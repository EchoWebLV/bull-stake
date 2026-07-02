# Beat the Market (Day Game) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One 2-bucket parimutuel line market per eligible fixture — does the favourite's StablePrice consensus win probability close **Above** or **Below** the opening line at kick-off — on the existing `Market` program with zero on-chain changes, surfaced in a new **Market** tab (Parlay tab hidden, daily-card create cron paused).

**Architecture:** spike gains a typed StablePrice odds client (`spike/src/odds.ts`, shared by keeper + engine). Keeper gains `lines.ts` (idempotent ensure → seed → settle passes) wired into `cron.ts`. Engine gains `LinesStore` (odds series poller) + `readLineMarkets()` + `/api/lines` endpoints. Web gains `lib/lines.ts` (pure mapper), `useLines` hook, `MarketLinesView`, and the nav swap. Spec: `docs/superpowers/specs/2026-07-02-beat-the-market-design.md`.

**Tech Stack:** TypeScript ESM (`.js`-suffixed relative imports), vitest per package (`cd <pkg> && npx vitest run`), Anchor 0.31 via `@coral-xyz/anchor`, Fastify inject tests, React 18 + Vite.

**Conventions used throughout:**
- Milli-percent: `54.407%` → `54407` (i32-safe integer).
- Bucket **0 = Above**, **1 = Below**. `stat_key` stores the favourite side (**1 = Participant1/home, 2 = Participant2/away**). `threshold` stores the opening line (milli-pct). `settled_value` stores the closing line.
- `LINE_CLOSE_MARKET_ID = 90`.
- All new env keys and defaults are in spec §9.

---

### Task 1: StablePrice odds client (spike)

**Files:**
- Create: `spike/src/odds.ts`
- Test: `spike/test/odds.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// spike/test/odds.test.ts
import { describe, it, expect } from "vitest";
import {
  isLineRow, favouriteSide, pctMilliFor, latestLineRowAtOrBefore,
  type OddsRow,
} from "../src/odds.js";

/** A verified-shape StablePrice full-game 1X2 row (probe 2026-07-02). */
function row(over: Partial<OddsRow> = {}): OddsRow {
  return {
    FixtureId: 18179551,
    MessageId: "m1",
    Ts: 1_782_983_557_629,
    Bookmaker: "TXLineStablePriceDemargined",
    BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT",
    GameState: null,
    InRunning: false,
    MarketParameters: null,
    MarketPeriod: null,
    PriceNames: ["part1", "draw", "part2"],
    Prices: [1838, 2832, 9740],
    Pct: ["54.407", "35.311", "10.267"],
    ...over,
  };
}

describe("isLineRow", () => {
  it("accepts a full-game pre-match StablePrice 1X2 row", () => {
    expect(isLineRow(row())).toBe(true);
  });
  it("rejects half-period rows", () => {
    expect(isLineRow(row({ MarketPeriod: "half=1" }))).toBe(false);
  });
  it("rejects in-running rows", () => {
    expect(isLineRow(row({ InRunning: true }))).toBe(false);
  });
  it("rejects other odds types and other bookmakers", () => {
    expect(isLineRow(row({ SuperOddsType: "OVERUNDER_PARTICIPANT_GOALS" }))).toBe(false);
    expect(isLineRow(row({ BookmakerId: 999 }))).toBe(false);
  });
  it("rejects rows without a 3-part Pct", () => {
    expect(isLineRow(row({ Pct: undefined }))).toBe(false);
    expect(isLineRow(row({ Pct: ["50.0", "50.0"] }))).toBe(false);
  });
});

describe("favouriteSide / pctMilliFor", () => {
  it("part1 favourite → side 1; part2 favourite → side 2", () => {
    expect(favouriteSide(row())).toBe(1);
    expect(favouriteSide(row({ Pct: ["10.0", "30.0", "60.0"] }))).toBe(2);
  });
  it("exact tie → side 1 (deterministic)", () => {
    expect(favouriteSide(row({ Pct: ["45.0", "10.0", "45.0"] }))).toBe(1);
  });
  it("pctMilliFor reads the right slot and rounds to milli-pct", () => {
    expect(pctMilliFor(row(), 1)).toBe(54407);
    expect(pctMilliFor(row(), 2)).toBe(10267);
  });
});

describe("latestLineRowAtOrBefore", () => {
  it("returns the latest eligible row at or before the cutoff, ignoring non-line rows", () => {
    const rows = [
      row({ Ts: 1000, MessageId: "a" }),
      row({ Ts: 3000, MessageId: "half", MarketPeriod: "half=1" }), // ignored
      row({ Ts: 2000, MessageId: "b" }),
      row({ Ts: 5000, MessageId: "late" }), // past cutoff
    ];
    expect(latestLineRowAtOrBefore(rows, 4000)?.MessageId).toBe("b");
  });
  it("returns null when nothing qualifies", () => {
    expect(latestLineRowAtOrBefore([row({ Ts: 9000 })], 4000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/spike && npx vitest run test/odds.test.ts`
Expected: FAIL — `Cannot find module '../src/odds.js'`

- [ ] **Step 3: Write the implementation**

```ts
// spike/src/odds.ts
/**
 * TxLINE StablePrice odds client + pure line helpers (Beat the Market).
 *
 * Endpoints (probe-verified on devnet 2026-07-02):
 *   GET /api/odds/snapshot/{fixtureId} — latest row per (SuperOddsType, MarketPeriod, MarketParameters)
 *   GET /api/odds/updates/{fixtureId}  — full history (thousands of rows)
 *
 * THE line = the favourite's implied win probability from the full-game 1X2
 * consensus row: SuperOddsType 1X2_PARTICIPANT_RESULT, MarketPeriod null,
 * InRunning false, BookmakerId 10021 (TXLineStablePriceDemargined).
 * `Pct` is de-margined (["part1","draw","part2"], sums to ~100).
 */
import { txline } from "./util.js";
import type { Auth, SpikeContext } from "./auth.js";

export interface OddsRow {
  FixtureId: number;
  MessageId: string;
  Ts: number; // ms epoch
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState: string | null;
  InRunning: boolean;
  MarketParameters: string | null;
  MarketPeriod: string | null;
  PriceNames: string[];
  Prices: number[]; // milli-odds (1838 = 1.838)
  Pct?: string[];   // implied probabilities as strings
}

export const STABLEPRICE_BOOKMAKER_ID = 10021;

const auth = (a: Auth) => ({ jwt: a.jwt, apiToken: a.apiToken });

export async function fetchOddsSnapshot(
  ctx: SpikeContext, a: Auth, fixtureId: number,
): Promise<OddsRow[]> {
  const res = await txline<OddsRow[]>(`/api/odds/snapshot/${fixtureId}`, {
    baseUrl: ctx.baseUrl, ...auth(a),
  });
  return Array.isArray(res) ? res : [];
}

export async function fetchOddsUpdates(
  ctx: SpikeContext, a: Auth, fixtureId: number,
): Promise<OddsRow[]> {
  const res = await txline<OddsRow[]>(`/api/odds/updates/${fixtureId}`, {
    baseUrl: ctx.baseUrl, ...auth(a),
  });
  return Array.isArray(res) ? res : [];
}

/** Full-game, pre-match, StablePrice 1X2 with a 3-slot Pct — the ONLY row kind
 *  the line game reads. Everything else (halves, in-running, O/U) is ignored. */
export function isLineRow(r: OddsRow): boolean {
  return (
    r.SuperOddsType === "1X2_PARTICIPANT_RESULT" &&
    r.MarketPeriod == null &&
    r.InRunning === false &&
    r.BookmakerId === STABLEPRICE_BOOKMAKER_ID &&
    Array.isArray(r.Pct) && r.Pct.length === 3
  );
}

/** Favourite side from a line row: 1 = part1 (home), 2 = part2 (away). Tie → 1. */
export function favouriteSide(r: OddsRow): 1 | 2 {
  const p1 = parseFloat(r.Pct![0]);
  const p2 = parseFloat(r.Pct![2]);
  return p2 > p1 ? 2 : 1;
}

/** The given side's implied probability in milli-percent (54.407% → 54407). */
export function pctMilliFor(r: OddsRow, side: 1 | 2): number {
  return Math.round(parseFloat(r.Pct![side === 1 ? 0 : 2]) * 1000);
}

/** Latest line row with Ts <= cutoffMs, or null. */
export function latestLineRowAtOrBefore(rows: OddsRow[], cutoffMs: number): OddsRow | null {
  let best: OddsRow | null = null;
  for (const r of rows) {
    if (!isLineRow(r) || r.Ts > cutoffMs) continue;
    if (!best || r.Ts > best.Ts) best = r;
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/spike && npx vitest run test/odds.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add spike/src/odds.ts spike/test/odds.test.ts
git commit -m "feat(spike): StablePrice odds client + pure line-row helpers"
```

---

### Task 2: LINE_CLOSE market catalog entry (engine)

**Files:**
- Modify: `engine/src/markets.ts`
- Modify: `docs/superpowers/specs/2026-07-02-beat-the-market-design.md` (§3: `stat_key` = favourite side, not 0)
- Test: `engine/test/markets.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test** — append to `engine/test/markets.test.ts`:

```ts
import {
  LINE_CLOSE_MARKET_ID, LINE_CLOSE_DEF, lineInitArgs, MARKET_TEMPLATE as TPL,
} from "../src/markets.ts";

describe("LINE_CLOSE (market 90)", () => {
  it("is registered for lookups but NOT in the per-fixture template", () => {
    expect(LINE_CLOSE_MARKET_ID).toBe(90);
    expect(marketById(90)).toBe(LINE_CLOSE_DEF);
    expect(marketById(90)?.group).toBe("line");
    expect(marketById(90)?.numBuckets).toBe(2);
    expect(TPL.some((d) => d.marketId === 90)).toBe(false);
  });

  it("lineInitArgs encodes open line + favourite side into the existing init args", () => {
    const args = lineInitArgs(54407, 1, DUMMY_AUTH, 1_752_000_000);
    expect(args.statKey).toBe(1);          // favourite side (1 = home)
    expect(args.statKey2).toBeNull();
    expect(args.op).toBeNull();
    expect(args.comparison).toEqual({ greaterThan: {} }); // sentinel, unused
    expect(args.threshold).toBe(54407);    // opening line, milli-pct
    expect(args.entryCloseTs.toNumber()).toBe(1_752_000_000);
    expect(args.feeBps).toBe(0);
    expect(args.numBuckets).toBe(2);
    expect(args.settleAuthority).toBe(DUMMY_AUTH);
    expect(args.feeRecipient).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run test/markets.test.ts`
Expected: FAIL — `LINE_CLOSE_MARKET_ID` not exported

- [ ] **Step 3: Implement** — in `engine/src/markets.ts`:

Widen the group union (line 25):

```ts
  group: "corners" | "goals" | "result" | "cards" | "line";
```

Append after the `MARKET_TEMPLATE` block (keep the template untouched — the parlay/card flows iterate it and must never create line markets):

```ts
// ── Beat the Market: the odds-line market (id 90) ───────────────────────────
// One per fixture, OUTSIDE the per-fixture template. Bucket 0 = Above,
// 1 = Below the opening line. Field reuse (documented in spec §3):
//   stat_key   = favourite side (1 = Participant1/home, 2 = Participant2/away)
//   threshold  = opening line in milli-percent (54.407% → 54407)
//   settled_value (at settle) = closing line in milli-percent
export const LINE_CLOSE_MARKET_ID = 90;

export const LINE_CLOSE_DEF: MarketDef = {
  marketId: LINE_CLOSE_MARKET_ID,
  label: "Line Close (favourite % vs open)",
  group: "line",
  line: 0,
  statKey: 0,      // per-market: overwritten by lineInitArgs (favourite side)
  statKey2: null,
  op: null,
  comparison: "greaterThan", // sentinel — never evaluated for LINE_CLOSE
  threshold: 0,    // per-market: overwritten by lineInitArgs (opening line)
  settleAt: "FT",
  numBuckets: 2,
};
BY_ID.set(LINE_CLOSE_MARKET_ID, LINE_CLOSE_DEF);

/** initializeMarket args for a LINE_CLOSE market. `openMilli` is the opening
 *  line (milli-pct), `favSide` the favourite (1|2) it tracks. */
export function lineInitArgs(
  openMilli: number,
  favSide: 1 | 2,
  settleAuthority: PublicKey,
  entryCloseTsSec: number,
) {
  return {
    settleAuthority,
    feeRecipient: null,
    statKey: favSide,
    statKey2: null,
    op: null,
    comparison: { greaterThan: {} },
    threshold: openMilli,
    entryCloseTs: new BN(entryCloseTsSec),
    feeBps: 0,
    numBuckets: 2,
  };
}
```

In the spec (§3 bullet 1), replace “Stat-machinery fields are explicit sentinels (`stat_key 0`, …)” with: “`stat_key` = favourite side (1 = home, 2 = away) so the market is fully self-describing; `op 0`/`comparison` stay sentinels.”

- [ ] **Step 4: Run the full engine suite (guard against template-count regressions)**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run`
Expected: PASS (the “has exactly 7 entries” test still passes — 90 is not in the template)

- [ ] **Step 5: Commit**

```bash
git add engine/src/markets.ts engine/test/markets.test.ts docs/superpowers/specs/2026-07-02-beat-the-market-design.md
git commit -m "feat(engine): LINE_CLOSE market catalog entry (id 90) + lineInitArgs"
```

---

### Task 3: Line open/resolution rules (keeper, pure)

**Files:**
- Create: `keeper/lines-rules.ts`
- Test: `keeper/test/lines-rules.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// keeper/test/lines-rules.test.ts
import { describe, it, expect } from "vitest";
import { pickOpen, resolveLine } from "../lines-rules.js";
import type { OddsRow } from "../../spike/src/odds.js";

const MIN = 60_000;
function row(ts: number, p1: string, p2: string, over: Partial<OddsRow> = {}): OddsRow {
  return {
    FixtureId: 1, MessageId: `m${ts}`, Ts: ts,
    Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT", GameState: null, InRunning: false,
    MarketParameters: null, MarketPeriod: null,
    PriceNames: ["part1", "draw", "part2"], Prices: [1800, 2900, 9000],
    Pct: [p1, "20.0", p2], ...over,
  };
}

describe("pickOpen", () => {
  it("uses the latest fresh line row: open milli-pct + favourite side", () => {
    const now = 100 * MIN;
    const rows = [row(now - 5 * MIN, "60.0", "20.0"), row(now - 90 * MIN, "70.0", "10.0")];
    expect(pickOpen(rows, now, 60)).toEqual({ openMilli: 60000, favSide: 1, rowTs: now - 5 * MIN });
  });
  it("away favourite → favSide 2 and open reads part2", () => {
    const now = 100 * MIN;
    expect(pickOpen([row(now - MIN, "20.0", "61.5")], now, 60))
      .toEqual({ openMilli: 61500, favSide: 2, rowTs: now - MIN });
  });
  it("no row fresh enough → null (skip this pass)", () => {
    const now = 100 * MIN;
    expect(pickOpen([row(now - 61 * MIN, "60.0", "20.0")], now, 60)).toBeNull();
    expect(pickOpen([], now, 60)).toBeNull();
  });
  it("ignores in-running and half-period rows", () => {
    const now = 100 * MIN;
    const rows = [
      row(now - MIN, "80.0", "5.0", { InRunning: true }),
      row(now - MIN, "80.0", "5.0", { MarketPeriod: "half=1" }),
    ];
    expect(pickOpen(rows, now, 60)).toBeNull();
  });
});

describe("resolveLine", () => {
  const ko = 1000 * MIN;
  const base = { kickoffMs: ko, openMilli: 60000, favSide: 1 as const, staleMaxMin: 30 };

  it("close above open → Above (bucket 0) wins", () => {
    const rows = [row(ko - 2 * MIN, "62.1", "18.0")];
    expect(resolveLine(rows, base)).toEqual({
      action: "settle", winningBucket: 0, closeMilli: 62100, closeTsMs: ko - 2 * MIN,
    });
  });
  it("close below open → Below (bucket 1) wins, and post-KO rows are ignored", () => {
    const rows = [row(ko - 3 * MIN, "58.9", "21.0"), row(ko + MIN, "99.0", "0.5")];
    expect(resolveLine(rows, base)).toEqual({
      action: "settle", winningBucket: 1, closeMilli: 58900, closeTsMs: ko - 3 * MIN,
    });
  });
  it("close reads the FAVOURITE side fixed at creation (favSide 2)", () => {
    const rows = [row(ko - MIN, "30.0", "55.5")];
    expect(resolveLine(rows, { ...base, favSide: 2, openMilli: 54000 })).toEqual({
      action: "settle", winningBucket: 0, closeMilli: 55500, closeTsMs: ko - MIN,
    });
  });
  it("exact tie → void", () => {
    const rows = [row(ko - MIN, "60.0", "20.0")];
    expect(resolveLine(rows, base)).toEqual({ action: "void", reason: "tie" });
  });
  it("stale (last row older than staleMaxMin before KO) → void", () => {
    const rows = [row(ko - 31 * MIN, "62.0", "18.0")];
    expect(resolveLine(rows, base)).toEqual({ action: "void", reason: "stale" });
  });
  it("no eligible rows at all → void", () => {
    expect(resolveLine([], base)).toEqual({ action: "void", reason: "no-rows" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx vitest run test/lines-rules.test.ts`
Expected: FAIL — `Cannot find module '../lines-rules.js'`

- [ ] **Step 3: Implement**

```ts
// keeper/lines-rules.ts
/**
 * Beat the Market — pure open/close/resolution rules (spec §2). No I/O.
 * Every branch is unit-tested; lines.ts (the CLI) is a thin shell around these.
 */
import {
  isLineRow, favouriteSide, pctMilliFor, latestLineRowAtOrBefore,
  type OddsRow,
} from "../spike/src/odds.js";

const MIN_MS = 60_000;

export interface OpenPick { openMilli: number; favSide: 1 | 2; rowTs: number }

/** The opening line from the latest FRESH line row (Ts within freshMaxMin of
 *  now). Nothing fresh → null: the caller skips the fixture and retries. */
export function pickOpen(rows: OddsRow[], nowMs: number, freshMaxMin: number): OpenPick | null {
  const r = latestLineRowAtOrBefore(rows.filter(isLineRow), nowMs);
  if (!r || r.Ts < nowMs - freshMaxMin * MIN_MS) return null;
  const favSide = favouriteSide(r);
  return { openMilli: pctMilliFor(r, favSide), favSide, rowTs: r.Ts };
}

export type LineResolution =
  | { action: "settle"; winningBucket: 0 | 1; closeMilli: number; closeTsMs: number }
  | { action: "void"; reason: "no-rows" | "stale" | "tie" };

/** Resolve a line market at/after kick-off from the fixture's odds history.
 *  close = the favourite's milli-pct in the latest line row with Ts <= KO.
 *  Older than staleMaxMin before KO → void. Equal to open → void. */
export function resolveLine(
  rows: OddsRow[],
  opts: { kickoffMs: number; openMilli: number; favSide: 1 | 2; staleMaxMin: number },
): LineResolution {
  const r = latestLineRowAtOrBefore(rows, opts.kickoffMs);
  if (!r) return { action: "void", reason: "no-rows" };
  if (r.Ts < opts.kickoffMs - opts.staleMaxMin * MIN_MS) return { action: "void", reason: "stale" };
  const closeMilli = pctMilliFor(r, opts.favSide);
  if (closeMilli === opts.openMilli) return { action: "void", reason: "tie" };
  return {
    action: "settle",
    winningBucket: closeMilli > opts.openMilli ? 0 : 1,
    closeMilli,
    closeTsMs: r.Ts,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx vitest run test/lines-rules.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add keeper/lines-rules.ts keeper/test/lines-rules.test.ts
git commit -m "feat(keeper): pure Beat-the-Market open/resolution rules"
```

---

### Task 4: keeper `lines.ts` CLI (ensure → seed → settle → sweep)

**Files:**
- Create: `keeper/lines.ts`
- Verify: devnet dry-run (no unit test — the CLI is a thin shell over Task 3 rules + verified Anchor call shapes from `verify-3way.ts`)

- [ ] **Step 1: Implement the CLI**

```ts
// keeper/lines.ts
/**
 * Beat the Market keeper — one idempotent pass over the line markets (spec §4).
 *
 *   ENSURE  fixtures kicking off in (now+minLead, now+horizon] with a fresh
 *           full-game 1X2 StablePrice row → initialize_market(id 90) with
 *           threshold = opening line, stat_key = favourite side. PDA exists → skip.
 *   SEED    open line markets with BOTH bucket totals exactly 0 → place_bet
 *           LINES_SEED_SOL on each side (guard makes double-seeding impossible).
 *   SETTLE  open line markets past KO+buffer → close from /api/odds/updates
 *           (full history — snapshot may be overwritten by in-running rows),
 *           then settle(winning, 0, closeTs, closeMilli) or void_market.
 *   SWEEP   after a terminal state, claim the keeper's own position (recovers
 *           the seed's winning share / void refund).
 *
 *   npx tsx lines.ts [--dry-run] [--fixture <id>]
 *
 * Env (spec §9): LINES_HORIZON_H(24) LINES_MIN_LEAD_MIN(30) LINES_OPEN_FRESH_MIN(60)
 *                LINES_STALE_MAX_MIN(30) LINES_SEED_SOL(0.05) LINES_SETTLE_BUFFER_MIN(2)
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getFixtures, type Fixture } from "../spike/src/discover.js";
import { fetchOddsSnapshot, fetchOddsUpdates } from "../spike/src/odds.js";
import { lineInitArgs, LINE_CLOSE_MARKET_ID } from "../engine/src/markets.js";
import { pickOpen, resolveLine } from "./lines-rules.js";
import { loadProofbetProgram } from "./settle.js";

const BN = anchorDefault.BN;
const SOL = 1_000_000_000;
const MIN_MS = 60_000;

const envNum = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const HORIZON_MS = envNum("LINES_HORIZON_H", 24) * 3_600_000;
const MIN_LEAD_MS = envNum("LINES_MIN_LEAD_MIN", 30) * MIN_MS;
const OPEN_FRESH_MIN = envNum("LINES_OPEN_FRESH_MIN", 60);
const STALE_MAX_MIN = envNum("LINES_STALE_MAX_MIN", 30);
const SEED_LAMPORTS = Math.round(envNum("LINES_SEED_SOL", 0.05) * SOL);
const SETTLE_BUFFER_MS = envNum("LINES_SETTLE_BUFFER_MIN", 2) * MIN_MS;

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function marketPda(pid: PublicKey, fid: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fid), Buffer.from([LINE_CLOSE_MARKET_ID])], pid)[0];
}
function vaultPda(pid: PublicKey, m: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
}
function positionPda(pid: PublicKey, m: PublicKey, b: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), b.toBuffer()], pid)[0];
}

const flagIdx = (n: string) => process.argv.indexOf(`--${n}`);
const DRY = flagIdx("dry-run") >= 0;
const ONLY_FIXTURE = flagIdx("fixture") >= 0 ? Number(process.argv[flagIdx("fixture") + 1]) : null;

async function main() {
  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const program = loadProofbetProgram(ctx.provider);
  const pid = program.programId;
  const me = ctx.wallet.publicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = program.account as any;
  const now = Date.now();

  const fixtures = (await getFixtures(ctx, auth))
    .filter((f) => (ONLY_FIXTURE == null ? true : f.FixtureId === ONLY_FIXTURE));

  // ── ENSURE ──────────────────────────────────────────────────────────────────
  const upcoming = fixtures.filter(
    (f) => f.StartTime > now + MIN_LEAD_MS && f.StartTime <= now + HORIZON_MS,
  );
  console.log(`# ensure: ${upcoming.length} fixture(s) in window`);
  for (const f of upcoming) {
    const market = marketPda(pid, f.FixtureId);
    if ((await acct.market.fetchNullable(market)) !== null) {
      console.log(`  = ${label(f)} — market exists`); continue;
    }
    const snap = await fetchOddsSnapshot(ctx, auth, f.FixtureId);
    const open = pickOpen(snap, now, OPEN_FRESH_MIN);
    if (!open) { console.log(`  · ${label(f)} — no fresh 1X2 line, skipping`); continue; }
    const favName = open.favSide === 1 ? f.Participant1 : f.Participant2;
    console.log(`  + ${label(f)} — open ${fmt(open.openMilli)} on ${favName}${DRY ? " (dry-run)" : ""}`);
    if (DRY) continue;
    await program.methods
      .initializeMarket(new BN(f.FixtureId), LINE_CLOSE_MARKET_ID,
        lineInitArgs(open.openMilli, open.favSide, me, Math.floor(f.StartTime / 1000)))
      .accountsStrict({ creator: me, market, vault: vaultPda(pid, market), systemProgram: SystemProgram.programId })
      .rpc();
  }

  // ── SEED / SETTLE / SWEEP over every candidate fixture ──────────────────────
  const candidates = fixtures.filter(
    (f) => f.StartTime > now - 36 * 3_600_000 && f.StartTime <= now + HORIZON_MS,
  );
  for (const f of candidates) {
    const market = marketPda(pid, f.FixtureId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await acct.market.fetchNullable(market);
    if (m === null) continue;
    const vault = vaultPda(pid, market);
    const position = positionPda(pid, market, me);
    const open = m.status.open !== undefined;
    const totals: bigint[] = m.bucketTotals.slice(0, 2).map((b: any) => BigInt(b.toString()));

    // SEED — both totals exactly zero, still open, before KO.
    if (open && totals[0] === 0n && totals[1] === 0n && now < f.StartTime) {
      const bal = await ctx.connection.getBalance(me);
      if (bal < SEED_LAMPORTS * 2 + 0.01 * SOL) {
        console.log(`  ! ${label(f)} — keeper balance ${(bal / SOL).toFixed(3)}◎ too low to seed, SKIPPING`);
      } else {
        console.log(`  ⬒ ${label(f)} — seeding ${(SEED_LAMPORTS / SOL)}◎ per side${DRY ? " (dry-run)" : ""}`);
        if (!DRY) {
          await program.methods.placeBet(0, new BN(SEED_LAMPORTS))
            .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
          await program.methods.placeBet(1, new BN(SEED_LAMPORTS))
            .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
        }
      }
    }

    // SETTLE — still open, past KO + buffer.
    if (open && now >= f.StartTime + SETTLE_BUFFER_MS) {
      const updates = await fetchOddsUpdates(ctx, auth, f.FixtureId);
      const res = resolveLine(updates, {
        kickoffMs: f.StartTime,
        openMilli: m.threshold as number,
        favSide: (m.statKey as number) === 2 ? 2 : 1,
        staleMaxMin: STALE_MAX_MIN,
      });
      if (res.action === "settle") {
        console.log(`  ✓ ${label(f)} — close ${fmt(res.closeMilli)} vs open ${fmt(m.threshold)} → ` +
          `${res.winningBucket === 0 ? "ABOVE" : "BELOW"} wins${DRY ? " (dry-run)" : ""}`);
        if (!DRY) {
          await program.methods
            .settle(res.winningBucket, 0, new BN(Math.floor(res.closeTsMs / 1000)), res.closeMilli)
            .accountsStrict({ settleAuthority: me, market, vault, feeRecipient: m.feeRecipient }).rpc();
        }
      } else {
        console.log(`  ∅ ${label(f)} — VOID (${res.reason})${DRY ? " (dry-run)" : ""}`);
        if (!DRY) {
          await program.methods.voidMarket(0, new BN(Math.floor(now / 1000)))
            .accountsStrict({ settleAuthority: me, market }).rpc();
        }
      }
    }

    // SWEEP — terminal market, keeper still holds a position → claim seed share.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fresh: any = DRY ? m : await acct.market.fetch(market);
    const terminal = fresh.status.settled !== undefined || fresh.status.voided !== undefined;
    if (terminal && (await acct.position.fetchNullable(position)) !== null) {
      console.log(`  $ ${label(f)} — claiming keeper seed share${DRY ? " (dry-run)" : ""}`);
      if (!DRY) {
        try {
          await program.methods.claim()
            .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
        } catch (e) {
          console.log(`    claim failed (retry next pass): ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
  }
}

const label = (f: Fixture) =>
  `${f.FixtureId} ${f.Participant1} v ${f.Participant2} (KO ${new Date(f.StartTime).toISOString().slice(5, 16)}Z)`;
const fmt = (milli: number) => `${(milli / 1000).toFixed(1)}%`;

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Type-check the keeper package**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx tsc --noEmit 2>&1 | head -20`
Expected: no errors mentioning `lines.ts` (pre-existing unrelated errors, if any, are out of scope)

- [ ] **Step 3: Devnet dry-run (real feed, zero transactions)**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx tsx lines.ts --dry-run`
Expected: `# ensure: N fixture(s) in window`; for each odds-carrying fixture a `+ … open XX.X% on <team> (dry-run)` line; odds-less fixtures logged `· no fresh 1X2 line`. No transaction signatures in the output.

- [ ] **Step 4: Commit**

```bash
git add keeper/lines.ts
git commit -m "feat(keeper): lines.ts — ensure/seed/settle/sweep pass for line markets"
```

---

### Task 5: cron wiring — pause daily card, run lines pass

**Files:**
- Modify: `keeper/cron.ts`
- Modify: `keeper/create-daily-card.ts` (stale “no odds on devnet” comment, lines 40–56)
- Test: `keeper/test/cron.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `keeper/test/cron.test.ts`:

```ts
import { linesIntervalMs, dailyCardCreateEnabled } from "../cron.js";

describe("linesIntervalMs", () => {
  it("defaults to 5 minutes and floors at 1s", () => {
    expect(linesIntervalMs({} as NodeJS.ProcessEnv)).toBe(5 * 60_000);
    expect(linesIntervalMs({ LINES_INTERVAL_MIN: "2" } as unknown as NodeJS.ProcessEnv)).toBe(120_000);
    expect(linesIntervalMs({ LINES_INTERVAL_MIN: "0" } as unknown as NodeJS.ProcessEnv)).toBe(1_000);
    expect(linesIntervalMs({ LINES_INTERVAL_MIN: "junk" } as unknown as NodeJS.ProcessEnv)).toBe(5 * 60_000);
  });
});

describe("dailyCardCreateEnabled", () => {
  it("is on by default and off only at the explicit '0'", () => {
    expect(dailyCardCreateEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(dailyCardCreateEnabled({ DAILY_CARD_CREATE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(dailyCardCreateEnabled({ DAILY_CARD_CREATE: "0" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx vitest run test/cron.test.ts`
Expected: FAIL — `linesIntervalMs` not exported

- [ ] **Step 3: Implement** — in `keeper/cron.ts`:

Add next to `scheduleIntervalMs` (same pure-helper section):

```ts
/**
 * The Beat-the-Market lines-pass interval in MILLISECONDS, from
 * `LINES_INTERVAL_MIN` (MINUTES; default 5). Same floor pattern as the other
 * interval helpers. The pass is idempotent (PDA-exists / zero-totals /
 * status-open guards), so cadence only bounds settle latency after KO.
 */
export function linesIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.LINES_INTERVAL_MIN ?? "5");
  const min = Number.isFinite(raw) ? raw : 5;
  return Math.max(1 / 60, min) * MINUTE_MS;
}

/** Daily-card create toggle: `DAILY_CARD_CREATE=0` pauses the 08:00Z card
 *  create (the Parlay tab is hidden); anything else leaves it on. Pure. */
export function dailyCardCreateEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.DAILY_CARD_CREATE !== "0";
}
```

Add a runner beside `runSchedulePools`:

```ts
/** Run one Beat-the-Market lines pass (ensure/seed/settle/sweep; idempotent). */
async function runLinesPass(dryRun: boolean): Promise<void> {
  const args = dryRun ? ["--dry-run"] : [];
  const ts = new Date().toISOString();
  console.log(`[cron ${ts}] === lines pass${dryRun ? " (DRY RUN)" : ""} ===`);
  const code = await runKeeperScript("lines.ts", args);
  console.log(`[cron] lines pass exited ${code}`);
}
```

In `main()`: gate job (1) — wrap the `scheduleDailyCreate();` call:

```ts
  if (dailyCardCreateEnabled(process.env)) {
    scheduleDailyCreate();
  } else {
    console.log("[cron] daily-card create PAUSED (DAILY_CARD_CREATE=0) — settle loop unaffected");
  }
```

And append job (5) after the pool auto-scheduler block (same busy-guard pattern):

```ts
  // (5) Beat the Market lines pass: ensure/seed/settle line markets every
  //     LINES_INTERVAL_MIN (default 5m). Idempotent; run once on boot.
  let linesBusy = false;
  const tickLines = async () => {
    if (linesBusy) { console.log("[cron] previous lines pass still running — skipping tick"); return; }
    linesBusy = true;
    try { await runLinesPass(dryRun); }
    finally { linesBusy = false; }
  };
  await tickLines();
  setInterval(tickLines, linesIntervalMs(process.env));
```

Also update the header comment’s job list (two jobs → note jobs 4/5) and, in `keeper/create-daily-card.ts` lines 40–41, replace “it carries NO pre-match bookmaker odds” with: “pre-match StablePrice odds DO exist for some fixtures (`/api/odds/snapshot/{id}` — see spike/src/odds.ts, probed 2026-07-02); the card allocator still runs on pool-implied/neutral priors and can adopt them later.”

- [ ] **Step 4: Run keeper suite**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx vitest run`
Expected: PASS (new + existing)

- [ ] **Step 5: Commit**

```bash
git add keeper/cron.ts keeper/create-daily-card.ts keeper/test/cron.test.ts
git commit -m "feat(keeper): cron lines pass + DAILY_CARD_CREATE pause flag"
```

---

### Task 6: engine chain readers — `readLineMarkets` + `readLinePosition`

**Files:**
- Modify: `engine/src/chain.ts` (append; follow the `readLiveContests` defensive pattern)

- [ ] **Step 1: Implement** — append to `engine/src/chain.ts`:

```ts
// ── Beat the Market: line-market reader (market_id 90) ──────────────────────

/** Mirrors markets.ts LINE_CLOSE_MARKET_ID (imported value, single source). */
import { LINE_CLOSE_MARKET_ID } from "./markets.ts";

export interface LineMarketView {
  pubkey: string;
  fixtureId: number;
  status: "open" | "settled" | "voided";
  /** Favourite side the line tracks: 1 = home/Participant1, 2 = away. */
  favSide: 1 | 2;
  /** Opening line, milli-percent (stat threshold field). */
  openMilli: number;
  /** Kick-off (= entry_close_ts), unix SECONDS. */
  entryCloseTs: number;
  bucketTotals: [string, string]; // [Above, Below] lamports
  totalPool: string;
  winningBucket: number | null;
  /** Closing line, milli-percent; meaningful only when settled. */
  settledValueMilli: number;
  settledTs: number;
}

/**
 * Every LINE_CLOSE (market_id 90) market on the program. Discriminator+size
 * filtered getProgramAccounts, decoded via the Anchor coder, then filtered by
 * market_id — same defensive shape as readLiveContests: any RPC/coder failure
 * returns [] rather than throwing into a route.
 */
export async function readLineMarkets(): Promise<LineMarketView[]> {
  try {
    const program = loadProgram();
    const conn = program.provider.connection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coder = (program.coder as any).accounts;
    const disc = coder.memcmp("market");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const size: number | undefined = (program.account as any).market?.size;
    const filters: object[] = [{ memcmp: { offset: disc.offset ?? 0, bytes: disc.bytes } }];
    if (size) filters.push({ dataSize: size });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (conn as any).getProgramAccounts(program.programId, { filters });
    const out: LineMarketView[] = [];
    for (const item of raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let m: any;
      try { m = coder.decode("market", item.account.data); } catch { continue; }
      if ((m.marketId as number) !== LINE_CLOSE_MARKET_ID) continue;
      out.push({
        pubkey: item.pubkey.toBase58(),
        fixtureId: Number(m.fixtureId),
        status: statusString(m.status),
        favSide: (m.statKey as number) === 2 ? 2 : 1,
        openMilli: m.threshold as number,
        entryCloseTs: Number(m.entryCloseTs),
        bucketTotals: [m.bucketTotals[0].toString(), m.bucketTotals[1].toString()],
        totalPool: m.totalPool.toString(),
        winningBucket: m.winningBucket == null ? null : Number(m.winningBucket),
        settledValueMilli: m.settledValue as number,
        settledTs: Number(m.settledTs),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** This wallet's stakes on a fixture's line market: [Above, Below] lamports,
 *  or null when no position exists. */
export async function readLinePosition(
  fixtureId: number, wallet: string,
): Promise<[string, string] | null> {
  try {
    const program = loadProgram();
    const market = deriveMarketPda(program.programId, fixtureId, LINE_CLOSE_MARKET_ID);
    const position = derivePositionPda(program.programId, market, new PublicKey(wallet));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = await (program.account as any).position.fetchNullable(position);
    if (p === null) return null;
    return [p.amounts[0].toString(), p.amounts[1].toString()];
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Type-check + existing suite**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run test/chain.test.ts && npx tsc --noEmit 2>&1 | head -10`
Expected: existing chain tests PASS; no new type errors

- [ ] **Step 3: Commit**

```bash
git add engine/src/chain.ts
git commit -m "feat(engine): readLineMarkets + readLinePosition chain readers"
```

---

### Task 7: engine `LinesStore` (odds series poller)

**Files:**
- Create: `engine/src/lines.ts`
- Test: `engine/test/lines.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// engine/test/lines.test.ts
import { describe, it, expect } from "vitest";
import { LinesStore, downsample } from "../src/lines.ts";
import type { OddsRow } from "../../spike/src/odds.js";

const MIN = 60_000;
function lineRow(ts: number, p1: string): OddsRow {
  return {
    FixtureId: 7, MessageId: `m${ts}`, Ts: ts,
    Bookmaker: "TXLineStablePriceDemargined", BookmakerId: 10021,
    SuperOddsType: "1X2_PARTICIPANT_RESULT", GameState: null, InRunning: false,
    MarketParameters: null, MarketPeriod: null,
    PriceNames: ["part1", "draw", "part2"], Prices: [1800, 2900, 9000],
    Pct: [p1, "25.0", "15.0"],
  };
}

describe("downsample", () => {
  it("keeps at most one point per bucket and always the last point", () => {
    const pts: [number, number][] = [
      [0, 1], [10_000, 2], [59_000, 3], [61_000, 4], [125_000, 5],
    ];
    expect(downsample(pts, 60_000)).toEqual([[0, 1], [61_000, 4], [125_000, 5]]);
  });
});

describe("LinesStore", () => {
  it("seeds history once from updates, then appends snapshot changes", async () => {
    let updatesCalls = 0;
    const store = new LinesStore({
      fetchUpdates: async () => { updatesCalls++; return [lineRow(0, "60.0"), lineRow(2 * MIN, "61.0")]; },
      fetchSnapshot: async () => [lineRow(5 * MIN, "62.5")],
    });
    await store.track(7, 1); // fixtureId, favSide
    expect(updatesCalls).toBe(1);
    expect(store.series(7)).toEqual([[0, 60000], [2 * MIN, 61000]]);

    await store.poll();
    expect(store.current(7)).toEqual({ pctMilli: 62500, ts: 5 * MIN });
    expect(store.series(7)).toEqual([[0, 60000], [2 * MIN, 61000], [5 * MIN, 62500]]);

    await store.poll(); // same snapshot again → no duplicate point
    expect(store.series(7)).toHaveLength(3);
    await store.track(7, 1); // re-track → no re-seed
    expect(updatesCalls).toBe(1);
  });

  it("current() is null when no line rows exist; untrack stops polling", async () => {
    const store = new LinesStore({
      fetchUpdates: async () => [],
      fetchSnapshot: async () => [],
    });
    await store.track(9, 2);
    await store.poll();
    expect(store.current(9)).toBeNull();
    expect(store.series(9)).toEqual([]);
    store.untrack(9);
    expect(store.tracked()).toEqual([]);
  });

  it("remembers fixture names", () => {
    const store = new LinesStore({ fetchUpdates: async () => [], fetchSnapshot: async () => [] });
    store.setNames([{ fixtureId: 7, home: "Spain", away: "Austria" }]);
    expect(store.name(7)).toEqual({ home: "Spain", away: "Austria" });
    expect(store.name(8)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run test/lines.test.ts`
Expected: FAIL — `Cannot find module '../src/lines.ts'`

- [ ] **Step 3: Implement**

```ts
// engine/src/lines.ts
/**
 * Beat the Market — engine-side odds tracker (spec §5).
 *
 * Owns ONLY odds data (series + latest point + fixture names). Money numbers
 * (pot, totals, status) are read fresh from the chain by the routes. Injectable
 * fetchers make it fully unit-testable; production wiring (start()) polls
 * TxLINE every LINES_POLL_SECS and refreshes the tracked set from
 * readLineMarkets every 60s.
 */
import {
  isLineRow, pctMilliFor,
  fetchOddsSnapshot, fetchOddsUpdates, latestLineRowAtOrBefore, type OddsRow,
} from "../../spike/src/odds.js";
import type { Auth, SpikeContext } from "../../spike/src/auth.js";

const POLL_MS = Math.max(5, Number(process.env.LINES_POLL_SECS ?? "45")) * 1000;
const DOWNSAMPLE_MS = 60_000;
const RING_CAP = 720; // ≤ 12h at 1/min

/** ≤1 point per bucket of `stepMs`; the final point always survives. */
export function downsample(points: [number, number][], stepMs: number): [number, number][] {
  const out: [number, number][] = [];
  let bucket = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ts] = points[i];
    const b = Math.floor(ts / stepMs);
    if (b > bucket) { out.push(points[i]); bucket = b; }
    else if (i === points.length - 1) out[out.length - 1] = points[i];
  }
  return out;
}

interface Fetchers {
  fetchSnapshot: (fixtureId: number) => Promise<OddsRow[]>;
  fetchUpdates: (fixtureId: number) => Promise<OddsRow[]>;
}
interface Tracked {
  favSide: 1 | 2;
  seeded: boolean;
  series: [number, number][]; // [tsMs, pctMilli], ascending
}

export class LinesStore {
  private fx: Fetchers;
  private map = new Map<number, Tracked>();
  private names = new Map<number, { home: string; away: string }>();

  constructor(fx?: Partial<Fetchers>) {
    // Production fetchers are bound in start(); tests inject fakes here.
    this.fx = {
      fetchSnapshot: fx?.fetchSnapshot ?? (async () => []),
      fetchUpdates: fx?.fetchUpdates ?? (async () => []),
    };
  }

  /** Begin tracking a fixture's line; seeds history from updates ONCE. */
  async track(fixtureId: number, favSide: 1 | 2): Promise<void> {
    let t = this.map.get(fixtureId);
    if (!t) { t = { favSide, seeded: false, series: [] }; this.map.set(fixtureId, t); }
    if (t.seeded) return;
    t.seeded = true;
    try {
      const rows = (await this.fx.fetchUpdates(fixtureId)).filter(isLineRow);
      rows.sort((a, b) => a.Ts - b.Ts);
      const pts: [number, number][] = rows.map((r) => [r.Ts, pctMilliFor(r, t!.favSide)]);
      t.series = downsample(pts, DOWNSAMPLE_MS).slice(-RING_CAP);
    } catch { /* history is a nice-to-have; the snapshot poll still runs */ }
  }

  untrack(fixtureId: number): void { this.map.delete(fixtureId); }
  tracked(): number[] { return [...this.map.keys()]; }

  /** One snapshot poll over every tracked fixture; appends changed points. */
  async poll(): Promise<void> {
    for (const [fixtureId, t] of this.map) {
      try {
        const row = latestLineRowAtOrBefore(
          (await this.fx.fetchSnapshot(fixtureId)).filter(isLineRow), Number.MAX_SAFE_INTEGER);
        if (!row) continue;
        const pt: [number, number] = [row.Ts, pctMilliFor(row, t.favSide)];
        const last = t.series[t.series.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
          t.series.push(pt);
          if (t.series.length > RING_CAP) t.series.shift();
        }
      } catch { /* transient upstream failure: keep last-known series */ }
    }
  }

  current(fixtureId: number): { pctMilli: number; ts: number } | null {
    const t = this.map.get(fixtureId);
    const last = t?.series[t.series.length - 1];
    return last ? { pctMilli: last[1], ts: last[0] } : null;
  }
  series(fixtureId: number): [number, number][] { return this.map.get(fixtureId)?.series ?? []; }

  setNames(rows: { fixtureId: number; home: string; away: string }[]): void {
    for (const r of rows) this.names.set(r.fixtureId, { home: r.home, away: r.away });
  }
  name(fixtureId: number): { home: string; away: string } | null {
    return this.names.get(fixtureId) ?? null;
  }

  /** Production loop: bind real fetchers, then (a) refresh tracked set + names
   *  from the chain + fixtures every 60s, (b) poll snapshots every POLL_MS. */
  start(ctx: SpikeContext, auth: Auth): void {
    this.fx = {
      fetchSnapshot: (id) => fetchOddsSnapshot(ctx, auth, id),
      fetchUpdates: (id) => fetchOddsUpdates(ctx, auth, id),
    };
    const refresh = async () => {
      try {
        const { readLineMarkets } = await import("./chain.ts");
        const { getFixtures } = await import("../../spike/src/discover.js");
        const markets = await readLineMarkets();
        const nowSec = Math.floor(Date.now() / 1000);
        for (const m of markets) {
          if (m.status === "open" || m.entryCloseTs > nowSec - 36 * 3600) {
            await this.track(m.fixtureId, m.favSide);
          }
          if (m.status !== "open") this.untrackLater(m.fixtureId, m.entryCloseTs, nowSec);
        }
        const fixtures = await getFixtures(ctx, auth);
        this.setNames(fixtures.map((f) => ({
          fixtureId: f.FixtureId, home: f.Participant1, away: f.Participant2,
        })));
      } catch (e) {
        console.warn("lines refresh failed:", (e as Error).message);
      }
    };
    void refresh();
    setInterval(refresh, 60_000);
    setInterval(() => void this.poll(), POLL_MS);
  }

  /** Drop terminal fixtures once they age out (keeps results visible ~36h). */
  private untrackLater(fixtureId: number, entryCloseTs: number, nowSec: number): void {
    if (entryCloseTs < nowSec - 36 * 3600) this.untrack(fixtureId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run test/lines.test.ts`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add engine/src/lines.ts engine/test/lines.test.ts
git commit -m "feat(engine): LinesStore odds tracker (seed-once history, snapshot poll)"
```

---

### Task 8: engine routes — `/api/lines` + `/api/lines/:fixtureId` + history labels

**Files:**
- Modify: `engine/src/routes.ts` (new signature param + two routes)
- Modify: `engine/src/server.ts` (construct + start LinesStore)
- Modify: `engine/src/history.ts` (`sideLabel` line branch)
- Test: `engine/test/lines-routes.test.ts` (create), `engine/test/history.test.ts` (append one case)

- [ ] **Step 1: Write the failing route test**

```ts
// engine/test/lines-routes.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildServer } from "../src/server.ts";
import { LinesStore } from "../src/lines.ts";

vi.mock("../src/chain.ts", async (orig) => {
  const real = await orig<typeof import("../src/chain.ts")>();
  return {
    ...real,
    readLineMarkets: vi.fn(async () => [
      {
        pubkey: "Line111", fixtureId: 7, status: "open", favSide: 1,
        openMilli: 60000, entryCloseTs: 9_999_999_999,
        bucketTotals: ["50000000", "50000000"], totalPool: "100000000",
        winningBucket: null, settledValueMilli: 0, settledTs: 0,
      },
      {
        pubkey: "Line222", fixtureId: 8, status: "settled", favSide: 2,
        openMilli: 54000, entryCloseTs: 1_700_000_000,
        bucketTotals: ["80000000", "60000000"], totalPool: "140000000",
        winningBucket: 0, settledValueMilli: 55100, settledTs: 1_700_000_100,
      },
    ]),
    readLinePosition: vi.fn(async (_f: number, w: string) =>
      w === "Me111" ? (["10000000", "0"] as [string, string]) : null),
  };
});

afterEach(() => vi.restoreAllMocks());

function fakeLines(): LinesStore {
  const store = new LinesStore({
    fetchUpdates: async () => [], fetchSnapshot: async () => [],
  });
  store.setNames([{ fixtureId: 7, home: "Spain", away: "Austria" }]);
  // Pre-seed a series through the test-only injection path used across suites:
  // track() with empty updates, then hand-push via poll is overkill — assert
  // series-less behavior (current: null) for fixture 7 and shape otherwise.
  return store;
}

describe("GET /api/lines", () => {
  it("serves chain money + store odds, honest nulls when odds absent", async () => {
    const app = buildServer(undefined, fakeLines());
    const res = await app.inject({ url: "/api/lines" });
    const body = res.json();
    expect(body.lines).toHaveLength(2);
    const open = body.lines.find((l: { fixtureId: number }) => l.fixtureId === 7);
    expect(open).toMatchObject({
      marketPk: "Line111", status: "open", favSide: 1, favName: "Spain",
      home: "Spain", away: "Austria", openMilli: 60000,
      kickoffMs: 9_999_999_999_000, potLamports: "100000000",
      bucketTotals: ["50000000", "50000000"], current: null,
      winningBucket: null,
    });
    expect(typeof open.houseBoostLamports).toBe("number");
    const settled = body.lines.find((l: { fixtureId: number }) => l.fixtureId === 8);
    expect(settled).toMatchObject({
      status: "settled", winningBucket: 0, settledValueMilli: 55100,
      home: "Fixture #8", away: "", favName: "Fixture #8",
    });
    await app.close();
  });
});

describe("GET /api/lines/:fixtureId", () => {
  it("returns the line + series + caller's stakes", async () => {
    const app = buildServer(undefined, fakeLines());
    const res = await app.inject({ url: "/api/lines/7?wallet=Me111" });
    const body = res.json();
    expect(body.line.fixtureId).toBe(7);
    expect(body.series).toEqual([]);
    expect(body.myStakes).toEqual(["10000000", "0"]);
    await app.close();
  });
  it("404s an unknown fixture", async () => {
    const app = buildServer(undefined, fakeLines());
    const res = await app.inject({ url: "/api/lines/999" });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run test/lines-routes.test.ts`
Expected: FAIL — buildServer takes 1 argument / route missing

- [ ] **Step 3: Implement**

`engine/src/server.ts` — extend the signature and the isMain block:

```ts
import { LinesStore } from "./lines.ts";
// …
export function buildServer(store?: LiveStore, linesStore?: LinesStore): FastifyInstance {
  // … (unchanged until registerRoutes)
  const liveStore = store ?? new LiveStore();
  const lines = linesStore ?? new LinesStore();
  registerRoutes(app, liveStore, lines);
  return app;
}
```

In `isMain` construct one store and pass it to both `buildServer` and `.start`:

```ts
  const liveStore = new LiveStore();
  const linesStore = new LinesStore();
  const app = buildServer(liveStore, linesStore);
```

and after `liveStore.start(ctx, auth);` add `linesStore.start(ctx, auth);`.

`engine/src/routes.ts` — update the signature `export function registerRoutes(app, liveStore, linesStore)` (import `LinesStore` type + `readLineMarkets`, `readLinePosition` from `./chain.ts`), then add:

```ts
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
    const names = linesStore.name(m.fixtureId);
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
      current: linesStore.current(m.fixtureId), // {pctMilli, ts} | null — never invented
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
      series: linesStore.series(fixtureId),
      myStakes: wallet ? await readLinePosition(fixtureId, wallet) : null,
    };
  });
```

`engine/src/history.ts` — in `sideLabel` insert before the final return:

```ts
  if (group === "line") return bucket === 0 ? "Above" : "Below";
```

Append to `engine/test/history.test.ts` (locate the existing `sideLabel`-adjacent tests; if `sideLabel` is not exported, test through the exported history formatter the file already tests — the assertion is that a `group: "line"` leg renders "Above"/"Below". If neither is reachable, export `sideLabel` and test it directly):

```ts
it("labels line-market buckets Above/Below", () => {
  expect(sideLabel("line", 0, "Spain", "Austria")).toBe("Above");
  expect(sideLabel("line", 1, "Spain", "Austria")).toBe("Below");
});
```

- [ ] **Step 4: Run the engine suite**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/engine && npx vitest run`
Expected: PASS — new lines-routes tests + all existing (routes.test.ts still constructs `buildServer()` with no args — both params are optional)

- [ ] **Step 5: Commit**

```bash
git add engine/src/routes.ts engine/src/server.ts engine/src/history.ts engine/test/lines-routes.test.ts engine/test/history.test.ts
git commit -m "feat(engine): /api/lines + /api/lines/:fixtureId, Above/Below history labels"
```

---

### Task 9: web — api types + pure `lines` mapper

**Files:**
- Modify: `web/src/lib/api.ts` (append types + fetchers)
- Create: `web/src/lib/lines.ts`
- Test: `web/test/lines.test.ts`

- [ ] **Step 1: Append to `web/src/lib/api.ts`** (mirror of Task 8's DTO — no test yet, exercised via the mapper tests):

```ts
// ── Beat the Market ──────────────────────────────────────────────────────────
export interface LineDto {
  fixtureId: number; home: string; away: string;
  favName: string; favSide: 1 | 2;
  kickoffMs: number; marketPk: string;
  status: "open" | "settled" | "voided";
  openMilli: number;
  current: { pctMilli: number; ts: number } | null;
  potLamports: string;
  bucketTotals: [string, string];
  houseBoostLamports: number;
  winningBucket: number | null;
  settledValueMilli: number | null;
  settledTs: number | null;
}
export interface LinesResponse { lines: LineDto[] }
export interface LineDetailResponse {
  line: LineDto;
  series: [number, number][];
  myStakes: [string, string] | null;
}
export const getLines = (): Promise<LinesResponse> =>
  fetch(`${ENGINE}/api/lines`).then(json);
export const getLineDetail = (fixtureId: number, wallet?: string | null): Promise<LineDetailResponse> =>
  fetch(`${ENGINE}/api/lines/${fixtureId}${wallet ? `?wallet=${wallet}` : ""}`).then(json);
```

- [ ] **Step 2: Write the failing mapper test**

```ts
// web/test/lines.test.ts
import { describe, it, expect } from "vitest";
import { mapSlateRow, mapLineDetail, estWinLamports, LINE_STAKE_PRESETS } from "../src/lib/lines.ts";
import type { LineDto } from "../src/lib/api.ts";

const NOW = 1_800_000_000_000;
function dto(over: Partial<LineDto> = {}): LineDto {
  return {
    fixtureId: 7, home: "Spain", away: "Austria", favName: "Spain", favSide: 1,
    kickoffMs: NOW + 3_600_000, marketPk: "Line111", status: "open",
    openMilli: 60000, current: { pctMilli: 61200, ts: NOW - 30_000 },
    potLamports: "100000000", bucketTotals: ["50000000", "50000000"],
    houseBoostLamports: 100000000, winningBucket: null,
    settledValueMilli: null, settledTs: null, ...over,
  };
}

describe("estWinLamports", () => {
  it("pre-bet preview includes your own stake in pot and side", () => {
    // pot 0.1, side 0.05, stake 0.01 → (0.11 * 0.01) / 0.06
    expect(estWinLamports(dto(), 0, 10_000_000n, null)).toBe(18_333_333n);
  });
  it("post-bet estimate uses your recorded stake against live totals", () => {
    // my 0.01 already inside side total 0.06, pot 0.11
    const d = dto({ bucketTotals: ["60000000", "50000000"], potLamports: "110000000" });
    expect(estWinLamports(d, 0, 0n, ["10000000", "0"])).toBe(18_333_333n);
  });
});

describe("mapSlateRow", () => {
  it("open line with odds → live pct, direction vs open, pot text", () => {
    const r = mapSlateRow(dto(), NOW);
    expect(r).toMatchObject({
      fixtureId: 7, title: "Spain v Austria", favName: "Spain",
      pctText: "61.2%", dirUp: true, status: "open", clickable: true,
    });
    expect(r.potText).toContain("0.1");
  });
  it("odds missing → honest dash, still clickable", () => {
    const r = mapSlateRow(dto({ current: null }), NOW);
    expect(r.pctText).toBe("—");
    expect(r.dirUp).toBeNull();
  });
  it("settled line summarises open → close and the winner", () => {
    const r = mapSlateRow(dto({
      status: "settled", winningBucket: 0, settledValueMilli: 61500, current: null,
    }), NOW);
    expect(r.status).toBe("settled");
    expect(r.resultText).toBe("opened 60.0% → closed 61.5% · Above won");
  });
});

describe("mapLineDetail", () => {
  const detail = { line: dto(), series: [[NOW - 120_000, 60000], [NOW - 60_000, 61200]] as [number, number][], myStakes: null };

  it("no position → both options biddable with est-win previews per preset", () => {
    const d = mapLineDetail(detail, NOW);
    expect(d.canBet).toBe(true);
    expect(d.options[0].label).toBe("Above");
    expect(d.options[1].label).toBe("Below");
    expect(d.deltaText).toBe("▲ +1.2 vs open");
    expect(d.presets).toEqual(LINE_STAKE_PRESETS);
  });
  it("with a position → verdict tracks the live line vs open", () => {
    const d = mapLineDetail({ ...detail, myStakes: ["10000000", "0"] }, NOW);
    expect(d.canBet).toBe(false);
    expect(d.verdict).toEqual({ tone: "win", text: "your Above is ahead ✓ · 61.2% vs 60.0% open" });
  });
  it("behind side → lose tone; voided → refund claim", () => {
    const behind = mapLineDetail({ ...detail, myStakes: ["0", "10000000"] }, NOW);
    expect(behind.verdict?.tone).toBe("lose");
    const voided = mapLineDetail({
      ...detail, line: dto({ status: "voided", current: null }), myStakes: ["0", "10000000"],
    }, NOW);
    expect(voided.claim).toEqual({ kind: "refund", amountLamports: 10_000_000n });
  });
  it("settled won → claim with pro-rata share; lost → no claim", () => {
    const won = mapLineDetail({
      ...detail,
      line: dto({ status: "settled", winningBucket: 0, settledValueMilli: 61500, current: null }),
      myStakes: ["10000000", "0"],
    }, NOW);
    // share = pot * my / sideTotal = 0.1 * 0.01 / 0.05
    expect(won.claim).toEqual({ kind: "won", amountLamports: 20_000_000n });
    const lost = mapLineDetail({
      ...detail,
      line: dto({ status: "settled", winningBucket: 1, settledValueMilli: 58000, current: null }),
      myStakes: ["10000000", "0"],
    }, NOW);
    expect(lost.claim).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/web && npx vitest run test/lines.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/lines.ts'`

- [ ] **Step 4: Implement the mapper**

```ts
// web/src/lib/lines.ts
/* ──────────────────────────────────────────────────────────────────────────
 * Beat the Market — pure view-model mapper (same contract as liveGame.ts):
 * pure function of (server payload, wallet stakes, nowMs) → render model.
 * No RNG, no fabricated values — odds gaps render as "—".
 * ────────────────────────────────────────────────────────────────────────── */
import type { LineDto, LineDetailResponse } from "./api.ts";

const SOL = "◎";
const LAMPORTS = 1e9;
export const LINE_STAKE_PRESETS: bigint[] = [10_000_000n, 50_000_000n, 100_000_000n]; // ◎0.01/0.05/0.10

export const pctText = (milli: number | null | undefined): string =>
  milli == null ? "—" : `${(milli / 1000).toFixed(1)}%`;
export const solText = (lamports: bigint | number | string): string => {
  const n = Number(lamports) / LAMPORTS;
  return SOL + (n < 1 ? String(+n.toFixed(3)) : n.toFixed(2));
};

/** Pro-rata winnings estimate (fee is 0 for line markets).
 *  Pre-bet (pendingStake > 0): both pot and side grow by your stake.
 *  Post-bet: your recorded stake against the live totals. Floor division. */
export function estWinLamports(
  line: LineDto, bucket: 0 | 1, pendingStake: bigint, myStakes: [string, string] | null,
): bigint {
  const pot = BigInt(line.potLamports) + pendingStake;
  const side = BigInt(line.bucketTotals[bucket]) + pendingStake;
  const mine = pendingStake > 0n ? pendingStake : BigInt(myStakes?.[bucket] ?? "0");
  if (side === 0n || mine === 0n) return 0n;
  return (pot * mine) / side;
}

export interface SlateRowVM {
  fixtureId: number; title: string; favName: string;
  koLabel: string; kickoffMs: number;
  pctText: string; dirUp: boolean | null;
  potText: string; status: LineDto["status"]; clickable: boolean;
  resultText: string | null;
}

export function mapSlateRow(line: LineDto, _nowMs: number): SlateRowVM {
  const settled = line.status === "settled";
  const dirUp = line.current == null ? null : line.current.pctMilli >= line.openMilli;
  return {
    fixtureId: line.fixtureId,
    title: line.away ? `${line.home} v ${line.away}` : line.home,
    favName: line.favName,
    koLabel: new Date(line.kickoffMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    kickoffMs: line.kickoffMs,
    pctText: settled ? pctText(line.settledValueMilli) : pctText(line.current?.pctMilli),
    dirUp,
    potText: `${solText(line.potLamports)} pot`,
    status: line.status,
    clickable: true,
    resultText: settled && line.settledValueMilli != null
      ? `opened ${pctText(line.openMilli)} → closed ${pctText(line.settledValueMilli)} · ` +
        `${line.winningBucket === 0 ? "Above" : "Below"} won`
      : line.status === "voided" ? "voided — refunds open" : null,
  };
}

export interface LineOptionVM {
  bucket: 0 | 1; label: "Above" | "Below";
  sideTotalText: string;
  /** est win per preset stake, aligned with LINE_STAKE_PRESETS. */
  estWinTexts: string[];
}
export interface DetailVM {
  row: SlateRowVM;
  openText: string; currentText: string;
  deltaText: string | null; deltaUp: boolean;
  spark: { points: [number, number][]; openMilli: number };
  options: [LineOptionVM, LineOptionVM];
  presets: bigint[];
  canBet: boolean;
  myBucket: 0 | 1 | null; myStakeText: string | null;
  verdict: { tone: "win" | "lose"; text: string } | null;
  claim: { kind: "won" | "refund"; amountLamports: bigint } | null;
  houseBoostText: string;
}

export function mapLineDetail(detail: LineDetailResponse, nowMs: number): DetailVM {
  const { line, series, myStakes } = detail;
  const myAbove = BigInt(myStakes?.[0] ?? "0");
  const myBelow = BigInt(myStakes?.[1] ?? "0");
  const myBucket: 0 | 1 | null = myAbove > 0n ? 0 : myBelow > 0n ? 1 : null;
  const myStake = myBucket === 0 ? myAbove : myBucket === 1 ? myBelow : 0n;
  const open = line.status === "open";
  const cur = line.current?.pctMilli ?? null;
  const delta = cur == null ? null : cur - line.openMilli;

  let verdict: DetailVM["verdict"] = null;
  if (open && myBucket != null && cur != null && delta !== 0) {
    const ahead = (myBucket === 0) === (cur > line.openMilli);
    const side = myBucket === 0 ? "Above" : "Below";
    verdict = {
      tone: ahead ? "win" : "lose",
      text: `your ${side} is ${ahead ? "ahead ✓" : "behind ✕"} · ${pctText(cur)} vs ${pctText(line.openMilli)} open`,
    };
  }

  let claim: DetailVM["claim"] = null;
  if (line.status === "voided" && myAbove + myBelow > 0n) {
    claim = { kind: "refund", amountLamports: myAbove + myBelow };
  } else if (line.status === "settled" && line.winningBucket != null) {
    const wb = line.winningBucket as 0 | 1;
    const mine = wb === 0 ? myAbove : myBelow;
    if (mine > 0n) {
      const side = BigInt(line.bucketTotals[wb]);
      claim = { kind: "won", amountLamports: side === 0n ? 0n : (BigInt(line.potLamports) * mine) / side };
    }
  }

  const option = (bucket: 0 | 1): LineOptionVM => ({
    bucket,
    label: bucket === 0 ? "Above" : "Below",
    sideTotalText: solText(line.bucketTotals[bucket]),
    estWinTexts: LINE_STAKE_PRESETS.map((p) => solText(estWinLamports(line, bucket, p, myStakes))),
  });

  return {
    row: mapSlateRow(line, nowMs),
    openText: pctText(line.openMilli),
    currentText: pctText(cur),
    deltaText: delta == null ? null
      : `${delta >= 0 ? "▲ +" : "▼ "}${(delta / 1000).toFixed(1)} vs open`,
    deltaUp: (delta ?? 0) >= 0,
    spark: { points: series, openMilli: line.openMilli },
    options: [option(0), option(1)],
    presets: LINE_STAKE_PRESETS,
    canBet: open && myBucket == null && nowMs < line.kickoffMs,
    myBucket,
    myStakeText: myBucket == null ? null : solText(myStake),
    verdict,
    claim,
    houseBoostText: `pot includes ${solText(line.houseBoostLamports)} house boost`,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/web && npx vitest run test/lines.test.ts`
Expected: PASS (all)

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/lines.ts web/test/lines.test.ts
git commit -m "feat(web): line DTOs + pure Beat-the-Market view-model mapper"
```

---

### Task 10: web — `useLines` hook, `MarketLinesView`, nav swap

**Files:**
- Create: `web/src/hooks/useLines.ts`
- Create: `web/src/components/MarketLinesView.tsx`
- Modify: `web/src/components/BottomNav.tsx` (TABS + label + comment)
- Modify: `web/src/App.tsx` (route)
- Modify: `web/src/App.css` (append `.ml-*` styles)

- [ ] **Step 1: The hook** (clone of useLivePool's cadence pattern; lines move slowly — 8s):

```ts
// web/src/hooks/useLines.ts
/** Polls /api/lines (slate) and, when a fixture is focused, /api/lines/:id
 *  with this wallet — 8s cadence (odds tick ~45s server-side; money moves on
 *  every bet, and refresh() gives an instant re-read after your own tx). */
import { useCallback, useEffect, useState } from "react";
import {
  getLines, getLineDetail,
  type LineDto, type LineDetailResponse,
} from "../lib/api.ts";

const POLL_MS = 8000;

export function useLines(wallet: string | null, focusFixtureId: number | null) {
  const [lines, setLines] = useState<LineDto[] | null>(null);
  const [detail, setDetail] = useState<LineDetailResponse | null>(null);

  const refresh = useCallback(async () => {
    const slate = await getLines().catch(() => null);
    if (slate) setLines(slate.lines);
    if (focusFixtureId != null) {
      const d = await getLineDetail(focusFixtureId, wallet).catch(() => null);
      setDetail(d);
    } else {
      setDetail(null);
    }
  }, [wallet, focusFixtureId]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      await refresh();
      if (!alive) return;
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [refresh]);

  return { lines, detail, refresh };
}
```

- [ ] **Step 2: The view** — mockup 14 translated to app conventions (pure mapper drives everything; on-chain writes via the existing builders):

```tsx
// web/src/components/MarketLinesView.tsx
import { useMemo, useState } from "react";
import { useLines } from "../hooks/useLines.ts";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx, buildClaimTx } from "../lib/anchorClient.ts";
import { LINE_CLOSE_MARKET_ID } from "../lib/lineConstants.ts";
import {
  mapSlateRow, mapLineDetail, solText, LINE_STAKE_PRESETS,
} from "../lib/lines.ts";

/* Beat the Market — the day game (spec §1/§6, mockup 14).
 * Slate of today's lines → detail: sparkline vs the opening line, Above/Below
 * with preset stakes, live ahead/behind verdict, claim on settle/void.
 * REAL-MONEY: money numbers come from /api/lines (chain-read); odds from
 * TxLINE via the engine tracker. Missing odds render as "—", never invented. */
export function MarketLinesView() {
  const { address, signAndSend } = usePrivySigner();
  const [focus, setFocus] = useState<number | null>(null);
  const [stakeIdx, setStakeIdx] = useState(0);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState("");
  const { lines, detail, refresh } = useLines(address ?? null, focus);
  const nowMs = Date.now();

  const rows = useMemo(() => (lines ?? []).map((l) => mapSlateRow(l, nowMs)), [lines, nowMs]);
  const vm = useMemo(() => (detail ? mapLineDetail(detail, nowMs) : null), [detail, nowMs]);

  async function onBet(bucket: 0 | 1) {
    if (!address || focus == null || !vm?.canBet) return;
    setBusy("bet"); setFlash("");
    try {
      const tx = await buildPlaceBetTx(address, focus, LINE_CLOSE_MARKET_ID, bucket, LINE_STAKE_PRESETS[stakeIdx]);
      await signAndSend(tx);
      await refresh();
    } catch (e) { setFlash(e instanceof Error ? e.message : "Bet failed"); }
    finally { setBusy(""); }
  }

  async function onClaim() {
    if (!address || focus == null) return;
    setBusy("claim"); setFlash("");
    try {
      const tx = await buildClaimTx(address, focus, LINE_CLOSE_MARKET_ID);
      await signAndSend(tx);
      await refresh();
    } catch (e) { setFlash(e instanceof Error ? e.message : "Claim failed"); }
    finally { setBusy(""); }
  }

  // ── detail ──────────────────────────────────────────────────────────────
  if (focus != null && vm) {
    const spark = vm.spark;
    return (
      <div className="mlines">
        {flash && <div className="ml-flash">{flash}</div>}
        <button className="ml-back" onClick={() => setFocus(null)}>‹ Today's lines</button>

        <div className="ml-head">
          <div className="ml-title">{vm.row.title}</div>
          <div className="ml-ko">KO {vm.row.koLabel}</div>
        </div>

        <div className="ml-linecard">
          <div className="ml-lab">
            <span>Consensus line — {vm.row.favName} to win</span>
            <span className="ml-src">TxLINE StablePrice</span>
          </div>
          <div className="ml-bignum">
            <span className="ml-pct tnum">{vm.currentText}</span>
            {vm.deltaText && (
              <span className={`ml-delta tnum ${vm.deltaUp ? "up" : "down"}`}>{vm.deltaText}</span>
            )}
          </div>
          <Spark points={spark.points} openMilli={spark.openMilli} />
          <div className="ml-sparkcap"><span>open {vm.openText}</span><span>now</span></div>
        </div>

        <div className="ml-call">
          <div className="ml-q">Where does the line close at kick-off?</div>
          {vm.canBet && (
            <div className="ml-presets">
              {vm.presets.map((p, i) => (
                <button key={String(p)} className={`ml-preset${i === stakeIdx ? " sel" : ""}`}
                  onClick={() => setStakeIdx(i)}>{solText(p)}</button>
              ))}
            </div>
          )}
          <div className="ml-opts">
            {vm.options.map((o) => (
              <button key={o.bucket}
                className={`ml-opt${vm.myBucket === o.bucket ? " sel" : ""}`}
                disabled={!vm.canBet || !!busy}
                onClick={() => onBet(o.bucket)}>
                <span className={`ml-oc ${o.bucket === 0 ? "up" : "down"}`}>{o.bucket === 0 ? "▲" : "▼"}</span>
                <span className="ml-ot">{o.label}</span>
                <span className="ml-osub tnum">
                  {vm.canBet ? `win ≈ ${o.estWinTexts[stakeIdx]}` : o.sideTotalText}
                </span>
              </button>
            ))}
          </div>
          {vm.verdict && <div className={`ml-verdict ${vm.verdict.tone}`}>{vm.verdict.text}</div>}
          {vm.myBucket != null && !vm.verdict && vm.row.status === "open" && (
            <div className="ml-verdict idle">you're in — {vm.myStakeText} on {vm.myBucket === 0 ? "Above" : "Below"}</div>
          )}
          {vm.row.resultText && <div className="ml-verdict idle">{vm.row.resultText}</div>}
          {vm.claim && (
            <button className="ml-claim" onClick={onClaim} disabled={!!busy}>
              {busy === "claim" ? "Claiming…"
                : vm.claim.kind === "refund" ? `Claim refund ${solText(vm.claim.amountLamports)} ▸`
                : `Claim ${solText(vm.claim.amountLamports)} ▸`}
            </button>
          )}
        </div>

        <div className="ml-pot">
          <span>{vm.row.potText}</span>
          <span className="ml-boost">{vm.houseBoostText}</span>
        </div>
        {!address && <div className="ml-hint">log in to play</div>}
      </div>
    );
  }

  // ── slate ────────────────────────────────────────────────────────────────
  return (
    <div className="mlines">
      {flash && <div className="ml-flash">{flash}</div>}
      <div className="ml-hero">
        <div>
          <div className="ml-hero-lab">The day game</div>
          <div className="ml-hero-ttl">Beat the Market</div>
        </div>
        <div className="ml-hero-sub">call where the line<br />closes at kick-off</div>
      </div>
      {lines === null && <div className="ml-empty">loading lines…</div>}
      {lines !== null && rows.length === 0 && (
        <div className="ml-empty">No lines right now — they open as soon as the market prices a match.</div>
      )}
      {rows.map((r) => (
        <button key={r.fixtureId} className="ml-row" onClick={() => setFocus(r.fixtureId)}>
          <span className="ml-row-main">
            <span className="ml-row-title">{r.title}</span>
            <span className="ml-row-meta">
              {r.status === "open" ? `KO ${r.koLabel} · ${r.potText}` : r.resultText ?? r.status}
            </span>
          </span>
          <span className="ml-row-line">
            <span className={`ml-row-pct tnum${r.dirUp == null ? "" : r.dirUp ? " up" : " down"}`}>
              {r.pctText}{r.dirUp != null && <span className="ml-arrow">{r.dirUp ? "▲" : "▼"}</span>}
            </span>
            <span className="ml-row-fav">{r.favName} to win</span>
          </span>
        </button>
      ))}
      <div className="ml-hint">
        pick Above or Below the opening line · the right side splits the pot at kick-off ·
        odds by TxLINE StablePrice
      </div>
    </div>
  );
}

/** Honest sparkline: renders ONLY real series points + the open reference. */
function Spark({ points, openMilli }: { points: [number, number][]; openMilli: number }) {
  if (points.length < 2) return <div className="ml-spark-empty">not enough data yet</div>;
  const W = 340, H = 64;
  const vals = points.map((p) => p[1]).concat(openMilli);
  const lo = Math.min(...vals) - 500, hi = Math.max(...vals) + 500;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - 5 - ((v - lo) / (hi - lo)) * (H - 10);
  const last = points[points.length - 1][1];
  const up = last >= openMilli;
  return (
    <svg className="ml-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1={0} y1={y(openMilli)} x2={W} y2={y(openMilli)}
        stroke="currentColor" strokeDasharray="4 4" opacity={0.35} />
      <polyline
        points={points.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}
        fill="none" stroke={up ? "var(--ml-green, #3DE08A)" : "var(--ml-accent, #FF6A1A)"}
        strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={W} cy={y(last)} r={3.4} fill={up ? "var(--ml-green, #3DE08A)" : "var(--ml-accent, #FF6A1A)"} />
    </svg>
  );
}
```

Create `web/src/lib/lineConstants.ts` (the web bundle must not import engine sources):

```ts
/** Mirrors engine/src/markets.ts LINE_CLOSE_MARKET_ID (u8 in the market PDA seed). */
export const LINE_CLOSE_MARKET_ID = 90;
```

- [ ] **Step 3: Nav swap** — `web/src/components/BottomNav.tsx`:

```ts
const LABELS: Record<Tab, string> = { live: "Live", sweepstake: "Parlay", markets: "Market", bets: "My Bets", wallet: "Wallet" };
// Parlay (sweepstake) is hidden (not deleted) — SweepstakeView stays in App.tsx,
// just unrouted, and the daily-card create cron is paused (DAILY_CARD_CREATE=0).
// The markets slot returns as the Beat-the-Market day game.
const TABS: Tab[] = ["live", "markets", "bets", "wallet"];
```

`web/src/App.tsx` — import and route:

```tsx
import { MarketLinesView } from "./components/MarketLinesView.tsx";
// …
      {tab === "markets" && <MarketLinesView />}
```

(`MarketsTeaser` stays defined-but-unrouted; add `// hidden-not-deleted` above it.)

- [ ] **Step 4: Styles** — append to `web/src/App.css` (namespaced, follows the app's dark theme variables; adapt freely from `mockups/14-beat-the-market.html`):

```css
/* ── Beat the Market (Market tab) ─────────────────────────────────────────── */
.mlines { padding: 12px 4px 80px; }
.ml-flash { text-align: center; color: var(--accent-2, #FFB23E); font-weight: 700; font-size: 13px; margin-bottom: 8px; }
.ml-hero { display: flex; justify-content: space-between; align-items: center; background: linear-gradient(180deg,#1c160d,#100c07); border: 1px solid rgba(255,211,107,.22); border-radius: 15px; padding: 12px 14px; margin-bottom: 10px; }
.ml-hero-lab { font-size: 9px; letter-spacing: 1.4px; text-transform: uppercase; color: #5C6473; font-weight: 700; }
.ml-hero-ttl { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 19px; background: linear-gradient(180deg,#FFE9B4,#FFC24C); -webkit-background-clip: text; background-clip: text; color: transparent; }
.ml-hero-sub { text-align: right; font-size: 10.5px; color: #9AA2B1; line-height: 1.5; }
.ml-row { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 10px; text-align: left; background: #11141b; border: 1px solid rgba(255,255,255,.09); border-radius: 15px; padding: 12px; margin-top: 7px; color: inherit; cursor: pointer; font-family: inherit; }
.ml-row-title { display: block; font-weight: 700; font-size: 13.5px; }
.ml-row-meta { display: block; font-size: 10.5px; color: #5C6473; margin-top: 2px; }
.ml-row-line { text-align: right; }
.ml-row-pct { display: block; font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 17px; }
.ml-row-pct.up .ml-arrow { color: #3DE08A; } .ml-row-pct.down .ml-arrow { color: #FF3B3B; }
.ml-arrow { font-size: 11px; vertical-align: 2px; margin-left: 3px; }
.ml-row-fav { display: block; font-size: 9px; color: #5C6473; text-transform: uppercase; letter-spacing: .6px; }
.ml-back { background: none; border: 0; color: #9AA2B1; font-size: 13px; font-weight: 700; cursor: pointer; padding: 2px 6px 8px 0; font-family: inherit; }
.ml-head { display: flex; justify-content: space-between; align-items: baseline; }
.ml-title { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 18px; }
.ml-ko { font-size: 11px; color: #9AA2B1; }
.ml-linecard { background: #11141b; border: 1px solid rgba(255,255,255,.09); border-radius: 15px; padding: 12px 14px; margin-top: 9px; }
.ml-lab { display: flex; justify-content: space-between; font-size: 9px; letter-spacing: 1.2px; text-transform: uppercase; color: #5C6473; font-weight: 700; }
.ml-src { text-transform: none; letter-spacing: 0; font-weight: 500; }
.ml-bignum { display: flex; align-items: baseline; gap: 9px; margin-top: 5px; }
.ml-pct { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 36px; line-height: 1; background: linear-gradient(180deg,#FFE9B4,#FFC24C); -webkit-background-clip: text; background-clip: text; color: transparent; }
.ml-delta { font-size: 11px; font-weight: 800; border-radius: 999px; padding: 3px 9px; }
.ml-delta.up { background: rgba(61,224,138,.12); color: #3DE08A; }
.ml-delta.down { background: rgba(255,59,59,.12); color: #FF3B3B; }
.ml-spark { width: 100%; height: 64px; display: block; margin-top: 10px; color: #5C6473; }
.ml-spark-empty { height: 64px; display: flex; align-items: center; justify-content: center; color: #5C6473; font-size: 11px; }
.ml-sparkcap { display: flex; justify-content: space-between; font-size: 9.5px; color: #5C6473; margin-top: 4px; }
.ml-call { background: linear-gradient(180deg,#1a130b,#0d0b08); border: 1.5px solid rgba(255,106,26,.4); border-radius: 18px; padding: 14px; margin-top: 11px; }
.ml-q { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 16px; }
.ml-presets { display: flex; gap: 6px; margin-top: 10px; }
.ml-preset { background: #1c222d; border: 1px solid rgba(255,255,255,.09); color: #F4F6FA; border-radius: 999px; padding: 5px 12px; font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
.ml-preset.sel { border-color: #FF6A1A; background: rgba(255,106,26,.14); }
.ml-opts { display: flex; gap: 7px; margin-top: 11px; }
.ml-opt { flex: 1; background: #181d27; border: 1px solid rgba(255,255,255,.09); border-radius: 12px; padding: 11px 5px 10px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 3px; color: #F4F6FA; font-family: inherit; }
.ml-opt.sel { border-color: #FF6A1A; background: rgba(255,106,26,.14); }
.ml-opt:disabled { cursor: default; opacity: .75; }
.ml-oc { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800; color: #fff; }
.ml-oc.up { background: #2f7d4f; } .ml-oc.down { background: #8c2f3b; }
.ml-ot { font-size: 12.5px; font-weight: 700; }
.ml-osub { font-size: 9.5px; color: #FFD36B; font-weight: 600; }
.ml-verdict { margin-top: 10px; text-align: center; font-size: 12px; font-weight: 800; }
.ml-verdict.win { color: #3DE08A; } .ml-verdict.lose { color: #FF3B3B; } .ml-verdict.idle { color: #5C6473; font-weight: 600; }
.ml-claim { width: 100%; margin-top: 10px; background: linear-gradient(180deg,#FF9244,#FF6A1A); color: #0a0a0a; border: 0; border-radius: 13px; padding: 12px; font-weight: 800; font-size: 14px; cursor: pointer; font-family: inherit; }
.ml-pot { display: flex; justify-content: space-between; margin-top: 9px; font-size: 11.5px; color: #9AA2B1; padding: 0 4px; }
.ml-boost { color: #5C6473; }
.ml-empty { text-align: center; color: #5C6473; font-size: 12.5px; padding: 26px 12px; }
.ml-hint { text-align: center; font-size: 10.5px; color: #5C6473; margin-top: 13px; line-height: 1.6; }
```

- [ ] **Step 5: Build + full web suite**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/web && npx vitest run && npx tsc --noEmit 2>&1 | head -10 && npx vite build 2>&1 | tail -3`
Expected: tests PASS, no type errors, build succeeds

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/useLines.ts web/src/components/MarketLinesView.tsx web/src/lib/lineConstants.ts web/src/components/BottomNav.tsx web/src/App.tsx web/src/App.css
git commit -m "feat(web): Market tab — Beat the Market view; Parlay hidden (hidden-not-deleted)"
```

---

### Task 11: devnet end-to-end verification

**Files:** none (operational). Prereq: keeper wallet ≥ ◎1.5 (`solana balance -k ~/.config/solana/lazer-probe.json -u devnet`; top up per spec if low).

- [ ] **Step 1: Dry-run the keeper pass against the live feed**

Run: `cd /Users/yordanlasonov/Documents/GitHub/ProofBet/keeper && npx tsx lines.ts --dry-run`
Expected: ensure lists the odds-carrying fixtures (probe 2026-07-02 saw Spain v Austria 18179551, Portugal v Croatia 18179763, Switzerland v Algeria 18179552, Colombia v Ghana 18179549) with `open XX.X% on <team> (dry-run)`; no signatures.

- [ ] **Step 2: Create + seed for real (one fixture first)**

Run: `npx tsx lines.ts --fixture 18179551`
Expected: `+ … open …` then `⬒ … seeding 0.05◎ per side`. Re-run the same command — expected: `= … market exists` and NO second seed (totals guard).

- [ ] **Step 3: Engine serves it**

Run: `cd ../engine && npx tsx src/server.ts` (or the deployed instance), then `curl -s localhost:8787/api/lines | head -c 600`
Expected: one line object: `"fixtureId":18179551`, `"openMilli":…`, `"potLamports":"100000000"`, `current` non-null within ~1 min of the tracker's first poll.

- [ ] **Step 4: Web flow with a test wallet**

Start web (`cd ../web && npx vite`), open the **Market** tab: slate shows the line; detail shows sparkline + open reference; place ◎0.01 on a side; "you're in" + verdict line appears; pot grows by 0.01. Confirm the **Parlay tab is gone** and Live/My Bets/Wallet still work.

- [ ] **Step 5: Settle after kick-off (Spain v Austria KOs 19:00Z)**

Run: `cd ../keeper && npx tsx lines.ts --fixture 18179551 --dry-run` → expect `✓ … close … → ABOVE/BELOW wins (dry-run)` (or `∅ VOID`), then without `--dry-run` to settle + sweep. Verify: web detail shows the result + Claim; claim pays; `curl /api/lines` shows `status:"settled"`, `settledValueMilli` set; keeper log shows `$ … claiming keeper seed share`.

- [ ] **Step 6: Start the full cron and watch one cycle**

Run: `DAILY_CARD_CREATE=0 npx tsx cron.ts --dry-run`
Expected boot log: `daily-card create PAUSED` + settle/live/schedule/lines job lines; lines pass output every 5 min.

- [ ] **Step 7: Commit any fixups + update memory**

```bash
git add -A && git commit -m "chore: beat-the-market e2e fixups"
```

Update `~/.claude` memory (`streak-daily-card-pivot` → note the card is paused + Parlay hidden; new memory for Beat the Market: market_id 90 semantics, stat_key=favSide, threshold=open milli-pct, odds endpoints, seed flow).

---

## Self-review checklist (run after writing, fixed inline)

- **Spec coverage:** §1 stakes/seeding/nav (Tasks 9/4/10) · §2 rules (Tasks 1/3) · §3 mapping (Tasks 2/4) · §4 keeper (Tasks 4/5) · §5 engine (Tasks 6/7/8) · §6 web (Tasks 9/10) · §7 testing (every task + Task 11) · §9 config (Tasks 4/5/7/8).
- **Type consistency:** `OddsRow` (Task 1) is the single row type imported by Tasks 3/7; `LineMarketView` (Task 6) feeds Task 8's DTO; web `LineDto` (Task 9) mirrors Task 8's `lineDto()` field-for-field; `LINE_CLOSE_MARKET_ID` defined once in engine + mirrored as a documented constant for the web bundle.
- **Known judgment calls:** settle reads `updates` not `snapshot` (in-running rows can displace the pre-match row in a latest-per-tuple snapshot); web mirrors the market id constant rather than importing engine source into the Vite bundle; `sideLabel` test falls back to exporting the helper if unreachable through the public API.
