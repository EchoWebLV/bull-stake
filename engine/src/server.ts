import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./routes.ts";
import { LiveStore } from "./live.ts";

/**
 * Build and return a Fastify server.
 *
 * @param store - optional LiveStore to inject (useful in tests for mocking).
 *   When omitted and running as main (not under vitest), a real LiveStore is
 *   constructed and its poll loop is started after the server is listening.
 */
export function buildServer(store?: LiveStore): FastifyInstance {
  const app = Fastify({ logger: false });
  // Comma-separated allow-list so the prod web origin and local dev ports
  // (Vite's default 5173 + the preview harness's 5180) all work without churn.
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173,http://localhost:5180";
  const origins = webOrigin.split(",").map((o) => o.trim()).filter(Boolean);
  app.register(cors, { origin: origins });
  app.get("/health", async () => ({ status: "ok" }));

  // Use the injected store (tests) or create a bare store (server start wires it).
  const liveStore = store ?? new LiveStore();
  registerRoutes(app, liveStore);
  return app;
}

// Start only when run directly (not under vitest import).
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const liveStore = new LiveStore();
  const app = buildServer(liveStore);
  const port = Number(process.env.PORT ?? 8787);

  app.listen({ port, host: "0.0.0.0" }).then(async (addr) => {
    // eslint-disable-next-line no-console
    console.log(`engine listening at ${addr}`);

    // Start the live poll loop only after the server is up.
    // Auth + slate are loaded here; catalog sets the slate before this in prod.
    try {
      const { createContext } = await import("../../spike/src/auth.js");
      const { authenticateCached } = await import("../../spike/src/auth-cache.js");
      const ctx = createContext();
      const auth = await authenticateCached(ctx);

      // Load the live tournament slate. hoursBehind keeps in-play and
      // recently-finished matches on the board (so a match you bet on stays
      // visible after kickoff, and a fresh boot re-loads matches under way).
      const BOARD_HOURS_BEHIND = 5;
      const { fetchSlate, fetchFixturesAcross } = await import("./catalog.ts");
      let slate: { fixtureId: number; home: string; away: string; kickoffMs: number }[] = [];
      try {
        slate = await fetchSlate(ctx, auth, { hoursBehind: BOARD_HOURS_BEHIND });
      } catch (e) {
        console.warn("fetchSlate failed:", (e as Error).message);
      }
      // Fallback to the M0 single fixture if the slate is empty (between match days).
      if (slate.length === 0 && process.env.M0_FIXTURE_ID) {
        slate = [{
          fixtureId: Number(process.env.M0_FIXTURE_ID),
          home: process.env.M0_HOME ?? "Home",
          away: process.env.M0_AWAY ?? "Away",
          kickoffMs: Date.now(),
        }];
      }
      liveStore.setSlate(slate);
      console.log(`live slate: ${slate.length} fixture(s)`);
      liveStore.start(ctx, auth);

      // Refresh the slate periodically (fixtures roll over across days).
      setInterval(() => {
        fetchSlate(ctx, auth, { hoursBehind: BOARD_HOURS_BEHIND })
          .then((s) => { if (s.length) liveStore.setSlate(s); })
          .catch(() => {});
      }, 30 * 60_000);

      // Resolve every live contest's MATCH names independently of the 36h board
      // window — a single-match parlay's fixture can be days out, so fetch the
      // span of days covering ALL live contests' lockTs and merge ONLY the
      // matched names into the store (no extra board rows). Without this the
      // card shows "#<fixtureId>" for matches beyond the board window.
      //
      // Each live contest carries its own lockTs/fixture; rather than one fetch
      // per contest we compute the [min..max] epoch-day span across all of them
      // and do a single fetchFixturesAcross over that window (padded ±1 day),
      // then union the wanted fixture ids. Simpler + fewer RPC calls than a
      // per-contest fetch, and correct because fetchFixturesAcross already takes
      // a (startDay, dayCount) window.
      const DAY_SEC = 86_400;
      const refreshContestNames = async () => {
        try {
          const { readLiveContests } = await import("./chain.ts");
          const cs = await readLiveContests();
          if (cs.length === 0) return;
          const wanted = new Set<number>();
          let minDay = Infinity;
          let maxDay = -Infinity;
          for (const c of cs) {
            for (const f of c.fixtures) wanted.add(f);
            const day = Math.floor(c.lockTs / DAY_SEC);
            if (day < minDay) minDay = day;
            if (day > maxDay) maxDay = day;
          }
          // Pad ±1 day so a contest locking near a day boundary still resolves.
          // Cap the span so two contests locking weeks apart (e.g. a stuck
          // never-settled zombie alongside a fresh one) don't fan out dozens of
          // upstream getFixtures page requests every 30 min. A zombie weeks-old
          // contest losing its card name is acceptable — it'll be voided anyway.
          // (We cap the span rather than filter to status==='open' contests:
          // /api/contest/live serves settled/voided contests too, and the web
          // still needs their fixture names for the results card.)
          const startDay = minDay - 1;
          const dayCount = Math.min(maxDay - minDay + 3, 10);
          const fixtures = await fetchFixturesAcross(ctx, auth, startDay, dayCount);
          const matched = fixtures.filter((f) => wanted.has(f.fixtureId));
          liveStore.addFixtureNames(matched);
          console.log(`contest cards: resolved ${matched.length}/${wanted.size} fixture name(s) across ${cs.length} contest(s)`);
        } catch (e) {
          console.warn("contest-card name resolve failed:", (e as Error).message);
        }
      };
      await refreshContestNames();
      setInterval(refreshContestNames, 30 * 60_000);
    } catch (e) {
      console.warn("LiveStore poll loop could not start:", (e as Error).message);
    }
  });
}
