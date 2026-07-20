/**
 * Production supervisor — runs the engine (always) and the keeper cron
 * (opt-in via RUN_KEEPER=1) inside the single Railway container.
 *
 * WHY: the Railway deploy is one service. The engine (API + web) is a read-only
 * process; the keeper cron (engine/../keeper/cron.ts) is the money-path actor
 * that COMPOSES the daily Pearly card at 08:00 UTC (PEARLY_CREATE=1) and settles
 * contests on its own clock. Historically the keeper was run by hand, so on days
 * nobody ran it there was no card. This supervisor makes the keeper part of the
 * deploy so a real card auto-composes on every day the TxLINE slate has ≥3
 * eligible fixtures — no manual step.
 *
 * SAFETY MODEL — the engine is CRITICAL, the keeper is BEST-EFFORT:
 *   • Engine exit  → the supervisor exits with the engine's code, so Railway
 *                    restarts the container (same failure semantics as today's
 *                    bare `npm --prefix engine run start`).
 *   • Keeper exit  → logged and RESTARTED after a backoff. A keeper crash (e.g.
 *                    a missing WALLET_SECRET_KEY, an RPC blip) NEVER touches the
 *                    engine, so the public web app stays up regardless.
 *
 * ROLLOUT: with RUN_KEEPER unset (the default) ONLY the engine runs — byte-for-
 * byte the current behavior. Landing this file + the Dockerfile CMD change is
 * therefore a no-op until you set RUN_KEEPER=1 (and the keeper's own env:
 * PEARLY_CREATE=1 to enable the daily create, plus WALLET_SECRET_KEY / RPC_URL /
 * TXLINE_BASE_URL / SERVICE_LEVEL_ID). See keeper/cron.ts for the full env list.
 *
 * The child commands default to the real ones but are env-overridable
 * (ENGINE_CMD / KEEPER_CMD) purely so the smoke test can substitute trivial
 * processes — production never sets them.
 */
import { spawn } from "node:child_process";

const ENGINE_CMD = process.env.ENGINE_CMD ?? "npm --prefix engine run start";
const KEEPER_CMD = process.env.KEEPER_CMD ?? "npm --prefix keeper run cron";
const RUN_KEEPER = process.env.RUN_KEEPER === "1";
/** Backoff before restarting a crashed keeper (ms). Floored at 1s. */
const KEEPER_RESTART_MS = Math.max(1000, Number(process.env.KEEPER_RESTART_MS ?? "10000"));

let shuttingDown = false;
/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

function log(msg) {
  console.log(`[supervisor] ${msg}`);
}

/** Spawn a child from a "cmd arg arg" string, inheriting stdio + env. */
function launch(cmdStr) {
  const [cmd, ...args] = cmdStr.split(/\s+/).filter(Boolean);
  const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
  children.push(child);
  return child;
}

// ── Engine: the critical process. Its exit is the container's exit. ──
function startEngine() {
  log(`starting engine: ${ENGINE_CMD}`);
  const engine = launch(ENGINE_CMD);
  engine.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`engine exited (code=${code} signal=${signal ?? "-"}) — bringing the container down so Railway restarts it`);
    shutdown(code == null ? 1 : code);
  });
  engine.on("error", (err) => {
    log(`engine failed to spawn: ${err.message}`);
    shutdown(1);
  });
}

// ── Keeper: best-effort. On exit, restart after a backoff; never fatal. ──
function startKeeper() {
  log(`starting keeper cron: ${KEEPER_CMD}`);
  const keeper = launch(KEEPER_CMD);
  keeper.on("exit", (code, signal) => {
    if (shuttingDown) return;
    log(`keeper exited (code=${code} signal=${signal ?? "-"}) — restarting in ${KEEPER_RESTART_MS}ms (best-effort; engine unaffected)`);
    // .unref() so a pending restart never keeps the process alive past an
    // engine-triggered shutdown (the running engine child already holds the loop open).
    setTimeout(() => { if (!shuttingDown) startKeeper(); }, KEEPER_RESTART_MS).unref();
  });
  keeper.on("error", (err) => {
    if (shuttingDown) return;
    log(`keeper failed to spawn: ${err.message} — retrying in ${KEEPER_RESTART_MS}ms`);
    setTimeout(() => { if (!shuttingDown) startKeeper(); }, KEEPER_RESTART_MS).unref();
  });
}

/** Forward a shutdown to all children and exit with `code` (Railway sends SIGTERM). */
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Set exitCode (not process.exit) so the intended code survives once the event
  // loop drains after the children close — a bare unref'd timer would let Node
  // exit 0 first and swallow the code.
  process.exitCode = code;
  for (const c of children) { try { c.kill("SIGTERM"); } catch { /* already gone */ } }
  // Hard-exit fallback if a child ignores SIGTERM and hangs the loop.
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { log(`${sig} received — shutting down`); shutdown(0); });
}

startEngine();
if (RUN_KEEPER) {
  startKeeper();
} else {
  log("keeper DISABLED (set RUN_KEEPER=1 to enable the daily-card composer + settle loop) — engine only");
}
