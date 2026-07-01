/**
 * Unit tests for keeper/live-feed.ts — the PURE feed→outcome layer that maps a
 * TxLINE score event into a resolvable Call option index, decides void-on-goal,
 * and classifies match phase.
 *
 * HERMETIC by construction: live-feed.ts is a pure module — every export is an
 * in-memory function over plain data (a `Stats` map, a `ScoreEvent`, deltas).
 * Importing it fires ZERO I/O: no Connection, no RPC, no feed HTTP, no dotenv,
 * no wallet load. It imports only from spike/src/config.ts (pure constants, no
 * dotenv) and reuses the phase codes verbatim. A test that hit the network or
 * spent SOL would be a FAILING test; none here does. All inputs are hand-built
 * fixtures modelled on the real discover.ts ScoreEvent shape (PascalCase,
 * string-keyed `Stats`).
 */

import { describe, it, expect } from "vitest";
import {
  CallKind,
  goalTotal,
  latestEvent,
  mapOutcomeToOption,
  shouldVoidOnGoal,
  callSpec,
  detectPhase,
  VOID_OUTCOME,
  type GoalDeltas,
} from "../live-feed.js";
import type { ScoreEvent } from "../../spike/src/discover.js";

// ── goalTotal ───────────────────────────────────────────────────────────────

describe("goalTotal", () => {
  it("reads string keys '1' and '2' (P1_GOALS + P2_GOALS)", () => {
    expect(goalTotal({ "1": 2, "2": 1 })).toBe(3);
  });

  it("missing keys count as 0", () => {
    expect(goalTotal({})).toBe(0);
    expect(goalTotal({ "1": 3 })).toBe(3);
    expect(goalTotal({ "2": 1 })).toBe(1);
  });

  it("coerces string numeric values", () => {
    // The feed sometimes serializes stat values as strings.
    expect(goalTotal({ "1": "2" as unknown as number, "2": "1" as unknown as number })).toBe(3);
  });

  it("tolerates an undefined stats map", () => {
    expect(goalTotal(undefined)).toBe(0);
  });
});

// ── latestEvent ─────────────────────────────────────────────────────────────

describe("latestEvent", () => {
  it("returns the event with the highest Seq (freshest cumulative stats)", () => {
    const evs: ScoreEvent[] = [
      { FixtureId: 1, Seq: 10 },
      { FixtureId: 1, Seq: 42 },
      { FixtureId: 1, Seq: 7 },
    ];
    expect(latestEvent(evs)?.Seq).toBe(42);
  });

  it("returns null for an empty list", () => {
    expect(latestEvent([])).toBeNull();
  });

  it("does not mutate the input order", () => {
    const evs: ScoreEvent[] = [
      { FixtureId: 1, Seq: 5 },
      { FixtureId: 1, Seq: 9 },
    ];
    latestEvent(evs);
    expect(evs.map((e) => e.Seq)).toEqual([5, 9]);
  });
});

// ── mapOutcomeToOption (REAL-MONEY SAFETY SURFACE) ───────────────────────────

describe("mapOutcomeToOption", () => {
  it("NextGoal: home goal delta wins → option 0", () => {
    const d: GoalDeltas = { homeGoals: 1, awayGoals: 0 };
    expect(mapOutcomeToOption(CallKind.NextGoal, d)).toBe(0);
  });

  it("NextGoal: no goal → option 1", () => {
    const d: GoalDeltas = { homeGoals: 0, awayGoals: 0 };
    expect(mapOutcomeToOption(CallKind.NextGoal, d)).toBe(1);
  });

  it("NextGoal: away goal delta wins → option 2", () => {
    const d: GoalDeltas = { homeGoals: 0, awayGoals: 1 };
    expect(mapOutcomeToOption(CallKind.NextGoal, d)).toBe(2);
  });

  it("NextGoal: simultaneous same-side rise favors the larger delta", () => {
    expect(mapOutcomeToOption(CallKind.NextGoal, { homeGoals: 2, awayGoals: 1 })).toBe(0);
    expect(mapOutcomeToOption(CallKind.NextGoal, { homeGoals: 1, awayGoals: 2 })).toBe(2);
  });

  it("GoalRush: watched stat rose → hit (0), else miss (1)", () => {
    expect(mapOutcomeToOption(CallKind.GoalRush, { watched: 1 })).toBe(0);
    expect(mapOutcomeToOption(CallKind.GoalRush, { watched: 0 })).toBe(1);
  });

  it("CornerSoon: rose → 0, flat → 1", () => {
    expect(mapOutcomeToOption(CallKind.CornerSoon, { watched: 2 })).toBe(0);
    expect(mapOutcomeToOption(CallKind.CornerSoon, { watched: 0 })).toBe(1);
  });

  it("CardSoon: rose → 0, flat → 1", () => {
    expect(mapOutcomeToOption(CallKind.CardSoon, { watched: 1 })).toBe(0);
    expect(mapOutcomeToOption(CallKind.CardSoon, { watched: 0 })).toBe(1);
  });

  it("NEVER returns a sentinel (0xFE/0xFF) or an out-of-range index for ANY kind/delta", () => {
    const kinds = [CallKind.NextGoal, CallKind.GoalRush, CallKind.CornerSoon, CallKind.CardSoon];
    // A wide sweep of plausible + adversarial deltas (including negatives, which
    // should never happen for cumulative stats but must not break the mapper).
    const deltaSamples: GoalDeltas[] = [];
    for (const h of [-1, 0, 1, 2, 5]) {
      for (const a of [-1, 0, 1, 2, 5]) {
        deltaSamples.push({ homeGoals: h, awayGoals: a, watched: h + a });
      }
    }
    for (const kind of kinds) {
      const numOptions = callSpec(kind).numOptions;
      for (const d of deltaSamples) {
        const opt = mapOutcomeToOption(kind, d);
        expect(opt).not.toBe(0xfe);
        expect(opt).not.toBe(0xff);
        expect(Number.isInteger(opt)).toBe(true);
        expect(opt).toBeGreaterThanOrEqual(0);
        expect(opt).toBeLessThan(numOptions);
      }
    }
  });

  it("throws on an unknown kind rather than emitting a bad index", () => {
    expect(() => mapOutcomeToOption(99 as unknown as CallKind, { watched: 1 })).toThrow();
  });
});

// ── shouldVoidOnGoal ─────────────────────────────────────────────────────────

describe("shouldVoidOnGoal", () => {
  it("fires for a NON-goal call (CornerSoon) when the goal total rose", () => {
    expect(shouldVoidOnGoal(CallKind.CornerSoon, 1, 2)).toBe(true);
  });

  it("fires for CardSoon on a goal rise", () => {
    expect(shouldVoidOnGoal(CallKind.CardSoon, 0, 1)).toBe(true);
  });

  it("does NOT fire for NextGoal (a goal is its answer, not a void)", () => {
    expect(shouldVoidOnGoal(CallKind.NextGoal, 0, 1)).toBe(false);
  });

  it("does NOT fire for GoalRush (a goal is its answer, not a void)", () => {
    expect(shouldVoidOnGoal(CallKind.GoalRush, 0, 1)).toBe(false);
  });

  it("does NOT fire when the goal total is unchanged", () => {
    expect(shouldVoidOnGoal(CallKind.CornerSoon, 2, 2)).toBe(false);
    expect(shouldVoidOnGoal(CallKind.CardSoon, 2, 2)).toBe(false);
  });

  it("does NOT fire when the goal total somehow decreased (data glitch)", () => {
    expect(shouldVoidOnGoal(CallKind.CornerSoon, 3, 2)).toBe(false);
  });
});

// ── callSpec ─────────────────────────────────────────────────────────────────

describe("callSpec", () => {
  it("NextGoal → 3 options, base points [4,1,4], 9s answer window", () => {
    expect(callSpec(CallKind.NextGoal)).toEqual({
      numOptions: 3,
      basePoints: [4, 1, 4],
      answerSecs: 9,
    });
  });

  it("GoalRush → 2 options, [3,1,0]", () => {
    expect(callSpec(CallKind.GoalRush)).toEqual({ numOptions: 2, basePoints: [3, 1, 0], answerSecs: 9 });
  });

  it("CornerSoon → 2 options, [2,1,0]", () => {
    expect(callSpec(CallKind.CornerSoon)).toEqual({ numOptions: 2, basePoints: [2, 1, 0], answerSecs: 9 });
  });

  it("CardSoon → 2 options, [3,1,0]", () => {
    expect(callSpec(CallKind.CardSoon)).toEqual({ numOptions: 2, basePoints: [3, 1, 0], answerSecs: 9 });
  });

  it("every basePoints array is exactly length 3 (on-chain [u8;3] wire array)", () => {
    // base_points is a FIXED [u8; 3] on-chain; a short array under-serializes the
    // open_call ix and corrupts answer_secs. Binary kinds pad the third slot with 0.
    for (const kind of [CallKind.NextGoal, CallKind.GoalRush, CallKind.CornerSoon, CallKind.CardSoon]) {
      const s = callSpec(kind);
      expect(s.basePoints.length).toBe(3);
    }
  });
});

// ── detectPhase ──────────────────────────────────────────────────────────────

describe("detectPhase", () => {
  const ev = (statusId: number): ScoreEvent => ({ FixtureId: 1, Seq: 1, StatusId: statusId });

  it("finished phases {5,10,13} → 'ft'", () => {
    for (const s of [5, 10, 13]) expect(detectPhase(ev(s))).toBe("ft");
  });

  it("void phases {14..19} → 'void'", () => {
    for (const s of [14, 15, 16, 17, 18, 19]) expect(detectPhase(ev(s))).toBe("void");
  });

  it("halftime (3) → 'ht' (NOT ft)", () => {
    expect(detectPhase(ev(3))).toBe("ht");
  });

  it("in-play phases → 'live'", () => {
    for (const s of [1, 2, 4, 6, 7, 8, 9, 11, 12]) expect(detectPhase(ev(s))).toBe("live");
  });

  it("reads a string StatusId (feed sometimes stringifies)", () => {
    expect(detectPhase({ FixtureId: 1, Seq: 1, StatusId: "5" })).toBe("ft");
    expect(detectPhase({ FixtureId: 1, Seq: 1, StatusId: "F" })).toBe("ft");
  });

  it("falls back to 'live' when phase is unknown/absent", () => {
    expect(detectPhase({ FixtureId: 1, Seq: 1 })).toBe("live");
  });
});

// ── exported sentinel ────────────────────────────────────────────────────────

describe("VOID_OUTCOME", () => {
  it("is 0xFE (the on-chain void sentinel resolve_call accepts)", () => {
    expect(VOID_OUTCOME).toBe(0xfe);
  });
});
