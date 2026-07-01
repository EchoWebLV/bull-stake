/**
 * live-pda.ts — pure PDA + little-endian encoding helpers for the live-match
 * program (`By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`, devnet).
 *
 * Pure and I/O-free by construction: every export is either an in-memory byte
 * writer or a `PublicKey.findProgramAddressSync` derivation (a local
 * ed25519/sha256 computation — no Connection, no RPC). Importing this module
 * fires zero side effects, so keeper tests can import it freely.
 *
 * PDA seeds mirror spike/live-er/proof.ts:53-61 (the runtime-verified spike):
 *   livepool   [b"livepool",  u64le(pool_id)]
 *   livecursor [b"livecursor", pool]
 *   call       [b"call", pool, u32le(seq)]   ← seq is u32 (4 bytes), NOT u64
 *   liveentry  [b"liveentry", pool, player]
 *   jackpot    [b"jackpot"]
 *
 * Anchor CJS idiom (NodeNext ESM): default-import then destructure — named /
 * namespace imports of @coral-xyz/anchor break under this toolchain.
 */

import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";

const { PublicKey } = pkg;
const { BN } = anchorDefault;

/** Deployed live-match program id (devnet). */
export const LIVE_PROGRAM_ID = new PublicKey(
  "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
);

// ── little-endian encoders (copy of create-parlay.ts:159-160 + 4-byte u32le) ──

/** 4-byte unsigned little-endian (call seq — u32, NOT u64). */
export function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** 8-byte unsigned little-endian. */
export function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** 8-byte signed little-endian (two's complement for negatives). */
export function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

// ── PDA derivations (mirror proof.ts:53-61) ──────────────────────────────────

type BNLike = { toArrayLike(buffer: BufferConstructor, endian: "le", length: number): Buffer };

/** livepool PDA for a pool_id (u64le). Accepts a BN (or BN-like). */
export function livePoolPda(poolId: BNLike): InstanceType<typeof PublicKey> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livepool"), poolId.toArrayLike(Buffer, "le", 8)],
    LIVE_PROGRAM_ID,
  )[0];
}

/** livecursor PDA for a livepool. */
export function liveCursorPda(
  pool: InstanceType<typeof PublicKey>,
): InstanceType<typeof PublicKey> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livecursor"), pool.toBuffer()],
    LIVE_PROGRAM_ID,
  )[0];
}

/** call PDA for a (pool, seq) — seq is encoded as u32le (4 bytes). */
export function callPda(
  pool: InstanceType<typeof PublicKey>,
  seq: number,
): InstanceType<typeof PublicKey> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("call"), pool.toBuffer(), u32le(seq)],
    LIVE_PROGRAM_ID,
  )[0];
}

/** liveentry PDA for a (pool, player). */
export function liveEntryPda(
  pool: InstanceType<typeof PublicKey>,
  player: InstanceType<typeof PublicKey>,
): InstanceType<typeof PublicKey> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liveentry"), pool.toBuffer(), player.toBuffer()],
    LIVE_PROGRAM_ID,
  )[0];
}

/** jackpot PDA (single global seed). */
export function jackpotPda(): InstanceType<typeof PublicKey> {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("jackpot")],
    LIVE_PROGRAM_ID,
  )[0];
}
