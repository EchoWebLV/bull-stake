/**
 * Live-tab cross-link (spec §1): the slim "🃏 your card rides this match"
 * strip inside LiveMatchView. Pure derivation from the raw /api/card DTO —
 * LiveMatchView doesn't build a PearlyCardVM, so this works off Card directly
 * (activeMask = the legs this card carried at entry). Returns null whenever
 * there's nothing to say (no card, dead card, closed card, degraded poll, no
 * carried leg on the given fixture).
 */
import type { Card } from "./api.ts";
import { bucketLabel } from "./pearlyCard.ts";

export function stripForFixture(
  card: Card | null,
  fixtureId: number,
  liveGoalsTotal: number,
): { text: string } | null {
  if (!card || !card.myCard || !card.myCard.alive) return null;
  if (card.status !== "open") return null;
  if (card.degraded) return null; // api.ts's DTO contract: degraded polls make `alive` OPTIMISTIC — never claim a ride we can't stand behind
  const rides: string[] = [];
  for (let i = 0; i < card.legs.length; i++) {
    const leg = card.legs[i];
    if (leg.fixtureId !== fixtureId) continue;
    if (card.myCard.activeMask[i] !== true) continue; // this card never carried the leg
    const pick = card.myCard.picks[i];
    let part = `${leg.label}: ${bucketLabel(leg, pick)}`;
    // Spec's example copy — O/U Over still short of the line gets the dynamic nudge.
    if (leg.marketId === 11 && pick === 0 && typeof leg.line === "number") {
      const short = leg.line - liveGoalsTotal;
      if (short > 0 && short < 1) part += " — needs one more goal";
    }
    rides.push(part);
  }
  if (!rides.length) return null;
  return { text: `🃏 your card rides this match — ${rides.join(" · ")}` };
}
