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

/** Entries are only accepted while >= MIN_OPEN_LEGS legs are open (mirrors
 * contest_state.rs MIN_OPEN_LEGS), so every legitimate winner carries at least
 * this many active legs. */
const MIN_OPEN_LEGS = 3;

/**
 * Guard predicate mirroring the on-chain `WeightMismatch` band in
 * settle_contest.rs: weight must be 0 iff count is 0; otherwise it must lie in
 * [count × 2^MIN_OPEN_LEGS, count × 2^numLegs] (every winner carried at least the
 * minimum mask, at most THIS contest's full card). Unreachable for weights
 * produced by countPerfectWeighted over legitimate entries, but a friendly abort
 * beats a raw on-chain revert. Pure.
 */
export function perfectWeightWithinBand(
  perfectCount: number,
  perfectWeight: number,
  numLegs: number,
): boolean {
  if (perfectCount === 0) return perfectWeight === 0;
  const minW = perfectCount * 2 ** MIN_OPEN_LEGS;
  const maxW = perfectCount * 2 ** numLegs;
  return perfectWeight >= minW && perfectWeight <= maxW;
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

/** Per-entry mirror of claim_contest.rs's masked-perfect check: `active` counts
 * the legs whose lock is strictly after entryTs; `perfect` seeds from
 * `entryTs > 0` (fail-closed on an impossible zero — the chain never pays such
 * an entry) and requires every active pick to match; a perfect entry's claim
 * weight is 2^active (0 if imperfect or nothing was active). Single source of
 * truth for the mask semantics — countPerfectWeighted aggregates over this and
 * settle-contest.ts logs it per entry, so the audit log and the two trusted
 * settle args can never disagree. */
export function entryWeight(
  e: { picks: number[]; entryTs: number },
  winningBuckets: number[],
  legLockTs: number[],
  numLegs: number,
): { active: number; perfect: boolean; weight: number } {
  let active = 0;
  let perfect = e.entryTs > 0; // fail-closed seed, mirrors claim_contest.rs
  for (let i = 0; i < numLegs; i++) {
    if (legLockTs[i] > e.entryTs) {
      active++;
      if (e.picks[i] !== winningBuckets[i]) perfect = false;
    }
  }
  const paid = perfect && active > 0;
  return { active, perfect: paid, weight: paid ? 2 ** active : 0 };
}

/** Weighted perfect tally for the Pearly: an entry's ACTIVE legs are those whose
 * leg lock is strictly after its entryTs; perfect = all active picks match; each
 * perfect entry contributes 2^active to the weight. Mirrors claim_contest.rs
 * (the per-entry semantics live in entryWeight above). */
export function countPerfectWeighted(
  entries: { picks: number[]; entryTs: number }[],
  winningBuckets: number[],
  legLockTs: number[],
  numLegs: number,
): { perfectCount: number; perfectWeight: number } {
  let perfectCount = 0;
  let perfectWeight = 0;
  for (const e of entries) {
    const w = entryWeight(e, winningBuckets, legLockTs, numLegs);
    if (w.perfect) {
      perfectCount++;
      perfectWeight += w.weight;
    }
  }
  return { perfectCount, perfectWeight };
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
  distributable: bigint; // the FULL raw pool credited to winners (pot_net + jpool);
                          // 0 on rollover. No flooring here — per-claim division
                          // (floor(distributable * weight / perfect_weight)) happens
                          // in claim_contest.rs; the flooring residue (< perfect_count
                          // lamports) stays in the Contest PDA, untouched by settle.
  jackpotIn: bigint;      // lamports moved jackpot → contest (winners: ALWAYS the
                          // whole jpool, unconditionally — no signed-delta compare)
  jackpotOut: bigint;     // lamports moved contest → jackpot (rollover only; always
                          // 0 on a winners-settle — nothing ever flows back out)
  rolledOver: boolean;    // perfectCount == 0 → no winners, potNet rolls into jackpot
}

/**
 * Pure mirror of `settle_contest.rs` (the pot/rake/jackpot-movement section of the
 * handler, after the leg-market verification): compute exactly what the on-chain
 * handler will do for a keeper-supplied `perfectCount`, so the operator can
 * sanity-check the trusted inputs and the resulting payout + jackpot movement
 * BEFORE broadcasting `settle_contest`. Settle takes TWO trusted inputs, but
 * money movement depends only on perfect_count == 0 vs > 0; perfect_weight (the
 * second trusted input) never moves lamports at settle — on-chain it is checked
 * only by the WeightMismatch band ([count × 2^MIN_OPEN_LEGS, count × 2^num_legs],
 * mirrored here by perfectWeightWithinBand) and is exercised at claim, where each
 * winner's share divides by it.
 *
 * On-chain uses checked_sub for pot/jpool (would error on underflow); here we clamp
 * ≥0 so the preview is total. All other arithmetic mirrors the chain exactly:
 *   pot       = contest_lamports − contest_rent_floor          (clamp ≥0)
 *   rake      = (entry_count * entry_price * fee_bps / 10_000) capped at pot
 *   pot_net   = pot − rake
 *   jpool     = jackpot_lamports − jackpot_rent_floor          (clamp ≥0)
 *   rollover (perfect_count==0): jackpot_out = pot_net; distributable = 0.
 *   winners:  distributable = pot_net + jpool (the FULL raw pool — NO division at
 *             settle; claim_contest.rs floors per-entry by weight, residue stays in
 *             the Contest PDA); jackpot_in = jpool UNCONDITIONALLY (the whole
 *             rolling jackpot is always pulled into the contest when there are
 *             winners — no signed-delta comparison against pot_net); jackpot_out
 *             stays 0 (nothing ever flows contest → jackpot on a winners-settle).
 *
 * NOTE (Rider B / commit 542d57c): this used to floor-divide at settle (share =
 * floor(raw / perfect_count); payable = share * perfect_count; dust = raw − payable
 * left in the jackpot via a signed jackpotIn/jackpotOut delta). That mechanism is
 * GONE — settle now hands winners the whole raw pool undivided, and per-claim
 * division/flooring happens in claim_contest.rs against perfect_weight, not
 * perfect_count. `share`/`payable`/`dust` no longer exist as settle-time concepts.
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
      pot, rake, jpool, distributable: 0n,
      jackpotIn: 0n, jackpotOut: potNet, rolledOver: true,
    };
  }
  const raw = potNet + jpool;
  return {
    pot, rake, jpool, distributable: raw,
    jackpotIn: jpool, jackpotOut: 0n, rolledOver: false,
  };
}
