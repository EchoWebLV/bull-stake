/**
 * Void a single-match parlay contest (v2) — abandoned-match insurance.
 *
 * Usage:
 *   npx tsx void-contest.ts --contest-id <fixtureId> [--dry-run]
 *
 * The on-chain void_contest requires contest.status == Open (else ContestNotOpen)
 * and has NO keeper time-gate: the settle_authority (keeper) may void an Open
 * contest at any time. This is the abandoned-match path the program-plan deferred
 * to off-chain — when a fixture is cancelled/abandoned and its legs Void, the
 * contest can never settle, so the keeper voids it.
 *
 * After a void, the keeper pushes NO refunds: each ticket-holder reclaims their
 * stake by calling claim_contest, whose Voided branch refunds the entry stake.
 *
 * --dry-run prints the confirmation summary but does NOT send (a sensible safety
 * default for a destructive op; omit to actually broadcast the void).
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { createContext } from "../spike/src/auth.js";
import { loadProofbetProgram } from "./settle.js";

// Contest PDA rent floor: minimum_balance(8 disc + Contest::INIT_SPACE) — Anchor's
// program.account.contest.size already includes the 8-byte discriminator (= 281 for
// the pearly v3 layout; was 217 at 6-leg v2, 207 at 5 legs).
const CONTEST_SIZE_FALLBACK = 281;

const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

// ── Inline PDA helpers (do NOT import engine/src/chain.ts — it uses ".ts"
//    extensions, which break this package's NodeNext typecheck). Mirrors the
//    inline-derive convention already used in settle-all.ts / settle-contest.ts. ──
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function deriveContestPda(programId: PublicKey, contestId: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(contestId)], programId)[0];
}

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

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = !!flags["dry-run"];

  // Required --contest-id <fixtureId>; error clearly if missing or non-numeric.
  const raw = flags["contest-id"];
  if (raw == null || raw === true) {
    console.error("error: --contest-id <fixtureId> is required.\n  usage: npx tsx void-contest.ts --contest-id <fixtureId> [--dry-run]");
    process.exit(1);
  }
  const contestId = Number(raw);
  if (!Number.isFinite(contestId) || !Number.isInteger(contestId) || contestId < 0) {
    console.error(`error: --contest-id must be a non-negative integer (got "${String(raw)}").`);
    process.exit(1);
  }

  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const connection = proofbet.provider.connection;
  const contest = deriveContestPda(proofbet.programId, contestId);

  // Fetch the contest (throws if it doesn't exist — the operator gave a bad id).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (proofbet.account as any).contest.fetch(contest);

  // Normalize the Anchor status enum ({ open: {} } → "open").
  const status = c.status;
  const statusKey = status && typeof status === "object" ? Object.keys(status)[0] : String(status);
  if (statusKey !== "open") {
    console.log(JSON.stringify({
      action: "void_contest", contestId, contest: contest.toBase58(), status: statusKey,
      result: "skipped: contest not Open (already settled/voided/rolled-over) — nothing to void",
    }, null, 2));
    return;
  }

  // Confirmation summary: entry_count + pot (lamports held by the contest PDA
  // above its rent floor — what the void will make claimable as refunds).
  const entryCount = Number(c.entryCount);
  const contestLamports = BigInt(await connection.getBalance(contest));
  const contestSize = (proofbet.account as { contest: { size?: number } }).contest.size ?? CONTEST_SIZE_FALLBACK;
  const contestRentFloor = BigInt(await connection.getMinimumBalanceForRentExemption(contestSize));
  const pot = contestLamports > contestRentFloor ? contestLamports - contestRentFloor : 0n;

  console.log(JSON.stringify({
    action: "void_contest", contestId, contest: contest.toBase58(), status: statusKey,
    entryCount, pot: pot.toString(), potSol: sol(pot),
    note: "voiding refunds every ticket via claim_contest (Voided branch); the keeper pushes no refunds",
    dryRun,
  }, null, 2));
  console.log(
    `void preview · contest ${contestId} · ${entryCount} entr${entryCount === 1 ? "y" : "ies"} · ` +
    `pot ${sol(pot)} ◎ → refundable per-ticket via claim_contest`,
  );

  if (dryRun) { console.log("dry-run: not sending void_contest"); return; }

  // void_contest takes NO args; accounts: settle_authority(signer), contest(mut).
  const sig = await proofbet.methods
    .voidContest()
    .accountsStrict({ settleAuthority: keeper, contest })
    .rpc();
  console.log(JSON.stringify({ action: "void_contest", contestId, status: "voided", sig }, null, 2));
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O).
const isMain = process.argv[1]?.endsWith("void-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
