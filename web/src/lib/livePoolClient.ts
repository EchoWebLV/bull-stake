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
import { readonlyProgram, withBlockhash } from "./anchorClient.ts";
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

/** ⚠️ STUB (Slice 5 correction): taps must go to the ER via the MagicRouter — the
 *  keeper delegates each LiveEntry for ER gameplay, so a BASE-layer lock_pick
 *  reverts on a delegated entry (base owner == Delegation Program). The real tap
 *  path is an ER/router tx (router blockhash + router broadcast), signed by the
 *  player (popup) or an ephemeral session key (gasless). This base builder is kept
 *  only for shape reference until the ER tap path lands. `seq` selects the Call
 *  PDA; `option` is the picked bucket index. */
export async function buildLockPickTx(
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
  return withBlockhash(tx, player);
}
