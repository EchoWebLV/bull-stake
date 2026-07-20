/**
 * schedule-pools.ts — auto-line-up live match pools ("games line themselves up").
 *
 * ONE idempotent pass (cron spawns it every SCHEDULE_INTERVAL_SEC; create-daily-card
 * precedent): fetch the upcoming allowlisted slate from TxLINE, and for every
 * fixture whose kickoff is within the JOIN window — now ∈ [kickoff − JOIN_AHEAD_MIN,
 * kickoff) — create its pool (create_live_pool + prealloc loop via createMatchPool)
 * unless the pool PDA already exists on-chain. The pool's lock_ts = kickoff, so this
 * window IS the buy-in window the web countdown advertises.
 *
 *   - already exists on-chain → skip (idempotent; safe to re-run every 5 min)
 *   - kickoff already passed  → skip (joins are closed on-chain; rent would be wasted)
 *   - outside the window      → skip (created on a later pass once the window opens)
 *   - overlapping fixtures    → each gets its own pool (the engine picks the featured one)
 *
 * IMPORTS mirror create-match-pool.ts / create-daily-card.ts: spike getFixtures
 * (`.js` NodeNext-clean), allowlist inlined (never import engine/src/config.ts — its
 * `.ts` import extensions trip TS5097 under the keeper's NodeNext typecheck).
 *
 * CLI:
 *   npx tsx schedule-pools.ts             one pass, creates what the window needs
 *   npx tsx schedule-pools.ts --dry-run   same pass, prints what it WOULD create
 */
import "dotenv/config";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getFixtures } from "../spike/src/discover.js";
import { loadProofbetProgram } from "./settle.js";
import { livePoolPda } from "./live-pda.js";
import { buildCreateLiveArgs, createMatchPool } from "./create-match-pool.js";

const { BN } = anchorDefault;

const LAMPORTS_PER_SOL = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minutes before kickoff that the pool is created (the join window). Mirrors the
 *  engine's JOIN_AHEAD_MIN so the web's "join opens at…" line matches reality.
 *  Default 1440 (24h): pools line up a full day ahead, so a game is joinable as
 *  soon as it's on the board — not only in the last 45 min. (Slate spans
 *  today+tomorrow; set 2880 to open tomorrow's fixtures a day early too.) */
export const JOIN_AHEAD_MIN = Number(process.env.JOIN_AHEAD_MIN ?? 1440);

/** Mirrors engine/src/config.ts COMPETITION_ALLOWLIST (inlined — see header):
 *  World Cup + International Friendlies, the two the devnet free tier carries. */
const COMPETITION_ALLOWLIST: string[] = (process.env.COMPETITION_ALLOWLIST ?? "World Cup,Friendlies")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** The slice of a TxLINE fixture the scheduler needs. */
export interface SlateFixture {
  fixtureId: number;
  kickoffMs: number;
  competition: string;
}

/**
 * PURE selection: which fixtures need a pool created RIGHT NOW?
 *   allowlisted competition AND now ∈ [kickoff − aheadMin, kickoff) AND no pool yet.
 * Earliest kickoff first (the soonest game is the most urgent to line up).
 */
export function selectPoolsToCreate(
  fixtures: SlateFixture[],
  hasPool: Set<number>,
  nowMs: number,
  aheadMin: number = JOIN_AHEAD_MIN,
  allowlist: string[] = COMPETITION_ALLOWLIST,
): SlateFixture[] {
  const seen = new Set<number>();
  return fixtures
    .filter(
      (f) =>
        allowlist.includes(f.competition) &&
        nowMs >= f.kickoffMs - aheadMin * 60_000 &&
        nowMs < f.kickoffMs &&
        !hasPool.has(f.fixtureId),
    )
    .sort((a, b) => a.kickoffMs - b.kickoffMs)
    // De-dupe by fixtureId: with a day-wide window a kickoff near midnight UTC
    // lands in BOTH the today and tomorrow slate fetches, so the same fixture
    // can appear twice — keep the first (earliest) and drop the rest, else we'd
    // issue a redundant create_live_pool that reverts "account already in use".
    .filter((f) => (seen.has(f.fixtureId) ? false : (seen.add(f.fixtureId), true)));
}

/** Injected I/O seams so the pass is hermetically testable. */
export interface ScheduleDeps {
  fetchSlate: () => Promise<SlateFixture[]>;
  poolExists: (fixtureId: number) => Promise<boolean>;
  createPool: (fixtureId: number, kickoffMs: number) => Promise<void>;
  now?: () => number;
  aheadMin?: number;
  log?: (msg: string) => void;
}

/** One scheduling pass. Returns what it created (fixture ids). Never throws for a
 *  single fixture's failure — it logs and moves on so one bad create can't block
 *  the rest of the slate; a genuinely down slate fetch DOES throw (cron logs it). */
export async function runSchedulePass(deps: ScheduleDeps): Promise<number[]> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console.log;
  const fixtures = await deps.fetchSlate();

  // Window-filter FIRST (cheap), then check on-chain existence only for candidates.
  const inWindow = selectPoolsToCreate(fixtures, new Set(), now(), deps.aheadMin);
  const created: number[] = [];
  for (const f of inWindow) {
    if (await deps.poolExists(f.fixtureId)) {
      log(`[schedule] pool ${f.fixtureId} already exists — skip`);
      continue;
    }
    try {
      await deps.createPool(f.fixtureId, f.kickoffMs);
      created.push(f.fixtureId);
      log(`[schedule] created pool ${f.fixtureId} (kickoff ${new Date(f.kickoffMs).toISOString()})`);
    } catch (e) {
      log(`[schedule] create ${f.fixtureId} FAILED: ${(e as Error).message}`);
    }
  }
  if (inWindow.length === 0) log("[schedule] no fixtures inside the join window");
  return created;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const entryPriceLamports = Math.round(
    Number(process.env.ENTRY_PRICE_SOL ?? "0.035") * LAMPORTS_PER_SOL,
  );
  const feeBps = Number(process.env.FEE_BPS ?? "500");

  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const conn = ctx.provider.connection;

  // Today + tomorrow covers the 45-min window across the midnight boundary.
  const todayEpochDay = Math.floor(Date.now() / DAY_MS);
  const fetchSlate = async (): Promise<SlateFixture[]> => {
    const [today, tomorrow] = await Promise.all([
      getFixtures(ctx, auth, { startEpochDay: todayEpochDay }),
      getFixtures(ctx, auth, { startEpochDay: todayEpochDay + 1 }),
    ]);
    return [...today, ...tomorrow].map((f) => ({
      fixtureId: f.FixtureId,
      kickoffMs: f.StartTime,
      competition: f.Competition,
    }));
  };

  const created = await runSchedulePass({
    fetchSlate,
    poolExists: async (fixtureId) =>
      (await conn.getAccountInfo(livePoolPda(new BN(fixtureId)))) !== null,
    createPool: async (fixtureId, kickoffMs) => {
      const args = buildCreateLiveArgs(fixtureId, kickoffMs, {
        entryPriceLamports,
        feeBps,
        nowSec: Math.floor(Date.now() / 1000),
      });
      if (dryRun) {
        console.log(`# dry-run: would create pool ${fixtureId} (lock ${args.lockTs})`);
        return;
      }
      await createMatchPool(proofbet, keeper, keeper, args);
    },
  });

  console.log(JSON.stringify({ action: "schedule_pools", dryRun, created }, null, 2));
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring create-match-pool.ts:237-238.
const isMain = process.argv[1]?.endsWith("schedule-pools.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
