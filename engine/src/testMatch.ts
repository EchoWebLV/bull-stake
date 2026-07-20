/**
 * testMatch.ts — presentation state for TEST MATCHES (fixtureId ≥ TEST_FIXTURE_MIN).
 *
 * A test match's pool/calls/points are all REAL on-chain state; only its score
 * feed is scripted (keeper/test-feed.ts drives resolution from DEFAULT_SCRIPT).
 * The chain carries no match drama though — no score, no stats, no events — so
 * the app's match panel rendered dashes and the game looked dead.
 *
 * This module mirrors THAT SAME script (same offsets, same stat keys) and
 * computes the match state at any wall-clock instant from nothing but the pool's
 * on-chain timestamps. Deterministic — same inputs, same output, no RNG — and
 * consistent by construction with what the keeper resolves: when the panel shows
 * a corner, the corner call it settles is the same scripted event.
 *
 * The 8-minute script is presented as a 90' match: elapsed seconds map linearly
 * onto match minutes, so the clock reads 0'→90' over `durationSecs`.
 */

/** One scripted increment (MIRRORS keeper/test-feed.ts DEFAULT_SCRIPT — keep in sync).
 *  Keys: '1'/'2' home/away goals, '3'/'4' home/away yellows, '7'/'8' home/away corners. */
type ScriptStep = { atSec: number; key: "1" | "2" | "3" | "4" | "7" | "8" };
const DEFAULT_SCRIPT: ScriptStep[] = [
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

/**
 * TEST_SCRIPT_JSON env override: a JSON array of {key, atSec} produced by the
 * keeper's replayScript (a real fixture's history compressed to the match
 * duration). Lets a `run-test-match --replay <fixtureId>` run keep the panel in
 * lockstep with the calls it resolves — same steps on both sides. Falls back to
 * DEFAULT_SCRIPT on absent/invalid input.
 */
function loadScript(): ScriptStep[] {
  const raw = process.env.TEST_SCRIPT_JSON;
  if (!raw) return DEFAULT_SCRIPT;
  try {
    const arr = JSON.parse(raw) as ScriptStep[];
    if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_SCRIPT;
    return [...arr].sort((a, b) => a.atSec - b.atSec);
  } catch {
    return DEFAULT_SCRIPT;
  }
}
const SCRIPT: ScriptStep[] = loadScript();

/**
 * Test-match display identity. Defaults are clearly synthetic; TEST_HOME /
 * TEST_AWAY env overrides let a replay run (keeper run-test-match --replay)
 * carry the real fixture's team names on the /test page.
 */
export const TEST_HOME = process.env.TEST_HOME ?? "Streak City";
export const TEST_AWAY = process.env.TEST_AWAY ?? "Devnet Rovers";

/**
 * TEST SWEEP roster — the fixed six synthetic matches behind the /test-page
 * Sweep card (keeper/create-test-sweep.ts creates a Contest over exactly these
 * fixtureId+marketId legs; the engine's /api/card?test=1 names them from this
 * same table). Keyed by fixtureId so a leg's team names survive the round-trip
 * to chain and back (the Contest stores only fixtureId + marketId, no names).
 *
 * fixtureIds sit in 10_000_000_00X — above TEST_FIXTURE_MIN (so they read as
 * test) AND above the live test-match band (9_900_000_000 + secondsOfEra, which
 * never reaches 100_000_000), so a Sweep leg can never collide with a running
 * Live test match. marketId picks a catalog market: 12 = Match Result (3-way),
 * 11 = Total Goals O/U 2.5 (2-way) — a mix so the card reads like a real Sweep.
 */
export interface TestSweepLeg { fixtureId: number; home: string; away: string; marketId: number; }
export const TEST_SWEEP_LEGS: TestSweepLeg[] = [
  { fixtureId: 10_000_000_001, home: "France", away: "England", marketId: 12 },
  { fixtureId: 10_000_000_002, home: "Spain", away: "Brazil", marketId: 12 },
  { fixtureId: 10_000_000_003, home: "Argentina", away: "Germany", marketId: 11 },
  { fixtureId: 10_000_000_004, home: "Portugal", away: "Netherlands", marketId: 12 },
  { fixtureId: 10_000_000_005, home: "Croatia", away: "Morocco", marketId: 11 },
  { fixtureId: 10_000_000_006, home: "Uruguay", away: "Mexico", marketId: 12 },
];

/** Team names for a test-Sweep leg fixture, or null for any other id (the caller
 *  then falls back to the single TEST_HOME/TEST_AWAY pair or "#<fixtureId>"). */
export function testSweepLegName(fixtureId: number): { home: string; away: string } | null {
  const leg = TEST_SWEEP_LEGS.find((l) => l.fixtureId === fixtureId);
  return leg ? { home: leg.home, away: leg.away } : null;
}

export interface TestMatchEvent {
  /** Match minute on the compressed 90' clock ('' for pre-match lines). */
  min: number | "";
  txt: string;
  /** Big moments (goals) render emphasized in the feed. */
  big: boolean;
}

export interface TestMatchState {
  home: string;
  away: string;
  /** Present once kicked off (mirrors the real-fixture `live` join shape). */
  live?: { home: number; away: number; minute: number; phase: "live" | "ft" };
  /** Per-side counters, home first. */
  stats?: { shots: [number, number]; corners: [number, number]; cards: [number, number]; poss: [number, number] };
  /** Chronological scripted events up to now (web renders newest first). */
  events?: TestMatchEvent[];
}

/** Map an elapsed-seconds offset onto the compressed 90' clock. */
function matchMinute(atSec: number, durationSecs: number): number {
  return Math.max(1, Math.min(90, Math.ceil((atSec / durationSecs) * 90)));
}

const EVENT_TXT: Record<string, (side: string) => { txt: string; big: boolean }> = {
  goal: (side) => ({ txt: `GOAL — ${side}`, big: true }),
  corner: (side) => ({ txt: `Corner — ${side}`, big: false }),
  yellow: (side) => ({ txt: `Yellow card — ${side}`, big: false }),
};

/**
 * The scripted match state at `nowMs` for a test pool that kicks off at
 * `lockTs` (seconds) and plays `durationSecs`. Pre-kickoff → names only
 * (the pre-game card owns that phase); in play → live score/clock + stats +
 * events; past full-time → the final 2-1 under phase 'ft'.
 */
export function testMatchState(lockTs: number, durationSecs: number, nowMs: number): TestMatchState {
  const elapsedSec = Math.floor(nowMs / 1000) - lockTs;
  if (elapsedSec < 0) return { home: TEST_HOME, away: TEST_AWAY };

  const ft = elapsedSec >= durationSecs;
  const minute = ft ? 90 : matchMinute(elapsedSec, durationSecs);

  const n = { "1": 0, "2": 0, "3": 0, "4": 0, "7": 0, "8": 0 };
  const events: TestMatchEvent[] = [{ min: 1, txt: "Kick-off", big: false }];
  for (const step of SCRIPT) {
    if (step.atSec > elapsedSec || step.atSec >= durationSecs) break;
    n[step.key] += 1;
    const side = ["1", "3", "7"].includes(step.key) ? TEST_HOME : TEST_AWAY;
    const kind = step.key === "1" || step.key === "2" ? "goal" : step.key === "3" || step.key === "4" ? "yellow" : "corner";
    const { txt, big } = EVENT_TXT[kind](side);
    events.push({ min: matchMinute(step.atSec, durationSecs), txt, big });
  }
  if (ft) events.push({ min: 90, txt: `Full-time — ${TEST_HOME} ${n["1"]}–${n["2"]} ${TEST_AWAY}`, big: true });

  // Shots and possession are presentation-only (the script doesn't drive calls
  // with them): derived deterministically so the panel breathes, goals ≤ shots
  // always holds, and every client computes the identical numbers.
  const shots: [number, number] = [n["1"] * 3 + n["7"], n["2"] * 3 + n["8"]];
  const possH = 48 + ((minute * 7) % 9); // 48–56, drifts with the clock
  return {
    home: TEST_HOME,
    away: TEST_AWAY,
    live: { home: n["1"], away: n["2"], minute, phase: ft ? "ft" : "live" },
    stats: {
      shots,
      corners: [n["7"], n["8"]],
      cards: [n["3"], n["4"]],
      poss: [possH, 100 - possH],
    },
    events,
  };
}

/**
 * Recover a test pool's match duration from its on-chain timestamps. The test
 * harness (keeper/run-test-match.ts) always creates pools with
 * `settleAfterTs = lockTs + durationSecs + 60` (settle opens 1 min after FT),
 * so the inverse is exact — the same recovery its --resume path uses.
 */
export function testMatchDurationSecs(lockTs: number, settleAfterTs: number): number {
  return Math.max(60, settleAfterTs - lockTs - 60);
}
