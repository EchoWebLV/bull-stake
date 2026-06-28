import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { Feed, type Replay } from "./feed.ts";
import { readMarket } from "./chain.ts";
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
}
