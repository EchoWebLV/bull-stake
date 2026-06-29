# Streak — Daily Rolling Sweepstake (perfect-parlay jackpot) — Design Spec

**Date:** 2026-06-29
**Status:** Revised after design review + data-feasibility probe (2026-06-29); pending spec review → implementation plan.
**Promotes:** §13.1 "Daily Streak Contest" of [2026-06-28-streak-onchain-parimutuel-design.md](2026-06-28-streak-onchain-parimutuel-design.md) from roadmap to **headline / main feature**.
**Depends on:** the parimutuel core — `programs/proofbet` (vault-escrow + pro-rata patterns), `keeper/` (TxLINE `validateStat` settlement, green on devnet), `engine/` (Fastify + TxLINE relay; `catalog.ts:fetchSlate` rolling-window fetch), `web/` (Vite PWA, Privy signing). Program id `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`.
**Relationship to the secondary feature:** the tradeable per-match LMSR prediction market is **parked** at [../secondary-prediction-market.md](../secondary-prediction-market.md). This sweepstake is the **main** product; the existing per-match parimutuel board becomes the **second** tab.

### Revision history
- **v2 (2026-06-29):** Folded in a 5-lens adversarial design review + an empirical TxLINE match-supply probe. Material changes: (1) **rolling next-N-kickoffs card**, not a strict UTC calendar day; (2) **adaptive card size** (floor 3 / target 4 / cap 5) with an explicit **skip-on-thin → pot persists** rule; (3) **competition scope is a config allow-list** (World Cup for v1; year-round needs a broader feed — a data-entitlement step, not code); (4) **vault rent-floor netting** so draining to dust can't brick the singleton vault; (5) **per-contest solvency cap** (`claimed_total`/`claimed_count`) bounding a bad `perfect_count`; (6) **settlement bound to the card's result-market PDAs** (re-derived + checked), making "verified" true; (7) **rake moved off "payout only"** to **5% of each contest's new entries at settle** (always-on, never taxes the rolled-in pot); (8) misc safety fixes (deterministic new-ticket detection, stored `distributable`, `sub/add_lamports` for program-owned vault transfers, one-live-contest guard, array-tail guard).
- **v1 (2026-06-29):** Initial design (persistent vault + per-day contest + per-ticket entry; perfect-parlay-splits-or-rolls; multi-ticket).

---

## 1. Overview

**The daily sweepstake is a perfect-parlay jackpot.** A keeper opens a contest roughly once a day over a **rolling card of the next 3–5 matches** (target 4) on a sliding ~36h window. Anyone enters for a fixed **0.02 SOL per ticket** and submits one **1X2 pick** (Home / Draw / Away) per match — and may buy **multiple tickets** to cover more scenarios. After the last carded match settles:

- **Someone went perfect** (all picks correct) → all perfect cards **split the pot equally**.
- **Nobody went perfect** → the pot **rolls over** into the next contest. The jackpot grows.

A 5% rake is taken on **each contest's new entries** (always-on, win or roll); the **rolled-in pot is never taxed again**. This is a contest-a-day with a growing pot — the purest expression of the "Streak" name, and a sharper hook than the per-match board (one shared pot, one ritual, a number that climbs until someone cracks it).

This iteration adds a **new on-chain construct** (jackpot vault + per-contest record + per-ticket entries) and a **new front-end tab**, while reusing `proofbet`'s escrow/claim patterns, the TxLINE settlement keeper, the engine relay + `fetchSlate`, and the Privy signing path.

### Goals
- A user can: open the app → see the current card + the live jackpot → pick 1X2 on each match → pay 0.02 SOL per ticket (one or more) → watch a live "still alive" board as matches settle → claim a split if perfect, or see it roll over.
- The pot **rolls between contests for free** (it simply stays escrowed), with a visible "rolled N days" / "paused" badge.
- **Real-SOL mechanics on devnet** — actual escrow, actual split, actual rollover (not play-money).
- Reuse the proven escrow + settlement + slate plumbing; the only genuinely new code is the contest program + the contest tab/engine routes.

### Non-goals (this iteration)
- The tradeable LMSR per-match market — parked ([../secondary-prediction-market.md](../secondary-prediction-market.md)).
- A full global leaderboard and friend leagues — roadmap (§14).
- Fully trustless winner-set / divisor (merkle or on-chain registration) — designed as a hardening path (§9), not built in v1.
- A forced rolldown / pot cap for runaway rollovers — roadmap (§16).
- Mainnet, USDC collateral, fiat on-ramp, legal/compliance — roadmap (§14, §16).

## 2. Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Headline product | **Daily rolling perfect-parlay sweepstake** | One shared pot + a daily ritual + a growing jackpot beats the per-match board as the hook. |
| Win condition | **Perfect parlay splits the pot; else it rolls** | "Split or it rolls" — the locked decision. Rollover is the retention engine. |
| Pick type | **1X2 per match (Home / Draw / Away)** | Reuses the 3-way bucket model in `ResultSelector`; provable via `goals1 − goals2`. |
| Card model | **Rolling next-N kickoffs in a sliding ~36h window** (not a strict UTC day) | Real fixture data is lumpy (§10): a calendar-day card is infeasible >half the days. The engine's `catalog.ts:fetchSlate` already does exactly this rolling fetch. |
| Card size | **Adaptive: floor 3 / target 4 / cap 5**, chosen at create-time from the window | Data ranges 1–8 matches/window; a fixed 4 reverts on thin days. Sub-floor cards are forbidden (a 1–2 match card makes a perfect parlay common and drains the jackpot). |
| Thin-window rule | **< 3 in-scope fixtures → keeper skips; pot persists** | No silent revert; the vault just carries (rollover-for-free). UI shows "paused — N rolled days". |
| Competition scope | **Config allow-list; World Cup for v1** | Year-round supply needs a broader TxODDS entitlement (a data/licensing step, not code). Scope is a setting so widening later is config, not a rewrite. |
| Card curation | **Auto-picked by the keeper, biased toward uncertainty** | No manual ops; uncertain matches make perfect parlays rarer → bigger rollovers. |
| Entry price | **0.02 SOL per ticket, fixed per contest** | Cheap, casual; locked range was 0.02–0.03. |
| Tickets per wallet | **Multiple allowed** (`nonce`-keyed entries) | Buy more lines to cover more scenarios. It's a **stake-weighted** lottery (§8): more tickets = more chances; a duplicate of the winning line genuinely buys a second share. |
| Collateral | **Native SOL / lamports** | Reuses `proofbet`'s lamport escrow; "vault balance IS the jackpot" works cleanly only with native lamports. |
| Rake | **5% of each contest's new entries, at settle (win or roll); rolled-in pot never taxed** | "Payout-only" was perverse (zero revenue on the common no-winner day; operator aligned against anyone winning; unbounded retroactive tax on the whole pot). This is always-on and only ever taxes new money once. |
| Economic split | **Equal split among perfect tickets** | `floor(distributable / perfect_count)` each; dust rolls forward. |
| On-chain shape | **A — persistent `JackpotVault` PDA + per-contest `Contest` + per-ticket `Entry`** | Rollover = the vault balance persists; one contest live at a time, enforced on-chain (§4–§6). |
| Settlement trust | **Winning buckets verified from the card's settled result-market PDAs; `perfect_count` keeper-supplied but blast-radius-capped** | "Verifiable, not trustless"; the cap makes deferring the trustless divisor honest (§9). |
| Network | **devnet, real-SOL mechanics** | Real escrow/split/rollover; mainnet + legal are roadmap. |
| Nav | **New "Sweepstake" tab, first; per-match board moves to second ("Markets")** | The sweepstake is the main product; markets are secondary but kept. |

### Honest framing (inherited house rule)
The program never calls Txoracle directly. The keeper resolves each match from a TxLINE Merkle proof (`validateStat.view()`) and settles the per-match result markets; `settle_contest` then **reads the winning bucket from those program-owned, settled market PDAs** (re-derived and checked, §6.3/§9). The only keeper-trusted value is `perfect_count`, which is **capped** so a bad value can't drain beyond the contest's own `distributable`. We describe settlement as **"verifiable, single-source, no dispute window"** — **never "trustless."** Full trustlessness of the divisor (a registration window or merkle) is the roadmap item, not a v1 claim.

## 3. Reuse map

**Reused as-is (no code changes):**
- **`proofbet` escrow + claim patterns** — `Vault` PDA holding native lamports, `close = bettor` to return rent + prevent double-claim, `has_one` owner checks, u128 intermediate payout math, **rent-floor-aware** debiting (`claim.rs` only distributes ≤ `total_pool`, never the rent reserve), and program-owned-vault transfers via `sub_lamports`/`add_lamports` (System CPI can't debit a program-owned account — `settle.rs` documents this).
- **Settlement engine** — `keeper/` `validateStat.view()` against the `daily_scores` PDA, terminal/void phase detection (`spike/`). The keeper settles each card match's 1X2 **result market** with the same code used today.
- **`engine/catalog.ts:fetchSlate`** — the rolling-window slate fetch (yesterday+today+tomorrow epoch-days, dedupe by `FixtureId`, `inSlateWindow(now, now+36h)`). The contest card is sourced from this, not a new calendar-day query.
- **`engine/`** — Fastify server, TxLINE auth + live feed relay, on-chain readers (`chain.ts`), market catalog (`catalog.ts`).
- **`web/`** — Vite PWA shell, Privy embedded-wallet signing (`usePrivySigner`), the 1X2 button styling in `ResultSelector.tsx`, the Streak design tokens in `App.css`.

**New build:**
- **Program:** a contest module in `programs/proofbet` — `JackpotVault`, `Contest`, `Entry` accounts + `initialize_vault` / `create_contest` / `enter` / `settle_contest` / `claim_contest` / `void_contest` (§5–§6).
- **Engine:** `/api/contest` routes + a contest reader over the new accounts (§11); a **competition allow-list** config replacing the hard-coded `Competition === "World Cup"` filter in `catalog.ts`.
- **Keeper:** a daily job that builds the adaptive card from `fetchSlate`, calls `create_contest`, and after the last match calls `settle_contest` (§12).
- **Web:** a `SweepstakeView` tab + the `BottomNav` change (§13).

**Roughly 70% reused.** The genuinely new core is the contest program (escrow that *persists across days*) and the contest tab.

## 4. On-chain architecture — approaches

**A — Persistent jackpot vault + per-contest accounts ✅ (chosen).**
One long-lived `JackpotVault` PDA holds the rolling pot; its lamport balance (above the rent floor) **is** the jackpot and persists across contests. Each contest gets a `Contest` account (card + economics + result) and each player one `Entry` per ticket. Rollover is free — on a no-winner contest nothing leaves the vault, so the next pot starts where this one ended. Reuses the escrow/claim patterns. *All five review lenses confirmed A is the correct, simplest shape; B and C below were rejected.*

**B — Per-contest vault, transfer on rollover.** Each contest owns its vault; rollover = CPI-transfer the balance forward. An extra cross-account transfer on the common (rollover) path, no benefit since only one contest is live. ❌

**C — Reuse the per-match 1X2 pools as the contest.** No separate pot exists to roll, and it conflates the two products. We *do* reuse those markets' settled **results** as the oracle (§9) — just not as the pot. ❌

## 5. Accounts

All PDAs program-owned. Lamport math reuses `proofbet`'s rent-floor-aware patterns. `MAX_MATCHES = 5`.

### 5.1 `JackpotVault` (singleton)
```
seeds = ["jackpot_vault"]
struct JackpotVault {
  active_contest_id: u64,   // 0 = none live; enforces one contest at a time
  bump: u8,
}                            // jackpot = lamports − rent_floor; not a field
```
A program-owned escrow whose balance (net of its own rent-exempt minimum) is the rolling jackpot. Created **once** via `initialize_vault` (plain `init`, payer = keeper — no `init_if_needed` footgun). Its lamports persist across every contest — **this persistence is the rollover.** `active_contest_id` makes "one contest at a time" an on-chain invariant, not just a keeper convention.

> **Rent floor.** The vault's own rent-exempt minimum (`Rent::minimum_balance(8 + JackpotVault::INIT_SPACE)`) is **never** part of the pot. Every pot read nets it out and every debit (`settle` rake, `claim` payout/refund) asserts `vault.lamports ≥ rent_floor` afterward. Without this, "distribute down to dust" would push the singleton below rent and the runtime would garbage-collect it mid-claim-cycle.

### 5.2 `Contest` (one per contest)
```
seeds = ["contest", contest_id.to_le_bytes()]   // contest_id = epoch day at open (u64), unique id
struct Contest {
  contest_id:       u64,          // epoch day at open; a unique deterministic id (card may cross midnight)
  settle_authority: Pubkey,       // keeper; has_one on settle/void
  fee_recipient:    Pubkey,       // rake destination
  fixtures:         [i64; 5],     // card fixture ids; first `num_matches` valid, rest 0
  num_matches:      u8,           // 3..=5, chosen from the rolling window at create-time
  entry_price:      u64,          // lamports (e.g. 0.02 SOL)
  lock_ts:          i64,          // entries close (first kickoff on the card)
  settle_after_ts:  i64,          // earliest settle time (latest kickoff + buffer); liveness guard
  fee_bps:          u16,          // 500 = 5%; <= MAX_FEE_BPS (1000)
  status:           ContestStatus,// Open | Settled | RolledOver | Voided
  winning_buckets:  [u8; 5],      // 0=Home 1=Draw 2=Away; first `num_matches` valid
  entry_count:      u64,          // # tickets entered (drives new-entry rake + void refund total)
  perfect_count:    u64,          // # perfect tickets; the split divisor (keeper-supplied, capped)
  pot_snapshot:     u64,          // net pot (vault.lamports − rent_floor) captured at settle
  distributable:    u64,          // pot_snapshot − rake, stored at settle so every claim reads one value
  claimed_count:    u64,          // # claims paid so far (caps payouts at perfect_count)
  claimed_total:    u64,          // lamports paid out so far (caps payouts at distributable)
  settled_ts:       i64,
  bump:             u8,
}
enum ContestStatus { Open, Settled, RolledOver, Voided }
```
`contest_id = epoch_day` at open is a deterministic unique id (derive the address without a registry); the card itself is a **rolling window** that may span past midnight.

### 5.3 `Entry` (one per ticket: wallet + contest + nonce)
```
seeds = ["entry", contest.key(), bettor.key(), nonce.to_le_bytes()]
struct Entry {
  bettor:  Pubkey,
  contest: Pubkey,
  nonce:   u64,       // ticket index for this wallet in this contest (0, 1, 2, …)
  picks:   [u8; 5],   // 0/1/2 per match; first `num_matches` valid, rest forced 0
  amount:  u64,       // lamports paid (= contest.entry_price at entry time)
  bump:    u8,
}
```
A wallet may hold **multiple tickets**: each `nonce` is a distinct `Entry` PDA = a distinct ticket = a distinct payment. The client assigns `nonce` sequentially. Created via `init_if_needed`; a brand-new ticket is detected deterministically (`entry.bettor == Pubkey::default()`), so the **same** `nonce` re-`enter` edits picks without paying again, while a **new** `nonce` is a new ticket and a new payment. Closed on `claim_contest` (rent back to bettor; blocks double-claim per ticket).

## 6. Instructions

### 6.0 `initialize_vault()`
- Signer: **keeper** (payer). One-time `init` of the singleton `JackpotVault` (`active_contest_id = 0`). Plain `init`, not `init_if_needed` — removes the genesis race / feature-flag footgun and makes the rent funder explicit.

### 6.1 `create_contest(contest_id, fixtures, num_matches, entry_price, lock_ts, settle_after_ts, fee_bps)`
- Signer: **keeper** (becomes `settle_authority`). Takes the `JackpotVault` as a seeds+bump-constrained account.
- Requires `vault.active_contest_id == 0` (no live contest); sets it to `contest_id`. Inits the `Contest` (status `Open`). The pot starts from whatever is **already in the vault** (rollover) — no transfer.
- Validates `3 <= num_matches <= 5`, `fee_bps <= MAX_FEE_BPS`, `entry_price > 0`, `now < lock_ts < settle_after_ts`, and `fixtures[i] != 0` for `i < num_matches`.

### 6.2 `enter(nonce, picks)`
- Signer: **player.** Requires `status == Open` and `now < lock_ts` (else `EntryClosed`).
- Validates `picks[i] < 3` for `i < num_matches` **and** `picks[i] == 0` for `i >= num_matches` (array-tail guard).
- `init_if_needed` the `Entry` at `["entry", contest, bettor, nonce]`. **New-ticket detection is by sentinel** (`entry.bettor == Pubkey::default()`), not by reading mutable state:
  - **New** (`bettor` unset): set `bettor`/`contest`/`nonce`/`amount`, transfer `entry_price` player→`JackpotVault`, increment `entry_count`, write `picks`.
  - **Edit** (already initialized): require `has_one = bettor` and `now < lock_ts`; **overwrite `picks` only** — no payment, no `entry_count` change.

### 6.3 `settle_contest(perfect_count)` — winning buckets read on-chain
- Signer: **keeper** (`has_one = settle_authority`). Requires `status == Open` and `now >= settle_after_ts`.
- **Winning buckets are not a parameter.** Pass exactly `num_matches` result-market accounts as remaining accounts. For each `i < num_matches`, the program **re-derives** the expected market PDA from `["market", contest.fixtures[i].to_le_bytes(), RESULT_MARKET_ID.to_le_bytes()]`, asserts `remaining_accounts[i].key() == that PDA`, `owner == this program`, `status == Settled`, `num_buckets == 3`, then **copies** that market's `winning_bucket` into `contest.winning_buckets[i]`. This binds the result to the card's actual fixtures (a shadow market can't be substituted). The all-markets-Settled requirement is also the real liveness gate.
- `pot_snapshot = vault.lamports − rent_floor`.
- **Rake (new-entries only):** `rake = (entry_count * entry_price) * fee_bps / 10000`, taken at settle on **both** Settled and RolledOver outcomes, paid vault→`fee_recipient` via `sub_lamports`/`add_lamports`, `fee_recipient` pinned by `address = contest.fee_recipient`. The rolled-in pot is never taxed (only this contest's new stakes). Assert `vault.lamports ≥ rent_floor` after the debit.
- If `perfect_count == 0` → `status = RolledOver`. The net remainder (`pot_snapshot − rake`) stays and carries forward. `distributable = 0`.
- Else → `status = Settled`. `distributable = pot_snapshot − rake`, stored on the `Contest`.
- Records `winning_buckets`, `perfect_count`, `pot_snapshot`, `distributable`, `settled_ts`; clears `vault.active_contest_id = 0`.

### 6.4 `claim_contest()`
- Signer: **player.** Requires a **terminal** status (`Settled`, `RolledOver`, or `Voided`). One instruction handles payout, refund, and rent-only close.
- Branches by status; payouts are computed from **stored** `distributable` (never live `vault.lamports`):
  - **Settled + perfect** (`entry.picks[i] == winning_buckets[i]` for all `i < num_matches`, verified on-chain) → `require!(perfect_count > 0)`; `payout = distributable / perfect_count` (u128 intermediate). **Solvency cap:** require `claimed_count < perfect_count` **and** `claimed_total + payout <= distributable`; then `claimed_count += 1`, `claimed_total += payout`, transfer vault→player, assert `vault.lamports ≥ rent_floor` after.
  - **Settled + not perfect** → no payout; close only.
  - **RolledOver** → no payout (stake is in the rolled-forward pot); close only.
  - **Voided** → refund `entry.amount` vault→player (assert rent floor after).
- `has_one = bettor` and `close = bettor` (mirrors `claim.rs`): only the ticket owner can claim, rent returns to them, and a second claim fails with `AccountNotInitialized`. The cap means a too-low `perfect_count` can at worst over-pay early claimers up to `distributable` — it can **never** reach another contest's funds or the rent floor.

### 6.5 `void_contest()` (abandoned card)
- Signer: **keeper** (`has_one`). If any card match is abandoned/void (no provable result), set `status = Voided` and clear `vault.active_contest_id = 0`. No rake on void.
- Each ticket then calls `claim_contest` → **refund `entry.amount`** (the actually-paid field, not a recomputed total), close entry. The **rolled-in** portion stays in the vault and carries forward.

## 7. Contest lifecycle & rollover

```
(genesis)    initialize_vault()        active_contest_id = 0
day N        create_contest(N)         status=Open, pot = vault balance (rollover); active = N
  …          enter / re-enter           until lock_ts (first kickoff on the card)
  …          carded matches play → each match's result market settles
>= settle    settle_contest(N)          reads winning buckets from those markets; rake on new entries
               ├─ perfect_count == 0 → RolledOver   (net remainder carries)
               └─ perfect_count >  0 → Settled       (distributable stored for claims)
  …          claim_contest               perfect tickets split; others close for rent; active → 0
(thin gap)   < 3 in-scope fixtures      keeper SKIPS create_contest; pot persists ("paused")
next         create_contest(N+k)        pot = whatever's left in the vault
```
The vault is the single source of continuity: **rollover is just "don't move the money."** A winning contest distributes the pot down to dust; the next starts from that dust (plus new entries). A no-winner contest carries the net pot forward. A thin window opens no contest at all — the pot simply waits.

## 8. Economics

- **Entry:** fixed `entry_price` (0.02 SOL) **per ticket**, escrowed into the vault; a wallet may buy multiple tickets, each a separate `Entry`.
- **Multi-ticket = stake-weighted lottery (honest framing).** Only the line matching the one real outcome is perfect. Distinct cards covering *different* scenarios give you more **chances** (at most one of them can win → one share). A **duplicate** of the winning card genuinely buys a **second share** (it was paid for; there's no on-chain dedupe). So: more tickets = more chances, and stacking copies of one scenario scales your slice of that scenario. We describe it as a stake-weighted lottery — not "extra tickets never enlarge your slice."
- **Rake:** `(entry_count * entry_price) * fee_bps / 10000` (5% of this contest's new entries), taken at settle on **win or roll**, never on the rolled-in pot. Always-on revenue; no perverse "operator wants no winner" incentive; no retroactive tax on the accumulated jackpot. No rake on void.
- **Split:** each perfect ticket claims `floor(distributable / perfect_count)`, where `distributable = pot_snapshot − rake` (stored at settle).
- **Solvency invariant:** enforced on-chain per contest — `claimed_count ≤ perfect_count` and `claimed_total ≤ distributable ≤ pot_snapshot ≤ vault.lamports − rent_floor`. A bad `perfect_count` (§9) cannot exceed `distributable` or touch the rent floor / other contests. Dust (floor remainder) stays escrowed and rolls forward.
- **Void:** refunds `Σ entry.amount` (= `entry_count * entry_price`); the rolled-in remainder stays in the vault.

## 9. Settlement source of truth & trust model

The keeper influences two things at settle; they now have very different trust profiles:

- **Winning buckets — verified on-chain (v1).** `settle_contest` does **not** accept buckets as a parameter. It re-derives each card fixture's result-market PDA from `contest.fixtures[i]`, requires it is program-owned, `Settled`, and 3-bucket, and copies its `winning_bucket` (§6.3). Because the PDA is derived from the contest's own fixtures, the keeper cannot point at a shadow market — "verified against on-chain settlements" is now literally true. The keeper's only settlement job is to settle those per-match result markets (the same proof path used today) and then call `settle_contest`.
- **`perfect_count` — keeper-supplied but blast-radius-capped.** It still can't be computed in one instruction (it requires scanning every `Entry`), so the keeper counts off-chain and supplies it. The risk is asymmetric: too **high** → winners under-paid, surplus rolls forward (safe); too **low** → winners over-draw. The **per-contest solvency cap** (`claimed_count ≤ perfect_count`, `claimed_total ≤ distributable`, §6.4/§8) bounds the worst case to "early claimers over-paid up to this contest's `distributable`" — never cross-contest insolvency, never the rent floor. This cap is what makes deferring full trustlessness honest.
  - **Hardening (roadmap, not v1):** a two-phase settle — phase 1 records verified `winning_buckets`; a **registration window** lets each perfect entry call `register_win` (on-chain increment = trustless count); then claims pay `distributable / perfect_count`. A **merkle root** of the winner set is the wrong tool here (winners are few and Entries already exist on-chain; the root still needs the off-chain scan you're trying to remove). Explicitly deferred.

This is the "verifiable, single-source, detectable-not-trustless" posture from §2.

## 10. Card curation, supply & scope

### 10.1 Match supply (validated against live data, 2026-06-29)
A probe of the live TxLINE feed (devnet) over a 23-day window returned **78 World Cup + 3 friendly** fixtures. Matches per UTC calendar day ranged 1–8; **only 43% of days had ≥4, 78% had ≥3**, and the day of the probe had just 2 — **below** a fixed floor of 3. Conclusions:
- A **strict calendar-day card is infeasible** (>half the days). The **rolling next-N-kickoffs window** (the next 4 kickoffs already span ~24h) is the fix and is already implemented in `catalog.ts:fetchSlate`.
- The **density figures are demo-feed-specific** (accelerated, front-loaded World Cup group stage thinning to a near-empty knockout tail), not a production SLA.
- **Outside the World Cup, the free devnet tier carries essentially nothing.** Year-round supply (global soccer plays nearly every day across overlapping confederation seasons) requires a **broader TxODDS entitlement** — a data-licensing step, not engineering. The only genuinely thin window (European summer) is covered by South-American / North-American / Nordic / Asian leagues + international tournaments.

### 10.2 Curation (auto-pick by keeper)
- Source the card from `fetchSlate(now, now+~36h)` — the rolling window, **not** a calendar-day query.
- **Competition scope = config allow-list** (default `["World Cup"]` for v1; widen via config when a broader feed is available). This replaces the hard-coded `Competition === "World Cup"` filter in `catalog.ts:106`.
- **Adaptive size:** let `k` = count of in-scope fixtures in the window. If `k < 3` → **skip** (no `create_contest`; the pot persists; UI shows "paused — N rolled days"). Else `num_matches = min(5, k)` (target 4 when `k ≥ 4`).
- **Bias toward uncertainty:** among in-scope fixtures, rank by how close the 1X2 implied probabilities are to even (lowest favourite-probability / highest entropy from the odds feed); take the top `num_matches`. Uncertain matches make a clean sweep rarer → bigger rollovers.
- Ensure a per-match **result market** exists for each chosen fixture (create if missing) so the verified-settlement path (§9) applies.
- Set `lock_ts` = earliest kickoff on the card; `settle_after_ts` = latest kickoff + buffer.

## 11. Engine (`engine/`)

New `/api/contest` surface (reads on-chain accounts via `chain.ts`; no custody):
- `GET /api/contest/today` → the live `Contest`: card fixtures (+ team names/kickoffs from the feed), `entry_price`, `lock_ts`, `status`, live **pot** (`vault.lamports − rent_floor`), **rolled-days / paused** state, `entry_count`.
- `GET /api/contest/entries?wallet=…` → that wallet's `Entry` tickets for the live contest (each with `nonce`, picks, amount); empty if none.
- `GET /api/contest/alive` → the live **"still alive"** board: how many picks are still correct given matches settled so far (aggregate for v1; per-wallet detail for the signed-in user).

New config: `COMPETITION_ALLOWLIST` (env, default `["World Cup"]`) consumed by `catalog.ts` (replaces the hard-coded filter). Live match state still flows through the existing TxLINE relay. The engine never holds user funds — `enter`/`claim_contest` are signed client-side by the Privy wallet.

## 12. Keeper (`keeper/`)

A daily job (the existing keeper process, extended):
- **Open:** build the adaptive card from `fetchSlate` + the allow-list (§10); if `< 3` in-scope fixtures, **skip**. Else ensure per-match result markets exist and call `create_contest(epoch_day, …)`.
- **After last full-time (`now >= settle_after_ts`):** settle each card match's result market via the existing `validateStat` path, count perfect entries off-chain, call `settle_contest(perfect_count)` with the card's result-market accounts (or `void_contest` if a match abandoned).
- Reuses the keeper's TxLINE auth, phase detection, and `settle` plumbing; only the contest create/settle calls + adaptive card-build are new.

## 13. Frontend (`web/`)

### 13.1 Navigation change
`BottomNav.tsx` / `App.tsx`: `Tab` becomes `"sweepstake" | "markets" | "bets" | "wallet"`.
- **Sweepstake** — **first** tab, the default landing tab.
- **Markets** — the current per-match board (`MatchList`), relabeled "Live" → "Markets", moved to **second**.
- **My Bets** and **Wallet** — unchanged.

### 13.2 `SweepstakeView` (new)
- **Jackpot header:** the live pot + a "rolled N days" / "paused — no card today" badge + a countdown to `lock_ts`.
- **Today's card:** one row per match (teams, kickoff) with **1X2 pick buttons** (reuse `ResultSelector`'s styling; picks, not odds — no per-pick multiplier).
- **Entry / tickets:** "Enter — 0.02 ◎" signs `enter(nonce, picks)`. A wallet can hold **multiple tickets** — "+ Add another ticket" opens the next `nonce`; each ticket stays editable until lock (re-`enter` same `nonce`, no second charge). After `lock_ts` the card locks; the view lists the wallet's tickets with each one's live status.
- **Live "still alive" board:** how many of your picks are still alive and how many entries remain in contention; a clear win/rolled-over result at the end.
- **Streak chip:** the user's consecutive-day participation/correct streak.
- **Share card:** a shareable image/route of the user's card + result.

Claiming a split (or void refund) happens via `claim_contest`, surfaced here after settlement (and/or My Bets).

## 14. Scope & milestones (YAGNI)

Build as vertical slices; everything past M0 is additive.

### Milestone 0 — walking skeleton
**One contest, the full lifecycle on devnet, through the real UI — with the safety must-fixes built in from day one.**
- Program: `JackpotVault` (rent-floor-aware, one-live-contest guard) + `Contest` (with `distributable`/`claimed_*` accounting) + `Entry` (`nonce` seed, sentinel new-ticket detection), `initialize_vault` / `create_contest` / `enter` / `settle_contest` (verified buckets + new-entry rake + solvency cap) / `claim_contest`, deployed to devnet.
- Keeper: scripted `create_contest` for one card (auto-pick can be a fixed list in M0; adaptive build is M1), `settle_contest` after the matches.
- Engine: `GET /api/contest/today` + `entries`; `COMPETITION_ALLOWLIST` config.
- Web: `SweepstakeView` (jackpot header, card with 1X2 picks, enter one ticket, claim) + the nav change. "+ Add another ticket" UI is M1.
- Demo (~90s): land on Sweepstake → see pot → pick 4 → enter 0.02 ◎ → matches settle → either split-and-claim or watch it roll forward.

### Milestone 1+ — widen (in order)
Adaptive card from `fetchSlate` + skip-on-thin → multi-ticket UI → live "still alive" board → `void_contest` refund path → streak chip + share card → rolled-days/paused badge polish.

### Out (this iteration)
Trustless `perfect_count` (registration window / merkle), forced rolldown / pot cap, full leaderboard/friend leagues, mainnet, USDC, fiat on-ramp, broader-than-World-Cup competition feed (data-entitlement step).

## 15. Testing

**Anchor (program):**
- `enter` escrows `entry_price`; re-`enter` the **same `nonce`** before lock overwrites picks **without** a second charge or an `entry_count` change.
- Multi-ticket: same wallet, two **different** `nonce`s → two `Entry` PDAs, two payments, `entry_count == 2`.
- `enter` after `lock_ts` rejects (`EntryClosed`); array-tail guard rejects `picks[i] != 0` for `i >= num_matches`.
- `settle_contest` reads buckets from the bound result-market PDAs; **a wrong/foreign market account is rejected** (PDA mismatch / owner / not-Settled / wrong num_buckets); requires exactly `num_matches` accounts.
- `settle_contest` rake = 5% of `entry_count * entry_price` only; **the rolled-in pot is untaxed** (settle after a rollover taxes only the new entries).
- `perfect_count == 0` → `RolledOver`, net remainder carries; `active_contest_id` cleared.
- **Rent-floor:** distribute a contest down to dust (all entries to one perfect ticket) → vault stays ≥ rent floor and remains claimable; never GC'd.
- **Solvency cap:** an over-reported `perfect_count` under-pays and rolls surplus; an under-reported `perfect_count` cannot pay beyond `distributable` (cap rejects the over-draw) — no cross-contest reach.
- `claim_contest` pays `distributable / perfect_count` to a perfect ticket; rejects a non-perfect ticket's payout; payout reads stored `distributable`, not live balance.
- Multi-ticket payout: a wallet with several distinct lines collects exactly **one** share; a **duplicate** of the perfect card collects **two**.
- Double-claim blocked (entry closed); two perfect winners each get the split, dust ≤ `perfect_count` lamports remains.
- `void_contest` → each ticket refunds `entry.amount`; rolled-in remainder stays; no rake taken.
- Conservation: `Σ payouts + rake + dust == pot_snapshot` (Settled); `Σ refunds == entry_count * entry_price` (Voided).
- One-live-contest: `create_contest` rejects while `active_contest_id != 0`.

**Engine/keeper:** unit tests for the contest reader, `/api/contest/*` shapes, the allow-list filter, the adaptive card-build (`k<3` → skip; `k≥4` → 4; `k>5` → cap 5), uncertainty ranking, and the perfect-count counter.

**Web:** typecheck + preview — nav shows Sweepstake first; card picks, enter, locked state, paused state, and claim render correctly.

## 16. Risks & honest posture

- **Settlement trust (now mostly closed):** winning buckets are verified from bound result-market PDAs (§9); `perfect_count` stays keeper-supplied but is blast-radius-capped — framed **verifiable, not trustless**, with the registration-window/merkle hardening designed.
- **Runaway rollover (the real economic tail):** perfect-parlay odds are brutal (~(1/3)⁴ ≈ 1.2% per 4-match card), so the pot can roll for many days. v1 is all-or-nothing (the lottery hook); a **forced rolldown / pot cap after N rollovers** (pay the best near-perfect tier) is the roadmap softener and revenue event. Flagged, not built.
- **Data supply / scope:** the free devnet tier is World-Cup-only; year-round operation needs a broader TxODDS entitlement (a business/licensing step). Scope is a config allow-list so widening is a setting (§10).
- **Legal:** real-money contest → jurisdictional exposure; devnet-only this iteration, framed as a verifiable-settlement demo. Mainnet needs legal review.
- **Cold-start pot:** early contests have a small pot until rollovers accumulate (the rollover mechanic is exactly the fix); an optional genesis seed deposit is a lever.
- **Card liveness:** an abandoned card match routes to `void_contest` (full refunds); no funds stuck.
- **Keeper availability:** a stalled keeper delays settle/claim (detectable, not forgeable). Production posture is a multisig `settle_authority`.
- **Token safety:** TxLINE API token stays in the engine/keeper, never shipped to the client.

## 17. Relationship to the secondary feature

The per-match tradeable LMSR market is **parked** ([../secondary-prediction-market.md](../secondary-prediction-market.md)) and **not** built here. The existing per-match **parimutuel** board stays live as the **second ("Markets")** tab. Both products share the TxLINE settlement engine, Privy signing, design language, and the per-match **result markets** — which the sweepstake also consumes as its settlement oracle (§9).

## 18. Open decisions
- **Rake model** — adopted: **5% of each contest's new entries, at settle (win or roll)**. (Alternatives considered: skim-at-entry — rejected for void-refund cleanliness; payout-only — rejected as perverse.) Confirm.
- **Rollover tail** — adopted for v1: **all-or-nothing, roll forever**, with a forced rolldown as roadmap (§16). Confirm.
- **Competition scope** — v1 **World Cup** (config allow-list); year-round needs a broader feed (business step). Confirm.
- `entry_price` 0.02 SOL; `num_matches` target 4 (adaptive 3–5); uncertainty metric (favourite-probability vs entropy) — pick at implementation.
- Whether to seed the genesis vault with a small starting pot for the first demo.
