import { describe, it, expect } from "vitest";
import { impliedOdds } from "../src/odds.ts";

describe("impliedOdds", () => {
  it("returns pot/bucket payout multiplier, fee applied", () => {
    // pools: OVER=300, UNDER=100, total=400, fee 0 bps
    // over backer share of pot = 400/300 = 1.3333...
    expect(impliedOdds([300n, 100n], 0, 0)).toBeCloseTo(1.3333, 3);
    expect(impliedOdds([300n, 100n], 1, 0)).toBeCloseTo(4.0, 3);
  });

  it("applies fee to the pot for the implied multiplier", () => {
    // fee 1000 bps (10%): pot*(0.9)=360, over: 360/300=1.2
    expect(impliedOdds([300n, 100n], 0, 1000)).toBeCloseTo(1.2, 3);
  });

  it("returns 0 for an empty bucket (no liquidity on that side)", () => {
    expect(impliedOdds([0n, 100n], 0, 0)).toBe(0);
  });

  it("returns 0 when total pool is empty", () => {
    expect(impliedOdds([0n, 0n], 0, 0)).toBe(0);
  });
});
