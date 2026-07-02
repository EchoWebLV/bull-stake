# Live "Next Game" Countdown + Pool Auto-Scheduler — Design

**Date:** 2026-07-02 · **Branch:** feat/streak-pivot · **Status:** approved (user: "Full: scheduler + timer", join window = 45 min)

## Problem

The Live tab's idle state is "No live game right now" — dead air. Live pools are only
created by hand (`keeper/create-match-pool.ts <fixtureId>:<kickoffISO>`), so in
practice no game is ever lined up. The web also pins the first fixture it discovers
forever (finding #5).

## Goal

Games line up themselves and the Live tab always shows the next thing to care about:

1. **Keeper auto-scheduler** — a pool exists for every upcoming allowlisted fixture,
   created **45 minutes before kickoff** (the join window; on-chain `lock_ts` =
   kickoff closes joins).
2. **Engine `GET /api/live/next`** — the ONE game the home tab should feature.
3. **Web big countdown** — giant timer to kickoff, join button once the pool exists,
   the existing live game once it kicks off.

No program change. No redeploy. Real money only (devnet SOL) — no demo states.

## 1. Keeper — `schedule-pools.ts` + cron job

New CLI, same shape as `create-daily-card.ts` (idempotent single pass; cron spawns it).

Pass logic (pure core, injected seams for tests):

```
fixtures = upcoming allowlisted slate (TxLINE getFixtures, COMPETITION_ALLOWLIST)
for each fixture f, earliest kickoff first:
  skip unless now ∈ [kickoffMs − JOIN_AHEAD_MIN·60_000, kickoffMs)   // 45-min window; never post-kickoff
  skip if livePoolPda(f.fixtureId) already exists on-chain            // idempotent
  createMatchPool(f.fixtureId, kickoff)                               // existing helper:
      // pool_id == fixtureId, entry 0.035◎, lock_ts = kickoff,
      // settle_after = +3h, 8 preallocated calls
```

- `JOIN_AHEAD_MIN` env, default **45**.
- Overlapping fixtures each get their own pool (the engine picks which to feature).
- A fixture whose window was missed entirely (keeper down past kickoff) is skipped —
  joins would be closed on-chain anyway; no rent wasted.
- Cron: third job in `keeper/cron.ts`, every 5 min (`SCHEDULE_INTERVAL_SEC`, default
  300), same spawn-a-CLI pattern and crash isolation as the daily-card job.

## 2. Engine — `GET /api/live/next`

Returns the featured game, picked in priority order (`now` = server clock):

1. **In-play pool** — status `open`, `lockTs ≤ now < settleAfterTs`; earliest `lockTs`
   wins. (A playing pool's on-chain status stays `open`; in-play is a time fact.)
2. **Joinable pool** — status `open`, `now < lockTs`; earliest `lockTs`.
3. **Upcoming fixture, no pool yet** — earliest `status:"upcoming"` row from the live
   board; `pool: null`, countdown only.
4. **Nothing scheduled** — `{ pool: null, match: null, kickoffMs: null }`.

Response is a superset of `/api/live/pool` (same assembly, one shared helper):

```
{ pool, openCall, lastCall, standings, match,      // as /api/live/pool (null/[] where n/a)
  kickoffMs,                                        // fixture kickoff (ms) or null
  joinOpensTs }                                     // kickoffSec − 45·60, or null
```

Terminal pools (settled/rolledOver/voided/ended) are never featured — the next game
takes over; entrants still see their over-card via the pool data while it is featured
pre-terminal, and claims live in the wallet flow.

This endpoint replaces web-side discovery and closes **#5** (fixture pinning): the web
re-asks "what's next" every poll.

## 3. Web — countdown states on the Live tab

- `api.ts`: `NextGameResponse = LivePoolResponse & { kickoffMs: number|null;
  joinOpensTs: number|null }`; `getNextGame()`.
- `useLivePool` now polls `/api/live/next` (no more `getMatches()` discovery, no
  pinned fixture) and exposes `kickoffMs`/`joinOpensTs`. Poll: 5s idle / 2s in-play.
- `liveGame.ts`: pure `formatCountdown(msLeft)` → `"02:14:33"` under 24h, `"3d 04h"`
  above; `preGameFromChain(...)` state helper.
- `LiveMatchView` render branches:
  - **nothing scheduled** → honest empty state (unchanged copy).
  - **upcoming, no pool** (`pool null`, `kickoffMs` set) → big timer: team names,
    kickoff time, giant countdown, "Join opens 45 min before kick-off".
  - **joinable** (`pool.status open`, `now < lockTs`) → big timer + pot/players +
    the real **Join ◎0.035** button (existing base-layer flow, wallet modal).
  - **in-play / terminal** → the existing live game UI, untouched.
- CSS: `.lg-pre*` styles inside the existing (uncommitted) `.livegame` block — giant
  mono timer, muted meta line.

## 4. Testing

- **Keeper** (hermetic): creates inside the window; skips existing pool / outside
  window / post-kickoff; idempotent re-run creates nothing; cron wiring fires on its
  own clock.
- **Engine**: route tests for all four pick states + priority (in-play beats joinable
  beats fixture-only) + `joinOpensTs` math.
- **Web**: `formatCountdown` formatting; state selection (upcoming vs joinable vs
  live) snapshot tests.

## Out of scope

Devnet dry-run (separate task, owed for P0 #1/#2 as well); mainnet key-split
hardening; multi-game browsing UI (one featured game only).
