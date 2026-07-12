import { describe, it, expect } from "vitest";
import { marketStatusKey } from "../settle.js";

/* settleMarketByPubkey's documented contract is "idempotent — skips already
 * settled/voided", but nothing implemented the status check: re-running a
 * partially-settled contest re-sent settle on a voided-with-bucket leg and the
 * program rejected MarketNotOpen (6003), wedging the whole contest pass (hit
 * live 2026-07-12 on contests 777020638/639/640). The status→key decision is
 * the pure seam; the early-return in settleMarketByPubkey consumes it. */
describe("marketStatusKey", () => {
  it("maps anchor enum objects to their key", () => {
    expect(marketStatusKey({ open: {} })).toBe("open");
    expect(marketStatusKey({ settled: {} })).toBe("settled");
    expect(marketStatusKey({ voided: {} })).toBe("voided");
  });

  it("treats missing/unknown status as open (proceed — never silently skip real work)", () => {
    expect(marketStatusKey(undefined)).toBe("open");
    expect(marketStatusKey(null)).toBe("open");
    expect(marketStatusKey("garbage")).toBe("open");
    expect(marketStatusKey({})).toBe("open");
  });
});
