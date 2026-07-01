/**
 * live-runner.ts — the in-process, dual-RPC harness that drives ONE live match
 * pool through its MagicBlock Ephemeral-Rollup lifecycle. This is the production
 * hardening of the proven spike (spike/live-er/proof.ts): two RPC layers (base
 * devnet + the ER endpoint), one shared keeper wallet, and a `step()` reporter
 * that records every on-chain call's timing / signature / error.
 *
 * SLICE 3 — S3-T4 lands ONLY the core: dual-RPC construction (proof.ts:64-70),
 * the `step()` harness (proof.ts:74-91), the `runLiveMatch(poolPda, opts)` export
 * seam, and the `isMain` guard. Delegation (T5), ER gameplay (T6), and
 * end→settle→void/refund (T7) extend `runLiveMatch` in later tasks.
 *
 * *** HERMETIC by construction ***
 *   • main() is behind an `isMain` guard — importing this file loads no wallet
 *     and opens no RPC. Tests import it with ZERO side effects.
 *   • `new Connection(url)` only stores the endpoint; no socket opens until a
 *     request method runs. `createLiveRunner` is therefore I/O-free.
 *   • `createLiveRunner` takes a `programFactory` seam (default = real Program)
 *     so tests inject spy Programs and never fetch an IDL or hit a Connection.
 *
 * Anchor CJS idiom (NodeNext ESM): default-import then destructure — named /
 * namespace imports of @coral-xyz/anchor break under this toolchain.
 * IDL is snake_case; call camelCase methods (.openCall / .resolveCall / …).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import anchorDefault from "@coral-xyz/anchor";
import type { Idl, Program as ProgramT, AnchorProvider as AnchorProviderT } from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import type { Connection as ConnectionT, Keypair as KeypairT, PublicKey as PublicKeyT } from "@solana/web3.js";
import { liveEntryPda, callPda, liveCursorPda } from "./live-pda.js";

const { Connection, PublicKey, Keypair } = pkg;
const { Program, AnchorProvider, Wallet } = anchorDefault;

/** Sleep helper (proof.ts:40) — only used inside async poll loops, never at import. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── constants (runtime-verified 2026-07-01; proof.ts:29-34) ─────────────────
/** Base-layer devnet RPC (the settlement / escrow layer). */
export const BASE_RPC = "https://api.devnet.solana.com";
/** MagicBlock Ephemeral-Rollup RPC (the gameplay layer). */
export const ER_RPC = "https://devnet.magicblock.app";
/** Deployed live-match program id (devnet). */
export const LIVE_PROGRAM_ID = new PublicKey(
  "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
);
/** MagicBlock delegation program (owner of a delegated account on base). */
export const DELEGATION_PROGRAM = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
);
/** ER validator identity — pinned as remainingAccounts[0] on every delegate_*. */
export const VALIDATOR = new PublicKey(
  "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
);

// ── report accumulator (proof.ts:72-91) ─────────────────────────────────────

/** One recorded on-chain (or read) step. */
export interface StepRecord {
  name: string;
  ms: number;
  ok: boolean;
  sig?: string;
  err?: string;
  logs?: unknown;
}

/** The mutable run report a `LiveRunner` accumulates. */
export interface RunReport {
  steps: StepRecord[];
  errors: { name: string; err: string }[];
}

/** A `programFactory` seam: build an Anchor Program from (idl, provider). */
export type ProgramFactory = (idl: Idl, provider: AnchorProviderT) => ProgramT;

/** The default factory — the REAL Anchor Program (I/O-free constructor). */
const defaultProgramFactory: ProgramFactory = (idl, provider) =>
  new Program(idl, provider);

/** Options for constructing a dual-RPC runner. */
export interface CreateRunnerOpts {
  /** Funded keeper keypair — the shared wallet for both providers. */
  keypair: KeypairT;
  /** The live-match IDL object (its `.address` is overwritten to LIVE_PROGRAM_ID). */
  idl?: Idl;
  /** Program factory seam (defaults to the real Anchor Program). */
  programFactory?: ProgramFactory;
  /** Override the base RPC endpoint (defaults to BASE_RPC). */
  baseRpc?: string;
  /** Override the ER RPC endpoint (defaults to ER_RPC). */
  erRpc?: string;
}

/** A constructed dual-RPC runner: two layers + a step reporter. */
export interface LiveRunner {
  base: ProgramT;
  er: ProgramT;
  baseConn: ConnectionT;
  erConn: ConnectionT;
  programId: PublicKeyT;
  /** The shared keeper pubkey (settle_authority + fee_recipient + payer on devnet). */
  keeper: PublicKeyT;
  report: RunReport;
  /** Run `fn`, record its timing/sig/error into `report`, return its value (or null on throw). */
  step<T>(name: string, fn: () => Promise<T>): Promise<T | null>;
}

/**
 * Load the live-match IDL from disk (base-layer default path, matching
 * settle.ts:66-70). Only called by main() — never at import time.
 */
function loadLiveIdl(): Idl {
  const idlPath = process.env.PROOFBET_IDL ?? "../target/idl/proofbet.json";
  return JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8")) as Idl;
}

/**
 * Construct the dual-RPC runner VERBATIM per proof.ts:64-70: two `Connection`s
 * (base/ER), one shared `Wallet(keeper)`, two `AnchorProvider`s, and two
 * `Program`s (`base`/`er`) built from an idl whose `.address` is injected to
 * LIVE_PROGRAM_ID FIRST. I/O-free — no network until a step actually runs.
 */
export function createLiveRunner(opts: CreateRunnerOpts): LiveRunner {
  const idl = opts.idl ?? loadLiveIdl();
  // Inject the program id BEFORE building either Program (proof.ts:38).
  idl.address = LIVE_PROGRAM_ID.toBase58();

  const factory = opts.programFactory ?? defaultProgramFactory;
  const baseRpc = opts.baseRpc ?? BASE_RPC;
  const erRpc = opts.erRpc ?? ER_RPC;

  const baseConn = new Connection(baseRpc, "confirmed");
  const erConn = new Connection(erRpc, "confirmed");
  const wallet = new Wallet(opts.keypair);
  const baseProvider = new AnchorProvider(baseConn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const erProvider = new AnchorProvider(erConn, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const base = factory(idl, baseProvider);
  const er = factory(idl, erProvider);

  const report: RunReport = { steps: [], errors: [] };

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      report.steps.push({
        name,
        ms,
        ok: true,
        sig: typeof r === "string" ? r : undefined,
      });
      return r;
    } catch (e: unknown) {
      const ms = Date.now() - t0;
      const err = e as { message?: string; logs?: unknown };
      const msg = err?.message ?? String(e);
      report.steps.push({ name, ms, ok: false, err: msg, logs: err?.logs });
      report.errors.push({ name, err: msg });
      return null;
    }
  }

  return {
    base,
    er,
    baseConn,
    erConn,
    programId: LIVE_PROGRAM_ID,
    keeper: opts.keypair.publicKey,
    report,
    step,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// S3-T5 — delegation phase (BASE): player-count gate + delegate_* + ER gate
//
// Productionizes proof.ts:179-205. The keeper gathers the pool's seats, HARD
// GATES on player_count<2 (routing to the void+refund branch — the on-chain
// tx lands in S3-T7), and otherwise delegates the ER working set
// (cursor + every entry + every call) to the MagicBlock validator, pinning the
// VALIDATOR as remainingAccounts[0] on each delegate_*. Finally it waits for the
// ER to surface the delegated cursor (owner flips back to our PROGRAM_ID on the
// ER RPC) before gameplay can begin.
//
// Account-key note: delegate_cursor / delegate_entry / delegate_call all take the
// delegated account under the GENERIC key `pda` (NOT cursor/entry/call). The
// validator is passed as a single non-signer, non-writable remaining account.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sort seat pubkeys strictly ascending by raw-byte `Buffer.compare`. Pure — does
 * NOT mutate the input (returns a fresh array). This is the canonical order the
 * on-chain `settle_live_pool` remaining_accounts contract demands (entries
 * ascending), so every seat list the runner derives is kept in this order.
 */
export function sortSeatsAscending(pubkeys: PublicKeyT[]): PublicKeyT[] {
  return [...pubkeys].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
}

/**
 * Gather a pool's player seats from the BASE program via
 * `liveEntry.all([{memcmp:{offset:40, bytes: pool}}])` (pool@40 in LiveEntry).
 * Returns the seat PLAYER pubkeys, sorted ascending (settle-order canonical).
 * The only I/O is the `getProgramAccounts` behind `.all` — tests inject a spy.
 */
export async function gatherSeats(
  baseProgram: ProgramT,
  pool: PublicKeyT,
): Promise<PublicKeyT[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await (baseProgram as any).account.liveEntry.all([
    { memcmp: { offset: 40, bytes: pool.toBase58() } },
  ]);
  const players = rows.map((r) => r.account.player as PublicKeyT);
  return sortSeatsAscending(players);
}

/**
 * HARD GATE: the on-chain live-match settlement needs ≥2 players. Fewer than two
 * seats → the pool cannot be a real contest, so we skip delegation entirely and
 * route to the void+refund branch (S3-T7). Exactly two (or more) → delegate.
 */
export function selectDelegationBranch(playerCount: number): "delegate" | "void" {
  return playerCount < 2 ? "void" : "delegate";
}

/** Inputs for the delegation phase. */
export interface DelegateAllInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  /** Seat player pubkeys (ascending). */
  seats: PublicKeyT[];
  /** Number of preallocated calls to delegate (seq 0..numCalls-1). */
  numCalls: number;
}

/** Result of the delegation phase. */
export interface DelegateAllResult {
  branch: "delegate" | "void";
  delegated: boolean;
}

/**
 * Delegate the full ER working set for a pool on the BASE layer (proof.ts:179-205):
 *   delegate_cursor + delegate_entry(player)×seats + delegate_call(seq)×numCalls.
 * Each instruction takes its delegated account under the generic key `pda` and
 * pins the VALIDATOR as `remainingAccounts[0]` (non-signer, non-writable).
 *
 * Enforces the player-count gate first: <2 seats → returns `{branch:'void'}`
 * WITHOUT issuing any tx (the caller runs the void+refund path). All txs flow
 * through `runner.step(...)` so timings/sigs/errors land in the report.
 */
export async function delegateAll(
  runner: LiveRunner,
  input: DelegateAllInput,
): Promise<DelegateAllResult> {
  const branch = selectDelegationBranch(input.seats.length);
  if (branch === "void") {
    return { branch, delegated: false };
  }

  const keeper = runner.keeper;
  const { pool, cursor, seats, numCalls } = input;
  const validatorRemaining = [{ pubkey: VALIDATOR, isSigner: false, isWritable: false }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.base as any).methods;

  await runner.step("delegate_cursor", () =>
    methods
      .delegateCursor()
      .accountsPartial({ keeper, pool, pda: cursor })
      .remainingAccounts(validatorRemaining)
      .rpc(),
  );

  for (const player of seats) {
    await runner.step(`delegate_entry ${player.toBase58().slice(0, 4)}`, () =>
      methods
        .delegateEntry(player)
        .accountsPartial({ keeper, pool, pda: liveEntryPda(pool, player) })
        .remainingAccounts(validatorRemaining)
        .rpc(),
    );
  }

  for (let seq = 0; seq < numCalls; seq++) {
    await runner.step(`delegate_call(${seq})`, () =>
      methods
        .delegateCall(seq)
        .accountsPartial({ keeper, pool, pda: callPda(pool, seq) })
        .remainingAccounts(validatorRemaining)
        .rpc(),
    );
  }

  return { branch, delegated: true };
}

/** Poll cadence for the ER-visibility gate (proof.ts:199-204). */
export interface ErVisibilityOpts {
  /** Poll interval in ms (default 2500). */
  intervalMs?: number;
  /** Overall timeout in ms (default 60000). */
  timeoutMs?: number;
}

/**
 * Wait until the ER RPC surfaces the delegated `cursor` with its owner flipped
 * back to our PROGRAM_ID (proof.ts:196-205). While the account is missing or
 * still owned by the DELEGATION_PROGRAM, keep polling every `intervalMs` up to
 * `timeoutMs`. Resolves `true` once ready; throws on timeout.
 */
export async function awaitErVisibility(
  runner: LiveRunner,
  cursor: PublicKeyT,
  opts: ErVisibilityOpts = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info: any = await runner.erConn.getAccountInfo(cursor, "confirmed");
    if (info && info.owner && info.owner.equals(runner.programId)) {
      return true;
    }
    await sleep(intervalMs);
  }
  throw new Error("ER visibility timeout: cursor never surfaced under PROGRAM_ID on the ER RPC");
}

/** Options for a full live-match run (extended in S3-T5..T7). */
export interface RunLiveMatchOpts {
  /** The funded keeper keypair (shared wallet). Required unless a runner is injected. */
  keypair?: KeypairT;
  /** Inject a pre-built runner (tests / cron reuse). */
  runner?: LiveRunner;
  /** Program factory seam forwarded to createLiveRunner. */
  programFactory?: ProgramFactory;
  /** The live-match IDL (forwarded to createLiveRunner). */
  idl?: Idl;
}

/**
 * Drive ONE live match pool through its lifecycle. S3-T5 lands the delegation
 * phase: read the pool's `num_calls`, gather its seats, HARD GATE on
 * player_count<2 (→ void+refund branch, wired in S3-T7), otherwise delegate the
 * ER working set and wait for the ER to surface the delegated cursor. The
 * ER-gameplay (S3-T6) and end→settle/void (S3-T7) phases extend from here.
 */
export async function runLiveMatch(
  poolPda: PublicKeyT,
  opts: RunLiveMatchOpts = {},
): Promise<RunReport> {
  const runner =
    opts.runner ??
    createLiveRunner({
      keypair: opts.keypair ?? Keypair.generate(),
      idl: opts.idl,
      programFactory: opts.programFactory,
    });

  const cursor = liveCursorPda(poolPda);

  // Read num_calls off the pool (how many Call PDAs to delegate).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool: any = await runner.step("read_pool", () =>
    (runner.base as any).account.livePool.fetch(poolPda),
  );
  const numCalls = Number(pool?.numCalls ?? 0);

  const seats = await gatherSeats(runner.base, poolPda);

  const del = await delegateAll(runner, { pool: poolPda, cursor, seats, numCalls });
  if (del.branch === "void") {
    // Under-filled pool → void+refund (the on-chain tx lands in S3-T7).
    return runner.report;
  }

  // ER-visibility gate: block until the ER sees the delegated cursor.
  await runner.step("er_visibility", () => awaitErVisibility(runner, cursor));

  // ER gameplay (S3-T6) and end→settle/void (S3-T7) extend from here.
  return runner.report;
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring create-match-pool.ts:237-238.
const isMain = process.argv[1]?.endsWith("live-runner.ts");
if (isMain) {
  // A minimal manual entry point; real cron wiring lands in S3-T8.
  (async () => {
    const idl = loadLiveIdl();
    void idl;
    console.error("live-runner: CLI entry is a stub until S3-T5..T8 wire the phases.");
    process.exit(1);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
