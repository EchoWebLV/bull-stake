export function impliedOdds(bucketTotals: [bigint, bigint], bucket: 0 | 1, feeBps: number): number {
  const total = bucketTotals[0] + bucketTotals[1];
  const side = bucketTotals[bucket];
  if (total === 0n || side === 0n) return 0;
  const loser = bucketTotals[bucket === 0 ? 1 : 0]; // fee is taken from the LOSING pool only
  const feeCollected = (Number(loser) * feeBps) / 10_000;
  return (Number(total) - feeCollected) / Number(side);
}
