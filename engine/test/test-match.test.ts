import { describe, it, expect } from "vitest";
import {
  testMatchState,
  testMatchDurationSecs,
  TEST_HOME,
  TEST_AWAY,
} from "../src/testMatch.ts";

// The scripted timeline (mirrors keeper/test-feed.ts DEFAULT_SCRIPT): goals at
// 75s (H), 215s (A), 345s (H); corners 40/170/260/390; yellows 130/300/430.
const LOCK = 1_000_000; // seconds
const DUR = 480;
const ms = (elapsedSec: number) => (LOCK + elapsedSec) * 1000;

describe("testMatchState — deterministic scripted presentation", () => {
  it("pre-kickoff: names only, no live/stats/events (the pre-game card owns that phase)", () => {
    const s = testMatchState(LOCK, DUR, ms(-30));
    expect(s.home).toBe(TEST_HOME);
    expect(s.away).toBe(TEST_AWAY);
    expect(s.live).toBeUndefined();
    expect(s.stats).toBeUndefined();
    expect(s.events).toBeUndefined();
  });

  it("mid-match (t=220s): 1-1, the scripted events so far, clock on the compressed 90' scale", () => {
    const s = testMatchState(LOCK, DUR, ms(220));
    expect(s.live).toEqual({ home: 1, away: 1, minute: Math.ceil((220 / DUR) * 90), phase: "live" });
    // 40s corner + 75s goal + 130s yellow + 170s corner + 215s goal happened.
    expect(s.stats?.corners).toEqual([1, 1]);
    expect(s.stats?.cards).toEqual([0, 1]);
    // Kick-off line + 5 scripted events.
    expect(s.events).toHaveLength(6);
    expect(s.events?.filter((e) => e.big)).toHaveLength(2); // both goals emphasized
  });

  it("full-time: 2-1, minute 90, phase ft, FT line appended", () => {
    const s = testMatchState(LOCK, DUR, ms(DUR + 5));
    expect(s.live).toEqual({ home: 2, away: 1, minute: 90, phase: "ft" });
    expect(s.stats?.corners).toEqual([2, 2]);
    expect(s.stats?.cards).toEqual([1, 2]);
    const last = s.events?.[s.events.length - 1];
    expect(last?.txt).toContain("Full-time");
    expect(last?.big).toBe(true);
  });

  it("goals never exceed shots, possession always sums to 100", () => {
    for (const t of [10, 100, 250, 400, 600]) {
      const s = testMatchState(LOCK, DUR, ms(t));
      expect(s.stats!.shots[0]).toBeGreaterThanOrEqual(s.live!.home);
      expect(s.stats!.shots[1]).toBeGreaterThanOrEqual(s.live!.away);
      expect(s.stats!.poss[0] + s.stats!.poss[1]).toBe(100);
    }
  });

  it("pure: identical inputs produce identical output objects", () => {
    expect(testMatchState(LOCK, DUR, ms(300))).toEqual(testMatchState(LOCK, DUR, ms(300)));
  });
});

describe("testMatchDurationSecs — inverse of the harness's settleAfterTs contract", () => {
  it("recovers durationSecs from lockTs + settleAfterTs (buffer = duration + 60)", () => {
    expect(testMatchDurationSecs(LOCK, LOCK + 480 + 60)).toBe(480);
  });
  it("floors at 60s for degenerate windows", () => {
    expect(testMatchDurationSecs(LOCK, LOCK + 30)).toBe(60);
  });
});
