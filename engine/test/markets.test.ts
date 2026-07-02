import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { MARKET_TEMPLATE, marketById, toInitArgs, type MarketDef } from "../src/markets.ts";
import {
  LINE_CLOSE_MARKET_ID, LINE_CLOSE_DEF, lineInitArgs, MARKET_TEMPLATE as TPL,
} from "../src/markets.ts";

const DUMMY_AUTH = new PublicKey("11111111111111111111111111111112");

describe("MARKET_TEMPLATE", () => {
  it("has exactly 7 entries", () => {
    expect(MARKET_TEMPLATE).toHaveLength(7);
  });

  it("all 7 marketIds are unique (10–16)", () => {
    const ids = MARKET_TEMPLATE.map((d) => d.marketId);
    const unique = new Set(ids);
    expect(unique.size).toBe(7);
    expect(ids.sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16]);
  });

  it("corners def (marketId 10) is statKey 7 + statKey2 8, op add, threshold 9, binary", () => {
    const corners = MARKET_TEMPLATE.find((d) => d.marketId === 10) as MarketDef;
    expect(corners.statKey).toBe(7);
    expect(corners.statKey2).toBe(8);
    expect(corners.op).toBe("add");
    expect(corners.threshold).toBe(9);
    expect(corners.settleAt).toBe("FT");
    expect(corners.numBuckets).toBe(2);
  });

  it("the result def (marketId 12) is a three-way goal-diff market", () => {
    const result = MARKET_TEMPLATE.find((d) => d.marketId === 12) as MarketDef;
    expect(result.group).toBe("result");
    expect(result.label).toBe("Match Result");
    expect(result.numBuckets).toBe(3);
    expect(result.statKey).toBe(1);
    expect(result.statKey2).toBe(2);
    expect(result.op).toBe("subtract"); // home − away goals
    expect(result.settleAt).toBe("FT");
  });

  it("three-way markets are {12, 16} (both group:result, numBuckets 3); the rest are binary", () => {
    const threeWay = MARKET_TEMPLATE.filter((d) => d.numBuckets === 3).map((d) => d.marketId).sort((a, b) => a - b);
    expect(threeWay).toEqual([12, 16]);
    for (const def of MARKET_TEMPLATE) {
      expect(def.numBuckets).toBe(def.group === "result" ? 3 : 2);
    }
  });

  it("1H corners def (marketId 14) has statKey 1007 / statKey2 1008 and settleAt HT", () => {
    const ht = MARKET_TEMPLATE.find((d) => d.marketId === 14) as MarketDef;
    expect(ht.statKey).toBe(1007);
    expect(ht.statKey2).toBe(1008);
    expect(ht.op).toBe("add");
    expect(ht.threshold).toBe(4);
    expect(ht.settleAt).toBe("HT");
  });

  it("defines marketId 16 — 1st-Half Result, 3-way, settles at HT", () => {
    const m = MARKET_TEMPLATE.find((d) => d.marketId === 16)!;
    expect(m).toBeDefined();
    expect(m.group).toBe("result");
    expect(m.numBuckets).toBe(3);
    expect(m.settleAt).toBe("HT");
    expect(m.statKey).toBe(1001);     // 1st-half home goals
    expect(m.statKey2).toBe(1002);    // 1st-half away goals
    expect(m.op).toBe("subtract");    // home - away → sign maps to bucket
  });

  it("marketById resolves label/group for the 4 parlay legs", () => {
    expect([16, 15, 12, 11].map((id) => marketById(id)?.numBuckets)).toEqual([3, 2, 3, 2]);
  });
});

describe("toInitArgs", () => {
  it('maps op "add" → { add: {} }', () => {
    const def = MARKET_TEMPLATE[0]; // marketId 0, op "add"
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.op).toEqual({ add: {} });
  });

  it('maps op "subtract" → { subtract: {} }', () => {
    const def = MARKET_TEMPLATE[2]; // Match Result, op "subtract"
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.op).toEqual({ subtract: {} });
  });

  it('maps op null → null', () => {
    const def: MarketDef = { ...MARKET_TEMPLATE[0], op: null, comparison: "greaterThan" };
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.op).toBeNull();
  });

  it('maps comparison "greaterThan" → { greaterThan: {} }', () => {
    const def = MARKET_TEMPLATE[0];
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.comparison).toEqual({ greaterThan: {} });
  });

  it('maps comparison "lessThan" → { lessThan: {} }', () => {
    const def: MarketDef = { ...MARKET_TEMPLATE[0], comparison: "lessThan" };
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.comparison).toEqual({ lessThan: {} });
  });

  it('maps comparison "equalTo" → { equalTo: {} }', () => {
    const def: MarketDef = { ...MARKET_TEMPLATE[0], comparison: "equalTo" };
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.comparison).toEqual({ equalTo: {} });
  });

  it("sets settleAuthority, feeRecipient: null, feeBps: 0", () => {
    const args = toInitArgs(MARKET_TEMPLATE[0], DUMMY_AUTH, 1000);
    expect(args.settleAuthority).toBe(DUMMY_AUTH);
    expect(args.feeRecipient).toBeNull();
    expect(args.feeBps).toBe(0);
  });

  it("passes num_buckets through (2 for binary, 3 for result)", () => {
    expect(toInitArgs(MARKET_TEMPLATE[0], DUMMY_AUTH, 1000).numBuckets).toBe(2);
    expect(toInitArgs(MARKET_TEMPLATE[2], DUMMY_AUTH, 1000).numBuckets).toBe(3);
  });

  it("wraps entryCloseTsSec in a BN", () => {
    const args = toInitArgs(MARKET_TEMPLATE[0], DUMMY_AUTH, 1_700_000_000);
    expect(typeof args.entryCloseTs.toNumber).toBe("function");
    expect(args.entryCloseTs.toNumber()).toBe(1_700_000_000);
  });

  it("passes through statKey and statKey2 from the def", () => {
    const def = MARKET_TEMPLATE[4]; // 1H corners
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.statKey).toBe(1007);
    expect(args.statKey2).toBe(1008);
  });
});

describe("LINE_CLOSE (market 90)", () => {
  it("is registered for lookups but NOT in the per-fixture template", () => {
    expect(LINE_CLOSE_MARKET_ID).toBe(90);
    expect(marketById(90)).toBe(LINE_CLOSE_DEF);
    expect(marketById(90)?.group).toBe("line");
    expect(marketById(90)?.numBuckets).toBe(2);
    expect(TPL.some((d) => d.marketId === 90)).toBe(false);
  });

  it("lineInitArgs encodes open line + favourite side into the existing init args", () => {
    const args = lineInitArgs(54407, 1, DUMMY_AUTH, 1_752_000_000);
    expect(args.statKey).toBe(1);          // favourite side (1 = home)
    expect(args.statKey2).toBeNull();
    expect(args.op).toBeNull();
    expect(args.comparison).toEqual({ greaterThan: {} }); // sentinel, unused
    expect(args.threshold).toBe(54407);    // opening line, milli-pct
    expect(args.entryCloseTs.toNumber()).toBe(1_752_000_000);
    expect(args.feeBps).toBe(0);
    expect(args.numBuckets).toBe(2);
    expect(args.settleAuthority).toBe(DUMMY_AUTH);
    expect(args.feeRecipient).toBeNull();
  });
});
