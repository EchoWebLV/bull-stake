/**
 * Settle the live daily sweepstake contest (M0).
 *
 * Usage: npx tsx settle-contest.ts [--dry-run]
 *
 * 1. Read jackpot_vault.active_contest_id → the live Contest.
 * 2. For each carded fixture, settle its result market (market_id 12) via the existing
 *    proof path (settleMarketByPubkey) — skips if already settled/voided.
 * 3. Read each result market's winning_bucket, count perfect entries off-chain.
 * 4. Call settle_contest(perfect_count) with the result-market accounts as remaining_accounts.
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { loadProofbetProgram, settleMarketByPubkey } from "./settle.js";
import { countPerfect, previewSettle } from "./contest.js";

// Named ESM exports aren't exposed through anchor's ESM entry — use the default import.
const BN = anchorDefault.BN;
const RESULT_MARKET_ID = 12;
// JackpotVault account size: 8 (disc) + active_contest_id(u64) + reserved(u64) + bump(u8).
const JACKPOT_VAULT_SIZE = 8 + 8 + 8 + 1;
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const programId = proofbet.programId;

  const jackpotVault = PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (proofbet.account as any).jackpotVault.fetch(jackpotVault);
  const activeId = Number(v.activeContestId);
  if (activeId === 0) { console.log("no live contest"); return; }

  const contest = PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(activeId)], programId)[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (proofbet.account as any).contest.fetch(contest);
  const nm = Number(c.numMatches);
  const fixtures: number[] = (c.fixtures as { toNumber(): number }[]).slice(0, nm).map((f) => f.toNumber());

  // 1. Settle each result market (idempotent — skips already settled/voided).
  const resultMarkets: PublicKey[] = [];
  for (const fixtureId of fixtures) {
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), i64le(fixtureId), Buffer.from([RESULT_MARKET_ID])], programId,
    )[0];
    resultMarkets.push(market);
    const r = await settleMarketByPubkey(ctx, auth, proofbet, market, { dryRun });
    console.log(`result market fixture ${fixtureId}: ${r.action}`);
  }

  // 2. Read winning buckets + count perfect entries.
  const winningBuckets: number[] = [];
  for (const market of resultMarkets) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await (proofbet.account as any).market.fetchNullable(market);
    winningBuckets.push(m?.winningBucket ?? -1);
  }
  if (winningBuckets.includes(-1)) {
    console.warn("a result market has no winning bucket (abandoned match) — run void-contest instead; aborting.");
    console.log(JSON.stringify({
      action: "settle_contest", contestId: activeId, fixtures, winningBuckets,
      aborted: "abandoned-match", dryRun,
    }, null, 2));
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = await (proofbet.account as any).entry.all([
    { memcmp: { offset: 8 + 32, bytes: contest.toBase58() } }, // contest at offset 40
  ]);
  const perfectCount = countPerfect(entries.map((e) => ({ picks: e.account.picks as number[] })), winningBuckets, nm);

  // Audit: compute exactly what settle_contest will do for this perfect_count,
  // so the operator can sanity-check the pot/rake/payout BEFORE broadcasting.
  const connection = proofbet.provider.connection;
  const vaultLamports = BigInt(await connection.getBalance(jackpotVault));
  const rentFloor = BigInt(await connection.getMinimumBalanceForRentExemption(JACKPOT_VAULT_SIZE));
  const preview = previewSettle({
    vaultLamports,
    rentFloor,
    reserved: BigInt(v.reserved.toString()),
    entryCount: BigInt(c.entryCount.toString()),
    entryPrice: BigInt(c.entryPrice.toString()),
    feeBps: Number(c.feeBps),
    perfectCount: BigInt(perfectCount),
  });

  console.log(JSON.stringify({
    action: "settle_contest", contestId: activeId, fixtures, winningBuckets,
    entries: entries.length, perfectCount,
    preview: {
      potSnapshot: preview.potSnapshot.toString(), rake: preview.rake.toString(),
      distributable: preview.distributable.toString(), share: preview.share.toString(),
      payable: preview.payable.toString(), dust: preview.dust.toString(),
      rolledOver: preview.rolledOver,
    },
    dryRun,
  }, null, 2));
  console.log(
    `settle preview · pot ${sol(preview.potSnapshot)} ◎ · rake ${sol(preview.rake)} ◎ · ` +
    `distributable ${sol(preview.distributable)} ◎ · ${perfectCount} winner(s) → ${sol(preview.share)} ◎ each` +
    (preview.rolledOver ? " · ROLLOVER (no winners, pot rolls forward)" : ` · dust ${sol(preview.dust)} ◎`),
  );

  if (dryRun) { console.log("dry-run: not sending settle_contest"); return; }

  // 3. settle_contest(perfect_count) with result markets as remaining_accounts.
  const sig = await proofbet.methods
    .settleContest(new BN(perfectCount))
    .accountsStrict({
      settleAuthority: keeper,
      vault: jackpotVault,
      contest,
      feeRecipient: c.feeRecipient,
    })
    .remainingAccounts(resultMarkets.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })))
    .rpc();
  console.log(`settle_contest: ${sig}`);
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("settle-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
