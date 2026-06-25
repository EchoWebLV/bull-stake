import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import { Proofbet } from "../target/types/proofbet";

export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
export const program = (anchor.workspace as any).proofbet as Program<Proofbet>;
export const connection = provider.connection;

export function marketPda(fixtureId: number | BN, marketId: number): PublicKey {
  const fid = new BN(fixtureId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), fid.toArrayLike(Buffer, "le", 8), Buffer.from([marketId])],
    program.programId,
  )[0];
}

export function vaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    program.programId,
  )[0];
}

export function positionPda(market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()],
    program.programId,
  )[0];
}

export async function airdrop(pubkey: PublicKey, sol = 100): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

export async function freshFunded(sol = 100): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, sol);
  return kp;
}

export async function balance(pubkey: PublicKey): Promise<number> {
  return connection.getBalance(pubkey);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Default predicate fields for a Total-Goals O/U market (two-stat Add). */
export function goalsArgs(opts: {
  settleAuthority: PublicKey;
  threshold: number;
  entryCloseTs: number;
  feeBps?: number;
  feeRecipient?: PublicKey | null;
}) {
  return {
    settleAuthority: opts.settleAuthority,
    feeRecipient: opts.feeRecipient ?? null,
    statKey: 1,
    statKey2: 2,
    op: { add: {} },
    comparison: { greaterThan: {} },
    threshold: opts.threshold,
    entryCloseTs: new BN(opts.entryCloseTs),
    feeBps: opts.feeBps ?? 0,
  };
}

/** Assert a transaction promise rejects with the given Anchor error code (or substring). */
export async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  // Capture the rejection, then assert OUTSIDE the try/catch — otherwise the
  // assert.fail below (whose message contains `code`) would be caught and would
  // spuriously satisfy the assert.include, making every rejection test pass.
  let caught = false;
  let err: any;
  try {
    await p;
  } catch (e) {
    caught = true;
    err = e;
  }
  if (!caught) {
    assert.fail(`expected error "${code}" but the call succeeded`);
  }
  const anchorCode = err?.error?.errorCode?.code;
  const haystack = anchorCode ?? err?.message ?? String(err);
  assert.include(String(haystack), code, `expected "${code}", got: ${haystack}`);
}

export { BN, Program, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, anchor, assert };
