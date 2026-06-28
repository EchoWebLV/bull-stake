/**
 * Pool-implied odds = the payout multiplier a backer of `bucket` would get if the
 * market settled now and `bucket` won. Mirrors the on-chain payout exactly:
 *   fee_collected = loser_total * feeBps/10000   (fee taken from the LOSING pool only)
 *   payout        = (total_pool - fee_collected) / bucket_total
 * Indicative only — the realized payout is fixed at entry close.
 * Returns 0 when there is no liquidity on the bucket or no pool at all.
 */
export function impliedOdds(
  bucketTotals: [bigint, bigint],
  bucket: 0 | 1,
  feeBps: number,
): number {
  const total = bucketTotals[0] + bucketTotals[1];
  const side = bucketTotals[bucket];
  if (total === 0n || side === 0n) return 0;
  const loser = bucketTotals[bucket === 0 ? 1 : 0];
  const feeCollected = (Number(loser) * feeBps) / 10_000;
  return (Number(total) - feeCollected) / Number(side);
}
