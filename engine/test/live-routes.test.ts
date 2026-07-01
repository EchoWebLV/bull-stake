import { describe, it, expect, vi, beforeEach } from "vitest";

// Slice 4 engine read routes — the live-match program readers/routes tests.
//
// Shared file for S4-T1 (chain.ts readLivePools/readCall), S4-T2 (scoped reads
// + View mappers), S4-T3 (/api/live/* routes). Each task extends this file.
//
// The Anchor layer is mocked (as in chain.contest.test.ts) so the size-filtered
// getProgramAccounts scan runs without a live RPC. The live-match accounts share
// the same discovery seams as the contest reader:
//   - `connection.getProgramAccounts` returns raw { pubkey, account: { data } }
//   - `coder.accounts.memcmp(name)` builds a discriminator/pubkey filter
//   - `coder.accounts.decode(name, data)` decodes one raw account
//   - `program.account.<k>.size` exposes the runtime byte size (NEVER hardcoded)
const h = vi.hoisted(() => ({
  getBalance: vi.fn(async () => 0),
  getMin: vi.fn(async () => 0),
  getProgramAccounts: vi.fn(async (_programId: unknown, _opts?: unknown) => [] as unknown[]),
  decode: vi.fn((_name: string, _data: unknown): unknown => undefined),
  memcmp: vi.fn((_name?: string) => ({ offset: 0, bytes: "d9UCMmqzRPV" })),
  cursorFetch: vi.fn(async (_pda: unknown): Promise<unknown> => ({})),
  entryAll: vi.fn(async (_filters?: unknown): Promise<unknown[]> => []),
}));

vi.mock("@coral-xyz/anchor", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  class BN {
    constructor(public n: number | string) {}
    toString() { return String(this.n); }
    toNumber() { return Number(this.n); }
  }
  return {
    default: { BN },
    BN,
    AnchorProvider: class {
      connection: unknown;
      constructor(connection: unknown) {
        this.connection = connection;
      }
    },
    Program: class {
      programId = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");
      provider = {
        connection: {
          getBalance: h.getBalance,
          getMinimumBalanceForRentExemption: h.getMin,
          getProgramAccounts: h.getProgramAccounts,
        },
      };
      coder = { accounts: { decode: h.decode, memcmp: h.memcmp } };
      account = {
        // Live-match accounts (camelCase keys; runtime sizes match live_state.rs).
        livePool: { size: 176 },
        call: { size: 62 },
        liveCursor: { size: 53, fetch: h.cursorFetch },
        liveEntry: { size: 159, all: h.entryAll },
      };
      constructor(_idl: unknown, _provider: unknown) {}
    },
  };
});

import {
  readLivePools,
  readCall,
  readLiveCursor,
  readLiveEntry,
  toLivePoolView,
  toCallView,
  toLiveEntryView,
  toLiveCursorView,
} from "../src/chain.ts";

// ── BN mock helper (mirrors the mocked @coral-xyz/anchor BN above) ───────────
class TestBN {
  constructor(public n: number | string) {}
  toString() { return String(this.n); }
  toNumber() { return Number(this.n); }
}
function bn(n: number | string) { return new TestBN(n); }
function pk(s: string) { return { toBase58: () => s }; }
// A real, valid base58 pubkey — readLiveEntry feeds `wallet` to the un-mocked
// @solana/web3.js PublicKey ctor, which rejects arbitrary strings like "WALLET".
const REAL_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-arm the memcmp default (cleared above) so discovery can build its filter.
  h.memcmp.mockReturnValue({ offset: 0, bytes: "d9UCMmqzRPV" });
});

// ── S4-T1: readLivePools + readCall (size-filtered scan) ─────────────────────

describe("readLivePools — size-filtered LivePool scan", () => {
  it("reads .size at runtime and passes dataSize:176 (the filter, not a literal)", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readLivePools();

    expect(h.getProgramAccounts).toHaveBeenCalledTimes(1);
    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { dataSize?: number }[] };
    expect(opts.filters.some((f) => f.dataSize === 176)).toBe(true);
  });

  it("uses the camelCase 'livePool' account name for the discriminator memcmp", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readLivePools();

    expect(h.memcmp).toHaveBeenCalledWith("livePool");
  });

  it("filters by the LivePool discriminator at offset 0", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readLivePools();

    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { memcmp: { offset: number; bytes: string } }[] };
    expect(opts.filters[0].memcmp.offset).toBe(0);
    expect(opts.filters[0].memcmp.bytes).toBe("d9UCMmqzRPV");
  });

  it("skips a wrong-size account sharing the discriminator (never reaches decode)", async () => {
    // A 200-byte account slips past a bytes-only filter but must be dropped by the
    // size guard BEFORE decode is called (delegated accounts keep their size).
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "P1" }, account: { data: Buffer.alloc(176) } },  // correct size
      { pubkey: { toBase58: () => "BAD" }, account: { data: Buffer.alloc(200) } }, // wrong size
    ]);
    h.decode.mockReturnValue({ ok: true });

    await readLivePools();

    // decode reached ONLY for the correctly-sized account, never for the 200-byte one.
    expect(h.decode).toHaveBeenCalledTimes(1);
  });

  it("skips an undecodable account (decode throws) but keeps the rest", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "P1" }, account: { data: Buffer.alloc(176) } },
      { pubkey: { toBase58: () => "P2" }, account: { data: Buffer.alloc(176) } },
    ]);
    h.decode
      .mockImplementationOnce(() => { throw new Error("Invalid account discriminator"); })
      .mockReturnValueOnce({ ok: true });

    const pools = await readLivePools();

    // One survives; the undecodable one is skipped, not fatal.
    expect(pools).toHaveLength(1);
  });

  it("total RPC failure during the scan → [] (no throw)", async () => {
    h.getProgramAccounts.mockRejectedValue(new Error("connection refused"));

    expect(await readLivePools()).toEqual([]);
  });

  it("a memcmp throw (IDL-name miss) → [] (no throw)", async () => {
    h.memcmp.mockImplementation(() => { throw new Error("Account not found: livePool"); });

    expect(await readLivePools()).toEqual([]);
  });
});

describe("readCall — size-filtered Call scan (optionally scoped to a pool)", () => {
  it("uses the camelCase 'call' account name and passes dataSize:62", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readCall();

    expect(h.memcmp).toHaveBeenCalledWith("call");
    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { dataSize?: number }[] };
    expect(opts.filters.some((f) => f.dataSize === 62)).toBe(true);
  });

  it("without a pool → only the discriminator filter (no pool memcmp)", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readCall();

    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { memcmp?: { offset: number; bytes: string } }[] };
    // Exactly one memcmp filter (the discriminator); no {offset:8} pool filter.
    const memcmps = opts.filters.filter((f) => f.memcmp);
    expect(memcmps).toHaveLength(1);
    expect(memcmps[0].memcmp!.offset).toBe(0);
  });

  it("with a pool → adds a {offset:8, bytes:pool} memcmp filter", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readCall("PoolBase58Key");

    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { memcmp?: { offset: number; bytes: string } }[] };
    const poolFilter = opts.filters.find((f) => f.memcmp?.offset === 8);
    expect(poolFilter).toBeDefined();
    expect(poolFilter!.memcmp!.bytes).toBe("PoolBase58Key");
  });

  it("skips a wrong-size account before decode", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "C1" }, account: { data: Buffer.alloc(62) } },  // correct
      { pubkey: { toBase58: () => "BAD" }, account: { data: Buffer.alloc(80) } }, // wrong size
    ]);
    h.decode.mockReturnValue({ ok: true });

    await readCall();

    expect(h.decode).toHaveBeenCalledTimes(1);
  });

  it("total RPC failure → [] (no throw)", async () => {
    h.getProgramAccounts.mockRejectedValue(new Error("connection refused"));

    expect(await readCall()).toEqual([]);
  });
});

// ── S4-T2: scoped reads (readLiveCursor / readLiveEntry) + View mappers ──────

describe("readLiveCursor — scoped LiveCursor fetch", () => {
  it("returns the mapped cursor view for a pool", async () => {
    h.cursorFetch.mockResolvedValue({
      pool: pk("POOL"), nextSeq: 3, openSeq: 4294967295, resolvedCount: 2, bump: 7,
    });

    const c = await readLiveCursor(REAL_WALLET);

    expect(c).not.toBeNull();
    expect(c!.pool).toBe("POOL");
    expect(c!.nextSeq).toBe(3);
    expect(c!.openSeq).toBe(4294967295);
    expect(c!.resolvedCount).toBe(2);
  });

  it("missing / unfetchable cursor → null (never throws)", async () => {
    h.cursorFetch.mockRejectedValue(new Error("Account does not exist"));

    expect(await readLiveCursor(REAL_WALLET)).toBeNull();
  });
});

describe("readLiveEntry — wallet+pool scoped LiveEntry", () => {
  it("filters by wallet at offset 8 AND pool at offset 40", async () => {
    h.entryAll.mockResolvedValue([]);

    await readLiveEntry(REAL_WALLET, 777020634);

    expect(h.entryAll).toHaveBeenCalledTimes(1);
    const filters = h.entryAll.mock.calls[0][0] as { memcmp: { offset: number; bytes: string } }[];
    const walletF = filters.find((f) => f.memcmp.offset === 8);
    const poolF = filters.find((f) => f.memcmp.offset === 40);
    expect(walletF).toBeDefined();
    expect(walletF!.memcmp.bytes).toBe(REAL_WALLET);
    expect(poolF).toBeDefined();
    // pool is derived from poolId; just assert a pubkey memcmp is present at 40.
    expect(typeof poolF!.memcmp.bytes).toBe("string");
    expect(poolF!.memcmp.bytes.length).toBeGreaterThan(0);
  });

  it("no matching entry → null", async () => {
    h.entryAll.mockResolvedValue([]);

    expect(await readLiveEntry(REAL_WALLET, 1)).toBeNull();
  });

  it("returns the mapped entry view when one exists", async () => {
    h.entryAll.mockResolvedValue([
      {
        publicKey: pk("ENTRY"),
        account: {
          player: pk("WALLET"),
          pool: pk("POOL"),
          amount: bn("35000000"),
          basePts: 12,
          bonusPts: 5,
          streak: 2,
          nextScoreSeq: 3,
          picks: [1, 0, 0xff, ...Array(61).fill(0xff)],
          bump: 4,
        },
      },
    ]);

    const e = await readLiveEntry(REAL_WALLET, 1);

    expect(e).not.toBeNull();
    expect(e!.pubkey).toBe("ENTRY");
    expect(e!.total).toBe(17);
  });
});

describe("toLivePoolView — LivePool → JSON-safe view", () => {
  const raw = {
    poolId: bn(777020634),
    fixtureId: bn(777020634),
    settleAuthority: pk("AUTH"),
    feeRecipient: pk("FEE"),
    entryPrice: bn("35000000"),
    lockTs: bn(1750000000),
    settleAfterTs: bn(1750003600),
    feeBps: 250,
    status: { live: {} },
    numCalls: 8,
    playerCount: bn(42),
    winningScore: bn(9),
    winnerCount: bn(3),
    distributable: bn("1234567890"),
    claimedCount: bn(2),
    claimedTotal: bn("800000000"),
    settledTs: bn(0),
  };

  it("emits every lamport field as a string (no BigInt survives JSON.stringify)", () => {
    const v = toLivePoolView(pk("POOL") as never, raw);
    expect(typeof v.entryPrice).toBe("string");
    expect(v.entryPrice).toBe("35000000");
    expect(typeof v.distributable).toBe("string");
    expect(typeof v.claimedTotal).toBe("string");
    // player_count / num_calls are small numbers, not strings.
    expect(v.playerCount).toBe(42);
    expect(v.numCalls).toBe(8);
    // round-trips with no BigInt (would throw otherwise).
    expect(() => JSON.stringify(v)).not.toThrow();
  });

  it("maps pubkeys via toBase58 and status via the variant idiom", () => {
    expect(toLivePoolView(pk("POOL") as never, raw).pubkey).toBe("POOL");
    expect(toLivePoolView(pk("POOL") as never, raw).settleAuthority).toBe("AUTH");
    expect(toLivePoolView(pk("POOL") as never, raw).status).toBe("live");
    expect(toLivePoolView(pk("POOL") as never, { ...raw, status: { settled: {} } }).status).toBe("settled");
    expect(toLivePoolView(pk("POOL") as never, { ...raw, status: { voided: {} } }).status).toBe("voided");
    expect(toLivePoolView(pk("POOL") as never, { ...raw, status: { rolledOver: {} } }).status).toBe("rolledOver");
    expect(toLivePoolView(pk("POOL") as never, { ...raw, status: { ended: {} } }).status).toBe("ended");
    expect(toLivePoolView(pk("POOL") as never, { ...raw, status: { open: {} } }).status).toBe("open");
  });
});

describe("toCallView — Call → JSON-safe view", () => {
  const base = {
    pool: pk("POOL"),
    seq: 2,
    kind: { nextGoal: {} },
    state: { open: {} },
    openedTs: bn(1750000100),
    answerSecs: 9,
    numOptions: 3,
    basePoints: [4, 1, 4],
    outcome: 0xff,
    bump: 5,
  };

  it("kind + state via the variant idiom, arrays copied", () => {
    const v = toCallView(pk("CALL") as never, base);
    expect(v.pubkey).toBe("CALL");
    expect(v.pool).toBe("POOL");
    expect(v.seq).toBe(2);
    expect(v.kind).toBe("nextGoal");
    expect(v.state).toBe("open");
    expect(v.basePoints).toEqual([4, 1, 4]);
    expect(v.numOptions).toBe(3);
  });

  it("outcome sentinels: 0xFF → null, 0xFE → 'void', else the index", () => {
    expect(toCallView(pk("C") as never, { ...base, outcome: 0xff }).outcome).toBeNull();
    expect(toCallView(pk("C") as never, { ...base, outcome: 0xfe }).outcome).toBe("void");
    expect(toCallView(pk("C") as never, { ...base, outcome: 0 }).outcome).toBe(0);
    expect(toCallView(pk("C") as never, { ...base, outcome: 2 }).outcome).toBe(2);
  });

  it("maps the other CallKind / CallState variants", () => {
    expect(toCallView(pk("C") as never, { ...base, kind: { goalRush: {} } }).kind).toBe("goalRush");
    expect(toCallView(pk("C") as never, { ...base, kind: { cornerSoon: {} } }).kind).toBe("cornerSoon");
    expect(toCallView(pk("C") as never, { ...base, kind: { cardSoon: {} } }).kind).toBe("cardSoon");
    expect(toCallView(pk("C") as never, { ...base, state: { empty: {} } }).state).toBe("empty");
    expect(toCallView(pk("C") as never, { ...base, state: { resolved: {} } }).state).toBe("resolved");
    expect(toCallView(pk("C") as never, { ...base, state: { voided: {} } }).state).toBe("voided");
  });
});

describe("toLiveEntryView — LiveEntry → JSON-safe view", () => {
  const raw = {
    player: pk("WALLET"),
    pool: pk("POOL"),
    amount: bn("35000000"),
    basePts: 12,
    bonusPts: 5,
    streak: 2,
    nextScoreSeq: 3,
    picks: [1, 0, 0xff, ...Array(61).fill(0xff)],
    bump: 4,
  };

  it("amount as string; total = base_pts + bonus_pts", () => {
    const v = toLiveEntryView(pk("ENTRY") as never, raw);
    expect(typeof v.amount).toBe("string");
    expect(v.amount).toBe("35000000");
    expect(v.total).toBe(17);
    expect(v.basePts).toBe(12);
    expect(v.bonusPts).toBe(5);
    expect(() => JSON.stringify(v)).not.toThrow();
  });

  it("picks 0xFF → null (NO_PICK sentinel), real picks pass through", () => {
    const v = toLiveEntryView(pk("ENTRY") as never, raw);
    expect(v.picks[0]).toBe(1);
    expect(v.picks[1]).toBe(0);
    expect(v.picks[2]).toBeNull();
    expect(v.picks[3]).toBeNull();
  });
});

describe("toLiveCursorView — LiveCursor → JSON-safe view", () => {
  it("maps pool + small counters; NONE_SEQ open_seq passes through as the number", () => {
    const v = toLiveCursorView(pk("CURSOR") as never, {
      pool: pk("POOL"),
      nextSeq: 3,
      openSeq: 4294967295,
      resolvedCount: 2,
      bump: 7,
    });
    expect(v.pubkey).toBe("CURSOR");
    expect(v.pool).toBe("POOL");
    expect(v.nextSeq).toBe(3);
    expect(v.openSeq).toBe(4294967295);
    expect(v.resolvedCount).toBe(2);
    expect(() => JSON.stringify(v)).not.toThrow();
  });
});

// ── S4-T3: /api/live/* routes ────────────────────────────────────────────────
//
// Routes are driven end-to-end through the SAME mocked @coral-xyz/anchor layer
// (getProgramAccounts / decode / entryAll) + buildServer + a mock LiveStore, so
// the assertions exercise the real readLivePoolByFixture / readOpenCall /
// readPoolStandings / readLiveEntry code paths, not stubbed chain functions.

import { buildServer } from "../src/server.ts";
import type { LiveStore } from "../src/live.ts";

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

// A decoded LivePool for a fixture. Only fields the mappers read matter; BNs are
// TestBN (mirrors the mocked anchor BN) and pubkeys expose toBase58().
function poolRaw(over: { poolId: number; fixtureId: number; status?: Record<string, unknown> }) {
  return {
    poolId: bn(over.poolId),
    fixtureId: bn(over.fixtureId),
    settleAuthority: pk("AUTH"),
    feeRecipient: pk("FEE"),
    entryPrice: bn("35000000"),
    lockTs: bn(1750000000),
    settleAfterTs: bn(1750003600),
    feeBps: 250,
    status: over.status ?? { live: {} },
    numCalls: 8,
    playerCount: bn(3),
    winningScore: bn(0),
    winnerCount: bn(0),
    distributable: bn("0"),
    claimedCount: bn(0),
    claimedTotal: bn("0"),
    settledTs: bn(0),
  };
}

function entryRaw(over: { player: string; basePts: number; bonusPts: number }) {
  return {
    player: pk(over.player),
    pool: pk("POOL"),
    amount: bn("35000000"),
    basePts: over.basePts,
    bonusPts: over.bonusPts,
    streak: 1,
    nextScoreSeq: 0,
    picks: Array(64).fill(0xff),
    bump: 4,
  };
}

describe("GET /api/live/pool", () => {
  it("400s when fixtureId is missing", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });

  it("400s when fixtureId is not a number", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool?fixtureId=abc" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 200 { pool: null } (not 404) when no pool exists for the fixture", async () => {
    h.getProgramAccounts.mockResolvedValue([]); // empty pool scan
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool?fixtureId=999" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pool: null });
    await app.close();
  });

  it("502s when the pool chain read fails", async () => {
    // readLivePoolByFixture → readLivePools swallows RPC errors to [], so force a
    // throw at the mapping layer by returning a decoded account whose fields the
    // mapper can't read (decode returns a non-object → toBase58 access throws).
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "P1" }, account: { data: Buffer.alloc(176) } },
    ]);
    h.decode.mockReturnValue(null); // toLivePoolView(null) throws on p.settleAuthority
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool?fixtureId=1" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });

  it("returns the pool with fixture-name join + livePhase drama fold (live row wins)", async () => {
    // Pool scan returns one LivePool for fixture 101; the standings/open-call scans
    // reuse the same getProgramAccounts mock (entries via entryAll → []).
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "POOL101" }, account: { data: Buffer.alloc(176) } },
    ]);
    h.decode.mockImplementation((name: string) =>
      name === "livePool" ? poolRaw({ poolId: 101, fixtureId: 101 }) : undefined,
    );
    h.entryAll.mockResolvedValue([]);
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        {
          fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1234,
          status: "live" as const, minute: 63, phase: "H2", scoreH: 2, scoreA: 1,
          corners: 7, goals: 3, yellows: 2,
        },
      ]),
      getFixtureMeta: vi.fn(() => new Map()),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/live/pool?fixtureId=101" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pool.fixtureId).toBe(101);
    expect(body.pool.entryPrice).toBe("35000000"); // lamports as string
    expect(body.match).toEqual({
      fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1234,
      live: { home: 2, away: 1, minute: 63, phase: "live" },
    });
    await app.close();
  });

  it("fixture-name three-tier fallback: live → meta → #id", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "POOL202" }, account: { data: Buffer.alloc(176) } },
    ]);
    h.decode.mockImplementation((name: string) =>
      name === "livePool" ? poolRaw({ poolId: 202, fixtureId: 202 }) : undefined,
    );
    h.entryAll.mockResolvedValue([]);

    // (a) meta names, no live row → names from meta, no `live` key, kickoffMs null.
    const metaStore = makeMockStore({
      getMatches: vi.fn(() => []),
      getFixtureMeta: vi.fn(() => new Map([[202, { home: "Japan", away: "Peru" }]])),
    });
    let app = buildServer(metaStore);
    let res = await app.inject({ url: "/api/live/pool?fixtureId=202" });
    expect(res.json().match).toEqual({ fixtureId: 202, home: "Japan", away: "Peru", kickoffMs: null });
    expect("live" in res.json().match).toBe(false);
    await app.close();

    // (b) neither live nor meta → "#<id>" placeholder.
    app = buildServer(makeMockStore());
    res = await app.inject({ url: "/api/live/pool?fixtureId=202" });
    expect(res.json().match).toMatchObject({ fixtureId: 202, home: "#202", away: "" });
    await app.close();
  });

  it("folds in the currently-open call + sorted standings", async () => {
    // getProgramAccounts serves BOTH the pool scan and the call scan; distinguish by
    // the memcmp/data shape. Simplest: return the pool for the livePool decode and a
    // call for the call decode, driven by decode(name).
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "X" }, account: { data: Buffer.alloc(176) } },
    ]);
    // Pool scan uses dataSize 176; call scan uses dataSize 62. Return a 176-buffer
    // for pools and a 62-buffer for calls so each scan sees its own account.
    h.getProgramAccounts.mockImplementation(async (_pid: unknown, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      if (size === 176) return [{ pubkey: { toBase58: () => "POOL" }, account: { data: Buffer.alloc(176) } }];
      if (size === 62) return [{ pubkey: { toBase58: () => "CALL" }, account: { data: Buffer.alloc(62) } }];
      return [];
    });
    h.decode.mockImplementation((name: string) => {
      if (name === "livePool") return poolRaw({ poolId: 303, fixtureId: 303 });
      if (name === "call") {
        return {
          pool: pk("POOL"), seq: 2, kind: { nextGoal: {} }, state: { open: {} },
          openedTs: bn(1750000100), answerSecs: 9, numOptions: 3, basePoints: [4, 1, 4],
          outcome: 0xff, bump: 5,
        };
      }
      return undefined;
    });
    h.entryAll.mockResolvedValue([
      { publicKey: pk("E_LOW"), account: entryRaw({ player: "PL", basePts: 3, bonusPts: 1 }) },   // total 4
      { publicKey: pk("E_HIGH"), account: entryRaw({ player: "PH", basePts: 10, bonusPts: 2 }) }, // total 12
    ]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool?fixtureId=303" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openCall).not.toBeNull();
    expect(body.openCall.state).toBe("open");
    expect(body.openCall.seq).toBe(2);
    // standings sorted by total DESC.
    expect(body.standings.map((s: { total: number }) => s.total)).toEqual([12, 4]);
    await app.close();
  });

  it("does not crash when store is undefined (registerRoutes(app) → #id fallback)", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "POOL404" }, account: { data: Buffer.alloc(176) } },
    ]);
    h.decode.mockImplementation((name: string) =>
      name === "livePool" ? poolRaw({ poolId: 404, fixtureId: 404 }) : undefined,
    );
    h.entryAll.mockResolvedValue([]);
    // The route guards `store?` — with NO store injected it must still resolve the
    // fixture name (to "#<id>") rather than throwing on store.getMatches().
    const Fastify = (await import("fastify")).default;
    const { registerRoutes } = await import("../src/routes.ts");
    const app = Fastify({ logger: false });
    registerRoutes(app); // store === undefined
    const res = await app.inject({ url: "/api/live/pool?fixtureId=404" });
    expect(res.statusCode).toBe(200);
    expect(res.json().match).toMatchObject({ fixtureId: 404, home: "#404" });
    await app.close();
  });
});

describe("GET /api/live/pool/:id/standings", () => {
  it("returns entries sorted by total desc", async () => {
    h.entryAll.mockResolvedValue([
      { publicKey: pk("E_MID"), account: entryRaw({ player: "PM", basePts: 5, bonusPts: 0 }) },   // 5
      { publicKey: pk("E_HIGH"), account: entryRaw({ player: "PH", basePts: 9, bonusPts: 3 }) },   // 12
      { publicKey: pk("E_LOW"), account: entryRaw({ player: "PL", basePts: 1, bonusPts: 0 }) },    // 1
    ]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool/303/standings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((s: { total: number }) => s.total)).toEqual([12, 5, 1]);
    // lamports as strings.
    expect(typeof body[0].amount).toBe("string");
    await app.close();
  });

  it("returns 200 [] (not 404) for a pool with no entries", async () => {
    h.entryAll.mockResolvedValue([]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool/303/standings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("filters entries by pool at offset 40", async () => {
    h.entryAll.mockResolvedValue([]);
    const app = buildServer(makeMockStore());
    await app.inject({ url: "/api/live/pool/303/standings" });
    const filters = h.entryAll.mock.calls[0][0] as { memcmp: { offset: number; bytes: string } }[];
    expect(filters.some((f) => f.memcmp.offset === 40)).toBe(true);
    await app.close();
  });

  it("502s when the standings read fails", async () => {
    h.entryAll.mockRejectedValue(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool/303/standings" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toHaveProperty("error");
    await app.close();
  });
});

describe("GET /api/live/entry", () => {
  it("400s when wallet is missing", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/entry?poolId=1" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s when poolId is missing", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 200 { entry: null } when no ticket exists", async () => {
    h.entryAll.mockResolvedValue([]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}&poolId=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entry: null });
    await app.close();
  });

  it("returns the wallet's entry with amount as a string + total", async () => {
    h.entryAll.mockResolvedValue([
      { publicKey: pk("ENTRY"), account: entryRaw({ player: "WALLET", basePts: 12, bonusPts: 5 }) },
    ]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}&poolId=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entry).not.toBeNull();
    expect(typeof body.entry.amount).toBe("string");
    expect(body.entry.total).toBe(17);
    await app.close();
  });

  it("502s when the entry read fails", async () => {
    h.entryAll.mockRejectedValue(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}&poolId=1` });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});
