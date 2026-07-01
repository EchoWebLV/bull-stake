import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { livePoolPda, liveEntryPda, callPda, u32le } from "../src/lib/pdasLive.ts";
import { poolIsClaimable, isWinner } from "../src/lib/api.ts";
import { connection } from "../src/lib/anchorClient.ts";
import {
  buildJoinLivePoolTx, buildClaimLivePoolTx, buildLockPickTx,
} from "../src/lib/livePoolClient.ts";

const PAYER = "So11111111111111111111111111111111111111112";
const POOL_ID = 1782924013084000; // from the Slice-2b devnet proof

// Keep the builder tests offline: withBlockhash() calls getLatestBlockhash.
vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 1,
} as never);

describe("pdasLive", () => {
  it("u32le is 4 bytes (call seq is u32, not u64)", () => {
    expect(u32le(1).length).toBe(4);
  });
  it("derivations are deterministic and seq-sensitive", () => {
    const pool = livePoolPda(POOL_ID);
    expect(pool).toBeInstanceOf(PublicKey);
    const player = new PublicKey(PAYER);
    expect(liveEntryPda(pool, player).equals(liveEntryPda(pool, player))).toBe(true);
    expect(callPda(pool, 0).equals(callPda(pool, 0))).toBe(true);
    expect(callPda(pool, 0).equals(callPda(pool, 1))).toBe(false);
  });
});

describe("live view helpers", () => {
  it("winner iff settled and total == winningScore > 0", () => {
    const pool = { status: "settled", winningScore: 4 } as const;
    expect(isWinner(pool, { total: 4 })).toBe(true);
    expect(isWinner(pool, { total: 3 })).toBe(false);
    expect(isWinner({ status: "settled", winningScore: 0 }, { total: 0 })).toBe(false);
    expect(isWinner({ status: "live", winningScore: 4 }, { total: 4 })).toBe(false);
  });
  it("claimable only in terminal states", () => {
    expect(poolIsClaimable({ status: "settled" })).toBe(true);
    expect(poolIsClaimable({ status: "voided" })).toBe(true);
    expect(poolIsClaimable({ status: "rolledOver" })).toBe(true);
    expect(poolIsClaimable({ status: "live" })).toBe(false);
    expect(poolIsClaimable({ status: "open" })).toBe(false);
  });
});

describe("live tx builders", () => {
  it("join targets pool+entry; player is the signer feePayer", async () => {
    const tx = await buildJoinLivePoolTx(PAYER, POOL_ID);
    const player = new PublicKey(PAYER);
    expect(tx.feePayer?.equals(player)).toBe(true);
    expect(tx.instructions.length).toBe(1);
    const k0 = tx.instructions[0].keys[0];
    expect(k0.pubkey.equals(player)).toBe(true);
    expect(k0.isSigner).toBe(true);
  });
  it("claim builds one instruction with the player as feePayer", async () => {
    const tx = await buildClaimLivePoolTx(PAYER, POOL_ID);
    expect(tx.feePayer?.equals(new PublicKey(PAYER))).toBe(true);
    expect(tx.instructions.length).toBe(1);
  });
  it("lock_pick includes the derived call + entry accounts", async () => {
    const tx = await buildLockPickTx(PAYER, POOL_ID, 0, 1);
    const pool = livePoolPda(POOL_ID);
    const metas = tx.instructions[0].keys.map((k) => k.pubkey.toBase58());
    expect(metas).toContain(callPda(pool, 0).toBase58());
    expect(metas).toContain(liveEntryPda(pool, new PublicKey(PAYER)).toBase58());
  });
});
