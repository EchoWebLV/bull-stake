/**
 * create-match-pool.ts — base-layer CLI that composes ONE live match pool for a
 * fixture: `create_live_pool` (creates the LivePool escrow PDA + its LiveCursor),
 * then a `prealloc_call` loop that reserves the pool's `num_calls` Call PDAs so
 * the live-runner can `open_call` each seq later on the ER.
 *
 * `pool_id == fixture_id` (one pool per fixture, mirroring create-parlay.ts's
 * `contest_id == fixtureId`). The keeper is settle_authority + fee_recipient
 * (single-key devnet posture — split flagged for mainnet in the plan).
 *
 * Usage:
 *   npx tsx create-match-pool.ts <fixtureId>:<kickoffISO> \
 *     [--entry-price=0.035] [--fee-bps=500] [--num-calls=8] [--dry-run]
 *
 * PDA derivations + le encoders are INLINED via live-pda.ts (the create-parlay.ts
 * precedent) so this file never imports engine/src/chain.ts.
 *
 * Anchor CJS idiom (NodeNext ESM): default-import then destructure.
 * IDL is snake_case; call camelCase methods (.createLivePool / .preallocCall).
 */
import "dotenv/config";
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { createContext } from "../spike/src/auth.js";
import { loadProofbetProgram } from "./settle.js";
import { livePoolPda, liveCursorPda, callPda } from "./live-pda.js";

const { PublicKey, SystemProgram } = pkg;
const { BN } = anchorDefault;

const LAMPORTS_PER_SOL = 1_000_000_000;

/** On-chain caps (create_live_pool.rs:49-52 + state.rs). */
export const MAX_FEE_BPS = 1000;
export const MAX_CALLS = 64;

/** Default number of calls a pool preallocates (plan default; ≤ MAX_CALLS). */
export const DEFAULT_NUM_CALLS = 8;
/** Default settle buffer after kickoff (3h — mirrors parlayParams). */
export const DEFAULT_BUFFER_SECS = 3 * 3600;

export interface CreateLiveOpts {
  entryPriceLamports: number;
  feeBps: number;
  numCalls?: number;
  bufferSecs?: number;
  /** Current unix seconds — used ONLY to validate now < lock_ts (pure, testable). */
  nowSec: number;
}

/** BN-free args for `create_live_pool` (the `new BN(...)` wrapping happens at the RPC site). */
export interface CreateLiveArgs {
  poolId: number; // == fixtureId
  fixtureId: number;
  entryPriceLamports: number;
  lockTs: number; // seconds — fixture kickoff (entry close)
  settleAfterTs: number; // seconds — lockTs + bufferSecs
  feeBps: number;
  numCalls: number;
}

/**
 * Pure arg assembly that enforces EVERY on-chain invariant from
 * create_live_pool.rs (46-55) BEFORE any tx is broadcast — so an invalid pool
 * never reaches the network:
 *   pool_id != 0, fixture_id != 0, entry_price > 0, fee_bps <= MAX_FEE_BPS,
 *   1 <= num_calls <= MAX_CALLS, now < lock_ts < settle_after_ts.
 * `pool_id == fixture_id`. Throws (does not clamp) on any violation.
 */
export function buildCreateLiveArgs(
  fixtureId: number,
  kickoffMs: number,
  opts: CreateLiveOpts,
): CreateLiveArgs {
  const numCalls = opts.numCalls ?? DEFAULT_NUM_CALLS;
  const bufferSecs = opts.bufferSecs ?? DEFAULT_BUFFER_SECS;
  const lockTs = Math.floor(kickoffMs / 1000);
  const settleAfterTs = lockTs + bufferSecs;

  if (!Number.isInteger(fixtureId) || fixtureId === 0) {
    throw new Error(`InvalidFixtureId: fixture_id must be a non-zero integer (got ${fixtureId})`);
  }
  // pool_id == fixture_id, so a non-zero fixture_id also guarantees pool_id != 0.
  if (!(opts.entryPriceLamports > 0)) {
    throw new Error(`ZeroAmount: entry_price must be > 0 (got ${opts.entryPriceLamports})`);
  }
  if (!(opts.feeBps >= 0 && opts.feeBps <= MAX_FEE_BPS)) {
    throw new Error(`FeeTooHigh: fee_bps must be 0..${MAX_FEE_BPS} (got ${opts.feeBps})`);
  }
  if (!(numCalls >= 1 && numCalls <= MAX_CALLS)) {
    throw new Error(`InvalidCallCount: num_calls must be 1..${MAX_CALLS} (got ${numCalls})`);
  }
  if (!(opts.nowSec < lockTs && lockTs < settleAfterTs)) {
    throw new Error(
      `EntryCloseInPast: require now(${opts.nowSec}) < lock_ts(${lockTs}) < settle_after_ts(${settleAfterTs})`,
    );
  }

  return {
    poolId: fixtureId,
    fixtureId,
    entryPriceLamports: opts.entryPriceLamports,
    lockTs,
    settleAfterTs,
    feeBps: opts.feeBps,
    numCalls,
  };
}

type PublicKeyT = InstanceType<typeof PublicKey>;

/**
 * Drive `create_live_pool` then the `prealloc_call` seq 0..num_calls-1 loop
 * against an Anchor Program. Pure of PDA I/O (derivations are local); the only
 * side effect is `.rpc()`, which `--dry-run` suppresses entirely.
 *
 * Account keys mirror the IDL exactly:
 *   create_live_pool → {keeper, pool, cursor, systemProgram}
 *   prealloc_call    → {keeper, pool, call, systemProgram}
 */
export async function createMatchPool(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  keeper: PublicKeyT,
  feeRecipient: PublicKeyT,
  args: CreateLiveArgs,
  opts: { dryRun?: boolean } = {},
): Promise<{ createSig?: string; preallocSigs: string[] }> {
  const pool = livePoolPda(new BN(args.poolId));
  const cursor = liveCursorPda(pool);

  if (opts.dryRun) {
    return { preallocSigs: [] };
  }

  const createSig: string = await program.methods
    .createLivePool(
      new BN(args.poolId),
      new BN(args.fixtureId),
      new BN(args.entryPriceLamports),
      new BN(args.lockTs),
      new BN(args.settleAfterTs),
      feeRecipient,
      args.feeBps, // u16 → plain number
      args.numCalls, // u32 → plain number
    )
    .accountsStrict({ keeper, pool, cursor, systemProgram: SystemProgram.programId })
    .rpc();

  const preallocSigs: string[] = [];
  for (let seq = 0; seq < args.numCalls; seq++) {
    const sig: string = await program.methods
      .preallocCall(seq) // u32 seq → plain number
      .accountsStrict({ keeper, pool, call: callPda(pool, seq), systemProgram: SystemProgram.programId })
      .rpc();
    preallocSigs.push(sig);
  }

  return { createSig, preallocSigs };
}

interface ParsedArgs {
  flags: Record<string, string>;
  fixtureId: number;
  kickoffMs: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  let fixtureId = 0;
  let kickoffMs = 0;
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v = "true"] = a.slice(2).split("=");
      flags[k] = v;
    } else {
      // Split on the FIRST colon only — the ISO kickoff has colons.
      const idx = a.indexOf(":");
      fixtureId = Number(a.slice(0, idx));
      kickoffMs = Date.parse(a.slice(idx + 1));
    }
  }
  return { flags, fixtureId, kickoffMs };
}

async function main() {
  const { flags, fixtureId, kickoffMs } = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === "true";
  const entryPriceLamports = Math.round(Number(flags["entry-price"] ?? "0.035") * LAMPORTS_PER_SOL);
  const feeBps = Number(flags["fee-bps"] ?? "500");
  const numCalls = Number(flags["num-calls"] ?? String(DEFAULT_NUM_CALLS));

  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;

  const args = buildCreateLiveArgs(fixtureId, kickoffMs, {
    entryPriceLamports,
    feeBps,
    numCalls,
    nowSec: Math.floor(Date.now() / 1000),
  });

  const pool = livePoolPda(new BN(args.poolId));
  console.log(
    JSON.stringify(
      {
        action: "create_match_pool",
        poolId: args.poolId,
        fixtureId: args.fixtureId,
        pool: pool.toBase58(),
        entryPriceLamports: args.entryPriceLamports,
        lockTs: args.lockTs,
        settleAfterTs: args.settleAfterTs,
        feeBps: args.feeBps,
        numCalls: args.numCalls,
        keeper: keeper.toBase58(),
        dryRun,
      },
      null,
      2,
    ),
  );

  const res = await createMatchPool(proofbet, keeper, keeper, args, { dryRun });
  if (dryRun) {
    console.log(`# dry-run: would create pool ${pool.toBase58()} + prealloc ${args.numCalls} calls`);
    return;
  }
  console.log(`create_live_pool: ${res.createSig}`);
  console.log(`prealloc_call ×${res.preallocSigs.length}: ${res.preallocSigs.join(", ")}`);
  console.log(`pool pubkey: ${pool.toBase58()}`);
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring create-parlay.ts:164-165.
const isMain = process.argv[1]?.endsWith("create-match-pool.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
