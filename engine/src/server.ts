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
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.register(cors, { origin: [webOrigin] });
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
      const { fetchSlate } = await import("./catalog.ts");
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
    } catch (e) {
      console.warn("LiveStore poll loop could not start:", (e as Error).message);
    }
  });
}
