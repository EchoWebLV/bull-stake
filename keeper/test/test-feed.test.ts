/** test-feed tests — the scripted match feed is pure and deterministic. */
import { describe, it, expect } from "vitest";
import { scriptedEvents, makeSimFeed, DEFAULT_SCRIPT } from "../test-feed.js";
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
