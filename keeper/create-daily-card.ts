/**
 * Compose + (on a real run) open "Streak"'s ONE daily 6-leg card.
 *
 * Streak shows a single daily card auto-composed from the day's World Cup
 * matches. This keeper is the composer + creator:
 *
 *   authenticate (cached) → fetch today's WC slate + per-(fixture,market) odds
 *   → map onto the allocator's Fixture[] / Odds[] → buildCard(...) → derive a
 *   deterministic contest_id from the UTC day → ensure the leg markets exist
 *   → create_contest (idempotent: skip if the Contest PDA already exists).
 *
 * The pure allocator (engine/src/allocator.ts) does the leg selection; this file
 * only does the I/O (auth, slate, on-chain reads/writes) and the odds mapping.
 *
 * IMPORTS — the allocator is imported RELATIVE (../engine/src/allocator.js), the
 * cross-dir pattern the other keeper files use (create-parlay.ts imports
 * ../engine/src/markets.js). allocator.ts has ZERO imports of its own, so it
 * pulls nothing else into the keeper's typecheck and stays tsc-clean.
 *
 * We deliberately do NOT import engine/src/catalog.ts or engine/src/chain.ts:
 * those engine files use `.ts` import extensions (the engine tsconfig sets
 * moduleResolution:"Bundler" + allowImportingTsExtensions:true), which is
 * incompatible with the keeper's NodeNext tsconfig (allowImportingTsExtensions:
 * false) and trips TS5097. Instead we reuse the SPIKE's getFixtures (spike files
 * use `.js` extensions — NodeNext-clean, already imported by settle.ts) and
 * replicate catalog.ts's tiny slate window/allowlist inline, and read on-chain
 * market pools through the Anchor program with inline PDA derivation — exactly
 * the create-parlay.ts pattern (it derives PDAs inline to avoid importing
 * engine/src/chain.ts for the same reason).
 *
 * Usage:
 *   npx tsx create-daily-card.ts [--dry-run] [--entry-price=0.02] [--window-hours=24]
 *
 *   --dry-run       compose + PRINT the card (contest_id, lock/settle, every leg
 *                   with teams + market label + the implied odds used) and EXIT.
 *                   No markets created, no transaction.
 *   --entry-price   SOL per ticket (default 0.02). fee_bps is hard-wired to 0.
 *   --window-hours  eligibility window for the card (default 24).
 *
 * ── ODDS SOURCE / FALLBACK (important) ─────────────────────────────────────────
 * The TxLINE devnet feed provides FIXTURES + SCORE EVENTS; pre-match StablePrice
 * odds DO exist for some fixtures (`/api/odds/snapshot/{id}` — see
 * spike/src/odds.ts, probed 2026-07-02); the card allocator still runs on
 * pool-implied/neutral priors and can adopt them later. The only odds actually
 * wired into this composer today are on-chain PARIMUTUEL
 * pool-implied probabilities (bucket_total / total_pool), the same source the
 * live board derives via engine getMarkets()/impliedOddsN. We read those same
 * pools here. But a brand-new daily card is composed BEFORE any bets, so the
 * pools are empty (or the market account doesn't exist yet) and carry zero
 * signal. So per (fixture, market):
 *   - pool HAS liquidity → impliedProbs = per-bucket money share (sums to 1).
 *   - pool empty / market absent (the normal compose-time case) → NEUTRAL prior
 *     (3-way Result → [1/3,1/3,1/3]; 2-way O/U → [0.5,0.5]).
 * With neutral priors every match looks equally competitive, so the allocator's
 * spread-first pass just lays one Result leg across as many matches as possible —
 * the intended thin-signal behavior. The quality gate (maxImplied=0.82) never
 * trips on a neutral prior (favorite 0.5 < 0.82); it only bites once real pool
 * money makes a bucket lopsided. Wire a real odds feed later and this mapping is
 * the only thing that changes.
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getFixtures, type Fixture as TxlineFixture } from "../spike/src/discover.js";
import type { Auth, SpikeContext } from "../spike/src/auth.js";
import { marketById, toInitArgs } from "../engine/src/markets.js";
import { loadProofbetProgram } from "./settle.js";
import {
  buildCard,
  DEFAULT_MENU,
  type Card,
  type Fixture,
  type Odds,
} from "../engine/src/allocator.js";

// Named ESM exports aren't exposed through anchor's ESM entry — use the default import.
const BN = anchorDefault.BN;

const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_LEGS = 6; // mirrors contest_state.rs MAX_LEGS; create_contest requires num_legs 3..=6.
const TARGET_LEGS = 6;
const MAX_IMPLIED = 0.82; // quality gate: drop a leg whose favorite implied prob exceeds this.
const MATCH_LEN_SECS = 2 * 3600; // assumed match length (matches the allocator's own buffer).
// Coherent-slate kickoff spread. A real WC day's matches span ~19h; without a cap
// the card would lock at the first kickoff and sit locked most of the day. We keep
// only the cluster within 6h of the earliest eligible kickoff, so lock↔settle is at
// most MAX_SPREAD_SECS + MATCH_LEN_SECS (~8h) — a real, short entry window.
const MAX_SPREAD_SECS = 6 * 3600;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Competitions eligible for the card. Mirrors engine/src/config.ts
 * COMPETITION_ALLOWLIST (default: World Cup — what the devnet free tier carries).
 * Inlined (not imported) so we don't pull engine/src/config.ts — a `.ts`-importing
 * engine file — into the keeper's NodeNext typecheck (TS5097).
 */
const COMPETITION_ALLOWLIST: string[] = (process.env.COMPETITION_ALLOWLIST ?? "World Cup")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface Flags {
  [k: string]: string;
}

export function parseArgs(argv: string[]): Flags {
  const flags: Flags = {};
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v = "true"] = a.slice(2).split("=");
      flags[k] = v;
    }
  }
  return flags;
}

// ── slate fetch (mirrors engine/src/catalog.ts fetchSlate, spike getFixtures) ────

/** Minimal slate fixture shape (the subset we need from TxLINE). */
interface SlateFixture {
  fixtureId: number;
  home: string;
  away: string;
  kickoffMs: number;
}

/**
 * Pull yesterday+today+tomorrow WC fixtures (to straddle midnight UTC), dedupe by
 * FixtureId, filter to the competition allow-list and to [now, now+hoursAhead].
 * This is the catalog.ts fetchSlate logic, reimplemented on the NodeNext-clean
 * spike getFixtures so the keeper typechecks without importing engine/src/catalog.ts.
 */
export async function fetchSlate(
  ctx: SpikeContext,
  auth: Auth,
  hoursAhead: number,
): Promise<SlateFixture[]> {
  const nowMs = Date.now();
  const todayEpochDay = Math.floor(nowMs / DAY_MS);
  const [yesterday, today, tomorrow] = await Promise.all([
    getFixtures(ctx, auth, { startEpochDay: todayEpochDay - 1 }),
    getFixtures(ctx, auth, { startEpochDay: todayEpochDay }),
    getFixtures(ctx, auth, { startEpochDay: todayEpochDay + 1 }),
  ]);

  const seen = new Set<number>();
  const all: TxlineFixture[] = [];
  for (const f of [...yesterday, ...today, ...tomorrow]) {
    if (!seen.has(f.FixtureId)) {
      seen.add(f.FixtureId);
      all.push(f);
    }
  }

  const windowEndMs = nowMs + hoursAhead * 3_600_000;
  return all
    .filter(
      (f) =>
        COMPETITION_ALLOWLIST.includes(f.Competition) &&
        f.StartTime > nowMs &&
        f.StartTime <= windowEndMs,
    )
    .map((f) => ({
      fixtureId: f.FixtureId,
      home: f.Participant1,
      away: f.Participant2,
      kickoffMs: f.StartTime,
    }));
}

// ── contest_id derivation ──────────────────────────────────────────────────────

/**
 * Deterministic contest_id for a UTC day, derived from the day's epochDay
 * (days since the Unix epoch). Same day → same id → the create is idempotent and
 * a settle keeper can re-derive it without state. We namespace it well above any
 * real fixtureId (parlay v2 uses contest_id == fixtureId, ids in the tens of
 * thousands) so a daily card can never collide with a single-match parlay:
 *
 *   contest_id = DAILY_NAMESPACE * 1_000_000 + epochDay
 *
 * epochDay today (2026) is ~20_600 and grows ~365/yr, so it stays < 1e6 for
 * ~2700 years; the whole value is ~7.77e8, far inside u64. Pure + reversible.
 */
const DAILY_NAMESPACE = 777; // arbitrary high tag so daily ids don't collide with fixtureId-keyed parlays.
export function dailyContestId(nowMs: number): { contestId: number; epochDay: number } {
  const epochDay = Math.floor(nowMs / DAY_MS);
  return { contestId: DAILY_NAMESPACE * 1_000_000 + epochDay, epochDay };
}

// ── odds mapping ────────────────────────────────────────────────────────────────

/** Neutral per-bucket prior when no pool money exists yet (sums to 1). */
function neutralProbs(numBuckets: number): number[] {
  return Array(numBuckets).fill(1 / numBuckets);
}

/**
 * Per-bucket implied probabilities from a parimutuel pool: prob[i] = share of the
 * total pool on bucket i. This is the crowd's money distribution — the natural
 * inverse of the payout multiplier engine impliedOddsN returns. Returns null when
 * there is no liquidity (caller falls back to a neutral prior).
 */
export function poolImpliedProbs(bucketTotals: bigint[]): number[] | null {
  const total = bucketTotals.reduce((a, b) => a + b, 0n);
  if (total === 0n) return null;
  return bucketTotals.map((b) => Number(b) / Number(total));
}

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

/** Market PDA: seeds [b"market", fixtureId.to_le_bytes(i64), [marketId]] (mirrors chain.ts). */
function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])], programId,
  )[0];
}
/** Vault PDA: seeds [b"vault", market]. */
function deriveVaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
}

/**
 * Build the allocator's Odds[] for the carded markets across all slate fixtures.
 * For each (fixture, menu-market) pair we read the on-chain market pool via the
 * Anchor program (the same pools the live board reads) and convert it to per-bucket
 * implied probabilities; empty/absent pools fall back to a neutral prior so the
 * market is still "priceable" to the allocator. Returns a tally of how many came
 * from real pools vs the neutral fallback.
 */
async function buildOdds(
  proofbet: AnchorProgramLike,
  fixtures: SlateFixture[],
  menu: number[],
): Promise<{ odds: Odds[]; fromPool: number; fromPrior: number }> {
  const programId = proofbet.programId;
  const odds: Odds[] = [];
  let fromPool = 0;
  let fromPrior = 0;

  for (const f of fixtures) {
    for (const marketId of menu) {
      const def = marketById(marketId);
      if (!def) continue; // unknown market id — can't price what isn't in the catalog.
      const market = deriveMarketPda(programId, f.fixtureId, marketId);
      let probs: number[] | null = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const m: any = await (proofbet.account as any).market.fetchNullable(market);
        if (m) {
          const nb = Number(m.numBuckets);
          const totals = (m.bucketTotals as { toString(): string }[])
            .slice(0, nb)
            .map((b) => BigInt(b.toString()));
          probs = poolImpliedProbs(totals);
        }
      } catch {
        // Account absent (not created yet) or a stale layout → neutral prior.
        probs = null;
      }
      if (probs) {
        fromPool++;
      } else {
        probs = neutralProbs(def.numBuckets);
        fromPrior++;
      }
      odds.push({ fixtureId: f.fixtureId, market: marketId, impliedProbs: probs });
    }
  }
  return { odds, fromPool, fromPrior };
}

// Minimal structural type for the Anchor Program we pass around (avoids importing
// anchor's namespace type just for an annotation; the program comes from settle.ts).
// `account`/`methods` are accessed dynamically (cast to any at the call sites,
// exactly like create-parlay.ts / settle.ts do with the real Program).
type AnchorProgramLike = {
  programId: PublicKey;
  account: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: Record<string, (...args: any[]) => any>;
};

// ── card printing ────────────────────────────────────────────────────────────────

const isoSec = (s: number) => new Date(s * 1000).toISOString();

/** Index odds by `${fixtureId}:${market}` for printing the odds actually used. */
function indexOdds(odds: Odds[]): Map<string, Odds> {
  const m = new Map<string, Odds>();
  for (const o of odds) m.set(`${o.fixtureId}:${o.market}`, o);
  return m;
}

/** Pretty per-bucket label so the printed odds read clearly. */
function bucketLabels(numBuckets: number): string[] {
  return numBuckets === 3 ? ["home", "draw", "away"] : ["over", "under"];
}

/** Print the composed card: contest_id, lock/settle, and each leg in full. */
function printCard(
  card: Card,
  contestId: number,
  epochDay: number,
  fixtures: SlateFixture[],
  odds: Odds[],
  meta: { entryPrice: number; feeBps: number; eligible: number; fromPool: number; fromPrior: number },
): void {
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const idx = indexOdds(odds);

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(` Streak — daily card for UTC day ${epochDay} (${isoSec(epochDay * 86_400).slice(0, 10)})`);
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`contest_id      : ${contestId}`);
  console.log(`num_legs        : ${card.legs.length}`);
  console.log(`lock_ts         : ${card.lockTs}  (${isoSec(card.lockTs)})`);
  console.log(`settle_after_ts : ${card.settleAfterTs}  (${isoSec(card.settleAfterTs)})`);
  const spanSecs = card.settleAfterTs - card.lockTs;
  console.log(`lock↔settle span: ${(spanSecs / 3600).toFixed(2)}h  (${spanSecs}s)`);
  console.log(`entry_price     : ${meta.entryPrice} lamports (${meta.entryPrice / LAMPORTS_PER_SOL} SOL)`);
  console.log(`fee_bps         : ${meta.feeBps}`);
  console.log(`eligible matches: ${meta.eligible}   odds: ${meta.fromPool} from pool / ${meta.fromPrior} neutral prior`);
  console.log("──────────────────────────────────────────────────────────────");

  if (card.legs.length === 0) {
    console.log("(no legs — no eligible WC matches in the window; nothing to create)");
    console.log("══════════════════════════════════════════════════════════════\n");
    return;
  }

  card.legs.forEach((leg, i) => {
    const fx = byId.get(leg.fixtureId);
    const def = marketById(leg.marketId);
    const teams = fx ? `${fx.home} v ${fx.away}` : `fixture ${leg.fixtureId}`;
    const label = def?.label ?? `market ${leg.marketId}`;
    const o = idx.get(`${leg.fixtureId}:${leg.marketId}`);
    const labels = bucketLabels(def?.numBuckets ?? o?.impliedProbs.length ?? 2);
    const oddsStr = o
      ? o.impliedProbs.map((p, b) => `${labels[b] ?? b}=${p.toFixed(3)}`).join("  ")
      : "(no odds)";
    console.log(`leg ${i + 1}  [fx ${leg.fixtureId} / mkt ${leg.marketId}]  ${teams}`);
    console.log(`        ${label.padEnd(22)} implied: ${oddsStr}`);
  });
  console.log("══════════════════════════════════════════════════════════════\n");
}

// ── on-chain leg arrays ──────────────────────────────────────────────────────────

/** Pad an array to MAX_LEGS with `fill` (the program ignores entries beyond num_legs). */
function pad<T>(xs: T[], fill: T): T[] {
  const out = [...xs];
  while (out.length < MAX_LEGS) out.push(fill);
  return out;
}

// ── on-chain create driver ───────────────────────────────────────────────────────

/** Discriminated outcome of createDailyCard (the settle.ts SettleResult convention). */
export type DailyCardResult =
  | { action: "dry-run" }
  | { action: "too-few-legs"; legs: number }
  | { action: "exists"; contest: PublicKey }
  | { action: "created"; contest: PublicKey; sig: string; marketSigs: string[] };

/**
 * Drive ensure-markets + create_contest for a composed card against an Anchor
 * Program — extracted from main() so tests can inject a Program.methods spy and
 * assert the exact wire args with zero network I/O (the create-match-pool.ts
 * createMatchPool precedent). ALL chain effects (account reads and `.rpc()`)
 * live here; `dryRun` returns before any of them.
 */
export async function createDailyCard(
  proofbet: AnchorProgramLike,
  keeper: PublicKey,
  feeRecipient: PublicKey,
  card: Card,
  fixtures: Fixture[],
  contestId: number,
  opts: { entryPriceLamports: number; feeBps: number; dryRun?: boolean },
): Promise<DailyCardResult> {
  if (opts.dryRun) {
    console.log("# --dry-run: composed only, no markets created, no transaction sent.");
    return { action: "dry-run" };
  }

  // create_contest requires num_legs 3..=6. A thin slate that can't reach 3 legs
  // isn't a card worth opening — bail rather than send a tx the program rejects.
  if (card.legs.length < 3) {
    console.log(`# only ${card.legs.length} leg(s) — below the on-chain minimum of 3; not creating a contest.`);
    return { action: "too-few-legs", legs: card.legs.length };
  }
  const numLegs = Math.min(card.legs.length, MAX_LEGS);
  const legs = card.legs.slice(0, numLegs);

  const programId = proofbet.programId;

  // Idempotency: if today's Contest PDA already exists, this card is already live —
  // report and exit (a re-run later in the same UTC day is a no-op).
  const contest = PublicKey.findProgramAddressSync(
    [Buffer.from("contest"), u64le(contestId)], programId,
  )[0];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = await (proofbet.account as any).contest.fetchNullable(contest);
    if (existing) {
      console.log(`# contest ${contest.toBase58()} (id ${contestId}) already exists — nothing to do.`);
      return { action: "exists", contest };
    }
  } catch {
    console.log(`# contest PDA ${contest.toBase58()} is occupied (undecodable) — nothing to do.`);
    return { action: "exists", contest };
  }

  // settle_contest binds result_market.settle_authority == contest.settle_authority,
  // so the keeper must own each leg market. Ensure the per-leg markets exist with
  // the keeper as settle_authority before creating the contest.
  const marketSigs: string[] = [];
  for (const leg of legs) {
    const def = marketById(leg.marketId);
    if (!def) throw new Error(`unknown market id ${leg.marketId} on fixture ${leg.fixtureId}`);
    const fx = fixtures.find((f) => f.fixtureId === leg.fixtureId);
    const entryCloseSec = fx?.kickoffTs ?? card.lockTs; // market entry closes at its own fixture kickoff.
    const market = deriveMarketPda(programId, leg.fixtureId, leg.marketId);
    const vault = deriveVaultPda(programId, market);
    let exists: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exists = (await (proofbet.account as any).market.fetchNullable(market)) !== null;
    } catch { exists = true; }
    if (exists) { console.log(`market ${leg.marketId} exists: fixture ${leg.fixtureId}`); continue; }
    const sig = await proofbet.methods
      .initializeMarket(new BN(leg.fixtureId), leg.marketId, toInitArgs(def, keeper, entryCloseSec))
      .accountsStrict({ creator: keeper, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    marketSigs.push(sig);
    console.log(`created market ${leg.marketId} fixture ${leg.fixtureId}: ${sig}`);
  }

  // create_contest (NO vault). Arg order MUST match the IDL:
  //   contest_id, fixtures[6], market_ids[6], num_legs, entry_price, lock_ts,
  //   settle_after_ts, fee_recipient, fee_bps.
  const fixturesArr = pad(legs.map((l) => l.fixtureId), 0);
  const marketIdsArr = pad(legs.map((l) => l.marketId), 0);
  const sig = await proofbet.methods
    .createContest(
      new BN(contestId),
      fixturesArr.map((f) => new BN(f)),
      marketIdsArr, // [u8; MAX_LEGS] as a plain number[] — matches the program's own tests
      numLegs,
      new BN(opts.entryPriceLamports),
      new BN(card.lockTs),
      new BN(card.settleAfterTs),
      feeRecipient,
      opts.feeBps,
    )
    .accountsStrict({ keeper, contest, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`create_contest: ${sig}`);
  console.log(`contest pubkey: ${contest.toBase58()} (id ${contestId})`);
  return { action: "created", contest, sig, marketSigs };
}

// ── main ─────────────────────────────────────────────────────────────────────────

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === "true";
  const entryPrice = Math.round(Number(flags["entry-price"] ?? "0.02") * LAMPORTS_PER_SOL);
  const feeBps = 0; // hard-wired: the daily card takes no rake.
  const windowSecs = Number(flags["window-hours"] ?? "24") * 3600;

  const nowMs = Date.now();
  const nowSecs = Math.floor(nowMs / 1000);
  const { contestId, epochDay } = dailyContestId(nowMs);

  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider) as unknown as AnchorProgramLike;

  // Fetch today's WC slate. Pull a touch wider than the window so a match near the
  // edge isn't dropped before the allocator's own eligibility filter runs.
  const hoursAhead = windowSecs / 3600 + 12;
  const slate = await fetchSlate(ctx, auth, hoursAhead);
  console.log(`# slate: ${slate.length} in-scope WC fixture(s) in the next ${hoursAhead}h`);

  // Map TxLINE slate → allocator Fixture[] (kickoff ms → unix seconds).
  const fixtures: Fixture[] = slate.map((f) => ({
    fixtureId: f.fixtureId,
    home: f.home,
    away: f.away,
    kickoffTs: Math.floor(f.kickoffMs / 1000),
  }));

  // Build per-(fixture, market) implied odds (on-chain pools w/ neutral fallback).
  const { odds, fromPool, fromPrior } = await buildOdds(proofbet, slate, DEFAULT_MENU);

  // Compose the card with the pure allocator. windowSecs is the OUTER eligibility
  // bound (24h); maxSpreadSecs clusters that down to a coherent slate so the card
  // locks and settles a few hours apart instead of spanning the whole day.
  const card = buildCard(fixtures, odds, {
    lockTs: nowSecs,
    windowSecs,
    target: TARGET_LEGS,
    menu: DEFAULT_MENU,
    maxImplied: MAX_IMPLIED,
    maxSpreadSecs: MAX_SPREAD_SECS,
  });

  const eligibleCount = fixtures.filter(
    (f) => f.kickoffTs > nowSecs && f.kickoffTs + MATCH_LEN_SECS <= nowSecs + windowSecs,
  ).length;
  printCard(card, contestId, epochDay, slate, odds, {
    entryPrice, feeBps, eligible: eligibleCount, fromPool, fromPrior,
  });

  // Dry-run returns inside the driver before ANY chain effect. The keeper is
  // both signer and fee_recipient (single-key devnet posture, as create-match-pool).
  await createDailyCard(proofbet, ctx.wallet.publicKey, ctx.wallet.publicKey, card, fixtures, contestId, {
    entryPriceLamports: entryPrice,
    feeBps,
    dryRun,
  });
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring create-parlay.ts / settle.ts.
const isMain = process.argv[1]?.endsWith("create-daily-card.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
