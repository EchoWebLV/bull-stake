/** test-feed tests — the scripted match feed is pure and deterministic. */
import { describe, it, expect } from "vitest";
import { scriptedEvents, makeSimFeed, replayScript, DEFAULT_SCRIPT } from "../test-feed.js";
import { detectPhase, latestEvent, goalSides, goalTotal } from "../live-feed.js";

const FID = 9_900_000_001;

describe("scriptedEvents — cumulative history at an elapsed time", () => {
  it("pre-kickoff → a single not-started snapshot (phase 'live' is never reported early)", () => {
    const ev = scriptedEvents(FID, -30);
    expect(ev).toHaveLength(1);
    expect(detectPhase(ev[0])).not.toBe("ft"); // NS folds to live-ish, never final
    expect(goalTotal(latestEvent(ev)?.Stats)).toBe(0);
  });

  it("mid-match: stats accumulate in script order with ascending Seq", () => {
    // elapsed 220s → corner(40) goal-home(75) yellow(130) corner(170) goal-away(215)
    const ev = scriptedEvents(FID, 220);
    const last = latestEvent(ev)!;
    expect(detectPhase(last)).toBe("live");
    expect(goalSides(last.Stats)).toEqual({ home: 1, away: 1 });
    expect(last.Stats?.["7"]).toBe(1); // home corner
    expect(last.Stats?.["8"]).toBe(1); // away corner
    expect(last.Stats?.["4"]).toBe(1); // away yellow
    const seqs = ev.map((e) => e.Seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // ascending
  });

  it("full time: past durationSecs the last event is StatusId F with the final stats", () => {
    const ev = scriptedEvents(FID, 9_999, DEFAULT_SCRIPT, 480);
    const last = latestEvent(ev)!;
    expect(detectPhase(last)).toBe("ft");
    expect(goalSides(last.Stats)).toEqual({ home: 2, away: 1 }); // scripted 2-1
  });

  it("deterministic: same elapsed → identical history", () => {
    expect(scriptedEvents(FID, 300)).toEqual(scriptedEvents(FID, 300));
  });
});

describe("makeSimFeed — the FetchEvents seam", () => {
  it("serves the script against the injected clock and ignores other fixtures", async () => {
    let t = 0;
    const kickoffMs = 1_000_000;
    const feed = makeSimFeed(FID, kickoffMs, { durationSecs: 480, now: () => t });

    t = kickoffMs - 60_000; // T-1min
    expect(goalTotal(latestEvent(await feed(FID))?.Stats)).toBe(0);

    t = kickoffMs + 80_000; // 80s in → first goal landed at 75s
    expect(goalSides(latestEvent(await feed(FID))!.Stats)).toEqual({ home: 1, away: 0 });

    t = kickoffMs + 500_000; // past 480s → full time
    expect(detectPhase(latestEvent(await feed(FID))!)).toBe("ft");

    expect(await feed(123)).toEqual([]); // not our fixture
  });
});

describe("replayScript — real event history → compressed sim script", () => {
  const cum = (seq: number, statusId: number, stats: Record<string, number>) =>
    ({ FixtureId: 555, Seq: seq, StatusId: statusId, Stats: stats }) as never;

  it("emits one step per unit increase per key, in Seq order, uniformly spaced inside the window", () => {
    // Deliberately unsorted, with a post-terminal StatusId-100 quirk event.
    const events = [
      cum(40, 3, { "1": 1, "2": 1, "7": 1 }), // HT snapshot
      cum(10, 2, { "1": 1 }), // 1-0
      cum(1, 1, {}), // NS
      cum(20, 2, { "1": 1, "2": 1 }), // 1-1
      cum(30, 2, { "1": 1, "2": 1, "7": 1 }), // corner home
      cum(60, 5, { "1": 2, "2": 1, "7": 1, "4": 1 }), // FT: 2-1 + away yellow
      cum(70, 100, { "1": 3, "2": 1, "7": 1, "4": 1 }), // post-terminal quirk — ignored
    ];
    const script = replayScript(events, 480);
    expect(script.map((s) => s.key)).toEqual(["1", "2", "7", "1", "4"]);
    const at = script.map((s) => s.atSec);
    expect([...at].sort((a, b) => a - b)).toEqual(at); // monotonic
    expect(at[0]).toBeGreaterThanOrEqual(30); // breathing room after kickoff
    expect(at[at.length - 1]).toBeLessThanOrEqual(480 - 50); // strictly before the FT cutoff
  });

  it("drops unsupported stat keys and cumulative regressions", () => {
    const events = [
      cum(1, 2, { "1": 1, "1001": 5, "9999": 2 }),
      cum(2, 2, { "1": 0, "1001": 6 }), // regression on "1" — ignored, no negative steps
      cum(3, 5, { "1": 1, "1001": 7 }),
    ];
    const script = replayScript(events, 480);
    expect(script).toHaveLength(1);
    expect(script[0].key).toBe("1");
  });

  it("a replay script drives makeSimFeed to the same final stats as the source history", async () => {
    const events = [
      cum(1, 1, {}),
      cum(2, 2, { "2": 1 }),
      cum(3, 2, { "2": 2, "8": 1 }),
      cum(4, 5, { "1": 1, "2": 2, "8": 1 }), // FT 1-2, one away corner
    ];
    const script = replayScript(events, 480);
    const feed = makeSimFeed(FID, 1_000_000, { durationSecs: 480, script, now: () => 1_000_000 + 481_000 });
    const last = latestEvent(await feed(FID))!;
    expect(detectPhase(last)).toBe("ft");
    expect(goalSides(last.Stats)).toEqual({ home: 1, away: 2 });
    expect(last.Stats?.["8"]).toBe(1);
  });
});
