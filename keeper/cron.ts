/**
 * Streak settlement scheduler — the keeper's long-running entrypoint.
 *
 * Two jobs, one process, ZERO new dependencies (plain `setInterval`, the same
 * convention engine/src/server.ts uses):
 *
 *   1. CREATE  — once per UTC day at 08:00 UTC, run `create-daily-card.ts` to
 *                compose + open that day's ONE 6-leg card. Idempotent on the
 *                create side (create-daily-card skips if today's Contest PDA
 *                already exists), so a missed/duplicated tick is harmless.
 *
 *   2. SETTLE  — every SETTLE_INTERVAL_MIN minutes, run `settle-contest.ts` with
 *                NO --contest-id (its built-in "enumerate Open contests due"
 *                pass). That pass already implements everything this task asks
 *                for and we REUSE it wholesale rather than reimplement:
 *                  • skips contests whose settle_after_ts is in the future
 *                    (settle window not open) — "skipped-too-early",
 *                  • per leg, resolves the fixture phase and only settles the
 *                    leg whose wave (HT/FT) TxLINE reports final — a leg whose
 *                    fixture isn't final is skipped ("wave not ready"),
 *                  • after the per-leg pass, classifyLegReadiness gates the
 *                    contest: "pending" (a leg still Open → match not final) →
 *                    it ABORTS and waits ("aborted-wait"); it never settles a
 *                    contest whose last match hasn't reached full-time,
 *                  • never re-settles: settleMarketByPubkey skips markets that
 *                    are already Settled/Voided, and a contest whose status is
 *                    no longer Open is "skipped-not-open",
 *                  • counts perfect tickets off-chain and calls settle_contest;
 *                    zero perfect → automatic rollover into the jackpot.
 *
 * Because the settle pass is N-leg generic (it reads num_legs off the contest
 * and slices fixtures/market_ids to it), the SAME pass settles a 4-leg
 * single-match parlay and the 6-leg daily card — no card-shape special-casing.
 *
 * The scheduler does NOT touch Anchor/RPC/TxLINE itself. It spawns the existing
 * CLIs as child processes (inheriting this process's cwd + .env), so the money
 * path lives in exactly one place (settle-contest.ts) and this file is just the
 * clock. That also means --dry-run here simply forwards --dry-run to the settle
 * child: you get the full settle PREVIEW (pot/rake/jackpot/perfect-count) for
 * every due contest with no transaction sent.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────────
 *   npx tsx cron.ts                  long-running: 08:00Z daily create + settle loop
 *   npx tsx cron.ts --dry-run        same loop, but the settle pass is preview-only
 *                                    (forwards --dry-run to settle-contest)
 *   npx tsx cron.ts --once           run ONE settle pass right now and exit (no loop,
 *                                    no create). Combine with --dry-run to exercise
 *                                    the settle pass safely (used by this task's VERIFY).
 *   npx tsx cron.ts --once --create  run ONE create + ONE settle pass now and exit.
 *
 * Env (all optional; sensible defaults):
 *   SETTLE_INTERVAL_MIN   minutes between settle passes        (default 10)
 *   DAILY_CREATE_HOUR_UTC hour-of-day UTC to run create        (default 8)
 *   KEEPER_DRY_RUN=1      force --dry-run on the settle pass    (default off)
 *
 * ── Alternative: system cron (if you'd rather not run a long-lived process) ─────
 * Run the two CLIs straight from crontab. NOTE crontab times are the HOST's local
 * time — express them in UTC by setting `CRON_TZ=UTC` (Vixie/Linux) at the top of
 * the crontab, or convert. Both commands MUST run from the keeper/ dir so
 * `import "dotenv/config"` finds keeper/.env. Adjust the absolute paths:
 *
 *   CRON_TZ=UTC
 *   # 1. compose + open the daily 6-leg card at 08:00 UTC
 *   0 8 * * *      cd /ABS/PATH/ProofBet/keeper && npx tsx create-daily-card.ts  >> /var/log/streak-create.log 2>&1
 *   # 2. settle pass every 10 minutes (enumerates Open contests due; idempotent)
 *   [slash]10 * * * *  cd /ABS/PATH/ProofBet/keeper && npx tsx settle-contest.ts >> /var/log/streak-settle.log 2>&1
 *
 * (Write "[slash]10" as the literal crontab step "*" + "/10" — spelled out here
 * only because the "*" + "/" two-char sequence would otherwise close this block
 * comment. For a settle pass every 10 min the minute field is the standard
 * step-of-10 form.) For a DRY-RUN settle cron (preview only, no tx), append
 * --dry-run to line 2.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pkg from "@solana/web3.js";

const { PublicKey } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** LivePool.status offset in the (8-disc) account (Reference data: status u8@114). */
const LIVE_POOL_STATUS_OFFSET = 114;
/** PoolStatus enum (u8): Open0, Live1, Ended2, Settled3, RolledOver4, Voided5. */
const POOL_STATUS_OPEN = 0;
const POOL_STATUS_LIVE = 1;
const POOL_STATUS_ENDED = 2;

// ── Pure scheduling helpers (no I/O — unit-tested in test/cron.test.ts) ───────────

/**
 * Milliseconds from `nowMs` until the next occurrence of `hourUtc`:00:00.000 UTC.
 * Always in (0, DAY_MS]: if we're exactly at the boundary we schedule the NEXT
 * day (never 0, so a misfire can't spin). Used to align the first daily-create
 * tick to the wall clock instead of "24h after process start".
 */
export function msUntilNextUtcHour(nowMs: number, hourUtc: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    hourUtc, 0, 0, 0,
  );
  const delta = next - nowMs;
  return delta > 0 ? delta : delta + DAY_MS;
}

/**
 * Has the daily create for THIS UTC day already fired? Compares the UTC epoch-day
 * of `nowMs` to the last-fired epoch-day. Guards the create job against double
 * firing if the interval drifts or the process is restarted mid-day. Pure.
 */
export function isSameUtcDay(aMs: number, bMs: number): boolean {
  return Math.floor(aMs / DAY_MS) === Math.floor(bMs / DAY_MS);
}

/**
 * The fast-live-job interval in MILLISECONDS, derived from `LIVE_INTERVAL_SEC`
 * (SECONDS; default 30). Floored at 1s so a mis-set 0/negative env can never spin
 * the loop. Pure — reads only the passed env map (unit-tested). DELIBERATELY
 * independent of `SETTLE_INTERVAL_MIN` (different key, different unit): the fast
 * live job and the 10-min settle job run on their own clocks. Documented against
 * the ~60s devnet data delay — do not set below the feed's resolution latency.
 */
export function liveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.LIVE_INTERVAL_SEC ?? "30");
  const sec = Number.isFinite(raw) ? raw : 30;
  return Math.max(1, sec) * SECOND_MS;
}

/**
 * The pool-scheduler interval in MILLISECONDS, from `SCHEDULE_INTERVAL_SEC`
 * (SECONDS; default 300 = 5 min). Same shape/floor as liveIntervalMs. The pass
 * itself is idempotent (pool-PDA-exists check), so the cadence only bounds how
 * late inside the 45-min join window a pool can appear — 5 min leaves ≥40 min
 * of real buy-in time even in the worst case.
 */
export function scheduleIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.SCHEDULE_INTERVAL_SEC ?? "300");
  const sec = Number.isFinite(raw) ? raw : 300;
  return Math.max(1, sec) * SECOND_MS;
}

// ── child-process runner ──────────────────────────────────────────────────────────

/**
 * Run one of the sibling keeper CLIs (create-daily-card.ts / settle-contest.ts)
 * as a child `tsx` process. Inherits stdio so its logs stream straight through,
 * and inherits cwd (= keeper/) + env so `import "dotenv/config"` loads keeper/.env
 * exactly as a manual run would. Resolves with the child's exit code; NEVER
 * rejects — a failed pass must not kill the scheduler loop (the next tick retries).
 */
function runKeeperScript(script: string, args: string[]): Promise<number> {
  const scriptPath = join(__dirname, script);
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", scriptPath, ...args], {
      cwd: __dirname,
      env: process.env,
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`[cron] failed to spawn ${script}: ${err.message}`);
      resolve(1);
    });
  });
}

/** Run the daily-card composer/creator once. */
async function runDailyCreate(dryRun: boolean): Promise<void> {
  const args = dryRun ? ["--dry-run"] : [];
  const ts = new Date().toISOString();
  console.log(`[cron ${ts}] === create-daily-card${dryRun ? " (DRY RUN)" : ""} ===`);
  const code = await runKeeperScript("create-daily-card.ts", args);
  console.log(`[cron] create-daily-card exited ${code}`);
}

/** Run one pool-scheduler pass (auto-line-up live pools inside the join window). */
async function runSchedulePools(dryRun: boolean): Promise<void> {
  const args = dryRun ? ["--dry-run"] : [];
  const ts = new Date().toISOString();
  console.log(`[cron ${ts}] === schedule-pools${dryRun ? " (DRY RUN)" : ""} ===`);
  const code = await runKeeperScript("schedule-pools.ts", args);
  console.log(`[cron] schedule-pools exited ${code}`);
}

/**
 * Run ONE settle pass. With no --contest-id, settle-contest enumerates every Open
 * contest whose settle window has opened and settles each (or aborts-to-wait /
 * aborts-to-void per the readiness gate). Forwarding --dry-run makes it preview-only.
 */
async function runSettlePass(dryRun: boolean): Promise<void> {
  const args = dryRun ? ["--dry-run"] : [];
  const ts = new Date().toISOString();
  console.log(`[cron ${ts}] === settle pass${dryRun ? " (DRY RUN)" : ""} ===`);
  const code = await runKeeperScript("settle-contest.ts", args);
  console.log(`[cron] settle pass exited ${code}`);
}

// ── fast live job — per-pool in-flight guard (S3-T8) ────────────────────────────────
//
// A SECOND independent job, alongside the 10-min settle pass. It discovers the
// live-match pools that still need driving (status Open/Live/Ended) and runs the
// in-process `runLiveMatch` per pool. Unlike the single global `settling` flag on
// the settle job, this job guards PER POOL (a `Set<string>` of pool pubkeys): a
// single pool never overlaps itself across ticks (an ER run can span multiple
// ticks — see plan Risk #2, first-flip ~21s), so an overlapping tick skips any
// pool still in-flight and only picks up newly-discovered ones. The guard is
// released in a `finally` so a thrown run (a bad/mid-match pool) leaves the pool
// retryable on the next tick and can never wedge the loop.

/** A discovered-pool driver seam: run ONE pool's live lifecycle to completion. */
export type RunPoolFn = (pool: string) => Promise<unknown>;
/** A discovery seam: list the pool pubkeys (base58) that still need driving. */
export type DiscoverPoolsFn = () => Promise<string[]>;

export interface TickLiveDeps {
  /** Shared cross-tick in-flight guard — pools currently mid-run. */
  inFlight: Set<string>;
  /** Discover Open/Live/Ended live pools (base58 pubkeys). */
  discover: DiscoverPoolsFn;
  /** Drive one pool (default: runLiveMatch), awaited under the guard. */
  run: RunPoolFn;
}

/**
 * Build the fast-live tick. Each call:
 *   1. discovers the pools needing work (failure is swallowed — the loop lives),
 *   2. for every pool NOT already in-flight, marks it in-flight, `run`s it, and
 *      clears the guard in `finally` whether the run resolves or THROWS.
 * A single pool never overlaps itself: because the guard is added BEFORE awaiting
 * the run, an OVERLAPPING tick that arrives while the run is still pending sees the
 * pool in-flight and skips it (concurrency is across ticks/pools, not within a
 * pool). The tick NEVER rejects — a thrown run is logged and the loop survives.
 */
export function makeTickLive(deps: TickLiveDeps): () => Promise<void> {
  const { inFlight, discover, run } = deps;
  return async function tickLive(): Promise<void> {
    let pools: string[];
    try {
      pools = await discover();
    } catch (e) {
      console.error(`[cron] live discovery failed: ${(e as Error).message}`);
      return;
    }
    for (const pool of pools) {
      if (inFlight.has(pool)) {
        console.log(`[cron] live pool ${pool.slice(0, 8)} still in-flight — skipping`);
        continue;
      }
      inFlight.add(pool);
      try {
        await run(pool);
      } catch (e) {
        console.error(`[cron] live run for ${pool.slice(0, 8)} threw: ${(e as Error).message}`);
      } finally {
        inFlight.delete(pool);
      }
    }
  };
}

// ── production seams for the fast live job (used only inside main()) ────────────────
//
// These touch RPC / Anchor / the live-runner and are therefore constructed ONLY
// inside main() (behind the isMain guard). Tests import cron.ts freely and never
// reach here — makeTickLive takes `discover` / `run` as seams, so the unit tests
// inject spies (zero I/O). The dynamic imports below keep import-time hermetic:
// pulling in createContext / loadProofbetProgram / runLiveMatch (which open no
// socket at import, but load a wallet / IDL) happens lazily when main() runs.

/**
 * Discover the live-match pools that still need driving on the BASE layer: every
 * `LivePool` whose status is Open(0)/Live(1)/Ended(2) (i.e. not yet Settled /
 * RolledOver / Voided). Size-filtered `getProgramAccounts` (runtime `.size`, not a
 * hardcoded 176) + a status-byte scan at offset 114. Returns pool pubkeys base58.
 * Only invoked from main(); errors bubble to the `makeTickLive` discover try/catch.
 */
export async function discoverLivePools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
): Promise<string[]> {
  const conn = program.provider.connection;
  const size: number = program.account.livePool.size;
  // Discriminator memcmp (camelCase account key — matches chain.ts's readers).
  const memcmp = program.coder.accounts.memcmp("livePool");
  const accounts = await conn.getProgramAccounts(program.programId, {
    filters: [
      { memcmp: { offset: memcmp.offset ?? 0, bytes: memcmp.bytes } },
      { dataSize: size },
    ],
  });
  const drivable = new Set([POOL_STATUS_OPEN, POOL_STATUS_LIVE, POOL_STATUS_ENDED]);
  const pools: string[] = [];
  for (const { pubkey, account } of accounts) {
    const data: Buffer = account.data;
    if (data.length !== size) continue;
    const status = data.readUInt8(LIVE_POOL_STATUS_OFFSET);
    if (drivable.has(status)) pools.push(pubkey.toBase58());
  }
  return pools;
}

// ── flag parsing ──────────────────────────────────────────────────────────────────

interface Flags { [k: string]: boolean; }
function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (const a of argv) if (a.startsWith("--")) flags[a.slice(2)] = true;
  return flags;
}

// ── main ───────────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = !!flags["dry-run"] || process.env.KEEPER_DRY_RUN === "1";
  const once = !!flags["once"];
  const alsoCreate = !!flags["create"];

  const settleIntervalMin = Math.max(1, Number(process.env.SETTLE_INTERVAL_MIN ?? "10"));
  const createHourUtc = Math.min(23, Math.max(0, Number(process.env.DAILY_CREATE_HOUR_UTC ?? "8")));
  const liveMs = liveIntervalMs(process.env);

  // ── --once: one immediate pass, then exit (used for exercising / VERIFY). ──
  if (once) {
    if (alsoCreate) await runDailyCreate(dryRun);
    await runSettlePass(dryRun);
    return;
  }

  // ── Long-running scheduler. ──
  console.log(
    `[cron] scheduler up · settle every ${settleIntervalMin}m · ` +
    `create at ${String(createHourUtc).padStart(2, "0")}:00 UTC · ` +
    `live every ${liveMs / SECOND_MS}s · ` +
    `pool-schedule every ${scheduleIntervalMs(process.env) / SECOND_MS}s` +
    `${dryRun ? " · DRY RUN (settle preview only)" : ""}`,
  );

  // (1) Daily create, wall-clock aligned to HH:00 UTC. We self-schedule with
  //     setTimeout each day (vs a fixed setInterval) so it stays pinned to the
  //     wall clock across DST-free UTC and process uptime drift. A per-day guard
  //     (lastCreateMs) makes a stray double-fire a no-op on top of create-daily-card's
  //     own PDA-exists idempotency.
  let lastCreateMs = 0;
  const scheduleDailyCreate = () => {
    const wait = msUntilNextUtcHour(Date.now(), createHourUtc);
    const fireAt = new Date(Date.now() + wait).toISOString();
    console.log(`[cron] next daily create at ${fireAt} (in ${(wait / HOUR_MS).toFixed(2)}h)`);
    setTimeout(async () => {
      const now = Date.now();
      if (lastCreateMs && isSameUtcDay(now, lastCreateMs)) {
        console.log("[cron] daily create already fired this UTC day — skipping");
      } else {
        lastCreateMs = now;
        await runDailyCreate(dryRun);
      }
      scheduleDailyCreate(); // re-arm for the next day
    }, wait);
  };
  scheduleDailyCreate();

  // (2) Settle pass on a fixed interval. Run one immediately on boot so a freshly
  //     started keeper doesn't wait a full interval before checking for due cards,
  //     then guard against overlap (a slow pass spanning a tick) with a busy flag.
  let settling = false;
  const tickSettle = async () => {
    if (settling) { console.log("[cron] previous settle pass still running — skipping tick"); return; }
    settling = true;
    try { await runSettlePass(dryRun); }
    finally { settling = false; }
  };
  await tickSettle();
  setInterval(tickSettle, settleIntervalMin * MINUTE_MS);

  // (3) Fast live job on its OWN interval (LIVE_INTERVAL_SEC, default 30s),
  //     independent of the settle interval. Builds the base-layer Program once
  //     (lazy dynamic imports keep import-time hermetic — see the seams section),
  //     then discovers Open/Live/Ended pools each tick and drives runLiveMatch per
  //     pool under a PER-POOL in-flight guard (a single pool never overlaps itself
  //     across ticks). Run once on boot, then on the interval.
  const inFlightLive = new Set<string>();
  const { createContext } = await import("../spike/src/auth.js");
  const { authenticateCached } = await import("../spike/src/auth-cache.js");
  const { getScoreHistory } = await import("../spike/src/discover.js");
  const { loadProofbetProgram } = await import("./settle.js");
  const { runLiveMatch } = await import("./live-runner.js");
  const liveCtx = createContext();
  const liveProgram = loadProofbetProgram(liveCtx.provider);
  // The TxLINE score-history seam runLiveMatch REQUIRES for gameplay (it
  // loud-fails without one — a delegated pool with no feed can never resolve).
  // Auth is cached across calls (authenticateCached re-signs only on expiry).
  const fetchEvents = async (fixtureId: number) => {
    const auth = await authenticateCached(liveCtx);
    return getScoreHistory(liveCtx, auth, fixtureId);
  };
  const tickLive = makeTickLive({
    inFlight: inFlightLive,
    discover: () => discoverLivePools(liveProgram),
    run: (pool) =>
      runLiveMatch(new PublicKey(pool), {
        keypair: liveCtx.wallet,
        fetchEvents,
        // The Txoracle program (ctx.program) — resolveOutcomeIndex's proof seam.
        oracle: { program: liveCtx.program },
      }),
  });
  await tickLive();
  setInterval(tickLive, liveMs);

  // (4) Pool auto-scheduler ("games line themselves up"): every SCHEDULE_INTERVAL_SEC
  //     (default 5 min), spawn schedule-pools.ts — it creates a live pool for each
  //     allowlisted fixture entering its 45-min join window (idempotent via the
  //     pool-PDA-exists check, so overlapping/duplicate ticks are no-ops). Same
  //     child-CLI pattern + busy guard as the settle job. Run once on boot so a
  //     freshly started keeper lines up an imminent game immediately.
  const scheduleMs = scheduleIntervalMs(process.env);
  let scheduling = false;
  const tickSchedule = async () => {
    if (scheduling) { console.log("[cron] previous schedule pass still running — skipping tick"); return; }
    scheduling = true;
    try { await runSchedulePools(dryRun); }
    finally { scheduling = false; }
  };
  await tickSchedule();
  setInterval(tickSchedule, scheduleMs);
}

// Only run the scheduler when invoked directly — guard against import-time
// execution (the pure helpers above are imported by test/cron.test.ts), mirroring
// settle.ts / settle-all.ts / settle-contest.ts.
const isMain = process.argv[1]?.endsWith("cron.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
