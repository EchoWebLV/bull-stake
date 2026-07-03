import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anchor layer so we can drive `readJackpot` / `readLiveContests`
// without a live RPC. The mock mirrors Anchor's real account-client contract:
//   - `.fetch(pda)`         throws "Account does not exist…" for a missing account
//   - `.fetchNullable(pda)` resolves to `null` for a missing account, but still
//                           rejects on a genuine RPC/network failure.
//
// Multi-contest discovery does NOT use `account.contest.all()` (that fetches +
// decodes every account internally and rejects the WHOLE call if any single one
// fails to decode — a stale v1 contest shares the 8-byte "Contest" discriminator
// but has a different byte layout, so `.all()` would throw and hide everything).
// Instead the reader fetches raw accounts via `connection.getProgramAccounts` and
// decodes each one individually with `program.coder.accounts.decode("contest", …)`
// inside a per-account try/catch. The mock therefore exposes those two seams:
//   - `getProgramAccounts` returns raw { pubkey, account: { data } } stand-ins
//   - `coder.accounts.decode` is driven per-call so ONE item can throw while the
//     others decode → the undecodable (stale v1) account is skipped, not fatal.
//
// Pre-launch the jackpot singleton is absent, so `readJackpot` must degrade to a
// pot "0" sentinel rather than throwing (which the route maps to a 502).
const h = vi.hoisted(() => ({
  jackpotFetchNullable: vi.fn(),
  contestFetch: vi.fn(),
  contestAll: vi.fn(async () => [] as unknown[]),
  entryAll: vi.fn(async () => [] as unknown[]),
  getBalance: vi.fn(async () => 0),
  getMin: vi.fn(async () => 0),
  getProgramAccounts: vi.fn(async (_programId: unknown, _opts?: unknown) => [] as unknown[]),
  decode: vi.fn((_name: string, _data: unknown): unknown => undefined),
  memcmp: vi.fn((_name?: string) => ({ offset: 0, bytes: "d9UCMmqzRPV" })),
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
      provider = {
        connection: {
          getBalance: h.getBalance,
          getMinimumBalanceForRentExemption: h.getMin,
          getProgramAccounts: h.getProgramAccounts,
        },
      };
      coder = { accounts: { decode: h.decode, memcmp: h.memcmp } };
      account = {
        jackpot: { fetchNullable: h.jackpotFetchNullable },
        contest: { fetch: h.contestFetch, all: h.contestAll, size: 217 },
        entry: { all: h.entryAll },
      };
      constructor(_idl: unknown, _provider: unknown) {}
    },
  };
});

import { readJackpot, readLiveContests, listEntriesForWallet, entryOutcome } from "../src/chain.ts";
import type { ContestView } from "../src/chain.ts";

beforeEach(() => {
  vi.clearAllMocks();
  // Re-arm the memcmp default (cleared above) so discovery can build its filter.
  h.memcmp.mockReturnValue({ offset: 0, bytes: "d9UCMmqzRPV" });
});

// Helper: a fake BN-ish value (toString + toNumber) as on-chain accounts present.
function bn(n: number | string) {
  return { toString: () => String(n), toNumber: () => Number(n) };
}

// Build a decoded v2 Contest account object (what `coder.accounts.decode` returns).
function contestAcct(over: Record<string, unknown> = {}) {
  return {
    contestId: bn(7),
    settleAuthority: { toBase58: () => "K" },
    feeRecipient: { toBase58: () => "F" },
    fixtures: [bn(100), bn(100), bn(100), bn(100), bn(0), bn(0)],
    marketIds: [16, 15, 12, 11, 0, 0],
    numLegs: 4,
    entryPrice: bn(100),
    lockTs: bn(0),
    legLockTs: [bn(0), bn(0), bn(0), bn(0), bn(0), bn(0)],
    entriesCloseTs: bn(0),
    settleAfterTs: bn(0),
    feeBps: 500,
    status: { open: {} },
    winningBuckets: [0, 0, 0, 0, 0, 0],
    entryCount: bn(0),
    perfectCount: bn(0),
    perfectWeight: bn(0),
    distributable: bn(0),
    claimedCount: bn(0),
    claimedTotal: bn(0),
    settledTs: bn(0),
    bump: 255,
    ...over,
  };
}

// ── entryOutcome (pure mirror of claim_contest.rs) ──────────────────────────

describe("entryOutcome — mirrors claim_contest.rs payout math", () => {
  // Base settled contest: 3 legs, winning [0,1,2], 2 perfect winners,
  // distributable 1000 lamports → share = floor(1000/2) = 500.
  const settled: ContestView = {
    pubkey: "C", contestId: 1, settleAuthority: "K", feeRecipient: "F",
    fixtures: [10, 11, 12], marketIds: [16, 15, 12], numLegs: 3,
    legs: [], entryPrice: "100",
    lockTs: 0, legLockTs: [0, 0, 0], entriesCloseTs: 0,
    settleAfterTs: 0, feeBps: 500, status: "settled",
    winningBuckets: [0, 1, 2], entryCount: 5, perfectCount: 2, perfectWeight: "0",
    pot: "1050", distributable: "1000", claimedCount: 0, claimedTotal: "0",
    settledTs: 0,
  };

  it("perfect ticket → won + claimable, payout = floor(distributable/perfect_count)", () => {
    const o = entryOutcome([0, 1, 2, 0, 0], 100n, settled);
    expect(o).toEqual({ won: true, claimable: true, payout: 500n });
  });

  it("ignores pick tail beyond numLegs", () => {
    // last two picks differ but only first 3 are carded
    const o = entryOutcome([0, 1, 2, 2, 2], 100n, settled);
    expect(o.won).toBe(true);
    expect(o.payout).toBe(500n);
  });

  it("non-perfect ticket → not won, not claimable, payout 0", () => {
    const o = entryOutcome([0, 1, 1, 0, 0], 100n, settled);
    expect(o).toEqual({ won: false, claimable: false, payout: 0n });
  });

  it("perfect but all winners already claimed (claimed_count == perfect_count) → won, not claimable, payout 0", () => {
    const exhausted = { ...settled, claimedCount: 2, claimedTotal: "1000" };
    const o = entryOutcome([0, 1, 2, 0, 0], 100n, exhausted);
    expect(o.won).toBe(true);
    expect(o.claimable).toBe(false);
    // A blocked claim reverts on-chain (transfers nothing), so payout is 0 — not the share.
    expect(o.payout).toBe(0n);
  });

  it("perfect but claimed_total + share would exceed distributable → won, not claimable, payout 0", () => {
    // claimedTotal 600, share 500 → 1100 > 1000 distributable → cap blocks
    const near = { ...settled, claimedCount: 1, claimedTotal: "600" };
    const o = entryOutcome([0, 1, 2, 0, 0], 100n, near);
    expect(o.claimable).toBe(false);
    expect(o.payout).toBe(0n);
  });

  it("floor division leaves dust: distributable 1001 / 2 → share 500 (dust 1 stays)", () => {
    const dusty = { ...settled, distributable: "1001" };
    const o = entryOutcome([0, 1, 2, 0, 0], 100n, dusty);
    expect(o.payout).toBe(500n);
  });

  it("voided contest → every ticket refunds its own stake, regardless of picks", () => {
    const voided: ContestView = { ...settled, status: "voided" };
    expect(entryOutcome([2, 2, 2, 0, 0], 100n, voided)).toEqual({ won: false, claimable: true, payout: 100n });
    expect(entryOutcome([0, 1, 2, 0, 0], 100n, voided)).toEqual({ won: false, claimable: true, payout: 100n });
  });

  it("rolledOver contest → nothing payable even for a matching ticket", () => {
    const rolled: ContestView = { ...settled, status: "rolledOver", perfectCount: 0, distributable: "0" };
    expect(entryOutcome([0, 1, 2, 0, 0], 100n, rolled)).toEqual({ won: false, claimable: false, payout: 0n });
  });

  it("open contest → nothing payable", () => {
    const open: ContestView = { ...settled, status: "open" };
    expect(entryOutcome([0, 1, 2, 0, 0], 100n, open)).toEqual({ won: false, claimable: false, payout: 0n });
  });

  it("share of 0 (distributable < perfect_count) → won but not claimable", () => {
    const tiny = { ...settled, distributable: "1", perfectCount: 2 };
    const o = entryOutcome([0, 1, 2, 0, 0], 100n, tiny);
    expect(o.won).toBe(true);
    expect(o.payout).toBe(0n);
    expect(o.claimable).toBe(false);
  });
});

// ── readJackpot (pot = balance − rentFloor; pre-launch sentinel) ─────────────

describe("readJackpot — Jackpot PDA pot accounting", () => {
  it("present → pot = balance − rentFloor", async () => {
    h.jackpotFetchNullable.mockResolvedValue({ bump: 255 });
    h.getBalance.mockResolvedValue(5_000_000);
    h.getMin.mockResolvedValue(900_000); // rent floor for 8+1 bytes

    const j = await readJackpot();

    expect(j.lamports).toBe("5000000");
    expect(j.rentFloor).toBe("900000");
    expect(j.pot).toBe("4100000");
  });

  it("balance below rent floor → pot clamps at 0 (never negative)", async () => {
    h.jackpotFetchNullable.mockResolvedValue({ bump: 255 });
    h.getBalance.mockResolvedValue(800_000);
    h.getMin.mockResolvedValue(900_000);

    const j = await readJackpot();

    expect(j.pot).toBe("0");
  });

  it("absent (pre-launch) → { pot: '0' } sentinel, no balance lookups", async () => {
    h.jackpotFetchNullable.mockResolvedValue(null);

    const j = await readJackpot();

    expect(j).toEqual({ lamports: "0", rentFloor: "0", pot: "0" });
    expect(h.getBalance).not.toHaveBeenCalled();
  });

  it("genuine RPC error still rejects (so the route can 502)", async () => {
    h.jackpotFetchNullable.mockRejectedValue(new Error("failed to get account info: 503 Service Unavailable"));

    await expect(readJackpot()).rejects.toThrow(/503/);
  });
});

// ── readLiveContests (multi-contest discovery w/ per-account tolerance) ──────

describe("readLiveContests — discovery skips undecodable stale v1 accounts", () => {
  it("returns the two decodable Open contests, skips the one that throws on decode", async () => {
    // Three raw accounts come back from getProgramAccounts; the middle one is a
    // stale v1 contest whose bytes fail to decode under the v2 layout.
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "CA" }, account: { data: Buffer.alloc(217) } },
      { pubkey: { toBase58: () => "CBAD" }, account: { data: Buffer.alloc(217) } },
      { pubkey: { toBase58: () => "CB" }, account: { data: Buffer.alloc(217) } },
    ]);
    // Decode is driven by call order: 1st ok, 2nd throws (stale v1), 3rd ok.
    h.decode
      .mockReturnValueOnce(contestAcct({ contestId: bn(1) }))
      .mockImplementationOnce(() => {
        throw new Error("Invalid account discriminator");
      })
      .mockReturnValueOnce(contestAcct({ contestId: bn(2) }));
    // Each surviving contest reads its own pot via getBalance.
    h.getBalance.mockResolvedValue(2_000_000);
    h.getMin.mockResolvedValue(1_400_000); // contest rent floor

    const contests = await readLiveContests();

    expect(contests).toHaveLength(2);
    expect(contests.map((c) => c.contestId).sort()).toEqual([1, 2]);
    // The good contests carry their per-account pot (2_000_000 − 1_400_000).
    expect(contests[0].pot).toBe("600000");
    // The stale account never makes it into the result.
    expect(contests.find((c) => c.pubkey === "CBAD")).toBeUndefined();
  });

  it("skips a same-discriminator orphan contest of the wrong SIZE (decodes to garbage, not a throw)", async () => {
    // The real failure mode the devnet deploy surfaced: an orphaned older Contest shares
    // the "Contest" discriminator and its body borsh-DECODES into the current v2 struct
    // as GARBAGE rather than throwing — so a decode try/catch does NOT skip it. The
    // size guard must exclude it BEFORE decode is ever reached. Here the orphan is the
    // prior 5-leg layout (207 bytes) vs the current 6-leg 217.
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "V2" }, account: { data: Buffer.alloc(217) } },        // good v2 (correct size)
      { pubkey: { toBase58: () => "ORPHAN" }, account: { data: Buffer.alloc(207) } },    // stale 5-leg (wrong size)
    ]);
    h.decode.mockReturnValue(contestAcct({ contestId: bn(7) })); // would return data even for the v1 bytes
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);

    const contests = await readLiveContests();

    expect(contests).toHaveLength(1);
    expect(contests[0].contestId).toBe(7);
    expect(contests.find((c) => c.pubkey === "ORPHAN")).toBeUndefined();
    // decode is reached ONLY for the correctly-sized v2 account, never for the orphan.
    expect(h.decode).toHaveBeenCalledTimes(1);
  });

  it("requests a dataSize filter for the exact v2 Contest size (217)", async () => {
    h.getProgramAccounts.mockResolvedValue([]);
    await readLiveContests();
    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { dataSize?: number }[] };
    expect(opts.filters.some((f) => f.dataSize === 217)).toBe(true);
  });

  it("filters discovery by the v2 Contest discriminator (offset 0)", async () => {
    h.getProgramAccounts.mockResolvedValue([]);

    await readLiveContests();

    expect(h.getProgramAccounts).toHaveBeenCalledTimes(1);
    const opts = h.getProgramAccounts.mock.calls[0][1] as { filters: { memcmp: { offset: number; bytes: string } }[] };
    expect(opts.filters[0].memcmp.offset).toBe(0);
    expect(opts.filters[0].memcmp.bytes).toBe("d9UCMmqzRPV");
  });

  it("total RPC failure during discovery → [] (no live contests, no throw)", async () => {
    h.getProgramAccounts.mockRejectedValue(new Error("connection refused"));

    expect(await readLiveContests()).toEqual([]);
  });

  it("maps per-leg legs joined from the market catalog", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "CA" }, account: { data: Buffer.alloc(217) } },
    ]);
    // Settled contest, markets [16,15,12,11], winning buckets [0,1,2,0].
    h.decode.mockReturnValueOnce(contestAcct({
      status: { settled: {} },
      marketIds: [16, 15, 12, 11, 0, 0],
      fixtures: [bn(100), bn(100), bn(100), bn(100), bn(0), bn(0)],
      winningBuckets: [0, 1, 2, 0, 0, 0],
      numLegs: 4,
    }));
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);

    const [c] = await readLiveContests();

    expect(c.legs).toHaveLength(4);
    expect(c.legs[0]).toMatchObject({ marketId: 16, label: "1st-Half Result", group: "result", numBuckets: 3, fixtureId: 100, winningBucket: 0 });
    expect(c.legs[1]).toMatchObject({ marketId: 15, label: "1st-Half Goals O/U 0.5", group: "goals", winningBucket: 1 });
    expect(c.legs[2]).toMatchObject({ marketId: 12, label: "Match Result", group: "result", numBuckets: 3, winningBucket: 2 });
    expect(c.legs[3]).toMatchObject({ marketId: 11, label: "Total Goals O/U 2.5", winningBucket: 0 });
  });

  it("open (unsettled) contest → each leg's winningBucket is null", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "CA" }, account: { data: Buffer.alloc(217) } },
    ]);
    h.decode.mockReturnValueOnce(contestAcct()); // status open by default
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);

    const [c] = await readLiveContests();

    expect(c.legs.every((l) => l.winningBucket === null)).toBe(true);
  });

  it("contest view carries pearly fields (legLockTs, entriesCloseTs, perfectWeight)", async () => {
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => "CA" }, account: { data: Buffer.alloc(217) } },
    ]);
    h.decode.mockReturnValueOnce(contestAcct({
      numLegs: 6,
      legLockTs: [bn(1000), bn(2000), bn(3000), bn(4000), bn(5000), bn(6000)],
      entriesCloseTs: bn(4000),
      perfectWeight: bn(0),
    }));
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);

    const [view] = await readLiveContests();

    expect(view.legLockTs).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect(view.entriesCloseTs).toBe(4000);
    expect(view.perfectWeight).toBe("0");
  });
});

// ── listEntriesForWallet enrichment (settled contest, multi-contest) ─────────

describe("listEntriesForWallet — enriches entries with won/claimable/payout", () => {
  it("scores a winner and a loser against a single scoped settled contest", async () => {
    // Discovery returns one settled contest (3 legs, winning [0,1,2], perfect 1, distributable 1000).
    // pubkey must be valid base58 — entriesForContest does `new PublicKey(contest.pubkey)`.
    const PA = "4NLurQabdod5ZprpqC95Xfo757emqkrTjdtRaraxf5Dn";
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => PA }, account: { data: Buffer.alloc(217) } },
    ]);
    h.decode.mockReturnValue(contestAcct({
      contestId: bn(7),
      status: { settled: {} },
      fixtures: [bn(10), bn(11), bn(12), bn(0), bn(0), bn(0)],
      marketIds: [16, 15, 12, 0, 0, 0],
      numLegs: 3,
      winningBuckets: [0, 1, 2, 0, 0, 0],
      entryCount: bn(2),
      perfectCount: bn(1),
      distributable: bn(1000),
    }));
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);
    h.entryAll.mockResolvedValue([
      { publicKey: { toBase58: () => "E1" }, account: { nonce: bn(0), picks: [0, 1, 2, 0, 0], amount: bn(100), bump: 1 } },
      { publicKey: { toBase58: () => "E2" }, account: { nonce: bn(1), picks: [2, 2, 2, 0, 0], amount: bn(100), bump: 1 } },
    ]);

    const entries = await listEntriesForWallet("So11111111111111111111111111111111111111112");

    expect(entries).toHaveLength(2);
    const winner = entries.find((e) => e.nonce === 0)!;
    const loser = entries.find((e) => e.nonce === 1)!;
    expect(winner).toMatchObject({ won: true, claimable: true, payout: "1000", contestId: 7 });
    expect(loser).toMatchObject({ won: false, claimable: false, payout: "0", contestId: 7 });
  });

  it("aggregates entries across multiple live contests, tagging each with its contestId", async () => {
    // Discovery pubkeys must be valid base58 (entriesForContest does `new PublicKey(pubkey)`).
    const PA = "4NLurQabdod5ZprpqC95Xfo757emqkrTjdtRaraxf5Dn";
    const PB = "CYDxTZVogVUscoWr6Fftz6M6ubnCo98PQDBn2Uo3AquM";
    h.getProgramAccounts.mockResolvedValue([
      { pubkey: { toBase58: () => PA }, account: { data: Buffer.alloc(217) } },
      { pubkey: { toBase58: () => PB }, account: { data: Buffer.alloc(217) } },
    ]);
    h.decode
      .mockReturnValueOnce(contestAcct({ contestId: bn(7), status: { open: {} } }))
      .mockReturnValueOnce(contestAcct({ contestId: bn(9), status: { open: {} } }));
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);
    // entry.all is called once per contest; return one entry per contest.
    h.entryAll
      .mockResolvedValueOnce([
        { publicKey: { toBase58: () => "E1" }, account: { nonce: bn(0), picks: [0, 0, 0, 0, 0], amount: bn(100), bump: 1 } },
      ])
      .mockResolvedValueOnce([
        { publicKey: { toBase58: () => "E2" }, account: { nonce: bn(0), picks: [1, 1, 1, 1, 0], amount: bn(100), bump: 1 } },
      ]);

    const entries = await listEntriesForWallet("So11111111111111111111111111111111111111112");

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.contestId).sort()).toEqual([7, 9]);
  });

  it("contestId given → scopes to that contest only (single getProgramAccounts skip, direct fetch)", async () => {
    // When scoped, the reader fetches the single contest directly (no discovery scan).
    h.contestFetch.mockResolvedValue(contestAcct({
      contestId: bn(7),
      status: { settled: {} },
      numLegs: 3,
      marketIds: [16, 15, 12, 0, 0, 0],
      winningBuckets: [0, 1, 2, 0, 0, 0],
      perfectCount: bn(1),
      distributable: bn(1000),
    }));
    h.getBalance.mockResolvedValue(0);
    h.getMin.mockResolvedValue(0);
    h.entryAll.mockResolvedValue([
      { publicKey: { toBase58: () => "E1" }, account: { nonce: bn(0), picks: [0, 1, 2, 0, 0], amount: bn(100), bump: 1 } },
    ]);

    const entries = await listEntriesForWallet("So11111111111111111111111111111111111111112", 7);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ won: true, contestId: 7 });
    // Scoped path goes straight to contest.fetch, not the discovery scan.
    expect(h.getProgramAccounts).not.toHaveBeenCalled();
    expect(h.contestFetch).toHaveBeenCalledTimes(1);
  });
});
