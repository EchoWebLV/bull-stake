// web/test/pearlyStrip.test.ts
import { describe, it, expect } from "vitest";
import { stripForFixture } from "../src/lib/pearlyStrip.ts";
import type { Card } from "../src/lib/api.ts";

const NOW = 1_800_000_000;
const baseLeg = {
  fixtureId: 500, home: "Brazil", away: "Spain", kickoffTs: null,
  marketId: 12, label: "Match Result", group: "result", buckets: 3, lockTs: NOW - 10,
};
const card = (over: Partial<Card> = {}): Card => ({
  contestId: 9, status: "open", lockTs: NOW - 10, settleAfterTs: NOW + 9999,
  entryPrice: "50000000", pot: "0", jackpot: "0",
  legs: [baseLeg, { ...baseLeg, marketId: 11, label: "Total Goals O/U 2.5", group: "goals", line: 2.5, buckets: 2 }],
  myCard: { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 100, activeMask: [true, true, true, true, true, true], weight: 64, alive: true },
  ...over,
});

describe("stripForFixture", () => {
  it("null when the wallet has no live card", () => {
    expect(stripForFixture(card({ myCard: null }), 500, 0)).toBeNull();
  });
  it("null when the card is dead (spectating — no ride copy)", () => {
    const c = card();
    c.myCard!.alive = false;
    expect(stripForFixture(c, 500, 0)).toBeNull();
  });
  it("null when no carried leg is on this fixture", () => {
    expect(stripForFixture(card(), 999, 0)).toBeNull();
  });
  it("names the pick for a result leg on this fixture", () => {
    const s = stripForFixture(card(), 500, 0);
    expect(s).not.toBeNull();
    expect(s!.text).toContain("your card rides this match");
    expect(s!.text).toContain("Brazil");
  });
  it("O/U leg with Over pick one goal short says 'needs one more goal'", () => {
    // picks[1] = 0 = Over on the 2.5 line; 2 goals so far → needs one more.
    const s = stripForFixture(card(), 500, 2);
    expect(s!.text).toContain("needs one more goal");
  });
  it("O/U Over already cleared says nothing extra (no stale 'needs')", () => {
    const s = stripForFixture(card(), 500, 3);
    expect(s!.text).not.toContain("needs");
  });
});
