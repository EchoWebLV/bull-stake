/**
 * ProofBet settlement keeper.
 *
 * Reuses the spike's validate path (TxLINE three-stage Merkle proof ->
 * Txoracle.validateStat .view()) to derive a market's winning bucket, then
 * submits `settle` (or `void_market` for abandoned fixtures) to proofbet.
 *
 * Modes:
 *   tsx settle.ts --compute-only --fixture <id> --seq <n> --stat <k> \
 *        [--stat2 <k>] [--op add|subtract] --threshold <t> [--cmp greaterThan|lessThan|equalTo]
 *   tsx settle.ts <marketPubkey> [--dry-run]
 *
 * Exported:
 *   settleMarketByPubkey(ctx, auth, proofbet, marketPubkey, { dryRun })
 *     — reusable core for settle-all.ts
 */

import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import anchorDefault from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getScoreHistory, resolvePhase } from "../spike/src/discover.js";
import {
  fetchStatValidation, buildBaseArgs, viewValidate, dailyScoresPda,
  type BinaryOp, type Comparison,
} from "../spike/src/validate.js";
import { FINISHED_PHASES, VOID_PHASES, PHASE_NAME } from "../spike/src/config.js";
import type { Auth, SpikeContext } from "../spike/src/auth.js";

const BN = anchorDefault.BN;

interface Flags { [k: string]: string | boolean; }

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const opFromFlag = (s?: string): BinaryOp | null =>
  s === "add" || s === "subtract" ? s : null;
const opFromAnchor = (o: { add?: object; subtract?: object } | null): BinaryOp | null =>
  o == null ? null : "add" in o ? "add" : "subtract";
const cmpFromFlag = (s?: string): Comparison =>
  s === "lessThan" || s === "equalTo" ? s : "greaterThan";

/** Anchor enum {greaterThan:{}} -> spike's {greaterThan:{}} (identical wire form). */
type PredObj = { threshold: number; comparison: { [k: string]: object } };

/**
 * Load the proofbet IDL and build an Anchor Program from an existing provider.
 * Called by both settle.ts (main) and settle-all.ts.
 */
export function loadProofbetProgram(provider: anchor.AnchorProvider): anchor.Program {
  const idlPath = (process.env.PROOFBET_IDL ?? "../target/idl/proofbet.json");
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  return new anchor.Program(idl as anchor.Idl, provider);
}

export type SettleResult =
  | { action: "settled"; sig: string; winningBucket: number; lhs: number }
  | { action: "voided"; sig: string }
  | { action: "skipped"; reason: string }
  | { action: "dry-run-settle"; winningBucket: number; lhs: number }
  | { action: "dry-run-void" };

/**
 * Reusable core: settle (or void) a single market by its on-chain public key.
 *
 * @param ctx         - SpikeContext (wallet, connection, etc.)
 * @param auth        - Authenticated {jwt, apiToken}
 * @param proofbet    - Anchor Program for the proofbet program
 * @param marketPubkey - The market account public key
 * @param opts.dryRun  - If true, compute + log but do not submit any tx
 * @param phaseInfo   - Optional pre-fetched phase info (skip if settled/closed check done externally)
 */
export async function settleMarketByPubkey(
  ctx: SpikeContext,
  auth: Auth,
  proofbet: anchor.Program,
  marketPubkey: PublicKey,
  opts: { dryRun: boolean },
): Promise<SettleResult> {
  const { dryRun } = opts;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const market: any = await (proofbet.account as any).market.fetch(marketPubkey);

  if (!market.settleAuthority.equals(ctx.wallet.publicKey)) {
    console.warn(`WARNING: wallet ${ctx.wallet.publicKey.toBase58()} is not the settle_authority ` +
      `(${market.settleAuthority.toBase58()}); the transaction will fail unless you control that key.`);
  }

  const fixtureId = market.fixtureId.toNumber();
  const statKey = market.statKey as number;
  const statKey2 = market.statKey2 == null ? undefined : (market.statKey2 as number);
  const op = opFromAnchor(market.op);

  // Find the fixture's terminal event.
  const events = await getScoreHistory(ctx, auth, fixtureId);
  const withPhase = events.map((ev) => ({ ev, ...resolvePhase(ev) }));
  const finished = withPhase
    .filter((e) => e.code !== null && FINISHED_PHASES.has(e.code))
    .sort((a, b) => b.ev.Seq - a.ev.Seq)[0];
  const voided = withPhase
    .filter((e) => e.code !== null && VOID_PHASES.has(e.code))
    .sort((a, b) => b.ev.Seq - a.ev.Seq)[0];

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketPubkey.toBuffer()], proofbet.programId);

  if (!finished && voided) {
    const seq = voided.ev.Seq;
    const ts = Number(voided.ev.Ts ?? 0);
    console.log(JSON.stringify({ action: "void_market", fixtureId, seq, ts, phase: voided.label }, null, 2));
    if (dryRun) return { action: "dry-run-void" };
    const sig = await proofbet.methods.voidMarket(seq, new BN(ts))
      .accountsStrict({ settleAuthority: ctx.wallet.publicKey, market: marketPubkey })
      .rpc();
    console.log(`voided: ${sig}`);
    return { action: "voided", sig };
  }

  if (!finished) {
    console.log(JSON.stringify({ action: "none", reason: "fixture not final yet", fixtureId }, null, 2));
    return { action: "skipped", reason: "fixture not final yet" };
  }

  const seq = finished.ev.Seq;
  const v = await fetchStatValidation(ctx, auth, { fixtureId, seq, statKey, statKey2 });
  const base = buildBaseArgs(v, ctx.program.programId, op);
  const pred: PredObj = { threshold: market.threshold as number, comparison: market.comparison };
  const truthy = await viewValidate(ctx.program, base, pred, op);
  const winningBucket = truthy ? 0 : 1;
  const settledTs = v.summary.updateStats.minTimestamp; // ms (matches on-chain settled_ts unit)
  const settledValue = base.lhs;

  console.log(JSON.stringify({
    action: "settle", fixtureId, seq, statKey, statKey2, op,
    threshold: market.threshold, lhs: base.lhs, predicateTrue: truthy,
    winningBucket, settledTs, settledValue,
    dailyScoresPda: dailyScoresPda(ctx.program.programId, settledTs).toBase58(),
  }, null, 2));
  if (dryRun) return { action: "dry-run-settle", winningBucket, lhs: settledValue };

  const sig = await proofbet.methods
    .settle(winningBucket, seq, new BN(settledTs), settledValue)
    .accountsStrict({
      settleAuthority: ctx.wallet.publicKey,
      market: marketPubkey,
      vault: vaultPda,
      feeRecipient: market.feeRecipient,
    })
    .rpc();
  console.log(`settled: ${sig}`);
  return { action: "settled", sig, winningBucket, lhs: settledValue };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const ctx = createContext();
  const auth = await authenticateCached(ctx);

  // -- compute-only: reproduce the spike's result for explicit predicate flags --
  if (flags["compute-only"]) {
    const fixtureId = Number(flags.fixture);
    const seq = Number(flags.seq);
    const statKey = Number(flags.stat);
    const statKey2 = flags.stat2 != null ? Number(flags.stat2) : undefined;
    const op = opFromFlag(flags.op as string | undefined);
    const threshold = Number(flags.threshold);
    const comparison = cmpFromFlag(flags.cmp as string | undefined);

    const v = await fetchStatValidation(ctx, auth, { fixtureId, seq, statKey, statKey2 });
    const base = buildBaseArgs(v, ctx.program.programId, op);
    const pred: PredObj = { threshold, comparison: { [comparison]: {} } };
    const truthy = await viewValidate(ctx.program, base, pred, op);
    const bucket = truthy ? 0 : 1; // OVER=0 (TRUE), UNDER=1 (FALSE)
    console.log(JSON.stringify({
      mode: "compute-only", fixtureId, seq, statKey, statKey2, op, threshold, comparison,
      lhs: base.lhs, predicateTrue: truthy, winningBucket: bucket,
      settledTs: v.summary.updateStats.minTimestamp,
      dailyScoresPda: dailyScoresPda(ctx.program.programId, v.summary.updateStats.minTimestamp).toBase58(),
    }, null, 2));
    return;
  }

  // -- market mode: fetch the on-chain market and settle it --
  if (positional.length === 0) {
    throw new Error("usage: settle.ts <marketPubkey> [--dry-run]  |  settle.ts --compute-only ...");
  }
  const marketKey = new PublicKey(positional[0]);
  const dryRun = !!flags["dry-run"];

  const proofbet = loadProofbetProgram(ctx.provider);
  await settleMarketByPubkey(ctx, auth, proofbet, marketKey, { dryRun });
}

main().catch((e) => { console.error(e); process.exit(1); });
