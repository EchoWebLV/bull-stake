import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.ts";

/**
 * Same-origin deploy mode: when WEB_DIST points at a built web bundle the
 * engine serves it (SPA fallback to index.html), so one Railway service is
 * both the API and the app. Without WEB_DIST the engine stays API-only.
 */
describe("static web serving (WEB_DIST)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "webdist-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Bull Stake</title>");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.WEB_DIST;
  });

  it("serves index.html at / when WEB_DIST is set", async () => {
    process.env.WEB_DIST = dir;
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Bull Stake");
  });

  it("serves asset files as themselves", async () => {
    process.env.WEB_DIST = dir;
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("console.log(1)");
  });

  it("falls back to index.html for client-side routes, but never for /api paths", async () => {
    process.env.WEB_DIST = dir;
    const app = buildServer();
    const spa = await app.inject({ method: "GET", url: "/some/client/route" });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain("Bull Stake");
    const api = await app.inject({ method: "GET", url: "/api/definitely-missing" });
    expect(api.statusCode).toBe(404);
  });

  it("without WEB_DIST the engine stays API-only: / is 404, /health still ok", async () => {
    const app = buildServer();
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
