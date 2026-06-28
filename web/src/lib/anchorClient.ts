import * as anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import idl from "../idl/proofbet.json";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "./pdas.ts";

const RPC = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
export const connection = new Connection(RPC, "confirmed");

/** Read-only program (no signer) for building instructions. */
function readonlyProgram(payer: PublicKey): anchor.Program {
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: payer, signTransaction: async (t) => t, signAllTransactions: async (t) => t } as anchor.Wallet,
    { commitment: "confirmed" },
  );
  return new anchor.Program(idl as anchor.Idl, provider);
}

async function withBlockhash(tx: Transaction, payer: PublicKey): Promise<Transaction> {
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/** Build an unsigned place_bet transaction. amountLamports as bigint. */
export async function buildPlaceBetTx(
  payerAddress: string, fixtureId: number, marketId: number, bucket: number, amountLamports: bigint,
): Promise<Transaction> {
  const payer = new PublicKey(payerAddress);
  const program = readonlyProgram(payer);
  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const position = derivePositionPda(PROGRAM_ID, market, payer);
  const tx = await program.methods
    .placeBet(bucket, new anchor.BN(amountLamports.toString()))
    .accountsStrict({ bettor: payer, market, vault, position, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, payer);
}

/** Build an unsigned claim transaction. */
export async function buildClaimTx(
  payerAddress: string, fixtureId: number, marketId: number,
): Promise<Transaction> {
  const payer = new PublicKey(payerAddress);
  const program = readonlyProgram(payer);
  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const position = derivePositionPda(PROGRAM_ID, market, payer);
  const tx = await program.methods
    .claim()
    .accountsStrict({ bettor: payer, market, vault, position, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, payer);
}
