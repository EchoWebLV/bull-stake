# Streak — TxODDS World Cup Hackathon: ⚡ Live + 🃏 The Daily Pearly — Design Spec

**Date:** 2026-07-03
**Branch:** feat/streak-pivot
**Status:** approved (converged over `mockups/15-roar-demo.html`, `16-gauntlet.html`, `17-pearly.html`)

**Goal:** Win the TxODDS **Consumer and Fan Experiences** track (1st = 10k USDT; submissions close **2026-07-19 23:59 UTC**; judging leans heavily on a ≤5-min demo video). Submission = the Streak app with **two real-money game modes on Solana devnet**, both settled from TxLINE data: **⚡ Live** (exists today; gets the "roar" presentation layer) and **🃏 The Daily Pearly** (new; the all-day cross-fixture parlay survival game). Real money only — no demo/paper modes.

**Judging criteria mapping:** Live = real-time responsiveness + originality (money on 10–50 ms ER taps). Pearly = "fan opens it regularly" + monetization (rake-ready pot + rollover jackpot). Both = completeness (end-to-end on devnet against real World Cup matches; knockout rounds run daily through July 19).

---

## 1. Product model — two modes, two pots, one wallet

Nav: **Live · Pearly · My Bets · Wallet**. Beat the Market tab retires (hidden-not-deleted); its odds data becomes "field split / crowd" context. The hidden Parlay tab is reborn as the Pearly.

- **⚡ Live (per match):** join pool ◎0.035 before KO; rapid on-chain micro-calls during play (MagicBlock ER); top score takes the pot at FT. Mechanics unchanged this cycle — new presentation layer only (§7).
- **🃏 Pearly (per day):** one keeper-composed **6-leg card across all of today's fixtures**. Enter **◎0.05 at any time while ≥3 legs remain unlocked**; your card = the legs still open at entry; **payout weight = 2^(legs carried)** (6 legs ×64 … 3 legs ×8). Each leg locks at its own kickoff. **One entry per wallet per day — no buy-backs.** (Enforced at the product layer: web/engine always use entry nonce 0, so a wallet has one card. The program's nonce channel remains for legacy parlays; extra raw-CLI tickets just feed the pot.) All carried legs correct = **perfect**. Perfect cards split (pot − rake) **by weight**. **Zero perfect → the entire pot rolls** into the jackpot PDA (existing rollover path) and seeds tomorrow's card. A dead card spectates; alerts continue.
- **Notifications are the retention engine** (replaces rejected buy-backs): card-relevant alerts — leg live / leg hit / leg died / one-leg-from-perfect / settled / tomorrow-seeded. v1 = in-app ticker + browser `Notification` API while the PWA is open; service-worker Web Push = stretch.
- **Cross-links:** a slim Pearly strip inside `LiveMatchView` ("🃏 your card rides this match — Over 2.5 needs one more goal") and a "match window live — go play it ⚡" pointer in the Pearly during its matches.

## 2. Card composition (allocator v2 — cross-fixture)

- **Inputs:** TxLINE day slate + StablePrice consensus odds. **Markets restricted to TxLINE-verified stats** (soccer feed keys 1–8: goals / yellows / reds / corners per team, plus per-period variants `(period×1000)+key`): 1X2 winner, goals O/U, first-half goal, corners O/U, red/yellow card props. Team-news and line-movement markets are explicitly rejected (§11).
- **Shape (6 legs):** one winner leg per fixture (up to 4) → goals O/U on the most competitive fixture → first-half-goal on an evening fixture → **one chaos leg** — "Red card shown? (Y/N)" on the day's marquee (top-ranked) fixture, new catalog market 17 settling off TxLINE red-card keys 5/6 through the existing per-fixture settle machinery. (Day-wide "any match today" aggregation = post-hackathon; it needs a synthetic-fixture market the settle path can't proof-validate today.) Fewer fixtures → climb the market menu on the most competitive matches (daily-card spec rules apply).
- **Gates:** drop legs with implied favorite > ~82% where odds exist. Deterministic `contest_id = hash(dayEpoch)`; idempotent create (PDA exists → no-op).

## 3. Weight math + edge cases

- `weight_i = 2^(count of legs with leg.lock_ts > entry.entry_ts)`. Entry permitted iff that count ≥ 3 (entries effectively close at the KO that leaves only 2 open legs).
- `perfect_i` = every counted leg correct. **Unresolvable legs** (postponed/abandoned fixture with no proof-determined bucket): the keeper voids the whole contest → every entry refunds (existing `void_contest` path). No per-leg void exclusion this cycle.
- `payout_i = distributable × weight_i / Σ weight_perfect`, u64 floor math, where **distributable = (pot − rake) + the whole jackpot** (winners settle pulls the jackpot in); flooring residue (< perfect_count lamports) stays in the Contest PDA. Zero perfect (or zero entries) → full pot → jackpot PDA rollover. `fee_bps` configurable, **0 for the demo**.

## 4. On-chain changes (one focused set; redeploy in place, same program id)

- `Contest` gains per-leg `lock_ts[MAX_LEGS]` (set at create from each leg's own fixture KO — the chaos leg locks at the marquee fixture's KO like any other leg).
- `enter`: allowed until `entries_close_ts` (derived: KO leaving 2 open legs) instead of the global first-KO lock; `Entry` gains `entry_ts` (cluster time at entry).
- `settle_contest` / `claim_contest`: compute each entry's active-leg mask from `entry_ts` vs per-leg `lock_ts`; weighted split per §3. Perfect-count guard and rollover path reuse the existing machinery.
- `MAX_LEGS` stays 6. Live-pool instructions untouched.

## 5. Engine

- **`/api/card` v2:** per-leg lock times + labels + team names, field pick-splits per leg, **alive count** ("cards still perfect", computed engine-side from entries × resolved buckets), pot, rollover seed, entries-close time, and `myCard` (wallet param → picks, active mask, weight, state).
- **SSE migration (stretch, high demo value):** swap the 8 s REST score polling for TxLINE `GET /api/scores/stream` (SSE; confirmed in TxLINE docs) with polling fallback. Same for odds stream if time allows.

## 6. Keeper

- `create-daily-pearly` (composer v2, cross-fixture) daily 08:00 UTC.
- Per-leg settle waves generalize the existing 2-wave flow: settle each fixture's legs at its FT (HT legs at H1 final); final `settle_contest` after the last whistle (phase-driven, not clock-driven). Void path unchanged (3-day permissionless grace exists).
- Existing LIVE / SCHEDULE jobs unchanged.

## 7. Web

- **Pearly tab** (blueprint = mockup 17): picker (6 legs, field splits, weight chips, perfect-or-rollover copy) → day HUD (alive/pot/weight pills, alert ticker, match-window strip, my-card leg rows) → death state (spectate; no buy-back) → on-chain settle sequence → over card (weight-share breakdown, claim, share text) / rollover card.
- **Live tab roar layer — DEFERRED (user call, 2026-07-03):** the live game's presentation gets a dedicated redesign after the Pearly lands; mockup 15 stays as a reference sketch but is NOT built this cycle. The existing `LiveMatchView` ships as-is for the submission. (Pearly-tab moments per mockup 17 are unaffected — they belong to the Pearly build. No usernames/profiles this cycle.)
- Cross-links per §1. Port mockup CSS into `App.css` following the mockups→component pattern used for the daily card.

## 8. Demo video (≤5 min) beats

1. Cold open pitch-side: live game taps with real SOL on the line, existing Live UI (criterion 2, spectacle).
2. Morning: fill the Pearly card, enter on-chain (weight chips explain all-day entry).
3. Day montage: legs resolving, alive counter bleeding, 🔔 card alerts, late entries raising the pot.
4. Evening: live game with the Pearly strip — one goal, two dopamine hits; the red card flips the chaos leg on screen (Pearly-tab moment).
5. Midnight: settle with Merkle proof on Txoracle, weighted split, claim, rollover tease.
6. 15 s architecture card: TxLINE (SSE) → keeper → Anchor program → `Txoracle.validateStat`.

## 9. Submission checklist (hard requirements)

- **Public GitHub repo** — the repo currently has **no remote**; create + push before submission.
- Deployed web app (Railway) + devnet program id in the docs.
- Tech doc listing TxLINE endpoints used: fixtures snapshot, scores historical/snapshot (+ stream), odds snapshot/updates, validation proofs; Txoracle `validateStat` CPI.
- TxLINE API feedback section (explicitly requested by the sponsor).
- Demo video link (Loom/YouTube), ≤5 min.

## 10. Schedule to Jul 19 (cut line)

- **07/04–07:** §4 program change + Anchor tests; composer v2 + `/api/card` v2. R16 runs daily — start capturing b-roll.
- **07/08–10:** Pearly web e2e on devnet against real QF fixtures.
- **07/11–13:** Pearly web polish + cross-links + notifications v1 (Live roar layer deferred — freed days are buffer).
- **07/14–16:** SSE migration (stretch), polish, record demo during QF/SF (SF July 14–15).
- **07/17–18:** docs, public repo, deploy, submit. **07/19 = buffer only** (final is deadline day).
- **Fallback if §4 slips past 07/09:** ship Pearly with entry-closes-at-first-KO (no weights, program untouched) — the two-mode story survives on the existing Live UI.

## 11. Rejected / non-goals (this cycle)

- **Buy-backs / re-entry** — rejected by design: one card a day; perfect-or-rollover is the drama and the jackpot engine.
- **Line-movement betting** (Beat the Market as a game) — rejected: pro-trader niche, not consumer excitement; odds survive as field-split context only.
- **Team-news markets** — rejected: no line-up data in the TxLINE feed; unsettleable trustlessly.
- **Live roar presentation layer** — deferred 2026-07-03 by user call; the live game's presentation is redesigned after the Pearly lands (mockup 15 = reference sketch only).
- Usernames/profiles, private rooms/crews, duels, Gauntlet moment-scheduler, session keys, float-yield, mainnet, Seeker MWA — post-hackathon.

## 12. Open tunables (defaults set, trivially changed)

`PEARLY_ENTRY` = 0.05 SOL · `LIVE_ENTRY` = 0.035 SOL · `fee_bps` = 0 · min open legs to enter = 3 · compose 08:00 UTC · settle buffer 2 h after last KO · weight base = 2.
