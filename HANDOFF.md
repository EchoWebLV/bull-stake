# Streak / Pearly — Session Handoff (2026-07-03 ~21:30 UTC)

> For the next AI session. Everything below is verified against the running stack
> and devnet as of the timestamp above. Branch: `feat/streak-pivot`. Do NOT merge
> to main without the user. Real-money framing only — never propose demo/paper/
> free-to-play. All subagents on model **fable** (Fable 5). Railway-only deploys
> (never mention Vercel). UI copy = multiplier framing (banned words: "weight",
> "2^", "mask", "active legs", "perfect_weight").

---

## TL;DR

The **TxODDS World Cup hackathon** submission (Consumer & Fan Experiences track;
deadline **2026-07-19 23:59 UTC**; 1st = 10k USDT) is **built and live on devnet**.
Two modes: **⚡ Live** (existing per-match ER game, unchanged this cycle) and
**🃏 Daily Pearly** (new all-day 6-leg survival card). The user is testing the
Pearly through localhost right now and hit a `CardLocked` simulation error — **that
error is the anti-buy-back edit-freeze working exactly as designed, not a bug**
(full diagnosis below). The chain, engine, keeper, and web are all healthy.

## Running stack (all verified up)

| Piece | How | Port / PID | State |
|---|---|---|---|
| Engine (Fastify, `tsx watch`) | `engine/` `npm run dev` | `:8787` · PID 63121 | v2, serving live `/api/card` from devnet. (It doesn't log GET requests — don't read "no log lines" as "dead".) |
| Web (Vite) | `web/` `npm run dev -- --port 5180 --strictPort` | `:5180` · PID 53774 | Pearly tab live. `web/.env` → `VITE_ENGINE_URL=http://localhost:8787` ✅ |
| Cron (keeper) | `keeper/` `tsx cron.ts` | PID 63173 | `DAILY_CARD_CREATE=0 POOL_SCHEDULE=0 PEARLY_CREATE=1` — auto-composes the next card at **08:00 UTC**. |

Logs: `/private/tmp/claude-501/-Users-yordanlasonov-Documents-GitHub-ProofBet/4a7b6589-5a98-4175-8c86-a85f8a4943d4/scratchpad/{engine-v3,cron-v3}.log`
(that scratchpad path belongs to the ORIGIN session — a fresh session gets its own
scratchpad, so re-point logs if you restart anything).

## On-chain facts

- **Program id:** `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ` (Anchor 0.31, redeployed
  **in place** — same id, v3 layout). Account sizes: **Contest 281**, **Entry 103**.
  Old-size accounts (v1 217 / 207) decode to garbage → engine size-filters every
  program-account scan (`CONTEST_SIZE=281`, `dataSize` filter in `engine/src/chain.ts`).
- **Upgrade authority:** `FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM` =
  `~/.config/solana/lazer-probe.json` (NOT `Anchor.toml`'s id.json). Redeploy with
  `--provider.wallet ~/.config/solana/lazer-probe.json`. Buffer rent (~5.16 SOL)
  refunds after a successful upgrade.
- **Tonight's live card:** contest **777020637** (PDA
  `7KXmBHkfKkt5UZYn64BH8ZYaycuJDuhb2q4Xkdogz8Lk`). 6 legs across 3 fixtures + 1 chaos
  leg. Entry ◎0.05. Jackpot ◎0.02 carried over from the prior rolled contest.
  - Legs / locks (UTC): Australia–Egypt result **18:00** (now FT 1–1), Argentina–Cape
    Verde result + O/U 2.5 **22:00**, Colombia–Ghana result **01:30 (07-04)**, chaos
    Red-Card Y/N on Argentina.
  - **entriesClose 22:00 UTC (07-03)** · **settleAfter 03:30 UTC (07-04)**.
- **User's wallet:** `J7yZbEoQW6gqapBnKH9r5NZdus3j1t8j3vmrGUGxzxu7` (their Privy devnet
  wallet; the only entry on this contest). They hold a **live, perfect ×64 card** —
  entered **15:26 UTC** carrying all 6 legs. `curl "localhost:8787/api/card?wallet=J7yZ…"`
  returns `myCard:{ picks:[2,0,2,1,0,1], weight:64, activeMask:[all true], alive:true }`.

---

## THE `CardLocked` INCIDENT — full diagnosis

**What the user saw:** simulation failed, custom program error `0x17a4` (6052),
`AnchorError … enter.rs:103 … CardLocked: card has a locked leg; picks are immutable.`

**Verdict: expected on-chain behavior, NOT a chain bug.**
- The user already holds a nonce-0 Entry (entered 15:26 UTC, ×64, all 6 legs).
- Clicking "Enter" again takes the **edit branch** of `enter` (`enter.rs:96+`). The
  edit guard (`enter.rs:101-107`) rejects any edit once a **carried leg has kicked
  off**: `for each leg: require!(!(leg_lock > entry.entry_ts && leg_lock <= now))`.
- Australia–Egypt locked at 18:00 UTC (> the 15:26 entry_ts, ≤ now) → guard fires →
  `CardLocked`. This is the anti-buy-back freeze the user explicitly demanded (spec
  §11, "no buy-backs"). It is correct.

**The real (UI) bug: the user should never have reached the Enter button.**
- The engine serves `myCard` correctly RIGHT NOW (tested with their wallet — see
  above). When `PearlyView.tsx` has a `myCard`, it renders the **My-Card HUD**, and
  `onEnter` (the only caller of `buildEnterTx`) is on the **picker**, which only
  renders when `myCardState === "not-entered"` (i.e. `myCard` null/absent).
- So at click time, a poll returned `myCard` null/unknown and the picker rendered
  for a wallet that already holds a card. Since the engine returns it correctly now,
  this was a **transient UI state** — most likely a mount-time login/`address` race
  or a one-off entry-scan blip — not an engine defect. Not reproducible from the
  engine side at handoff time.

**Recommended fix (UI-side, defensive — do this next):**
`web/src/components/PearlyView.tsx` already fetches the nonce-0 `entry` separately
(`getContestEntries` → `setEntry`). Gate the picker / `onEnter` on `!entry` as a
belt-and-suspenders cross-check, so a wallet that provably holds a ticket can NEVER
reach Enter regardless of a `myCard` poll blip. Also consider: in `onEnter`, bail
early if `entry` (or any last-known `myCard`) exists. Pure UI change, no chain/engine
work. Add a `pearlyCard.test.ts` case if you touch the mapper.

---

## What's done (all green)

- Program v3: per-leg `leg_lock_ts[6]`, `entries_close_ts`, `entry_ts`, weighted
  settle/claim (`1<<active`), edit-freeze, exact per-contest weight band. Deployed.
- Engine `/api/card` v2 (flat contract, per-leg locks, `entriesCloseTs`, `aliveCount`
  three-state, `myCard` three-state, `degraded` signaling, 4s success-only cache).
- Keeper: `create-daily-pearly` composer, `countPerfectWeighted`/`entryWeight`
  (mirrors claim exactly), per-entry settle audit log, cron pearly job.
- Web: Pearly tab (picker → HUD → death/settled/rollover), Privy signer reuse, nonce 0.
- Chaos market 17 (Red-Card Y/N) in the catalog + allocator.
- **Test suites all passing:** anchor **113**, keeper **337**, engine **260**, web **134**.
- Latest commits: `bfeece5` (mockups), `87d3236` (web IDL sync), `4dc4601` (sizes +
  devnet redeploy), `3ea3cf9` (Pearly tab v1). Working tree: only untracked mockups +
  `keeper/audit-owners.tmp.ts` (leave untracked) are dirty.

## Open tasks (priority order)

> **Update 07-04 ~07:05 UTC:** #2 is DONE — but only after fixing a NEW blocker it exposed:
> the devnet feed appends post-match `StatusId 100` events, stranding every FT wave at
> `not-final-yet`. Fixed in `a08b540` (`resolveFixturePhase`, absorbing-terminal pick;
> keeper 346 green). Cron then auto-settled 777020637: buckets [0,1,0,0,1,1], 0 perfect →
> ROLLOVER `52R5xMD3…`; jackpot PDA now 0.07095 ◎. Evidence in the plan doc (`5960d78`).
> Perfect-card weighted-claim capture (T13 Step 4) still owed on a future card. #1 is next.
> **Update 07-04 (later):** #4 Plan C (shrunk) SHIPPED — cross-links + notifications v1, web suite 165, see the plan's execution log (`2026-07-04-pearly-crosslinks-notifications.md`).

1. **UI picker-guard fix** (above) — highest value; closes the exact thing the user hit.
2. **T13 devnet e2e evidence** (tracker #20): watch tonight's card settle. Aus–Egy is
   FT 1–1 (result = Draw, bucket 1); user picked bucket 0 on leg 0 (Arg–CV) and bucket
   0 on leg 1 (Aus–Egy = home Australia) → **their leg-1 pick likely LOSES** (draw ≠
   Australia), so their card probably busts and the pot rolls. Capture: per-leg settle
   waves in `cron-v3.log`, `countPerfectWeighted` at final settle (after 03:30 UTC),
   and the rollover into the jackpot PDA. If it busts, that's still valid e2e evidence
   (the rollover path). A cleaner "perfect card + weighted claim" capture can wait for
   tomorrow's R16 card.
3. **#22 test hardening** (from T5 quality review, non-blocking): widen the edit-accept
   lock window t0+5→t0+10, ADD the uncovered "late-entrant edit ALLOWED" test, fix the
   stale `sleep(22000)` margin comment, document the understated-weight revert-forever
   direction in `settle_contest.rs`. One test-only commit + full anchor suite when the
   validator's free (suite ~19–22 min, `mocha -t 1000000`).
4. **Plan C (shrunk):** cross-links (Pearly strip in `LiveMatchView` + live pointer in
   Pearly) + notifications v1 (in-app ticker + browser Notification API; SSE = stretch).
   Roar layer is EXCLUDED (user deferred it).
5. **Submission logistics (07/17–18):** create a **public GitHub remote + push** (repo
   has NO remote yet), Railway deploy, tech doc + TxLINE API feedback section, ≤5-min
   demo video.

## Gotchas the next session will trip on

- Anchor suite is slow (~20 min) — use a log-grep watchdog on `[0-9]+ (passing|failing)`
  over the last ~200 lines, not `ps` (sandboxed background shells are process-blind).
- Settle require order: SettleTooEarly → PerfectCountExceedsEntries → weight band →
  market checks. `BorshAccountsCoder.size` needs the account NAME string.
- `?wallet=A&wallet=B` → Fastify parses an array → `new PublicKey(array)` silently =
  system program. Engine already validates single-string; keep that.
- MagicBlock devnet undelegation handback is INTERMITTENT (Live-mode concern only;
  keeper is handback-gated + idempotent). Not a Pearly issue.
- Bash cwd persists between calls — use absolute paths.

## Spec / plan / memory pointers

- Spec: `docs/superpowers/specs/2026-07-03-streak-hackathon-live-pearly-design.md`
- Plan: `docs/superpowers/plans/2026-07-03-pearly-core.md`
- Auto-memory: `MEMORY.md` index → `streak-pearly-hackathon.md` (current direction),
  `streak-real-money-only.md` (hard directive), `subagents-use-fable.md`.
