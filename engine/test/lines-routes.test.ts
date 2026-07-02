import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer } from "../src/server.ts";
import { LinesStore } from "../src/lines.ts";

vi.mock("../src/chain.ts", async (orig) => {
  const real = await orig<typeof import("../src/chain.ts")>();
  return {
    ...real,
    readLineMarkets: vi.fn(async () => [
      {
        pubkey: "Line111", fixtureId: 7, status: "open", favSide: 1,
        openMilli: 60000, entryCloseTs: 9_999_999_999,
        bucketTotals: ["50000000", "50000000"], totalPool: "100000000",
        winningBucket: null, settledValueMilli: 0, settledTs: 0,
      },
      {
        pubkey: "Line222", fixtureId: 8, status: "settled", favSide: 2,
        openMilli: 54000, entryCloseTs: 1_700_000_000,
        bucketTotals: ["80000000", "60000000"], totalPool: "140000000",
        winningBucket: 0, settledValueMilli: 55100, settledTs: 1_700_000_100,
      },
    ]),
    readLinePosition: vi.fn(async (_f: number, w: string) =>
      w === "Me111" ? (["10000000", "0"] as [string, string]) : null),
  };
});

afterEach(() => vi.restoreAllMocks());

function fakeLines(): LinesStore {
  const store = new LinesStore({
    fetchUpdates: async () => [], fetchSnapshot: async () => [],
  });
  store.setNames([{ fixtureId: 7, home: "Spain", away: "Austria" }]);
  // Pre-seed a series through the test-only injection path used across suites:
  // track() with empty updates, then hand-push via poll is overkill — assert
  // series-less behavior (current: null) for fixture 7 and shape otherwise.
  return store;
}

describe("GET /api/lines", () => {
  it("serves chain money + store odds, honest nulls when odds absent", async () => {
    const app = buildServer(undefined, fakeLines());
    const res = await app.inject({ url: "/api/lines" });
    const body = res.json();
    expect(body.lines).toHaveLength(2);
    const open = body.lines.find((l: { fixtureId: number }) => l.fixtureId === 7);
    expect(open).toMatchObject({
      marketPk: "Line111", status: "open", favSide: 1, favName: "Spain",
      home: "Spain", away: "Austria", openMilli: 60000,
      kickoffMs: 9_999_999_999_000, potLamports: "100000000",
      bucketTotals: ["50000000", "50000000"], current: null,
      winningBucket: null,
    });
    expect(typeof open.houseBoostLamports).toBe("number");
    const settled = body.lines.find((l: { fixtureId: number }) => l.fixtureId === 8);
    expect(settled).toMatchObject({
      status: "settled", winningBucket: 0, settledValueMilli: 55100,
      home: "Fixture #8", away: "", favName: "Fixture #8",
    });
    await app.close();
  });
});

describe("GET /api/lines/:fixtureId", () => {
  it("returns the line + series + caller's stakes", async () => {
    const app = buildServer(undefined, fakeLines());
    const res = await app.inject({ url: "/api/lines/7?wallet=Me111" });
    const body = res.json();
    expect(body.line.fixtureId).toBe(7);
    expect(body.series).toEqual([]);
    expect(body.myStakes).toEqual(["10000000", "0"]);
    await app.close();
  });
  it("404s an unknown fixture", async () => {
    const app = buildServer(undefined, fakeLines());
    const res = await app.inject({ url: "/api/lines/999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
