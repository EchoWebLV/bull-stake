/* ──────────────────────────────────────────────────────────────────────────
 * Streak — live per-leg status vs the user's pick.
 *
 * Pure functions so the green/amber/red drama of the live card is unit-testable
 * (see web/test/lib.test.ts). A card leg carries an optional `live` block once
 * its fixture kicks off: `{ home, away, minute, phase }` where home/away are the
 * running SCORES. We compare that score against the user's pick and label it.
 *
 * Two market shapes (distinguished by bucket count, matching the rest of the UI):
 *   • Result 1X2 (3 buckets): pick 0=home, 1=Draw, 2=away.
 *   • Total Goals O/U 2.5 (2 buckets): pick 0=Over, 1=Under.
 * ──────────────────────────────────────────────────────────────────────── */

import type { CardLegLive } from "./api.ts";

/** Tone drives the green/amber/red styling; kind fixes the copy. */
export type LiveTone = "good" | "warn" | "bad" | "neutral";
export interface LegLiveStatus {
  tone: LiveTone;
  /** Short status word shown to entered players, e.g. "on track" / "hit". */
  label: string;
  /** True once the fixture is full-time (phase "ft"): status is final. */
  final: boolean;
}

/** Current live score as "home–away" (en-dash), e.g. "2–1". */
export function fmtLiveScore(live: CardLegLive): string {
  return `${live.home}–${live.away}`;
}

/** Minute/phase caption for the score, e.g. "78'", "HT", "FT", "kickoff". */
export function fmtLivePhase(live: CardLegLive): string {
  switch (live.phase) {
    case "ht": return "HT";
    case "ft": return "FT";
    case "live": return live.minute != null ? `${live.minute}'` : "live";
    case "pre": default: return "kickoff";
  }
}

/** Is `pick` currently leading a Result (1X2) leg given the running score? */
function resultLeading(pick: number, h: number, a: number): boolean {
  if (pick === 0) return h > a;   // home
  if (pick === 2) return a > h;   // away
  return h === a;                 // Draw
}

/** Does the current total satisfy an O/U 2.5 `pick` (0 = Over, 1 = Under)?
 *  Over needs total ≥ 3; Under needs total ≤ 2. Total 2.5 can't tie. */
function ouSatisfied(pick: number, total: number): boolean {
  return pick === 0 ? total > 2.5 : total < 2.5;
}

/**
 * Per-leg live status for the user's pick.
 *   Result (buckets 3): leading → "on track" (good); else "trailing" (bad).
 *     Under-way: at-parity draws are trailing unless the pick IS the draw.
 *   O/U (buckets 2): satisfied → "on track" (good); else "at risk" (warn).
 *   Full-time (phase "ft"): resolves to "hit" (good) / "miss" (bad).
 *
 * `buckets` is the leg's catalog bucket count (2 = O/U, 3 = three-way).
 */
export function legLiveStatus(
  buckets: number,
  pick: number,
  live: CardLegLive,
): LegLiveStatus {
  const total = live.home + live.away;
  const ou = buckets === 2;
  const onTrack = ou ? ouSatisfied(pick, total) : resultLeading(pick, live.home, live.away);

  if (live.phase === "ft") {
    return onTrack ? { tone: "good", label: "hit", final: true }
                   : { tone: "bad", label: "miss", final: true };
  }
  if (onTrack) return { tone: "good", label: "on track", final: false };
  // Off-track while still playable: O/U is "at risk" (amber), Result "trailing" (red).
  return ou ? { tone: "warn", label: "at risk", final: false }
            : { tone: "bad", label: "trailing", final: false };
}
