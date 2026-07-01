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
import { liveEntryPda, callPda, liveCursorPda, jackpotPda } from "./live-pda.js";
import {
  CallKind,
  callSpec,
  mapOutcomeToOption,
  shouldVoidOnGoal,
  detectPhase,
  latestEvent,
  goalTotal,
  goalSides,
  watchedTotal,
  firstGoalSide,
  pickCallKind,
  VOID_OUTCOME,
  type GoalDeltas,
  type FirstGoalSide,
} from "./live-feed.js";
import type { ScoreEvent } from "../spike/src/discover.js";
import type { Program as AnchorProgramT } from "@coral-xyz/anchor";

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
/**
 * "No call is open" sentinel for `LiveCursor.open_seq` (u32::MAX). The
 * single-open invariant: an `open_call` is only legal when `open_seq === NONE_SEQ`.
 */
export const NONE_SEQ = 4_294_967_295;

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
 * Gather a pool's player seats on the BASE layer, OWNER-AGNOSTICALLY.
 *
 * *** WHY NOT `liveEntry.all(...)` *** — Anchor's `.all()` is a
 * `getProgramAccounts` under OUR program id, i.e. owner-scoped. While a pool is
 * delegated to the MagicBlock ER, every LiveEntry's base-layer `.owner` flips to
 * the Delegation Program (`DELeGG…`) — the data stays fully readable (runtime
 * probe, Finding [2] Fork A) but an owner-scoped scan returns NOTHING. Under
 * `.all()` a delegated live pool reads as 0 seats, and the under-filled gate
 * would VOID A LIVE MATCH MID-PLAY. So we scan BOTH owners (our program + the
 * Delegation Program) with the same discriminator+size+pool filters and merge.
 *
 * Returns the seat PLAYER pubkeys (decoded from raw bytes at offset 8), sorted
 * ascending (settle-order canonical), de-duplicated across the two scans.
 */
export async function gatherSeats(
  baseProgram: ProgramT,
  pool: PublicKeyT,
): Promise<PublicKeyT[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prog: any = baseProgram as any;
  const conn = prog.provider.connection;
  const size: number = prog.account.liveEntry.size;
  const disc = prog.coder.accounts.memcmp("liveEntry");
  const filters = [
    { memcmp: { offset: disc.offset ?? 0, bytes: disc.bytes } },
    { dataSize: size },
    { memcmp: { offset: 40, bytes: pool.toBase58() } }, // LiveEntry.pool@40
  ];
  const owners: PublicKeyT[] = [prog.programId, DELEGATION_PROGRAM];
  const byPlayer = new Map<string, PublicKeyT>();
  for (const owner of owners) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const accounts: any[] = await conn.getProgramAccounts(owner, { filters });
    for (const { account } of accounts) {
      const data: Buffer = account.data;
      if (data.length !== size) continue;
      const player = new PublicKey(data.subarray(8, 40)); // LiveEntry.player@8
      byPlayer.set(player.toBase58(), player);
    }
  }
  return sortSeatsAscending([...byPlayer.values()]);
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

// ─────────────────────────────────────────────────────────────────────────────
// S3-T6 — ER gameplay (open / resolve / score / commit) on the `er` Program
//
// Productionizes proof.ts:209-227. Once the ER surfaces the delegated working
// set, the keeper runs a call cycle on the ER RPC:
//   open_call(seq)  — ONLY when the cursor reports no open call (open_seq==NONE_SEQ)
//                     AND seq matches cursor.next_seq (single-open invariant).
//   resolve_call    — a WINNING OPTION INDEX derived from the TXLINE feed via the
//                     settle.ts:143-159 proof core (viewValidate on the TXORACLE
//                     program), mapped through mapOutcomeToOption; OR the void
//                     sentinel 0xFE when a goal rose under a non-goal call.
//   score_entry     — once per seat, under the account key `cranker` (NOT keeper).
//   commit_live     — a mid-match ER→base checkpoint with the FULL writable
//                     remaining-account set [cursor, ...entries, ...calls].
//
// Account-key notes (do NOT copy-paste the settle/delegate keys here):
//   open_call / resolve_call : { keeper, pool, cursor, call }
//   score_entry              : { cranker, call, entry }   ← `cranker`, not keeper
//   commit_live              : { keeper, pool } + remainingAccounts (all writable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a `CallKind` to the Anchor enum object `open_call` expects. The IDL is
 * snake_case on the wire but Anchor consumes camelCase variant keys, so
 * NextGoal → `{ nextGoal: {} }`, etc. Throws on an unknown kind.
 */
export function erKind(kind: CallKind): Record<string, Record<string, never>> {
  switch (kind) {
    case CallKind.NextGoal:
      return { nextGoal: {} };
    case CallKind.GoalRush:
      return { goalRush: {} };
    case CallKind.CornerSoon:
      return { cornerSoon: {} };
    case CallKind.CardSoon:
      return { cardSoon: {} };
    default:
      throw new Error(`erKind: unknown CallKind ${kind}`);
  }
}

/** The (freshly-read) cursor fields the single-open invariant needs. */
export interface CursorState {
  /** `LiveCursor.open_seq` — NONE_SEQ when no call is open. */
  openSeq: number;
  /** `LiveCursor.next_seq` — the next seq legal to open. */
  nextSeq: number;
}

/** Inputs for an `open_call` on the ER. */
export interface OpenCallInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  call: PublicKeyT;
  seq: number;
  kind: CallKind;
  /** Freshly-read cursor state (enforces the single-open invariant). */
  cursorState: CursorState;
}

/**
 * Open ONE call on the ER, enforcing the single-open invariant BEFORE any tx:
 *   • a call is only opened when `cursorState.openSeq === NONE_SEQ` (no call open)
 *   • and `seq === cursorState.nextSeq` (strictly in-order).
 * A violation returns `null` WITHOUT issuing a tx (never a double-open). On a
 * legal open it submits `open_call(seq, erKind, numOptions, basePoints,
 * answerSecs).accountsPartial({keeper,pool,cursor,call})` through `runner.step`.
 */
export async function openCallOnEr(
  runner: LiveRunner,
  input: OpenCallInput,
): Promise<string | null> {
  const { pool, cursor, call, seq, kind, cursorState } = input;
  // Single-open invariant — refuse (no tx) on any violation.
  if (cursorState.openSeq !== NONE_SEQ) return null;
  if (seq !== cursorState.nextSeq) return null;

  const spec = callSpec(kind);
  const keeper = runner.keeper;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.er as any).methods;
  return runner.step(`open_call(${seq})`, () =>
    methods
      .openCall(seq, erKind(kind), spec.numOptions, spec.basePoints, spec.answerSecs)
      .accountsPartial({ keeper, pool, cursor, call })
      .rpc(),
  );
}

/**
 * The proof/feed context `resolveOutcomeIndex` consumes. It carries the feed
 * deltas (already derived from the TXLINE score history), the cumulative goal
 * totals bracketing the call's open window (for the void-on-goal check), and the
 * TXORACLE `program` + a `viewValidate` seam. In production the caller wires
 * `program = ctx.program` (Txoracle 6pW64gN…) and `viewValidate` = the
 * validate.ts implementation over a `fetchStatValidation` payload; tests inject
 * a spy that records the program handed to it.
 */
export interface ResolveContext {
  /** Goal/watched deltas since the call opened (fed to mapOutcomeToOption). */
  deltas: GoalDeltas;
  /** Cumulative goal total when the call OPENED. */
  prevGoals: number;
  /** Cumulative goal total NOW (latest event). */
  curGoals: number;
  /**
   * NextGoal ONLY — which side scored FIRST inside the window, derived from
   * event order via `firstGoalSide`. This outranks the cumulative deltas: when
   * BOTH teams score in one window the deltas tie (1–1 reads as "no goal") and
   * would mis-pay; the first scorer is the true outcome. 'both' (a feed batch
   * where the order is unprovable) resolves to a VOID — fair, no guess.
   * When absent (legacy callers), NextGoal falls back to the delta mapping.
   */
  firstSide?: FirstGoalSide;
  /** The TXORACLE program (6pW64gN…) — NEVER the proofbet/live program. */
  program?: AnchorProgramT;
  /**
   * The settle.ts:143-159 proof-core seam. Called only when a kind's predicate
   * must be consulted on-chain; it MUST be handed `ctx.program` (Txoracle). Tests
   * assert exactly that. Optional: pure-delta kinds may resolve without it.
   */
  viewValidate?: (program: AnchorProgramT) => Promise<boolean>;
}

/**
 * Derive the WINNING OPTION INDEX (or the void sentinel 0xFE) for an open call
 * from the resolved feed. This is the single real-money-critical mapping:
 *   1. VOID-ON-GOAL first — if a goal rose while a NON-goal call was open
 *      (shouldVoidOnGoal), return 0xFE. This wins over any option mapping.
 *   2. Otherwise map the feed deltas to a legitimate option index via
 *      `mapOutcomeToOption` (NextGoal home/away/none; binary hit/miss).
 * NEVER returns 0xFF, and never an index ≥ num_options. The proof-core seam
 * (`viewValidate`), when consulted, is always handed the TXORACLE program.
 */
export async function resolveOutcomeIndex(
  kind: CallKind,
  ctx: ResolveContext,
): Promise<number> {
  // (1) Void-on-goal takes precedence for the non-goal kinds.
  if (shouldVoidOnGoal(kind, ctx.prevGoals, ctx.curGoals)) {
    return VOID_OUTCOME;
  }
  // (2) If a predicate seam is provided, run it on the TXORACLE program so the
  // on-chain-proved stat backs the mapping (settle.ts:143-159 posture). The
  // boolean is advisory here — the delta mapping is authoritative for the index —
  // but consulting it proves we always use the Txoracle program, never proofbet.
  if (ctx.viewValidate && ctx.program) {
    await ctx.viewValidate(ctx.program);
  }
  // (3) NextGoal with event-order knowledge: the FIRST scorer wins the call.
  // Both-teams-score no longer collapses to "no goal" (the delta-tie mis-pay);
  // an unorderable same-event batch voids instead of guessing.
  if (kind === CallKind.NextGoal && ctx.firstSide !== undefined) {
    switch (ctx.firstSide) {
      case "home":
        return 0;
      case "away":
        return 2;
      case "both":
        return VOID_OUTCOME;
      case null:
        return 1; // no goal in the window
    }
  }
  return mapOutcomeToOption(kind, ctx.deltas);
}

/** Inputs for a `resolve_call` on the ER. */
export interface ResolveCallInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  call: PublicKeyT;
  seq: number;
  /** A winning option index in [0, num_options) OR the void sentinel 0xFE. */
  outcome: number;
}

/**
 * Submit `resolve_call(outcome).accountsPartial({keeper,pool,cursor,call})` on
 * the ER. `outcome` is a winning option index or 0xFE (passed verbatim). Flows
 * through `runner.step`.
 */
export async function resolveCallOnEr(
  runner: LiveRunner,
  input: ResolveCallInput,
): Promise<string | null> {
  const { pool, cursor, call, seq, outcome } = input;
  const keeper = runner.keeper;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.er as any).methods;
  return runner.step(`resolve_call(${seq})=${outcome}`, () =>
    methods
      .resolveCall(outcome)
      .accountsPartial({ keeper, pool, cursor, call })
      .rpc(),
  );
}

/** Inputs for the per-seat `score_entry` batch. */
export interface ScoreAllInput {
  pool: PublicKeyT;
  call: PublicKeyT;
  /** Seat player pubkeys — each scored once (its own LiveEntry PDA). */
  seats: PublicKeyT[];
}

/**
 * Score EVERY seat for a resolved call: one `score_entry` per seat, under the
 * account key `cranker` (NOT keeper) — `{cranker: keeper, call, entry}`. Every
 * seat must reach `next_score_seq == resolved_count` before settle, so the runner
 * scores the full seat set here. Flows through `runner.step`.
 */
export async function scoreAllSeats(
  runner: LiveRunner,
  input: ScoreAllInput,
): Promise<void> {
  const { pool, call, seats } = input;
  const cranker = runner.keeper;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.er as any).methods;
  for (const player of seats) {
    const entry = liveEntryPda(pool, player);
    await runner.step(`score_entry ${player.toBase58().slice(0, 4)}`, () =>
      methods.scoreEntry().accountsPartial({ cranker, call, entry }).rpc(),
    );
  }
}

/** Inputs for a `commit_live` ER→base checkpoint. */
export interface CommitLiveInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  /** Seat player pubkeys (their entries join the writable set). */
  seats: PublicKeyT[];
  /** Every delegated Call PDA (the full call set joins the writable set). */
  calls: PublicKeyT[];
}

/**
 * Commit the ER working set back to base (proof.ts:225-227) — a mid-match
 * checkpoint that does NOT undelegate. The remaining-account contract is the
 * FULL writable set `[cursor, ...entries, ...calls]` (isSigner:false,
 * isWritable:true), in that order. Flows through `runner.step`.
 */
export async function commitLiveOnEr(
  runner: LiveRunner,
  input: CommitLiveInput,
): Promise<string | null> {
  const { pool, cursor, seats, calls } = input;
  const keeper = runner.keeper;
  const entries = seats.map((player) => liveEntryPda(pool, player));
  const remaining = [cursor, ...entries, ...calls].map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.er as any).methods;
  return runner.step("commit_live", () =>
    methods
      .commitLive()
      .accountsPartial({ keeper, pool })
      .remainingAccounts(remaining)
      .rpc(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// S3-T7 — end→settle→void/refund (BASE)
//
// The full-time (FT) path returns custody to the base layer, then settles ON the
// base layer; the void path abandons the pool and refunds every seat. These two
// terminal branches have DELIBERATELY DIFFERENT remaining_account contracts — a
// copy-paste between them reverts on-chain (plan Risk #3):
//
//   settle_live_pool  : remaining = ENTRIES ONLY, strictly ascending, exactly
//                       player_count, isWritable:FALSE, NO score arg (the program
//                       recomputes the winner on-chain over the passed seats).
//   refund_voided     : remaining = INTERLEAVED [entry_0, player_0, entry_1, …],
//                       entries ascending, length = player_count*2, players
//                       writable (they RECEIVE the refund).
//
// Account-key notes (verified against the on-chain instruction structs):
//   end_and_undelegate : { keeper, pool } + full writable [cursor,...entries,...calls]
//                        (magic_program/magic_context are auto-resolved by Anchor)
//   end_live_pool      : { keeper, pool, cursor }
//   settle_live_pool   : { settleAuthority, jackpot, pool, cursor, feeRecipient }
//   void_live_pool     : { settleAuthority, pool }
//   refund_voided      : { cranker, pool }
// On devnet the single keeper key plays settle_authority + fee_recipient + cranker.
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs for the ER-side `end_and_undelegate` (final commit + ownership return). */
export interface EndAndUndelegateInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  /** Seat player pubkeys (their entries join the writable set). */
  seats: PublicKeyT[];
  /** Every delegated Call PDA. */
  calls: PublicKeyT[];
}

/**
 * Final ER→base commit that ALSO returns ownership of the delegated set to the
 * program (proof.ts:236-237). Accounts `{keeper, pool}`; the remaining-account
 * contract is the SAME full writable set as `commit_live`:
 * `[cursor, ...entries, ...calls]` (isSigner:false, isWritable:true), in order.
 * After this lands the accounts flip back to PROGRAM_ID ownership on base (poll
 * with `pollBaseUndelegated`). Flows through `runner.step`.
 */
export async function endAndUndelegateOnEr(
  runner: LiveRunner,
  input: EndAndUndelegateInput,
): Promise<string | null> {
  const { pool, cursor, seats, calls } = input;
  const keeper = runner.keeper;
  const entries = seats.map((player) => liveEntryPda(pool, player));
  const remaining = [cursor, ...entries, ...calls].map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: true,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.er as any).methods;
  return runner.step("end_and_undelegate", () =>
    methods
      .endAndUndelegate()
      .accountsPartial({ keeper, pool })
      .remainingAccounts(remaining)
      .rpc(),
  );
}

/** Poll cadence for the base-layer undelegation gate (proof.ts:241-243). */
export interface PollBaseOpts {
  /** Poll interval in ms (default 3000). */
  intervalMs?: number;
  /** Overall timeout in ms (default 90000 — first ER→base flip is ~21s). */
  timeoutMs?: number;
}

/**
 * Wait until EVERY passed account has its owner flipped back to our PROGRAM_ID on
 * the BASE RPC (proof.ts:241-243). While any account is missing or still owned by
 * the DELEGATION_PROGRAM, keep polling every `intervalMs` up to `timeoutMs`.
 * Resolves `true` once ALL are PROGRAM_ID-owned; throws on timeout.
 */
export async function pollBaseUndelegated(
  runner: LiveRunner,
  pubkeys: PublicKeyT[],
  opts: PollBaseOpts = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let allReady = true;
    for (const pk of pubkeys) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info: any = await runner.baseConn.getAccountInfo(pk, "confirmed");
      if (!(info && info.owner && info.owner.equals(runner.programId))) {
        allReady = false;
        break;
      }
    }
    if (allReady) return true;
    await sleep(intervalMs);
  }
  throw new Error("base undelegation timeout: an account never returned to PROGRAM_ID ownership on base");
}

/** Inputs for the base-layer `end_live_pool` (Open/Live → Ended). */
export interface EndLivePoolInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
}

/**
 * Mark full-time on the base layer: `end_live_pool` flips the pool to Ended,
 * gating settle. Accounts `{keeper, pool, cursor}`, no args (proof.ts:250-251).
 * Requires no call still open (enforced on-chain). Flows through `runner.step`.
 */
export async function endLivePoolOnBase(
  runner: LiveRunner,
  input: EndLivePoolInput,
): Promise<string | null> {
  const { pool, cursor } = input;
  const keeper = runner.keeper;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.base as any).methods;
  return runner.step("end_live_pool", () =>
    methods.endLivePool().accountsPartial({ keeper, pool, cursor }).rpc(),
  );
}

/** Poll cadence for the on-chain settle-window gate (proof.ts:255-263). */
export interface SettleWindowOpts {
  /** Poll interval in ms (default 5000). */
  intervalMs?: number;
  /** Overall timeout in ms (default 480000). */
  timeoutMs?: number;
}

/**
 * Block until the ON-CHAIN clock passes the pool's settle window
 * (proof.ts:255-263): `getBlockTime(getSlot()) >= settleAfterTs + 1`. NEVER a
 * wall-clock comparison — the on-chain `settle_live_pool` gates on
 * `Clock::get().unix_timestamp >= settle_after_ts`, so we read the same clock and
 * require strictly `settleAfterTs + 1` (a full second past). Resolves `true` once
 * the window opens; throws on timeout.
 */
export async function awaitSettleWindow(
  runner: LiveRunner,
  settleAfterTs: number,
  opts: SettleWindowOpts = {},
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 480_000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const slot = await runner.baseConn.getSlot();
    const bt = await runner.baseConn.getBlockTime(slot);
    if (bt !== null && bt >= settleAfterTs + 1) return true;
    await sleep(intervalMs);
  }
  throw new Error("settle window timeout: on-chain clock never reached settle_after_ts + 1");
}

/** Inputs for the base-layer `settle_live_pool`. */
export interface SettleLivePoolInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  /** Seat player pubkeys (any order — sorted ascending here). */
  seats: PublicKeyT[];
}

/**
 * Settle a finished pool ON the base layer (proof.ts:266-269). The keeper supplies
 * NO score — the program recomputes the winner over every seat, so the remaining
 * accounts are the ENTRY PDAs ONLY, strictly ascending by key, exactly
 * player_count of them, all `isWritable:false`. Accounts:
 * `{settleAuthority, jackpot, pool, cursor, feeRecipient}` (keeper plays both the
 * authority and the recipient on devnet). Flows through `runner.step`.
 *
 * *** Distinct from refund_voided *** — that path passes INTERLEAVED [entry,player]
 * pairs (writable players); this one passes entries-only, non-writable. Do NOT
 * cross the two shapes.
 */
export async function settleLivePoolOnBase(
  runner: LiveRunner,
  input: SettleLivePoolInput,
): Promise<string | null> {
  const { pool, cursor, seats } = input;
  const keeper = runner.keeper;
  // Entries, strictly ascending BY ENTRY KEY (the on-chain monotonicity rule is
  // over the remaining-account keys — i.e. the entry PDAs, not the players).
  const entries = seats
    .map((player) => liveEntryPda(pool, player))
    .sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const remaining = entries.map((pubkey) => ({
    pubkey,
    isSigner: false,
    isWritable: false,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.base as any).methods;
  return runner.step("settle_live_pool", () =>
    methods
      .settleLivePool()
      .accountsPartial({
        settleAuthority: keeper,
        jackpot: jackpotPda(),
        pool,
        cursor,
        feeRecipient: keeper,
      })
      .remainingAccounts(remaining)
      .rpc(),
  );
}

/** Inputs for the base-layer `void_live_pool`. */
export interface VoidLivePoolInput {
  pool: PublicKeyT;
}

/**
 * Void a non-terminal pool on the base layer → refund path (void-contest.ts
 * precedent). Accounts `{settleAuthority, pool}`, no args. The keeper may void any
 * time before settle. Flows through `runner.step`.
 */
export async function voidLivePoolOnBase(
  runner: LiveRunner,
  input: VoidLivePoolInput,
): Promise<string | null> {
  const { pool } = input;
  const keeper = runner.keeper;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.base as any).methods;
  return runner.step("void_live_pool", () =>
    methods.voidLivePool().accountsPartial({ settleAuthority: keeper, pool }).rpc(),
  );
}

/** Inputs for the base-layer `refund_voided`. */
export interface RefundVoidedInput {
  pool: PublicKeyT;
  /** Seat player pubkeys (any order — sorted ascending by entry key here). */
  seats: PublicKeyT[];
}

/**
 * Refund every seat of a Voided pool on the base layer (single-shot, permissionless).
 * Accounts `{cranker, pool}` (keeper cranks on devnet). The remaining accounts are
 * INTERLEAVED `[entry_0, player_0, entry_1, player_1, …]` — entries strictly
 * ascending by key, length = player_count*2, players `isWritable:true` (they
 * RECEIVE the refund). Entries are marked writable too (the on-chain handler binds
 * them by PDA; the pool debits and the player credits). Flows through `runner.step`.
 *
 * *** Distinct from settle_live_pool *** — that path passes entries-only,
 * non-writable, length player_count. Do NOT cross the two shapes.
 */
export async function refundVoidedOnBase(
  runner: LiveRunner,
  input: RefundVoidedInput,
): Promise<string | null> {
  const { pool, seats } = input;
  const keeper = runner.keeper;
  // Sort seats by their ENTRY key (the on-chain ascending rule is over entries).
  const bySeat = seats
    .map((player) => ({ player, entry: liveEntryPda(pool, player) }))
    .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
  const remaining: { pubkey: PublicKeyT; isSigner: boolean; isWritable: boolean }[] = [];
  for (const { player, entry } of bySeat) {
    remaining.push({ pubkey: entry, isSigner: false, isWritable: true });
    remaining.push({ pubkey: player, isSigner: false, isWritable: true });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = (runner.base as any).methods;
  return runner.step("refund_voided", () =>
    methods
      .refundVoided()
      .accountsPartial({ cranker: keeper, pool })
      .remainingAccounts(remaining)
      .rpc(),
  );
}

/** Inputs for the full FT (full-time) finalize path. */
export interface FinalizeFtInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  seats: PublicKeyT[];
  calls: PublicKeyT[];
  /** The pool's `settle_after_ts` (seconds) — the on-chain settle gate. */
  settleAfterTs: number;
  /** Poll-loop overrides (tests inject fast intervals). */
  pollBase?: PollBaseOpts;
  settleWindow?: SettleWindowOpts;
}

/**
 * The full-time terminal path, in the EXACT documented order (plan S3-T7):
 *   1. end_and_undelegate (ER) — final commit + ownership return
 *   2. pollBaseUndelegated — wait until cursor + every entry flip to PROGRAM_ID on base
 *   3. end_live_pool (base) — flip status to Ended
 *   4. awaitSettleWindow — gate on the on-chain clock ≥ settleAfterTs + 1
 *   5. settle_live_pool (base) — entries-only, ascending, non-writable, no score arg
 * Any thrown poll (undelegation / settle-window timeout) aborts the settle.
 */
export async function finalizeFt(
  runner: LiveRunner,
  input: FinalizeFtInput,
): Promise<RunReport> {
  const { pool, cursor, seats, calls, settleAfterTs } = input;
  const entries = seats.map((player) => liveEntryPda(pool, player));

  // 1. ER: final commit + undelegate.
  await endAndUndelegateOnEr(runner, { pool, cursor, seats, calls });
  // 2. Base: wait for cursor + entries to return to PROGRAM_ID ownership.
  await runner.step("base_undelegated", () =>
    pollBaseUndelegated(runner, [cursor, ...entries], input.pollBase),
  );
  // 3. Base: end (Ended).
  await endLivePoolOnBase(runner, { pool, cursor });
  // 4. Base: gate on the on-chain settle window.
  await runner.step("settle_window", () =>
    awaitSettleWindow(runner, settleAfterTs, input.settleWindow),
  );
  // 5. Base: settle (entries-only ascending, no score arg).
  await settleLivePoolOnBase(runner, { pool, cursor, seats });
  return runner.report;
}

/** Inputs for the void+refund terminal path. */
export interface FinalizeVoidInput {
  pool: PublicKeyT;
  /** Seat player pubkeys (may be 0 or 1 for an under-filled pool). */
  seats: PublicKeyT[];
}

/**
 * The void terminal path (plan S3-T7): `void_live_pool` then, iff there is at
 * least one seat to pay back, `refund_voided` with the INTERLEAVED [entry,player]
 * pairs. Reached for `detectPhase === 'void'` OR an under-filled pool
 * (player_count < 2). Zero seats → void only (nothing to refund).
 */
export async function finalizeVoid(
  runner: LiveRunner,
  input: FinalizeVoidInput,
): Promise<RunReport> {
  const { pool, seats } = input;
  await voidLivePoolOnBase(runner, { pool });
  if (seats.length > 0) {
    await refundVoidedOnBase(runner, { pool, seats });
  }
  return runner.report;
}

// ─────────────────────────────────────────────────────────────────────────────
// The RE-ENTRANT match state machine (stress-test fixes F1/F2/F3)
//
// cron drives `runLiveMatch` for every un-terminal pool on every tick, so ONE
// invocation must be a bounded, idempotent STEP that inspects on-chain state and
// advances the pool at most one stage — never assuming it is the first (or only)
// invocation. The dispatch:
//
//   Settled/RolledOver/Voided → no-op (terminal).
//   Ended                     → resume the settle tail (clock-gate → settle). F3
//   Open/Live, now < lock_ts  → no-op: the JOIN WINDOW IS STILL OPEN. Acting
//                               here voided brand-new pools ~30s after creation
//                               (stress finding F1). The on-chain clock
//                               (getBlockTime) gates this — never wall-clock.
//   post-lock, seats < 2      → finalizeVoid (under-filled — safe ONLY post-lock).
//   post-lock, ≥2 seats       → delegate ONCE (skipped when the cursor's base
//                               owner is already the Delegation Program — F2's
//                               re-delegation), then ONE feed-driven gameplay
//                               step: void an orphaned open call / run one full
//                               call cycle / finalize at FT or feed-void.
// ─────────────────────────────────────────────────────────────────────────────

/** The TxLINE score-history seam (production: getScoreHistory; tests: fixtures). */
export type FetchEvents = (fixtureId: number) => Promise<ScoreEvent[]>;

/** The Txoracle proof seam forwarded into `resolveOutcomeIndex`. */
export interface OracleSeam {
  /** The TXORACLE program (6pW64gN…) — NEVER the proofbet/live program. */
  program: AnchorProgramT;
  viewValidate?: (program: AnchorProgramT) => Promise<boolean>;
}

/** Options for a full live-match run. */
export interface RunLiveMatchOpts {
  /** The funded keeper keypair (shared wallet). Required unless a runner is injected. */
  keypair?: KeypairT;
  /** Inject a pre-built runner (tests / cron reuse). */
  runner?: LiveRunner;
  /** Program factory seam forwarded to createLiveRunner. */
  programFactory?: ProgramFactory;
  /** The live-match IDL (forwarded to createLiveRunner). */
  idl?: Idl;
  /** REQUIRED for gameplay: the TxLINE score-history seam. Loud-fails if absent. */
  fetchEvents?: FetchEvents;
  /** On-chain clock seam (default: base getSlot → getBlockTime). */
  now?: (runner: LiveRunner) => Promise<number | null>;
  /** Sleep seam for the in-tick answer window (default: real setTimeout). */
  sleepFn?: (ms: number) => Promise<void>;
  /** Extra seconds past answer_secs before resolving (default 3). */
  resolveBufferSecs?: number;
  /** Txoracle proof seam. */
  oracle?: OracleSeam;
  erVisibility?: ErVisibilityOpts;
  pollBase?: PollBaseOpts;
  settleWindow?: SettleWindowOpts;
}

/**
 * The on-chain clock: `getBlockTime(getSlot())` on the BASE connection. All
 * time-gating (lock_ts, settle windows) reads THIS, never wall-clock — the
 * validator clock lags wall time under load (plan Reference data).
 */
export async function chainNow(runner: LiveRunner): Promise<number | null> {
  const slot = await runner.baseConn.getSlot();
  return runner.baseConn.getBlockTime(slot);
}

/** Decode an Anchor enum object ({open:{}} …) into its variant name. */
export function poolStatusOf(pool: unknown): string {
  const status = (pool as { status?: Record<string, unknown> })?.status;
  if (!status || typeof status !== "object") return "unknown";
  return Object.keys(status)[0] ?? "unknown";
}

/**
 * The base-layer owner of a PDA: 'program' (ours — not delegated), 'delegated'
 * (the Delegation Program owns it), or 'missing'. Drives delegate-once (F2).
 */
export async function baseOwnerOf(
  runner: LiveRunner,
  pda: PublicKeyT,
): Promise<"program" | "delegated" | "missing"> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info: any = await runner.baseConn.getAccountInfo(pda, "confirmed");
  if (!info || !info.owner) return "missing";
  if (info.owner.equals(runner.programId)) return "program";
  if (info.owner.equals(DELEGATION_PROGRAM)) return "delegated";
  return "missing";
}

/** The cursor fields the gameplay step needs, read off the ER. */
export async function readErCursorState(
  runner: LiveRunner,
  cursor: PublicKeyT,
): Promise<CursorState | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any = await runner.step("read_er_cursor", () =>
    (runner.er as any).account.liveCursor.fetch(cursor),
  );
  if (!row) return null;
  return { openSeq: Number(row.openSeq), nextSeq: Number(row.nextSeq) };
}

/** Inputs for one full in-tick call cycle (open → window → resolve → score → commit). */
export interface RunCallCycleInput {
  pool: PublicKeyT;
  cursor: PublicKeyT;
  seats: PublicKeyT[];
  calls: PublicKeyT[];
  fixtureId: number;
  /** Freshly-read cursor state (the cycle opens cursorState.nextSeq). */
  cursorState: CursorState;
  /** The events already fetched THIS tick (the open-time baseline). */
  baselineEvents: ScoreEvent[];
  fetchEvents: FetchEvents;
  sleepFn: (ms: number) => Promise<void>;
  resolveBufferSecs: number;
  oracle?: OracleSeam;
}

/**
 * ONE full call cycle inside a single tick: open the next call, wait out its
 * answer window (+ a resolve buffer), re-poll the feed, derive the outcome
 * (first-goal order for NextGoal; watched-delta for binary kinds; void-on-goal
 * where a goal invalidates the window), then resolve → score every seat →
 * commit. Holding the open-time baseline IN MEMORY makes the outcome derivation
 * exact; a call this process did NOT open is never resolved here (orphans are
 * voided by the state machine instead, where no baseline can be reconstructed).
 */
export async function runCallCycle(
  runner: LiveRunner,
  input: RunCallCycleInput,
): Promise<{ opened: boolean; outcome?: number }> {
  const { pool, cursor, seats, calls, fixtureId, cursorState } = input;
  const seq = cursorState.nextSeq;
  const kind = pickCallKind(seq);
  const call = callPda(pool, seq);

  const baselineStats = latestEvent(input.baselineEvents)?.Stats ?? {};
  const baseSides = goalSides(baselineStats);
  const baseGoals = goalTotal(baselineStats);
  const baseWatched = watchedTotal(kind, baselineStats);
  const baseSeq = latestEvent(input.baselineEvents)?.Seq ?? Number.NEGATIVE_INFINITY;

  const opened = await openCallOnEr(runner, { pool, cursor, call, seq, kind, cursorState });
  if (opened === null) return { opened: false };

  // Wait out the answer window + resolve buffer (players are tapping on the ER).
  const spec = callSpec(kind);
  await input.sleepFn((spec.answerSecs + input.resolveBufferSecs) * 1000);

  // Re-poll the feed and derive the outcome against the open-time baseline.
  const events = await input.fetchEvents(fixtureId);
  const nowStats = latestEvent(events)?.Stats ?? {};
  const windowEvents = events.filter((e) => e.Seq > baseSeq);

  const ctx: ResolveContext = {
    deltas:
      kind === CallKind.NextGoal
        ? {
            homeGoals: goalSides(nowStats).home - baseSides.home,
            awayGoals: goalSides(nowStats).away - baseSides.away,
          }
        : { watched: watchedTotal(kind, nowStats) - baseWatched },
    prevGoals: baseGoals,
    curGoals: goalTotal(nowStats),
    firstSide: kind === CallKind.NextGoal ? firstGoalSide(windowEvents, baseSides) : undefined,
    program: input.oracle?.program,
    viewValidate: input.oracle?.viewValidate,
  };
  const outcome = await resolveOutcomeIndex(kind, ctx);

  await resolveCallOnEr(runner, { pool, cursor, call, seq, outcome });
  await scoreAllSeats(runner, { pool, call, seats });
  await commitLiveOnEr(runner, { pool, cursor, seats, calls });
  return { opened: true, outcome };
}

/**
 * Drive ONE live match pool ONE bounded, idempotent step (see the state-machine
 * dispatch above). cron invokes this per pool per tick under a per-pool
 * in-flight guard; a keeper crash at any point resumes cleanly on the next tick
 * because every branch re-derives its decision from on-chain + feed state.
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
  const sleepFn = opts.sleepFn ?? sleep;
  const nowFn = opts.now ?? chainNow;
  const resolveBufferSecs = opts.resolveBufferSecs ?? 3;

  const cursor = liveCursorPda(poolPda);

  // Read the pool off BASE: status drives the dispatch; lock/settle gate action.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool: any = await runner.step("read_pool", () =>
    (runner.base as any).account.livePool.fetch(poolPda),
  );
  if (!pool) return runner.report; // unreadable pool → try again next tick
  const status = poolStatusOf(pool);
  const numCalls = Number(pool.numCalls ?? 0);
  const lockTs = Number(pool.lockTs ?? 0);
  const settleAfterTs = Number(pool.settleAfterTs ?? 0);
  const fixtureId = Number(pool.fixtureId ?? 0);

  // Terminal states — nothing to do.
  if (status === "settled" || status === "rolledOver" || status === "voided") {
    return runner.report;
  }

  const seats = await gatherSeats(runner.base, poolPda);
  const calls = Array.from({ length: numCalls }, (_, s) => callPda(poolPda, s));

  // F3 — Ended: the pool is past gameplay (undelegated by the end path). Resume
  // the settle tail; NEVER re-delegate.
  if (status === "ended") {
    await runner.step("settle_window", () =>
      awaitSettleWindow(runner, settleAfterTs, opts.settleWindow),
    );
    await settleLivePoolOnBase(runner, { pool: poolPda, cursor, seats });
    return runner.report;
  }

  // F1 — the JOIN WINDOW gate: while the on-chain clock is before lock_ts the
  // pool is still filling. Do NOTHING (especially not void). An unreadable
  // clock also waits — never act blind on a money path.
  const now = await runner.step("chain_now", () => nowFn(runner));
  if (now === null || now < lockTs) return runner.report;

  // Post-lock, under-filled → void + refund (works even if already delegated:
  // LivePool is never delegated and refund_voided reads entries owner-agnostically).
  if (seats.length < 2) {
    await finalizeVoid(runner, { pool: poolPda, seats });
    return runner.report;
  }

  // F2 — delegate exactly once: skip when the cursor's base owner already IS
  // the Delegation Program (a delegate re-issue reverts and wastes the tick).
  const owner = await runner.step("read_cursor_owner", () => baseOwnerOf(runner, cursor));
  if (owner === "program") {
    await delegateAll(runner, { pool: poolPda, cursor, seats, numCalls });
    await runner.step("er_visibility", () =>
      awaitErVisibility(runner, cursor, opts.erVisibility),
    );
  } else if (owner === "missing") {
    return runner.report; // malformed pool (no cursor) — nothing safe to do
  }

  // ── ONE feed-driven gameplay step ──
  if (!opts.fetchEvents) {
    // Loud failure (caught by cron's tick try/catch): delegated pools MUST have
    // a feed or the match can never resolve. Silence here would strand the pot.
    throw new Error("runLiveMatch: opts.fetchEvents is required for gameplay");
  }
  const events = await runner.step("fetch_events", () => opts.fetchEvents!(fixtureId));
  if (events === null) return runner.report; // feed hiccup — retry next tick
  const latest = latestEvent(events);
  const phase = latest ? detectPhase(latest) : "live";

  // Feed says the MATCH is void/abandoned → void + refund.
  if (phase === "void") {
    await finalizeVoid(runner, { pool: poolPda, seats });
    return runner.report;
  }

  const cursorState = await readErCursorState(runner, cursor);
  if (!cursorState) return runner.report; // ER unreadable — retry next tick

  // An open call on tick ENTRY is an ORPHAN (a healthy cycle closes its call
  // within its own tick): the open-time baseline died with the previous keeper
  // process, so the outcome is unprovable. Void it — fair, nobody penalized —
  // then score + commit so coverage still advances.
  if (cursorState.openSeq !== NONE_SEQ) {
    const orphan = callPda(poolPda, cursorState.openSeq);
    await resolveCallOnEr(runner, {
      pool: poolPda,
      cursor,
      call: orphan,
      seq: cursorState.openSeq,
      outcome: VOID_OUTCOME,
    });
    await scoreAllSeats(runner, { pool: poolPda, call: orphan, seats });
    await commitLiveOnEr(runner, { pool: poolPda, cursor, seats, calls });
  } else if (phase === "live" && cursorState.nextSeq < numCalls) {
    // No open call, match live, calls remaining → run ONE full call cycle.
    await runCallCycle(runner, {
      pool: poolPda,
      cursor,
      seats,
      calls,
      fixtureId,
      cursorState,
      baselineEvents: events,
      fetchEvents: opts.fetchEvents,
      sleepFn,
      resolveBufferSecs,
      oracle: opts.oracle,
    });
    return runner.report;
  }

  // Full-time (with no call left open) → the FT terminal path.
  if (phase === "ft") {
    await finalizeFt(runner, {
      pool: poolPda,
      cursor,
      seats,
      calls,
      settleAfterTs,
      pollBase: opts.pollBase,
      settleWindow: opts.settleWindow,
    });
  }
  // 'ht' (or paced out / all calls played) → wait for the next tick.
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
