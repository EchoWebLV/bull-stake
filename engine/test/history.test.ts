import { describe, it, expect } from "vitest";
import {
  reconstructStatus,
  winningPayout,
  buildLegs,
  sideLabel,
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

describe("buildLegs — per-outcome breakdown", () => {
  const label = (b: number) => ["Brazil", "Draw", "Japan"][b] ?? `#${b}`;

  it("open 1X2: one leg per outcome, only backed ones carry stake, payout projects 'if it wins'", () => {
    // pool Brazil 0.30 / Draw 0.15 / Japan 0.10 (total 0.55); wallet backed Brazil+Draw
    const open: MarketSnapshot = {
      status: "open", winningBucket: null,
      bucketTotals: [300_000_000n, 150_000_000n, 100_000_000n],
      totalPool: 550_000_000n, feeCollected: 0n,
    };
    const legs = buildLegs([100_000_000n, 60_000_000n, 0n], open, 3, label);
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => l.side)).toEqual(["Brazil", "Draw", "Japan"]);
    expect(legs.map((l) => l.backed)).toEqual([true, true, false]);
    // Brazil leg: 0.10 stake, odds 0.55/0.30 = 1.833, payout 0.10 * 0.55/0.30 = 0.18333
    expect(legs[0].odds).toBeCloseTo(1.8333, 3);
    expect(legs[0].payoutLamports).toBe("183333333");
    // Japan not backed: 0 stake, 0 payout, but still shows the live price
    expect(legs[2].stakeLamports).toBe("0");
    expect(legs[2].payoutLamports).toBe("0");
    expect(legs[2].odds).toBeCloseTo(5.5, 3);
    expect(legs.every((l) => l.result === null)).toBe(true);
  });

  it("settled: winning outcome marked won with realized payout, the rest lost", () => {
    const settled: MarketSnapshot = {
      status: "settled", winningBucket: 2, // Japan won
      bucketTotals: [1_000_000_000n, 1_000_000_000n, 2_000_000_000n],
      totalPool: 4_000_000_000n, feeCollected: 0n,
    };
    // wallet had backed Brazil(1) and Japan(2)
    const legs = buildLegs([1_000_000_000n, 0n, 2_000_000_000n], settled, 3, label);
    expect(legs[0].result).toBe("lost");
    expect(legs[1].result).toBe("lost");
    expect(legs[2].result).toBe("won");
    // Japan: stake 2 of winner pool 2, whole 4 pool → 2 * 4 / 2 = 4
    expect(legs[2].payoutLamports).toBe("4000000000");
    expect(legs[0].payoutLamports).toBe("0");
  });

  it("voided: every leg refunded, backed legs return their stake", () => {
    const voided: MarketSnapshot = {
      status: "voided", winningBucket: null,
      bucketTotals: [1_000_000_000n, 500_000_000n], totalPool: 1_500_000_000n, feeCollected: 0n,
    };
    const legs = buildLegs([1_000_000_000n, 0n], voided, 2, (b) => (b === 0 ? "Over" : "Under"));
    expect(legs.map((l) => l.result)).toEqual(["refunded", "refunded"]);
    expect(legs[0].payoutLamports).toBe("1000000000"); // backed → refunded
    expect(legs[1].payoutLamports).toBe("0");           // not backed → nothing
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

describe("sideLabel — line markets", () => {
  it("labels line-market buckets Above/Below", () => {
    expect(sideLabel("line", 0, "Spain", "Austria")).toBe("Above");
    expect(sideLabel("line", 1, "Spain", "Austria")).toBe("Below");
  });
});
