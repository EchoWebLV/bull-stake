/**
 * Open a daily sweepstake contest for a FIXED card (M0; adaptive build is M1).
 *
 * Usage:
 *   npx tsx create-contest.ts 101:2026-06-30T18:00:00Z 102:2026-06-30T20:00:00Z 103:2026-06-30T21:00:00Z \
 *     [--entry-price=0.02] [--fee-bps=500] [--dry-run]
 *
 * For each carded fixture it ensures the result market (market_id 12) exists — it MUST be
 * created (and later settled) by THIS keeper, because settle_contest binds
 * result_market.settle_authority == contest.settle_authority (v3.1 oracle binding). Then it
 * calls create_contest with the keeper as settle_authority and fee_recipient.
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { toInitArgs, MARKET_TEMPLATE } from "../engine/src/markets.js";
import { loadProofbetProgram } from "./settle.js";
import { computeContestParams } from "./contest.js";

// Named ESM exports aren't exposed through anchor's ESM entry — use the default import.
const BN = anchorDefault.BN;

const MAX_MATCHES = 5;
const RESULT_MARKET_ID = 12;
const LAMPORTS_PER_SOL = 1_000_000_000;

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const cards: { fixtureId: number; kickoffMs: number }[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v = "true"] = a.slice(2).split("=");
      flags[k] = v;
    } else {
      // Split on the FIRST colon only — the ISO kickoff (e.g. 2026-07-01T01:00:00Z) has colons.
      const idx = a.indexOf(":");
      const id = a.slice(0, idx);
      const iso = a.slice(idx + 1);
      cards.push({ fixtureId: Number(id), kickoffMs: Date.parse(iso) });
    }
  }
  return { flags, cards };
}

async function main() {
  const { flags, cards } = parseArgs(process.argv.slice(2));
  if (cards.length < 3 || cards.length > MAX_MATCHES) {
    throw new Error(`provide 3..${MAX_MATCHES} fixtures as <id>:<kickoffISO>`);
  }
  const dryRun = flags["dry-run"] === "true";
  const entryPrice = Math.round(Number(flags["entry-price"] ?? "0.02") * LAMPORTS_PER_SOL);
  const feeBps = Number(flags["fee-bps"] ?? "500");

  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const programId = proofbet.programId;

  const params = computeContestParams(cards);
  const kickoffById = new Map(cards.map((c) => [c.fixtureId, c.kickoffMs]));

  console.log(JSON.stringify({
    action: "create_contest", contestId: params.contestId, fixtures: params.orderedFixtures,
    numMatches: params.numMatches, lockTs: params.lockTs, settleAfterTs: params.settleAfterTs,
    entryPrice, feeBps, keeper: keeper.toBase58(), dryRun,
  }, null, 2));

  // 1. Ensure each result market (market_id 12) exists, settle_authority = keeper.
  const resultDef = MARKET_TEMPLATE.find((m) => m.marketId === RESULT_MARKET_ID)!;
  for (const fixtureId of params.orderedFixtures) {
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), i64le(fixtureId), Buffer.from([RESULT_MARKET_ID])], programId,
    )[0];
    const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
    let exists: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exists = (await (proofbet.account as any).market.fetchNullable(market)) !== null;
    } catch { exists = true; }
    if (exists) { console.log(`result market exists: fixture ${fixtureId}`); continue; }
    if (dryRun) { console.log(`would create result market: fixture ${fixtureId}`); continue; }
    const kickoffSec = Math.floor((kickoffById.get(fixtureId) ?? 0) / 1000);
    const sig = await proofbet.methods
      .initializeMarket(new BN(fixtureId), RESULT_MARKET_ID, toInitArgs(resultDef, keeper, kickoffSec))
      .accountsStrict({ creator: keeper, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`created result market fixture ${fixtureId}: ${sig}`);
  }

  // 2. create_contest.
  const fixturesArg = padFixtures(params.orderedFixtures);
  const contest = PublicKey.findProgramAddressSync(
    [Buffer.from("contest"), u64le(params.contestId)], programId,
  )[0];
  const jackpotVault = PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
  if (dryRun) { console.log(`would create_contest ${contest.toBase58()}`); return; }
  const sig = await proofbet.methods
    .createContest(
      new BN(params.contestId), fixturesArg, params.numMatches, new BN(entryPrice),
      new BN(params.lockTs), new BN(params.settleAfterTs), keeper, feeBps,
    )
    .accountsStrict({ keeper, vault: jackpotVault, contest, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`create_contest: ${sig}`);
  console.log(`contest pubkey: ${contest.toBase58()}`);
}

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
/** Pad fixtures to [i64; 5] with BN(0) (program ignores entries beyond num_matches). */
function padFixtures(ids: number[]) {
  const out = ids.map((id) => new BN(id));
  while (out.length < MAX_MATCHES) out.push(new BN(0));
  return out;
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("create-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
