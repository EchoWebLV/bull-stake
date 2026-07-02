/**
 * On-chain bet history for a wallet.
 *
 * The `Position` PDA is closed on claim (`close = bettor`), so it cannot be the
 * source of truth for past wins — once a bettor claims, their position is gone.
 * Instead we reconstruct history from the program's permanent event log:
 *   - `BetPlaced` (market, bettor, bucket, amount) — every stake
 *   - `Claimed`   (market, bettor, payout, voided) — the terminal outcome
 * joined with the current on-chain `Market` (status / winning bucket / pools).
 *
 * Events are parsed from recent program transactions and cached briefly so the
 * UI can poll without hammering the RPC.
 */

import { EventParser } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getProgram, readMarket, type MarketView } from "./chain.ts";
import { MARKET_TEMPLATE } from "./markets.ts";
import { impliedOddsN } from "./odds.ts";

// How many of the wallet's recent signatures to scan, and how long to cache.
const SIG_LIMIT = 200;
const CACHE_TTL_MS = 20_000;
// Helius (and most public RPCs) reject JSON-RPC *batch* requests, so we fetch
// transactions individually with a small concurrency pool rather than via the
// batched getTransactions().
const CONCURRENCY = 4;

export type HistoryStatus =
  | "pending"          // market still open
  | "won"              // settled, winning side, already claimed
  | "lost"             // settled, losing side (claimed or not — nothing to collect)
  | "refunded"         // voided, refund already claimed
  | "claimable-won"    // settled, winning side, not yet claimed
  | "claimable-refund" // voided, not yet claimed
  | "legacy";          // bet on a pre-upgrade market the current program can't read

/**
 * One outcome of a market, from the bettor's point of view. A market has one leg
 * per bucket (2 for O/U, 3 for 1X2) so the UI can show the full picture: the
 * outcomes you backed, their stake/odds/projected return, and the ones you left
 * alone. Replaces the old single collapsed "side" (which became a useless
 * "Multiple" the moment you backed more than one outcome).
 */
export interface HistoryLeg {
  bucket: number;
  side: string;            // outcome label: team name | "Draw" | "Over" | "Under"
  backed: boolean;         // the wallet staked on this outcome
  stakeLamports: string;   // stake on this outcome (0 if not backed)
  odds: number;            // current pool-implied multiplier (0 when no price)
  payoutLamports: string;  // open → projected if it wins; settled-win → realized; void → refund; else 0
  result: "won" | "lost" | "refunded" | null; // per-outcome resolution (null while open)
}

export interface HistoryEntry {
  market: string;          // market PDA (base58) — for explorer link
  fixtureId: number;
  marketId: number;
  label: string;           // e.g. "Total Corners O/U 9.5"
  group: string;           // corners | goals | result | cards
  line: number;
  settleAt: "HT" | "FT";
  home: string;
  away: string;
  side: string;            // "Over" | "Under" | "Yes" | "No" | "Both"
  bucket: number;          // primary bucket bet (0/1; -1 if both)
  stakeLamports: string;
  payoutLamports: string;  // realized (claimed) or claimable, in lamports
  status: HistoryStatus;
  settledValue: number | null; // the proved stat value, when settled
  legs: HistoryLeg[];      // per-outcome breakdown (empty for legacy markets)
  betSig: string;          // first BetPlaced tx — explorer link
  claimSig: string | null; // Claimed tx, if any
  tsMs: number;            // most recent activity timestamp
}

// ── Pure reconstruction core (unit-tested) ──────────────────────────────────

export interface MarketSnapshot {
  status: "open" | "settled" | "voided";
  winningBucket: number | null;
  bucketTotals: bigint[];
  totalPool: bigint;
  feeCollected: bigint;
  feeBps?: number; // fee basis points (0 for current markets); used for live odds
}

export interface ClaimInfo {
  payout: bigint;
  voided: boolean;
}

/**
 * Parimutuel payout for `stake` if `bucket` wins — mirrors claim.rs.
 * Generalized to any bucket so it serves both the realized winner and the
 * "what would this outcome pay" projection on a still-open market.
 */
export function payoutIfWins(stake: bigint, bucket: number, market: MarketSnapshot): bigint {
  if (stake <= 0n) return 0n;
  const winnerTotal = market.bucketTotals[bucket] ?? 0n;
  if (winnerTotal <= 0n) return 0n;
  const distributable = market.totalPool - market.feeCollected;
  return (stake * distributable) / winnerTotal;
}

/** Parimutuel payout for `stake` on the winning bucket — mirrors claim.rs. */
export function winningPayout(stake: bigint, market: MarketSnapshot): bigint {
  const wb = market.winningBucket;
  if (wb == null) return 0n;
  return payoutIfWins(stake, wb, market);
}

/**
 * Decide a bet's display status + payout from the stake per bucket, the current
 * market snapshot, and a Claimed event if the bettor already collected.
 * Pure — no I/O.
 */
export function reconstructStatus(
  stake: bigint[],
  market: MarketSnapshot,
  claim: ClaimInfo | null,
): { status: HistoryStatus; payout: bigint } {
  if (claim) {
    if (claim.voided) return { status: "refunded", payout: claim.payout };
    return claim.payout > 0n
      ? { status: "won", payout: claim.payout }
      : { status: "lost", payout: 0n };
  }

  if (market.status === "open") return { status: "pending", payout: 0n };

  if (market.status === "voided") {
    return { status: "claimable-refund", payout: stake.reduce((a, b) => a + b, 0n) };
  }

  // settled
  const wb = market.winningBucket;
  const wonStake = wb == null ? 0n : stake[wb];
  if (wonStake > 0n) {
    return { status: "claimable-won", payout: winningPayout(wonStake, market) };
  }
  return { status: "lost", payout: 0n };
}

/**
 * Expand a bet into one leg per market outcome — the data the My Bets view needs
 * to show exactly what you backed, at what odds, and what each outcome pays.
 * Pure: `stake[b]` is the wallet's stake on bucket b; `labelFor(b)` names it.
 *
 *   - open    → each leg's payout is the projection "if this outcome wins now"
 *   - settled → winning bucket marked "won" (realized payout); others "lost"
 *   - voided  → every leg "refunded", backed legs refund their stake
 */
export function buildLegs(
  stake: bigint[],
  market: MarketSnapshot,
  numBuckets: number,
  labelFor: (bucket: number) => string,
): HistoryLeg[] {
  const feeBps = market.feeBps ?? 0;
  const legs: HistoryLeg[] = [];
  for (let b = 0; b < numBuckets; b++) {
    const legStake = stake[b] ?? 0n;
    const backed = legStake > 0n;
    let payout = 0n;
    let result: HistoryLeg["result"] = null;

    if (market.status === "settled") {
      result = market.winningBucket === b ? "won" : "lost";
      if (result === "won") payout = payoutIfWins(legStake, b, market);
    } else if (market.status === "voided") {
      result = "refunded";
      payout = legStake; // full refund of whatever sat on this outcome
    } else {
      payout = payoutIfWins(legStake, b, market); // open: projected if it wins
    }

    legs.push({
      bucket: b,
      side: labelFor(b),
      backed,
      stakeLamports: legStake.toString(),
      odds: impliedOddsN(market.bucketTotals, b, feeBps),
      payoutLamports: payout.toString(),
      result,
    });
  }
  return legs;
}

// ── Event gathering (I/O) ────────────────────────────────────────────────────

interface BetEvent { market: string; bucket: number; amount: bigint; sig: string; tsMs: number; }
interface ClaimEvent { market: string; payout: bigint; voided: boolean; sig: string; tsMs: number; }

// Per-wallet cache so repeated polls don't re-scan the chain.
const cache = new Map<string, { at: number; bets: BetEvent[]; claims: ClaimEvent[] }>();

/**
 * Gather the wallet's own BetPlaced / Claimed events. The bettor signs every
 * place_bet and claim, so the wallet's signature history contains exactly the
 * relevant transactions — far fewer than the whole program's, and naturally
 * scoped to this user.
 */
async function gatherEvents(wallet: string, nowMs: number): Promise<{ bets: BetEvent[]; claims: ClaimEvent[] }> {
  const hit = cache.get(wallet);
  if (hit && nowMs - hit.at < CACHE_TTL_MS) return hit;

  const program = getProgram();
  const connection = program.provider.connection;
  const sigInfos = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: SIG_LIMIT });
  const sigs = sigInfos.map((s) => s.signature);

  const parser = new EventParser(program.programId, program.coder);
  const bets: BetEvent[] = [];
  const claims: ClaimEvent[] = [];

  // Fetch each transaction individually, CONCURRENCY at a time (no JSON-RPC batch).
  let next = 0;
  async function worker() {
    while (next < sigs.length) {
      const i = next++;
      const tx = await connection.getTransaction(sigs[i], { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const logs = tx?.meta?.logMessages;
      if (!logs) continue;
      const tsMs = ((tx?.blockTime ?? sigInfos[i].blockTime ?? 0) as number) * 1000;
      for (const ev of parser.parseLogs(logs)) {
        const name = ev.name.toLowerCase();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = ev.data as any;
        // Only this wallet's own bets/claims (defensive — the tx is theirs anyway).
        if (name === "betplaced" && d.bettor.toBase58() === wallet) {
          bets.push({ market: d.market.toBase58(), bucket: Number(d.bucket), amount: BigInt(d.amount.toString()), sig: sigs[i], tsMs });
        } else if (name === "claimed" && d.bettor.toBase58() === wallet) {
          claims.push({ market: d.market.toBase58(), payout: BigInt(d.payout.toString()), voided: !!d.voided, sig: sigs[i], tsMs });
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sigs.length) }, worker));

  const result = { at: nowMs, bets, claims };
  cache.set(wallet, result);
  return result;
}

function snapshotFrom(mv: MarketView): MarketSnapshot {
  return {
    status: mv.status,
    winningBucket: mv.winningBucket,
    bucketTotals: mv.bucketTotals.map((b) => BigInt(b)),
    totalPool: BigInt(mv.totalPool),
    feeCollected: BigInt(mv.feeCollected),
    feeBps: mv.feeBps,
  };
}

export function sideLabel(group: string, bucket: number, home: string, away: string): string {
  if (bucket < 0) return "Multiple";
  if (group === "result") {
    if (bucket === 1) return "Draw";
    const team = bucket === 0 ? home : away;
    return team && !team.startsWith("Fixture ") ? team : bucket === 0 ? "Home" : "Away";
  }
  if (group === "line") return bucket === 0 ? "Above" : "Below";
  return bucket === 0 ? "Over" : "Under";
}

/**
 * Build the bet history for `wallet`, newest first.
 * `fixtureMeta` maps fixtureId → team names (from the LiveStore slate).
 */
export async function fetchHistory(
  wallet: string,
  fixtureMeta: Map<number, { home: string; away: string }>,
  nowMs = Date.now(),
): Promise<HistoryEntry[]> {
  const { bets, claims } = await gatherEvents(wallet, nowMs);

  // Aggregate stakes per market into a per-bucket array (oldest bet sig is the
  // "placed" receipt). Three outcome slots cover both binary and 3-way markets.
  const byMarket = new Map<string, { stake: bigint[]; firstSig: string; tsMs: number }>();
  for (const b of bets) {
    const agg = byMarket.get(b.market) ?? { stake: [0n, 0n, 0n], firstSig: b.sig, tsMs: b.tsMs };
    if (b.bucket >= 0 && b.bucket < agg.stake.length) agg.stake[b.bucket] += b.amount;
    agg.tsMs = Math.max(agg.tsMs, b.tsMs);
    byMarket.set(b.market, agg);
  }

  const claimByMarket = new Map<string, ClaimEvent>();
  for (const c of claims) claimByMarket.set(c.market, c);

  const entries: HistoryEntry[] = [];
  for (const [market, agg] of byMarket) {
    const claimEvForMarket = claimByMarket.get(market) ?? null;
    let mv: MarketView;
    try {
      mv = await readMarket(market);
    } catch {
      // Pre-upgrade market the current IDL can't decode. Don't drop the bet —
      // surface it as a read-only "legacy" receipt from the event data alone.
      const stake = agg.stake.reduce((a, b) => a + b, 0n);
      entries.push({
        market, fixtureId: 0, marketId: -1, label: "Pre-upgrade market", group: "",
        line: 0, settleAt: "FT", home: "Legacy bet", away: "",
        side: "—", bucket: -1,
        stakeLamports: stake.toString(),
        payoutLamports: (claimEvForMarket?.payout ?? 0n).toString(),
        status: "legacy",
        settledValue: null,
        legs: [],
        betSig: agg.firstSig,
        claimSig: claimEvForMarket?.sig ?? null,
        tsMs: Math.max(agg.tsMs, claimEvForMarket?.tsMs ?? 0),
      });
      continue;
    }

    const claimEv = claimByMarket.get(market) ?? null;
    const claim: ClaimInfo | null = claimEv ? { payout: claimEv.payout, voided: claimEv.voided } : null;
    const stake = agg.stake.slice(0, mv.numBuckets);
    const snapshot = snapshotFrom(mv);
    const { status, payout } = reconstructStatus(stake, snapshot, claim);

    const def = MARKET_TEMPLATE.find((d) => d.marketId === mv.marketId);
    const meta = fixtureMeta.get(mv.fixtureId);
    const home = meta?.home ?? `Fixture ${mv.fixtureId}`;
    const away = meta?.away ?? "";
    const betBuckets = stake.map((s, i) => (s > 0n ? i : -1)).filter((i) => i >= 0);
    const primaryBucket = betBuckets.length === 1 ? betBuckets[0] : -1;
    const legs = buildLegs(stake, snapshot, mv.numBuckets, (b) => sideLabel(def?.group ?? "", b, home, away));

    entries.push({
      market,
      fixtureId: mv.fixtureId,
      marketId: mv.marketId,
      label: def?.label ?? `Market #${mv.marketId}`,
      group: def?.group ?? "",
      line: def?.line ?? 0,
      settleAt: def?.settleAt ?? "FT",
      home,
      away,
      side: sideLabel(def?.group ?? "", primaryBucket, home, away),
      bucket: primaryBucket,
      stakeLamports: stake.reduce((a, b) => a + b, 0n).toString(),
      payoutLamports: payout.toString(),
      status,
      settledValue: mv.status === "settled" ? mv.settledValue : null,
      legs,
      betSig: agg.firstSig,
      claimSig: claimEv?.sig ?? null,
      tsMs: Math.max(agg.tsMs, claimEv?.tsMs ?? 0),
    });
  }

  entries.sort((a, b) => b.tsMs - a.tsMs);
  return entries;
}
