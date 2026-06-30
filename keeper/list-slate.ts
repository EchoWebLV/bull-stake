/**
 * Dev helper: print the upcoming in-scope (allow-list) fixtures from the TxLINE slate.
 * Read-only — reuses the cached auth token (no fresh activate). Used to pick a fixed
 * card for create-parlay.ts in M0.
 *
 * Usage: npx tsx list-slate.ts [hoursAhead] [hoursBehind]
 */
import "dotenv/config";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { fetchSlate } from "../engine/src/catalog.js";

async function main() {
  const hoursAhead = Number(process.argv[2] ?? 96);
  const hoursBehind = Number(process.argv[3] ?? 0);
  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const slate = await fetchSlate(ctx, auth, { hoursAhead, hoursBehind });
  console.log(`# in-scope fixtures in [-${hoursBehind}h, +${hoursAhead}h]: ${slate.length}`);
  for (const f of slate) {
    console.log(`${f.fixtureId}:${new Date(f.kickoffMs).toISOString()}  ${f.home} v ${f.away}`);
  }
}

const isMain = process.argv[1]?.endsWith("list-slate.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
