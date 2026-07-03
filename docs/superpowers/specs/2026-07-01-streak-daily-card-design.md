# Streak — Daily Card Pivot — Design Spec

**Date:** 2026-07-01
**Branch:** feat/streak-pivot
**Status:** approved (design converged over mockups `mockups/6-pre-game`, `7-after-game`, `8-pre-blank`)

**Goal:** Convert the existing single-match parlay into **Streak** — one auto-composed **daily 6-leg perfect-parlay card**. Fixed entry into a common pool; getting all 6 legs right wins; perfect cards split the pot; if nobody is perfect the pot rolls into the next day. The card settles when its **last match reaches full-time**, all within a 24h window. Built on TxLINE World-Cup data + the on-chain contest/jackpot machinery that already exists.

**Architecture:** Reuse the on-chain `Contest` / `Entry` / `Jackpot` programs and the `Txoracle.validateStat` Merkle-proof settlement (already confirmed on devnet). Add: a daily **allocator** (keeper job) that builds the card from TxLINE fixtures + odds; an `/api/card` endpoint; a reskinned single-card web view; and a daily cron for create + last-whistle settle.

**Tech Stack:** Anchor 0.31 (Rust) · Fastify + TypeScript engine · React + Vite + Privy web · TxLINE REST/SSE + Txoracle (Solana). Devnet.

---

## 1. Product model

- **One card per day, exactly 6 legs.** Each leg = `(fixture, market, pick)`.
- **Markets (TxLINE-confirmed only):** Result 1X2 (`market_id 12`), Goals O/U (`11`), HT Result (`16`), HT Goals O/U (`15`). Corners (`10`) / Cards (`13`) exist in catalog but are kept as single-match-fallback only (coverage less certain).
- **Entry:** fixed `CARD_ENTRY_LAMPORTS` (default **0.02 SOL** on devnet; "$1" is the conceptual framing). One pool = the `Contest` PDA balance.
- **Win condition:** all 6 legs correct. Perfect cards **split** `distributable`. **Zero perfect → pot rolls** into the singleton `Jackpot` PDA (existing rollover path).
- **Fee:** `0 bps` for the demo (rake is a later flip; the program already supports it).
- **Lifecycle (24h):** keeper creates the card in the morning → **locks at first kickoff** (`lock_ts`) → **settles when the last match hits full-time** (`settle_after_ts` = last kickoff + buffer; settlement *fired off the TxLINE phase, not a clock*) → fresh card next day.

## 2. The allocator (smart filter) — daily keeper job

**Input:** TxLINE slate for the day + consensus odds. **Output:** 6 legs + `lock_ts` + `settle_after_ts` + deterministic `contest_id`.

Pipeline:
1. **Eligibility** — keep fixtures that kick off after lock *and* reach full-time inside the 24h window, with odds available.
2. **Rank matches** by card-worthiness: stature (big teams / knockout > dead rubber) + competitiveness (closer odds = more interesting).
3. **Allocate 6 legs, spread-first** — one **Result** leg per top match; if fewer than 6 matches, add **Goals O/U** to the most competitive, then **HT** variants, climbing until 6. ≥6 matches → 6 results, one each. 1 match → 6 markets on it.
4. **Quality-gate by odds** — drop legs where the favorite is implied > ~82% (odds < ~1.20: foregone conclusion); prefer a competitive band. Track combined odds (informational for v1).
5. **Freeze** — snapshot legs + lines; `contest_id = hash(dayEpoch)`; call `create_contest`. **Idempotent:** PDA already exists → no-op.

## 3. On-chain changes

- **`MAX_LEGS` 5 → 6** in `contest_state.rs` (fixed arrays resize via `InitSpace`). `create_contest` `num_legs` range → `3..=6`. Everything else (`enter`, `settle_contest`, `claim_contest`, `void_contest`, jackpot rollover) is already N-leg generic.
- **Redeploy in-place** to devnet (same program id, as done for v2). `Contest` account size grows → engine/web size constants update accordingly.

## 4. Engine

- **New keeper** `create-daily-card.ts` (the allocator) + a **pure allocator module** + unit tests.
- **New endpoint** `GET /api/card` → today's live card: legs (catalog label/group/line + team names), `lock_ts`/`settle_after_ts`, entry price, pot, jackpot. Reuses `chain.ts` readers.
- **Settlement** — reuse the `settle-contest` flow; add scheduling: create card daily, settle legs as matches finish, call `settle_contest` after the last whistle (poll TxLINE phase).
- Update the engine's **contest size-filter constant** for 6 legs.

## 5. Web

- Reskin `SweepstakeView` into the **single daily card** with the four states from the mockups: **blank** (pick) → **filled** (locked-in) → **live** (resolving) → **after** (settled / won / lost). **Grouped by match.** Port mockup CSS into `App.css`.
- Reuse `buildEnterTx` / `buildClaimContestTx` (pad picks to 6). Remove the multi-contest carousel — one card/day. Source from `/api/card`.

## 6. TxLINE integration

- Reuse `spike/` auth + discover + validate + `Txoracle.validateStat` (confirmed devnet). Allocator pulls slate + odds via `catalog.ts` / `live.ts`. Settlement unchanged: keeper pre-validates the Merkle proof → submits `settle` per leg → `settle_contest`.
- Market menu limited to TxLINE-confirmed types (Result, Goals O/U, HT variants).

## 7. Scope / non-goals (v1)

**In:** daily 6-leg card end-to-end on devnet; allocator from real TxLINE data; the web card states; enter + claim; last-whistle settlement; jackpot rollover headline; demo polish.

**Out (later):** Both-teams-score / first-scorer markets; the streak meta-layer (threshold race); no-loss / yield funding; two-token sweepstakes; mainnet; rake / monetization; Seeker MWA.

## 8. Open tunables (defaults set, trivially changed)

- `CARD_ENTRY_LAMPORTS` = 0.02 SOL · `fee_bps` = 0 (demo) · quality-gate ≈ 1.20 odds · card-create 08:00 UTC · settle buffer ≈ 2h after last kickoff.
