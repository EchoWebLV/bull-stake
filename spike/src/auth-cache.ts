/**
 * Auth-token caching — stop the per-run re-subscribe (~0.2 SOL each time).
 *
 * Cache file (default: .txline-auth.json at repo root, gitignored):
 *   { wallet: string, jwt: string, apiToken: string, createdAt: number }
 *
 * Logic:
 *   1. If the cache exists, wallet matches and is < 21 days old, validate it
 *      with one cheap authed call (getFixtures). On success → reuse.
 *   2. Otherwise authenticate() fresh, write the cache file, return.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { authenticate, type Auth, type SpikeContext } from "./auth.js";
import { getFixtures } from "./discover.js";

/** Shape stored on disk. */
interface CacheFile {
  wallet: string;
  jwt: string;
  apiToken: string;
  createdAt: number;
}

const TWENTY_ONE_DAYS_MS = 21 * 86_400_000;

/**
 * Pure predicate: should we reuse this cache entry?
 * Exported so it can be unit-tested without any I/O.
 */
export function shouldReuse(
  cache: CacheFile | null,
  walletB58: string,
  nowMs: number,
): boolean {
  if (!cache) return false;
  if (cache.wallet !== walletB58) return false;
  if (nowMs - cache.createdAt >= TWENTY_ONE_DAYS_MS) return false;
  return true;
}

/** Resolve the absolute path to the cache file. */
function resolveCachePath(cachePath: string): string {
  // If the caller passed an absolute path, use it as-is.
  if (cachePath.startsWith("/")) return cachePath;
  // Otherwise resolve relative to the repo root (two levels up from spike/src/).
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const repoRoot = resolve(thisDir, "..", "..");
  return resolve(repoRoot, cachePath);
}

/** Read the cache file; return null on any parse/read error. */
function readCache(absPath: string): CacheFile | null {
  try {
    const raw = readFileSync(absPath, "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

/** Write the cache file. */
function writeCache(absPath: string, entry: CacheFile): void {
  writeFileSync(absPath, JSON.stringify(entry, null, 2), "utf8");
}

/**
 * Return a valid {jwt, apiToken} pair, reusing the disk cache when possible.
 *
 * @param ctx       - SpikeContext (wallet, connection, etc.)
 * @param cachePath - path to the cache file (default: ".txline-auth.json" at repo root)
 */
export async function authenticateCached(
  ctx: SpikeContext,
  cachePath = ".txline-auth.json",
): Promise<Auth> {
  const absPath = resolveCachePath(cachePath);
  const walletB58 = ctx.wallet.publicKey.toBase58();
  const nowMs = Date.now();

  const cache = readCache(absPath);

  if (shouldReuse(cache, walletB58, nowMs)) {
    // cache is non-null here (shouldReuse returned true)
    const { jwt, apiToken } = cache!;
    // Validate with one cheap authed call.
    try {
      await getFixtures(ctx, { jwt, apiToken }, { startEpochDay: Math.floor(nowMs / 86_400_000) });
      return { jwt, apiToken };
    } catch {
      // Cache is stale or token revoked — fall through to fresh auth.
    }
  }

  // Fresh auth: subscribe + activate.
  const fresh = await authenticate(ctx);
  const entry: CacheFile = {
    wallet: walletB58,
    jwt: fresh.jwt,
    apiToken: fresh.apiToken,
    createdAt: nowMs,
  };
  writeCache(absPath, entry);
  return fresh;
}
