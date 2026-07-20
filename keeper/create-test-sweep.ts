/**
 * create-test-sweep.ts — stand up a PLAYABLE TEST SWEEP card, on-chain, now.
 *
 * The Sweep counterpart to run-test-match.ts. It creates a real devnet Contest
 * over the six synthetic matches in TEST_SWEEP_LEGS (engine/src/testMatch.ts) —
 * real escrow, real 6-leg survival card, real 0.035◎ entry from a player's Privy
 * wallet — so a tester can open the /test page's Sweep tab and enter a card on
 * camera: pick every leg, pay, watch it go alive at ×64.
 *
 * Only the fixtures are synthetic (ids 10_000_000_00X, outside any TxLINE range).
 * The engine serves the card via /api/card?test=1 (the /test-page audience), and
 * names each leg from the SAME TEST_SWEEP_LEGS roster this script builds it from,
 * so the card reads as six distinct World Cup ties rather than "#<fixtureId>".
 *
 * Leg kickoffs are staggered into the near future so the whole card is pickable
 * and entries stay open through the recording window: leg i locks at
 * now + firstMins + i*stepMins. On-chain, entries close when open legs would
 * drop below 3 (the 4th-earliest kickoff), and `lock_ts` == the earliest leg.
 *
 *   npx tsx create-test-sweep.ts                    6 legs, first KO 18m, 8m apart
 *   npx tsx create-test-sweep.ts --first-mins 5     open the entry window sooner
 *   npx tsx create-test-sweep.ts --legs 4           a shorter 4-leg card (×16)
 *   npx tsx create-test-sweep.ts --dry-run          print the plan, touch nothing
 *
 * Re-running stands up a FRESH card (new contestId) that supersedes the last —
 * selectTodaysCard(wantTest) always serves the most recently created test card,
 * so a demo re-take never lands on a stale one. The leg markets are keyed by the
 * fixed roster fixtureIds, so they're created once and reused across runs.
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { toInitArgs, marketById } from "../engine/src/markets.js";
import { TEST_SWEEP_LEGS } from "../engine/src/testMatch.js";
import { loadProofbetProgram } from "./settle.js";

const { BN } = anchorDefault;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_LEGS = 6;

function flag(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

async function main() {
  const firstMins = flag("first-mins", 18);
  const stepMins = flag("step-mins", 8);
  const numLegs = Math.max(3, Math.min(MAX_LEGS, flag("legs", 6)));
  const entryPrice = Math.round(
    Number(process.env.ENTRY_PRICE_SOL ?? flagStr("entry-price") ?? "0.035") * LAMPORTS_PER_SOL,
  );
  const feeBps = Number(flagStr("fee-bps") ?? process.env.FEE_BPS ?? "500");
  const dryRun = process.argv.includes("--dry-run");

  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const programId = proofbet.programId;

  const legs = TEST_SWEEP_LEGS.slice(0, numLegs);
  const nowSec = Math.floor(Date.now() / 1000);
  // Leg i kicks off (locks) at now + firstMins + i*stepMins. lock_ts is the
  // earliest (leg 0); settle opens a generous hour after the last kickoff.
  const legLockSecs = legs.map((_, i) => nowSec + (firstMins + i * stepMins) * 60);
  const lockTs = legLockSecs[0];
  const settleAfterTs = legLockSecs[legLockSecs.length - 1] + 60 * 60;
  // Unique, memorable, always >= TEST_FIXTURE_MIN (9_900_000_000): the test band
  // 10_000_000_000 + seconds-of-era, distinct per run.
  const contestId = 10_000_000_000 + (nowSec % 100_000_000);

  // Padded on-chain arrays ([_; MAX_LEGS], zero tail beyond num_legs).
  const fixtures = legs.map((l) => l.fixtureId);
  const marketIds = legs.map((l) => l.marketId);
  const legLocks = [...legLockSecs];
  while (fixtures.length < MAX_LEGS) fixtures.push(0);
  while (marketIds.length < MAX_LEGS) marketIds.push(0);
  while (legLocks.length < MAX_LEGS) legLocks.push(0);

  // entries_close_ts the program will derive: the (numLegs - 3)-th smallest lock.
  const entriesCloseTs = [...legLockSecs].sort((a, b) => a - b)[numLegs - 3];

  console.log(JSON.stringify({
    action: "create_test_sweep",
    contestId,
    numLegs,
    entryPrice: entryPrice / LAMPORTS_PER_SOL,
    feeBps,
    lockTs: new Date(lockTs * 1000).toISOString(),
    entriesCloseTs: new Date(entriesCloseTs * 1000).toISOString(),
    settleAfterTs: new Date(settleAfterTs * 1000).toISOString(),
    legs: legs.map((l, i) => ({
      leg: i, fixtureId: l.fixtureId, matchup: `${l.home} v ${l.away}`,
      market: marketById(l.marketId)?.label ?? `#${l.marketId}`,
      kickoff: new Date(legLockSecs[i] * 1000).toISOString(),
    })),
    keeper: keeper.toBase58(), dryRun,
  }, null, 2));

  // 1. Ensure each leg's result market exists (settle_authority = keeper — the
  //    same binding create_contest requires so this keeper can later settle it).
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const def = marketById(leg.marketId);
    if (!def) throw new Error(`unknown market id ${leg.marketId}`);
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), i64le(leg.fixtureId), Buffer.from([leg.marketId])], programId,
    )[0];
    const vault = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), market.toBuffer()], programId,
    )[0];
    let exists: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exists = (await (proofbet.account as any).market.fetchNullable(market)) !== null;
    } catch { exists = true; }
    if (exists) { console.log(`market ${leg.marketId} exists: fixture ${leg.fixtureId} (${leg.home} v ${leg.away})`); continue; }
    if (dryRun) { console.log(`would create market ${leg.marketId}: fixture ${leg.fixtureId}`); continue; }
    const sig = await proofbet.methods
      .initializeMarket(new BN(leg.fixtureId), leg.marketId, toInitArgs(def, keeper, legLockSecs[i]))
      .accountsStrict({ creator: keeper, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`created market ${leg.marketId} fixture ${leg.fixtureId}: ${sig}`);
  }

  // 2. create_contest (arg order MUST match the IDL: contest_id, fixtures,
  //    market_ids, num_legs, entry_price, lock_ts, settle_after_ts,
  //    fee_recipient, fee_bps, leg_lock_ts).
  const contest = PublicKey.findProgramAddressSync(
    [Buffer.from("contest"), u64le(contestId)], programId,
  )[0];
  if (dryRun) { console.log(`would create_contest ${contest.toBase58()}`); return; }
  const sig = await proofbet.methods
    .createContest(
      new BN(contestId),
      fixtures.map((f) => new BN(f)),
      marketIds,
      numLegs,
      new BN(entryPrice),
      new BN(lockTs),
      new BN(settleAfterTs),
      keeper,
      feeBps,
      legLocks.map((t) => new BN(t)),
    )
    .accountsStrict({ keeper, contest, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`create_contest: ${sig}`);
  console.log(`contest pubkey: ${contest.toBase58()}`);
  console.log(`\n[test-sweep] card ${contestId} is LIVE on the /test page's Sweep tab — ENTER NOW.`);
  console.log(`[test-sweep] entries open ~${Math.round((entriesCloseTs - nowSec) / 60)} min · ${numLegs} legs · ×${2 ** numLegs} perfect-card weight`);
}

/** String-valued flag (`--name value`) helper — numbers use flag() above. */
function flagStr(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1]?.endsWith("create-test-sweep.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
