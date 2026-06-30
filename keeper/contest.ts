/** Pure card-shaping + perfect-counting helpers for the daily sweepstake keeper. */

export interface CardFixture {
  fixtureId: number;
  kickoffMs: number;
}

export interface ContestParams {
  contestId: number;        // epoch day of the first kickoff (non-zero, deterministic)
  numMatches: number;
  lockTs: number;           // seconds — first kickoff
  settleAfterTs: number;    // seconds — last kickoff + bufferSecs
  orderedFixtures: number[];
}

/** Derive on-chain contest params from a card. `bufferSecs` is added after the last kickoff. */
export function computeContestParams(fixtures: CardFixture[], bufferSecs = 3 * 60 * 60): ContestParams {
  if (fixtures.length === 0) throw new Error("computeContestParams: empty card");
  const sorted = [...fixtures].sort((a, b) => a.kickoffMs - b.kickoffMs);
  const firstMs = sorted[0].kickoffMs;
  const lastMs = sorted[sorted.length - 1].kickoffMs;
  return {
    contestId: Math.floor(firstMs / 86_400_000),
    numMatches: sorted.length,
    lockTs: Math.floor(firstMs / 1000),
    settleAfterTs: Math.floor(lastMs / 1000) + bufferSecs,
    orderedFixtures: sorted.map((f) => f.fixtureId),
  };
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
