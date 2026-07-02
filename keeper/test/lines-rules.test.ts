// keeper/test/lines-rules.test.ts
import { describe, it, expect } from "vitest";
import { pickOpen, resolveLine } from "../lines-rules.js";
import type { OddsRow } from "../../spike/src/odds.js";

const MIN = 60_000;
function row(ts: number, p1: string, p2: string, over: Partial<OddsRow> = {}): OddsRow {
  return {
    FixtureId: 1, MessageId: `m${ts}`, Ts: ts,
    Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT", GameState: null, InRunning: false,
    MarketParameters: null, MarketPeriod: null,
    PriceNames: ["part1", "draw", "part2"], Prices: [1800, 2900, 9000],
    Pct: [p1, "20.0", p2], ...over,
  };
}

describe("pickOpen", () => {
  it("uses the latest fresh line row: open milli-pct + favourite side", () => {
    const now = 100 * MIN;
    const rows = [row(now - 5 * MIN, "60.0", "20.0"), row(now - 90 * MIN, "70.0", "10.0")];
    expect(pickOpen(rows, now, 60)).toEqual({ openMilli: 60000, favSide: 1, rowTs: now - 5 * MIN });
  });
  it("away favourite → favSide 2 and open reads part2", () => {
    const now = 100 * MIN;
    expect(pickOpen([row(now - MIN, "20.0", "61.5")], now, 60))
      .toEqual({ openMilli: 61500, favSide: 2, rowTs: now - MIN });
  });
  it("no row fresh enough → null (skip this pass)", () => {
    const now = 100 * MIN;
    expect(pickOpen([row(now - 61 * MIN, "60.0", "20.0")], now, 60)).toBeNull();
    expect(pickOpen([], now, 60)).toBeNull();
  });
  it("ignores in-running and half-period rows", () => {
    const now = 100 * MIN;
    const rows = [
      row(now - MIN, "80.0", "5.0", { InRunning: true }),
      row(now - MIN, "80.0", "5.0", { MarketPeriod: "half=1" }),
    ];
    expect(pickOpen(rows, now, 60)).toBeNull();
  });
});

describe("resolveLine", () => {
  const ko = 1000 * MIN;
  const base = { kickoffMs: ko, openMilli: 60000, favSide: 1 as const, staleMaxMin: 30 };

  it("close above open → Above (bucket 0) wins", () => {
    const rows = [row(ko - 2 * MIN, "62.1", "18.0")];
    expect(resolveLine(rows, base)).toEqual({
      action: "settle", winningBucket: 0, closeMilli: 62100, closeTsMs: ko - 2 * MIN,
    });
  });
  it("close below open → Below (bucket 1) wins, and post-KO rows are ignored", () => {
    const rows = [row(ko - 3 * MIN, "58.9", "21.0"), row(ko + MIN, "99.0", "0.5")];
    expect(resolveLine(rows, base)).toEqual({
      action: "settle", winningBucket: 1, closeMilli: 58900, closeTsMs: ko - 3 * MIN,
    });
  });
  it("close reads the FAVOURITE side fixed at creation (favSide 2)", () => {
    const rows = [row(ko - MIN, "30.0", "55.5")];
    expect(resolveLine(rows, { ...base, favSide: 2, openMilli: 54000 })).toEqual({
      action: "settle", winningBucket: 0, closeMilli: 55500, closeTsMs: ko - MIN,
    });
  });
  it("exact tie → void", () => {
    const rows = [row(ko - MIN, "60.0", "20.0")];
    expect(resolveLine(rows, base)).toEqual({ action: "void", reason: "tie" });
  });
  it("stale (last row older than staleMaxMin before KO) → void", () => {
    const rows = [row(ko - 31 * MIN, "62.0", "18.0")];
    expect(resolveLine(rows, base)).toEqual({ action: "void", reason: "stale" });
  });
  it("no eligible rows at all → void", () => {
    expect(resolveLine([], base)).toEqual({ action: "void", reason: "no-rows" });
  });
});
