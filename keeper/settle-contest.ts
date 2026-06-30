/**
 * Settle a single-match parlay contest (v2 — jackpot + per-leg, two-wave).
 *
 * Usage:
 *   npx tsx settle-contest.ts --contest-id <fixtureId> [--dry-run]
 *   npx tsx settle-contest.ts [--dry-run]   ← no id: enumerate Open contests due
 *
 * v2 model (vs v1): NO jackpot_vault / active_contest_id / reserved. A contest is
 * found by contest_id == fixtureId (deriveContestPda). Each of its legs is a
 * (fixture, market_id) pair; the legs are settled in TWO WAVES — HT legs (15,16)
 * once H1 is final, FT legs (11,12) once the full match is final — then
 * settle_contest is called with the leg result markets as remaining_accounts in
 * LEG ORDER, and the rolling jackpot PDA (`[b"jackpot"]`) replacing the old vault.
 *
 * Flow per contest:
 *   1. Fetch the contest; read num_legs, fixtures[0..n], market_ids[0..n].
 *   2. Resolve the (single) fixture's phase; marketsToSettle() decides which legs
 *      are settleable NOW. Settle each settleable leg via settleMarketByPubkey
 *      (idempotent — skips already settled/voided; market 16 is a 3-way sign map).
 *   3. Read each leg's winning_bucket. If ANY leg lacks a bucket (abandoned /
 *      not-yet-final) → ABORT and direct the operator to `void-contest`.
 *   4. Count perfect entries off-chain (entry.all memcmp on contest @ offset 40).
 *   5. AUDIT (always, dry-run + live): v2 previewSettle from the CONTEST + JACKPOT
 *      PDA balances — print pot/rake/jpool/distributable/share/dust/jackpotIn/
 *      jackpotOut/rolledOver + the perfect_count.
 *   6. Enforce perfect_count <= entry_count (mirrors on-chain PerfectCountExceedsEntries).
 *   7. If not --dry-run: settle_contest(perfect_count) with jackpot + leg markets.
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getScoreHistory, resolvePhase } from "../spike/src/discover.js";
import { marketById } from "../engine/src/markets.js";
import { loadProofbetProgram, settleMarketByPubkey } from "./settle.js";
import { marketsToSettle } from "./settle-all.js";
import {
  countPerfect,
  previewSettle,
  legMarketsInOrder,
  allLegsHaveBuckets,
  perfectCountWithinEntries,
} from "./contest.js";

// Named ESM exports aren't exposed through anchor's ESM entry — use the default import.
const BN = anchorDefault.BN;

// Jackpot PDA rent floor: minimum_balance(8 disc + Jackpot::INIT_SPACE(1 bump)).
const JACKPOT_RENT_SIZE = 8 + 1;
// Contest PDA rent floor: minimum_balance(8 disc + Contest::INIT_SPACE) — Anchor's
// program.account.contest.size already includes the 8-byte discriminator (= 207).
const CONTEST_SIZE_FALLBACK = 207;

const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

// ── Inline PDA helpers (do NOT import engine/src/chain.ts — it uses ".ts"
//    extensions, which break this package's NodeNext typecheck). Mirrors the
//    inline-derive convention already used in settle-all.ts. ──
function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

function deriveContestPda(programId: PublicKey, contestId: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(contestId)], programId)[0];
}
function deriveJackpotPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot")], programId)[0];
}
function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])], programId,
  )[0];
}

interface Flags { [k: string]: string | boolean; }

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpikeContext = ReturnType<typeof createContext>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Auth = Awaited<ReturnType<typeof authenticateCached>>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Proofbet = ReturnType<typeof loadProofbetProgram>;

/**
 * Settle one contest by its contest_id (== fixtureId). Returns a one-word outcome
 * for the no-id enumerate loop. All RPC wiring lives here; pure decisions
 * (legMarketsInOrder / allLegsHaveBuckets / perfectCountWithinEntries) are imported.
 */
async function settleOneContest(
  ctx: SpikeContext,
  auth: Auth,
  proofbet: Proofbet,
  contestId: number,
  dryRun: boolean,
): Promise<"settled" | "dry-run" | "aborted-void" | "aborted-guard"> {
  const programId = proofbet.programId;
  const keeper = ctx.wallet.publicKey;
  const connection = proofbet.provider.connection;

  const contest = deriveContestPda(programId, contestId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (proofbet.account as any).contest.fetch(contest);
  const numLegs = Number(c.numLegs);
  const fixtures: number[] = (c.fixtures as { toNumber(): number }[]).slice(0, numLegs).map((f) => f.toNumber());
  const marketIds: number[] = (c.marketIds as number[]).slice(0, numLegs);

  // 1. The ordered (fixtureId, marketId) leg tuples → leg-market PDAs (LEG ORDER).
  const legTuples = legMarketsInOrder(fixtures, marketIds, numLegs);
  const legMarkets: PublicKey[] = legTuples.map((t) => deriveMarketPda(programId, t.fixtureId, t.marketId));

  // 2. Two-wave: resolve the (single) fixture's phase once, then decide which legs
  //    settle now. All legs share one fixture, so one phase resolution covers them.
  //    (If a future card spans fixtures this loop would resolve per distinct fixture.)
  const fixturePhase = new Map<number, number | null>();
  for (const fid of new Set(fixtures)) {
    const events = await getScoreHistory(ctx, auth, fid);
    const withPhase = events.map((ev) => ({ ev, ...resolvePhase(ev) }));
    const best = withPhase.filter((e) => e.code !== null).sort((a, b) => b.ev.Seq - a.ev.Seq)[0];
    fixturePhase.set(fid, best ? (best.code as number) : null);
  }

  for (let i = 0; i < numLegs; i++) {
    const { fixtureId, marketId } = legTuples[i];
    const def = marketById(marketId);
    const settleAt = (def?.settleAt ?? "FT") as "HT" | "FT";
    const phaseCode = fixturePhase.get(fixtureId) ?? null;
    if (phaseCode === null) {
      console.log(`leg ${i} (fixture ${fixtureId}, market ${marketId}): no phase resolved — skipping`);
      continue;
    }
    // marketsToSettle with a single-leg template tells us if THIS leg's wave is ready.
    const ready = marketsToSettle(phaseCode, [{ marketId, settleAt }]).length > 0;
    if (!ready) {
      console.log(`leg ${i} (fixture ${fixtureId}, market ${marketId}, ${settleAt}): wave not ready (phase ${phaseCode}) — skipping`);
      continue;
    }
    // settleMarketByPubkey resolves the fixture's proof and settles 3-way or 2-way
    // generically (market 16 = 3-way sign map). Idempotent — skips already done.
    const r = await settleMarketByPubkey(ctx, auth, proofbet, legMarkets[i], { dryRun });
    console.log(`leg ${i} (fixture ${fixtureId}, market ${marketId}, ${settleAt}): ${r.action}`);
  }

  // 3. Read each leg's winning bucket; abort-to-void if ANY is missing.
  const winningBuckets: number[] = [];
  for (const market of legMarkets) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await (proofbet.account as any).market.fetchNullable(market);
    winningBuckets.push(m?.winningBucket ?? -1);
  }
  if (!allLegsHaveBuckets(winningBuckets, numLegs)) {
    console.warn(
      `contest ${contestId}: a leg has no winning bucket (abandoned / not yet final) — ` +
      `run void-contest instead; ABORTING (not settling).`,
    );
    console.log(JSON.stringify({
      action: "settle_contest", contestId, fixtures, marketIds, winningBuckets,
      aborted: "abandoned-or-not-final", dryRun,
    }, null, 2));
    return "aborted-void";
  }

  // 4. Count perfect entries off-chain (entry.contest is at offset 8 + 32 = 40).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = await (proofbet.account as any).entry.all([
    { memcmp: { offset: 8 + 32, bytes: contest.toBase58() } },
  ]);
  const entryCount = Number(c.entryCount);
  const perfectCount = countPerfect(
    entries.map((e) => ({ picks: e.account.picks as number[] })), winningBuckets, numLegs,
  );

  // 5. AUDIT (always — dry-run AND live): mirror settle_contest exactly so the
  //    operator can sanity-check the pot/rake/jackpot movement BEFORE broadcasting.
  //    CRITICAL wiring: pot ← CONTEST PDA balance; jpool ← JACKPOT PDA balance.
  const jackpotPda = deriveJackpotPda(programId);
  const contestLamports = BigInt(await connection.getBalance(contest));      // CONTEST PDA → pot
  const jackpotLamports = BigInt(await connection.getBalance(jackpotPda));   // JACKPOT PDA → jpool
  const contestSize = (proofbet.account as { contest: { size?: number } }).contest.size ?? CONTEST_SIZE_FALLBACK;
  const contestRentFloor = BigInt(await connection.getMinimumBalanceForRentExemption(contestSize));
  const jackpotRentFloor = BigInt(await connection.getMinimumBalanceForRentExemption(JACKPOT_RENT_SIZE));

  const preview = previewSettle({
    contestLamports,
    contestRentFloor,
    jackpotLamports,
    jackpotRentFloor,
    entryCount: BigInt(entryCount),
    entryPrice: BigInt(c.entryPrice.toString()),
    feeBps: Number(c.feeBps),
    perfectCount: BigInt(perfectCount),
  });

  console.log(JSON.stringify({
    action: "settle_contest", contestId, fixtures, marketIds, winningBuckets,
    entries: entries.length, entryCount, perfectCount,
    preview: {
      pot: preview.pot.toString(), rake: preview.rake.toString(),
      jpool: preview.jpool.toString(), distributable: preview.distributable.toString(),
      share: preview.share.toString(), payable: preview.payable.toString(),
      dust: preview.dust.toString(), jackpotIn: preview.jackpotIn.toString(),
      jackpotOut: preview.jackpotOut.toString(), rolledOver: preview.rolledOver,
    },
    dryRun,
  }, null, 2));
  console.log(
    `settle preview · pot ${sol(preview.pot)} ◎ · rake ${sol(preview.rake)} ◎ · ` +
    `jpool ${sol(preview.jpool)} ◎ · distributable ${sol(preview.distributable)} ◎ · ` +
    `${perfectCount}/${entryCount} winner(s) → ${sol(preview.share)} ◎ each` +
    (preview.rolledOver
      ? ` · ROLLOVER (no winners; ${sol(preview.jackpotOut)} ◎ rolls into jackpot)`
      : ` · dust ${sol(preview.dust)} ◎ · jackpotIn ${sol(preview.jackpotIn)} ◎ · jackpotOut ${sol(preview.jackpotOut)} ◎`),
  );

  // 6. Enforce perfect_count <= entry_count (mirror on-chain PerfectCountExceedsEntries).
  if (!perfectCountWithinEntries(perfectCount, entryCount)) {
    console.error(
      `contest ${contestId}: perfect_count (${perfectCount}) > entry_count (${entryCount}) — ` +
      `this would revert on-chain as PerfectCountExceedsEntries. ABORTING.`,
    );
    return "aborted-guard";
  }

  if (dryRun) { console.log("dry-run: not sending settle_contest"); return "dry-run"; }

  // 7. settle_contest(perfect_count) — jackpot REPLACES vault; leg markets in LEG ORDER.
  const sig = await proofbet.methods
    .settleContest(new BN(perfectCount))
    .accountsStrict({
      settleAuthority: keeper,
      jackpot: jackpotPda,
      contest,
      feeRecipient: c.feeRecipient,
    })
    .remainingAccounts(legMarkets.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })))
    .rpc();
  console.log(`settle_contest ${contestId}: ${sig}`);
  return "settled";
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = !!flags["dry-run"];
  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider);

  // PRIMARY path: explicit --contest-id <fixtureId>.
  if (flags["contest-id"] != null && flags["contest-id"] !== true) {
    const contestId = Number(flags["contest-id"]);
    await settleOneContest(ctx, auth, proofbet, contestId, dryRun);
    return;
  }

  // No-id mode: enumerate Open contests whose settle window has opened. Under the
  // planned fresh-id deploy there are no stale v1 contests, so .all() is acceptable
  // here; the PRIMARY path is the explicit --contest-id above.
  console.log(`[settle-contest] no --contest-id; enumerating Open contests due${dryRun ? " (DRY RUN)" : ""}`);
  const nowSec = Math.floor(Date.now() / 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let all: any[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    all = await (proofbet.account as any).contest.all();
  } catch (e) {
    console.error(`[settle-contest] contest.all() failed: ${(e as Error).message}`);
    return;
  }
  const due = all.filter((x) => {
    const st = x.account.status;
    const isOpen = st && typeof st === "object" && "open" in st;
    const settleAfter = Number(x.account.settleAfterTs);
    return isOpen && settleAfter <= nowSec;
  });
  console.log(`[settle-contest] ${due.length} of ${all.length} contest(s) Open and due`);
  for (const x of due) {
    const contestId = Number(x.account.contestId);
    console.log(`[settle-contest] === contest ${contestId} ===`);
    try {
      await settleOneContest(ctx, auth, proofbet, contestId, dryRun);
    } catch (e) {
      console.error(`[settle-contest] contest ${contestId} failed: ${(e as Error).message}`);
    }
  }
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("settle-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
