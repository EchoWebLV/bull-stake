import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { MARKET_TEMPLATE, toInitArgs, type MarketDef } from "../src/markets.ts";

const DUMMY_AUTH = new PublicKey("11111111111111111111111111111112");

describe("MARKET_TEMPLATE", () => {
  it("has exactly 8 entries", () => {
    expect(MARKET_TEMPLATE).toHaveLength(8);
  });

  it("all 8 marketIds are unique (0–7)", () => {
    const ids = MARKET_TEMPLATE.map((d) => d.marketId);
    const unique = new Set(ids);
    expect(unique.size).toBe(8);
    expect(ids.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("corners def (marketId 0) is statKey 7 + statKey2 8, op add, threshold 9", () => {
    const corners = MARKET_TEMPLATE.find((d) => d.marketId === 0) as MarketDef;
    expect(corners.statKey).toBe(7);
    expect(corners.statKey2).toBe(8);
    expect(corners.op).toBe("add");
    expect(corners.threshold).toBe(9);
    expect(corners.settleAt).toBe("FT");
  });

  it("1H corners def (marketId 6) has statKey 1007 / statKey2 1008 and settleAt HT", () => {
    const ht = MARKET_TEMPLATE.find((d) => d.marketId === 6) as MarketDef;
    expect(ht.statKey).toBe(1007);
    expect(ht.statKey2).toBe(1008);
    expect(ht.op).toBe("add");
    expect(ht.threshold).toBe(4);
    expect(ht.settleAt).toBe("HT");
  });
});

describe("toInitArgs", () => {
  it('maps op "add" → { add: {} }', () => {
    const def = MARKET_TEMPLATE[0]; // marketId 0, op "add"
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.op).toEqual({ add: {} });
  });

  it('maps op "subtract" → { subtract: {} }', () => {
    const def = MARKET_TEMPLATE[2]; // Home Win, op "subtract"
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.op).toEqual({ subtract: {} });
  });

  it('maps op null → null', () => {
    // Build a synthetic def with op null
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
    const def = MARKET_TEMPLATE[4]; // Away Win
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.comparison).toEqual({ lessThan: {} });
  });

  it('maps comparison "equalTo" → { equalTo: {} }', () => {
    const def = MARKET_TEMPLATE[3]; // Draw
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.comparison).toEqual({ equalTo: {} });
  });

  it("sets settleAuthority, feeRecipient: null, feeBps: 0", () => {
    const args = toInitArgs(MARKET_TEMPLATE[0], DUMMY_AUTH, 1000);
    expect(args.settleAuthority).toBe(DUMMY_AUTH);
    expect(args.feeRecipient).toBeNull();
    expect(args.feeBps).toBe(0);
  });

  it("wraps entryCloseTsSec in a BN", () => {
    const args = toInitArgs(MARKET_TEMPLATE[0], DUMMY_AUTH, 1_700_000_000);
    // BN instances have a .toNumber() method
    expect(typeof args.entryCloseTs.toNumber).toBe("function");
    expect(args.entryCloseTs.toNumber()).toBe(1_700_000_000);
  });

  it("passes through statKey and statKey2 from the def", () => {
    const def = MARKET_TEMPLATE[6]; // 1H corners
    const args = toInitArgs(def, DUMMY_AUTH, 9999999);
    expect(args.statKey).toBe(1007);
    expect(args.statKey2).toBe(1008);
  });
});
