/**
 * pdasLive.ts — web mirror of keeper/live-pda.ts for the live-match program.
 *
 * Pure + I/O-free: every export is an in-memory byte writer or a
 * `findProgramAddressSync` derivation. Follows web/src/lib/pdas.ts conventions
 * (named web3.js import + the `buffer` polyfill), NOT the keeper's NodeNext
 * default-destructure idiom.
 *
 * Seeds mirror keeper/live-pda.ts:
 *   livepool  [b"livepool",  u64le(pool_id)]
 *   call      [b"call", pool, u32le(seq)]   ← seq is u32 (4 bytes), NOT u64
 *   liveentry [b"liveentry", pool, player]
 */
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

/** Deployed live-match program id (devnet). */
export const LIVE_PROGRAM_ID = new PublicKey(
  "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
);

/** 4-byte unsigned little-endian — the call seq is u32 (NOT u64). */
export function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** 8-byte unsigned little-endian. Accepts number | bigint. */
export function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** livepool PDA for a pool_id. */
export function livePoolPda(poolId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livepool"), u64le(poolId)],
    LIVE_PROGRAM_ID,
  )[0];
}

/** call PDA for a (pool, seq) — seq encoded as u32le (4 bytes). */
export function callPda(pool: PublicKey, seq: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("call"), pool.toBuffer(), u32le(seq)],
    LIVE_PROGRAM_ID,
  )[0];
}

/** liveentry PDA for a (pool, player). */
export function liveEntryPda(pool: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liveentry"), pool.toBuffer(), player.toBuffer()],
    LIVE_PROGRAM_ID,
  )[0];
}
