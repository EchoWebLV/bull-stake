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
 *   3. Read each leg's winning_bucket + status and classify (classifyLegReadiness):
 *      - "ready"     (every leg has a bucket) → proceed.
 *      - "pending"   (a bucketless leg is still Open → match not final) → ABORT
 *                    and tell the operator to WAIT and re-run later; do NOT void.
 *      - "abandoned" (every bucketless leg is Voided) → ABORT and direct the
 *                    operator to `void-contest` to refund.
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
  classifyLegReadiness,
  perfectCountWithinEntries,
  type LegStatus,
} from "./contest.js";

// Named ESM exports aren't exposed through anchor's ESM entry — use the default import.
const BN = anchorDefault.BN;

// Jackpot PDA rent floor: minimum_balance(8 disc + Jackpot::INIT_SPACE(1 bump)).
const JACKPOT_RENT_SIZE = 8 + 1;
// Contest PDA rent floor: minimum_balance(8 disc + Contest::INIT_SPACE) — Anchor's
// program.account.contest.size already includes the 8-byte discriminator (= 217 for
// the 6-leg v2 layout; was 207 at 5 legs).
const CONTEST_SIZE_FALLBACK = 217;

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

type SettleOutcome =
  | "settled"
  | "dry-run"
  | "aborted-wait"
  | "aborted-void"
  | "aborted-guard"
  | "skipped-not-open"
  | "skipped-too-early";

/**
 * Settle one contest by its contest_id (== fixtureId). Returns a one-word outcome
 * for the no-id enumerate loop. All RPC wiring lives here; pure decisions
 * (legMarketsInOrder / classifyLegReadiness / perfectCountWithinEntries) are imported.
 */
async function settleOneContest(
  ctx: SpikeContext,
  auth: Auth,
  proofbet: Proofbet,
  contestId: number,
  dryRun: boolean,
): Promise<SettleOutcome> {
  const programId = proofbet.programId;
  const keeper = ctx.wallet.publicKey;
  const connection = proofbet.provider.connection;

  const contest = deriveContestPda(programId, contestId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (proofbet.account as any).contest.fetch(contest);

  // Friendly prechecks mirroring the on-chain ContestNotOpen / SettleTooEarly
  // guards — give the operator a clear message instead of a doomed broadcast.
  // (The no-id path pre-filters these; the explicit --contest-id path does not.)
  const status = c.status;
  const isOpen = status && typeof status === "object" && "open" in status;
  if (!isOpen) {
    const label = status && typeof status === "object" ? Object.keys(status)[0] : String(status);
    console.log(`contest ${contestId}: status is "${label}" (not Open) — already settled/voided/rolled-over; nothing to do.`);
    return "skipped-not-open";
  }
  const settleAfterTs = Number(c.settleAfterTs);
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < settleAfterTs) {
    console.log(`contest ${contestId}: settle window opens at ${settleAfterTs} (now ${nowSec}) — too early; nothing to do yet.`);
    return "skipped-too-early";
  }

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

  // 3. Read each leg's winning bucket AND status, then classify settle-readiness.
  //    A missing bucket means WAIT (leg still Open → match not final) or VOID
  //    (leg Voided → abandoned) — these are opposite directives, so we must not
  //    conflate them (void_contest has no keeper time-gate → a wrongful void on a
  //    still-live match forces refunds).
  const winningBuckets: number[] = [];
  const legStatuses: LegStatus[] = [];
  for (const market of legMarkets) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await (proofbet.account as any).market.fetchNullable(market);
    winningBuckets.push(m?.winningBucket ?? -1);
    const s = m?.status;
    // Anchor enum → lowercase string; a null account (uncreated leg) → "open"
    // (not yet resolved → pending, never abandoned: never void on missing data).
    const key = s && typeof s === "object" ? Object.keys(s)[0] : "open";
    legStatuses.push(key === "settled" ? "settled" : key === "voided" ? "voided" : "open");
  }
  const readiness = classifyLegReadiness(
    winningBuckets.map((bucket, i) => ({ status: legStatuses[i], bucket })),
    numLegs,
  );
  if (readiness === "pending") {
    console.warn(
      `contest ${contestId}: match not final yet (leg(s) still open) — ` +
      `WAIT and re-run later; do NOT void.`,
    );
    console.log(JSON.stringify({
      action: "settle_contest", contestId, fixtures, marketIds, winningBuckets,
      legStatuses, aborted: "not-final-yet", dryRun,
    }, null, 2));
    return "aborted-wait";
  }
  if (readiness === "abandoned") {
    console.warn(
      `contest ${contestId}: leg(s) abandoned (Voided with no bucket) — ` +
      `run void-contest to refund; ABORTING (not settling).`,
    );
    console.log(JSON.stringify({
      action: "settle_contest", contestId, fixtures, marketIds, winningBuckets,
      legStatuses, aborted: "abandoned", dryRun,
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
  const programId = proofbet.programId;
  const connection = proofbet.provider.connection;

  // PRIMARY path: explicit --contest-id <fixtureId>.
  if (flags["contest-id"] != null && flags["contest-id"] !== true) {
    const contestId = Number(flags["contest-id"]);
    await settleOneContest(ctx, auth, proofbet, contestId, dryRun);
    return;
  }

  // No-id mode: enumerate Open contests whose settle window has opened.
  //
  // We deliberately do NOT use `proofbet.account.contest.all()`: it fetches then
  // decodes EVERY account sharing the "Contest" discriminator in one call and
  // rejects the whole call if any single one fails. Orphaned older contests (the
  // v1 5-leg layout) share the discriminator but are a different size and their
  // bytes either throw or borsh-decode into the v2 struct as GARBAGE — so `.all()`
  // throws ("offset out of range") and hides every good v2 card. Instead we scan
  // raw via getProgramAccounts filtered by the v2 Contest discriminator AND the
  // exact v2 account size, then decode each in its own try/catch — the same
  // size-filtered discovery the engine uses (engine/src/chain.ts readLiveContests).
  console.log(`[settle-contest] no --contest-id; enumerating Open contests due${dryRun ? " (DRY RUN)" : ""}`);
  const nowSec = Math.floor(Date.now() / 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = (proofbet as any).coder.accounts;
  const contestSize = (proofbet.account as { contest: { size?: number } }).contest.size ?? CONTEST_SIZE_FALLBACK;

  let raw: { pubkey: PublicKey; account: { data: Buffer } }[] = [];
  try {
    // Resolve the discriminator filter INSIDE the try — an IDL-rename miss makes
    // coder.memcmp throw synchronously; keeping it here degrades to [] gracefully.
    const disc = coder.memcmp("contest"); // { offset: 0, bytes: <base58> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (await (connection as any).getProgramAccounts(programId, {
      filters: [{ memcmp: { offset: disc.offset, bytes: disc.bytes } }, { dataSize: contestSize }],
    })) as { pubkey: PublicKey; account: { data: Buffer } }[];
  } catch (e) {
    console.error(`[settle-contest] contest scan failed: ${(e as Error).message}`);
    return;
  }

  // Decode each candidate in its own try/catch; size-filtered above so only true
  // v2 cards reach here, but stay defensive against an RPC that ignores dataSize.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoded: { contestId: number; account: any }[] = [];
  for (const item of raw) {
    if (item.account.data.length !== contestSize) continue; // skip wrong-size (stale v1) accounts
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc: any = coder.decode("contest", item.account.data); // throws on stale v1 layout
      decoded.push({ contestId: Number(acc.contestId), account: acc });
    } catch {
      continue; // skip undecodable account, keep the rest
    }
  }

  const due = decoded.filter((x) => {
    const st = x.account.status;
    const isOpen = st && typeof st === "object" && "open" in st;
    const settleAfter = Number(x.account.settleAfterTs);
    return isOpen && settleAfter <= nowSec;
  });
  console.log(`[settle-contest] ${due.length} of ${decoded.length} contest(s) Open and due`);
  for (const x of due) {
    console.log(`[settle-contest] === contest ${x.contestId} ===`);
    try {
      await settleOneContest(ctx, auth, proofbet, x.contestId, dryRun);
    } catch (e) {
      console.error(`[settle-contest] contest ${x.contestId} failed: ${(e as Error).message}`);
    }
  }
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("settle-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
