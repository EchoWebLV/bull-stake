import { describe, it, expect } from "vitest";
import {
  reconstructStatus,
  winningPayout,
  type MarketSnapshot,
} from "../src/history.ts";

const settledWon0: MarketSnapshot = {
  status: "settled",
  winningBucket: 0,
  bucketTotals: [2_000_000_000n, 8_000_000_000n], // OVER=2, UNDER=8, total=10
  totalPool: 10_000_000_000n,
  feeCollected: 0n,
};
const openMkt: MarketSnapshot = {
  status: "open",
  winningBucket: null,
  bucketTotals: [1_000_000_000n, 0n],
  totalPool: 1_000_000_000n,
  feeCollected: 0n,
};
const voidedMkt: MarketSnapshot = {
  status: "voided",
  winningBucket: null,
  bucketTotals: [1_000_000_000n, 500_000_000n],
  totalPool: 1_500_000_000n,
  feeCollected: 0n,
};

describe("winningPayout", () => {
  it("pays stake's share of the distributable pool (fee 0)", () => {
    // stake 1 on OVER(2), total 10 → 1 * 10 / 2 = 5
    expect(winningPayout(1_000_000_000n, settledWon0)).toBe(5_000_000_000n);
  });
  it("applies fee from the distributable pool", () => {
    const withFee: MarketSnapshot = { ...settledWon0, feeCollected: 1_000_000_000n };
    // stake 1 on OVER(2), (10-1)=9 distributable → 1 * 9 / 2 = 4.5
    expect(winningPayout(1_000_000_000n, withFee)).toBe(4_500_000_000n);
  });
  it("returns 0 for a zero stake or empty winning side", () => {
    expect(winningPayout(0n, settledWon0)).toBe(0n);
    expect(winningPayout(1n, { ...settledWon0, winningBucket: null })).toBe(0n);
  });
});

describe("reconstructStatus — already claimed (position closed)", () => {
  it("claimed with payout > 0 → won", () => {
    const r = reconstructStatus([1_000_000_000n, 0n], settledWon0, { payout: 5_000_000_000n, voided: false });
    expect(r).toEqual({ status: "won", payout: 5_000_000_000n });
  });
  it("claimed with payout 0 and not voided → lost (rent reclaimed)", () => {
    const r = reconstructStatus([0n, 1_000_000_000n], settledWon0, { payout: 0n, voided: false });
    expect(r).toEqual({ status: "lost", payout: 0n });
  });
  it("claimed voided → refunded with the refund payout", () => {
    const r = reconstructStatus([1_000_000_000n, 0n], voidedMkt, { payout: 1_000_000_000n, voided: true });
    expect(r).toEqual({ status: "refunded", payout: 1_000_000_000n });
  });
});

const threeWayAwayWon: MarketSnapshot = {
  status: "settled",
  winningBucket: 2, // away
  bucketTotals: [1_000_000_000n, 1_000_000_000n, 2_000_000_000n], // home/draw/away, total 4
  totalPool: 4_000_000_000n,
  feeCollected: 0n,
};

describe("reconstructStatus — three-way result market", () => {
  it("away backer (bucket 2) wins and can claim the whole pool", () => {
    const r = reconstructStatus([0n, 0n, 2_000_000_000n], threeWayAwayWon, null);
    // stake 2 on away (winner pool 2) of a 4 pool → 2 * 4 / 2 = 4
    expect(r).toEqual({ status: "claimable-won", payout: 4_000_000_000n });
  });
  it("home/draw backers lost", () => {
    expect(reconstructStatus([1_000_000_000n, 0n, 0n], threeWayAwayWon, null).status).toBe("lost");
    expect(reconstructStatus([0n, 1_000_000_000n, 0n], threeWayAwayWon, null).status).toBe("lost");
  });
  it("voided three-way refunds the full stake across all buckets", () => {
    const voided: MarketSnapshot = { ...threeWayAwayWon, status: "voided", winningBucket: null };
    const r = reconstructStatus([1_000_000_000n, 500_000_000n, 0n], voided, null);
    expect(r).toEqual({ status: "claimable-refund", payout: 1_500_000_000n });
  });
});

describe("reconstructStatus — unclaimed", () => {
  it("open market → pending", () => {
    const r = reconstructStatus([1_000_000_000n, 0n], openMkt, null);
    expect(r).toEqual({ status: "pending", payout: 0n });
  });
  it("settled, on winning side → claimable-won with computed payout", () => {
    const r = reconstructStatus([1_000_000_000n, 0n], settledWon0, null);
    expect(r).toEqual({ status: "claimable-won", payout: 5_000_000_000n });
  });
  it("settled, on losing side → lost, nothing to collect", () => {
    const r = reconstructStatus([0n, 1_000_000_000n], settledWon0, null);
    expect(r).toEqual({ status: "lost", payout: 0n });
  });
  it("voided → claimable-refund of the full stake (both sides)", () => {
    const r = reconstructStatus([1_000_000_000n, 500_000_000n], voidedMkt, null);
    expect(r).toEqual({ status: "claimable-refund", payout: 1_500_000_000n });
  });
});
