# Streak Daily Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Each implementer reads the real files first (this plan gives the target, not a transcription of current code).

**Goal:** Ship a working daily 6-leg perfect-parlay card ("Streak") end-to-end on devnet, sourced from real TxLINE data, with the polished web card states for the demo video.

**Architecture:** Reuse on-chain `Contest`/`Entry`/`Jackpot` + `Txoracle.validateStat` settlement. Add a daily allocator (keeper), `/api/card`, a reskinned single-card web view, and a daily create+settle cron.

**Tech Stack:** Anchor 0.31 · Fastify/TS · React/Vite/Privy · TxLINE + Txoracle (devnet).

**Spec:** `docs/superpowers/specs/2026-07-01-streak-daily-card-design.md`

---

## Phase 1 — Program: 6-leg contests

### Task 1.1: Bump `MAX_LEGS` to 6 + widen validation
**Files:**
- Modify: `programs/proofbet/src/contest_state.rs` (the `MAX_LEGS` const; fixed arrays `fixtures`/`market_ids`/`winning_buckets` on `Contest`, `picks` on `Entry` resize via `InitSpace`)
- Modify: `programs/proofbet/src/instructions/create_contest.rs` (`num_legs` range check)
- Test: `programs/proofbet/tests/` (existing Anchor test suite)

- [ ] Read `contest_state.rs` and `create_contest.rs` to confirm the const name and the validation expression.
- [ ] Change `MAX_LEGS` from `5` to `6`.
- [ ] Widen the `num_legs` guard in `create_contest` so `3..=6` is accepted (was capping at 5).
- [ ] Add/extend an Anchor test: create a **6-leg** contest, `enter` a perfect ticket + an imperfect one, settle all 6 leg markets, `settle_contest`, `claim_contest` — assert the perfect ticket is paid and the imperfect one isn't.
- [ ] Run `anchor test`; expect all green (existing 5-leg tests must still pass).

### Task 1.2: Propagate the new contest size to engine + web
**Files:**
- Modify: `engine/src/chain.ts` (contest size / discriminator filter in `readLiveContests`)
- Modify: `engine/keeper/settle-contest.ts` (`CONTEST_SIZE_FALLBACK` if present)
- Modify: `web/src/lib/anchorClient.ts` (`buildEnterTx` pads picks to **6**), `web/src/lib/pdas.ts` if it hardcodes leg count
- Copy the freshly built IDL to wherever engine/web import it (confirm the IDL sync path).

- [ ] Rebuild so the IDL reflects 6-leg arrays; sync the IDL into engine + web.
- [ ] Update the engine's expected `Contest` account size so v3 (6-leg) contests pass the size filter and old ones are ignored (same pattern already used for v1→v2).
- [ ] Update `buildEnterTx` padding from 5 → 6.
- [ ] `tsc` clean on engine + web.

### Task 1.3 (GATED — needs explicit user OK before running): Redeploy in-place to devnet
- [ ] `anchor build` + `anchor deploy` to devnet (same program id, in-place upgrade).
- [ ] Smoke: create one throwaway 6-leg contest via keeper dry-run→real, confirm it reads back through `/api/contest/live`.

---

## Phase 2 — The allocator (daily card brain)

### Task 2.1: Pure allocator module + unit tests
**Files:**
- Create: `engine/src/allocator.ts`
- Test: `engine/src/allocator.test.ts` (vitest)

Functions (pure, no I/O):
```ts
type Fixture = { fixtureId: number; home: string; away: string; kickoffTs: number };
type Odds = { fixtureId: number; market: number; impliedProbs: number[] }; // per bucket
type Leg = { fixtureId: number; marketId: number };

// 1. keep fixtures kicking off after lockTs and finishing within the 24h window
export function filterEligible(fixtures: Fixture[], lockTs: number, windowSecs: number): Fixture[];
// 2. rank by competitiveness (closer odds first) — stature optional in v1
export function rankMatches(fixtures: Fixture[], odds: Odds[]): Fixture[];
// 3. spread-first: result per match, then climb the menu to reach `target` legs
export function allocateLegs(ranked: Fixture[], odds: Odds[], target: number, menu: number[]): Leg[];
// 4. drop legs whose favorite implied prob exceeds `maxImplied`
export function qualityGate(legs: Leg[], odds: Odds[], maxImplied: number): Leg[];
// orchestrator
export function buildCard(fixtures: Fixture[], odds: Odds[], opts: {
  lockTs: number; windowSecs: number; target: number; menu: number[]; maxImplied: number;
}): { legs: Leg[]; lockTs: number; settleAfterTs: number };
```

- [ ] Write failing tests first: (a) 6 eligible matches → 6 result legs, one each; (b) 3 matches → 3 results + 3 Goals O/U; (c) 1 match → 6 markets on it; (d) a blowout match (implied 0.9) is dropped by `qualityGate`; (e) `filterEligible` excludes a fixture finishing past the window.
- [ ] Implement to green. `menu` default `[12, 11, 16, 15]` (Result, Goals O/U, HT Result, HT Goals O/U).
- [ ] `vitest run` green.

### Task 2.2: Keeper job `create-daily-card.ts`
**Files:**
- Create: `engine/keeper/create-daily-card.ts`

- [ ] Read `engine/src/catalog.ts` + `live.ts` to learn how to fetch the slate + odds, and `keeper/create-parlay.ts` for the `create_contest` call shape.
- [ ] Wire: authenticate → fetch today's slate + odds → `buildCard(...)` → `contest_id = hash(dayEpochUTC)` → `lock_ts` = first kickoff, `settle_after_ts` = last kickoff + buffer → `create_contest(...)` with `entry_price = CARD_ENTRY_LAMPORTS`, `fee_bps = 0`.
- [ ] Idempotency: if the contest PDA already exists, log and exit 0.
- [ ] `--dry-run` flag prints the composed card without sending a tx.

### Task 2.3: Validate against live devnet data (dry-run)
- [ ] Run `create-daily-card --dry-run` against the live TxLINE slate; confirm it emits a sane 6-leg card (real teams, sensible markets, no blowout legs). Capture the output in the PR notes.

---

## Phase 3 — Engine `/api/card`

### Task 3.1: Endpoint
**Files:**
- Modify: `engine/src/routes.ts` (add `GET /api/card`)
- Modify: `engine/src/chain.ts` (helper: today's card by `contest_id`, reusing `readLiveContests` + catalog/name joins)

- [ ] Read `routes.ts` `/api/contest/live` to mirror its join logic.
- [ ] `GET /api/card` returns: `{ contestId, status, lockTs, settleAfterTs, entryPrice, pot, jackpot, legs: [{ fixtureId, home, away, kickoffTs, marketId, label, group, line, buckets }] }`.
- [ ] Manual check: `curl /api/card` returns the dry-run card once it's created on devnet.

### Task 3.2: Web API client
**Files:**
- Modify: `web/src/lib/api.ts` (add `getCard()` + the `Card`/`CardLeg` types)
- [ ] `tsc` clean.

---

## Phase 4 — Web: single daily card

### Task 4.1: Reskin `SweepstakeView` to one card with states
**Files:**
- Modify: `web/src/components/SweepstakeView.tsx`
- Modify: `web/src/App.css` (port the mockup styles: grouped match blocks, option buttons, pot hero, the 24h cycle line)
- Reference: `mockups/8-pre-blank.html` (blank), `6-pre-game.html` (filled), `5-daily-live.html` (live), `7-after-game.html` (after)

- [ ] Render the four states off `card.status` + lock/settle timestamps + the user's entry: **blank** (option buttons, 0/6, disabled CTA), **filled/locked** (your picks, locked countdown), **live** (per-leg hit/live/miss from leg results), **after** (settled — perfect → claim; else "so close").
- [ ] Group legs by match; copy reads "settles when the last match ends · fresh card every 24h".

### Task 4.2: Enter + claim
**Files:**
- Modify: `web/src/components/SweepstakeView.tsx`
- [ ] Wire `buildEnterTx` (6 picks) on lock-in and `buildClaimContestTx` on the after-state. Reuse `usePrivySigner`.
- [ ] Show lock countdown; disable entry after `lockTs`.

### Task 4.3: Verify in preview
- [ ] With engine serving `/api/card` (devnet card), run the web preview; verify blank → fill → lock-in flow renders and a real `enter` tx lands. Screenshot the blank + filled states.

---

## Phase 5 — Settlement scheduling

### Task 5.1: Daily create + last-whistle settle
**Files:**
- Create: `engine/keeper/cron.ts` (or document the system cron entries)
- Reuse: `engine/keeper/settle.ts`, `settle-contest.ts`

- [ ] Schedule `create-daily-card` daily (08:00 UTC).
- [ ] Schedule a settle pass that, when TxLINE reports all of a card's legs at full-time, settles each leg then calls `settle_contest`; rollover happens automatically on zero perfect.

### Task 5.2: End-to-end devnet test
- [ ] Create a card on a real fixture day, enter from a test wallet, let the legs settle (or settle a finished fixture), `claim_contest`. Confirm payout (or rollover into jackpot). Record signatures.

---

## Phase 6 — Demo polish

### Task 6.1: Headline + proofs
- [ ] Jackpot headline + rollover ("rolled over N days"), on-chain proof links per leg (explorer), the 24h cycle copy.

### Task 6.2: Demo flow
- [ ] Write the 5-min demo script: blank card → pick 6 → lock in $0.02 → (settled fixture) → claim / rollover, narrating TxLINE proof settlement. Verify the whole flow once start-to-finish.

---

## Notes
- DRY/YAGNI: reuse existing instructions and readers; the only program change is the leg-count bump.
- Gated steps (devnet redeploy 1.3) require explicit user confirmation before running.
- Keep `fee_bps = 0` and `CARD_ENTRY_LAMPORTS = 0.02 SOL` until the user says otherwise.
