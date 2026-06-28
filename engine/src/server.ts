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

      // Seed from env-set fixture if provided (M0 compat), else an empty slate.
      if (process.env.M0_FIXTURE_ID) {
        liveStore.setSlate([{
          fixtureId: Number(process.env.M0_FIXTURE_ID),
          home: process.env.M0_HOME ?? "Home",
          away: process.env.M0_AWAY ?? "Away",
          kickoffMs: Date.now(), // approximate — will be refreshed
        }]);
      }

      liveStore.start(ctx, auth);
    } catch (e) {
      console.warn("LiveStore poll loop could not start:", (e as Error).message);
    }
  });
}
