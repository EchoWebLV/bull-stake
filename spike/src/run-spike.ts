/**
 * ProofBet 72-hour settlement spike — prove-or-kill runner.
 *
 *   npm run spike              # Phases 1→3 (auth, discover, validate) + gates
 *   npm run spike -- --only=auth
 *   npm run spike -- --only=discover
 *   npm run spike -- --only=validate
 *
 * Gate C is the prove-or-kill: validateStat must return TRUE for a true predicate,
 * FALSE for a false one, and REJECT a tampered proof — on a real fixture.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  authenticate,
  createContext,
  type Auth,
  type SpikeContext,
} from "./auth.js";
import { discoverStat, getFixtures, type StatPick } from "./discover.js";
import {
  fetchStatValidation,
  runDirectionalChecks,
  runTamperCheck,
  type BinaryOp,
  type ScoresStatValidation,
} from "./validate.js";
import { EXAMPLE_STAT } from "./config.js";
import { envOpt, gate, section, info, ok, warn, fail, detail } from "./util.js";

const AUTH_CACHE = resolve(process.cwd(), ".spike-auth.json");

function loadAuthCache(): Auth | null {
  if (!existsSync(AUTH_CACHE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_CACHE, "utf8")) as Auth;
  } catch {
    return null;
  }
}
function saveAuthCache(a: Auth): void {
  writeFileSync(AUTH_CACHE, JSON.stringify(a, null, 2));
  detail(`cached credentials → ${AUTH_CACHE}`);
}

function parseOnly(): string | null {
  const arg = process.argv.find((a) => a.startsWith("--only="));
  return arg ? arg.slice("--only=".length) : null;
}

/** Get credentials: reuse cache unless forced (avoids re-subscribing on-chain). */
async function getAuth(ctx: SpikeContext, force: boolean): Promise<Auth> {
  if (!force) {
    const cached = loadAuthCache();
    if (cached?.jwt && cached?.apiToken) {
      detail("using cached credentials (.spike-auth.json)");
      return cached;
    }
  }
  const a = await authenticate(ctx);
  saveAuthCache(a);
  return a;
}

/** Resolve the stat to validate: env overrides → live discovery → docs example. */
async function resolvePick(ctx: SpikeContext, a: Auth): Promise<{ pick: StatPick; source: string }> {
  const envFixture = envOpt("FIXTURE_ID");
  if (envFixture) {
    const pick: StatPick = {
      fixtureId: Number(envFixture),
      seq: Number(envOpt("SEQ") ?? 0),
      statKey: Number(envOpt("STAT_KEY") ?? EXAMPLE_STAT.statKey),
      statKey2: envOpt("STAT_KEY2") ? Number(envOpt("STAT_KEY2")) : undefined,
      phaseCode: null,
      phaseLabel: "env-override",
      final: false,
      hints: {},
    };
    return { pick, source: "env override" };
  }
  const discovered = await discoverStat(ctx, a);
  if (discovered) return { pick: discovered, source: "live discovery" };

  warn("no live rooted soccer stat found — falling back to the docs example fixture");
  return {
    pick: {
      fixtureId: EXAMPLE_STAT.fixtureId,
      seq: EXAMPLE_STAT.seq,
      statKey: EXAMPLE_STAT.statKey,
      statKey2: EXAMPLE_STAT.statKey2,
      phaseCode: null,
      phaseLabel: "example",
      final: false,
      hints: {},
    },
    source: "docs example (NOT a live match)",
  };
}

async function main() {
  const only = parseOnly();
  const ctx = createContext();
  info(`cluster RPC: ${ctx.connection.rpcEndpoint}`);
  info(`TxLINE base: ${ctx.baseUrl}`);
  info(`wallet: ${ctx.wallet.publicKey.toBase58()}`);
  info(`program: ${ctx.program.programId.toBase58()}`);

  const gates: Record<string, boolean> = {};

  // ── Phase 1 — auth & free-tier access (Gate A) ──────────────────────────────
  section("Phase 1 — Auth & free-tier access");
  const auth = await getAuth(ctx, only === "auth" || only === null);
  let fixtureCount = -1;
  try {
    const fixtures = await getFixtures(ctx, auth, {
      startEpochDay: Math.floor(Date.now() / 86_400_000) - 14,
    });
    fixtureCount = fixtures.length;
    gates.A = true;
    gate("Gate A — auth", true, `fixtures snapshot returned ${fixtureCount} fixtures`);
  } catch (e) {
    gates.A = false;
    gate("Gate A — auth", false, (e as Error).message.split("\n")[0]);
  }
  if (only === "auth") return summarise(gates);
  if (!gates.A) {
    warn("Gate A failed — check the host (devnet vs prod), dual headers, and that subscribe landed.");
    return summarise(gates);
  }

  // ── Phase 2 — find a stat to settle (Gate B) ───────────────────────────────
  section("Phase 2 — Find a stat to settle");
  const { pick, source } = await resolvePick(ctx, auth);
  gates.B = Number.isFinite(pick.fixtureId) && Number.isFinite(pick.seq);
  gate(
    "Gate B — stat located",
    gates.B,
    `${source}: fixtureId=${pick.fixtureId} seq=${pick.seq} statKey=${pick.statKey}` +
      (pick.statKey2 ? `+${pick.statKey2}` : "") +
      ` phase=${pick.phaseLabel}`,
  );
  if (pick.phaseCode !== null && !pick.final) {
    warn(`phase is ${pick.phaseLabel} (not final) — mechanism still provable; settlement would wait for F`);
  }
  if (only === "discover" || !gates.B) return summarise(gates);

  // ── Phase 3 — fetch proof + validate (Gate C) ──────────────────────────────
  section("Phase 3 — Fetch proof + validate on-chain");
  let validation: ScoresStatValidation;
  try {
    validation = await fetchStatValidation(ctx, auth, {
      fixtureId: pick.fixtureId,
      seq: pick.seq,
      statKey: pick.statKey,
      statKey2: pick.statKey2,
    });
    const twoStat = !!validation.statToProve2;
    ok(`proof fetched: statToProve.value=${validation.statToProve?.value}` + (twoStat ? `, statToProve2.value=${validation.statToProve2?.value}` : ""));
    detail(`proof depths: stat=${validation.statProof?.length ?? 0} subTree=${validation.subTreeProof?.length ?? 0} mainTree=${validation.mainTreeProof?.length ?? 0}`);

    const op: BinaryOp | null = twoStat ? "add" : null; // combined corners = a + b
    const dir = await runDirectionalChecks(ctx.program, validation, ctx.program.programId, op);
    info(`lhs=${dir.lhs} (a=${dir.valueA}${dir.valueB !== null ? `, b=${dir.valueB}, op=${op}` : ""})`);
    if (dir.truthy) ok(`true-predicate  (lhs > ${dir.lhs - 1}) → ${dir.truthy}`);
    else fail(`true-predicate  (lhs > ${dir.lhs - 1}) → ${dir.truthy} (expected true)`);
    if (!dir.falsy) ok(`false-predicate (lhs > ${dir.lhs + 1}) → ${dir.falsy}`);
    else fail(`false-predicate (lhs > ${dir.lhs + 1}) → ${dir.falsy} (expected false)`);

    const tamper = await runTamperCheck(ctx.program, validation, ctx.program.programId, op);
    if (tamper.rejected) ok(tamper.detail);
    else fail(tamper.detail);

    gates.C = dir.truthy === true && dir.falsy === false && tamper.rejected;
    gate(
      "Gate C — on-chain validation",
      gates.C,
      gates.C
        ? "validateStat returns TRUE/FALSE correctly and rejects tampering ✅ prove-or-kill PASSED"
        : "validateStat did not behave as expected — see lines above",
    );
  } catch (e) {
    gates.C = false;
    gate("Gate C — on-chain validation", false, (e as Error).message.split("\n")[0]);
    warn("If the daily_scores_roots PDA is missing, this stat's day isn't rooted on devnet yet → fallback to odds-validation markets.");
  }

  // ── Gate D — reading the result from ProofBet's flow ───────────────────────
  section("Gate D — reading the result from your own flow");
  if (gates.C) {
    ok("Path A satisfied: the keeper can run this exact .view() off-chain and post settle(market, winner).");
    info("Path B/C (on-chain CPI via get_return_data, or in-program re-verify) are covered in docs/spike-runbook.md.");
    gates.D = true;
  } else {
    gates.D = false;
    warn("Gate D depends on Gate C — resolve C first.");
  }

  return summarise(gates);
}

function summarise(gates: Record<string, boolean>) {
  section("Summary");
  for (const g of ["A", "B", "C", "D"]) {
    if (g in gates) gate(`Gate ${g}`, gates[g], gates[g] ? "pass" : "fail");
  }
  const cGreen = gates.C === true;
  console.log(
    cGreen
      ? "\n✅ PASS — soccer scores-proof settlement is real. Build the parimutuel core on validateStat."
      : "\n⚠️  Not green — see docs/spike-runbook.md Outcome Matrix (likely fallback: odds-validation markets).",
  );
}

main().catch((e) => {
  fail(`spike crashed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
