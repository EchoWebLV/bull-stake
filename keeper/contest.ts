/** Pure card-shaping + perfect-counting helpers for the parlay keeper. */

/**
 * The ordered (fixtureId, marketId) tuples for a contest's legs.
 *
 * settle_contest's on-chain handler reads `remaining_accounts[i]` against
 * `fixtures[i]`/`market_ids[i]`, so the keeper MUST pass the leg markets in this
 * exact order. Pure: no PDA derivation, no I/O — derivation happens at the call
 * site (it needs the programId). Tested in settle-contest.test.ts.
 */
export function legMarketsInOrder(
  fixtures: number[],
  marketIds: number[],
  numLegs: number,
): { fixtureId: number; marketId: number }[] {
  const out: { fixtureId: number; marketId: number }[] = [];
  for (let i = 0; i < numLegs; i++) out.push({ fixtureId: fixtures[i], marketId: marketIds[i] });
  return out;
}

/**
 * Abort-to-void predicate: true only when EVERY leg recorded a winning bucket.
 *
 * A leg with no bucket (sentinel < 0, e.g. a Voided market on an abandoned match)
 * means the contest cannot be settled — the keeper must run `void-contest` to
 * refund. Mirrors the on-chain `ok_or(ResultMarketNotSettled)` per leg. Pure.
 */
export function allLegsHaveBuckets(buckets: number[], numLegs: number): boolean {
  for (let i = 0; i < numLegs; i++) if (!(buckets[i] >= 0)) return false;
  return true;
}

/** A leg market's on-chain status (Anchor enum normalized to a lowercase string). */
export type LegStatus = "open" | "settled" | "voided";

/**
 * Settle-readiness verdict for a contest's legs:
 *   "ready"     — every leg has a winning bucket → settle_contest can proceed.
 *   "pending"   — at least one bucketless leg is still Open → the match is NOT
 *                 final yet; the operator must WAIT and re-run, NOT void.
 *   "abandoned" — every bucketless leg is Voided (no in-flight legs) → the match
 *                 is genuinely abandoned → run void-contest to refund.
 */
export type LegReadiness = "ready" | "pending" | "abandoned";

/**
 * Classify whether a contest's legs are ready to settle, still pending, or
 * abandoned. This is the money-adjacent gate that prevents the keeper from
 * directing an operator to void a still-live match: `void_contest` has NO time
 * gate for the keeper, so a wrongful void on a match that may still complete
 * forces refunds and denies winners their payout.
 *
 * A missing bucket (`bucket < 0`) has two OPPOSITE causes:
 *   - leg still Open  → settleMarketByPubkey skipped it (match not final) → WAIT.
 *   - leg Voided      → void_market left winning_bucket = None (abandoned)  → VOID.
 *
 * `pending` takes PRECEDENCE over `abandoned`: if ANY bucketless leg is still
 * Open we never report abandoned, because that leg might yet complete. A short/
 * undefined leg is treated as pending (never void on incomplete information).
 * Only inspects the first `numLegs` (padded tail ignored). Pure; tested in
 * settle-contest.test.ts.
 */
export function classifyLegReadiness(
  legs: { status: LegStatus; bucket: number }[],
  numLegs: number,
): LegReadiness {
  let anyMissing = false;
  let anyOpenMissing = false;
  for (let i = 0; i < numLegs; i++) {
    const leg = legs[i];
    const hasBucket = leg != null && leg.bucket >= 0;
    if (hasBucket) continue;
    anyMissing = true;
    if (leg == null || leg.status === "open") anyOpenMissing = true;
  }
  if (!anyMissing) return "ready";
  return anyOpenMissing ? "pending" : "abandoned";
}

/**
 * Guard predicate mirroring the on-chain `perfect_count <= entry_count` check
 * (`PerfectCountExceedsEntries`). A parlay can have at most `entry_count` perfect
 * tickets; a larger count would (on-chain) scoop the shared jackpot a contest can
 * never pay back. Pure — keep the keeper from broadcasting a tx that would revert.
 */
export function perfectCountWithinEntries(perfectCount: number, entryCount: number): boolean {
  return perfectCount <= entryCount;
}

/** Count entries whose first `numLegs` picks all equal the winning buckets. */
export function countPerfect(
  entries: { picks: number[] }[],
  winningBuckets: number[],
  numLegs: number,
): number {
  return entries.filter((e) => {
    for (let i = 0; i < numLegs; i++) if (e.picks[i] !== winningBuckets[i]) return false;
    return true;
  }).length;
}

export interface SlateMatch {
  fixtureId: number;
  home: string;
  away: string;
  kickoffMs: number;
}

/** Pick ≤maxN marquee matches with staggered (non-overlapping) kickoffs, earliest-first. */
export function selectParlayMatches(slate: SlateMatch[], maxN: number, minGapMins: number): SlateMatch[] {
  const gap = minGapMins * 60_000;
  const sorted = slate.filter((m) => m.kickoffMs > 0).sort((a, b) => a.kickoffMs - b.kickoffMs);
  const picked: SlateMatch[] = [];
  for (const m of sorted) {
    if (picked.length >= maxN) break;
    const last = picked[picked.length - 1];
    if (!last || m.kickoffMs - last.kickoffMs >= gap) picked.push(m);
  }
  return picked;
}

/** Parlay contest window: one fixture, 4 fixed legs. contest_id = fixtureId. */
export interface ParlayParams {
  contestId: number;
  fixtureId: number;
  marketIds: number[];
  numLegs: number;
  lockTs: number;        // seconds — fixture kickoff
  settleAfterTs: number; // seconds — kickoff + bufferSecs
}

export function parlayParams(fixtureId: number, kickoffMs: number, bufferSecs = 3 * 3600): ParlayParams {
  const lockTs = Math.floor(kickoffMs / 1000);
  return {
    contestId: fixtureId,
    fixtureId,
    marketIds: [16, 15, 12, 11],
    numLegs: 4,
    lockTs,
    settleAfterTs: lockTs + bufferSecs,
  };
}

/** On-chain arrays are [_; MAX_LEGS] (mirrors contest_state.rs); a contest uses num_legs of them. */
const MAX_LEGS = 6;

/** Padded, BN-free args for the v2 `create_contest` instruction. The `new BN(...)`
 * wrapping happens at the RPC call site in create-parlay.ts. */
export interface CreateArgs {
  contestId: number;   // == fixtureId
  fixtures: number[];  // [i64; MAX_LEGS] — fixtureId repeated numLegs times, padded with 0
  marketIds: number[]; // [u8; MAX_LEGS] — e.g. [16, 15, 12, 11, 0, 0]
  numLegs: number;     // 4
  lockTs: number;
  settleAfterTs: number;
}

/** Pad fixtures to [i64; MAX_LEGS] with 0 (the program ignores entries beyond num_legs). */
export function padFixtures(ids: number[]): number[] {
  const out = [...ids];
  while (out.length < MAX_LEGS) out.push(0);
  return out;
}
/** Pad market ids to [u8; MAX_LEGS] with 0 (tail zeros). */
export function padMarketIds(ids: number[]): number[] {
  const out = [...ids];
  while (out.length < MAX_LEGS) out.push(0);
  return out;
}

/**
 * Pure arg assembly: turn ParlayParams into the padded on-chain create_contest
 * args. All 4 legs are on the SAME fixture, so `fixtures` is the fixtureId repeated
 * numLegs times (padded to MAX_LEGS), and `marketIds` is the leg markets padded to MAX_LEGS.
 */
export function buildCreateArgs(p: ParlayParams): CreateArgs {
  return {
    contestId: p.contestId,
    fixtures: padFixtures(new Array(p.numLegs).fill(p.fixtureId)),
    marketIds: padMarketIds(p.marketIds),
    numLegs: p.numLegs,
    lockTs: p.lockTs,
    settleAfterTs: p.settleAfterTs,
  };
}

export interface SettlePreviewInput {
  contestLamports: bigint;   // Contest PDA balance
  contestRentFloor: bigint;  // rent-exempt minimum for the Contest PDA
  jackpotLamports: bigint;   // Jackpot PDA balance
  jackpotRentFloor: bigint;  // rent-exempt minimum for the Jackpot PDA
  entryCount: bigint;        // this contest's entry_count
  entryPrice: bigint;        // lamports per ticket
  feeBps: number;            // rake basis points (e.g. 500 = 5%)
  perfectCount: bigint;      // number of perfect tickets the keeper will declare
}

export interface SettlePreview {
  pot: bigint;           // contest escrow above its rent floor
  rake: bigint;          // fee taken to fee_recipient (on NEW stakes, capped at pot)
  jpool: bigint;         // rolling jackpot above its rent floor
  distributable: bigint; // paid out to winners (== payable; 0 on rollover)
  share: bigint;         // per-winner payout (floor division of raw)
  payable: bigint;       // share * perfectCount
  dust: bigint;          // raw − payable — left implicitly in the jackpot
  jackpotIn: bigint;     // lamports moved jackpot → contest (payable >= potNet)
  jackpotOut: bigint;    // lamports moved contest → jackpot (rollover, or payable < potNet)
  rolledOver: boolean;   // perfectCount == 0 → no winners, potNet rolls into jackpot
}

/**
 * Pure mirror of `settle_contest.rs` (handler lines 99-214): compute exactly what
 * the on-chain handler will do for a keeper-supplied `perfectCount`, so the operator
 * can sanity-check the one trusted input (perfect_count) and the resulting payout +
 * jackpot movement BEFORE broadcasting `settle_contest`.
 *
 * On-chain uses checked_sub for pot/jpool (would error on underflow); here we clamp
 * ≥0 so the preview is total. All other arithmetic mirrors the chain exactly:
 *   pot       = contest_lamports − contest_rent_floor          (clamp ≥0)
 *   rake      = (entry_count * entry_price * fee_bps / 10_000) capped at pot
 *   pot_net   = pot − rake
 *   jpool     = jackpot_lamports − jackpot_rent_floor          (clamp ≥0)
 *   rollover (perfect_count==0): jackpot_out = pot_net; distributable = 0
 *   winners:  raw = pot_net + jpool; share = floor(raw / perfect_count);
 *             payable = share * perfect_count; dust = raw − payable (left in jackpot);
 *             SIGNED delta — payable >= pot_net → jackpot_in = payable − pot_net
 *                            (jackpot → contest); else jackpot_out = pot_net − payable
 *                            (contest → jackpot, leaving the jackpot holding dust > jpool).
 *             distributable = payable.
 */
export function previewSettle(i: SettlePreviewInput): SettlePreview {
  const max0 = (x: bigint) => (x > 0n ? x : 0n);
  const pot = max0(i.contestLamports - i.contestRentFloor);
  const jpool = max0(i.jackpotLamports - i.jackpotRentFloor);
  const rakeRaw = (i.entryCount * i.entryPrice * BigInt(i.feeBps)) / 10_000n;
  const rake = rakeRaw < pot ? rakeRaw : pot;
  const potNet = pot - rake;
  if (i.perfectCount === 0n) {
    return {
      pot, rake, jpool, distributable: 0n, share: 0n, payable: 0n, dust: 0n,
      jackpotIn: 0n, jackpotOut: potNet, rolledOver: true,
    };
  }
  const raw = potNet + jpool;
  const share = raw / i.perfectCount;
  const payable = share * i.perfectCount;
  const dust = raw - payable;
  const jackpotIn = payable >= potNet ? payable - potNet : 0n;
  const jackpotOut = payable >= potNet ? 0n : potNet - payable;
  return {
    pot, rake, jpool, distributable: payable, share, payable, dust,
    jackpotIn, jackpotOut, rolledOver: false,
  };
}
