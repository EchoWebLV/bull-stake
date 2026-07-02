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
  getAccountInfo: vi.fn(async (_pda: unknown): Promise<unknown> => null),
  decode: vi.fn((_name: string, _data: unknown): unknown => undefined),
  memcmp: vi.fn((_name?: string) => ({ offset: 0, bytes: "d9UCMmqzRPV" })),
  cursorFetch: vi.fn(async (_pda: unknown): Promise<unknown> => ({})),
  entryAll: vi.fn(async (_filters?: unknown): Promise<unknown[]> => []),
  // MagicBlock ER connection seams (erConn() in chain.ts). Default to "not on the
  // rollup" so every existing test reads base exactly as before; the live-play
  // tests arm these to serve the delegated open call / live points.
  erGetAccountInfo: vi.fn(async (_pda: unknown): Promise<unknown> => null),
  erGetMulti: vi.fn(async (_pdas: unknown[]): Promise<unknown[]> => []),
}));

// The ER connection is a real `new Connection(ER_RPC)`; partial-mock web3.js so it
// routes to the hoisted ER seams (PublicKey et al. stay real — REAL_WALLET needs
// the genuine ctor, and the base reads go through the mocked Anchor Program, not
// this Connection).
vi.mock("@solana/web3.js", async (orig) => {
  const actual = await orig<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: class {
      constructor(_url?: string, _commitment?: unknown) {}
      getAccountInfo = h.erGetAccountInfo;
      getMultipleAccountsInfo = h.erGetMulti;
    },
  };
});

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
          getAccountInfo: h.getAccountInfo,
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
  __clearErReadCache,
  readLivePools,
  readCall,
  readLiveCursor,
  readLiveEntry,
  readOpenCall,
  readLastResolvedCall,
  readPoolStandings,
  deriveLiveCursorPda,
  deriveCallPda,
  toLivePoolView,
  toCallView,
  toLiveEntryView,
  toLiveCursorView,
} from "../src/chain.ts";
import { PROGRAM_ID } from "../src/config.ts";
import { PublicKey } from "@solana/web3.js";

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
  // Restore the "nothing on the ER" default so a prior live-play test can't leak
  // rollup rows into a base-only test.
  h.erGetAccountInfo.mockResolvedValue(null);
  h.erGetMulti.mockResolvedValue([]);
  // Restore the base getAccountInfo default too: the scoped-read tests arm it
  // per-case, and readOpenCall now reads the cursor (getAccountInfo) before its
  // scan fallback — a leaked value would fake a cursor and skip the scan.
  h.getAccountInfo.mockResolvedValue(null);
  // The ER read cache is module state — clear it so no test sees another's rows.
  __clearErReadCache();
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

describe("readLiveCursor — OWNER-AGNOSTIC direct PDA read (stress-test F5)", () => {
  it("reads the derived PDA via getAccountInfo + coder.decode('liveCursor') — never an owner-checked fetch", async () => {
    // The account is DELEGATED (owner = Delegation Program) — mid-match state.
    // A direct read + decode must still surface it.
    h.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(53), owner: pk("DELeGG") });
    h.decode.mockImplementation((name: string) =>
      name === "liveCursor"
        ? { pool: pk("POOL"), nextSeq: 3, openSeq: 4294967295, resolvedCount: 2, bump: 7 }
        : undefined,
    );

    const c = await readLiveCursor(REAL_WALLET);

    expect(c).not.toBeNull();
    expect(c!.pool).toBe("POOL");
    expect(c!.nextSeq).toBe(3);
    expect(c!.openSeq).toBe(4294967295);
    expect(c!.resolvedCount).toBe(2);
    // The read went through getAccountInfo (owner-agnostic), not an .all()/fetch scan.
    expect(h.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(h.decode).toHaveBeenCalledWith("liveCursor", expect.anything());
  });

  it("missing account → null (never throws)", async () => {
    h.getAccountInfo.mockResolvedValue(null);
    expect(await readLiveCursor(REAL_WALLET)).toBeNull();
  });

  it("RPC failure → null (cursor reads degrade gracefully)", async () => {
    h.getAccountInfo.mockRejectedValue(new Error("rpc down"));
    expect(await readLiveCursor(REAL_WALLET)).toBeNull();
  });
});

describe("readLiveEntry — direct derived-PDA read, owner-agnostic (stress-test F5)", () => {
  it("fetches the DERIVED entry PDA via getAccountInfo (no owner-scoped .all() scan)", async () => {
    h.getAccountInfo.mockResolvedValue(null);

    await readLiveEntry(REAL_WALLET, 777020634);

    // One direct read of the derived [b"liveentry", pool, player] PDA…
    expect(h.getAccountInfo).toHaveBeenCalledTimes(1);
    // …and NOT the owner-scoped scan that blanked delegated (mid-match) entries.
    expect(h.entryAll).not.toHaveBeenCalled();
    expect(h.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("no ticket at the PDA → null", async () => {
    h.getAccountInfo.mockResolvedValue(null);
    expect(await readLiveEntry(REAL_WALLET, 1)).toBeNull();
  });

  it("REGRESSION: a DELEGATED entry (owner = Delegation Program) still maps to a view", async () => {
    // Mid-match state: the seat is playing and scoring on the ER; base owner flipped.
    h.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(159), owner: pk("DELeGG") });
    h.decode.mockImplementation((name: string) =>
      name === "liveEntry"
        ? {
            player: pk("WALLET"),
            pool: pk("POOL"),
            amount: bn("35000000"),
            basePts: 12,
            bonusPts: 5,
            streak: 2,
            nextScoreSeq: 3,
            picks: [1, 0, 0xff, ...Array(61).fill(0xff)],
            bump: 4,
          }
        : undefined,
    );

    const e = await readLiveEntry(REAL_WALLET, 1);

    expect(e).not.toBeNull();
    expect(e!.total).toBe(17); // base 12 + bonus 5 — live points visible mid-match
  });

  it("garbage data at the PDA (decode throws) → null; an RPC failure PROPAGATES (route 502s)", async () => {
    h.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(159) });
    h.decode.mockImplementation(() => {
      throw new Error("bad discriminator");
    });
    expect(await readLiveEntry(REAL_WALLET, 1)).toBeNull();

    h.getAccountInfo.mockRejectedValue(new Error("rpc down"));
    await expect(readLiveEntry(REAL_WALLET, 1)).rejects.toThrow("rpc down");
  });
});

// ── #1 FIX: ER-FIRST live reads (the open call is on the rollup, not base) ────
//
// A call opens → is tapped → resolves entirely on the Ephemeral Rollup, and the
// keeper only commits ER→base AFTER it resolves — so an OPEN call is NEVER on
// base. Reading base (even dual-owner) returns null for the whole answer window,
// which made the live game untappable. These tests pin the ER-first paths:
//   - readLiveCursor / readLiveEntry read the ER copy when present (base frozen)
//   - readOpenCall derives the open call from the cursor's open_seq + reads it ER
//   - readPoolStandings overlays live ER points onto the base roster
// The pool arg is REAL_WALLET (any valid base58 key) so the real PDA derivations
// used to key the ER mock match what the readers derive.
describe("ER-first live reads (#1 — makes the live game playable)", () => {
  const poolPk = new PublicKey(REAL_WALLET);
  const cursorPda = deriveLiveCursorPda(PROGRAM_ID, poolPk);

  /** A decoded open Call at `seq` (state=open, NextGoal 3-opt). */
  function openCallRaw(seq: number) {
    return {
      pool: pk("POOL"), seq, kind: { nextGoal: {} }, state: { open: {} },
      openedTs: bn(1750000100), answerSecs: 9, numOptions: 3, basePoints: [4, 1, 4],
      outcome: 0xff, bump: 5,
    };
  }
  /** A decoded RESOLVED Call at `seq` with the given winning-option index. */
  function resolvedCallRaw(seq: number, outcome: number) {
    return {
      pool: pk("POOL"), seq, kind: { nextGoal: {} }, state: { resolved: {} },
      openedTs: bn(1750000100), answerSecs: 9, numOptions: 3, basePoints: [4, 1, 4],
      outcome, bump: 5,
    };
  }
  /** A decoded LiveCursor with the given open_seq and resolved_count. */
  function cursorRaw(openSeq: number, resolvedCount = 1) {
    return { pool: pk("POOL"), nextSeq: openSeq + 1, openSeq, resolvedCount, bump: 7 };
  }

  it("readLiveCursor prefers the ER copy over the (frozen) base copy", async () => {
    // ER serves openSeq=2; base is armed to a STALE cursor that must NOT win.
    h.erGetAccountInfo.mockResolvedValue({ data: Buffer.alloc(53, 0xE) });
    h.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(53, 0x0) }); // frozen base
    h.decode.mockImplementation((name: string, data?: any) =>
      name === "liveCursor"
        ? cursorRaw(data?.[0] === 0xe ? 2 : 999) // ER buffer (0xE) → the live open_seq
        : undefined,
    );

    const c = await readLiveCursor(REAL_WALLET);

    expect(c!.openSeq).toBe(2); // ER won; base's stale 999 never surfaced
    expect(h.getAccountInfo).not.toHaveBeenCalled(); // ER short-circuited base
  });

  it("readOpenCall: cursor.open_seq → derive that Call PDA → read it from the ER", async () => {
    const callPda = deriveCallPda(PROGRAM_ID, poolPk, 2);
    // ER serves BOTH the cursor (53) and, at the derived seq-2 PDA, the open call (62).
    h.erGetAccountInfo.mockImplementation(async (pda: any) => {
      if (pda.toBase58() === cursorPda.toBase58()) return { data: Buffer.alloc(53, 0xC) };
      if (pda.toBase58() === callPda.toBase58()) return { data: Buffer.alloc(62, 0xA) };
      return null;
    });
    h.decode.mockImplementation((name: string) =>
      name === "liveCursor" ? cursorRaw(2) : name === "call" ? openCallRaw(2) : undefined,
    );

    const view = await readOpenCall(REAL_WALLET);

    expect(view).not.toBeNull();
    expect(view!.state).toBe("open");
    expect(view!.seq).toBe(2);
    // Sourced entirely from the ER — no base getAccountInfo, no dual-owner scan.
    expect(h.getAccountInfo).not.toHaveBeenCalled();
    expect(h.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("readOpenCall returns null (no scan) when the cursor reports NONE_SEQ", async () => {
    h.erGetAccountInfo.mockResolvedValue({ data: Buffer.alloc(53, 0xC) });
    h.decode.mockImplementation((name: string) =>
      name === "liveCursor" ? cursorRaw(4294967295) : undefined, // NONE_SEQ = u32::MAX
    );

    expect(await readOpenCall(REAL_WALLET)).toBeNull();
    // Authoritative "nothing open" — must NOT fall back to the dual-owner scan.
    expect(h.getProgramAccounts).not.toHaveBeenCalled();
  });

  it("readLiveEntry prefers the ER copy so LIVE points win over the frozen base", async () => {
    h.erGetAccountInfo.mockResolvedValue({ data: Buffer.alloc(159, 0xE) }); // live
    h.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(159, 0x0) });   // frozen base
    h.decode.mockImplementation((name: string, data?: any) =>
      name === "liveEntry"
        ? entryRaw({ player: "WALLET", basePts: data?.[0] === 0xe ? 12 : 0, bonusPts: data?.[0] === 0xe ? 5 : 0 })
        : undefined,
    );

    const e = await readLiveEntry(REAL_WALLET, 1);

    expect(e!.total).toBe(17); // ER's live 12+5, not base's frozen 0
    expect(h.getAccountInfo).not.toHaveBeenCalled();
  });

  it("readPoolStandings overlays live ER points onto the base roster", async () => {
    // Base scan supplies the ROSTER (2 seats), tagged with byte 0x1 (frozen bytes).
    h.getProgramAccounts.mockImplementation(async (_owner: unknown, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      if (size !== 159) return [];
      return [
        { pubkey: pk("E1"), account: { data: Buffer.alloc(159, 0x1) } },
        { pubkey: pk("E2"), account: { data: Buffer.alloc(159, 0x1) } },
      ];
    });
    // ER returns LIVE bytes (0x9) for both seats — higher points than the base bytes.
    h.erGetMulti.mockResolvedValue([
      { data: Buffer.alloc(159, 0x9) },
      { data: Buffer.alloc(159, 0x9) },
    ]);
    h.decode.mockImplementation((name: string, data?: any) => {
      if (name !== "liveEntry") return undefined;
      // Frozen base bytes → 1 pt; live ER bytes → 20 pts (E1) / 5 pts (E2 by pubkey? no —
      // keyed by call order). Distinguish the two seats by returning different points.
      const live = data?.[0] === 0x9;
      return entryRaw({ player: "P", basePts: live ? 20 : 1, bonusPts: 0 });
    });

    const rows = await readPoolStandings(1);

    expect(rows.map((r) => r.total)).toEqual([20, 20]); // both seats reflect LIVE ER points
    expect(h.erGetMulti).toHaveBeenCalledTimes(1);
  });

  // Bug A (live test-match finding): ER rate limits must not blank the open call.
  it("STALE-SERVE: after one good ER read, a failing ER read serves the recent value", async () => {
    // First read: ER serves the live cursor (openSeq 2).
    h.erGetAccountInfo.mockResolvedValue({ data: Buffer.alloc(53, 0xC) });
    h.decode.mockImplementation((name: string) => (name === "liveCursor" ? cursorRaw(2) : undefined));
    expect((await readLiveCursor(REAL_WALLET))!.openSeq).toBe(2);

    // ER now rate-limits AND the cache TTL is bypassed by clearing only inflight…
    // (the fresh-TTL window would serve it anyway; the point is the ERROR path:)
    h.erGetAccountInfo.mockRejectedValue(new Error("429 Too Many Requests"));
    const c = await readLiveCursor(REAL_WALLET);
    // …the recent ER value is served — NOT the frozen base copy (base is armed null).
    expect(c).not.toBeNull();
    expect(c!.openSeq).toBe(2);
  });

  it("SINGLE-FLIGHT: concurrent reads of the same PDA share one ER request", async () => {
    let calls = 0;
    h.erGetAccountInfo.mockImplementation(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return { data: Buffer.alloc(53, 0xC) };
    });
    h.decode.mockImplementation((name: string) => (name === "liveCursor" ? cursorRaw(1) : undefined));

    const [a, b, c] = await Promise.all([
      readLiveCursor(REAL_WALLET), readLiveCursor(REAL_WALLET), readLiveCursor(REAL_WALLET),
    ]);

    expect(calls).toBe(1); // one RPC served all three concurrent readers
    expect([a, b, c].every((v) => v?.openSeq === 1)).toBe(true);
  });

  it("readPoolStandings falls back to base bytes when the ER is unreachable", async () => {
    h.getProgramAccounts.mockImplementation(async (_owner: unknown, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      return size === 159 ? [{ pubkey: pk("E1"), account: { data: Buffer.alloc(159, 0x1) } }] : [];
    });
    h.erGetMulti.mockRejectedValue(new Error("er down"));
    h.decode.mockImplementation((name: string) =>
      name === "liveEntry" ? entryRaw({ player: "P", basePts: 7, bonusPts: 0 }) : undefined,
    );

    const rows = await readPoolStandings(1);

    expect(rows.map((r) => r.total)).toEqual([7]); // base bytes used — no throw
  });

  // #7 — the just-resolved call, for the web's between-calls verdict flash.
  it("readLastResolvedCall derives seq = resolved_count-1 and returns that resolved call", async () => {
    const lastPda = deriveCallPda(PROGRAM_ID, poolPk, 2); // resolved_count 3 → seq 2
    h.erGetAccountInfo.mockImplementation(async (pda: any) => {
      if (pda.toBase58() === cursorPda.toBase58()) return { data: Buffer.alloc(53, 0xC) };
      if (pda.toBase58() === lastPda.toBase58()) return { data: Buffer.alloc(62, 0xB) };
      return null;
    });
    h.decode.mockImplementation((name: string) =>
      name === "liveCursor" ? cursorRaw(4294967295, 3) // nothing open, 3 resolved
        : name === "call" ? resolvedCallRaw(2, 0) : undefined,
    );

    const view = await readLastResolvedCall(REAL_WALLET);

    expect(view).not.toBeNull();
    expect(view!.seq).toBe(2);
    expect(view!.state).toBe("resolved");
    expect(view!.outcome).toBe(0);
  });

  it("readLastResolvedCall returns null when nothing has resolved yet (resolved_count 0)", async () => {
    h.erGetAccountInfo.mockResolvedValue({ data: Buffer.alloc(53, 0xC) });
    h.decode.mockImplementation((name: string) =>
      name === "liveCursor" ? cursorRaw(4294967295, 0) : undefined,
    );

    expect(await readLastResolvedCall(REAL_WALLET)).toBeNull();
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

  it("folds in the currently-open call + sorted standings (delegated-owner scans included)", async () => {
    // getProgramAccounts serves the pool scan (dataSize 176), the call scan (62),
    // and the standings entry scan (159). The call + entry scans are DUAL-OWNER
    // (our program + the Delegation Program) — serve rows only under the
    // delegation owner to prove mid-match reads work (stress-test F5).
    const seenOwners = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.getProgramAccounts.mockImplementation(async (owner: any, opts: any) => {
      seenOwners.add(owner.toBase58?.() ?? String(owner));
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      const delegated = owner.toBase58?.() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
      if (size === 176 && !delegated)
        return [{ pubkey: { toBase58: () => "POOL" }, account: { data: Buffer.alloc(176) } }];
      if (size === 62 && delegated)
        return [{ pubkey: { toBase58: () => "CALL" }, account: { data: Buffer.alloc(62) } }];
      if (size === 159 && delegated)
        return [
          { pubkey: { toBase58: () => "E_LOW" }, account: { data: Buffer.alloc(159, 1) } },
          { pubkey: { toBase58: () => "E_HIGH" }, account: { data: Buffer.alloc(159, 2) } },
        ];
      return [];
    });
    h.decode.mockImplementation((name: string, data?: any) => {
      if (name === "livePool") return poolRaw({ poolId: 303, fixtureId: 303 });
      if (name === "call") {
        return {
          pool: pk("POOL"), seq: 2, kind: { nextGoal: {} }, state: { open: {} },
          openedTs: bn(1750000100), answerSecs: 9, numOptions: 3, basePoints: [4, 1, 4],
          outcome: 0xff, bump: 5,
        };
      }
      if (name === "liveEntry") {
        return data?.[0] === 1
          ? entryRaw({ player: "PL", basePts: 3, bonusPts: 1 })   // total 4
          : entryRaw({ player: "PH", basePts: 10, bonusPts: 2 }); // total 12
      }
      return undefined;
    });
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool?fixtureId=303" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.openCall).not.toBeNull();
    expect(body.openCall.state).toBe("open");
    expect(body.openCall.seq).toBe(2);
    // standings sorted by total DESC — sourced ENTIRELY from delegated-owner rows.
    expect(body.standings.map((s: { total: number }) => s.total)).toEqual([12, 4]);
    // Both owners were scanned.
    expect(seenOwners.has("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh")).toBe(true);
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
  /** Serve entry rows from the dual-owner gPA scan (dataSize 159 → entry buffers). */
  function armEntryScan(rows: { key: string; basePts: number; bonusPts: number }[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.getProgramAccounts.mockImplementation(async (owner: any, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      // Rows live under the DELEGATION owner only — the mid-match state.
      if (size === 159 && owner.toBase58?.() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh") {
        return rows.map((r, i) => ({
          pubkey: { toBase58: () => r.key },
          account: { data: Buffer.alloc(159, i + 1) },
        }));
      }
      return [];
    });
    h.decode.mockImplementation((name: string, data?: any) => {
      if (name !== "liveEntry") return undefined;
      const r = rows[(data?.[0] ?? 1) - 1];
      return entryRaw({ player: `P${r.key}`, basePts: r.basePts, bonusPts: r.bonusPts });
    });
  }

  it("returns entries sorted by total desc — sourced from DELEGATED rows (mid-match)", async () => {
    armEntryScan([
      { key: "E_MID", basePts: 5, bonusPts: 0 },  // 5
      { key: "E_HIGH", basePts: 9, bonusPts: 3 }, // 12
      { key: "E_LOW", basePts: 1, bonusPts: 0 },  // 1
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
    h.getProgramAccounts.mockResolvedValue([]);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/pool/303/standings" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    await app.close();
  });

  it("scans BOTH owners with disc + runtime dataSize(159) + pool@40 filters", async () => {
    h.getProgramAccounts.mockResolvedValue([]);
    const app = buildServer(makeMockStore());
    await app.inject({ url: "/api/live/pool/303/standings" });
    // The entry scan ran under our program AND the Delegation Program.
    const entryScans = h.getProgramAccounts.mock.calls.filter((c: any[]) =>
      (c[1] as any).filters.some((f: any) => f.dataSize === 159),
    );
    expect(entryScans.length).toBe(2);
    const owners = entryScans.map((c: any[]) => (c[0] as any).toBase58());
    expect(owners).toContain("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
    for (const [, opts] of entryScans as any[]) {
      expect(opts.filters.some((f: any) => f.memcmp?.offset === 40)).toBe(true);
      expect(opts.filters.some((f: any) => f.memcmp?.offset === 0)).toBe(true);
    }
    await app.close();
  });

  it("502s when the standings read fails", async () => {
    h.getProgramAccounts.mockRejectedValue(new Error("rpc down"));
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

  it("returns 200 { entry: null } when no ticket exists at the derived PDA", async () => {
    h.getAccountInfo.mockResolvedValue(null);
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}&poolId=1` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entry: null });
    await app.close();
  });

  it("returns the wallet's entry (even DELEGATED mid-match) with amount as a string + total", async () => {
    h.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(159), owner: pk("DELeGG") });
    h.decode.mockImplementation((name: string) =>
      name === "liveEntry" ? entryRaw({ player: "WALLET", basePts: 12, bonusPts: 5 }) : undefined,
    );
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}&poolId=1` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entry).not.toBeNull();
    expect(typeof body.entry.amount).toBe("string");
    expect(body.entry.total).toBe(17);
    await app.close();
  });

  it("502s when the entry read fails (RPC error ≠ 'no ticket')", async () => {
    h.getAccountInfo.mockRejectedValue(new Error("rpc down"));
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: `/api/live/entry?wallet=${REAL_WALLET}&poolId=1` });
    expect(res.statusCode).toBe(502);
    await app.close();
  });
});

// ── /api/live/next — the featured-game picker (timer feature) ────────────────
//
// Priority: in-play pool (lockTs ≤ now < settleAfterTs) → joinable pool
// (now < lockTs) → soonest upcoming fixture (pool null) → nothing. Pools are
// status "open" only; the fixture branch reads the store. Date.now is spied so
// the fixed poolRaw lockTs (1750000000) / settleAfterTs (1750003600) bracket it.
describe("GET /api/live/next", () => {
  const LOCK = 1_750_000_000; // poolRaw's fixed lockTs (sec)

  /** Serve one open pool from the 176-byte scan. */
  function armOnePool() {
    h.getProgramAccounts.mockImplementation(async (_owner: any, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      return size === 176
        ? [{ pubkey: { toBase58: () => "POOL" }, account: { data: Buffer.alloc(176) } }]
        : [];
    });
    h.decode.mockImplementation((name: string) =>
      name === "livePool" ? poolRaw({ poolId: 1, fixtureId: 1, status: { open: {} } }) : undefined,
    );
  }

  it("features an IN-PLAY pool (lockTs ≤ now < settleAfterTs) with kickoff + joinOpensTs", async () => {
    armOnePool();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue((LOCK + 600) * 1000); // 10 min in
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/next" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pool.poolId).toBe(1);
    expect(body.kickoffMs).toBe(LOCK * 1000);        // falls back to lockTs (no board row)
    expect(body.joinOpensTs).toBe(LOCK - 45 * 60);   // kickoff − JOIN_AHEAD_MIN
    await app.close();
    nowSpy.mockRestore();
  });

  it("features a JOINABLE pool before lock (the countdown/join state)", async () => {
    armOnePool();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue((LOCK - 1200) * 1000); // T-20 min
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/live/next" });
    const body = res.json();
    expect(body.pool.poolId).toBe(1);
    expect(body.kickoffMs).toBe(LOCK * 1000);
    await app.close();
    nowSpy.mockRestore();
  });

  it("prefers the IN-PLAY pool over a joinable one (priority order)", async () => {
    // Two pools: fixture 1 in-play (lock LOCK), fixture 2 joinable (lock LOCK+7200).
    h.getProgramAccounts.mockImplementation(async (_owner: any, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      return size === 176
        ? [
            { pubkey: { toBase58: () => "P1" }, account: { data: Buffer.alloc(176, 1) } },
            { pubkey: { toBase58: () => "P2" }, account: { data: Buffer.alloc(176, 2) } },
          ]
        : [];
    });
    h.decode.mockImplementation((name: string, data?: any) => {
      if (name !== "livePool") return undefined;
      const second = data?.[0] === 2;
      const raw = poolRaw({ poolId: second ? 2 : 1, fixtureId: second ? 2 : 1, status: { open: {} } });
      if (second) { raw.lockTs = bn(LOCK + 7200); raw.settleAfterTs = bn(LOCK + 7200 + 3600); }
      return raw;
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue((LOCK + 600) * 1000);
    const app = buildServer(makeMockStore());
    const body = (await app.inject({ url: "/api/live/next" })).json();
    expect(body.pool.poolId).toBe(1); // the in-play one, not the later joinable one
    await app.close();
    nowSpy.mockRestore();
  });

  it("ignores non-open pools and falls to the soonest UPCOMING fixture (pool null)", async () => {
    h.getProgramAccounts.mockImplementation(async (_owner: any, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      return size === 176
        ? [{ pubkey: { toBase58: () => "P1" }, account: { data: Buffer.alloc(176) } }]
        : [];
    });
    h.decode.mockImplementation((name: string) =>
      name === "livePool" ? poolRaw({ poolId: 1, fixtureId: 1, status: { settled: {} } }) : undefined,
    );
    const KICK = (LOCK + 9000) * 1000;
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 7, home: "England", away: "Brazil", kickoffMs: KICK + 3_600_000, status: "upcoming" as const, minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
        { fixtureId: 8, home: "Spain", away: "France", kickoffMs: KICK, status: "upcoming" as const, minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
        { fixtureId: 9, home: "Ghana", away: "Peru", kickoffMs: KICK - 9_999_000, status: "ft" as const, minute: null, phase: null, scoreH: 1, scoreA: 0, corners: 0, goals: 1, yellows: 0 },
      ]),
    } as any);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(LOCK * 1000);
    const app = buildServer(store);
    const body = (await app.inject({ url: "/api/live/next" })).json();
    expect(body.pool).toBeNull();
    expect(body.match.fixtureId).toBe(8); // soonest upcoming (Spain–France), not ft/later
    expect(body.kickoffMs).toBe(KICK);
    expect(body.joinOpensTs).toBe(Math.floor(KICK / 1000) - 45 * 60);
    await app.close();
    nowSpy.mockRestore();
  });

  it("returns the all-null body when nothing is scheduled anywhere", async () => {
    h.getProgramAccounts.mockResolvedValue([]);
    const app = buildServer(makeMockStore());
    const body = (await app.inject({ url: "/api/live/next" })).json();
    expect(body).toMatchObject({ pool: null, match: null, kickoffMs: null, joinOpensTs: null });
    await app.close();
  });

  // TEST-match audience split: the main tab NEVER features a synthetic fixture;
  // /test (?test=1) features ONLY them (fixtureId ≥ TEST_FIXTURE_MIN = 9.9e9).
  it("EXCLUDES a test pool from the main tab (falls to the real upcoming fixture)", async () => {
    h.getProgramAccounts.mockImplementation(async (_owner: any, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      return size === 176
        ? [{ pubkey: { toBase58: () => "TP" }, account: { data: Buffer.alloc(176) } }]
        : [];
    });
    h.decode.mockImplementation((name: string) => {
      if (name !== "livePool") return undefined;
      const raw = poolRaw({ poolId: 1, fixtureId: 1, status: { open: {} } });
      raw.fixtureId = bn(9_900_000_777); // a test fixture
      return raw;
    });
    const KICK = (LOCK + 9000) * 1000;
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 8, home: "Spain", away: "France", kickoffMs: KICK, status: "upcoming" as const, minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
      ]),
    } as any);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue((LOCK - 60) * 1000); // test pool joinable — but hidden
    const app = buildServer(store);
    const body = (await app.inject({ url: "/api/live/next" })).json();
    expect(body.pool).toBeNull();
    expect(body.match.fixtureId).toBe(8); // the REAL fixture, not the test pool
    await app.close();
    nowSpy.mockRestore();
  });

  it("?test=1 features ONLY the test pool and never falls to real fixtures", async () => {
    h.getProgramAccounts.mockImplementation(async (_owner: any, opts: any) => {
      const size = opts.filters.find((f: any) => f.dataSize)?.dataSize;
      return size === 176
        ? [{ pubkey: { toBase58: () => "TP" }, account: { data: Buffer.alloc(176) } }]
        : [];
    });
    h.decode.mockImplementation((name: string) => {
      if (name !== "livePool") return undefined;
      const raw = poolRaw({ poolId: 1, fixtureId: 1, status: { open: {} } });
      raw.fixtureId = bn(9_900_000_777);
      return raw;
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue((LOCK - 60) * 1000);
    const app = buildServer(makeMockStore());
    const body = (await app.inject({ url: "/api/live/next?test=1" })).json();
    expect(body.pool.fixtureId).toBe(9_900_000_777);
    await app.close();
    nowSpy.mockRestore();

    // …and with NO test pool, ?test=1 is all-null even when real fixtures exist.
    h.getProgramAccounts.mockResolvedValue([]);
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 8, home: "Spain", away: "France", kickoffMs: 1, status: "upcoming" as const, minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
      ]),
    } as any);
    const app2 = buildServer(store);
    const body2 = (await app2.inject({ url: "/api/live/next?test=1" })).json();
    expect(body2).toMatchObject({ pool: null, match: null });
    await app2.close();
  });
});
