/**
 * livePoolClient.ts — delegate-aware tx builders for the live pool.
 *
 *   join / claim → BASE layer (real wallet; the LivePool pot is never delegated).
 *   lock_pick    → BASE here in Phase A (player-signed → a wallet popup per tap);
 *                  Phase B swaps it for an ER/router tx signed by an ephemeral
 *                  session key (no popup).
 *
 * Mirrors anchorClient.ts's readonlyProgram/withBlockhash builder pattern.
 */
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { readonlyProgram, withBlockhash, erConnection } from "./anchorClient.ts";
import { livePoolPda, liveEntryPda, callPda } from "./pdasLive.ts";

/** Build an unsigned join_live_pool tx (base layer). Deposits entry_price and
 *  opens the caller's seat; reverts on a non-open pool or a closed join window. */
export async function buildJoinLivePoolTx(
  playerAddress: string,
  poolId: number | bigint,
): Promise<Transaction> {
  const player = new PublicKey(playerAddress);
  const pool = livePoolPda(poolId);
  const entry = liveEntryPda(pool, player);
  const program = readonlyProgram(player);
  const tx = await program.methods
    .joinLivePool()
    .accountsStrict({ player, pool, entry, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, player);
}

/** Build an unsigned claim_live_pool tx (base layer). Pays winner share / void
 *  refund / else close-only, and deletes the seat (rent back to the player). */
export async function buildClaimLivePoolTx(
  playerAddress: string,
  poolId: number | bigint,
): Promise<Transaction> {
  const player = new PublicKey(playerAddress);
  const pool = livePoolPda(poolId);
  const entry = liveEntryPda(pool, player);
  const program = readonlyProgram(player);
  const tx = await program.methods
    .claimLivePool()
    .accountsStrict({ player, pool, entry, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, player);
}

/** Build an unsigned ER lock_pick tx (a tap). The LiveEntry + Call are delegated
 *  to the MagicBlock ER, so this MUST be sent to the ER (`erConnection`) — signed
 *  by the player via Privy (no-modal). NO program change: the deployed lock_pick's
 *  `player: Signer` + `has_one = player` authorizes the embedded wallet directly,
 *  and inside the ER the delegated entry reads as program-owned. `seq` selects the
 *  Call PDA; `option` is the picked bucket index. */
export async function buildLockPickTxER(
  playerAddress: string,
  poolId: number | bigint,
  seq: number,
  option: number,
): Promise<Transaction> {
  const player = new PublicKey(playerAddress);
  const pool = livePoolPda(poolId);
  const entry = liveEntryPda(pool, player);
  const call = callPda(pool, seq);
  const program = readonlyProgram(player);
  const tx = await program.methods
    .lockPick(option)
    .accountsStrict({ player, call, entry })
    .transaction();
  // ER blockhash (not base) — the signer refreshes it once more right before signing.
  tx.feePayer = player;
  tx.recentBlockhash = (await erConnection.getLatestBlockhash("confirmed")).blockhash;
  return tx;
}
