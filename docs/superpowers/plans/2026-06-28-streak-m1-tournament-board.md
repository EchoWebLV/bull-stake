# Streak M1 — Full-Tournament Auto-Market Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Builds on M0 ([2026-06-28-streak-m0-walking-skeleton.md](2026-06-28-streak-m0-walking-skeleton.md)); reuses all M0 modules + patterns. Steps use `- [ ]`.

**Goal:** Turn the single-fixture skeleton into a live tournament board — auto-create a full market set for each upcoming World Cup fixture, poll live corners/goals/cards during matches, and settle every market in two waves (half-time + full-time).

**Architecture:** Extend the engine: a shared **market template**, **auth-token caching** (stop the ~0.2 SOL/run re-subscribe), a **market-catalog** cron that creates the 8-market set per WC fixture, a **live poller** that refreshes in-progress fixtures, new list endpoints (`/api/matches`, `/api/markets`), a **Live-tab** frontend listing matches→markets, and a **multi-market keeper** that settles 1H markets at HT and the rest at FT. Data source = polling the proven snapshot/`getScoreHistory` path (no SSE yet). Reality: TxLINE WC has ~5–10 fixtures/day; live ticking happens only during match windows.

**Tech stack:** unchanged from M0 (Fastify/tsx/vitest engine, Vite/React/Privy web, Anchor program reused as-is). Postgres deferred — catalog state derived on-chain + a small JSON.

---

## The market template (shared spec)

8 binary parimutuel markets per fixture, `market_id` 0–7. All predicates are TxLINE-provable. Period-encoded stat keys: full-game base, `+1000` = 1st half.

```ts
// engine/src/markets.ts
export type Op = "add" | "subtract" | null;
export type Cmp = "greaterThan" | "lessThan" | "equalTo";
export interface MarketDef {
  marketId: number; label: string; group: "corners"|"goals"|"result"|"cards";
  line: number; statKey: number; statKey2: number | null; op: Op;
  comparison: Cmp; threshold: number; settleAt: "HT" | "FT";
}
export const MARKET_TEMPLATE: MarketDef[] = [
  { marketId:0, label:"Total Corners O/U 9.5",   group:"corners", line:9.5, statKey:7,    statKey2:8,    op:"add",      comparison:"greaterThan", threshold:9, settleAt:"FT" },
  { marketId:1, label:"Total Goals O/U 2.5",     group:"goals",   line:2.5, statKey:1,    statKey2:2,    op:"add",      comparison:"greaterThan", threshold:2, settleAt:"FT" },
  { marketId:2, label:"Home Win",                group:"result",  line:0,   statKey:1,    statKey2:2,    op:"subtract", comparison:"greaterThan", threshold:0, settleAt:"FT" },
  { marketId:3, label:"Draw",                    group:"result",  line:0,   statKey:1,    statKey2:2,    op:"subtract", comparison:"equalTo",     threshold:0, settleAt:"FT" },
  { marketId:4, label:"Away Win",                group:"result",  line:0,   statKey:1,    statKey2:2,    op:"subtract", comparison:"lessThan",    threshold:0, settleAt:"FT" },
  { marketId:5, label:"Total Yellow Cards O/U 3.5", group:"cards", line:3.5, statKey:3,   statKey2:4,    op:"add",      comparison:"greaterThan", threshold:3, settleAt:"FT" },
  { marketId:6, label:"1st-Half Corners O/U 4.5", group:"corners", line:4.5, statKey:1007, statKey2:1008, op:"add",     comparison:"greaterThan", threshold:4, settleAt:"HT" },
  { marketId:7, label:"1st-Half Goals O/U 0.5",  group:"goals",   line:0.5, statKey:1001, statKey2:1002, op:"add",      comparison:"greaterThan", threshold:0, settleAt:"HT" },
];
```

The on-chain market stores the predicate, so the keeper reads it back; the template's `settleAt` tells the keeper which markets to settle at half-time. The web/engine use it for labels + grouping.

---

## Tasks

### Task 1 — Auth-token caching (stop the per-run re-subscribe)
**Files:** Create `spike/src/auth-cache.ts`; Modify callers (`keeper/settle.ts`, new engine scripts) to use it.
- `authenticateCached(ctx, cachePath = ".txline-auth.json"): Promise<Auth>` — read `{wallet, jwt, apiToken, createdAt}`; if `wallet === ctx.wallet.publicKey` and `Date.now() - createdAt < 21 days`, validate with one cheap authed call (`getFixtures` snapshot, catch 401) and **reuse** (no subscribe); else run `authenticate(ctx)` and write the cache file (gitignored).
- TDD: unit-test the freshness/wallet-match decision with a fake clock + fake authenticate; integration verify the keeper settles without a new `subscribe` tx when cache is warm.
- Backfill `keeper/settle.ts`, `engine/scripts/*` to call `authenticateCached`.

### Task 2 — `engine/src/markets.ts` template + predicate→Anchor-args helper
**Files:** Create `engine/src/markets.ts`, `engine/test/markets.test.ts`.
- Export `MARKET_TEMPLATE` (above) + `toInitArgs(def, settleAuthority, entryCloseTs)` returning the exact `initializeMarket` args object ({ op:{add:{}}|..., comparison:{greaterThan:{}}|..., statKey2, threshold, ... }).
- TDD: assert each def maps to the right Anchor enum shape; assert 8 unique marketIds.

### Task 3 — `market-catalog` (auto-create the slate)
**Files:** Create `engine/src/catalog.ts`, `engine/scripts/run-catalog.ts`, `engine/test/catalog.test.ts`.
- `fetchSlate(ctx, auth, {hoursAhead=36})`: `getFixtures` for the WC competition for epochDays [today, +1], keep fixtures kicking off in `(now, now+hoursAhead)` (upcoming, still bettable). Return `{fixtureId, home, away, kickoffMs, competitionId}[]`.
- `ensureMarkets(ctx, program, fixture)`: for each `MARKET_TEMPLATE` def, derive the market PDA; if the account doesn't exist, `initializeMarket(fixtureId, def.marketId, toInitArgs(def, operator, kickoffSec))`. Idempotent (skip existing). `entry_close_ts = kickoffMs/1000`.
- `run-catalog.ts`: `authenticateCached` → `fetchSlate` → `ensureMarkets` for each → print summary. Designed to run on a cron (every ~30 min) or manually.
- TDD: unit-test the slate window filter + the "skip existing" branch (mock account fetch).

### Task 4 — Live poller + list endpoints
**Files:** Create `engine/src/live.ts`; Modify `engine/src/routes.ts`, `engine/src/server.ts`.
- `LiveStore`: holds the current slate (fixtures + their on-chain markets). A background loop every ~8s: for each fixture whose kickoff has passed and isn't final, `getScoreHistory` → latest corners/goals/yellows/phase/score; for every fixture, read its markets' on-chain `bucketTotals` and compute pool-implied odds. Cache in memory.
- `GET /api/matches` → `[{fixtureId, home, away, kickoffMs, status:"live"|"upcoming"|"ft", minute, phase, scoreH, scoreA, corners, goals, yellows}]`.
- `GET /api/markets?fixtureId=` → that fixture's 8 markets `[{marketId, label, group, line, status, bucketTotals, impliedOdds:{over,under}, winningBucket}]`.
- Keep M0 `/api/market` + `/api/match` working (back-compat) or remove once the web migrates.
- TDD: route tests with a mocked `LiveStore` (status classification, odds shape). Live polling verified manually against a finished fixture + the 19:00 live match.

### Task 5 — Frontend Live tab (list → match → markets)
**Files:** Create `web/src/lib/api.ts` additions, `web/src/components/MatchList.tsx`, `web/src/components/MatchRow.tsx`, `web/src/components/MarketList.tsx`; Modify `web/src/App.tsx`.
- `App`: fetch `/api/matches` (poll 5s) → render a list sorted live→upcoming→ft, each row showing teams, minute/phase, live corners·goals·cards. Tap a row → expand its markets (`/api/markets?fixtureId=`) grouped by `group`, each with Over/Under pool-implied odds + a bet slip (reuse the M0 `buildPlaceBetTx` with the row's `fixtureId` + the market's `marketId`) and Claim when settled.
- Reuse `usePrivySigner`, `anchorClient`, `odds`. Keep the Streak palette.
- Verify in the preview browser against the live engine.

### Task 6 — Multi-market keeper (two-wave settlement)
**Files:** Modify/extend `keeper/settle.ts` → add `keeper/settle-all.ts`.
- `settle-all.ts`: `authenticateCached` once; load the slate's fixtures + their markets; for each fixture, resolve phase via `getScoreHistory` (`isH1Final` / `FINISHED_PHASES` / `VOID_PHASES`). For markets with `settleAt:"HT"` once H1 is final, and `settleAt:"FT"` once the match is final: run the existing proof→`validateStat`→`settle` path (reusing `keeper/settle.ts` internals) per market; `void_market` on abandoned fixtures. Skip already-settled/closed markets. One auth for the whole batch.
- Designed for a cron (every ~5 min). TDD where pure (phase→which-markets-to-settle); live-verify against the 19:00 match (1H markets at HT, rest at FT).

### Task 7 — Cron wiring + ops
**Files:** `engine/DEMO.md` update; document the two cron loops (catalog every 30m, settle-all every 5m) for local + Railway. For the local demo, a `npm run catalog` + a watch loop.

---

## Cost & cadence notes
- Market creation: ~0.002 SOL each → 8×5 = ~0.08 SOL/day. Fine.
- With auth caching (Task 1), catalog + keeper stop paying ~0.2 SOL/run. Without it, a 30-min catalog cron alone burns ~10 SOL/day — Task 1 is a hard prerequisite for the crons.
- `settle-all` authenticates once per run regardless of market count.

## Demo reality
Live corners/goals only tick during real match windows (next: South Africa v Canada, 06-28 19:00 UTC). Between matches the board shows upcoming (bettable) + recently-settled markets. The deterministic single-fixture replay (M0) stays available as a fallback "always-live" demo via the old `/api/match` if needed.

## Self-review
- Every market in the template is provable (goals/cards/corners only; no shots/possession/BTTS). ✅
- Two-wave settlement matches design §6. ✅
- Auth caching removes the cron cost blocker. ✅
- Frontend migrates from single card → list without changing the on-chain tx path (same `buildPlaceBetTx`). ✅
