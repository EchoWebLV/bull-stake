import {
  program, marketPda, vaultPda, positionPda, freshFunded, resultArgs, goalsArgs, nowSec, sleep,
  BN, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
} from "./helpers";
import type { Keypair } from "@solana/web3.js";

export const RESULT_MARKET_ID = 12;

/** v2 jackpot singleton PDA — NOTE the seed is "jackpot" (was "jackpot_vault" in v1). */
export function jackpotPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot")], program.programId)[0];
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

/** Pad a market_id list to the fixed [u8; 5] (tail zeros). */
export function marketIdArray(ids: number[]): number[] {
  const out = [...ids];
  while (out.length < 5) out.push(0);
  return out;
}

/** Pad a pick list to the fixed [u8; 5] (tail zeros). */
export function pickArray(picks: number[]): number[] {
  const out = [...picks];
  while (out.length < 5) out.push(0);
  return out;
}

/**
 * Create a per-fixture result market on (fixtureId, marketId) and settle it to
 * `winningBucket`, so settle_contest can read it. `numBuckets` (2 or 3) lets a leg
 * be a binary O/U market (settle to bucket 0/1) or a 1X2 result market (0/1/2).
 * Mirrors tests/three_way.ts (3-way) and tests/settle.ts (binary).
 */
export async function makeSettledResultMarket(
  fixtureId: number,
  winningBucket: number,
  settleAuth: Keypair,
  marketId: number = RESULT_MARKET_ID,
  numBuckets: number = 3,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, marketId);
  const vault = vaultPda(market);
  const args = numBuckets === 2
    ? goalsArgs({ settleAuthority: settleAuth.publicKey, threshold: 0, entryCloseTs: nowSec() + 3, numBuckets: 2 })
    : resultArgs({ settleAuthority: settleAuth.publicKey, entryCloseTs: nowSec() + 3 });
  await program.methods
    .initializeMarket(new BN(fixtureId), marketId, args)
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
  marketId: number = RESULT_MARKET_ID,
  numBuckets: number = 3,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, marketId);
  const vault = vaultPda(market);
  const args = numBuckets === 2
    ? goalsArgs({ settleAuthority: settleAuth.publicKey, threshold: 0, entryCloseTs: nowSec() + 3, numBuckets: 2 })
    : resultArgs({ settleAuthority: settleAuth.publicKey, entryCloseTs: nowSec() + 3 });
  await program.methods
    .initializeMarket(new BN(fixtureId), marketId, args)
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  // Stake on a bucket OTHER than the eventual winner → winner bucket has 0 stake.
  const loserBucket = (winningBucket + 1) % numBuckets;
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

/**
 * Create a per-fixture market and ABANDON it via `void_market` (not the settle
 * zero-winner path), leaving winning_bucket = None. settle_contest must reject a
 * leg pointing at such a market (ResultMarketNotSettled) so the keeper voids the
 * whole contest instead.
 */
export async function makeAbandonedMarket(
  fixtureId: number,
  settleAuth: Keypair,
  marketId: number = RESULT_MARKET_ID,
  numBuckets: number = 3,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, marketId);
  const vault = vaultPda(market);
  const args = numBuckets === 2
    ? goalsArgs({ settleAuthority: settleAuth.publicKey, threshold: 0, entryCloseTs: nowSec() + 3, numBuckets: 2 })
    : resultArgs({ settleAuthority: settleAuth.publicKey, entryCloseTs: nowSec() + 3 });
  await program.methods
    .initializeMarket(new BN(fixtureId), marketId, args)
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  await program.methods.voidMarket(1, new BN(1700000000000))
    .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
    .signers([settleAuth]).rpc();
  return market;
}

/** Ensure the singleton jackpot PDA exists; ignore "already in use" across suites. */
export async function ensureJackpot(): Promise<PublicKey> {
  const keeper = await freshFunded();
  const jackpot = jackpotPda();
  try {
    await program.methods.initializeJackpot()
      .accountsStrict({ keeper: keeper.publicKey, jackpot, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* already initialized by an earlier suite */ }
  return jackpot;
}

export { LAMPORTS_PER_SOL };
