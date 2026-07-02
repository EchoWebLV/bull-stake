import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";

// Mock the Anchor layer so we can drive readLineMarkets / readLinePosition
// without a live RPC — the same seams chain.contest.test.ts exposes for
// readLiveContests (raw `getProgramAccounts` + per-call-driven `coder.decode`),
// plus the two the line readers need:
//   - `account.market.size`: the runtime Market account size, used BOTH for
//     the RPC dataSize filter and the per-item wrong-size guard. The guard is
//     what keeps orphaned old-layout Market accounts (ids 0-7 still live on
//     devnet) out of the result — stale layouts can borsh-decode into the
//     current struct as GARBAGE rather than throwing, so a decode try/catch
//     alone does NOT skip them (the same failure mode readLiveContests pins).
//   - `account.position.fetchNullable`: the scoped Position read.
const h = vi.hoisted(() => ({
  marketSize: 201, // 8 disc + Market INIT_SPACE; only equality vs data.length matters here
  getProgramAccounts: vi.fn(async (_programId: unknown, _opts?: unknown) => [] as unknown[]),
  decode: vi.fn((_name: string, _data: unknown): unknown => undefined),
  memcmp: vi.fn((_name?: string) => ({ offset: 0, bytes: "d9UCMmqzRPV" })),
  positionFetchNullable: vi.fn(),
}));

vi.mock("@coral-xyz/anchor", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  // markets.ts (imported transitively by chain.ts) reads `anchorDefault.BN` at
  // module load, so the mock must expose a `default` carrying a BN stand-in.
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
      provider = { connection: { getProgramAccounts: h.getProgramAccounts } };
      coder = { accounts: { decode: h.decode, memcmp: h.memcmp } };
      account = {
        market: { size: h.marketSize },
        position: { fetchNullable: h.positionFetchNullable },
      };
      constructor(_idl: unknown, _provider: unknown) {}
    },
  };
});

import { readLineMarkets, readLinePosition, deriveMarketPda, derivePositionPda } from "../src/chain.ts";
import { LINE_CLOSE_MARKET_ID } from "../src/markets.ts";

const PROGRAM = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");
const WALLET = "So11111111111111111111111111111111111111112";
const SIZE = h.marketSize;

beforeEach(() => {
  vi.clearAllMocks();
  // Re-arm the memcmp default (cleared above) so discovery can build its filter.
  h.memcmp.mockReturnValue({ offset: 0, bytes: "d9UCMmqzRPV" });
});

// Helper: a fake BN-ish value (toString + toNumber) as on-chain accounts present.
function bn(n: number | string) {
  return { toString: () => String(n), toNumber: () => Number(n) };
}

// Build a decoded Market account object (what `coder.accounts.decode` returns).
function marketAcct(over: Record<string, unknown> = {}) {
  return {
    marketId: LINE_CLOSE_MARKET_ID,
    fixtureId: bn(17952170),
    status: { open: {} },
    statKey: 1,
    threshold: 54407,
    entryCloseTs: bn(1_760_000_000),
    bucketTotals: [bn(3_000_000), bn(1_000_000), bn(0)],
    totalPool: bn(4_000_000),
    winningBucket: null,
    settledValue: 0,
    settledTs: bn(0),
    ...over,
  };
}

// ── readLineMarkets (LINE_CLOSE discovery w/ per-account tolerance) ──────────

describe("readLineMarkets — keeps only decodable, correctly-sized market_id-90 accounts", () => {
  it("skips non-line / undecodable / wrong-size accounts; maps the survivor's fields", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "LM" }, account: { data: Buffer.alloc(SIZE) } },      // valid line market
      { pubkey: { toBase58: () => "OTHER" }, account: { data: Buffer.alloc(SIZE) } },   // valid, but marketId 11
      { pubkey: { toBase58: () => "BAD" }, account: { data: Buffer.alloc(SIZE) } },     // decode throws
      { pubkey: { toBase58: () => "ORPHAN" }, account: { data: Buffer.alloc(128) } },   // wrong size: old layout
    ]);
    // Decode is driven by call order for the three accounts that REACH it: the
    // ORPHAN never does — if it did, decode's default returns garbage (not a
    // throw), which the outer try/catch would NOT skip per-item.
    h.decode
      .mockReturnValueOnce(marketAcct())
      .mockReturnValueOnce(marketAcct({ marketId: 11 }))
      .mockImplementationOnce(() => {
        throw new Error("Invalid account discriminator");
      });

    const out = await readLineMarkets();

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      pubkey: "LM",
      fixtureId: 17952170,
      status: "open",
      favSide: 1,                                // statKey 1 → home favourite
      openMilli: 54407,                          // threshold field
      entryCloseTs: 1_760_000_000,
      bucketTotals: ["3000000", "1000000"],      // [Above, Below]
      totalPool: "4000000",
      winningBucket: null,
      settledValueMilli: 0,
      settledTs: 0,
    });
    // decode is reached ONLY for the correctly-sized accounts, never the orphan.
    expect(h.decode).toHaveBeenCalledTimes(3);
  });

  it("requests the Market discriminator + exact dataSize filters", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readLineMarkets();

    const opts = h.getProgramAccounts.mock.calls[0][1] as {
      filters: { memcmp?: { offset: number; bytes: string }; dataSize?: number }[];
    };
    expect(opts.filters[0].memcmp).toEqual({ offset: 0, bytes: "d9UCMmqzRPV" });
    expect(opts.filters.some((f) => f.dataSize === SIZE)).toBe(true);
  });

  it("settled market → favSide 2 from statKey, closing line from settledValue", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "LM" }, account: { data: Buffer.alloc(SIZE) } },
    ]);
    h.decode.mockReturnValueOnce(marketAcct({
      status: { settled: {} },
      statKey: 2,
      winningBucket: 1,
      settledValue: 53910,
      settledTs: bn(1_760_010_000),
    }));

    const [m] = await readLineMarkets();

    expect(m).toMatchObject({
      status: "settled",
      favSide: 2,
      winningBucket: 1,
      settledValueMilli: 53910,
      settledTs: 1_760_010_000,
    });
  });

  it("total RPC failure → [] (route degrades gracefully, no throw)", async () => {
    h.getProgramAccounts.mockRejectedValue(new Error("connection refused"));

    expect(await readLineMarkets()).toEqual([]);
  });
});

// ── readLinePosition (scoped [Above, Below] stakes for one wallet) ───────────

describe("readLinePosition — wallet stakes on a fixture's line market", () => {
  it("no position account → null", async () => {
    h.positionFetchNullable.mockResolvedValue(null);

    expect(await readLinePosition(17952170, WALLET)).toBeNull();
  });

  it("present → [Above, Below] lamport strings, read at the fixture's line-market position PDA", async () => {
    h.positionFetchNullable.mockResolvedValue({
      bettor: {},
      amounts: [bn(5_000_000), bn(250_000), bn(0)],
      bump: 254,
    });

    const pos = await readLinePosition(17952170, WALLET);

    expect(pos).toEqual(["5000000", "250000"]);
    // Reads the Position PDA derived from THIS fixture's LINE_CLOSE (90) market.
    const expected = derivePositionPda(
      PROGRAM, deriveMarketPda(PROGRAM, 17952170, LINE_CLOSE_MARKET_ID), new PublicKey(WALLET),
    );
    expect((h.positionFetchNullable.mock.calls[0][0] as PublicKey).toBase58()).toBe(expected.toBase58());
  });

  it("RPC failure → null (never throws into a route)", async () => {
    h.positionFetchNullable.mockRejectedValue(new Error("503 Service Unavailable"));

    expect(await readLinePosition(17952170, WALLET)).toBeNull();
  });
});
