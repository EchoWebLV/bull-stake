import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}
export function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])], programId,
  )[0];
}
export function deriveVaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
}
export function derivePositionPda(programId: PublicKey, market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()], programId,
  )[0];
}

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
export function deriveJackpotPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot")], programId)[0];
}
export function deriveContestPda(programId: PublicKey, contestId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(contestId)], programId)[0];
}
export function deriveEntryPda(
  programId: PublicKey, contest: PublicKey, bettor: PublicKey, nonce: number | bigint,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), contest.toBuffer(), bettor.toBuffer(), u64le(nonce)], programId,
  )[0];
}
