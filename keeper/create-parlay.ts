/**
 * Open a single-match parlay contest per carded fixture (v2; one contest = one
 * fixture, 4 fixed legs on that match).
 *
 * Each fixture becomes its OWN contest with contest_id == fixtureId. The 4 legs are
 * the result-style markets [16, 15, 12, 11] (1st-half result, 1st-half goals O/U,
 * match result, total goals O/U) — all on the SAME fixture, so leg i = (fixtureId,
 * market_ids[i]).
 *
 * The keeper must create (and later settle) each result market because
 * settle_contest binds result_market.settle_authority == contest.settle_authority
 * (oracle binding). So this CLI ensures the 4 markets exist on the fixture, then
 * calls create_contest with the keeper as settle_authority + fee_recipient.
 *
 * Usage:
 *   npx tsx create-parlay.ts 101:2026-06-30T18:00:00Z [102:2026-06-30T20:00:00Z ...] \
 *     [--entry-price=0.02] [--fee-bps=500] [--dry-run]
 *   npx tsx create-parlay.ts --auto [--entry-price=0.02] [--fee-bps=500] [--dry-run]
 *
 * --auto fetches the live slate and picks up to 3 spaced marquee matches via
 * selectParlayMatches(slate, 3, 120).
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { toInitArgs, marketById } from "../engine/src/markets.js";
import { fetchSlate } from "../engine/src/catalog.js";
import { loadProofbetProgram } from "./settle.js";
import { parlayParams, selectParlayMatches, buildCreateArgs } from "./contest.js";

// Named ESM exports aren't exposed through anchor's ESM entry — use the default import.
const BN = anchorDefault.BN;

const LAMPORTS_PER_SOL = 1_000_000_000;
const AUTO_MAX_MATCHES = 3;
const AUTO_MIN_GAP_MINS = 120;

interface ParsedArgs {
  flags: Record<string, string>;
  cards: { fixtureId: number; kickoffMs: number }[];
}

export function parseArgs(argv: string[]): ParsedArgs {
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
  const dryRun = flags["dry-run"] === "true";
  const entryPrice = Math.round(Number(flags["entry-price"] ?? "0.02") * LAMPORTS_PER_SOL);
  const feeBps = Number(flags["fee-bps"] ?? "500");
  const auto = flags["auto"] === "true";

  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const programId = proofbet.programId;

  // Resolve the card: explicit positional fixtures, or --auto from the live slate.
  let resolved = cards;
  if (auto) {
    const auth = await authenticateCached(ctx);
    const slate = await fetchSlate(ctx, auth, { hoursAhead: 96 });
    const picked = selectParlayMatches(slate, AUTO_MAX_MATCHES, AUTO_MIN_GAP_MINS);
    resolved = picked.map((m) => ({ fixtureId: m.fixtureId, kickoffMs: m.kickoffMs }));
    console.log(`# --auto picked ${resolved.length} fixture(s): ${resolved.map((c) => c.fixtureId).join(", ")}`);
  } else {
    console.log("# --auto not used; creating contests for the explicit <fixtureId>:<iso> args");
  }

  if (resolved.length < 1 || resolved.length > AUTO_MAX_MATCHES) {
    throw new Error(`provide 1..${AUTO_MAX_MATCHES} fixtures as <id>:<kickoffISO> (or use --auto)`);
  }

  for (const card of resolved) {
    const params = parlayParams(card.fixtureId, card.kickoffMs);
    const args = buildCreateArgs(params);
    const lockSec = params.lockTs; // entry close = kickoff for each leg market.

    console.log(JSON.stringify({
      action: "create_parlay",
      contestId: args.contestId,
      fixtures: args.fixtures,
      marketIds: args.marketIds,
      numLegs: args.numLegs,
      lockTs: args.lockTs,
      settleAfterTs: args.settleAfterTs,
      entryPrice, feeBps, keeper: keeper.toBase58(), dryRun,
    }, null, 2));

    // 1. Ensure the 4 leg markets exist on this fixture, settle_authority = keeper.
    for (const mid of params.marketIds) {
      const def = marketById(mid);
      if (!def) throw new Error(`unknown market id ${mid}`);
      const market = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), i64le(card.fixtureId), Buffer.from([mid])], programId,
      )[0];
      const vault = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), market.toBuffer()], programId,
      )[0];
      let exists: boolean;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exists = (await (proofbet.account as any).market.fetchNullable(market)) !== null;
      } catch { exists = true; }
      if (exists) { console.log(`market ${mid} exists: fixture ${card.fixtureId}`); continue; }
      if (dryRun) { console.log(`would create market ${mid}: fixture ${card.fixtureId}`); continue; }
      const sig = await proofbet.methods
        .initializeMarket(new BN(card.fixtureId), mid, toInitArgs(def, keeper, lockSec))
        .accountsStrict({ creator: keeper, market, vault, systemProgram: SystemProgram.programId })
        .rpc();
      console.log(`created market ${mid} fixture ${card.fixtureId}: ${sig}`);
    }

    // 2. create_contest (NO vault). Arg order MUST match the IDL:
    //    contest_id, fixtures, market_ids, num_legs, entry_price, lock_ts,
    //    settle_after_ts, fee_recipient, fee_bps.
    // Inline the contest PDA derivation (seed [b"contest", u64le(contestId)]) so
    // this file doesn't import engine/src/chain.ts — matches settle-all.ts.
    const contest = PublicKey.findProgramAddressSync(
      [Buffer.from("contest"), u64le(args.contestId)], programId,
    )[0];
    if (dryRun) { console.log(`would create_contest ${contest.toBase58()}`); continue; }
    const sig = await proofbet.methods
      .createContest(
        new BN(args.contestId),
        args.fixtures.map((f) => new BN(f)),
        args.marketIds, // [u8; 5] as a plain number[] — matches the program's own tests
        args.numLegs,
        new BN(entryPrice),
        new BN(args.lockTs),
        new BN(args.settleAfterTs),
        keeper,
        feeBps,
      )
      .accountsStrict({ keeper, contest, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`create_contest: ${sig}`);
    console.log(`contest pubkey: ${contest.toBase58()}`);
  }
}

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("create-parlay.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
