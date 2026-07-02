import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { Feed, type Replay } from "./feed.ts";
import {
  readMarket,
  readLiveContests,
  readJackpot,
  listEntriesForWallet,
  readLivePoolByFixture,
  readLivePoolViews,
  readOpenCall,
  readLastResolvedCall,
  readPoolStandings,
  readLiveEntry,
  readLineMarkets,
  readLinePosition,
  type ContestView,
  type LivePoolView,
} from "./chain.ts";
import { marketById } from "./markets.ts";
import { impliedOdds } from "./odds.ts";
import { M0, JOIN_AHEAD_MIN, TEST_FIXTURE_MIN } from "./config.ts";
import { testMatchState, testMatchDurationSecs } from "./testMatch.ts";
import { livePhase, type LiveStore } from "./live.ts";
import type { LinesStore } from "./lines.ts";

function loadReplay(): Replay {
  const url = new URL("../data/replay.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Replay;
}

/**
 * Pick "today's" single card from the set of live contests.
 *
 * "Streak" runs one daily card, but the chain may briefly hold more than one
 * Open contest (e.g. yesterday's card mid-settlement alongside today's). The
 * selection mirrors the task spec:
 *   1. Consider only Open contests (settled/voided/rolledOver are never "today").
 *   2. Prefer one whose in-play window [lockTs, settleAfterTs] covers `now`.
 *   3. Otherwise fall back to the most recent Open contest.
 *   4. Tie-break (in BOTH groups) by the latest lockTs, then highest contestId
 *      for full determinism.
 * Returns null when no Open contest exists (caller serves `{ card: null }`).
 *
 * `nowSec` is injected (defaults to wall-clock seconds) so it can be unit-tested.
 */
export function selectTodaysCard(
  contests: ContestView[],
  nowSec: number = Math.floor(Date.now() / 1000),
): ContestView | null {
  const open = contests.filter((c) => c.status === "open");
  if (open.length === 0) return null;
  // Latest first: by lockTs desc, then contestId desc (stable, deterministic).
  const byLatest = (a: ContestView, b: ContestView) =>
    (b.lockTs - a.lockTs) || (b.contestId - a.contestId);
  const covering = open
    .filter((c) => c.lockTs <= nowSec && nowSec <= c.settleAfterTs)
    .sort(byLatest);
  if (covering.length > 0) return covering[0];
  // No window covers now → most recent Open card.
  return [...open].sort(byLatest)[0];
}

/**
 * The full pool body served by /api/live/pool AND /api/live/next: the pool plus its
 * best-effort open call, just-resolved call, standings, and the single-fixture
 * name/live-drama join (live board row → fixture-meta → "#<fixtureId>"; `livePhase`
 * fold, `live` key omitted when the board doesn't track the fixture). A hiccup on
 * any enrichment degrades to null/[] rather than failing an otherwise-good pool.
 */
async function assemblePoolResponse(pool: LivePoolView, store?: LiveStore) {
  let openCall = null;
  try {
    openCall = await readOpenCall(pool.pubkey);
  } catch {
    openCall = null;
  }
  // The just-resolved call (if any) — the web flashes its verdict in the gap
  // between calls, since `openCall` only ever carries the OPEN one.
  let lastCall = null;
  try {
    lastCall = await readLastResolvedCall(pool.pubkey);
  } catch {
    lastCall = null;
  }
  let standings = [] as Awaited<ReturnType<typeof readPoolStandings>>;
  try {
    standings = await readPoolStandings(pool.poolId);
  } catch {
    standings = [];
  }

  // Test fixtures have no TxLINE presence — their match state is the scripted
  // feed the keeper resolves against, computed deterministically from the
  // pool's own on-chain timestamps (see testMatch.ts).
  if (pool.fixtureId >= TEST_FIXTURE_MIN) {
    const sim = testMatchState(
      pool.lockTs,
      testMatchDurationSecs(pool.lockTs, pool.settleAfterTs),
      Date.now(),
    );
    const match = { fixtureId: pool.fixtureId, kickoffMs: pool.lockTs * 1000, ...sim };
    return { pool, openCall, lastCall, standings, match };
  }

  const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
  const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();
  const live = byId.get(pool.fixtureId);
  const meta = names.get(pool.fixtureId);
  const match = {
    fixtureId: pool.fixtureId,
    home: live?.home ?? meta?.home ?? `#${pool.fixtureId}`,
    away: live?.away ?? meta?.away ?? "",
    kickoffMs: live?.kickoffMs ?? null,
    ...(live
      ? {
          live: {
            home: live.scoreH,
            away: live.scoreA,
            minute: live.minute,
            phase: livePhase(live.status, live.phase),
          },
        }
      : {}),
  };

  return { pool, openCall, lastCall, standings, match };
}

export function registerRoutes(app: FastifyInstance, store?: LiveStore, linesStore?: LinesStore): void {
  const feed = new Feed(loadReplay());
  feed.start(); // demo clock starts when the engine boots

  // ── M0 back-compat routes (single-fixture skeleton) ─────────────────────

  app.get("/api/match", async () => feed.current());

  app.get("/api/market", async (_req, reply) => {
    if (!M0.marketPubkey) {
      reply.code(503);
      return { error: "M0_MARKET_PUBKEY not set — run create-market first" };
    }
    const m = await readMarket(M0.marketPubkey);
    const totals: [bigint, bigint] = [BigInt(m.bucketTotals[0]), BigInt(m.bucketTotals[1])];
    return {
      ...m,
      meta: { home: M0.home, away: M0.away, line: M0.line, label: M0.label },
      impliedOdds: {
        over: impliedOdds(totals, 0, m.feeBps),
        under: impliedOdds(totals, 1, m.feeBps),
      },
    };
  });

  // ── List endpoints (Task 4) ───────────────────────────────────────────────

  /**
   * GET /api/matches
   * Returns all slate fixtures sorted live → upcoming → ft.
   */
  app.get("/api/matches", async (_req, reply) => {
    if (!store) {
      reply.code(503);
      return { error: "LiveStore not available" };
    }
    return store.getMatches();
  });

  /**
   * GET /api/markets?fixtureId=<number>
   * Returns the 8 markets for a fixture, with pool-implied odds.
   */
  app.get("/api/markets", async (req, reply) => {
    if (!store) {
      reply.code(503);
      return { error: "LiveStore not available" };
    }
    const { fixtureId } = (req.query as Record<string, string>);
    if (!fixtureId) {
      reply.code(400);
      return { error: "fixtureId query param required" };
    }
    const id = Number(fixtureId);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "fixtureId must be a number" };
    }
    return store.getMarkets(id);
  });

  /**
   * GET /api/history?wallet=<base58>
   * Returns the wallet's bet/win history, reconstructed from on-chain events.
   */
  app.get("/api/history", async (req, reply) => {
    const { wallet } = (req.query as Record<string, string>);
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    const { fetchHistory } = await import("./history.ts");
    const meta = store?.getFixtureMeta() ?? new Map();
    try {
      return await fetchHistory(wallet, meta);
    } catch (e) {
      reply.code(502);
      return { error: `history fetch failed: ${(e as Error).message}` };
    }
  });

  // ── Contest endpoints (daily sweepstake) ──────────────────────────────────

  /**
   * GET /api/contest/live
   * Every live single-match parlay contest, each joined with its fixture's
   * team names/kickoff (the `match`) and its per-leg catalog metadata (the
   * `legs`, with the O/U `line` joined from markets.ts). Returns a (possibly
   * empty) array — the jackpot is now its own `/api/jackpot` endpoint, so an
   * empty live set is just `[]`, not a "paused" object.
   */
  app.get("/api/contest/live", async (_req, reply) => {
    let contests;
    try {
      contests = await readLiveContests();
    } catch (e) {
      reply.code(502);
      return { error: `contest read failed: ${(e as Error).message}` };
    }

    const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
    const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();

    return contests.map((contest) => {
      // Each contest is a single-match parlay: join its one fixture (fixtures[0]).
      const fixtureId = contest.fixtures[0];
      const live = byId.get(fixtureId);
      const meta = names.get(fixtureId);
      const match = {
        fixtureId,
        home: live?.home ?? meta?.home ?? `#${fixtureId}`,
        away: live?.away ?? meta?.away ?? "",
        kickoffMs: live?.kickoffMs ?? null,
      };
      // The engine LegView already carries marketId/label/group/numBuckets/
      // fixtureId/winningBucket; add the catalog `line` for the web's O/U control.
      const legs = contest.legs.map((leg) => ({
        fixtureId: leg.fixtureId,
        marketId: leg.marketId,
        label: leg.label,
        group: leg.group,
        numBuckets: leg.numBuckets,
        line: marketById(leg.marketId)?.line,
        winningBucket: leg.winningBucket,
      }));
      return {
        contestId: contest.contestId,
        status: contest.status,
        pot: contest.pot,
        entryPrice: contest.entryPrice,
        lockTs: contest.lockTs,
        settleAfterTs: contest.settleAfterTs,
        entryCount: contest.entryCount,
        perfectCount: contest.perfectCount,
        distributable: contest.distributable,
        numLegs: contest.numLegs,
        match,
        legs,
      };
    });
  });

  /**
   * GET /api/card
   * TODAY's single 6-leg card — the focused view the new web reads. It reuses
   * `readLiveContests` (same per-leg catalog join as `/api/contest/live`) and
   * `selectTodaysCard` to pick the current day's Open contest, then folds in the
   * standalone jackpot pot.
   *
   * Shape: `{ contestId, status, lockTs, settleAfterTs, entryPrice, pot, jackpot,
   *           legs: [{ fixtureId, home, away, kickoffTs, marketId, label, group,
   *                    line, buckets }] }`.
   * Every leg is one match (single-match parlay), so home/away/kickoffTs are the
   * same fixture join on each leg — resolved like `/api/contest/live`: live row,
   * then fixture-meta names, then `#<fixtureId>`. `kickoffTs` is SECONDS (the
   * store carries kickoffMs), null when unknown. `buckets` is the catalog bucket
   * count; `line` is omitted (not null) for an out-of-catalog market.
   *
   * Empty case: when no Open contest exists, responds `{ card: null }` with 200
   * (NOT 404 / not a paused object) so the web can render an "open later" state.
   * A genuine RPC failure still 502s.
   */
  app.get("/api/card", async (_req, reply) => {
    let contests;
    try {
      contests = await readLiveContests();
    } catch (e) {
      reply.code(502);
      return { error: `card read failed: ${(e as Error).message}` };
    }

    const card = selectTodaysCard(contests);
    if (!card) return { card: null }; // 200 + null sentinel: no card for today (yet)

    // Jackpot is its own escrow; fold its pot in (best-effort — a jackpot RPC
    // hiccup shouldn't blank out an otherwise-good card, so degrade to "0").
    let jackpot = "0";
    try {
      jackpot = (await readJackpot()).pot;
    } catch {
      jackpot = "0";
    }

    // Single-match parlay: resolve the one fixture's names/kickoff once, exactly
    // like /api/contest/live (live row → fixture-meta → "#<fixtureId>"), then
    // stamp it onto every leg per the card shape.
    const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
    const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();

    const legs = card.legs.map((leg) => {
      const live = byId.get(leg.fixtureId);
      const meta = names.get(leg.fixtureId);
      // markets catalog supplies the O/U `line`; omit the key (not null) for an
      // unknown marketId, matching the /api/contest/live web contract.
      const line = marketById(leg.marketId)?.line;
      // When the live store tracks this fixture, fold in current score/minute/phase
      // so the web can render live drama. No live row → OMIT `live` entirely (per
      // contract) rather than emitting a zeroed placeholder.
      const liveField = live
        ? {
            live: {
              home: live.scoreH,
              away: live.scoreA,
              minute: live.minute,
              phase: livePhase(live.status, live.phase),
            },
          }
        : {};
      return {
        fixtureId: leg.fixtureId,
        home: live?.home ?? meta?.home ?? `#${leg.fixtureId}`,
        away: live?.away ?? meta?.away ?? "",
        // store carries kickoffMs; the card contract is seconds (null if unknown).
        kickoffTs: live?.kickoffMs != null ? Math.floor(live.kickoffMs / 1000) : null,
        marketId: leg.marketId,
        label: leg.label,
        group: leg.group,
        ...(line !== undefined ? { line } : {}),
        buckets: leg.numBuckets,
        ...liveField,
      };
    });

    return {
      contestId: card.contestId,
      status: card.status,
      lockTs: card.lockTs,
      settleAfterTs: card.settleAfterTs,
      entryPrice: card.entryPrice,
      pot: card.pot,
      jackpot,
      legs,
    };
  });

  /**
   * GET /api/jackpot
   * The standalone jackpot escrow view: `{ lamports, rentFloor, pot }`. The web
   * only reads `.pot`. Pre-launch chain.ts degrades the missing account to a
   * pot "0" sentinel, so this 502s only on a genuine RPC error.
   */
  app.get("/api/jackpot", async (_req, reply) => {
    try {
      return await readJackpot();
    } catch (e) {
      reply.code(502);
      return { error: `jackpot read failed: ${(e as Error).message}` };
    }
  });

  /**
   * GET /api/contest/entries?wallet=<base58>[&contestId=<number>]
   * The wallet's Entry tickets, enriched with won/claimable/payout. Without
   * `contestId` they're aggregated across all live contests; with a numeric
   * `contestId` the lookup is scoped to that single contest.
   */
  app.get("/api/contest/entries", async (req, reply) => {
    const { wallet, contestId } = req.query as Record<string, string>;
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    const id = contestId !== undefined ? Number(contestId) : undefined;
    try {
      return id !== undefined && Number.isFinite(id)
        ? await listEntriesForWallet(wallet, id)
        : await listEntriesForWallet(wallet);
    } catch (e) {
      reply.code(502);
      return { error: `entries fetch failed: ${(e as Error).message}` };
    }
  });

  // ── Live-match endpoints (Slice 4) ────────────────────────────────────────

  /**
   * GET /api/live/pool?fixtureId=<number>
   * The live-match pool for a fixture, enriched with its currently-open Call and
   * the standings leaderboard, plus the single-fixture name/live-drama join that
   * `/api/card` uses (live row → fixture-meta → `#<fixtureId>`; `livePhase` fold).
   *
   * Empty case: no pool for this fixture → 200 `{ pool: null }` (NOT 404), so the
   * web can render a "no live game yet" state. A genuine RPC failure 502s.
   */
  app.get("/api/live/pool", async (req, reply) => {
    const { fixtureId } = req.query as Record<string, string>;
    if (!fixtureId) {
      reply.code(400);
      return { error: "fixtureId query param required" };
    }
    const id = Number(fixtureId);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "fixtureId must be a number" };
    }

    let pool;
    try {
      pool = await readLivePoolByFixture(id);
    } catch (e) {
      reply.code(502);
      return { error: `live pool read failed: ${(e as Error).message}` };
    }
    if (!pool) return { pool: null }; // 200 + null sentinel: no live pool (yet)

    return assemblePoolResponse(pool, store);
  });

  /**
   * GET /api/live/next
   * The ONE game the home tab should feature, picked in priority order:
   *   1. an IN-PLAY pool  — status open, lockTs ≤ now < settleAfterTs (a playing
   *      pool's on-chain status stays "open"; in-play is a time fact) — earliest
   *      lockTs wins;
   *   2. a JOINABLE pool  — status open, now < lockTs (the 45-min join window);
   *   3. the soonest UPCOMING fixture with no pool yet — countdown only, pool null;
   *   4. nothing scheduled → all-null body.
   * The body is a superset of /api/live/pool (same assembly) plus `kickoffMs` and
   * `joinOpensTs` (kickoff − JOIN_AHEAD_MIN). Terminal/ended pools are never
   * featured — the next game takes over. Replaces web-side discovery (finding #5).
   *
   * `?test=1` flips the audience: ONLY test pools (fixtureId ≥ TEST_FIXTURE_MIN —
   * the /test page); without it, test pools are EXCLUDED so the main Live tab
   * carries exclusively real fixtures.
   */
  app.get("/api/live/next", async (req, reply) => {
    const wantTest = (req.query as Record<string, string>).test === "1";
    let pools;
    try {
      pools = await readLivePoolViews();
    } catch (e) {
      reply.code(502);
      return { error: `live pool scan failed: ${(e as Error).message}` };
    }
    const nowMs = Date.now();
    const open = pools.filter(
      (p) => p.status === "open" && (p.fixtureId >= TEST_FIXTURE_MIN) === wantTest,
    );
    const byLock = (a: { lockTs: number }, b: { lockTs: number }) => a.lockTs - b.lockTs;
    const inPlay = open
      .filter((p) => p.lockTs * 1000 <= nowMs && nowMs < p.settleAfterTs * 1000)
      .sort(byLock)[0];
    const joinable = open.filter((p) => nowMs < p.lockTs * 1000).sort(byLock)[0];
    const featured = inPlay ?? joinable ?? null;

    if (featured) {
      const body = await assemblePoolResponse(featured, store);
      // lock_ts == kickoff by construction; prefer the board's kickoff when known.
      const kickoffMs = body.match.kickoffMs ?? featured.lockTs * 1000;
      return { ...body, kickoffMs, joinOpensTs: featured.lockTs - JOIN_AHEAD_MIN * 60 };
    }

    // No pool anywhere → the soonest upcoming fixture (pure countdown state).
    // Real tab only: TxLINE has no test fixtures, so /test skips straight to nulls.
    const up = wantTest
      ? undefined
      : (store?.getMatches() ?? [])
          .filter((m) => m.status === "upcoming")
          .sort((a, b) => a.kickoffMs - b.kickoffMs)[0];
    if (up) {
      return {
        pool: null, openCall: null, lastCall: null, standings: [],
        match: { fixtureId: up.fixtureId, home: up.home, away: up.away, kickoffMs: up.kickoffMs },
        kickoffMs: up.kickoffMs,
        joinOpensTs: Math.floor(up.kickoffMs / 1000) - JOIN_AHEAD_MIN * 60,
      };
    }
    return {
      pool: null, openCall: null, lastCall: null, standings: [],
      match: null, kickoffMs: null, joinOpensTs: null,
    };
  });

  /**
   * GET /api/live/pool/:id/standings
   * The pool's standings leaderboard — every LiveEntry sorted by `total`
   * (base_pts + bonus_pts) descending. Empty pool → 200 `[]` (never 404); a
   * genuine RPC failure 502s. `:id` is the poolId (== fixtureId in practice).
   */
  app.get("/api/live/pool/:id/standings", async (req, reply) => {
    const { id } = req.params as Record<string, string>;
    const poolId = Number(id);
    if (!Number.isFinite(poolId)) {
      reply.code(400);
      return { error: "pool id must be a number" };
    }
    try {
      return await readPoolStandings(poolId);
    } catch (e) {
      reply.code(502);
      return { error: `standings read failed: ${(e as Error).message}` };
    }
  });

  /**
   * GET /api/live/entry?wallet=<base58>&poolId=<number>
   * One wallet's LiveEntry ticket for a pool (there is at most one per player per
   * pool). BOTH params are required → 400 otherwise. No matching entry → 200
   * `{ entry: null }` (never 404); a genuine RPC failure 502s.
   */
  app.get("/api/live/entry", async (req, reply) => {
    const { wallet, poolId } = req.query as Record<string, string>;
    if (!wallet || !poolId) {
      reply.code(400);
      return { error: "wallet and poolId query params required" };
    }
    const id = Number(poolId);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "poolId must be a number" };
    }
    try {
      const entry = await readLiveEntry(wallet, id);
      return { entry }; // entry is null when no ticket exists
    } catch (e) {
      reply.code(502);
      return { error: `live entry read failed: ${(e as Error).message}` };
    }
  });

  /**
   * GET /api/live/unclaimed?wallet=<base58>[&test=1]
   * The wallet's most recent UNFINISHED terminal pool: settled/voided/rolledOver
   * with the wallet's LiveEntry account still open — claiming (winner share /
   * refund / seat close) is what closes the entry, so an open entry on a
   * terminal pool == money or a close still owed to this wallet. The web PINS
   * this pool over the featured rotation: /api/live/next only ever serves open
   * pools, so without the pin a winner's claim button rotates away the moment
   * the next pool spawns. Same audience split as /next (`test=1`). Scans the
   * newest 12 terminal pools; `{pool:null, entry:null}` when nothing is owed.
   */
  app.get("/api/live/unclaimed", async (req, reply) => {
    const { wallet } = req.query as Record<string, string>;
    const wantTest = (req.query as Record<string, string>).test === "1";
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    let pools;
    try {
      pools = await readLivePoolViews();
    } catch (e) {
      reply.code(502);
      return { error: `live pool scan failed: ${(e as Error).message}` };
    }
    const terminal = pools
      .filter(
        (p) =>
          (p.status === "settled" || p.status === "voided" || p.status === "rolledOver") &&
          (p.fixtureId >= TEST_FIXTURE_MIN) === wantTest,
      )
      .sort((a, b) => b.settleAfterTs - a.settleAfterTs)
      .slice(0, 12);
    for (const p of terminal) {
      try {
        const entry = await readLiveEntry(wallet, p.poolId);
        if (entry) {
          const body = await assemblePoolResponse(p, store);
          return { ...body, entry };
        }
      } catch {
        // Unreadable entry (RPC blip) → skip; the web re-polls within seconds.
      }
    }
    return { pool: null, entry: null };
  });

  // ── Beat the Market ────────────────────────────────────────────────────────
  const HOUSE_BOOST_LAMPORTS = Math.round(Number(process.env.LINES_SEED_SOL ?? "0.05") * 2 * 1e9);
  // Money-read micro-cache: /api/lines fans out from every client poll; a 5s
  // TTL keeps getProgramAccounts off the hot path (same idea as the ER cache).
  let linesCache: { at: number; data: Awaited<ReturnType<typeof readLineMarkets>> } | null = null;
  async function cachedLineMarkets() {
    if (linesCache && Date.now() - linesCache.at < 5_000) return linesCache.data;
    const data = await readLineMarkets();
    linesCache = { at: Date.now(), data };
    return data;
  }

  function lineDto(m: Awaited<ReturnType<typeof readLineMarkets>>[number]) {
    const names = linesStore?.name(m.fixtureId);
    const home = names?.home ?? `Fixture #${m.fixtureId}`;
    const away = names?.away ?? "";
    return {
      fixtureId: m.fixtureId,
      home, away,
      favName: m.favSide === 1 ? home : (away || home),
      favSide: m.favSide,
      kickoffMs: m.entryCloseTs * 1000,
      marketPk: m.pubkey,
      status: m.status,
      openMilli: m.openMilli,
      current: linesStore?.current(m.fixtureId) ?? null, // {pctMilli, ts} | null — never invented
      potLamports: m.totalPool,
      bucketTotals: m.bucketTotals,
      houseBoostLamports: HOUSE_BOOST_LAMPORTS,
      winningBucket: m.winningBucket,
      settledValueMilli: m.status === "settled" ? m.settledValueMilli : null,
      settledTs: m.settledTs || null,
    };
  }

  app.get("/api/lines", async () => {
    const markets = await cachedLineMarkets();
    const lines = markets
      .map(lineDto)
      .sort((a, b) => a.kickoffMs - b.kickoffMs);
    return { lines };
  });

  app.get("/api/lines/:fixtureId", async (req, reply) => {
    const fixtureId = Number((req.params as { fixtureId: string }).fixtureId);
    const wallet = (req.query as { wallet?: string }).wallet;
    const m = (await cachedLineMarkets()).find((x) => x.fixtureId === fixtureId);
    if (!m) { reply.code(404); return { error: "no line for fixture" }; }
    return {
      line: lineDto(m),
      series: linesStore?.series(fixtureId) ?? [],
      myStakes: wallet ? await readLinePosition(fixtureId, wallet) : null,
    };
  });
}
