import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer } from "../src/server.ts";
import {
  readJackpot, readLiveContests, listEntriesForWallet, readMarket, listRawEntriesForContest, deriveMarketPda,
} from "../src/chain.ts";
import { PROGRAM_ID } from "../src/config.ts";
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
    // One live single-match parlay contest (v2 shape: legs[], pot, no potSnapshot/numMatches).
    readLiveContests: vi.fn(async () => [
      {
        pubkey: "Contest111", contestId: 20269,
        settleAuthority: "Keep1111111111111111111111111111111111111111",
        feeRecipient: "Fee11111111111111111111111111111111111111111",
        fixtures: [101], marketIds: [10, 12, 13], numLegs: 3,
        legs: [
          { marketId: 10, label: "Total Corners O/U 9.5", group: "corners", numBuckets: 2, fixtureId: 101, winningBucket: null },
          { marketId: 12, label: "Match Result",          group: "result",  numBuckets: 3, fixtureId: 101, winningBucket: null },
          { marketId: 13, label: "Total Yellow Cards O/U 3.5", group: "cards", numBuckets: 2, fixtureId: 101, winningBucket: null },
        ],
        entryPrice: "20000000", lockTs: 9999999999,
        legLockTs: [9999999999, 9999999999, 9999999999, 0, 0, 0], entriesCloseTs: 9999999999,
        settleAfterTs: 9999999999,
        feeBps: 500, status: "open", winningBuckets: [0, 0, 0],
        entryCount: 4, perfectCount: 0, perfectWeight: "0", pot: "80000000", distributable: "0",
        claimedCount: 0, claimedTotal: "0", settledTs: 0,
      },
    ]),
    readJackpot: vi.fn(async () => ({
      lamports: "82000000", rentFloor: "2000000", pot: "80000000",
    })),
    listEntriesForWallet: vi.fn(async () => [
      { pubkey: "Entry111", contestId: 20269, nonce: 0, picks: [0, 1, 2, 0, 0], amount: "20000000",
        won: false, claimable: false, payout: "0" },
    ]),
    listRawEntriesForContest: vi.fn(async () => [] as unknown[]),
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

describe("livePhase (store status → card phase)", () => {
  it("maps status 'upcoming' → 'pre' (phase label is ignored)", async () => {
    const { livePhase } = await import("../src/live.ts");
    expect(livePhase("upcoming", null)).toBe("pre");
    expect(livePhase("upcoming", "NS")).toBe("pre");
  });

  it("maps status 'ft' → 'ft' (phase label is ignored)", async () => {
    const { livePhase } = await import("../src/live.ts");
    expect(livePhase("ft", null)).toBe("ft");
    expect(livePhase("ft", "F")).toBe("ft");
    expect(livePhase("ft", "FET")).toBe("ft");
  });

  it("maps status 'live' → 'live' for in-play halves (H1/H2)", async () => {
    const { livePhase } = await import("../src/live.ts");
    expect(livePhase("live", "H1")).toBe("live");
    expect(livePhase("live", "H2")).toBe("live");
  });

  it("splits half-time out of 'live' → 'ht' from the phase label", async () => {
    const { livePhase } = await import("../src/live.ts");
    // classifyStatus folds HT into status:"live"; only the label distinguishes it.
    expect(livePhase("live", "HT")).toBe("ht");
    expect(livePhase("live", "HTET")).toBe("ht");
  });

  it("leaves a live match as 'live' when the phase label is null/unknown", async () => {
    const { livePhase } = await import("../src/live.ts");
    expect(livePhase("live", null)).toBe("live");
    expect(livePhase("live", "weird")).toBe("live");
  });
});

describe("GET /api/contest/live", () => {
  it("returns an array of live contests, each with match + legs joined", async () => {
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1234, status: "upcoming" as const,
          minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
      ]),
      getFixtureMeta: vi.fn(() => new Map()),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/contest/live" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    const c = body[0];
    // Top-level contest fields (no potSnapshot / numMatches; pot is its own escrow).
    expect(c).toMatchObject({
      contestId: 20269, status: "open", pot: "80000000", entryPrice: "20000000",
      lockTs: 9999999999, settleAfterTs: 9999999999, entryCount: 4, perfectCount: 0,
      distributable: "0", numLegs: 3,
    });
    // Single-match `match` join (live row wins).
    expect(c.match).toEqual({ fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1234 });
    // Per-leg legs, with the O/U line joined from the markets catalog.
    expect(c.legs).toHaveLength(3);
    expect(c.legs[0]).toMatchObject({
      fixtureId: 101, marketId: 10, label: "Total Corners O/U 9.5",
      group: "corners", numBuckets: 2, line: 9.5, winningBucket: null,
    });
    // Three-way result market (line 0) still carries its catalog line.
    expect(c.legs[1]).toMatchObject({ marketId: 12, group: "result", numBuckets: 3, line: 0 });
    await app.close();
  });

  it("falls back to fixture meta names, then to #fixtureId when neither is known", async () => {
    // No live row; meta supplies names for 101.
    const store = makeMockStore({
      getMatches: vi.fn(() => []),
      getFixtureMeta: vi.fn(() => new Map([[101, { home: "Japan", away: "Peru" }]])),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/contest/live" });
    const body = res.json();
    expect(body[0].match).toEqual({ fixtureId: 101, home: "Japan", away: "Peru", kickoffMs: null });
    await app.close();
  });

  it("OMITS the leg `line` key (not null) when the marketId is out of catalog", async () => {
    // marketById(99) is undefined, so the route's `line: marketById(...)?.line`
    // resolves to `undefined`, which JSON.stringify drops entirely. This guards
    // the web contract (`line?`) against a `?.line ?? null` regression that would
    // smuggle a null line into the payload.
    vi.mocked(readLiveContests).mockResolvedValueOnce([
      {
        pubkey: "Contest222", contestId: 30001,
        settleAuthority: "Keep1111111111111111111111111111111111111111",
        feeRecipient: "Fee11111111111111111111111111111111111111111",
        fixtures: [202], marketIds: [99], numLegs: 1,
        legs: [
          { marketId: 99, label: "", group: "", numBuckets: 0, fixtureId: 202, winningBucket: null },
        ],
        entryPrice: "20000000", lockTs: 9999999999,
        legLockTs: [9999999999, 0, 0, 0, 0, 0], entriesCloseTs: 9999999999,
        settleAfterTs: 9999999999,
        feeBps: 500, status: "open", winningBuckets: [0],
        entryCount: 0, perfectCount: 0, perfectWeight: "0", pot: "0", distributable: "0",
        claimedCount: 0, claimedTotal: "0", settledTs: 0,
      },
    ]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/live" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const leg = body[0].legs[0];
    expect(leg).toMatchObject({ marketId: 99, fixtureId: 202, winningBucket: null });
    // The contract is `line?` — an unknown market must drop the key, not send null.
    expect("line" in leg).toBe(false);
    expect(leg).not.toHaveProperty("line");
    await app.close();
  });

  it("returns 200 + [] (not a paused object) when no contests are live", async () => {
    vi.mocked(readLiveContests).mockResolvedValueOnce([]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/live" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("502s when the contest read fails", async () => {
    vi.mocked(readLiveContests).mockRejectedValueOnce(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/live" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });
});

describe("selectTodaysCard", () => {
  // Minimal ContestView factory — only the fields selectTodaysCard reads matter.
  const c = (over: { contestId: number; status?: string; lockTs: number; settleAfterTs: number }) =>
    ({
      pubkey: `C${over.contestId}`, contestId: over.contestId,
      settleAuthority: "", feeRecipient: "", fixtures: [], marketIds: [], numLegs: 0,
      legs: [], entryPrice: "0", lockTs: over.lockTs,
      legLockTs: [], entriesCloseTs: 0, settleAfterTs: over.settleAfterTs,
      feeBps: 0, status: (over.status ?? "open") as "open", winningBuckets: [],
      entryCount: 0, perfectCount: 0, perfectWeight: "0", pot: "0", distributable: "0",
      claimedCount: 0, claimedTotal: "0", settledTs: 0,
    });

  it("returns null when no contests exist", async () => {
    const { selectTodaysCard } = await import("../src/routes.ts");
    expect(selectTodaysCard([], 1000)).toBeNull();
  });

  it("ignores non-open contests (settled/voided are never 'today')", async () => {
    const { selectTodaysCard } = await import("../src/routes.ts");
    const settled = c({ contestId: 1, status: "settled", lockTs: 0, settleAfterTs: 9999 });
    expect(selectTodaysCard([settled], 500)).toBeNull();
  });

  it("prefers the Open contest whose [lockTs, settleAfterTs] window covers now", async () => {
    const { selectTodaysCard } = await import("../src/routes.ts");
    const past = c({ contestId: 1, lockTs: 0, settleAfterTs: 100 });        // window before now
    const covering = c({ contestId: 2, lockTs: 400, settleAfterTs: 600 });  // covers now=500
    const future = c({ contestId: 3, lockTs: 900, settleAfterTs: 1000 });   // window after now
    expect(selectTodaysCard([past, covering, future], 500)?.contestId).toBe(2);
  });

  it("picks the latest when several Open windows cover now", async () => {
    const { selectTodaysCard } = await import("../src/routes.ts");
    const a = c({ contestId: 1, lockTs: 100, settleAfterTs: 900 }); // covers 500
    const b = c({ contestId: 2, lockTs: 300, settleAfterTs: 900 }); // covers 500, later lock
    expect(selectTodaysCard([a, b], 500)?.contestId).toBe(2);
  });

  it("falls back to the most recent Open card when no window covers now", async () => {
    const { selectTodaysCard } = await import("../src/routes.ts");
    const older = c({ contestId: 1, lockTs: 1000, settleAfterTs: 2000 });
    const newer = c({ contestId: 2, lockTs: 5000, settleAfterTs: 6000 });
    // now=100 is before both windows → fall back to the latest-lock Open contest.
    expect(selectTodaysCard([older, newer], 100)?.contestId).toBe(2);
  });
});

describe("GET /api/card", () => {
  it("returns today's card with per-leg match join + folded-in jackpot", async () => {
    // Default mock readLiveContests is one Open contest (lockTs 9999999999) — the
    // most-recent-Open fallback selects it.
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1_700_000_000_000,
          status: "upcoming" as const, minute: null, phase: null, scoreH: 0, scoreA: 0,
          corners: 0, goals: 0, yellows: 0 },
      ]),
      getFixtureMeta: vi.fn(() => new Map()),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      contestId: 20269, status: "open", lockTs: 9999999999, settleAfterTs: 9999999999,
      entryPrice: "20000000", pot: "80000000", jackpot: "80000000",
    });
    expect(body.legs).toHaveLength(3);
    // Per-leg single-match join (live row wins) + catalog line + buckets, kickoff in
    // SECONDS. An upcoming live row also stamps `live` with phase "pre".
    expect(body.legs[0]).toEqual({
      fixtureId: 101, home: "Brazil", away: "Spain", kickoffTs: 1_700_000_000,
      marketId: 10, label: "Total Corners O/U 9.5", group: "corners", line: 9.5, buckets: 2,
      lockTs: 9999999999,
      live: { home: 0, away: 0, minute: null, phase: "pre" },
    });
    // Three-way result market (line 0) carries buckets:3.
    expect(body.legs[1]).toMatchObject({ marketId: 12, group: "result", line: 0, buckets: 3 });
    await app.close();
  });

  it("stamps each leg's `live` from the store (score/minute/phase) for an in-play fixture", async () => {
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: Date.now() - 3600_000,
          status: "live" as const, minute: 63, phase: "H2", scoreH: 2, scoreA: 1,
          corners: 7, goals: 3, yellows: 2 },
      ]),
      getFixtureMeta: vi.fn(() => new Map()),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Same fixture on every leg (single-match parlay) → same live object.
    for (const leg of body.legs) {
      expect(leg.live).toEqual({ home: 2, away: 1, minute: 63, phase: "live" });
    }
    await app.close();
  });

  it("maps a half-time store row to phase 'ht'", async () => {
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: Date.now() - 2700_000,
          status: "live" as const, minute: null, phase: "HT", scoreH: 1, scoreA: 0,
          corners: 4, goals: 1, yellows: 1 },
      ]),
      getFixtureMeta: vi.fn(() => new Map()),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/card" });
    const body = res.json();
    expect(body.legs[0].live).toEqual({ home: 1, away: 0, minute: null, phase: "ht" });
    await app.close();
  });

  it("OMITS `live` entirely when the store has no live entry for the fixture", async () => {
    // No live row; names resolved from fixture-meta only → no `live` key at all.
    const store = makeMockStore({
      getMatches: vi.fn(() => []),
      getFixtureMeta: vi.fn(() => new Map([[101, { home: "Japan", away: "Peru" }]])),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/card" });
    const body = res.json();
    for (const leg of body.legs) {
      expect("live" in leg).toBe(false);
      expect(leg).not.toHaveProperty("live");
    }
    await app.close();
  });

  it("falls back to fixture meta names, then to #fixtureId + null kickoff", async () => {
    const store = makeMockStore({
      getMatches: vi.fn(() => []),
      getFixtureMeta: vi.fn(() => new Map([[101, { home: "Japan", away: "Peru" }]])),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/card" });
    const body = res.json();
    expect(body.legs[0]).toMatchObject({
      fixtureId: 101, home: "Japan", away: "Peru", kickoffTs: null,
    });
    await app.close();
  });

  it("OMITS the leg `line` key (not null) for an out-of-catalog market", async () => {
    vi.mocked(readLiveContests).mockResolvedValueOnce([
      {
        pubkey: "Contest222", contestId: 30001,
        settleAuthority: "Keep1111111111111111111111111111111111111111",
        feeRecipient: "Fee11111111111111111111111111111111111111111",
        fixtures: [202], marketIds: [99], numLegs: 1,
        legs: [{ marketId: 99, label: "", group: "", numBuckets: 0, fixtureId: 202, winningBucket: null }],
        entryPrice: "20000000", lockTs: 9999999999,
        legLockTs: [9999999999, 0, 0, 0, 0, 0], entriesCloseTs: 9999999999,
        settleAfterTs: 9999999999,
        feeBps: 500, status: "open", winningBuckets: [0],
        entryCount: 0, perfectCount: 0, perfectWeight: "0", pot: "0", distributable: "0",
        claimedCount: 0, claimedTotal: "0", settledTs: 0,
      },
    ]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(200);
    const leg = res.json().legs[0];
    expect(leg).toMatchObject({ marketId: 99, fixtureId: 202, buckets: 0 });
    expect("line" in leg).toBe(false);
    await app.close();
  });

  it("returns 200 + { card: null } when no Open contest exists", async () => {
    vi.mocked(readLiveContests).mockResolvedValueOnce([]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ card: null });
    await app.close();
  });

  it("serves the card with jackpot:'0' when the jackpot read fails (best-effort)", async () => {
    vi.mocked(readJackpot).mockRejectedValueOnce(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.contestId).toBe(20269);
    expect(body.jackpot).toBe("0");
    await app.close();
  });

  it("502s when the contest read fails", async () => {
    vi.mocked(readLiveContests).mockRejectedValueOnce(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });

  it("returns per-leg locks, entriesCloseTs, aliveCount and myCard for ?wallet=", async () => {
    const WALLET = "So11111111111111111111111111111111111111112";
    const OTHER = "CYDxTZVogVUscoWr6Fftz6M6ubnCo98PQDBn2Uo3AquM";
    const fixtures = [301, 302, 303, 304, 305, 306];
    const marketIds = [12, 12, 12, 12, 12, 12];
    const legLockTs = [100, 200, 300, 400, 500, 600];

    // 6-leg Open card; every leg's own catalog join (winningBucket stays null
    // at the CONTEST level until the whole contest settles — the per-leg
    // "is it settled yet" answer instead comes from each leg's own Market
    // account, resolved below via `readMarket`).
    vi.mocked(readLiveContests).mockResolvedValueOnce([
      {
        pubkey: "Contest999", contestId: 40001,
        settleAuthority: "Keep1111111111111111111111111111111111111111",
        feeRecipient: "Fee11111111111111111111111111111111111111111",
        fixtures, marketIds, numLegs: 6,
        legs: fixtures.map((fixtureId, i) => ({
          marketId: marketIds[i], label: "Match Result", group: "result",
          numBuckets: 3, fixtureId, winningBucket: null,
        })),
        entryPrice: "20000000", lockTs: 100,
        legLockTs, entriesCloseTs: 100,
        settleAfterTs: 9999999999,
        feeBps: 500, status: "open", winningBuckets: [0, 0, 0, 0, 0, 0],
        entryCount: 2, perfectCount: 0, perfectWeight: "0", pot: "40000000", distributable: "0",
        claimedCount: 0, claimedTotal: "0", settledTs: 0,
      },
    ]);

    // Leg 0's own Market (fixture 301, marketId 12) is settled with winningBucket 1;
    // every other leg's market is still open (unsettled → excluded from alive-checking).
    const settledLegPda = deriveMarketPda(PROGRAM_ID, 301, 12).toBase58();
    vi.mocked(readMarket).mockImplementation(async (pubkey: string) => {
      if (pubkey === settledLegPda) {
        return {
          pubkey, status: "settled", fixtureId: 301, marketId: 12, numBuckets: 3,
          bucketTotals: ["0", "0", "0"], totalPool: "0", feeBps: 0, feeCollected: "0",
          winningBucket: 1, entryCloseTs: 100, settledValue: 0,
        };
      }
      return {
        pubkey, status: "open", fixtureId: 0, marketId: 12, numBuckets: 3,
        bucketTotals: ["0", "0", "0"], totalPool: "0", feeBps: 0, feeCollected: "0",
        winningBucket: null, entryCloseTs: 9999999999, settledValue: 0,
      };
    });

    // Two entries, both timed BEFORE every leg_lock_ts (all 6 legs active, weight
    // 2^6 = 64). The wallet's picks[0] matches the settled leg's winningBucket 1
    // (alive); the other wallet's picks[0] does not (dead).
    vi.mocked(listRawEntriesForContest).mockResolvedValueOnce([
      { pubkey: "EntryW", bettor: WALLET, nonce: 0, picks: [1, 0, 0, 0, 0, 0], amount: "20000000", entryTs: 1 },
      { pubkey: "EntryO", bettor: OTHER, nonce: 0, picks: [0, 0, 0, 0, 0, 0], amount: "20000000", entryTs: 1 },
    ]);

    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/card?wallet=${WALLET}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.entriesCloseTs).toBeTypeOf("number");
    expect(body.legs[0].lockTs).toBeTypeOf("number");
    expect(body.legs.map((l: { lockTs: number }) => l.lockTs)).toEqual(legLockTs);
    expect(body.aliveCount).toBe(1); // only the wallet's entry still matches the one settled+active leg
    expect(body.myCard.weight).toBe(64); // entered pre-lock on every leg → 2^6
    expect(body.myCard.picks).toHaveLength(6);
    expect(body.myCard.alive).toBe(true);
    await app.close();
  });

  it("myCard is null when ?wallet= has no entry on the card", async () => {
    const WALLET = "So11111111111111111111111111111111111111112";
    vi.mocked(listRawEntriesForContest).mockResolvedValueOnce([]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/card?wallet=${WALLET}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().myCard).toBeNull();
    await app.close();
  });

  it("aliveCount is 0 and myCard is omitted-null when no ?wallet= is given", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/card" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.aliveCount).toBe(0); // default fixture's listRawEntriesForContest mock is []
    expect(body.myCard).toBeNull();
    await app.close();
  });
});

describe("GET /api/jackpot", () => {
  it("returns the jackpot view with a pot string", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/jackpot" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("pot", "80000000");
    await app.close();
  });

  it("502s when the jackpot read fails", async () => {
    vi.mocked(readJackpot).mockRejectedValueOnce(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/jackpot" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty("error");
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
  it("returns the wallet's tickets (aggregated across live contests, v2 shape)", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/entries?wallet=So11111111111111111111111111111111111111112" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      contestId: 20269, nonce: 0, amount: "20000000",
      won: false, claimable: false, payout: "0",
    });
    expect(vi.mocked(listEntriesForWallet)).toHaveBeenCalledWith("So11111111111111111111111111111111111111112");
    await app.close();
  });
  it("passes a numeric ?contestId= through to listEntriesForWallet", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({
      url: "/api/contest/entries?wallet=So11111111111111111111111111111111111111112&contestId=20269",
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(listEntriesForWallet)).toHaveBeenCalledWith(
      "So11111111111111111111111111111111111111112", 20269,
    );
    await app.close();
  });
  it("502s when the entries fetch fails", async () => {
    vi.mocked(listEntriesForWallet).mockRejectedValueOnce(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/entries?wallet=So11111111111111111111111111111111111111112" });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
