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
        liveCursor: { size: 53 },
        liveEntry: { size: 159, all: vi.fn(async () => [] as unknown[]) },
      };
      constructor(_idl: unknown, _provider: unknown) {}
    },
  };
});

import { readLivePools, readCall } from "../src/chain.ts";

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
