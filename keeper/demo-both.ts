/**
 * demo-both.ts — stand up BOTH test games at once for one quick demo video.
 *
 * Creates the test Sweep card (create-test-sweep.ts — exits), then creates and
 * drives the Live test match (run-test-match.ts — foreground). Both then live on
 * the /test page at the same time: the Live tab plays the match (join → tap →
 * settle), the Sweep tab holds an enterable ×64 card. One screen recording can
 * walk the whole product.
 *
 *   npx tsx demo-both.ts                     Live = France/England replay, 1-min KO
 *   npx tsx demo-both.ts --duration-mins 5   snappier match
 *   npx tsx demo-both.ts --step-secs 10      faster call cadence
 *   npx tsx demo-both.ts --replay 0          Live uses the built-in DEFAULT_SCRIPT
 *   npx tsx demo-both.ts --dry-run           print the plan, touch no chain state
 *
 * Any run-test-match flag (--join-mins --duration-mins --step-secs --replay)
 * passes straight through to the Live match; the Sweep uses its own defaults.
 * Foreground until the Live match settles; Ctrl-C stops the driver — the Sweep
 * card stays enterable (~40 min) either way.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tsx = join(here, "node_modules", ".bin", "tsx");

const dryRun = process.argv.includes("--dry-run");
// --dry-run is ours (the Sweep step honours it too); never forward it to the
// Live match, which has no such flag.
const passthrough = process.argv.slice(2).filter((a) => a !== "--dry-run");
// Default the Live match to last night's France/England replay unless the caller
// picks their own --replay (--replay 0 = the built-in DEFAULT_SCRIPT).
const liveArgs = passthrough.includes("--replay")
  ? passthrough
  : ["--replay", "18257865", ...passthrough];

function run(script: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [join(here, script), ...args], { stdio: "inherit", cwd: here });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", reject);
  });
}

async function main() {
  console.log(`[demo-both] 1/2 — creating the test Sweep card (enterable, x64)${dryRun ? " [dry-run]" : ""}...\n`);
  const sweepCode = await run("create-test-sweep.ts", dryRun ? ["--dry-run"] : []);
  if (sweepCode !== 0) {
    console.error(`\n[demo-both] Sweep creation failed (exit ${sweepCode}) — not starting the Live match.`);
    process.exit(sweepCode);
  }
  if (dryRun) {
    console.log(`\n[demo-both] [dry-run] would then start the Live match:\n    tsx run-test-match.ts ${liveArgs.join(" ")}`);
    process.exit(0);
  }
  console.log("\n[demo-both] Sweep is live on /test -> Sweep tab.");
  console.log("[demo-both] 2/2 — starting the Live test match (foreground; Ctrl-C to stop)...\n");
  const liveCode = await run("run-test-match.ts", liveArgs);
  process.exit(liveCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
