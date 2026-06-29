import {
  program, marketPda, vaultPda, positionPda, freshFunded, resultArgs, nowSec, sleep,
  BN, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
} from "./helpers";
import type { Keypair } from "@solana/web3.js";

export const RESULT_MARKET_ID = 12;

export function jackpotVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], program.programId)[0];
}

export function contestPda(contestId: number | BN): PublicKey {
  const id = new BN(contestId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("contest"), id.toArrayLike(Buffer, "le", 8)],
    program.programId,
  )[0];
}

export function entryPda(contest: PublicKey, bettor: PublicKey, nonce: number | BN): PublicKey {
  const n = new BN(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), contest.toBuffer(), bettor.toBuffer(), n.toArrayLike(Buffer, "le", 8)],
    program.programId,
  )[0];
}

/** Pad a fixture list to the fixed [i64; 5] the program expects. */
export function fixtureArray(ids: number[]): BN[] {
  const out = ids.map((x) => new BN(x));
  while (out.length < 5) out.push(new BN(0));
  return out;
}

/** Pad a pick list to the fixed [u8; 5] (tail zeros). */
export function pickArray(picks: number[]): number[] {
  const out = [...picks];
  while (out.length < 5) out.push(0);
  return out;
}

/**
 * Create a per-fixture result market (market_id 12, 3-bucket) and settle it to
 * `winningBucket`, so settle_contest can read it. Mirrors tests/three_way.ts.
 */
export async function makeSettledResultMarket(
  fixtureId: number,
  winningBucket: number,
  settleAuth: Keypair,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, RESULT_MARKET_ID);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), RESULT_MARKET_ID, resultArgs({
      settleAuthority: settleAuth.publicKey,
      entryCloseTs: nowSec() + 3,
    }))
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  // A tiny bet on the winning bucket so settle() does NOT hit the zero-winner
  // void path (settle.rs voids a market whose winning bucket has no stake).
  const bettor = await freshFunded();
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(winningBucket, new BN(1000))
    .accountsStrict({ bettor: bettor.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([bettor]).rpc();
  await sleep(3500);
  await program.methods
    .settle(winningBucket, 1, new BN(1700000000000), 0)
    .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient: creator.publicKey })
    .signers([settleAuth]).rpc();
  return market;
}

/**
 * Create a per-fixture result market and drive it to the ZERO-WINNER void path:
 * the only stake sits on a NON-winning bucket, then `settle` declares
 * `winningBucket` (which has no stake). settle.rs Voids the market but RECORDS
 * `winning_bucket`. settle_contest must still read that bucket from the Voided
 * market (audit fix B) — a match that played but drew no stake on the winning side
 * settles the contest instead of bricking it.
 */
export async function makeZeroWinnerResultMarket(
  fixtureId: number,
  winningBucket: number,
  settleAuth: Keypair,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, RESULT_MARKET_ID);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), RESULT_MARKET_ID, resultArgs({
      settleAuthority: settleAuth.publicKey,
      entryCloseTs: nowSec() + 3,
    }))
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  // Stake on a bucket OTHER than the eventual winner → winner bucket has 0 stake.
  const loserBucket = (winningBucket + 1) % 3;
  const bettor = await freshFunded();
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(loserBucket, new BN(1000))
    .accountsStrict({ bettor: bettor.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([bettor]).rpc();
  await sleep(3500);
  await program.methods
    .settle(winningBucket, 1, new BN(1700000000000), 0)
    .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient: creator.publicKey })
    .signers([settleAuth]).rpc();
  return market;
}

export { LAMPORTS_PER_SOL };
