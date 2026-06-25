/**
 * Phase 3 — fetch the three-stage Merkle proof and validate it on-chain via
 * Txoracle.validateStat (read-only .view() → boolean).
 *
 * Arg mapping (verbatim from examples/onchain-validation), note the field renames:
 *   ts               <- summary.updateStats.minTimestamp
 *   fixtureSummary   <- { fixtureId, updateStats, eventsSubTreeRoot:eventStatsSubTreeRoot }
 *   fixtureProof     <- validation.subTreeProof   (NB: API "subTreeProof" → arg "fixture_proof")
 *   mainTreeProof    <- validation.mainTreeProof
 *   stat_a           <- { statToProve, eventStatRoot, statProof }
 *   stat_b (2-stat)  <- { statToProve2, eventStatRoot, statProof2 }
 */

import * as anchor from "@coral-xyz/anchor";
import anchorDefault from "@coral-xyz/anchor";
import { ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import type { Auth, SpikeContext } from "./auth.js";

// `BN` is exposed on the CJS default export (not the ESM namespace) — see README.
const BN = anchorDefault.BN;
import { SEED, VALIDATE_STAT_CU } from "./config.js";
import { txline } from "./util.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type Comparison = "greaterThan" | "lessThan" | "equalTo";
export type BinaryOp = "add" | "subtract";

export interface ProofNodeRaw {
  hash: unknown;
  isRightSibling: boolean;
}
export interface ScoreStatRaw {
  key: number;
  value: number;
  period: number;
}
export interface ScoresStatValidation {
  ts: number;
  statToProve: ScoreStatRaw;
  eventStatRoot: unknown;
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: unknown;
  };
  statProof: ProofNodeRaw[];
  subTreeProof: ProofNodeRaw[];
  mainTreeProof: ProofNodeRaw[];
  statToProve2?: ScoreStatRaw;
  statProof2?: ProofNodeRaw[];
}

export interface StatValidationParams {
  fixtureId: number;
  seq: number;
  statKey: number;
  statKey2?: number;
}

/**
 * Normalise the API's binary-string hash fields into a 32-byte number[] for the
 * IDL's `[u8;32]`. Accepts number[]/Buffer/Uint8Array, Node Buffer-JSON, base64,
 * or hex — whatever the endpoint actually returns.
 */
export function toBytes32(x: unknown): number[] {
  let bytes: Uint8Array;
  if (x == null) throw new Error("hash field is null/undefined");
  if (Array.isArray(x)) bytes = Uint8Array.from(x as number[]);
  else if (x instanceof Uint8Array) bytes = x;
  else if (typeof x === "object" && Array.isArray((x as { data?: number[] }).data)) {
    bytes = Uint8Array.from((x as { data: number[] }).data); // {type:'Buffer',data:[...]}
  } else if (typeof x === "string") {
    bytes = /^[0-9a-fA-F]{64}$/.test(x)
      ? Uint8Array.from(Buffer.from(x, "hex"))
      : Uint8Array.from(Buffer.from(x, "base64"));
  } else {
    throw new Error(`unrecognised hash encoding: ${typeof x}`);
  }
  if (bytes.length !== 32) {
    throw new Error(`expected 32-byte hash, got ${bytes.length} bytes`);
  }
  return Array.from(bytes);
}

const mapNodes = (nodes: ProofNodeRaw[] = []) =>
  nodes.map((n) => ({ hash: toBytes32(n.hash), isRightSibling: n.isRightSibling }));

const scoreStat = (s: ScoreStatRaw) => ({ key: s.key, value: s.value, period: s.period });

/** GET the three-stage Merkle proof for one (or two) statistic(s). */
export async function fetchStatValidation(
  ctx: SpikeContext,
  a: Auth,
  p: StatValidationParams,
): Promise<ScoresStatValidation> {
  return txline<ScoresStatValidation>("/api/scores/stat-validation", {
    baseUrl: ctx.baseUrl,
    jwt: a.jwt,
    apiToken: a.apiToken,
    query: {
      fixtureId: p.fixtureId,
      seq: p.seq,
      statKey: p.statKey,
      statKey2: p.statKey2,
    },
  });
}

/** Derive the per-day daily_scores_roots PDA from the batch's min timestamp. */
export function dailyScoresPda(programId: PublicKey, minTimestampMs: number): PublicKey {
  const epochDay = Math.floor(minTimestampMs / DAY_MS);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.DAILY_SCORES_ROOTS), new BN(epochDay).toBuffer("le", 2)],
    programId,
  );
  return pda;
}

interface BaseArgs {
  ts: anchor.BN;
  fixtureSummary: unknown;
  fixtureProof: unknown;
  mainTreeProof: unknown;
  statA: unknown;
  statB: unknown | null;
  pda: PublicKey;
  /** LHS the predicate threshold is compared against (a, or a OP b). */
  lhs: number;
  valueA: number;
  valueB: number | null;
}

/**
 * Build the positional validateStat args from a validation payload.
 * `op` is required when `validation.statToProve2` is present (two-stat predicate).
 */
export function buildBaseArgs(
  v: ScoresStatValidation,
  programId: PublicKey,
  op: BinaryOp | null,
): BaseArgs {
  const ts = new BN(v.summary.updateStats.minTimestamp);
  const fixtureSummary = {
    fixtureId: new BN(v.summary.fixtureId),
    updateStats: {
      updateCount: v.summary.updateStats.updateCount,
      minTimestamp: new BN(v.summary.updateStats.minTimestamp),
      maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
    },
    eventsSubTreeRoot: toBytes32(v.summary.eventStatsSubTreeRoot),
  };
  const fixtureProof = mapNodes(v.subTreeProof);
  const mainTreeProof = mapNodes(v.mainTreeProof);
  const eventStatRoot = toBytes32(v.eventStatRoot);
  const statA = {
    statToProve: scoreStat(v.statToProve),
    eventStatRoot,
    statProof: mapNodes(v.statProof),
  };

  const valueA = v.statToProve.value;
  let statB: unknown | null = null;
  let valueB: number | null = null;
  let lhs = valueA;

  if (v.statToProve2 && v.statProof2) {
    if (!op) throw new Error("two-stat validation requires an op (add|subtract)");
    statB = {
      statToProve: scoreStat(v.statToProve2),
      eventStatRoot,
      statProof: mapNodes(v.statProof2),
    };
    valueB = v.statToProve2.value;
    lhs = op === "add" ? valueA + valueB : valueA - valueB;
  }

  return {
    ts,
    fixtureSummary,
    fixtureProof,
    mainTreeProof,
    statA,
    statB,
    pda: dailyScoresPda(programId, v.summary.updateStats.minTimestamp),
    lhs,
    valueA,
    valueB,
  };
}

const opEnum = (op: BinaryOp | null) => (op ? { [op]: {} } : null);
const predicate = (threshold: number, comparison: Comparison) => ({
  threshold,
  comparison: { [comparison]: {} },
});

/** Run validateStat read-only and return the boolean. */
export async function viewValidate(
  program: anchor.Program,
  base: BaseArgs,
  pred: { threshold: number; comparison: { [k: string]: object } },
  op: BinaryOp | null,
): Promise<boolean> {
  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: VALIDATE_STAT_CU });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (program.methods as any)
    .validateStat(
      base.ts,
      base.fixtureSummary,
      base.fixtureProof,
      base.mainTreeProof,
      pred,
      base.statA,
      base.statB,
      opEnum(op),
    )
    .accounts({ dailyScoresMerkleRoots: base.pda })
    .preInstructions([computeBudgetIx])
    .view();
}

export interface DirectionalResult {
  lhs: number;
  valueA: number;
  valueB: number | null;
  truthy: boolean; // expected true
  falsy: boolean; // expected false
}

/** Prove both directions: a predicate that must be TRUE and one that must be FALSE. */
export async function runDirectionalChecks(
  program: anchor.Program,
  v: ScoresStatValidation,
  programId: PublicKey,
  op: BinaryOp | null,
): Promise<DirectionalResult> {
  const base = buildBaseArgs(v, programId, op);
  const truthy = await viewValidate(program, base, predicate(base.lhs - 1, "greaterThan"), op);
  const falsy = await viewValidate(program, base, predicate(base.lhs + 1, "greaterThan"), op);
  return { lhs: base.lhs, valueA: base.valueA, valueB: base.valueB, truthy, falsy };
}

export interface TamperResult {
  rejected: boolean; // true if a corrupted proof was rejected (threw or returned false)
  detail: string;
}

/** Flip a byte in a proof node and confirm the program rejects it. */
export async function runTamperCheck(
  program: anchor.Program,
  v: ScoresStatValidation,
  programId: PublicKey,
  op: BinaryOp | null,
): Promise<TamperResult> {
  const base = buildBaseArgs(v, programId, op);
  // Tamper the first available proof node (main → fixture → stat), else the root.
  const target =
    (base.mainTreeProof as { hash: number[] }[])[0] ??
    (base.fixtureProof as { hash: number[] }[])[0] ??
    ((base.statA as { statProof: { hash: number[] }[] }).statProof[0] as { hash: number[] });
  let where = "proof node hash";
  if (target?.hash) {
    target.hash[0] = target.hash[0] ^ 0xff;
  } else {
    (base.statA as { eventStatRoot: number[] }).eventStatRoot[0] ^= 0xff;
    where = "eventStatRoot";
  }
  try {
    const r = await viewValidate(program, base, predicate(base.lhs - 1, "greaterThan"), op);
    return { rejected: r === false, detail: `tampered ${where} → view returned ${r}` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const firstLine = msg.split("\n").map((s) => s.trim()).find(Boolean) ?? "view simulation reverted";
    return { rejected: true, detail: `tampered ${where} → rejected (${firstLine})` };
  }
}
