import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { Feed, type Replay } from "./feed.ts";
import { readMarket, readLiveContests, readJackpot, listEntriesForWallet } from "./chain.ts";
import { marketById } from "./markets.ts";
import { impliedOdds } from "./odds.ts";
import { M0 } from "./config.ts";
import type { LiveStore } from "./live.ts";

function loadReplay(): Replay {
  const url = new URL("../data/replay.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Replay;
}

export function registerRoutes(app: FastifyInstance, store?: LiveStore): void {
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
}
