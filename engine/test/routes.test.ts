import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server.ts";

vi.mock("../src/chain.ts", async (orig) => {
  const real = await orig<typeof import("../src/chain.ts")>();
  return {
    ...real,
    readMarket: vi.fn(async () => ({
      pubkey: "Mkt111", status: "open", fixtureId: 1, marketId: 1,
      bucketTotals: ["300", "100"], totalPool: "400", feeBps: 0, feeCollected: "0",
      winningBucket: null, entryCloseTs: 9999999999, settledValue: null,
    })),
  };
});

describe("engine routes", () => {
  it("GET /health", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/health" });
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /api/match returns a match state", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/api/match" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("totalCorners");
    expect(body).toHaveProperty("phase");
    await app.close();
  });

  it("GET /api/market returns market view + implied odds", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/api/market" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bucketTotals).toEqual(["300", "100"]);
    expect(body.impliedOdds.over).toBeCloseTo(1.3333, 3);
    expect(body.impliedOdds.under).toBeCloseTo(4.0, 3);
    await app.close();
  });
});
