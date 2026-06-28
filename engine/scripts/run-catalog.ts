/**
 * Market-catalog runner — auto-create the 8-market set for each upcoming
 * World Cup fixture on devnet.  Idempotent: existing markets are skipped.
 *
 * Usage (never auto-run from tests or CI — creates on-chain accounts):
 *   npm run catalog
 *   tsx scripts/run-catalog.ts
 *
 * Cron cadence: every ~30 minutes.
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createContext } from "../../spike/src/auth.js";
import { authenticateCached } from "../../spike/src/auth-cache.js";
import { fetchSlate, ensureMarkets } from "../src/catalog.ts";
import type { SlateFixture } from "../src/catalog.ts";
import type { EnsureResult } from "../src/catalog.ts";

async function main() {
  const ctx = createContext();
  console.log("authenticating (cached if warm)...");
  const auth = await authenticateCached(ctx);

  console.log("fetching WC slate (next 36 h)...");
  const slate = await fetchSlate(ctx, auth, { hoursAhead: 36 });

  if (!slate.length) {
    console.log("no upcoming World Cup fixtures in the next 36 hours.");
    return;
  }

  console.log(`slate: ${slate.length} fixture(s)`);

  // Build the proofbet Program from the IDL (same pattern as create-market.ts).
  const idlPath = process.env.PROOFBET_IDL ?? "../../target/idl/proofbet.json";
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, ctx.provider);

  const settleAuthority = ctx.wallet.publicKey;

  const rows: Array<{ fixture: string; created: number; existing: number }> = [];

  for (const fixture of slate) {
    const kickoffDate = new Date(fixture.kickoffMs).toISOString().replace("T", " ").slice(0, 16);
    console.log(`  ${fixture.home} vs ${fixture.away} (${kickoffDate} UTC) fixture=${fixture.fixtureId}`);

    const result: EnsureResult = await ensureMarkets(program, fixture, settleAuthority);
    rows.push({
      fixture: `${fixture.home} v ${fixture.away}`,
      created: result.created,
      existing: result.existing,
    });
  }

  // Summary table.
  console.log("\n--- catalog summary ---");
  console.log("fixture".padEnd(36), "created".padEnd(10), "existing");
  for (const row of rows) {
    console.log(row.fixture.padEnd(36), String(row.created).padEnd(10), row.existing);
  }
  console.log("-----------------------");
  const totalCreated = rows.reduce((s, r) => s + r.created, 0);
  const totalExisting = rows.reduce((s, r) => s + r.existing, 0);
  console.log(`total: ${totalCreated} created, ${totalExisting} already existed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
