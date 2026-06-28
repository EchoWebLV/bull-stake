# Streak — On-Chain Parimutuel App (PWA + Seeker) — Design Spec

**Date:** 2026-06-28
**Status:** Approved (design); pending spec review → implementation plan
**Depends on:** the parimutuel core — `programs/proofbet` (binary parimutuel program), `keeper/settle.ts` (settlement keeper), `spike/` (`Txoracle.validateStat` proof path, green on devnet). See [2026-06-25-proofbet-parimutuel-design.md](2026-06-25-proofbet-parimutuel-design.md) and [../../spike-runbook.md](../../spike-runbook.md).
**Hackathon target:** TxODDS World Cup — **Prediction Markets & Settlement** track ($18k). Submissions close 2026-07-19.

## 1. Overview

**Streak** is a real-money, on-chain **parimutuel** prediction app for World Cup soccer. Bettors stake native SOL into binary outcome pools on match props; after the match (or half) a keeper resolves the outcome from a TxLINE Merkle proof via `validateStat` and calls `settle`, recording the exact proof inputs on-chain so anyone can re-verify. Winners claim a pro-rata share of the pool. The app ships as an installable **PWA** and a **Seeker / Android APK** (Solana dApp Store), reusing the visual design of the existing `Streak` prototype.

This iteration is a **front-end + service layer** on top of the already-built and tested parimutuel core. The on-chain program and settlement keeper are reused **as-is**.

### Goals
- A polished, installable PWA (+ Seeker APK) that a user can: connect wallet → see live WC matches → bet into a pool → watch live pool-implied odds move → see it settle from a TxLINE proof → claim → and track a **streak** of correct picks on a leaderboard.
- Settlement that is **publicly verifiable** (re-run the on-chain proof inputs), not "trust me."
- **100% reuse** of `programs/proofbet` and `keeper/settle.ts` — no on-chain changes this iteration.
- Live data driven by TxLINE SSE streams (scores, events, odds).

### Non-goals (this iteration)
- The **Daily Streak Contest** (5-in-a-row jackpot) — fully specified in §13, but post-hackathon.
- USDC/SPL collateral, post-kickoff in-play betting, 48-second window markets, survivor-pool economics, fiat on-ramp, mainnet — all roadmap (§13).
- 3-way result as a single market, BTTS, shots/possession markets — not built (§5).

## 2. Key decisions (approved)

| Decision | Choice | Rationale |
|---|---|---|
| Product / track | **Real-money on-chain parimutuel → Prediction Markets & Settlement** | Reuses the proven on-chain engine; the consumer-track free game is a separate future entry (§13). |
| Economic model | **Parimutuel pools (reuse `proofbet` as-is)** | No house bankroll, fully pooled, the pool *is* the liquidity. Streak's "odds" become **pool-implied**, not bookmaker odds. |
| Markets | **Match + half binary predicates** | Stat keys are period-encoded (`+1000` 1st half, `+2000` 2nd half), so half markets are provable with zero program change — buys back in-play *cadence* (settle in two waves) without post-kickoff betting. |
| Collateral | **Native SOL / lamports (reuse as-is)** | Zero token setup; frictionless devnet demo (airdrop). UI shows SOL with optional USD-equivalent label. |
| Architecture | **A — React/Vite PWA + thin Node backend + reused program + keeper** | The backend is the only safe holder of the TxLINE API token and powers the leaderboard/streak layer. |
| Betting window | **Close at kickoff (MVP)** | In-play (post-kickoff) betting is a clean stretch goal, not MVP. |
| Frontend source | **Rebuild faithfully in React from the prototype's design; drop the generated bundle** | `Streak.html` is a 7.1MB generated `DCLogic`/`__bundler` artifact — not maintainable source. Reuse the *design* (`#FF6A1A` / `#07090d` / `#3DE08A`, Archivo, 4-tab layout, bet slip, confetti, receipts), not the bundle. |
| Streak/leaderboard | **MVP feature, derived from on-chain settled positions** | It's the app's namesake; built on the same settlement pipeline, so it's verifiable not a DB claim. |

### Honest framing (inherited house rule)
The program never calls Txoracle directly (Path A: keeper `.view()` + signed `settle`). The on-chain record (immutable predicate + bound proof inputs) makes a dishonest keeper **detectable**. We describe this as **"verifiable, single-source, no separate oracle, no dispute window"** — **never "trustless."** Full trustlessness (Path B: CPI into `validateStat`) stays on the roadmap.

## 3. Reuse map

**Reused as-is (no code changes):**
- **`programs/proofbet`** — binary parimutuel program. `initialize_market(fixture_id, market_id, args)`, `place_bet(bucket, amount)`, `settle(winning_bucket, settled_seq, settled_ts, settled_value)`, `void_market(...)`, `claim()`. Buckets: `OVER=0` (predicate TRUE) / `UNDER=1` (FALSE). Predicate: `(stat_key [op stat_key2]) comparison threshold`. SOL escrow in a per-market `Vault` PDA; pro-rata `claim`. Program id `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`.
- **`keeper/settle.ts`** — fetches score history, finds terminal/void event, fetches `stat-validation`, runs `validateStat.view()` against the `daily_scores` PDA, submits `settle`/`void`. Already supports `--compute-only` and market mode.
- **`spike/src/`** — `auth.ts` (TxLINE guest JWT + API token), `discover.ts` (score history / phase), `validate.ts` (`fetchStatValidation`, `buildBaseArgs`, `viewValidate`, `dailyScoresPda`), `config.ts` (finished/void phases).

**New build:**
- `streak-engine` backend (Node/TS) — §4.
- `streak-pwa` frontend (React/Vite) — §4.
- Pool-implied odds indexer, streak/leaderboard store — §6, §7.
- Wallet integration (wallet-adapter + Mobile Wallet Adapter) — §8.
- PWA manifest/service worker + TWA APK wrap — §9.

**Retired (not deleted; out of scope this iteration):** fixed-odds mechanics, 48-second window markets, survivor-pool economics from the prototype. Code untouched so a future Consumer-track entry can draw on it.

## 4. Architecture & components

Three units with clear boundaries:

### 4.1 `proofbet` program (on-chain, reused)
Owns market state, SOL escrow, and settlement truth. Interface = its Anchor instructions (above). Depends on nothing off-chain.

### 4.2 `streak-engine` backend (Node/TS, new)
The **only** holder of the TxLINE API token. Submodules, each with one purpose:
- **`txline-client`** — wraps `spike/src/auth.ts` + the SSE endpoints (`/api/scores/stream`, `/api/odds/stream`) and `/api/fixtures/snapshot`. *In:* config; *Out:* authenticated fetch + event streams.
- **`sse-relay`** — proxies the TxLINE scores/odds SSE to connected PWA clients over WS/SSE so the **token never ships to the browser**. Supports `Last-Event-ID` resume.
- **`market-catalog`** — on a schedule, reads `/api/fixtures/snapshot`, and for each in-scope fixture creates the standard market set (§5) via `initialize_market`, signed by a backend **creator/settle-authority keypair**. Idempotent (skips existing markets).
- **`settlement-keeper`** — wraps `keeper/settle.ts`; fires at half-time (1st-half markets) and full-time (match markets) when TxLINE marks the relevant stats final, settling or voiding each market.
- **`odds-indexer`** — reads `bucket_totals` / `total_pool` from on-chain `Market` accounts, computes pool-implied odds (§5), pushes updates to clients.
- **`streak-store`** — SQLite. On each settlement, records every participating wallet's win/loss → current streak, best streak, global leaderboard, receipt cache.
- **`api`** — REST/WS surface for the PWA: market catalog, live feed relay, odds, streaks/leaderboard, a wallet's open/settled positions.

### 4.3 `streak-pwa` frontend (React/Vite, new)
Rebuilt from the prototype's design. Tabs:
- **Live** — match list (from catalog), per-match markets with live pool-implied odds, bet slip → signs `place_bet` client-side, live score/event ticker from the SSE relay.
- **Streak** — current/best streak, pick history with verifiable settlement receipts (proof inputs + `daily_scores` PDA), shareable streak card.
- **Wallet** — SOL balance, open positions, **Claim** (signs `claim`), activity log.
- **Pool** *(simplified MVP placeholder)* — surfaces the active markets/leaderboard; full pool/contest formats are §13.

Wallet via Solana **wallet-adapter** (Phantom/Solflare on web, **Mobile Wallet Adapter** on Seeker/Android). Bets and claims are signed **client-side**; the backend never custodies user funds.

### 4.4 Data flow
- **PWA ↔ backend:** market catalog, relayed live feed, pool-implied odds, streaks/leaderboard.
- **PWA ↔ Solana (direct):** wallet signs `place_bet` and `claim`.
- **Backend ↔ TxLINE:** auth, SSE scores/odds, `stat-validation` proofs.
- **Backend ↔ Solana:** `market-catalog` creates markets; `settlement-keeper` settles/voids.

## 5. Market model

Binary parimutuel. Standard set created per in-scope fixture:

| Market | Predicate | Provable |
|---|---|---|
| Total corners O/U | `(corners1 + corners2) > t` (stat 7,8, `Add`, `GreaterThan`) | ✅ |
| Total goals O/U | `(goals1 + goals2) > t` (stat 1,2, `Add`, `GreaterThan`) | ✅ |
| 1st-half goals O/U | period-encoded stat (`+1000`), settles at HT | ✅ |
| 1st-half corners O/U | period-encoded stat (`+1000`), settles at HT | ✅ |
| Result — Home win | `(goals1 − goals2) > 0` (`Subtract`, `GreaterThan`, 0) | ✅ |
| Result — Away win | `(goals1 − goals2) < 0` (`Subtract`, `LessThan`, 0) | ✅ |
| Result — Draw | `(goals1 − goals2) = 0` (`Subtract`, `EqualTo`, 0) | ✅ |

The three Result markets are **grouped as a 1X2 in the UI** but are three independent binary markets on-chain.

**Dropped (honest):**
- **BTTS** — requires *both* `goals1 ≥ 1` AND `goals2 ≥ 1`; the `Add`/`Subtract` op set cannot express an AND. Out unless the program is extended.
- **Shots, possession** — not in TxLINE's cryptographically-provable stat set (only goals, yellow cards, red cards, corners). The prototype's "shots/possession" copy is not used.

**Pool-implied odds** shown in the UI:
`impliedOdds(bucket) = total_pool × (1 − fee) ÷ bucket_total`
recomputed from on-chain totals by `odds-indexer` and pushed live. The odds chips therefore reflect **real pool movement**, not a bookmaker line. Display a "live, indicative until close" note (final payout is fixed at entry close).

## 6. Settlement & the "half" cadence

Betting closes at **kickoff** (MVP; `entry_close_ts` = kickoff). Markets settle in **two waves**:
1. **Half-time** — 1st-half markets settle once TxLINE has anchored the 1st-half stats (`settlement-keeper` detects the HT phase, validates the period-encoded stat, calls `settle`).
2. **Full-time** — match markets settle from the terminal event.

This gives a live feedback rhythm (two settlement waves per match → faster streak updates) **without** post-kickoff betting. On settlement, winners `claim()` for a pro-rata payout; abandoned fixtures route to `void_market` (full refunds). The on-chain `settled_seq` / `settled_ts` / `settled_value` + `MarketSettled` event bind the exact proof inputs for independent verification.

## 7. Streak & leaderboard (the namesake)

On every settlement, `streak-store` records each participating wallet's outcome and updates:
- **Current streak** — consecutive correct settled picks.
- **Best streak** — all-time max (mirrors the prototype's "12 / best 27").
- **Global leaderboard** — ranked by current/best streak.
- **Shareable streak card** — image/route for social sharing.

All derived from **on-chain settled positions**, so any value is independently reconstructable — the streak is verifiable, not a database assertion.

## 8. Wallet & Solana sign-up

Solana **wallet-adapter**; **Mobile Wallet Adapter** for Seeker/Android, Phantom/Solflare for web. Connecting a wallet satisfies the track's "sign up through Solana" requirement. No custody: every value transfer (`place_bet`, `claim`) is a user-signed transaction. The backend's keypair only creates and settles markets (the immutable predicate + bound proof keep it honest-by-construction).

## 9. Platform: PWA + Seeker APK

- **PWA** — Vite PWA plugin: web manifest + service worker, installable, offline app shell, cached static assets. Live data is always network (SSE relay).
- **Seeker / Android** — wrap the deployed PWA as a **TWA** (Trusted Web Activity, via Bubblewrap) APK and submit to the **Solana dApp Store**. MWA handles on-device signing. (Native React-Native rebuild remains a future option, not needed for submission.)

## 10. Demo strategy

World Cup 2026 runs **through** 2026-07-19, so live TxLINE data is available during the build — but the demo video must not depend on a live match kicking off on cue. Plan:
- Record/replay a **deterministic TxLINE feed** (captured SSE + `stat-validation` responses for one or two fixtures) so the full flow — create → bet → live odds → settle-from-proof → claim → streak update — can be demoed on command on **devnet**.
- Keep a "live mode" toggle that points the `txline-client` at the real streams for a genuine live segment if a match is in play during recording.

## 11. Scope

**MVP (demo-ready, devnet):**
- Reused `proofbet` program + `keeper`.
- `streak-engine`: `txline-client`, `sse-relay`, `market-catalog`, `settlement-keeper`, `odds-indexer`, `streak-store`, `api`.
- `streak-pwa`: Live + Streak + Wallet tabs (+ simplified Pool), wallet-adapter, install/PWA.
- TWA APK build for Seeker.
- 1–2 demo fixtures with the standard market set.

**Out (this iteration → §13):** Daily Streak Contest, USDC, in-play betting, 48s windows, survivor economics, mainnet, fiat on-ramp.

## 12. Risks & honest posture

- **Legal:** real-money betting carries jurisdictional exposure. Hackathon build is **devnet-only**, framed as a verifiable-settlement demo; mainnet would require legal review. The track places compliance on the builder.
- **Data limits:** only goals/cards/corners are provable; BTTS and shots/possession are out (§5) — surfaced honestly, not faked.
- **Settlement liveness:** Path A keeper can stall (detectable, not forgeable); production posture is a Squads multisig `settle_authority`, full trustlessness via CPI is roadmap.
- **Demo dependency:** mitigated by the deterministic replay (§10).
- **Token safety:** TxLINE API token lives only in the backend; never shipped to clients.

## 13. Roadmap / Future

Listed in rough priority. The MVP's `streak-store`/leaderboard and settlement pipeline are deliberately the foundation for these, so they're cheap to add later.

### 13.1 Daily Streak Contest (next headline feature)
A daily **perfect-parlay jackpot** — the purest expression of the "Streak" name.
- **Format:** we pre-pick a slate of **5 matches** within a 24-hour window. Anyone enters for a fixed **0.01 SOL** buy-in and submits one pick per match.
- **Pick per match:** the **result — Home / Draw / Away** (provable via `goals1 − goals2` >0 / =0 / <0).
- **Win condition:** **all 5 correct.** All 5/5 entries **split the entire pot equally**.
- **No winner:** the pot **rolls over** to the next day's contest (growing jackpot = retention hook).
- **Rake:** 0% for the demo; small `fee_bps` later.
- **On-chain:** needs a **new construct** (`create_contest` → `enter_contest` with 5 picks → `settle_contest` writing the 5 results → `claim`). It **reuses the `validateStat` settlement engine** (five `.view()` resolutions, same `daily_scores` PDA path) and `proofbet`'s vault-escrow + pro-rata-claim **patterns** — it is *not* expressible as five binary parimutuel pools (payout is conditional on all five against one shared pot).

### 13.2 Group Sweepstake (Consumer-track candidate)
Assign WC teams to a friend group; a live leaderboard updates off the same settlement feed. **Free-entry** (lower regulatory risk) — could anchor a separate **Consumer & Fan Experiences** track entry from the same repo.

### 13.3 Other
- Survivor / elimination pools (the prototype's "Pool" tab).
- USDC/SPL collateral (rework escrow from lamports → token vaults/ATAs).
- Post-kickoff **in-play** betting (set `entry_close_ts` to half-time for 2nd-half markets).
- 48-second window markets as a **free** off-chain engagement layer.
- BTTS (needs a program predicate extension), richer prop set.
- Mainnet + Squads multisig settle authority; Path B CPI settlement for full trustlessness.

## 14. Open questions
- Exact in-scope fixture list for the demo (depends on the WC schedule near recording date).
- Default `threshold` values per market (e.g., corners 9.5, goals 2.5) — confirm at catalog-build time.
- Backend hosting target (single VM vs. serverless functions + a small always-on keeper).
