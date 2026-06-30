/**
 * Unit tests for the pure decision helpers used by settle-contest.ts.
 *
 * No mocks, no RPC, no Anchor — these test only the pure logic that gates the
 * money path (leg order, abort-to-void, perfect_count guard). The two-wave
 * phase→eligibility logic (marketsToSettle) is covered by settle-all.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  legMarketsInOrder,
  allLegsHaveBuckets,
  classifyLegReadiness,
  perfectCountWithinEntries,
  type LegStatus,
} from "../contest.js";

// ── legMarketsInOrder ─────────────────────────────────────────────────────────

describe("legMarketsInOrder", () => {
  it("returns numLegs tuples in leg order (matches on-chain remaining_accounts[i])", () => {
    // A v2 parlay: 4 legs on ONE fixture, markets [16, 15, 12, 11].
    const fixtures = [9001, 9001, 9001, 9001, 0];
    const marketIds = [16, 15, 12, 11, 0];
    const out = legMarketsInOrder(fixtures, marketIds, 4);
    expect(out).toEqual([
      { fixtureId: 9001, marketId: 16 },
      { fixtureId: 9001, marketId: 15 },
      { fixtureId: 9001, marketId: 12 },
      { fixtureId: 9001, marketId: 11 },
    ]);
  });

  it("length always equals numLegs (ignores padded tail entries)", () => {
    const fixtures = [1, 1, 1, 0, 0];
    const marketIds = [16, 15, 12, 0, 0];
    expect(legMarketsInOrder(fixtures, marketIds, 3)).toHaveLength(3);
    expect(legMarketsInOrder(fixtures, marketIds, 3)).toEqual([
      { fixtureId: 1, marketId: 16 },
      { fixtureId: 1, marketId: 15 },
      { fixtureId: 1, marketId: 12 },
    ]);
  });

  it("preserves the exact leg ordering (does not sort)", () => {
    const fixtures = [5, 5, 5, 5, 5];
    const marketIds = [11, 12, 15, 16, 10];
    const out = legMarketsInOrder(fixtures, marketIds, 5);
    expect(out.map((t) => t.marketId)).toEqual([11, 12, 15, 16, 10]);
  });

  it("supports multi-fixture cards (each leg keeps its own fixtureId)", () => {
    const fixtures = [100, 200, 300, 0, 0];
    const marketIds = [12, 12, 12, 0, 0];
    expect(legMarketsInOrder(fixtures, marketIds, 3)).toEqual([
      { fixtureId: 100, marketId: 12 },
      { fixtureId: 200, marketId: 12 },
      { fixtureId: 300, marketId: 12 },
    ]);
  });
});

// ── allLegsHaveBuckets (abort-to-void predicate) ──────────────────────────────

describe("allLegsHaveBuckets", () => {
  it("true when every leg has a bucket (>= 0)", () => {
    expect(allLegsHaveBuckets([0, 1, 2, 0], 4)).toBe(true);
  });

  it("false when any leg uses the -1 missing sentinel", () => {
    expect(allLegsHaveBuckets([0, 1, -1, 0], 4)).toBe(false);
  });

  it("false when the FIRST leg is missing", () => {
    expect(allLegsHaveBuckets([-1, 0, 1, 2], 4)).toBe(false);
  });

  it("false when the LAST leg is missing", () => {
    expect(allLegsHaveBuckets([0, 1, 2, -1], 4)).toBe(false);
  });

  it("only inspects the first numLegs (ignores padded tail)", () => {
    // 4 legs present + bucket, padded 5th slot is the sentinel — still settleable.
    expect(allLegsHaveBuckets([0, 1, 2, 0, -1], 4)).toBe(true);
  });

  it("bucket 0 (e.g. HOME / OVER) counts as present, not falsy", () => {
    expect(allLegsHaveBuckets([0, 0, 0, 0], 4)).toBe(true);
  });

  it("treats undefined (short array) as missing", () => {
    expect(allLegsHaveBuckets([0, 1], 4)).toBe(false);
  });
});

// ── classifyLegReadiness (wait-vs-void money gate) ────────────────────────────

describe("classifyLegReadiness", () => {
  const leg = (status: LegStatus, bucket: number) => ({ status, bucket });

  it("ready: every leg has a bucket (all settled)", () => {
    const legs = [leg("settled", 0), leg("settled", 1), leg("settled", 2), leg("settled", 0)];
    expect(classifyLegReadiness(legs, 4)).toBe("ready");
  });

  it("ready: a 0 bucket counts as present (no spurious pending/abandoned)", () => {
    const legs = [leg("settled", 0), leg("settled", 0), leg("settled", 0), leg("settled", 0)];
    expect(classifyLegReadiness(legs, 4)).toBe("ready");
  });

  it("ready: a Voided leg that recorded its bucket still counts as present", () => {
    // void_market on a zero-winner market can still record the proof-determined bucket.
    const legs = [leg("settled", 1), leg("voided", 0), leg("settled", 2), leg("settled", 1)];
    expect(classifyLegReadiness(legs, 4)).toBe("ready");
  });

  it("abandoned: a single bucketless Voided leg (rest settled) → abandoned", () => {
    const legs = [leg("settled", 0), leg("settled", 1), leg("voided", -1), leg("settled", 2)];
    expect(classifyLegReadiness(legs, 4)).toBe("abandoned");
  });

  it("pending: a single bucketless Open leg (rest settled) → pending (WAIT, do not void)", () => {
    const legs = [leg("settled", 0), leg("settled", 1), leg("open", -1), leg("settled", 2)];
    expect(classifyLegReadiness(legs, 4)).toBe("pending");
  });

  it("MIXED: one bucketless Voided + one bucketless Open → pending (safety, NOT abandoned)", () => {
    const legs = [leg("voided", -1), leg("settled", 1), leg("open", -1), leg("settled", 2)];
    expect(classifyLegReadiness(legs, 4)).toBe("pending");
  });

  it("pending takes precedence even when most bucketless legs are voided", () => {
    const legs = [leg("voided", -1), leg("voided", -1), leg("open", -1), leg("settled", 0)];
    expect(classifyLegReadiness(legs, 4)).toBe("pending");
  });

  it("abandoned: ALL legs bucketless and Voided → abandoned", () => {
    const legs = [leg("voided", -1), leg("voided", -1), leg("voided", -1), leg("voided", -1)];
    expect(classifyLegReadiness(legs, 4)).toBe("abandoned");
  });

  it("ignores the padded tail beyond numLegs", () => {
    // 4 ready legs + a padded 5th that is open/bucketless — still ready.
    const legs = [leg("settled", 0), leg("settled", 1), leg("settled", 2), leg("settled", 0), leg("open", -1)];
    expect(classifyLegReadiness(legs, 4)).toBe("ready");
  });

  it("treats a short/undefined leg as pending (never void on missing data)", () => {
    const legs = [leg("settled", 0), leg("settled", 1)];
    expect(classifyLegReadiness(legs, 4)).toBe("pending");
  });
});

// ── perfectCountWithinEntries (on-chain guard mirror) ─────────────────────────

describe("perfectCountWithinEntries", () => {
  it("true when perfectCount < entryCount", () => {
    expect(perfectCountWithinEntries(2, 10)).toBe(true);
  });

  it("true at the boundary perfectCount == entryCount (everyone perfect)", () => {
    expect(perfectCountWithinEntries(10, 10)).toBe(true);
  });

  it("false when perfectCount > entryCount (would revert PerfectCountExceedsEntries)", () => {
    expect(perfectCountWithinEntries(11, 10)).toBe(false);
  });

  it("rollover case: 0 perfect on 0 entries is allowed", () => {
    expect(perfectCountWithinEntries(0, 0)).toBe(true);
  });

  it("the bricking case: 1 perfect on an EMPTY contest is rejected", () => {
    expect(perfectCountWithinEntries(1, 0)).toBe(false);
  });
});
