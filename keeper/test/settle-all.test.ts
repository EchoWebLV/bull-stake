/**
 * Unit tests for the pure helper functions in settle-all.ts.
 *
 * No mocks, no RPC, no Anchor — these test only the pure phase→eligibility logic.
 */

import { describe, it, expect } from "vitest";
import { marketAction, marketsToSettle } from "../settle-all.js";
import { PHASE } from "../../spike/src/config.js";
import { MARKET_TEMPLATE } from "../../engine/src/markets.js";

// ── marketAction unit tests ────────────────────────────────────────────────────

describe("marketAction", () => {
  describe("HT market (settleAt: 'HT')", () => {
    it("phase HT → settle", () => {
      expect(marketAction(PHASE.HT, "HT")).toBe("settle");
    });

    it("phase H2 (in play after HT) → settle (h1 is still final)", () => {
      expect(marketAction(PHASE.H2, "HT")).toBe("settle");
    });

    it("phase F (full-time finished) → settle (h1 is final)", () => {
      expect(marketAction(PHASE.F, "HT")).toBe("settle");
    });

    it("phase FET (finished after extra time) → settle", () => {
      expect(marketAction(PHASE.FET, "HT")).toBe("settle");
    });

    it("phase FPE (finished after pens) → settle", () => {
      expect(marketAction(PHASE.FPE, "HT")).toBe("settle");
    });

    it("phase H1 (in play, 1H not done) → skip", () => {
      expect(marketAction(PHASE.H1, "HT")).toBe("skip");
    });

    it("phase NS (not started) → skip", () => {
      expect(marketAction(PHASE.NS, "HT")).toBe("skip");
    });

    it("phase A (abandoned) → void", () => {
      expect(marketAction(PHASE.A, "HT")).toBe("void");
    });

    it("phase C (cancelled) → void", () => {
      expect(marketAction(PHASE.C, "HT")).toBe("void");
    });

    it("phase P (postponed) → void", () => {
      expect(marketAction(PHASE.P, "HT")).toBe("void");
    });

    it("phase I (interrupted) → void", () => {
      expect(marketAction(PHASE.I, "HT")).toBe("void");
    });

    it("phase TXCC → void", () => {
      expect(marketAction(PHASE.TXCC, "HT")).toBe("void");
    });

    it("phase TXCS → void", () => {
      expect(marketAction(PHASE.TXCS, "HT")).toBe("void");
    });
  });

  describe("FT market (settleAt: 'FT')", () => {
    it("phase F → settle", () => {
      expect(marketAction(PHASE.F, "FT")).toBe("settle");
    });

    it("phase FET → settle", () => {
      expect(marketAction(PHASE.FET, "FT")).toBe("settle");
    });

    it("phase FPE → settle", () => {
      expect(marketAction(PHASE.FPE, "FT")).toBe("settle");
    });

    it("phase HT → skip (1H final but match not over)", () => {
      expect(marketAction(PHASE.HT, "FT")).toBe("skip");
    });

    it("phase H2 → skip (in play)", () => {
      expect(marketAction(PHASE.H2, "FT")).toBe("skip");
    });

    it("phase H1 → skip", () => {
      expect(marketAction(PHASE.H1, "FT")).toBe("skip");
    });

    it("phase NS → skip", () => {
      expect(marketAction(PHASE.NS, "FT")).toBe("skip");
    });

    it("phase A → void", () => {
      expect(marketAction(PHASE.A, "FT")).toBe("void");
    });

    it("phase C → void", () => {
      expect(marketAction(PHASE.C, "FT")).toBe("void");
    });
  });
});

// ── marketsToSettle unit tests (uses MARKET_TEMPLATE) ─────────────────────────

describe("marketsToSettle", () => {
  it("phase HT: only HT markets are eligible (settle), not FT markets", () => {
    const result = marketsToSettle(PHASE.HT, MARKET_TEMPLATE);
    const htMarketIds = MARKET_TEMPLATE.filter((d) => d.settleAt === "HT").map((d) => d.marketId);
    const ftMarketIds = MARKET_TEMPLATE.filter((d) => d.settleAt === "FT").map((d) => d.marketId);
    const resultIds = result.map((r) => r.marketId);

    // All HT markets should appear
    for (const id of htMarketIds) {
      expect(resultIds).toContain(id);
    }
    // No FT markets should appear at HT phase
    for (const id of ftMarketIds) {
      expect(resultIds).not.toContain(id);
    }
    // All returned actions should be "settle"
    expect(result.every((r) => r.action === "settle")).toBe(true);
  });

  it("phase H2 (after HT): HT markets settle; FT markets still skip", () => {
    const result = marketsToSettle(PHASE.H2, MARKET_TEMPLATE);
    const htMarketIds = MARKET_TEMPLATE.filter((d) => d.settleAt === "HT").map((d) => d.marketId);
    const ftMarketIds = MARKET_TEMPLATE.filter((d) => d.settleAt === "FT").map((d) => d.marketId);
    const resultIds = result.map((r) => r.marketId);

    for (const id of htMarketIds) {
      expect(resultIds).toContain(id);
    }
    for (const id of ftMarketIds) {
      expect(resultIds).not.toContain(id);
    }
  });

  it("phase F (full-time): all 8 markets are eligible (HT + FT both settle)", () => {
    const result = marketsToSettle(PHASE.F, MARKET_TEMPLATE);
    expect(result).toHaveLength(8);
    const allMarketIds = MARKET_TEMPLATE.map((d) => d.marketId).sort((a, b) => a - b);
    const resultIds = result.map((r) => r.marketId).sort((a, b) => a - b);
    expect(resultIds).toEqual(allMarketIds);
    expect(result.every((r) => r.action === "settle")).toBe(true);
  });

  it("phase FET (finished after extra time): all 8 eligible", () => {
    const result = marketsToSettle(PHASE.FET, MARKET_TEMPLATE);
    expect(result).toHaveLength(8);
  });

  it("phase FPE (finished after penalties): all 8 eligible", () => {
    const result = marketsToSettle(PHASE.FPE, MARKET_TEMPLATE);
    expect(result).toHaveLength(8);
  });

  it("void phase (A): all 8 markets returned as void", () => {
    const result = marketsToSettle(PHASE.A, MARKET_TEMPLATE);
    expect(result).toHaveLength(8);
    expect(result.every((r) => r.action === "void")).toBe(true);
  });

  it("void phase (C): all 8 markets returned as void", () => {
    const result = marketsToSettle(PHASE.C, MARKET_TEMPLATE);
    expect(result).toHaveLength(8);
    expect(result.every((r) => r.action === "void")).toBe(true);
  });

  it("void phase (P): all 8 markets returned as void", () => {
    const result = marketsToSettle(PHASE.P, MARKET_TEMPLATE);
    expect(result).toHaveLength(8);
    expect(result.every((r) => r.action === "void")).toBe(true);
  });

  it("in-play phase H1: no markets are eligible", () => {
    const result = marketsToSettle(PHASE.H1, MARKET_TEMPLATE);
    expect(result).toHaveLength(0);
  });

  it("phase NS (not started): no markets eligible", () => {
    const result = marketsToSettle(PHASE.NS, MARKET_TEMPLATE);
    expect(result).toHaveLength(0);
  });

  it("works with a single-item template", () => {
    const htTemplate = [{ marketId: 6, settleAt: "HT" as const }];
    expect(marketsToSettle(PHASE.HT, htTemplate)).toEqual([{ marketId: 6, action: "settle" }]);
    expect(marketsToSettle(PHASE.H1, htTemplate)).toHaveLength(0);
    expect(marketsToSettle(PHASE.A, htTemplate)).toEqual([{ marketId: 6, action: "void" }]);
  });

  it("template ordering is preserved in output", () => {
    const result = marketsToSettle(PHASE.F, MARKET_TEMPLATE);
    const resultIds = result.map((r) => r.marketId);
    const templateIds = MARKET_TEMPLATE.map((d) => d.marketId);
    expect(resultIds).toEqual(templateIds);
  });
});
