/**
 * Capture a fixture's corners progression from TxLINE into engine/data/replay.json
 * so the demo feed replays REAL data deterministically. Usage:
 *   tsx scripts/capture-replay.ts --fixture <id>
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createContext, authenticate } from "../../spike/src/auth.js";
import { getScoreHistory } from "../../spike/src/discover.js";
import { SOCCER_STAT } from "../../spike/src/config.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** TxLINE historical snapshots carry a flat status; derive a readable phase from
 *  the match minute so the demo feed progresses NS → H1 → HT → H2 → F. */
function phaseFromMinute(min: number): string {
  if (min <= 0) return "NS";
  if (min < 45) return "H1";
  if (min === 45) return "HT";
  if (min < 90) return "H2";
  return "F";
}

async function main() {
  const fixtureId = Number(flag("fixture"));
  if (!fixtureId) throw new Error("--fixture <id> required");
  const ctx = createContext();
  const auth = await authenticate(ctx);
  const events = await getScoreHistory(ctx, auth, fixtureId);

  const sorted = [...events].sort((a, b) => Number(a.Seq) - Number(b.Seq));
  const t0 = Number(sorted[0]?.Ts ?? 0);
  const frames = sorted.map((ev, i) => {
    const c1 = ev.Stats?.[String(SOCCER_STAT.P1_CORNERS)] ?? 0;
    const c2 = ev.Stats?.[String(SOCCER_STAT.P2_CORNERS)] ?? 0;
    const g1 = ev.Stats?.[String(SOCCER_STAT.P1_GOALS)] ?? 0;
    const g2 = ev.Stats?.[String(SOCCER_STAT.P2_GOALS)] ?? 0;
    const realMs = Number(ev.Ts ?? t0) - t0;
    const minute = Math.min(90, Math.round(realMs / 60000));
    return {
      tMs: i * 4000,                 // compress to ~4s/frame for the demo
      minute,
      phase: phaseFromMinute(minute),
      scoreH: g1, scoreA: g2, corners1: c1, corners2: c2,
    };
  });

  const replay = { fixtureId, home: flag("home") ?? "Home", away: flag("away") ?? "Away", frames };
  const out = new URL("../data/replay.json", import.meta.url);
  writeFileSync(out, JSON.stringify(replay, null, 2));
  console.log(`wrote ${frames.length} frames to engine/data/replay.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
