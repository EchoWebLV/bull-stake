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

import { readJackpotVault, readActiveContest, listEntriesForWallet } from "../src/chain.ts";

beforeEach(() => {
  vi.clearAllMocks();
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
