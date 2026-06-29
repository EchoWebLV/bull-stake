/**
 * ProofBet multi-market keeper — two-wave settlement.
 *
 * One run, one cached auth:
 *   1. Enumerate World Cup fixtures for yesterday + today via getFixtures.
 *   2. For each fixture, resolve the latest phase via getScoreHistory.
 *   3. For each MARKET_TEMPLATE def, derive the PDA + fetch the account:
 *      - Skip if the account doesn't exist or is already settled/voided.
 *      - void_market if the fixture is abandoned/cancelled.
 *      - Settle settleAt:"HT" markets once H1 is final.
 *      - Settle settleAt:"FT" markets once the match is final.
 *      - Skip if the phase doesn't satisfy the market's settle wave.
 *   4. Print per-fixture summary.
 *
 * Usage:
 *   tsx settle-all.ts [--dry-run] [--once]
 *
 * Note on imports: engine/src uses Bundler moduleResolution (.ts extensions);
 * this keeper uses NodeNext. To avoid transitive-parse errors, functions from
 * engine/src/chain.ts (which internally imports "./config.ts") are inlined here
 * rather than imported. MARKET_TEMPLATE is safe to import (no relative deps).
 */

import { PublicKey } from "@solana/web3.js";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getFixtures, getScoreHistory, resolvePhase } from "../spike/src/discover.js";
import {
  FINISHED_PHASES,
  VOID_PHASES,
  isH1Final,
  isFullGameFinal,
  PHASE_NAME,
} from "../spike/src/config.js";
import { MARKET_TEMPLATE } from "../engine/src/markets.js";
import { loadProofbetProgram, settleMarketByPubkey } from "./settle.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Inline deriveMarketPda (avoids importing engine/src/chain.ts which uses
//    Bundler-style ".ts" extensions incompatible with this package's NodeNext tsc) ──

/** i64 little-endian as 8 bytes (matches Rust fixture_id.to_le_bytes()). */
function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])],
    programId,
  )[0];
}

// ─────────────────────────────────────────────────────────────────────────────

interface Flags { [k: string]: string | boolean; }

function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

/**
 * Pure helper: given a phase code and a MARKET_TEMPLATE def's settleAt, decide what
 * action the keeper should take for this market.
 *
 * Returns:
 *   "settle"  — this market is ready to be settled now
 *   "void"    — fixture is abandoned/cancelled; market must be voided
 *   "skip"    — phase isn't ready for this market's wave yet
 */
export function marketAction(
  phaseCode: number,
  settleAt: "HT" | "FT",
): "settle" | "void" | "skip" {
  if (VOID_PHASES.has(phaseCode)) return "void";
  if (settleAt === "HT" && isH1Final(phaseCode)) return "settle";
  if (settleAt === "FT" && isFullGameFinal(phaseCode)) return "settle";
  return "skip";
}

/**
 * Given a phase code and a list of MarketDef settleAt values, return the marketIds
 * that are eligible for settlement (or voiding) in this run.
 *
 * Pure function — no I/O, no Anchor, no RPC. Tested in settle-all.test.ts.
 */
export function marketsToSettle(
  phaseCode: number,
  templates: ReadonlyArray<{ marketId: number; settleAt: "HT" | "FT" }>,
): { marketId: number; action: "settle" | "void" }[] {
  const result: { marketId: number; action: "settle" | "void" }[] = [];
  for (const t of templates) {
    const a = marketAction(phaseCode, t.settleAt);
    if (a !== "skip") result.push({ marketId: t.marketId, action: a });
  }
  return result;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = !!flags["dry-run"];

  console.log(`[settle-all] starting${dryRun ? " (DRY RUN)" : ""}`);

  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider);

  // Enumerate candidate fixtures: yesterday + today
  const todayEpochDay = Math.floor(Date.now() / DAY_MS);
  const startEpochDay = todayEpochDay - 1;

  const allFixtures = await getFixtures(ctx, auth, { startEpochDay });
  const wcFixtures = allFixtures.filter((f) => f.Competition === "World Cup");

  console.log(`[settle-all] found ${wcFixtures.length} World Cup fixture(s) to check`);

  // Per-fixture counters
  let totalSettled = 0;
  let totalVoided = 0;
  let totalSkippedNotReady = 0;
  let totalSkippedAlreadyDone = 0;
  let totalNotCreated = 0;

  for (const fixture of wcFixtures) {
    const fixtureId = fixture.FixtureId;
    const label = `${fixture.Participant1} vs ${fixture.Participant2} [${fixtureId}]`;

    // Cheap pre-check: skip fixtures with no markets before any TxLINE call.
    // The catalog always creates marketId 0 first, so if it's absent there are none.
    const probePda = deriveMarketPda(proofbet.programId, fixtureId, MARKET_TEMPLATE[0].marketId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((await (proofbet.account as any).market.fetchNullable(probePda)) === null) {
      totalNotCreated += MARKET_TEMPLATE.length;
      continue;
    }

    // Resolve the latest phase for this fixture
    const events = await getScoreHistory(ctx, auth, fixtureId);
    if (!events.length) {
      console.log(`[settle-all] ${label}: no score events — skipping`);
      continue;
    }

    const withPhase = events.map((ev) => ({ ev, ...resolvePhase(ev) }));
    // Pick the highest-Seq event that has a valid phase code
    const best = withPhase
      .filter((e) => e.code !== null)
      .sort((a, b) => b.ev.Seq - a.ev.Seq)[0];

    if (!best) {
      console.log(`[settle-all] ${label}: no phase code resolved — skipping`);
      continue;
    }

    const phaseCode = best.code as number;
    const phaseLabel = PHASE_NAME[phaseCode] ?? String(phaseCode);

    const h1Final = isH1Final(phaseCode);
    const ftFinal = isFullGameFinal(phaseCode);
    const voided = VOID_PHASES.has(phaseCode);

    console.log(`[settle-all] ${label}: phase=${phaseLabel} h1Final=${h1Final} ftFinal=${ftFinal} voided=${voided}`);

    let fixtureSettled = 0;
    let fixtureVoided = 0;
    let fixtureSkippedNotReady = 0;
    let fixtureSkippedAlreadyDone = 0;
    let fixtureNotCreated = 0;

    for (const def of MARKET_TEMPLATE) {
      const pda = deriveMarketPda(proofbet.programId, fixtureId, def.marketId);

      // Fetch the account (null if not created)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const marketAccount = await (proofbet.account as any).market.fetchNullable(pda);

      if (marketAccount === null) {
        fixtureNotCreated++;
        continue;
      }

      // Check status — skip if already settled or voided
      const status = marketAccount.status;
      const isOpen = status && "open" in status;
      if (!isOpen) {
        fixtureSkippedAlreadyDone++;
        continue;
      }

      const action = marketAction(phaseCode, def.settleAt);

      if (action === "skip") {
        fixtureSkippedNotReady++;
        continue;
      }

      if (action === "void") {
        // Use settleMarketByPubkey: it will detect void phase and call void_market
        console.log(`[settle-all]   void market=${pda.toBase58()} (${def.label})`);
        try {
          const result = await settleMarketByPubkey(ctx, auth, proofbet, pda, { dryRun });
          if (result.action === "voided" || result.action === "dry-run-void") {
            fixtureVoided++;
          } else {
            // Shouldn't happen, but log it
            console.warn(`[settle-all]   unexpected result for void: ${JSON.stringify(result)}`);
            fixtureSkippedNotReady++;
          }
        } catch (e) {
          console.error(`[settle-all]   void failed for ${pda.toBase58()}: ${(e as Error).message}`);
          fixtureSkippedNotReady++;
        }
        continue;
      }

      // action === "settle"
      console.log(`[settle-all]   settle market=${pda.toBase58()} (${def.label}, ${def.settleAt})`);
      try {
        const result = await settleMarketByPubkey(ctx, auth, proofbet, pda, { dryRun });
        if (
          result.action === "settled" ||
          result.action === "dry-run-settle"
        ) {
          fixtureSettled++;
        } else if (result.action === "skipped") {
          // settleMarketByPubkey returned "not final yet" — phase mismatch we didn't catch
          fixtureSkippedNotReady++;
        } else {
          // voided or dry-run-void — also fine (void branch above should handle this)
          fixtureVoided++;
        }
      } catch (e) {
        console.error(`[settle-all]   settle failed for ${pda.toBase58()}: ${(e as Error).message}`);
        fixtureSkippedNotReady++;
      }
    }

    console.log(
      `[settle-all] ${label} summary: settled=${fixtureSettled} voided=${fixtureVoided} ` +
      `skipped(not-ready)=${fixtureSkippedNotReady} skipped(already-done)=${fixtureSkippedAlreadyDone} ` +
      `not-created=${fixtureNotCreated}`,
    );

    totalSettled += fixtureSettled;
    totalVoided += fixtureVoided;
    totalSkippedNotReady += fixtureSkippedNotReady;
    totalSkippedAlreadyDone += fixtureSkippedAlreadyDone;
    totalNotCreated += fixtureNotCreated;
  }

  console.log(
    `[settle-all] TOTAL: settled=${totalSettled} voided=${totalVoided} ` +
    `skipped(not-ready)=${totalSkippedNotReady} skipped(already-done)=${totalSkippedAlreadyDone} ` +
    `not-created=${totalNotCreated}`,
  );
}

// Only run the CLI when invoked directly. Without this guard, importing this
// module (e.g. settle-all.test.ts importing the pure helpers) fires main(),
// which loads the wallet + connects to devnet with live credentials.
const isMain = process.argv[1]?.endsWith("settle-all.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
