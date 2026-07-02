/**
 * live-feed.ts — the PURE feed→outcome layer for the live-match keeper.
 *
 * Turns a TxLINE score event (PascalCase, string-keyed `Stats`) into the data a
 * `resolve_call` needs: a WINNING OPTION INDEX (never a raw stat or a sentinel),
 * a void-on-goal decision, per-kind call specs, and a match-phase classification.
 *
 * PURE and I/O-FREE by construction. Every export is an in-memory function over
 * plain data. This module imports ONLY pure constants from spike/src/config.ts
 * (phase codes + soccer stat keys — no dotenv, no Connection, no HTTP) and the
 * `ScoreEvent` TYPE from spike/src/discover.ts (erased at compile time — no
 * runtime import of discover's util/HTTP chain). Importing live-feed.ts fires
 * ZERO side effects, so the keeper's hermetic tests can import it freely.
 *
 * ── Resolve model (plan §"Resolve model") ──
 *   resolve_call(outcome: u8) takes a WINNING OPTION INDEX in [0, num_options),
 *   or the void sentinel 0xFE. It NEVER takes a raw stat or 0xFF.
 *   • NextGoal   (3 opts, base [4,1,4]): Δgoals home→0, no-goal→1, away→2.
 *   • GoalRush / CornerSoon / CardSoon (2 opts): watched stat rose → hit(0), else miss(1).
 *   • Void-on-goal (global): cumulative goal total Stats['1']+Stats['2'] rose while
 *     a NON-goal call (CornerSoon/CardSoon) was open → resolve_call(seq, 0xFE).
 */

import {
  FINISHED_PHASES,
  PHASE,
  VOID_PHASES,
  PHASE_NAME,
  SOCCER_STAT,
} from "../spike/src/config.js";
import type { ScoreEvent } from "../spike/src/discover.js";

/** On-chain void sentinel that `resolve_call` accepts (voids a call, refunds its points). */
export const VOID_OUTCOME = 0xfe;
/** On-chain "not yet resolved" sentinel — mapOutcomeToOption must NEVER emit this. */
export const OUTCOME_UNSET = 0xff;

/**
 * Call kinds (matches the on-chain `CallKind` enum discriminant order:
 * NextGoal0, GoalRush1, CornerSoon2, CardSoon3).
 */
export enum CallKind {
  NextGoal = 0,
  GoalRush = 1,
  CornerSoon = 2,
  CardSoon = 3,
}

/**
 * Per-kind resolvable spec.
 *
 * `basePoints` is the on-chain `open_call` wire array, which is a FIXED
 * `[u8; 3]` (see programs/proofbet/src/live_state.rs:117 and the IDL). It is
 * ALWAYS length 3 — binary kinds (numOptions === 2) carry a trailing 0 in the
 * third slot ([3,1,0] / [2,1,0]). Passing a 2-element array to Anchor borsh
 * under-serializes the instruction (only 2 of 3 bytes emitted), corrupting
 * `answer_secs` and failing on-chain deserialization, so the length is never
 * trimmed to `numOptions`.
 */
export interface CallSpec {
  numOptions: number;
  /** On-chain [u8; 3] wire array — always length 3 (trailing 0 for binary kinds). */
  basePoints: [number, number, number];
  answerSecs: number;
}

/**
 * Deltas (change since the call opened) fed to `mapOutcomeToOption`.
 * NextGoal uses home/away goal deltas; the binary kinds use `watched` (the rise
 * in whatever stat that kind watches — goals, corners keys 7/8, or yellows 3/4).
 */
export interface GoalDeltas {
  homeGoals?: number;
  awayGoals?: number;
  watched?: number;
}

/**
 * Static per-kind specs, mirrored from the web live game's call generators
 * (web/src/lib/liveGame.ts: nextGoal/goalRush/cornerSoon/cardSoon — the
 * base-point weights) with a fixed 20s answer window.
 *
 * 20s is the floor for a REAL pipeline, not a style choice: the sim's 9s
 * assumed a local feed. On chain the player only learns a call opened after
 * the engine's ER cache (≤1.5s) + the app's poll (≤2s), then needs to read,
 * decide, and land an ER tx (~1-2s) — 9s left ~3-5s of human time and players
 * missed every call (match #5, 2026-07-02: 8/8 calls unanswered by everyone).
 *
 * `basePoints` is the on-chain [u8; 3] wire array, so the binary (2-option)
 * kinds pad the unused third option with a trailing 0:
 *   NextGoal  : 3 opts, [home 4, no-goal 1, away 4]
 *   GoalRush  : 2 opts, [yes 3, no 1, —0]
 *   CornerSoon: 2 opts, [yes 2, no 1, —0]
 *   CardSoon  : 2 opts, [yes 3, no 1, —0]
 */
const CALL_SPECS: Record<CallKind, CallSpec> = {
  [CallKind.NextGoal]: { numOptions: 3, basePoints: [4, 1, 4], answerSecs: 20 },
  [CallKind.GoalRush]: { numOptions: 2, basePoints: [3, 1, 0], answerSecs: 20 },
  [CallKind.CornerSoon]: { numOptions: 2, basePoints: [2, 1, 0], answerSecs: 20 },
  [CallKind.CardSoon]: { numOptions: 2, basePoints: [3, 1, 0], answerSecs: 20 },
};

/** Kinds whose ANSWER is a goal — a goal rise is expected, so it must NOT void them. */
const GOAL_ANSWER_KINDS = new Set<CallKind>([CallKind.NextGoal, CallKind.GoalRush]);

/** Coerce a possibly-string / possibly-missing feed value to a finite number (default 0). */
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Cumulative goal total from a `Stats` map: P1_GOALS('1') + P2_GOALS('2').
 * Reads STRING keys (the feed keys `Stats` by the stat key as a string); a
 * missing key counts as 0; string numeric values are coerced.
 */
export function goalTotal(stats: Record<string, number> | undefined | null): number {
  if (!stats) return 0;
  return num(stats["1"]) + num(stats["2"]);
}

/**
 * The event carrying the freshest cumulative stats = the highest `Seq`.
 * Returns null for an empty list. Does not mutate the input.
 */
export function latestEvent(events: ScoreEvent[]): ScoreEvent | null {
  if (!events.length) return null;
  return events.reduce((best, e) => (e.Seq > best.Seq ? e : best), events[0]);
}

/**
 * The cumulative total of the stat a call kind WATCHES, from a `Stats` map:
 *   • NextGoal / GoalRush → goals  (P1_GOALS '1' + P2_GOALS '2')
 *   • CornerSoon          → corners (P1_CORNERS '7' + P2_CORNERS '8')
 *   • CardSoon            → yellows (P1_YELLOW '3' + P2_YELLOW '4')
 * Same string-key/missing-is-0 semantics as `goalTotal`.
 */
export function watchedTotal(
  kind: CallKind,
  stats: Record<string, number> | undefined | null,
): number {
  if (!stats) return 0;
  switch (kind) {
    case CallKind.NextGoal:
    case CallKind.GoalRush:
      return num(stats[String(SOCCER_STAT.P1_GOALS)]) + num(stats[String(SOCCER_STAT.P2_GOALS)]);
    case CallKind.CornerSoon:
      return (
        num(stats[String(SOCCER_STAT.P1_CORNERS)]) + num(stats[String(SOCCER_STAT.P2_CORNERS)])
      );
    case CallKind.CardSoon:
      return num(stats[String(SOCCER_STAT.P1_YELLOW)]) + num(stats[String(SOCCER_STAT.P2_YELLOW)]);
    default:
      throw new Error(`watchedTotal: unknown CallKind ${kind}`);
  }
}

/** Per-side cumulative goal counts from a `Stats` map (missing keys → 0). */
export function goalSides(
  stats: Record<string, number> | undefined | null,
): { home: number; away: number } {
  if (!stats) return { home: 0, away: 0 };
  return {
    home: num(stats[String(SOCCER_STAT.P1_GOALS)]),
    away: num(stats[String(SOCCER_STAT.P2_GOALS)]),
  };
}

/** Which side scored first inside a call window (or 'both' when unorderable). */
export type FirstGoalSide = "home" | "away" | "both" | null;

/**
 * Determine which side scored the FIRST goal after a baseline, by walking the
 * score events in ascending `Seq` order and finding the earliest event whose
 * cumulative home ('1') or away ('2') goal count exceeds the running baseline.
 *
 * This is the money-correct NextGoal resolver: comparing cumulative DELTAS at
 * the window's end mis-pays when BOTH teams score in one window (delta 1–1
 * looks like "no goal"). Walking event order recovers who scored first.
 *
 *   • the first event where ONLY home rose → 'home'
 *   • the first event where ONLY away rose → 'away'
 *   • the first rise shows BOTH sides up in the SAME event (a feed batch —
 *     the true order is unprovable) → 'both'  (caller voids: fair, no guess)
 *   • no rise across the window → null ("no goal")
 *
 * Events missing a `Stats` map are skipped. Baselines are the cumulative goal
 * counts when the call OPENED.
 */
export function firstGoalSide(
  events: ScoreEvent[],
  baseline: { home: number; away: number },
): FirstGoalSide {
  const HOME_KEY = String(SOCCER_STAT.P1_GOALS);
  const AWAY_KEY = String(SOCCER_STAT.P2_GOALS);
  const ordered = [...events].sort((a, b) => a.Seq - b.Seq);
  let prevHome = baseline.home;
  let prevAway = baseline.away;
  for (const ev of ordered) {
    const stats = ev.Stats as Record<string, unknown> | undefined;
    if (!stats) continue;
    // Read a side ONLY when its key is present — earlier feed events can carry
    // PARTIAL Stats maps, and coercing a missing key to 0 would slam the
    // baseline down and misread the next complete event as a fresh goal.
    const h = HOME_KEY in stats ? num(stats[HOME_KEY]) : null;
    const a = AWAY_KEY in stats ? num(stats[AWAY_KEY]) : null;
    const homeRose = h !== null && h > prevHome;
    const awayRose = a !== null && a > prevAway;
    if (homeRose && awayRose) return "both";
    if (homeRose) return "home";
    if (awayRose) return "away";
    // A present-but-LOWER value is a feed correction (goal disallowed) — follow
    // it down so a later re-score is detected as a fresh rise.
    if (h !== null && h < prevHome) prevHome = h;
    if (a !== null && a < prevAway) prevAway = a;
  }
  return null;
}

/**
 * Deterministic call-kind rotation for the pacing driver: seq 0 → NextGoal,
 * then CornerSoon, GoalRush, CardSoon, repeating. Deterministic (testable,
 * resumable after a keeper restart) and spreads the four kinds evenly.
 */
export function pickCallKind(seq: number): CallKind {
  const rotation = [CallKind.NextGoal, CallKind.CornerSoon, CallKind.GoalRush, CallKind.CardSoon];
  return rotation[((seq % rotation.length) + rotation.length) % rotation.length];
}

/** The per-kind resolvable spec (numOptions, basePoints, answerSecs). */
export function callSpec(kind: CallKind): CallSpec {
  const spec = CALL_SPECS[kind];
  if (!spec) throw new Error(`callSpec: unknown CallKind ${kind}`);
  // Return a shallow copy so callers cannot mutate the shared spec.
  const [b0, b1, b2] = spec.basePoints;
  return { numOptions: spec.numOptions, basePoints: [b0, b1, b2], answerSecs: spec.answerSecs };
}

/**
 * Map a resolved feed delta to a WINNING OPTION INDEX in [0, num_options).
 *
 * REAL-MONEY SAFETY: this NEVER returns a sentinel (0xFE/0xFF) and NEVER an
 * out-of-range index. Void decisions are made SEPARATELY by shouldVoidOnGoal —
 * this function only picks a legitimate option.
 *   • NextGoal: home goal delta > away → 0; away > home → 2; equal (incl. 0) → 1.
 *   • GoalRush/CornerSoon/CardSoon: watched > 0 → 0 (hit), else → 1 (miss).
 * Throws on an unknown kind rather than emitting a bad index.
 */
export function mapOutcomeToOption(kind: CallKind, deltas: GoalDeltas): number {
  switch (kind) {
    case CallKind.NextGoal: {
      const home = num(deltas.homeGoals);
      const away = num(deltas.awayGoals);
      if (home > away) return 0; // home scored (more)
      if (away > home) return 2; // away scored (more)
      return 1; // no goal, or an equal simultaneous rise → "no goal"
    }
    case CallKind.GoalRush:
    case CallKind.CornerSoon:
    case CallKind.CardSoon: {
      const watched = num(deltas.watched);
      return watched > 0 ? 0 : 1; // hit(0) / miss(1)
    }
    default:
      throw new Error(`mapOutcomeToOption: unknown CallKind ${kind}`);
  }
}

/**
 * Void-on-goal decision: true iff the cumulative goal total ROSE while a
 * NON-goal call (CornerSoon/CardSoon) was open. NextGoal/GoalRush treat a goal
 * as their answer, so a goal must NOT void them. A flat or (glitch) decreasing
 * goal total never voids.
 */
export function shouldVoidOnGoal(openKind: CallKind, prevGoals: number, curGoals: number): boolean {
  if (GOAL_ANSWER_KINDS.has(openKind)) return false;
  return curGoals > prevGoals;
}

/** Match-phase classification. */
export type Phase = "ft" | "void" | "ht" | "live";

/**
 * Classify a score event's phase, wrapping the spike's `resolvePhase` semantics
 * (StatusId first, then GameState). Reimplemented inline (not imported) so this
 * module pulls in NO HTTP/dotenv chain from discover.ts.
 *   FINISHED {5,10,13} → 'ft' (settle); VOID {14..19} → 'void'; HT(3) → 'ht';
 *   everything else → 'live'.
 */
export function detectPhase(event: ScoreEvent): Phase {
  const code = phaseCode(event);
  if (code === null) return "live";
  if (FINISHED_PHASES.has(code)) return "ft";
  if (VOID_PHASES.has(code)) return "void";
  if (code === PHASE.HT) return "ht";
  return "live";
}

const NAME_TO_PHASE: Record<string, number> = Object.fromEntries(
  Object.entries(PHASE_NAME).map(([code, name]) => [name, Number(code)]),
);

/** Resolve a numeric phase code from StatusId (number | string | tagged object). */
function phaseCode(ev: ScoreEvent): number | null {
  const s = ev.StatusId;
  if (typeof s === "number") return s;
  if (typeof s === "string") {
    if (s in NAME_TO_PHASE) return NAME_TO_PHASE[s];
    const n = Number(s);
    if (!Number.isNaN(n)) return n;
  }
  if (s && typeof s === "object") {
    const key = Object.keys(s)[0]; // tagged-union form { F: {} }
    if (key) {
      if (key in NAME_TO_PHASE) return NAME_TO_PHASE[key];
      const n = Number(key);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}
