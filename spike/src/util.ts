/**
 * Shared utilities: env, wallet loading, the dual-header TxLINE HTTP client,
 * and gate / section logging used by the spike runner.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";

// ── env ───────────────────────────────────────────────────────────────────────

export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export function envOpt(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

// ── wallet ──────────────────────────────────────────────────────────────────

/**
 * Load a Keypair from WALLET_SECRET_KEY, which may be either a base58 secret
 * key string or a path to a Solana CLI keypair json file (array of bytes).
 */
export function loadWallet(secret: string): Keypair {
  const trimmed = secret.trim();
  const looksLikePath =
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".") ||
    trimmed.endsWith(".json");

  if (looksLikePath) {
    const path = trimmed.startsWith("~")
      ? resolve(homedir(), trimmed.slice(1).replace(/^[/\\]/, ""))
      : resolve(trimmed);
    const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

export interface TxlineAuth {
  /** Bearer session JWT (guest or activated). */
  jwt?: string;
  /** Long-lived API token. */
  apiToken?: string;
}

export interface TxlineRequest extends TxlineAuth {
  method?: "GET" | "POST";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Override base url (defaults to TXLINE_BASE_URL). */
  baseUrl?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
    public bodyText: string,
  ) {
    super(`HTTP ${status} for ${url}\n${bodyText.slice(0, 800)}`);
    this.name = "HttpError";
  }
}

/**
 * Call a TxLINE endpoint with the standard dual auth headers:
 *   Authorization: Bearer <jwt>   and   X-Api-Token: <apiToken>
 * Returns parsed JSON (or raw text if the response is not JSON).
 */
export async function txline<T = unknown>(
  path: string,
  opts: TxlineRequest = {},
): Promise<T> {
  const base = (opts.baseUrl ?? env("TXLINE_BASE_URL")).replace(/\/$/, "");
  const url = new URL(path.startsWith("http") ? path : base + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.jwt) headers["Authorization"] = `Bearer ${opts.jwt}`;
  if (opts.apiToken) headers["X-Api-Token"] = opts.apiToken;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url.toString(), text);

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ── logging ─────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export function section(title: string): void {
  console.log(`\n${c.bold}${c.cyan}── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}${c.reset}`);
}

export function info(msg: string): void {
  console.log(`  ${msg}`);
}

export function detail(msg: string): void {
  console.log(`  ${c.dim}${msg}${c.reset}`);
}

export function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${c.yellow}⚠${c.reset} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

/** Print a gate result line (used for Gates A-D). */
export function gate(name: string, pass: boolean, note: string): void {
  const tag = pass ? `${c.green}PASS${c.reset}` : `${c.red}FAIL${c.reset}`;
  console.log(`\n${c.bold}[${name}] ${tag}${c.reset} — ${note}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
