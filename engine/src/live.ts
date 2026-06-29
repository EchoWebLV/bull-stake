/**
 * LiveStore — in-memory cache of match state + on-chain market data.
 *
 * The store is seeded from the catalog slate (setSlate) and refreshed every
 * ~8 seconds by a background poll loop (start).  During tests the loop is
 * never started; routes inject a mock store instead.
 *
 * Per-fixture state:
 *   - status: "upcoming" | "live" | "ft"
 *   - live score / phase / minute / corners / goals / yellows (from TxLINE)
 *   - on-chain market data (bucketTotals, impliedOdds) for all 8 markets
 */

import type { Auth, SpikeContext } from "../../spike/src/auth.js";
import { getScoreHistory, resolvePhase } from "../../spike/src/discover.js";
import { FINISHED_PHASES } from "../../spike/src/config.js";
import { MARKET_TEMPLATE } from "./markets.ts";
import { deriveMarketPda } from "./chain.ts";
import { impliedOddsN } from "./odds.ts";
import { PROGRAM_ID } from "./config.ts";
import type { MarketDef } from "./markets.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type MatchStatus = "upcoming" | "live" | "ft";

export interface LiveMatch {
  fixtureId: number;
  home: string;
  away: string;
  kickoffMs: number;
  status: MatchStatus;
  minute: number | null;
  phase: string | null;
  scoreH: number;
  scoreA: number;
  corners: number;
  goals: number;
  yellows: number;
}

export interface LiveMarket {
  marketId: number;
  label: string;
  group: MarketDef["group"];
  line: number;
  settleAt: MarketDef["settleAt"];
  numBuckets: number;
  status: "open" | "settled" | "voided" | "none";
  bucketTotals: string[];
  totalPool: string;
  /** Per-bucket implied multiplier (length numBuckets). */
  odds: number[];
  winningBucket: number | null;
}

interface SlateEntry {
  fixtureId: number;
  home: string;
  away: string;
  kickoffMs: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** No football match plausibly runs past this; beyond it, assume finished. */
const MAX_LIVE_MS = 3 * 60 * 60 * 1000;

/** Classify a fixture into live / upcoming / ft. */
export function classifyStatus(kickoffMs: number, phaseCode: number | null, nowMs: number): MatchStatus {
  if (nowMs < kickoffMs) return "upcoming";
  if (phaseCode !== null && FINISHED_PHASES.has(phaseCode)) return "ft";
  // Backstop: if kickoff was hours ago and we still see no finished phase (e.g.
  // TxLINE's latest event is a stats-only update), treat it as finished rather
  // than perpetually "live" with an ever-growing minute.
  if (nowMs - kickoffMs > MAX_LIVE_MS) return "ft";
  return "live";
}

/** Sort matches: live first, then upcoming, then ft. */
export function sortMatches(matches: LiveMatch[]): LiveMatch[] {
  const order: Record<MatchStatus, number> = { live: 0, upcoming: 1, ft: 2 };
  return [...matches].sort((a, b) => order[a.status] - order[b.status]);
}

// ── LiveStore ─────────────────────────────────────────────────────────────────

export class LiveStore {
  private slate: SlateEntry[] = [];
  private matchCache = new Map<number, LiveMatch>();
  private marketCache = new Map<number, LiveMarket[]>();
  // fixtureId → team names, accumulated across slates and never pruned, so bet
  // history can label fixtures even after they age out of the live board window.
  private fixtureNames = new Map<number, { home: string; away: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Seed the store with fixture metadata (from the catalog slate). */
  setSlate(fixtures: SlateEntry[]): void {
    this.slate = fixtures;
    const ids = new Set(fixtures.map((f) => f.fixtureId));

    // Prune board caches to the current window — fixtures that aged out drop off
    // the board (they remain visible in bet history via fixtureNames below).
    for (const id of [...this.matchCache.keys()]) if (!ids.has(id)) this.matchCache.delete(id);
    for (const id of [...this.marketCache.keys()]) if (!ids.has(id)) this.marketCache.delete(id);

    // Initialise entries so /api/matches works before the first poll, and record
    // names persistently for history labelling.
    const nowMs = Date.now();
    for (const f of fixtures) {
      this.fixtureNames.set(f.fixtureId, { home: f.home, away: f.away });
      if (!this.matchCache.has(f.fixtureId)) {
        this.matchCache.set(f.fixtureId, {
          fixtureId: f.fixtureId,
          home: f.home,
          away: f.away,
          kickoffMs: f.kickoffMs,
          status: nowMs < f.kickoffMs ? "upcoming" : "live",
          minute: null,
          phase: null,
          scoreH: 0,
          scoreA: 0,
          corners: 0,
          goals: 0,
          yellows: 0,
        });
      }
    }
  }

  /** Return sorted list of all cached matches. */
  getMatches(): LiveMatch[] {
    return sortMatches(Array.from(this.matchCache.values()));
  }

  /** Return the 8-market list for a fixture (or [] if unknown). */
  getMarkets(fixtureId: number): LiveMarket[] {
    return this.marketCache.get(fixtureId) ?? [];
  }

  /** fixtureId → team names (accumulated, never pruned), for bet-history labels. */
  getFixtureMeta(): Map<number, { home: string; away: string }> {
    return this.fixtureNames;
  }

  /** Merge fixture names into the persistent map WITHOUT touching the live board
   *  (matchCache/slate). Used to resolve a contest card whose matches are beyond
   *  the board's ~36h window — names only, no extra board rows. */
  addFixtureNames(fixtures: { fixtureId: number; home: string; away: string }[]): void {
    for (const f of fixtures) {
      this.fixtureNames.set(f.fixtureId, { home: f.home, away: f.away });
    }
  }

  /**
   * Start the background poll loop (called once when the server boots,
   * NOT in tests).
   */
  start(ctx: SpikeContext, auth: Auth): void {
    const INTERVAL_MS = 8_000;

    const tick = async () => {
      try {
        await this._poll(ctx, auth);
      } catch {
        // swallow errors — best-effort; timer continues below
      }
      this.timer = setTimeout(tick, INTERVAL_MS);
    };

    // Kick off immediately, then repeat.
    this.timer = setTimeout(tick, 0);
  }

  /** Stop the poll loop (for clean shutdown). */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ── Internal poll ──────────────────────────────────────────────────────────

  /** One poll cycle: refresh score state + on-chain markets for all slate fixtures. */
  async _poll(ctx: SpikeContext, auth: Auth): Promise<void> {
    const nowMs = Date.now();

    for (const f of this.slate) {
      // Determine current phase before deciding whether to fetch score history.
      const existing = this.matchCache.get(f.fixtureId);
      const isKickoffPassed = nowMs >= f.kickoffMs;

      let phaseCode: number | null = null;
      let phaseLabel: string | null = null;
      let scoreH = existing?.scoreH ?? 0;
      let scoreA = existing?.scoreA ?? 0;
      let corners = existing?.corners ?? 0;
      let goals = existing?.goals ?? 0;
      let yellows = existing?.yellows ?? 0;
      let minute: number | null = existing?.minute ?? null;

      if (isKickoffPassed) {
        try {
          const events = await getScoreHistory(ctx, auth, f.fixtureId);
          if (events.length > 0) {
            // Stats from the highest-Seq (most complete) event.
            const latest = events.reduce((best, ev) => (ev.Seq > best.Seq ? ev : best), events[0]);
            // Phase from the highest-Seq event that actually carries a phase code.
            // A trailing stats-only update can lack one, which would otherwise make
            // a finished match read as "live" with an absurd minute.
            const coded = events
              .map((ev) => ({ ev, ...resolvePhase(ev) }))
              .filter((e) => e.code !== null)
              .sort((a, b) => b.ev.Seq - a.ev.Seq)[0];
            phaseCode = coded?.code ?? null;
            phaseLabel = coded?.label ?? null;

            const stats = latest.Stats ?? {};
            scoreH = stats["1"] ?? 0;
            scoreA = stats["2"] ?? 0;
            corners = (stats["7"] ?? 0) + (stats["8"] ?? 0);
            goals = (stats["1"] ?? 0) + (stats["2"] ?? 0);
            yellows = (stats["3"] ?? 0) + (stats["4"] ?? 0);

            minute = latest.Ts ? Math.floor((latest.Ts - f.kickoffMs) / 60_000) : null;
          }
        } catch {
          // tolerate fetch errors — retain stale cache
        }
      }

      const status = classifyStatus(f.kickoffMs, phaseCode, nowMs);
      // Only show a minute for a genuinely-live match, and clamp implausible values.
      if (status !== "live") minute = null;
      else if (minute != null && minute > 120) minute = 120;

      this.matchCache.set(f.fixtureId, {
        fixtureId: f.fixtureId,
        home: f.home,
        away: f.away,
        kickoffMs: f.kickoffMs,
        status,
        minute,
        phase: phaseLabel,
        scoreH,
        scoreA,
        corners,
        goals,
        yellows,
      });

      // Refresh on-chain markets for this fixture.
      await this._refreshMarkets(ctx, f.fixtureId);
    }
  }

  /** Read the 8 market PDAs for a fixture and update the market cache. */
  private async _refreshMarkets(ctx: SpikeContext, fixtureId: number): Promise<void> {
    // We need a read-only Anchor program to call fetchNullable.
    // Import lazily to avoid pulling anchor into tests that don't need it.
    const { readMarket } = await import("./chain.ts");

    const markets: LiveMarket[] = [];

    for (const def of MARKET_TEMPLATE) {
      const pda = deriveMarketPda(PROGRAM_ID, fixtureId, def.marketId);

      try {
        const view = await readMarket(pda.toBase58());
        const totals = view.bucketTotals.map((b) => BigInt(b));
        markets.push({
          marketId: def.marketId,
          label: def.label,
          group: def.group,
          line: def.line,
          settleAt: def.settleAt,
          numBuckets: view.numBuckets,
          status: view.status,
          bucketTotals: view.bucketTotals,
          totalPool: view.totalPool,
          odds: totals.map((_, i) => impliedOddsN(totals, i, view.feeBps)),
          winningBucket: view.winningBucket,
        });
      } catch {
        // Account doesn't exist yet (market not created) or RPC error.
        markets.push({
          marketId: def.marketId,
          label: def.label,
          group: def.group,
          line: def.line,
          settleAt: def.settleAt,
          numBuckets: def.numBuckets,
          status: "none",
          bucketTotals: Array(def.numBuckets).fill("0"),
          totalPool: "0",
          odds: Array(def.numBuckets).fill(0),
          winningBucket: null,
        });
      }
    }

    this.marketCache.set(fixtureId, markets);
  }
}
