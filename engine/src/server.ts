import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./routes.ts";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.register(cors, { origin: [webOrigin] });
  app.get("/health", async () => ({ status: "ok" }));
  registerRoutes(app);
  return app;
}

// Start only when run directly (not under test import).
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8787);
  app.listen({ port, host: "0.0.0.0" }).then((addr) => {
    // eslint-disable-next-line no-console
    console.log(`engine listening at ${addr}`);
  });
}
