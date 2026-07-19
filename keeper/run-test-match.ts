/**
 * run-test-match.ts — stand up and drive a PLAYABLE TEST MATCH, end to end, now.
 *
 * Everything is the REAL pipeline on devnet — real pool escrow, real 0.035◎ joins
 * from players' Privy wallets, real ER delegation + lock_pick taps, real on-chain
 * scoring and settle/claim. Only the score feed is scripted (test-feed.ts): no
 * real fixture is live, so the keeper's FetchEvents seam is served from the
 * deterministic script instead of TxLINE. The engine's /api/live/next features
 * the pool automatically (soonest lock wins), so testers just open the app:
 * countdown → Join → kickoff → tap calls → settle → winners claim.
 *
 *   npx tsx run-test-match.ts                     join window 3 min, match 8 min
 *   npx tsx run-test-match.ts --join-mins 5       longer buy-in window
 *   npx tsx run-test-match.ts --duration-mins 6   shorter match
 *
 * Runs in the foreground until the pool reaches a terminal state (settled /
 * rolledOver / voided), logging every step. Assumes it is the ONLY keeper driving
 * this pool — don't run cron.ts's live job against it concurrently (cron would
 * try TxLINE for the synthetic fixture id, fail the feed, and skip anyway).
 * The synthetic fixture id is 990xxxxxxx — outside any real TxLINE range.
 */
import "dotenv/config";
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { createContext } from "../spike/src/auth.js";
import { loadProofbetProgram } from "./settle.js";
import { livePoolPda, liveEntryPda } from "./live-pda.js";

const { SystemProgram } = pkg;
import { buildCreateLiveArgs, createMatchPool } from "./create-match-pool.js";
import { runLiveMatch } from "./live-runner.js";
import { makeSimFeed, replayScript } from "./test-feed.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getScoreHistory } from "../spike/src/discover.js";

const { BN } = anchorDefault;
const LAMPORTS_PER_SOL = 1_000_000_000;

// A rate-limited RPC can reject a promise web3.js holds internally (outside any
// awaited try/catch) — by default Node kills the process, orphaning an OPEN call
// mid-match (the next driver voids it, costing players the round). The driver is
// a dev harness babysitting real money mid-game: log and keep driving instead.
process.on("unhandledRejection", (e) => {
  console.log(`[test-match] unhandled rejection (continuing): ${(e as Error)?.message ?? e}`);
});

function flag(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const joinMins = flag("join-mins", 3);
  const durationMins = flag("duration-mins", 8);
  const resumeFixture = flag("resume", 0); // re-attach to an existing test pool
  const replayFixture = flag("replay", 0); // script = a REAL fixture's history, compressed

  /** With --replay, serve the real fixture's compressed arc instead of DEFAULT_SCRIPT. */
  async function buildScript(ctx: ReturnType<typeof createContext>, durationSecs: number) {
    if (replayFixture <= 0) return undefined;
    const auth = await authenticateCached(ctx);
    const history = await getScoreHistory(ctx, auth, replayFixture);
    const script = replayScript(history, durationSecs);
    console.log(
      `[test-match] replaying real fixture ${replayFixture}: ${history.length} events → ${script.length} scripted steps`,
    );
    return script;
  }
  const entryPriceLamports = Math.round(
    Number(process.env.ENTRY_PRICE_SOL ?? "0.035") * LAMPORTS_PER_SOL,
  );

  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;

  if (resumeFixture > 0) {
    // RESUME: drive an already-created pool (e.g. after a driver crash/restart).
    // Every parameter is recovered from chain state; the state machine is
    // re-entrant, so re-attaching mid-match is safe by design.
    const pool = livePoolPda(new BN(resumeFixture));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = await (proofbet.account as any).livePool.fetch(pool);
    const lockTs = Number(row.lockTs);
    const durationSecs = Number(row.settleAfterTs) - lockTs - 60;
    console.log(`[test-match] RESUME fixture ${resumeFixture} · pool ${pool.toBase58()}`);
    const fetchEvents = makeSimFeed(resumeFixture, lockTs * 1000, {
      durationSecs,
      script: await buildScript(ctx, durationSecs),
    });
    await driveToTerminal(proofbet, ctx, pool, fetchEvents);
    return;
  }

  // Synthetic fixture id: 990 prefix + seconds-of-era suffix → unique per run,
  // far outside TxLINE's real fixture range.
  const fixtureId = 9_900_000_000 + (Math.floor(Date.now() / 1000) % 100_000_000);
  const kickoffMs = Date.now() + joinMins * 60_000;
  const durationSecs = durationMins * 60;

  // settle window opens 1 min after full time (NOT the 3h default) so the whole
  // test — join → play → settle → claimable — completes in ~joinMins+durationMins+2.
  const args = buildCreateLiveArgs(fixtureId, kickoffMs, {
    entryPriceLamports,
    feeBps: Number(process.env.FEE_BPS ?? "500"),
    bufferSecs: durationSecs + 60,
    nowSec: Math.floor(Date.now() / 1000),
  });
  const pool = livePoolPda(new BN(args.poolId));

  console.log(`[test-match] fixture ${fixtureId} · pool ${pool.toBase58()}`);
  console.log(
    `[test-match] join window ${joinMins} min (kickoff ${new Date(kickoffMs).toISOString()}) · ` +
    `match ${durationMins} min · entry ${entryPriceLamports / LAMPORTS_PER_SOL}◎`,
  );
  await createMatchPool(proofbet, keeper, keeper, args);
  console.log(`[test-match] pool created — it is now featured on the app's Live tab. JOIN NOW.`);

  // HOUSE SEAT: the on-chain delegation gate voids any pool with <2 seats, so a
  // solo tester could never reach kickoff. The keeper takes ONE real seat itself
  // (its own 0.035◎, real join_live_pool) — one human + the house seat = playable.
  // The house never taps, so its no-pick misses effectively concede the pot.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const joinSig = await (proofbet as any).methods
    .joinLivePool()
    .accountsStrict({
      player: keeper,
      pool,
      entry: liveEntryPda(pool, keeper),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`[test-match] house seat joined (${entryPriceLamports / LAMPORTS_PER_SOL}◎): ${joinSig}`);

  const fetchEvents = makeSimFeed(fixtureId, kickoffMs, {
    durationSecs,
    script: await buildScript(ctx, durationSecs),
  });
  await driveToTerminal(proofbet, ctx, pool, fetchEvents);
}

/** Drive the state machine until terminal. Each runLiveMatch call is one bounded,
 *  idempotent step (the cron contract); a thrown step is logged and retried. */
async function driveToTerminal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proofbet: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: any,
  fetchEvents: ReturnType<typeof makeSimFeed>,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct: any = proofbet.account;
  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = await acct.livePool.fetch(pool).catch(() => null);
    const status = row ? Object.keys(row.status ?? {})[0] : "unreadable";
    if (status === "settled" || status === "rolledOver" || status === "voided") {
      console.log(`[test-match] TERMINAL: ${status}`);
      if (status === "settled") {
        console.log(
          `[test-match] winning score ${Number(row.winningScore)} · ` +
          `${Number(row.winnerCount)} winner(s) · distributable ${Number(row.distributable) / LAMPORTS_PER_SOL}◎ — claims open in the app`,
        );
      }
      break;
    }
    console.log(`[test-match] status=${status} players=${row ? Number(row.playerCount) : "?"} — step`);
    try {
      const report = await runLiveMatch(pool, {
        keypair: ctx.wallet,
        fetchEvents,
      });
      for (const err of report.errors ?? []) {
        console.log(`[test-match]   step error: ${err.name}: ${err.err}`);
      }
    } catch (e) {
      console.log(`[test-match] step threw: ${(e as Error).message} — retrying`);
    }
    // 20s between driver steps. Each step runs at most ONE call cycle, so this
    // sets the BREATHER between calls (~40s call-to-call with the answer window
    // and tx time) — a 5s loop machine-gunned all 8 calls back-to-back and no
    // human could catch them. Mirrors the production cron's LIVE_INTERVAL_SEC 30.
    await sleep(20_000);
  }
}

const isMain = process.argv[1]?.endsWith("run-test-match.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
