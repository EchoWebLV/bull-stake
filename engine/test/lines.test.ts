// engine/test/lines.test.ts
import { describe, it, expect } from "vitest";
import { LinesStore, downsample } from "../src/lines.ts";
import type { OddsRow } from "../../spike/src/odds.js";

const MIN = 60_000;
function lineRow(ts: number, p1: string): OddsRow {
  return {
    FixtureId: 7, MessageId: `m${ts}`, Ts: ts,
    Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT", GameState: null, InRunning: false,
    MarketParameters: null, MarketPeriod: null,
    PriceNames: ["part1", "draw", "part2"], Prices: [1800, 2900, 9000],
    Pct: [p1, "25.0", "15.0"],
  };
}

describe("downsample", () => {
  it("keeps at most one point per bucket and always the last point", () => {
    const pts: [number, number][] = [
      [0, 1], [10_000, 2], [59_000, 3], [61_000, 4], [125_000, 5],
    ];
    expect(downsample(pts, 60_000)).toEqual([[0, 1], [61_000, 4], [125_000, 5]]);
  });
});

describe("LinesStore", () => {
  it("seeds history once from updates, then appends snapshot changes", async () => {
    let updatesCalls = 0;
    const store = new LinesStore({
      fetchUpdates: async () => { updatesCalls++; return [lineRow(0, "60.0"), lineRow(2 * MIN, "61.0")]; },
      fetchSnapshot: async () => [lineRow(5 * MIN, "62.5")],
    });
    await store.track(7, 1); // fixtureId, favSide
    expect(updatesCalls).toBe(1);
    expect(store.series(7)).toEqual([[0, 60000], [2 * MIN, 61000]]);

    await store.poll();
    expect(store.current(7)).toEqual({ pctMilli: 62500, ts: 5 * MIN });
    expect(store.series(7)).toEqual([[0, 60000], [2 * MIN, 61000], [5 * MIN, 62500]]);

    await store.poll(); // same snapshot again → no duplicate point
    expect(store.series(7)).toHaveLength(3);
    await store.track(7, 1); // re-track → no re-seed
    expect(updatesCalls).toBe(1);
  });

  it("current() is null when no line rows exist; untrack stops polling", async () => {
    const store = new LinesStore({
      fetchUpdates: async () => [],
      fetchSnapshot: async () => [],
    });
    await store.track(9, 2);
    await store.poll();
    expect(store.current(9)).toBeNull();
    expect(store.series(9)).toEqual([]);
    store.untrack(9);
    expect(store.tracked()).toEqual([]);
  });

  it("remembers fixture names", () => {
    const store = new LinesStore({ fetchUpdates: async () => [], fetchSnapshot: async () => [] });
    store.setNames([{ fixtureId: 7, home: "Spain", away: "Austria" }]);
    expect(store.name(7)).toEqual({ home: "Spain", away: "Austria" });
    expect(store.name(8)).toBeNull();
  });
});
