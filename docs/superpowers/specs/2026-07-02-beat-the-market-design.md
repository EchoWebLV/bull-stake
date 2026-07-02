# Streak — Beat the Market (day game) — Design Spec

**Date:** 2026-07-02
**Branch:** feat/streak-pivot
**Status:** approved (design converged over mockup `mockups/14-beat-the-market.html`)

**Goal:** Add the **day game** — one 2-bucket parimutuel line market per eligible fixture: will the market's confidence in the favourite **close above or below the opening line** at kick-off? Fills the dead hours between matches with a real-money game driven by TxLINE **StablePrice** consensus odds (verified live on devnet 2026-07-02). The Parlay tab is hidden (hidden-not-deleted) and the daily-card create cron is paused; the new **Market** tab hosts the game.

**Architecture:** Zero on-chain changes. Reuse the existing parimutuel `Market` program (`initialize_market` / `place_bet` / `settle` / `void_market` / `claim`) with a new catalog id. New: a StablePrice odds client (spike), a keeper `lines.ts` job (ensure → seed → settle), an engine odds tracker + `/api/lines` endpoints, and a `MarketLinesView` web tab built from mockup 14.

**Tech Stack:** unchanged — Anchor 0.31 (deployed, untouched) · Fastify + TypeScript engine · React + Vite + Privy web · TxLINE REST (devnet). Devnet SOL.

---

## 1. Product model

- **One line market per eligible fixture.** The question: *"Does the favourite's consensus win probability close ABOVE or BELOW the opening line at kick-off?"* Bucket **0 = Above**, **1 = Below**.
- **Stakes:** UI presets **◎0.01 / ◎0.05 / ◎0.10** (program accepts any stake — presets are a UI concern only). Payout is the existing pro-rata parimutuel math: winning bucket splits the pot by stake share; fee comes from the losing side only; **`fee_bps = 0`** for now (rake is a later flip, program already supports it).
- **Seeding (house boost):** the keeper seeds **◎0.05 per side** at creation so the first player always sees a live pot and a real counterparty. Disclosed in the UI ("pot includes ◎0.10 house boost"), never dressed up as players. Economics: balanced flow returns the seed; worst case per market is bounded by the seed.
- **Void = refund** (existing paths): exact tie at settle, stale/missing odds at kick-off, or a zero-stake winning bucket (settle's built-in zero-winner void).
- **Betting window:** market creation → kick-off (`entry_close_ts` = fixture `StartTime`).
- **Navigation:** `sweepstake` (Parlay) leaves `TABS` — component and routes stay in the codebase (hidden-not-deleted, same convention as Markets was). The existing `markets` tab id returns, labeled **"Market"**, routed to the new `MarketLinesView`. `MarketsTeaser` stays exported but unrouted.
- **Daily card:** create is paused via `DAILY_CARD_CREATE=0` (cron skips the 08:00Z create-daily-card spawn). The settle-contest loop keeps running — already-open contests must still settle. One env flip re-enables the card.

## 2. The line — exact data semantics (TxLINE, probe-verified 2026-07-02)

Confirmed live on `https://txline-dev.txodds.com` with the existing spike auth (guest JWT + API token):

- `GET /api/odds/snapshot/{fixtureId}` → latest row per (SuperOddsType, MarketPeriod, MarketParameters). 4/15 devnet fixtures currently carry odds.
- `GET /api/odds/updates/{fixtureId}` → full history (11,836 rows observed for one fixture) — powers the sparkline and proves a real time series exists.

**Row shape (verified):** `Bookmaker: "TXLineStablePriceDemargined"` (`BookmakerId: 10021`), `SuperOddsType: "1X2_PARTICIPANT_RESULT"`, `MarketPeriod: null` = full game (`"half=1"` rows exist and MUST be filtered out), `InRunning: false` = pre-match (in-running rows MUST be excluded from open/close), `PriceNames: ["part1","draw","part2"]`, `Prices`: integer milli-odds (1838 = 1.838), `Pct`: de-margined implied probabilities as strings, summing to 100.

**The LINE row filter (all conditions):** `SuperOddsType === "1X2_PARTICIPANT_RESULT"` ∧ `MarketPeriod == null` ∧ `InRunning === false` ∧ `BookmakerId === 10021`.

**Derived values (milli-percent integers, `round(parseFloat(Pct[i]) * 1000)`):**

- **Favourite:** `argmax(Pct[part1], Pct[part2])` at creation — a *team*, never the draw; exact tie → `part1`. Fixed for the market's life.
- **Open:** the favourite's milli-percent from a line row whose `Ts` is within `LINES_OPEN_FRESH_MIN` (60) minutes of creation. No fresh row → skip the fixture this pass (retry next tick).
- **Close:** the favourite's milli-percent from the **latest** line row with `Ts ≤ StartTime`. Validity: that row's `Ts ≥ StartTime − LINES_STALE_MAX_MIN` (30) minutes, else **void**.
- **Resolution:** `close > open` → Above (0) wins · `close < open` → Below (1) wins · `close === open` → **void**.

Nothing is interpolated, averaged, or invented. If TxLINE doesn't say it, the market voids or is never created.

## 3. On-chain mapping (no program changes, no redeploy)

- **Catalog:** new entry in `engine/src/markets.ts` — **`market_id 90 · LINE_CLOSE`**, `num_buckets 2`, bucket labels Above/Below. Stat-machinery fields are explicit sentinels (`stat_key 0`, `op 0`, `comparison 0`) — documented as unused for this market type.
- **`threshold` (i32) = open** (milli-percent) — written at `initialize_market`, making every line market **self-describing on-chain** and the keeper restart-safe with no local state.
- **PDA** `[b"market", fixture_id, market_id=90]` → at most one line per fixture; creation is idempotent (PDA exists → no-op).
- **Settle:** existing `settle(winning_bucket, settled_seq = 0, settled_ts = closeRow.Ts/1000, settled_value = close)`. `settled_seq` is unused for LINE_CLOSE (documented). Open + close + timestamp = complete on-chain audit trail.
- **Void:** existing `void_market` for tie/stale; settle's zero-winner path auto-voids when the winning bucket holds no stake.
- **Trust model:** keeper-authority settlement — identical to the rest of the product. Documented upgrade path (out of scope): validate TxLINE's cryptographic odds proofs at settle.

## 4. Keeper — `lines.ts` (new CLI) + cron integration

Single invocation runs three idempotent passes; safe to re-run or crash at any point because all money state lives on-chain:

1. **ENSURE** — fixtures with kick-off in `(now, now + LINES_HORIZON_H(24)]` and a fresh line row and `KO ≥ now + LINES_MIN_LEAD_MIN(30)`: `initializeMarket(fixtureId, 90, …, threshold = open)` unless the PDA exists. (Creation happens as soon as odds appear inside the horizon — no fixed T-minus; more open time = more play.)
2. **SEED** — line markets with status Open and **both bucket totals exactly 0**: `placeBet(0, seed)` + `placeBet(1, seed)`, `seed = LINES_SEED_SOL(0.05)`. The zero-totals guard makes double-seeding impossible. Keeper balance below budget → skip pass with a loud log.
3. **SETTLE** — line markets with status Open and `now ≥ StartTime + LINES_SETTLE_BUFFER_MIN(2)`: compute close per §2 → `settle` or `void_market`. Per-market try/catch; failures log and retry on the next tick.

**CLI:** `npx tsx lines.ts [--dry-run] [--fixture=<id>]` — dry-run prints every decision (create/seed/settle/void + values) with no transactions, same convention as `create-daily-card.ts`.

**cron.ts:** new LINES job spawning `lines.ts` every `LINES_INTERVAL_MIN(5)` minutes, alongside the existing settle loop; `DAILY_CARD_CREATE=0` (default `1`) skips the 08:00Z card create spawn. The stale "devnet has no pre-match odds" comment in `create-daily-card.ts` gets corrected in passing.

## 5. Engine

- **`engine/src/lines.ts` — LinesTracker.** Discovers line markets via the existing program-account scan filtered to `market_id 90` and `entry_close_ts` within ±36h. Per active fixture: poll `snapshot` every `LINES_POLL_SECS(45)`, append `(ts, pctMilli)` when changed; on first sight of a fixture, one-time `updates` fetch seeds history. Series downsampled to ≤1 point/min, ring-capped at 720 points (12h). 429/backoff handling follows the existing ER-read micro-cache precedent.
- **`GET /api/lines`** → `{ lines: [{ fixtureId, home, away, kickoffMs, marketPk, status: "open"|"settled"|"voided", favourite: "home"|"away", openMilli, current: { pctMilli, ts } | null, potLamports, bucketTotals: [string, string], houseBoostLamports, winningBucket?, settledValueMilli?, settledTs? }] }`. Money numbers from the chain; odds numbers from the tracker with real timestamps; `current: null` when the tracker has nothing — never a made-up value.
- **`GET /api/lines/:fixtureId`** → the same line object + `series: [ts, pctMilli][]`.
- **My positions:** reuse the existing `/api/history` wallet read (generic over markets). If it allow-lists market ids, add 90.
- **Tests:** `routes.test.ts` style with a fake tracker + fake chain — shape assertions for open/settled/voided, absent-odds honesty (`current: null`, no line for odds-less fixtures).

## 6. Web

- **BottomNav:** `TABS = ["live", "markets", "bets", "wallet"]`; `LABELS.markets = "Market"` (pulse icon already exists). `sweepstake` stays in the type/ICONS/LABELS with the hidden-not-deleted comment updated.
- **App.tsx:** `tab === "markets"` → `<MarketLinesView />`. `SweepstakeView` and `MarketsTeaser` remain in the tree, unrouted.
- **`web/src/lib/lines.ts` — pure mapper** (same contract as `liveGame.ts`: pure function of server payload + wallet + nowMs → render view-model; no RNG, no invented values, "—" where data is missing). Covers: slate rows (current pct + direction vs open, pot, counts, status chip), detail (sparkline points from `series`, open reference, delta), my-position verdict (ahead/behind by side vs open), est-win pro-rata `myStake / bucketTotal × pot` (fee 0), settled/void outcomes.
- **`MarketLinesView.tsx`:** mockup 14 adapted to app classes (`.ml-*` in App.css): slate → detail → Above/Below with preset chips → locked position with live ahead/behind → settled claim. Bets via existing `buildPlaceBetTx(bucket, lamports)` + `usePrivySigner`; claims via the existing claim builder. House boost labeled from `houseBoostLamports`.
- **Tests:** `web/test/lib.test.ts` style on the mapper — ahead/behind on both sides, tie display, settled won/lost/void, est-win math, empty-series and no-odds honesty.

## 7. Testing & verification

- **Unit:** keeper `resolveLine(rows, startTime)` pure function — above / below / tie→void / stale→void / in-running excluded / half-period excluded / missing→skip; seed idempotency guard; engine endpoint shapes; web mapper cases.
- **Integration (devnet):** `lines.ts --dry-run` against the live feed; real run against the odds-carrying fixtures (Spain v Austria KO 19:00Z today; Colombia v Ghana 07-04); two test wallets bet opposite sides; settle at KO; claim on both won and void paths; `BetsView` shows the position.
- **Regression:** live game untouched (only nav/route lines change in shared files).

## 8. Out of scope (explicit)

Odds-proof CPI validation · SSE streaming (45s polling suffices) · Over/Under line variants · mainnet · any `LivePool`/program change · deleting Parlay code (hide + cron flag only).

## 9. Config (all env, keeper/engine `.env`)

| Key | Default | Meaning |
|---|---|---|
| `LINES_HORIZON_H` | 24 | create markets for KOs within this window |
| `LINES_MIN_LEAD_MIN` | 30 | don't create closer than this to KO |
| `LINES_OPEN_FRESH_MIN` | 60 | max age of the row used as the open |
| `LINES_STALE_MAX_MIN` | 30 | close row older than this before KO → void |
| `LINES_SEED_SOL` | 0.05 | house seed per side |
| `LINES_SETTLE_BUFFER_MIN` | 2 | settle no earlier than KO + this |
| `LINES_INTERVAL_MIN` | 5 | keeper lines pass cadence |
| `LINES_POLL_SECS` | 45 | engine snapshot poll cadence |
| `DAILY_CARD_CREATE` | 1 | 0 pauses the daily-card create spawn |

## 10. Rollout order

1. Spike odds client (typed snapshot/updates + line-row filter) — unit tests.
2. Keeper `lines.ts` + `resolveLine` + cron flag — dry-run on devnet.
3. Engine tracker + endpoints — tests, then live behind the running engine.
4. Web tab (mapper → view → nav swap) — mapper tests, manual flow on devnet.
5. End-to-end on a real fixture (Spain v Austria if same-day, else Colombia v Ghana 07-04).
