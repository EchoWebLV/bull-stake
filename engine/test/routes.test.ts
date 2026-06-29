import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer } from "../src/server.ts";
import { readJackpotVault, readActiveContest } from "../src/chain.ts";
import type { LiveStore } from "../src/live.ts";

vi.mock("../src/chain.ts", async (orig) => {
  const real = await orig<typeof import("../src/chain.ts")>();
  return {
    ...real,
    readMarket: vi.fn(async () => ({
      pubkey: "Mkt111", status: "open", fixtureId: 1, marketId: 1,
      bucketTotals: ["300", "100"], totalPool: "400", feeBps: 0, feeCollected: "0",
      winningBucket: null, entryCloseTs: 9999999999, settledValue: 0,
    })),
    readActiveContest: vi.fn(async () => ({
      pubkey: "Contest111", contestId: 20269,
      settleAuthority: "Keep1111111111111111111111111111111111111111",
      feeRecipient: "Fee11111111111111111111111111111111111111111",
      fixtures: [101, 102, 103], numMatches: 3, entryPrice: "20000000",
      lockTs: 9999999999, settleAfterTs: 9999999999, feeBps: 500, status: "open",
      winningBuckets: [0, 0, 0], entryCount: 4, perfectCount: 0,
      potSnapshot: "0", distributable: "0", claimedCount: 0, claimedTotal: "0", settledTs: 0,
    })),
    readJackpotVault: vi.fn(async () => ({
      activeContestId: 20269, reserved: "0",
      lamports: "82000000", rentFloor: "2000000", pot: "80000000",
    })),
    listEntriesForWallet: vi.fn(async () => [
      { pubkey: "Entry111", nonce: 0, picks: [0, 1, 2, 0, 0], amount: "20000000" },
    ]),
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

  it("GET /api/market returns 503 when M0_MARKET_PUBKEY is unset", async () => {
    // M0.marketPubkey is read at config.ts module-load; clear the env and
    // re-import a fresh server so config re-evaluates with no pubkey.
    vi.stubEnv("M0_MARKET_PUBKEY", "");
    vi.resetModules();
    const { buildServer: freshBuildServer } = await import("../src/server.ts");
    const app = freshBuildServer();
    const res = await app.inject({ url: "/api/market" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });
});

// ── LiveStore mock helpers ────────────────────────────────────────────────────

function makeMockStore(overrides: Partial<LiveStore> = {}): LiveStore {
  return {
    setSlate: vi.fn(),
    getMatches: vi.fn(() => []),
    getMarkets: vi.fn(() => []),
    getFixtureMeta: vi.fn(() => new Map()),
    start: vi.fn(),
    stop: vi.fn(),
    _poll: vi.fn(),
    ...overrides,
  } as unknown as LiveStore;
}

// ── /api/matches tests ────────────────────────────────────────────────────────

describe("GET /api/matches", () => {
  it("returns an empty array when no fixtures are loaded", async () => {
    const store = makeMockStore({ getMatches: vi.fn(() => []) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/matches" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("returns matches in live → upcoming → ft order", async () => {
    // The store is responsible for sorting; the route proxies it.
    // Return already-sorted data from the mock (live→upcoming→ft).
    const matches = [
      {
        fixtureId: 2, home: "X", away: "Y", kickoffMs: Date.now() - 3600_000,
        status: "live" as const, minute: 35, phase: "H1", scoreH: 0, scoreA: 0,
        corners: 4, goals: 0, yellows: 1,
      },
      {
        fixtureId: 1, home: "A", away: "B", kickoffMs: Date.now() + 3600_000,
        status: "upcoming" as const, minute: null, phase: null, scoreH: 0, scoreA: 0,
        corners: 0, goals: 0, yellows: 0,
      },
      {
        fixtureId: 3, home: "C", away: "D", kickoffMs: Date.now() - 7200_000,
        status: "ft" as const, minute: 90, phase: "F", scoreH: 1, scoreA: 0,
        corners: 10, goals: 1, yellows: 2,
      },
    ];
    const store = makeMockStore({ getMatches: vi.fn(() => matches) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/matches" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The store.getMatches() returns pre-sorted data; route just proxies it
    expect(body).toHaveLength(3);
    expect(body[0].fixtureId).toBe(2); // live first
    expect(body[1].fixtureId).toBe(1); // upcoming second
    expect(body[2].fixtureId).toBe(3); // ft last
    await app.close();
  });

  it("each match row has the expected shape", async () => {
    const match = {
      fixtureId: 42, home: "Brazil", away: "Spain", kickoffMs: Date.now() - 1000,
      status: "live" as const, minute: 5, phase: "H1", scoreH: 1, scoreA: 0,
      corners: 2, goals: 1, yellows: 0,
    };
    const store = makeMockStore({ getMatches: vi.fn(() => [match]) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/matches" });
    const body = res.json() as typeof match[];
    const row = body[0];
    expect(row).toHaveProperty("fixtureId", 42);
    expect(row).toHaveProperty("home", "Brazil");
    expect(row).toHaveProperty("away", "Spain");
    expect(row).toHaveProperty("kickoffMs");
    expect(row).toHaveProperty("status", "live");
    expect(row).toHaveProperty("minute", 5);
    expect(row).toHaveProperty("phase", "H1");
    expect(row).toHaveProperty("scoreH", 1);
    expect(row).toHaveProperty("scoreA", 0);
    expect(row).toHaveProperty("corners", 2);
    expect(row).toHaveProperty("goals", 1);
    expect(row).toHaveProperty("yellows", 0);
    await app.close();
  });
});

// ── /api/markets tests ────────────────────────────────────────────────────────

describe("GET /api/markets", () => {
  it("returns 400 when fixtureId is missing", async () => {
    const store = makeMockStore();
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/markets" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns empty array for unknown fixtureId", async () => {
    const store = makeMockStore({ getMarkets: vi.fn(() => []) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/markets?fixtureId=9999" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("returns binary market rows with the expected shape including odds", async () => {
    const marketRow = {
      marketId: 0,
      label: "Total Corners O/U 9.5",
      group: "corners" as const,
      line: 9.5,
      settleAt: "FT" as const,
      numBuckets: 2,
      status: "open" as const,
      bucketTotals: ["300", "100"],
      totalPool: "400",
      odds: [1.3333, 4.0],
      winningBucket: null,
    };
    const store = makeMockStore({ getMarkets: vi.fn(() => [marketRow]) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/markets?fixtureId=42" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as typeof marketRow[];
    expect(body).toHaveLength(1);
    const m = body[0];
    expect(m).toHaveProperty("marketId", 0);
    expect(m).toHaveProperty("label", "Total Corners O/U 9.5");
    expect(m).toHaveProperty("group", "corners");
    expect(m).toHaveProperty("numBuckets", 2);
    expect(m).toHaveProperty("status", "open");
    expect(m).toHaveProperty("bucketTotals");
    expect(m).toHaveProperty("totalPool", "400");
    expect(m.odds[0]).toBeCloseTo(1.3333, 3);
    expect(m.odds[1]).toBeCloseTo(4.0, 3);
    expect(m).toHaveProperty("winningBucket", null);
    await app.close();
  });

  it("returns a three-way result market with three odds", async () => {
    const resultRow = {
      marketId: 2,
      label: "Match Result",
      group: "result" as const,
      line: 0,
      settleAt: "FT" as const,
      numBuckets: 3,
      status: "open" as const,
      bucketTotals: ["200", "100", "100"],
      totalPool: "400",
      odds: [2.0, 4.0, 4.0],
      winningBucket: null,
    };
    const store = makeMockStore({ getMarkets: vi.fn(() => [resultRow]) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/markets?fixtureId=42" });
    const body = res.json() as typeof resultRow[];
    expect(body[0].numBuckets).toBe(3);
    expect(body[0].bucketTotals).toHaveLength(3);
    expect(body[0].odds).toHaveLength(3);
    await app.close();
  });

  it("returns status:'none' for a market that hasn't been created yet", async () => {
    const noneMarket = {
      marketId: 1,
      label: "Total Goals O/U 2.5",
      group: "goals" as const,
      line: 2.5,
      settleAt: "FT" as const,
      numBuckets: 2,
      status: "none" as const,
      bucketTotals: ["0", "0"],
      totalPool: "0",
      odds: [0, 0],
      winningBucket: null,
    };
    const store = makeMockStore({ getMarkets: vi.fn(() => [noneMarket]) });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/markets?fixtureId=1" });
    const body = res.json() as typeof noneMarket[];
    expect(body[0].status).toBe("none");
    expect(body[0].odds[0]).toBe(0);
    await app.close();
  });
});

// ── live.ts unit tests (classifyStatus + sortMatches) ─────────────────────────

describe("classifyStatus", () => {
  const NOW = 1_750_000_000_000;

  it("returns 'upcoming' when kickoff is in the future", async () => {
    const { classifyStatus } = await import("../src/live.ts");
    expect(classifyStatus(NOW + 3600_000, null, NOW)).toBe("upcoming");
  });

  it("returns 'ft' when phase is in FINISHED_PHASES (5 = F)", async () => {
    const { classifyStatus } = await import("../src/live.ts");
    expect(classifyStatus(NOW - 9000_000, 5, NOW)).toBe("ft");
  });

  it("returns 'live' when kickoff has passed and phase is not finished", async () => {
    const { classifyStatus } = await import("../src/live.ts");
    expect(classifyStatus(NOW - 3600_000, 2, NOW)).toBe("live"); // phase 2 = H1
  });

  it("falls back to 'ft' for a stale match with no finished phase (no 139' live)", async () => {
    const { classifyStatus } = await import("../src/live.ts");
    // kicked off 4h ago, phase never resolved → must not stay "live"
    expect(classifyStatus(NOW - 4 * 3600_000, null, NOW)).toBe("ft");
  });

  it("returns 'live' when kickoff has passed and phaseCode is null", async () => {
    const { classifyStatus } = await import("../src/live.ts");
    expect(classifyStatus(NOW - 1, null, NOW)).toBe("live");
  });
});

describe("sortMatches", () => {
  it("orders live → upcoming → ft", async () => {
    const { sortMatches } = await import("../src/live.ts");
    const base = { home: "A", away: "B", kickoffMs: 0, minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 };
    const matches = [
      { ...base, fixtureId: 1, status: "ft" as const },
      { ...base, fixtureId: 2, status: "upcoming" as const },
      { ...base, fixtureId: 3, status: "live" as const },
    ];
    const sorted = sortMatches(matches);
    expect(sorted.map((m) => m.status)).toEqual(["live", "upcoming", "ft"]);
  });
});

describe("GET /api/contest/today", () => {
  it("returns the live contest with pot and a named card", async () => {
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1, status: "upcoming",
          minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
      ]),
      getFixtureMeta: vi.fn(() => new Map([[102, { home: "Japan", away: "Peru" }]])),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/contest/today" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("open");
    expect(body.pot).toBe("80000000");
    expect(body.contestId).toBe(20269);
    expect(body.card).toHaveLength(3);
    expect(body.card[0]).toMatchObject({ fixtureId: 101, home: "Brazil", away: "Spain" });
    expect(body.card[1]).toMatchObject({ fixtureId: 102, home: "Japan", away: "Peru" });
    await app.close();
  });

  it("returns a paused empty-state (pot '0', no contest) before the vault is initialized", async () => {
    // Pre-launch: chain.ts degrades the missing jackpot_vault account to the
    // paused sentinel rather than throwing, so the route must NOT 502.
    vi.mocked(readJackpotVault).mockResolvedValueOnce({
      activeContestId: 0, reserved: "0", lamports: "0", rentFloor: "0", pot: "0",
    });
    vi.mocked(readActiveContest).mockResolvedValueOnce(null);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/today" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "paused", pot: "0", contest: null });
    await app.close();
  });
});

describe("GET /api/contest/entries", () => {
  it("400s without wallet", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/entries" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("returns the wallet's tickets", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/entries?wallet=So11111111111111111111111111111111111111112" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ nonce: 0, amount: "20000000" });
    await app.close();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
