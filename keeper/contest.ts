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
