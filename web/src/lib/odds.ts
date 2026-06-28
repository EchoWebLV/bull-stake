export const LAMPORTS = 1_000_000_000;
export const SOL = "◎";

export function impliedOdds(bucketTotals: [bigint, bigint], bucket: 0 | 1, feeBps: number): number {
  const total = bucketTotals[0] + bucketTotals[1];
  const side = bucketTotals[bucket];
  if (total === 0n || side === 0n) return 0;
  const loser = bucketTotals[bucket === 0 ? 1 : 0]; // fee is taken from the LOSING pool only
  const feeCollected = (Number(loser) * feeBps) / 10_000;
  return (Number(total) - feeCollected) / Number(side);
}

/** Multiplier display: "2.40×", or "—" when there's no price yet. */
export const fmtMult = (n: number) => (n > 0 ? `${n.toFixed(2)}×` : "—");

/** Lamports → trimmed SOL string (e.g. 0.1, 1.25). */
export const fmtSol = (lamports: string | number) => {
  const sol = Number(lamports) / LAMPORTS;
  return sol >= 1 ? sol.toFixed(2) : sol.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
};

/**
 * Parimutuel projected payout if `bucket` wins, after adding `stakeLamports`.
 * feeBps is 0 for these markets, so distributable = the entire pool:
 *   payout = stake * (total + stake) / (sidePool + stake)
 */
export function projectedPayout(
  totals: number[],
  bucket: number,
  stakeLamports: number,
): number {
  if (stakeLamports <= 0) return 0;
  const total = totals.reduce((a, b) => a + b, 0) + stakeLamports;
  const side = (totals[bucket] ?? 0) + stakeLamports;
  return (stakeLamports * total) / side;
}

/**
 * The multiplier to show on a bet button: the stake-aware projected multiplier
 * for the current stake (so an empty/one-sided pool shows its real value rather
 * than collapsing to "—"); falls back to the static pool odds when no stake.
 */
export function buttonMultiplier(
  bucketTotals: string[],
  bucket: number,
  stakeLamports: number,
  staticOdds: number,
): number {
  if (stakeLamports <= 0) return staticOdds;
  const totals = bucketTotals.map(Number);
  return projectedPayout(totals, bucket, stakeLamports) / stakeLamports;
}
