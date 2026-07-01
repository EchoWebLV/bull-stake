/**
 * Unit tests for the pure PDA + encoding helpers in live-pda.ts.
 *
 * HERMETIC: these cover only in-memory byte encoding and
 * PublicKey.findProgramAddressSync (a pure ed25519/sha256 derivation). No
 * Connection, no RPC, no Anchor Program, no filesystem — importing live-pda.ts
 * fires ZERO I/O. Expected base58 values were derived offline against the
 * deployed program id By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ and pinned
 * here so a seed/encoding regression fails loudly.
 */

import { describe, it, expect } from "vitest";
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import {
  u32le,
  u64le,
  i64le,
  LIVE_PROGRAM_ID,
  livePoolPda,
  liveCursorPda,
  callPda,
  liveEntryPda,
  jackpotPda,
} from "../live-pda.js";

const { PublicKey } = pkg;
const { BN } = anchorDefault;

const POOL_ID = new BN(777020634);
const PLAYER = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

describe("LIVE_PROGRAM_ID", () => {
  it("is the deployed devnet program id", () => {
    expect(LIVE_PROGRAM_ID.toBase58()).toBe(
      "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
    );
  });
});

describe("encoding helpers", () => {
  it("u32le produces exactly 4 little-endian bytes", () => {
    expect(u32le(0)).toEqual(Buffer.from([0, 0, 0, 0]));
    expect(u32le(1)).toEqual(Buffer.from([1, 0, 0, 0]));
    const max = u32le(4294967295); // NONE_SEQ
    expect(max.length).toBe(4);
    expect(max).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  });

  it("u64le produces exactly 8 little-endian bytes", () => {
    const b = u64le(1);
    expect(b.length).toBe(8);
    expect(b).toEqual(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
  });

  it("i64le produces exactly 8 little-endian bytes", () => {
    expect(i64le(1).length).toBe(8);
  });

  it("u64le and i64le AGREE for a positive value", () => {
    expect(i64le(123456789)).toEqual(u64le(123456789));
  });

  it("u64le and i64le DIFFER for a negative value (signed two's complement)", () => {
    // -1 as i64 = 0xFFFF_FFFF_FFFF_FFFF; u64le(-1) is not representable the same way.
    const neg = i64le(-1);
    expect(neg).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    // A positive-only writer cannot equal the signed encoding of a negative number.
    expect(() => u64le(-1)).toThrow();
  });
});

describe("PDA derivations", () => {
  it("livePoolPda matches the pinned base58 for a fixed poolId/programId", () => {
    expect(livePoolPda(POOL_ID).toBase58()).toBe(
      "62HMRBNBbUacWfhEZ4CKfkwGv5kM8PTDVoRSfTKu8fhi",
    );
  });

  it("liveCursorPda matches the pinned base58", () => {
    const pool = livePoolPda(POOL_ID);
    expect(liveCursorPda(pool).toBase58()).toBe(
      "5KFuhjeXGpxHoKTUFY2wDoExqKGow6AfiYWBpzit876M",
    );
  });

  it("callPda uses a 4-byte u32le seq (not an 8-byte u64) — guards the u32/u64 trap", () => {
    const pool = livePoolPda(POOL_ID);
    // The real (u32) derivation:
    expect(callPda(pool, 0).toBase58()).toBe(
      "DNih6zeGA3DvqEBFwPG9fLXb5VSKGaZBf5XEuFC2ex6V",
    );
    // An 8-byte-seq variant would derive a DIFFERENT address — assert we are NOT that.
    const u64Variant = PublicKey.findProgramAddressSync(
      [Buffer.from("call"), pool.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)],
      LIVE_PROGRAM_ID,
    )[0];
    expect(callPda(pool, 0).toBase58()).not.toBe(u64Variant.toBase58());
    expect(u64Variant.toBase58()).toBe("6tUKT21s9PEJqWUzM7giqYgroAshRVdczdpuiRPw2GGb");
  });

  it("liveEntryPda matches the pinned base58 for a fixed pool/player", () => {
    const pool = livePoolPda(POOL_ID);
    expect(liveEntryPda(pool, PLAYER).toBase58()).toBe(
      "ECysiYjaLNeh5NRByCWv4XUjqNqQRPpC2kNwEFmbveRs",
    );
  });

  it("jackpotPda matches the pinned base58 (single global seed)", () => {
    expect(jackpotPda().toBase58()).toBe(
      "4LEY34HvTdqfH8WKWuW6tjmxNzaP2ryzS5ce9WwMVBiq",
    );
  });
});
