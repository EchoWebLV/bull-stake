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

/** Count entries whose first `numMatches` picks all equal the winning buckets. */
export function countPerfect(
  entries: { picks: number[] }[],
  winningBuckets: number[],
  numMatches: number,
): number {
  return entries.filter((e) => {
    for (let i = 0; i < numMatches; i++) if (e.picks[i] !== winningBuckets[i]) return false;
    return true;
  }).length;
}

export interface SettlePreviewInput {
  vaultLamports: bigint;  // jackpot_vault account balance
  rentFloor: bigint;      // rent-exempt minimum for the JackpotVault account
  reserved: bigint;       // lamports already owed to prior terminal contests
  entryCount: bigint;     // this contest's entry_count
  entryPrice: bigint;     // lamports per ticket
  feeBps: number;         // rake basis points (e.g. 500 = 5%)
  perfectCount: bigint;   // number of perfect tickets the keeper will declare
}

export interface SettlePreview {
  potSnapshot: bigint;    // free pot this contest may touch
  rake: bigint;           // fee taken to fee_recipient (capped at pot)
  distributable: bigint;  // paid out to winners (0 on rollover)
  share: bigint;          // per-winner payout (floor division)
  payable: bigint;        // share * perfectCount — fenced into vault.reserved
  dust: bigint;           // distributable - payable — stays free, rolls forward
  rolledOver: boolean;    // perfectCount == 0 → no winners, pot rolls forward
}

/**
 * Pure mirror of `settle_contest.rs` (lines 83-152): compute exactly what the
 * on-chain handler will do for a given keeper-supplied `perfectCount`, so the
 * operator can sanity-check the one trusted input (perfect_count) and the
 * resulting payout BEFORE broadcasting `settle_contest`.
 *
 * Mirrors the on-chain `saturating_sub` chain for pot_snapshot and the rake cap.
 */
export function previewSettle(i: SettlePreviewInput): SettlePreview {
  const max0 = (x: bigint) => (x > 0n ? x : 0n);
  // pot_snapshot = vault_lamports.saturating_sub(floor).saturating_sub(reserved)
  const potSnapshot = max0(max0(i.vaultLamports - i.rentFloor) - i.reserved);
  // rake on NEW stakes only (rolled-in pot excluded), capped at the pot.
  const rakeRaw = (i.entryCount * i.entryPrice * BigInt(i.feeBps)) / 10_000n;
  const rake = rakeRaw < potSnapshot ? rakeRaw : potSnapshot;
  const rolledOver = i.perfectCount === 0n;
  const distributable = rolledOver ? 0n : potSnapshot - rake;
  const share = rolledOver ? 0n : distributable / i.perfectCount; // floor div
  const payable = share * i.perfectCount;
  const dust = distributable - payable;
  return { potSnapshot, rake, distributable, share, payable, dust, rolledOver };
}
