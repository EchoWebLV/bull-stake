import { describe, it, expect } from "vitest";
import { impliedOdds, impliedOddsN } from "../src/odds.ts";

describe("impliedOddsN (N-outcome)", () => {
  it("treats every other bucket as the losing pool", () => {
    // home/draw/away = 200/100/100, total 400, fee 0
    expect(impliedOddsN([200n, 100n, 100n], 0, 0)).toBeCloseTo(2.0, 3); // 400/200
    expect(impliedOddsN([200n, 100n, 100n], 1, 0)).toBeCloseTo(4.0, 3); // 400/100
    expect(impliedOddsN([200n, 100n, 100n], 2, 0)).toBeCloseTo(4.0, 3);
  });
  it("returns 0 for an empty bucket and matches binary impliedOdds for 2 buckets", () => {
    expect(impliedOddsN([300n, 0n, 0n], 1, 0)).toBe(0);
    expect(impliedOddsN([300n, 100n], 0, 0)).toBeCloseTo(impliedOdds([300n, 100n], 0, 0), 6);
  });
});

describe("impliedOdds", () => {
  it("returns pot/bucket payout multiplier, fee applied", () => {
    // pools: OVER=300, UNDER=100, total=400, fee 0 bps
    // over backer share of pot = 400/300 = 1.3333...
    expect(impliedOdds([300n, 100n], 0, 0)).toBeCloseTo(1.3333, 3);
    expect(impliedOdds([300n, 100n], 1, 0)).toBeCloseTo(4.0, 3);
  });

  it("takes the fee from the LOSING pool only (matches on-chain payout)", () => {
    // 1000 bps (10%): over wins → loser=UNDER(100), fee=10 → (400-10)/300 = 1.30
    expect(impliedOdds([300n, 100n], 0, 1000)).toBeCloseTo(1.3, 3);
    // under wins → loser=OVER(300), fee=30 → (400-30)/100 = 3.70
    expect(impliedOdds([300n, 100n], 1, 1000)).toBeCloseTo(3.7, 3);
  });

  it("returns 0 for an empty bucket (no liquidity on that side)", () => {
    expect(impliedOdds([0n, 100n], 0, 0)).toBe(0);
  });

  it("returns 0 when total pool is empty", () => {
    expect(impliedOdds([0n, 0n], 0, 0)).toBe(0);
  });
});
