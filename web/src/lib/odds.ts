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

/**
 * Estimate-flavoured multiplier: "~2.40×". The leading "~" signals that every
 * parimutuel multiplier is a live projection — it shifts as stake (yours and
 * everyone else's) enters the pool and only finalizes at settlement. Falls back
 * to "—" (no "~") when there's no price yet.
 */
export const fmtMultEst = (n: number) => (n > 0 ? `~${n.toFixed(2)}×` : "—");

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

/**
 * The multiplier to display on a single outcome button.
 *
 * Only the outcome the bettor has *selected* reacts to their typed stake: in a
 * parimutuel pool, staking a side dilutes only that side, so a bet on one
 * outcome would actually *raise* the others' odds — never lower them. Showing
 * every button sink toward 1× as the stake grows wrongly implied that backing
 * one result hurt the rest. So unselected buttons hold at the live-market odds
 * (`staticOdds`); the selected one shows the stake-aware projection.
 */
export function displayMultiplier(
  bucketTotals: string[],
  bucket: number,
  selectedBucket: number | null,
  stakeLamports: number,
  staticOdds: number,
): number {
  if (bucket !== selectedBucket) return staticOdds;
  return buttonMultiplier(bucketTotals, bucket, stakeLamports, staticOdds);
}
