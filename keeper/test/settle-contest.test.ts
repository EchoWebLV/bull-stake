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
  perfectCountWithinEntries,
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
