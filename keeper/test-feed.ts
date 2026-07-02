/**
 * test-feed.ts — a scripted, deterministic score feed for TEST MATCHES.
 *
 * A test match is a REAL on-chain pool played for REAL (devnet) SOL through the
 * REAL pipeline — join → delegate → ER calls/taps → score → settle/claim. The ONLY
 * synthetic piece is this feed: no real fixture is in play, so the keeper's
 * `fetchEvents` seam (live-runner.ts FetchEvents) is served from a fixed script
 * instead of TxLINE. Same ScoreEvent shape, same cumulative-Stats semantics, same
 * StatusId phases (H1=2 live, F=5 full-time) the real feed uses — the runner
 * cannot tell the difference, which is the point: it exercises the exact
 * production path.
 *
 * The script compresses a match into `durationSecs` (default 8 min): goals,
 * corners and yellows land at fixed offsets from kickoff, so some call windows
 * see the watched stat move (a "Yes"/side hit) and others don't — real gameplay
 * variety, fully deterministic and unit-testable.
 */
import type { ScoreEvent } from "../spike/src/discover.js";
import type { FetchEvents } from "./live-runner.js";

/** One scripted increment: at `atSec` past kickoff, stat `key` bumps by 1. */
interface ScriptStep {
  atSec: number;
  /** TxLINE stat key: '1'/'2' home/away goals, '3'/'4' yellows, '7'/'8' corners. */
  key: "1" | "2" | "3" | "4" | "7" | "8";
}

/** The default 8-minute match: 3 goals (2-1), 4 corners, 3 yellows. */
export const DEFAULT_SCRIPT: ScriptStep[] = [
  { atSec: 40, key: "7" },  // corner, home
  { atSec: 75, key: "1" },  // GOAL home        1-0
  { atSec: 130, key: "4" }, // yellow, away
  { atSec: 170, key: "8" }, // corner, away
  { atSec: 215, key: "2" }, // GOAL away        1-1
  { atSec: 260, key: "7" }, // corner, home
  { atSec: 300, key: "3" }, // yellow, home
  { atSec: 345, key: "1" }, // GOAL home        2-1
  { atSec: 390, key: "8" }, // corner, away
  { atSec: 430, key: "4" }, // yellow, away
];

const PHASE_NS = 1;   // not started
const PHASE_H1 = 2;   // in play
const PHASE_F = 5;    // full time

/**
 * The full scripted event history at `elapsedSec` past kickoff (cumulative Stats,
 * ascending Seq — exactly what getScoreHistory returns for a real fixture).
 * Pre-kickoff → a single NS snapshot; past `durationSecs` → the final stats under
 * StatusId F (full time), which sends the runner down the finalize path.
 */
export function scriptedEvents(
  fixtureId: number,
  elapsedSec: number,
  script: ScriptStep[] = DEFAULT_SCRIPT,
  durationSecs = 480,
): ScoreEvent[] {
  if (elapsedSec < 0) {
    return [{ FixtureId: fixtureId, Seq: 1, StatusId: PHASE_NS, Stats: {} } as ScoreEvent];
  }
  const events: ScoreEvent[] = [
    { FixtureId: fixtureId, Seq: 1, StatusId: PHASE_H1, Stats: {} } as ScoreEvent,
  ];
  const stats: Record<string, number> = {};
  let seq = 1;
  for (const step of script) {
    if (step.atSec > elapsedSec || step.atSec >= durationSecs) break;
    stats[step.key] = (stats[step.key] ?? 0) + 1;
    seq += 1;
    events.push({
      FixtureId: fixtureId,
      Seq: seq,
      StatusId: PHASE_H1,
      Stats: { ...stats },
    } as ScoreEvent);
  }
  if (elapsedSec >= durationSecs) {
    events.push({
      FixtureId: fixtureId,
      Seq: seq + 1,
      StatusId: PHASE_F, // full time → the runner finalizes (end → settle)
      Stats: { ...stats },
    } as ScoreEvent);
  }
  return events;
}

/**
 * A FetchEvents seam serving the script against the wall clock: each call returns
 * the history as of `now() − kickoffMs`. Drop-in replacement for the TxLINE
 * getScoreHistory wiring in cron.ts — the runner sees a live match that kicks off
 * at `kickoffMs` and finishes `durationSecs` later.
 */
export function makeSimFeed(
  fixtureId: number,
  kickoffMs: number,
  opts: { durationSecs?: number; script?: ScriptStep[]; now?: () => number } = {},
): FetchEvents {
  const now = opts.now ?? Date.now;
  return async (fid: number) => {
    if (fid !== fixtureId) return [];
    const elapsedSec = Math.floor((now() - kickoffMs) / 1000);
    return scriptedEvents(fixtureId, elapsedSec, opts.script, opts.durationSecs);
  };
}
