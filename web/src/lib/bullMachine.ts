// web/src/lib/bullMachine.ts
/* Bull Machine client — port of the devnet-proven SOL bulls ER bridge
 * (demo/er-chain.src.js, VERDICT GREEN). One Privy-signed tx opens+delegates a
 * session; spins are session-key-signed straight to the MagicBlock ER node;
 * cash-out is cranked by the session key and mints bulls to the player.
 * L1 = shared Helius `connection`; the ER node is discovered per-delegation
 * via the MagicBlock router (NOT the live game's fixed `erConnection`). */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "../idl/bull_machine.er.json";
import { connection } from "./anchorClient.ts";

export const BULL_PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const ROUTER = "https://devnet-router.magicblock.app";
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

// Extra L1 top-up so the session key can crank settle_mint per bull; leftovers
// sweep back to the player at cash-out. Mirrors the bridge constants.
const CRANK_LAMPORTS_PER_SPIN = 10_000_000;
const CRANK_LAMPORTS_BASE = 5_000_000;
const SESSION_KEY_TOPUP = 20_000_000;
const RENT_FEES_MARGIN = 15_000_000;

// Frozen Session layout (SOL bulls litesvm layout.rs).
const SES_CREDITS_TOTAL = 72, SES_CREDITS_USED = 73, SES_SETTLED = 74;
const SES_SPINS = 75, SPIN_STRIDE = 50, SES_EXPIRES_AT = 583, SES_LEN = 592;
export const STATUS = { EMPTY: 0, PENDING: 1, ROLLED: 2, SETTLED: 3 } as const;

const seed = (...parts: Buffer[]) => PublicKey.findProgramAddressSync(parts, BULL_PROGRAM_ID)[0];
export const configPda = () => seed(Buffer.from("config"));
export const sessionPda = (player: PublicKey) => seed(Buffer.from("session"), player.toBuffer());
export const claimPda = (traits: number[]) => seed(Buffer.from("claim"), Buffer.from(traits));
export const identityPda = () => seed(Buffer.from("identity"));
export const authorityPda = () => seed(Buffer.from("authority"));

type IdlShape = { instructions: { name: string; discriminator: number[] }[] };
const spinDisc = Uint8Array.from(
  (idl as unknown as IdlShape).instructions.find((i) => i.name === "spin")!.discriminator,
);

export type SpinSlot = { status: number; traits: number[]; randomness: number[] };
export type SessionData = {
  creditsTotal: number; creditsUsed: number; settled: number;
  spins: SpinSlot[]; expiresAt: number;
};

export function decodeSession(d: Uint8Array): SessionData {
  const base = (i: number) => SES_SPINS + i * SPIN_STRIDE;
  const spins = Array.from({ length: 10 }, (_, i) => ({
    status: d[base(i)],
    traits: Array.from(d.subarray(base(i) + 1, base(i) + 10)),
    randomness: Array.from(d.subarray(base(i) + 18, base(i) + 50)),
  }));
  return {
    creditsTotal: d[SES_CREDITS_TOTAL], creditsUsed: d[SES_CREDITS_USED], settled: d[SES_SETTLED],
    spins,
    expiresAt: Number(new DataView(d.buffer, d.byteOffset + SES_EXPIRES_AT, 8).getBigInt64(0, true)),
  };
}

/** Full devnet-SOL cost of opening an n-spin session (bridge preflight math). */
export function openCostLamports(nSpins: number, spinPrice: bigint): number {
  return Number(spinPrice) * nSpins + SESSION_KEY_TOPUP
    + CRANK_LAMPORTS_BASE + nSpins * CRANK_LAMPORTS_PER_SPIN + RENT_FEES_MARGIN;
}

export type SessionView = {
  creditsTotal: number; creditsUsed: number; creditsLeft: number; settled: number;
  rolledUnsettled: number; expired: boolean; closeable: boolean; active: boolean;
  spins: SpinSlot[];
};

/** Pure UI summary of a decoded session (testable without RPC). */
export function deriveSessionView(
  s: SessionData,
  ctx: { delegated: boolean; sessionKeyHeld: boolean; now: number },
): SessionView {
  const rolled = s.spins.filter((sp) => sp.status === STATUS.ROLLED).length;
  return {
    creditsTotal: s.creditsTotal, creditsUsed: s.creditsUsed, settled: s.settled,
    creditsLeft: s.creditsTotal - s.creditsUsed,
    rolledUnsettled: rolled,
    expired: ctx.now > s.expiresAt,
    spins: s.spins,
    closeable: !ctx.delegated && s.spins.every((sp) => sp.status === STATUS.EMPTY || sp.status === STATUS.SETTLED),
    active: ctx.delegated && ctx.sessionKeyHeld && s.creditsTotal - s.creditsUsed > 0 && ctx.now <= s.expiresAt,
  };
}
