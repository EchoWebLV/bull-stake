/* ──────────────────────────────────────────────────────────────────────────
 * Streak — daily-card leg helpers (pure, so they're unit-testable).
 *
 * The card is a perfect-parlay of N legs (typically 6). Each leg is a
 * (fixture, market) pick; a single match usually contributes two legs (its
 * Result and its Total-Goals O/U). We NEVER collapse a match's markets into one
 * summary row — every leg renders individually — and we surface the true leg
 * count + market mix with a dynamic summary derived from `marketId`, never
 * hardcoded (the mix varies day to day).
 *
 * Market catalog (engine markets.ts):
 *   12 = Match Result 1X2   (winner)
 *   11 = Total Goals O/U 2.5 (goals)
 *   16 = 1st-Half Result    (HT result)
 *   15 = 1st-Half Goals O/U  (HT goals)
 * ──────────────────────────────────────────────────────────────────────── */

import type { CardLeg } from "./api.ts";

/** Short per-leg row label off the marketId, with a bucket-count fallback. */
export function legRowLabel(leg: CardLeg): string {
  switch (leg.marketId) {
    case 12: return "Result";
    case 11: return "Goals O/U 2.5";
    case 16: return "HT result";
    case 15: return "HT goals O/U";
    default: return leg.buckets === 2 ? "O/U" : "Result";
  }
}

/**
 * Dynamic "N legs · a winners + b goals + …" summary. Counts are derived from
 * the actual legs by marketId (never hardcoded) so a 6-leg card reads, e.g.,
 * "6 legs · 3 winners + 3 goals" and an all-Result day reads "6 legs · 6 winners".
 * Unknown marketIds still count toward the leg total but add no named part.
 */
export function legSummary(legs: CardLeg[]): string {
  const kinds: Array<{ id: number; word: string; plural?: string }> = [
    { id: 12, word: "winner", plural: "winners" },
    { id: 16, word: "HT result", plural: "HT results" },
    { id: 11, word: "goals" },      // "goals" reads the same at any count
    { id: 15, word: "HT goals" },
  ];
  const parts = kinds
    .map(({ id, word, plural }) => ({ n: legs.filter((l) => l.marketId === id).length, word, plural }))
    .filter((p) => p.n > 0)
    .map((p) => `${p.n} ${p.plural && p.n !== 1 ? p.plural : p.word}`);
  const n = legs.length;
  const head = `${n} leg${n === 1 ? "" : "s"}`;
  return parts.length ? `${head} · ${parts.join(" + ")}` : head;
}
