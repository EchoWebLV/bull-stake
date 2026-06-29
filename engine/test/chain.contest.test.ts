import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Anchor layer so we can drive `readJackpotVault` / `readActiveContest`
// without a live RPC. The mock mirrors Anchor's real account-client contract:
//   - `.fetch(pda)`         throws "Account does not exist…" for a missing account
//   - `.fetchNullable(pda)` resolves to `null` for a missing account, but still
//                           rejects on a genuine RPC/network failure.
// Pre-launch the jackpot_vault singleton is absent, so the readers must degrade
// to the paused sentinel rather than throwing (which the route maps to a 502).
const h = vi.hoisted(() => ({
  vaultFetch: vi.fn(async () => {
    throw new Error("Account does not exist or has no data 11111111111111111111111111111111");
  }),
  vaultFetchNullable: vi.fn(),
  contestFetch: vi.fn(),
  entryAll: vi.fn(async () => [] as unknown[]),
  getBalance: vi.fn(async () => 0),
  getMin: vi.fn(async () => 0),
}));

vi.mock("@coral-xyz/anchor", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  return {
    AnchorProvider: class {
      connection: unknown;
      constructor(connection: unknown) {
        this.connection = connection;
      }
    },
    Program: class {
      programId = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");
      provider = {
        connection: { getBalance: h.getBalance, getMinimumBalanceForRentExemption: h.getMin },
      };
      account = {
        jackpotVault: { fetch: h.vaultFetch, fetchNullable: h.vaultFetchNullable },
        contest: { fetch: h.contestFetch },
        entry: { all: h.entryAll },
      };
      constructor(_idl: unknown, _provider: unknown) {}
    },
  };
});

import { readJackpotVault, readActiveContest, listEntriesForWallet, entryOutcome } from "../src/chain.ts";
import type { ContestView } from "../src/chain.ts";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── entryOutcome (pure mirror of claim_contest.rs) ──────────────────────────

describe("entryOutcome — mirrors claim_contest.rs payout math", () => {
  // Base settled contest: 3 matches, winning [0,1,2], 2 perfect winners,
  // distributable 1000 lamports → share = floor(1000/2) = 500.
  const settled: ContestView = {
    pubkey: "C", contestId: 1, settleAuthority: "K", feeRecipient: "F",
    fixtures: [10, 11, 12], numMatches: 3, entryPrice: "100",
    lockTs: 0, settleAfterTs: 0, feeBps: 500, status: "settled",
    winningBuckets: [0, 1, 2], entryCount: 5, perfectCount: 2,
    potSnapshot: "1050", distributable: "1000", claimedCount: 0, claimedTotal: "0",
    settledTs: 0,
  };

  it("perfect ticket → won + claimable, payout = floor(distributable/perfect_count)", () => {
    const o = entryOutcome([0, 1, 2, 0, 0], 100n, settled);
    expect(o).toEqual({ won: true, claimable: true, payout: 500n });
  });

  it("ignores pick tail beyond numMatches", () => {
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

// ── listEntriesForWallet enrichment (settled contest) ───────────────────────

describe("listEntriesForWallet — enriches entries with won/claimable/payout", () => {
  function bn(n: number | string) {
    return { toString: () => String(n), toNumber: () => Number(n) };
  }

  it("scores a winner and a loser against a settled contest", async () => {
    // Vault points at contest 7.
    h.vaultFetchNullable.mockResolvedValue({ activeContestId: bn(7), reserved: bn(0), bump: 1 });
    // Settled contest: 3 matches, winning [0,1,2], perfect_count 1, distributable 1000.
    h.contestFetch.mockResolvedValue({
      contestId: bn(7), settleAuthority: { toBase58: () => "K" }, feeRecipient: { toBase58: () => "F" },
      fixtures: [bn(10), bn(11), bn(12), bn(0), bn(0)], numMatches: 3, entryPrice: bn(100),
      lockTs: bn(0), settleAfterTs: bn(0), feeBps: 500, status: { settled: {} },
      winningBuckets: [0, 1, 2, 0, 0], entryCount: bn(2), perfectCount: bn(1),
      potSnapshot: bn(1050), distributable: bn(1000), claimedCount: bn(0), claimedTotal: bn(0),
      settledTs: bn(0),
    });
    h.entryAll.mockResolvedValue([
      { publicKey: { toBase58: () => "E1" }, account: { nonce: bn(0), picks: [0, 1, 2, 0, 0], amount: bn(100), bump: 1 } },
      { publicKey: { toBase58: () => "E2" }, account: { nonce: bn(1), picks: [2, 2, 2, 0, 0], amount: bn(100), bump: 1 } },
    ]);

    const entries = await listEntriesForWallet("So11111111111111111111111111111111111111112");

    expect(entries).toHaveLength(2);
    const winner = entries.find((e) => e.nonce === 0)!;
    const loser = entries.find((e) => e.nonce === 1)!;
    expect(winner).toMatchObject({ won: true, claimable: true, payout: "1000" });
    expect(loser).toMatchObject({ won: false, claimable: false, payout: "0" });
  });
});

describe("contest readers — jackpot vault not initialized (pre-launch)", () => {
  it("readJackpotVault returns a pot '0' paused sentinel instead of throwing", async () => {
    h.vaultFetchNullable.mockResolvedValue(null); // account absent

    const vault = await readJackpotVault();

    expect(vault.pot).toBe("0");
    expect(vault.activeContestId).toBe(0);
  });

  it("readActiveContest returns null (no live contest)", async () => {
    h.vaultFetchNullable.mockResolvedValue(null);

    expect(await readActiveContest()).toBeNull();
  });

  it("listEntriesForWallet returns an empty list", async () => {
    h.vaultFetchNullable.mockResolvedValue(null);

    expect(await listEntriesForWallet("So11111111111111111111111111111111111111112")).toEqual([]);
  });

  it("still propagates a genuine RPC error (so the route can 502)", async () => {
    h.vaultFetchNullable.mockRejectedValue(new Error("failed to get account info: 503 Service Unavailable"));

    await expect(readJackpotVault()).rejects.toThrow(/503/);
  });
});
