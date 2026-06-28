import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { PROGRAM_ID, RPC_URL } from "./config.ts";

/** i64 little-endian as 8 bytes (matches Rust fixture_id.to_le_bytes()). */
function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

export function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])],
    programId,
  )[0];
}

export function deriveVaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    programId,
  )[0];
}

export function derivePositionPda(programId: PublicKey, market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()],
    programId,
  )[0];
}

export interface MarketView {
  pubkey: string;
  status: "open" | "settled" | "voided";
  fixtureId: number;
  marketId: number;
  numBuckets: number;
  bucketTotals: string[]; // length numBuckets; lamports as strings (avoid BigInt JSON issues)
  totalPool: string;
  feeBps: number;
  feeCollected: string;
  winningBucket: number | null;
  entryCloseTs: number;
  settledValue: number; // on-chain i32 (not an Option); only meaningful when status === "settled"
}

function statusString(s: Record<string, unknown>): MarketView["status"] {
  if ("settled" in s) return "settled";
  if ("voided" in s) return "voided";
  return "open";
}

let cachedProgram: anchor.Program | null = null;
function loadProgram(): anchor.Program {
  if (cachedProgram) return cachedProgram;
  const idlPath = process.env.PROOFBET_IDL ?? "../../target/idl/proofbet.json";
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const connection = new Connection(RPC_URL, "confirmed");
  // Read-only provider: a dummy wallet is fine, we never sign here.
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t } as anchor.Wallet,
    { commitment: "confirmed" },
  );
  cachedProgram = new anchor.Program(idl as anchor.Idl, provider);
  return cachedProgram;
}

/** Shared read-only Anchor program (cached). Used by history event parsing. */
export function getProgram(): anchor.Program {
  return loadProgram();
}

export async function readMarket(marketPubkey: string): Promise<MarketView> {
  const program = loadProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await (program.account as any).market.fetch(new PublicKey(marketPubkey));
  const numBuckets = Number(m.numBuckets);
  return {
    pubkey: marketPubkey,
    status: statusString(m.status),
    fixtureId: Number(m.fixtureId),
    marketId: Number(m.marketId),
    numBuckets,
    // on-chain array is fixed-size 3; expose only the active buckets.
    bucketTotals: (m.bucketTotals as any[]).slice(0, numBuckets).map((b) => b.toString()),
    totalPool: m.totalPool.toString(),
    feeBps: Number(m.feeBps),
    feeCollected: m.feeCollected.toString(),
    winningBucket: m.winningBucket === null ? null : Number(m.winningBucket),
    entryCloseTs: Number(m.entryCloseTs),
    // on-chain i32 (not an Option) — only meaningful when status === "settled" (0 otherwise)
    settledValue: Number(m.settledValue),
  };
}
