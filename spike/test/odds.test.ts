// spike/test/odds.test.ts
import { describe, it, expect } from "vitest";
import {
  isLineRow, favouriteSide, pctMilliFor, latestLineRowAtOrBefore,
  type OddsRow,
} from "../src/odds.js";

/** A verified-shape StablePrice full-game 1X2 row (probe 2026-07-02). */
function row(over: Partial<OddsRow> = {}): OddsRow {
  return {
    FixtureId: 18179551,
    MessageId: "m1",
    Ts: 1_782_983_557_629,
    Bookmaker: "TXLineStablePriceDemargined",
    BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    GameState: null,
    InRunning: false,
    MarketParameters: null,
    MarketPeriod: null,
    PriceNames: ["part1", "draw", "part2"],
    Prices: [1838, 2832, 9740],
    Pct: ["54.407", "35.311", "10.267"],
    ...over,
  };
}

describe("isLineRow", () => {
  it("accepts a full-game pre-match StablePrice 1X2 row", () => {
    expect(isLineRow(row())).toBe(true);
  });
  it("rejects half-period rows", () => {
    expect(isLineRow(row({ MarketPeriod: "half=1" }))).toBe(false);
  });
  it("rejects in-running rows", () => {
    expect(isLineRow(row({ InRunning: true }))).toBe(false);
  });
  it("rejects other odds types and other bookmakers", () => {
    expect(isLineRow(row({ SuperOddsType: "OVERUNDER_PARTICIPANT_GOALS" }))).toBe(false);
    expect(isLineRow(row({ BookmakerId: 999 }))).toBe(false);
  });
  it("rejects rows without a 3-part Pct", () => {
    expect(isLineRow(row({ Pct: undefined }))).toBe(false);
    expect(isLineRow(row({ Pct: ["50.0", "50.0"] }))).toBe(false);
  });
});

describe("favouriteSide / pctMilliFor", () => {
  it("part1 favourite → side 1; part2 favourite → side 2", () => {
    expect(favouriteSide(row())).toBe(1);
    expect(favouriteSide(row({ Pct: ["10.0", "30.0", "60.0"] }))).toBe(2);
  });
  it("exact tie → side 1 (deterministic)", () => {
    expect(favouriteSide(row({ Pct: ["45.0", "10.0", "45.0"] }))).toBe(1);
  });
  it("pctMilliFor reads the right slot and rounds to milli-pct", () => {
    expect(pctMilliFor(row(), 1)).toBe(54407);
    expect(pctMilliFor(row(), 2)).toBe(10267);
  });
});

describe("latestLineRowAtOrBefore", () => {
  it("returns the latest eligible row at or before the cutoff, ignoring non-line rows", () => {
    const rows = [
      row({ Ts: 1000, MessageId: "a" }),
      row({ Ts: 3000, MessageId: "half", MarketPeriod: "half=1" }), // ignored
      row({ Ts: 2000, MessageId: "b" }),
      row({ Ts: 5000, MessageId: "late" }), // past cutoff
    ];
    expect(latestLineRowAtOrBefore(rows, 4000)?.MessageId).toBe("b");
  });
  it("returns null when nothing qualifies", () => {
    expect(latestLineRowAtOrBefore([row({ Ts: 9000 })], 4000)).toBeNull();
  });
});
