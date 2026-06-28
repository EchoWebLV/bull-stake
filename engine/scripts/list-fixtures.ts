/**
 * Reality check: what fixtures does TxLINE have around now (live / today / soon)?
 * Usage: tsx scripts/list-fixtures.ts
 */
import "dotenv/config";
import { createContext, authenticate } from "../../spike/src/auth.js";
import { getFixtures, type Fixture } from "../../spike/src/discover.js";

async function main() {
  const ctx = createContext();
  const auth = await authenticate(ctx);
  const now = Date.now();
  const epochDay = Math.floor(now / 86_400_000);

  const all: Fixture[] = [];
  for (const d of [epochDay - 1, epochDay, epochDay + 1, epochDay + 2]) {
    try {
      const fx = await getFixtures(ctx, auth, { startEpochDay: d });
      all.push(...fx);
    } catch (e) {
      console.error(`epochDay ${d} failed:`, (e as Error).message);
    }
  }

  const seen = new Set<number>();
  const fixtures = all.filter((f) => (seen.has(f.FixtureId) ? false : seen.add(f.FixtureId)));

  const ms = (f: Fixture) => {
    const t = Number(f.StartTime);
    return t < 1e12 ? t * 1000 : t; // tolerate sec vs ms
  };
  const classify = (f: Fixture) => {
    const dt = ms(f) - now;
    if (dt < -2.5 * 3600_000) return "FT/past ";
    if (dt < 0) return "LIVE🔴  ";
    if (dt < 12 * 3600_000) return "today   ";
    if (dt < 36 * 3600_000) return "tomorrow";
    return "future  ";
  };

  const byComp: Record<string, Fixture[]> = {};
  for (const f of fixtures) (byComp[f.Competition] ??= []).push(f);

  console.log(`now = ${new Date(now).toISOString()}  (epochDay ${epochDay})`);
  console.log(`total fixtures in window: ${fixtures.length}\n`);

  const counts: Record<string, number> = {};
  for (const f of fixtures) { const k = classify(f).trim(); counts[k] = (counts[k] ?? 0) + 1; }
  console.log("by status:", JSON.stringify(counts), "\n");

  for (const [comp, fs] of Object.entries(byComp).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`[${comp}] (${fs.length})`);
    for (const f of fs.sort((a, b) => ms(a) - ms(b)).slice(0, 12)) {
      console.log(`  ${classify(f)} ${new Date(ms(f)).toISOString().slice(5, 16).replace("T", " ")}  ${f.Participant1} v ${f.Participant2}  [fx ${f.FixtureId}]`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
