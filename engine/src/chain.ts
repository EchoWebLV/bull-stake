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

// ── Contest reader (daily sweepstake) ──────────────────────────────────────

/** JackpotVault account size: 8 (disc) + active_contest_id(u64) + reserved(u64) + bump(u8). */
const JACKPOT_VAULT_SIZE = 8 + 8 + 8 + 1;

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function deriveJackpotVaultPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
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

/** Free pot = vault balance − rent floor − reserved liabilities, clamped at 0. Returns lamports as a string. */
export function computePot(lamports: bigint, rentFloor: bigint, reserved: bigint): string {
  const pot = lamports - rentFloor - reserved;
  return (pot > 0n ? pot : 0n).toString();
}

const CONTEST_STATUS = ["open", "settled", "rolledOver", "voided"] as const;
function contestStatusString(s: Record<string, unknown>): (typeof CONTEST_STATUS)[number] {
  if ("settled" in s) return "settled";
  if ("rolledOver" in s) return "rolledOver";
  if ("voided" in s) return "voided";
  return "open";
}

export interface JackpotVaultView {
  activeContestId: number;
  reserved: string;
  lamports: string;
  rentFloor: string;
  pot: string;
}

export interface ContestView {
  pubkey: string;
  contestId: number;
  settleAuthority: string;
  feeRecipient: string;
  fixtures: number[];           // length numMatches
  numMatches: number;
  entryPrice: string;
  lockTs: number;
  settleAfterTs: number;
  feeBps: number;
  status: "open" | "settled" | "rolledOver" | "voided";
  winningBuckets: number[];     // length numMatches
  entryCount: number;
  perfectCount: number;
  potSnapshot: string;
  distributable: string;
  claimedCount: number;
  claimedTotal: string;
  settledTs: number;
}

export interface EntryView {
  pubkey: string;
  nonce: number;
  picks: number[];              // raw [u8; 5]
  amount: string;
}

/** Paused sentinel returned before the jackpot_vault singleton is initialized on-chain. */
const PAUSED_VAULT: JackpotVaultView = {
  activeContestId: 0, reserved: "0", lamports: "0", rentFloor: "0", pot: "0",
};

export async function readJackpotVault(): Promise<JackpotVaultView> {
  const program = loadProgram();
  const pda = deriveJackpotVaultPda(program.programId);
  // fetchNullable → null when the account is absent (pre-launch), but still
  // throws on a genuine RPC error — so the route 502s only on real failures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (program.account as any).jackpotVault.fetchNullable(pda);
  if (v === null) return PAUSED_VAULT;
  const conn = program.provider.connection;
  const lamports = BigInt(await conn.getBalance(pda));
  const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(JACKPOT_VAULT_SIZE));
  const reserved = BigInt(v.reserved.toString());
  return {
    activeContestId: Number(v.activeContestId),
    reserved: reserved.toString(),
    lamports: lamports.toString(),
    rentFloor: rentFloor.toString(),
    pot: computePot(lamports, rentFloor, reserved),
  };
}

/** The currently-live contest, or null when none is live (vault.active_contest_id == 0). */
export async function readActiveContest(): Promise<ContestView | null> {
  const program = loadProgram();
  const vPda = deriveJackpotVaultPda(program.programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (program.account as any).jackpotVault.fetchNullable(vPda);
  if (v === null) return null; // vault not initialized yet → no live contest
  const activeId = Number(v.activeContestId);
  if (activeId === 0) return null;
  const cPda = deriveContestPda(program.programId, activeId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (program.account as any).contest.fetch(cPda);
  const nm = Number(c.numMatches);
  return {
    pubkey: cPda.toBase58(),
    contestId: Number(c.contestId),
    settleAuthority: c.settleAuthority.toBase58(),
    feeRecipient: c.feeRecipient.toBase58(),
    fixtures: (c.fixtures as { toNumber(): number }[]).slice(0, nm).map((f) => f.toNumber()),
    numMatches: nm,
    entryPrice: c.entryPrice.toString(),
    lockTs: Number(c.lockTs),
    settleAfterTs: Number(c.settleAfterTs),
    feeBps: Number(c.feeBps),
    status: contestStatusString(c.status),
    winningBuckets: (c.winningBuckets as number[]).slice(0, nm).map(Number),
    entryCount: Number(c.entryCount),
    perfectCount: Number(c.perfectCount),
    potSnapshot: c.potSnapshot.toString(),
    distributable: c.distributable.toString(),
    claimedCount: Number(c.claimedCount),
    claimedTotal: c.claimedTotal.toString(),
    settledTs: Number(c.settledTs),
  };
}

/** Every Entry the wallet holds in the live contest (empty if none / no live contest). */
export async function listEntriesForWallet(wallet: string): Promise<EntryView[]> {
  const program = loadProgram();
  const vPda = deriveJackpotVaultPda(program.programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (program.account as any).jackpotVault.fetchNullable(vPda);
  if (v === null) return []; // vault not initialized yet → no entries
  const activeId = Number(v.activeContestId);
  if (activeId === 0) return [];
  const cPda = deriveContestPda(program.programId, activeId);
  const bettor = new PublicKey(wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accts: any[] = await (program.account as any).entry.all([
    { memcmp: { offset: 8, bytes: bettor.toBase58() } },        // bettor at offset 8
    { memcmp: { offset: 8 + 32, bytes: cPda.toBase58() } },     // contest at offset 40
  ]);
  return accts
    .map((a) => ({
      pubkey: a.publicKey.toBase58(),
      nonce: Number(a.account.nonce),
      picks: (a.account.picks as number[]).map(Number),
      amount: a.account.amount.toString(),
    }))
    .sort((x, y) => x.nonce - y.nonce);
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
