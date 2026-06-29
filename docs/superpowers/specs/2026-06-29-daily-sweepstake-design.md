# Streak — Daily Rolling Sweepstake (perfect-parlay jackpot) — Design Spec

**Date:** 2026-06-29
**Status:** Approved (design); pending spec review → implementation plan
**Promotes:** §13.1 "Daily Streak Contest" of [2026-06-28-streak-onchain-parimutuel-design.md](2026-06-28-streak-onchain-parimutuel-design.md) from roadmap to **headline / main feature**.
**Depends on:** the parimutuel core — `programs/proofbet` (vault-escrow + pro-rata patterns), `keeper/` (TxLINE `validateStat` settlement, green on devnet), `engine/` (Fastify + TxLINE relay), `web/` (Vite PWA, Privy signing). Program id `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`.
**Relationship to the secondary feature:** the tradeable per-match LMSR prediction market is **parked** at [../secondary-prediction-market.md](../secondary-prediction-market.md). This sweepstake is the **main** product; the existing per-match parimutuel board becomes the **second** tab.

---

## 1. Overview

**The daily sweepstake is a perfect-parlay jackpot.** Every day a keeper auto-curates a small **card** of top matches (default **4**, range 3–5). Anyone enters once for a fixed **0.02 SOL** and submits one **1X2 pick** (Home / Draw / Away) per match. After the last match settles:

- **Someone went perfect** (all picks correct) → all perfect cards **split the pot equally** (minus a 5% rake).
- **Nobody went perfect** → the pot **rolls over** into tomorrow's contest. No rake is taken. The jackpot grows.

This is a contest-a-day with a growing pot — the purest expression of the "Streak" name, and a much sharper hook than the per-match board (one shared pot, one daily ritual, a number that climbs until someone cracks it).

This iteration adds a **new on-chain construct** (jackpot vault + per-day contest + per-wallet entry) and a **new front-end tab**, while reusing `proofbet`'s escrow/claim patterns, the TxLINE settlement keeper, the engine relay, and the Privy signing path.

### Goals
- A user can: open the app → see today's card + the live jackpot → pick 1X2 on each match → pay 0.02 SOL once → watch a live "still alive" board as matches settle → claim a split of the pot if perfect, or see it roll over.
- The pot **rolls across days for free** (it simply stays escrowed), with a visible "rolled N days" badge.
- **Real-SOL mechanics on devnet** — actual escrow, actual split, actual rollover (not play-money).
- Reuse the proven escrow + settlement plumbing; the only genuinely new code is the contest program + the contest tab/engine routes.

### Non-goals (this iteration)
- The tradeable LMSR per-match market — parked ([../secondary-prediction-market.md](../secondary-prediction-market.md)).
- Multiple entries per wallet, a full global leaderboard, friend leagues — roadmap (§16).
- Fully trustless winner-set / divisor (merkle or on-chain registration) — designed as a hardening path (§9), not built in v1.
- Mainnet, USDC collateral, fiat on-ramp, legal/compliance — roadmap (§16).

## 2. Key decisions (approved)

| Decision | Choice | Rationale |
|---|---|---|
| Headline product | **Daily rolling perfect-parlay sweepstake** | One shared pot + a daily ritual + a growing jackpot beats the per-match board as the hook. |
| Win condition | **Perfect parlay (all picks correct) splits the pot; else it rolls** | "Split or it rolls" — the locked decision. Rollover is the retention engine. |
| Pick type | **1X2 per match (Home / Draw / Away)** | Reuses the 3-way bucket model already in `ResultSelector`; provable via `goals1 − goals2`. |
| Card size | **4 matches default (3–5 configurable)** | Enough that a perfect parlay is rare (pot rolls and grows) but not impossible. |
| Card curation | **Auto-picked by the keeper, biased toward uncertainty** | No manual ops; uncertain matches make perfect parlays rarer → bigger rollovers. |
| Entry price | **0.02 SOL, fixed per contest** | Cheap enough to be casual; the locked range was 0.02–0.03. |
| Collateral | **Native SOL / lamports** | Reuses `proofbet`'s lamport escrow; zero token setup; devnet airdrop. |
| Rake | **5% on payout only** | Taken from the pot **only when someone wins**. A rollover day takes 0% — the full pot carries. |
| Economic split | **Equal split among perfect cards** | `floor(distributable / perfect_count)` each; dust rolls forward. |
| On-chain shape | **A — persistent `JackpotVault` PDA + per-day `Contest` + per-wallet `Entry`** | Rollover = the vault balance simply persists; one contest live at a time keeps it clean (§4). |
| Settlement trust | **Keeper-supplied results in v1; read winning buckets from settled result markets when present** | Same "verifiable, not trustless" posture as today; hardening path in §9. |
| Network | **devnet, real-SOL mechanics** | Real escrow/split/rollover; mainnet + legal are roadmap. |
| Nav | **New "Sweepstake" tab, first; per-match board moves to second ("Markets")** | The sweepstake is the main product; markets are secondary but kept. |

### Honest framing (inherited house rule)
The program never calls Txoracle directly. The keeper resolves each match from a TxLINE Merkle proof (`validateStat.view()`) and supplies the result; the on-chain contest binds the proof inputs so a dishonest keeper is **detectable**. We describe settlement as **"verifiable, single-source, no dispute window"** — **never "trustless."** Reading winning buckets from the already-settled per-match result markets (§9) tightens this further; full trustlessness of the *divisor* (`perfect_count`) is the roadmap item, not a v1 claim.

## 3. Reuse map

**Reused as-is (no code changes):**
- **`proofbet` escrow + claim patterns** — `Vault` PDA holding native lamports, `system_program::transfer` for escrow, `close = bettor` to return rent + prevent double-claim, u128 intermediate math for pro-rata payout. The new contest instructions mirror these line-for-line.
- **Settlement engine** — `keeper/` `validateStat.view()` against the `daily_scores` PDA, terminal/void phase detection (from `spike/`). The keeper resolves each card match's 1X2 result with the **same** code that settles result markets today.
- **`engine/`** — Fastify server, TxLINE auth + live feed relay, on-chain readers (`chain.ts`), market catalog (`catalog.ts`).
- **`web/`** — Vite PWA shell, Privy embedded-wallet signing (`usePrivySigner`), the 1X2 button styling in `ResultSelector.tsx`, the Streak design tokens in `App.css`.

**New build:**
- **Program:** a contest module in `programs/proofbet` — `JackpotVault`, `Contest`, `Entry` accounts + `create_contest` / `enter` / `settle_contest` / `claim_contest` / `void_contest` instructions (§5–§6).
- **Engine:** `/api/contest` routes (today's card, pot, your entry, live survivors) + a contest reader over the new accounts (§11).
- **Keeper:** a daily job that auto-picks the card, calls `create_contest`, and after the last match calls `settle_contest` (§12).
- **Web:** a `SweepstakeView` tab (jackpot header, card with 1X2 pickers, entry, live "still alive" board, streak chip, share card) + the `BottomNav` change (§13).

**Roughly 70% reused.** The genuinely new core is the contest program (escrow that *persists across days*) and the contest tab.

## 4. On-chain architecture — approaches

**A — Persistent jackpot vault + daily contest accounts ✅ (chosen).**
One long-lived `JackpotVault` PDA holds the rolling pot; its lamport balance **is** the jackpot and persists across days. Each day gets a `Contest` account (card + economics + result) and each player an `Entry`. Rollover is free — on a no-winner day nothing leaves the vault, so tomorrow's pot starts where today's ended. Reuses the escrow/claim patterns verbatim.

**B — Per-contest vault, transfer on rollover.** Each contest owns its own vault; rollover = CPI-transfer the balance to the next contest's vault. More moving parts and an extra cross-account transfer on every rollover day, with no benefit since only one contest is ever live. ❌

**C — Reuse the per-match 1X2 pools as the contest.** No separate pot exists to roll, and it conflates the two products. We *do* reuse those markets' settled **results** as the settlement oracle (§9) — just not as the pot. ❌

**Chosen: A.** Rollover-for-free is the whole point of the product, and A gets it by construction.

## 5. Accounts

All PDAs program-owned. Lamport math reuses `proofbet`'s patterns. `MAX_MATCHES = 5`.

### 5.1 `JackpotVault` (singleton)
```
seeds = ["jackpot_vault"]            // one per program
struct JackpotVault { bump: u8 }     // balance = native lamports, not a field
```
A program-owned escrow whose balance is the rolling jackpot. Initialized once. Its lamports persist across every contest — **this persistence is the rollover.**

### 5.2 `Contest` (one per day)
```
seeds = ["contest", contest_id.to_le_bytes()]   // contest_id = epoch day (u64)
struct Contest {
  contest_id:     u64,            // epoch day (days since unix epoch); unique, human-meaningful
  settle_authority: Pubkey,       // keeper; has_one on settle/void
  fee_recipient:  Pubkey,         // rake destination
  fixtures:       [i64; 5],       // card fixture ids; first `num_matches` valid
  num_matches:    u8,             // 3..=5
  entry_price:    u64,            // lamports (e.g. 0.02 SOL)
  lock_ts:        i64,            // entries close (first kickoff)
  fee_bps:        u16,            // 500 = 5%; <= MAX_FEE_BPS (1000)
  status:         ContestStatus,  // Open | Settled | RolledOver | Voided
  winning_buckets:[u8; 5],        // 0=Home 1=Draw 2=Away; first `num_matches` valid
  entry_count:    u64,            // # entries (informational)
  perfect_count:  u64,            // # perfect cards; the split divisor
  pot_snapshot:   u64,            // vault lamports captured at settle (rolled-in + entries)
  settled_ts:     i64,
  bump:           u8,
}
enum ContestStatus { Open, Settled, RolledOver, Voided }
```
`contest_id = epoch_day` makes the day's contest address deterministic (the client/keeper can derive it without a registry) and guarantees one contest per day.

### 5.3 `Entry` (one per wallet per contest)
```
seeds = ["entry", contest.key(), bettor.key()]
struct Entry {
  bettor:  Pubkey,
  contest: Pubkey,
  picks:   [u8; 5],   // 0/1/2 per match; first `num_matches` valid
  amount:  u64,       // lamports paid (= contest.entry_price at entry time)
  bump:    u8,
}
```
One card per wallet (multi-entry is roadmap). Created with `init_if_needed` so picks are **editable until `lock_ts`** (re-`enter` overwrites `picks` without paying again). Closed on `claim_contest` (rent back to bettor; blocks double-claim).

## 6. Instructions

### 6.1 `create_contest(contest_id, fixtures, num_matches, entry_price, lock_ts, fee_bps)`
- Signer: **keeper** (becomes `settle_authority`). Inits the `JackpotVault` if it doesn't exist yet (first run).
- Inits the `Contest` for `contest_id`, status `Open`. The pot starts from whatever is **already in the vault** (yesterday's rollover) — no transfer needed.
- Validates `3 <= num_matches <= 5`, `fee_bps <= MAX_FEE_BPS`, `entry_price > 0`, `lock_ts > now`.

### 6.2 `enter(picks)`
- Signer: **player.** Requires `status == Open` and `now < lock_ts` (else `EntryClosed`).
- Validates each `picks[i] < 3` for `i < num_matches`.
- `init_if_needed` the `Entry`; if newly created, transfer `entry_price` player→`JackpotVault` and set `amount`. If it already exists (re-entry before lock), **overwrite `picks` only** — no second payment.
- Writes `picks`, increments `entry_count` on first creation.

### 6.3 `settle_contest(winning_buckets, perfect_count)`
- Signer: **keeper** (`has_one = settle_authority`). Requires `status == Open` and `now >= lock_ts` (last match done, enforced by keeper timing).
- **Winning buckets:** in v1, when each card match has a settled per-match result `Market`, pass them as remaining accounts and **read `winning_bucket` from each** (verified, not trusted); otherwise accept the keeper-supplied `winning_buckets`. Either way they're recorded on-chain. (See §9.)
- `pot_snapshot = vault.lamports`.
- If `perfect_count == 0` → `status = RolledOver`. **Vault untouched** — the whole pot carries to the next contest. No rake.
- Else → `status = Settled`. Transfer rake `= pot_snapshot * fee_bps / 10000` vault→`fee_recipient`. `distributable = pot_snapshot − rake` stays in the vault for claims.
- Records `winning_buckets`, `perfect_count`, `pot_snapshot`, `settled_ts`.

### 6.4 `claim_contest()`
- Signer: **player.** Requires a **terminal** status (`Settled`, `RolledOver`, or `Voided`). One instruction handles payout, refund, and rent-only close so a player always has a single way to clear their entry.
- Payout branches by status:
  - **Settled + perfect** (`entry.picks[i] == winning_buckets[i]` for all `i < num_matches`, verified on-chain) → payout `= distributable / perfect_count` (u128 intermediate), vault→player. `distributable = pot_snapshot − rake`.
  - **Settled + not perfect** → no payout (their stake is already part of `distributable`/dust); the call only closes the entry.
  - **RolledOver** → no payout (their stake is in the rolled-forward pot); the call only closes the entry.
  - **Voided** → refund `entry.amount` (their stake) vault→player.
- `close = bettor` always returns the **Entry account's own rent** (which the player paid at `enter` via `init_if_needed`) and prevents double-claim. This rent is separate from the pot — closing never touches vault pot funds except for the explicit payout/refund above. Remainder (dust from the floor division on a Settled split) stays in the vault → rolls into the next contest.

### 6.5 `void_contest()` (abandoned card)
- Signer: **keeper.** If any card match is abandoned/void (no provable result), set `status = Voided`.
- Each entry then calls `claim_contest` on a voided contest → **refund `entry.amount`** (their stake), close entry. The **rolled-in** portion of the pot (everything beyond `entry_count * entry_price`) is **not** refunded — it wasn't anyone's entry — and remains in the vault to carry to the next contest.

## 7. Contest lifecycle & rollover

```
day N        create_contest(N)         status=Open, pot = vault balance (rollover from N-1)
  …          enter / re-enter           until lock_ts (first kickoff)
  …          matches play
last match   settle_contest(N)
               ├─ perfect_count == 0 → RolledOver   (vault untouched; pot carries)
               └─ perfect_count >  0 → Settled       (rake out; distributable stays for claims)
  …          claim_contest               perfect cards split; losers close for rent
day N+1      create_contest(N+1)        pot = whatever's left in the vault
```
The vault is the single source of continuity: **rollover is just "don't move the money."** A winning day distributes the pot down to dust; the next day's jackpot starts from that dust (plus new entries). A rollover day carries the full pot forward.

## 8. Economics

- **Entry:** fixed `entry_price` (0.02 SOL) per wallet, paid once into the vault.
- **Rake:** `pot_snapshot * fee_bps / 10000` (5%), taken **only on a winning day**, at settle. Rollover days take 0%.
- **Split:** each perfect card claims `floor((pot_snapshot − rake) / perfect_count)`.
- **Solvency invariant:** `perfect_count * floor(distributable/perfect_count) ≤ distributable ≤ pot_snapshot`. Holds **iff `perfect_count ≥ actual perfect cards`** — see §9 for why that's the one thing to protect. Dust (the floor remainder) stays escrowed and rolls forward.
- **Void:** refunds total `entry_count * entry_price`; the rolled-in remainder stays in the vault.

## 9. Settlement source of truth & trust model

The keeper supplies two things at settle: the **winning buckets** and the **perfect_count** (the split divisor). They have different trust profiles:

- **Winning buckets — harden in v1.** Each card match is a normal fixture that the existing per-match **result market** already settles from a TxLINE proof. `settle_contest` reads `winning_bucket` directly from those settled `Market` accounts (passed as remaining accounts), so the contest's recorded results are **verified against on-chain settlements**, not merely asserted. Fallback (if a result market isn't present for a match): accept the keeper-supplied bucket, recorded on-chain for re-verification. The keeper auto-picks the card, so it can guarantee a result market exists per match — making the verified path the normal path.
- **perfect_count — trusted in v1, hardening path noted.** It can't be computed in a single instruction (it requires scanning every `Entry`), so the keeper counts off-chain and supplies it. **The risk is asymmetric:** if the keeper reports it *too high*, winners are merely under-paid and the surplus rolls forward (safe). If it reports *too low*, winners over-draw and the vault can become insolvent before everyone claims. So the one rule is **never under-report**.
  - **Hardening (roadmap, not v1):** a two-phase settle — phase 1 records verified `winning_buckets`; a short **registration window** lets each perfect entry call `register_win` (on-chain increment, trustless count); then claims pay `distributable / perfect_count`. Alternatively, a **merkle root** of the winner set. Either removes the last trusted value. Same surface as today's keeper-trusted settle; explicitly deferred.

This is the same "verifiable, single-source, detectable-not-trustless" posture as the rest of Streak (inherited house rule, §2).

## 10. Card curation (auto-pick by keeper)

The keeper builds the day's card with **no manual ops**:
- Pull the day's in-scope fixtures from the TxLINE snapshot (`engine` already does this for the market catalog).
- **Bias toward uncertainty:** rank by how close the 1X2 implied probabilities are to even (e.g., lowest favourite-probability, or highest entropy across Home/Draw/Away from the odds feed). Pick the top `num_matches`. Uncertain matches make a clean sweep rare → bigger, more exciting rollovers.
- Ensure a per-match **result market** exists for each chosen fixture (create it if missing) so the verified-settlement path (§9) applies.
- Set `lock_ts` to the **earliest kickoff** on the card; schedule `settle_contest` for after the **latest** match's full-time.

## 11. Engine (`engine/`)

New `/api/contest` surface (reads the on-chain accounts via `chain.ts`; no custody):
- `GET /api/contest/today` → today's `Contest`: card fixtures (+ team names/kickoffs from the feed), `entry_price`, `lock_ts`, `status`, live **pot** (vault balance), **rolled-days** count, `entry_count`.
- `GET /api/contest/entry?wallet=…` → that wallet's `Entry` (picks, amount) for today's contest, if any.
- `GET /api/contest/alive` → the live **"still alive"** board: for each entry (or aggregate), how many picks are still correct given matches settled so far — derived from entries + per-match results. (Aggregate counts for v1; per-wallet detail for the signed-in user.)

Live match state continues to flow through the existing TxLINE relay. The engine never holds user funds — `enter`/`claim_contest` are signed client-side by the Privy wallet.

## 12. Keeper (`keeper/`)

A daily job (the existing keeper process, extended):
- **Morning:** auto-pick the card (§10), ensure per-match result markets exist, call `create_contest(epoch_day, …)`.
- **After last full-time:** resolve each card match's 1X2 result with the existing `validateStat` path, count perfect entries off-chain, call `settle_contest(winning_buckets, perfect_count)` (or `void_contest` if a match abandoned).
- Reuses the keeper's TxLINE auth, phase detection, and `settle` plumbing; only the contest-specific create/settle calls are new.

## 13. Frontend (`web/`)

### 13.1 Navigation change
`BottomNav.tsx` / `App.tsx`: `Tab` becomes `"sweepstake" | "markets" | "bets" | "wallet"`.
- **Sweepstake** — **first** tab, the default landing tab (the main product).
- **Markets** — the current per-match board (`MatchList`), relabeled from "Live" → "Markets", moved to **second**.
- **My Bets** and **Wallet** — unchanged.

### 13.2 `SweepstakeView` (new)
- **Jackpot header:** the live pot (vault balance) + a "rolled N days" badge + a countdown to `lock_ts`.
- **Today's card:** one row per match (team names, kickoff) with **1X2 pick buttons** (reuse `ResultSelector`'s button styling; these are picks, not parimutuel odds — no per-pick multiplier).
- **Entry:** "Enter — 0.02 ◎" button → signs `enter(picks)`. Editable until lock (re-`enter` overwrites picks, no second charge); shows a locked state after `lock_ts`.
- **Live "still alive" board:** as matches settle, show how many of your picks are still alive and how many entries remain in contention; a clear win/rolled-over result at the end.
- **Streak chip:** the user's consecutive-day participation/correct streak (cheap, on-brand — it's the app's name).
- **Share card:** a shareable image/route of the user's card + result (the "I'm 4/4 going into the last match" moment).

Claiming a split (or a void refund) happens via `claim_contest`, surfaced in `SweepstakeView` after settlement (and/or My Bets).

## 14. Scope & milestones (YAGNI)

Build as vertical slices; everything past M0 is additive.

### Milestone 0 — walking skeleton
**One contest, the full lifecycle on devnet, through the real UI.**
- Program: `JackpotVault` + `Contest` + `Entry`, `create_contest` / `enter` / `settle_contest` / `claim_contest`, deployed to devnet.
- Keeper: manual/scripted `create_contest` for one card (auto-pick can be a fixed list in M0), `settle_contest` after the matches.
- Engine: `GET /api/contest/today` + `entry`.
- Web: `SweepstakeView` (jackpot header, card with 1X2 picks, enter, claim) + the nav change.
- Demo (~90s): land on Sweepstake → see pot → pick 4 → enter 0.02 ◎ → matches settle → either split-and-claim or watch it roll into tomorrow's pot.

### Milestone 1+ — widen (in order)
Auto-card curation (§10) → live "still alive" board → `void_contest` refund path → read winning buckets from result markets (§9) → streak chip + share card → rolled-days badge polish.

### Out (this iteration → §16)
Trustless `perfect_count` (registration window / merkle), multi-entry, full leaderboard/friend leagues, mainnet, USDC, fiat on-ramp.

## 15. Testing

**Anchor (program):**
- `enter` escrows `entry_price`; re-`enter` before lock overwrites picks **without** a second charge.
- `enter` after `lock_ts` rejects (`EntryClosed`).
- `settle_contest` with a perfect winner → `Settled`, rake to `fee_recipient`, `distributable` correct.
- `settle_contest` with `perfect_count == 0` → `RolledOver`, **vault balance unchanged** (rollover).
- `claim_contest` pays `distributable / perfect_count` to a perfect card; **rejects a non-perfect card's payout**.
- Double-claim blocked (entry closed).
- Two perfect winners → each gets the equal split; dust ≤ `perfect_count` lamports remains in the vault.
- `void_contest` → each entry refunds `amount`; rolled-in remainder stays in the vault.
- Conservation: `Σ payouts + rake + dust == pot_snapshot` (Settled); `Σ refunds == entry_count * entry_price` (Voided).
- Rollover continuity: settle N as RolledOver → create N+1 → pot equals N's `pot_snapshot`.

**Engine/keeper:** unit tests for the contest reader, `/api/contest/*` shapes, card auto-pick ranking, and the perfect-count counter.

**Web:** typecheck + preview — nav shows Sweepstake first; card picks, enter, locked state, and claim render correctly.

## 16. Risks & honest posture

- **Settlement trust (the soft spot):** winning buckets are hardened by reading settled result markets (§9); `perfect_count` stays keeper-trusted in v1 — framed as **verifiable, not trustless**, with the registration-window/merkle hardening path designed. Never under-report the divisor (the one insolvency vector, §9).
- **Legal:** real-money contest → jurisdictional exposure; devnet-only this iteration, framed as a verifiable-settlement demo. Mainnet needs legal review.
- **Cold-start pot:** early contests have a small pot until rollovers accumulate. Acceptable (and the rollover mechanic is exactly what fixes it); an optional seed deposit into the vault is a lever, not a requirement.
- **Card liveness:** if a card match is abandoned, `void_contest` refunds entries and carries the rollover — no funds stuck.
- **Keeper availability:** a stalled keeper delays settle/claim (detectable, not forgeable). Production posture is a multisig `settle_authority`.
- **Token safety:** TxLINE API token stays in the engine/keeper, never shipped to the client.

## 17. Relationship to the secondary feature

The per-match tradeable LMSR market is **parked** ([../secondary-prediction-market.md](../secondary-prediction-market.md)) and is **not** built here. The existing per-match **parimutuel** board stays live as the **second ("Markets")** tab. Both products share the same TxLINE settlement engine, Privy signing, design language, and the per-match result markets — which the sweepstake also consumes as its settlement oracle (§9).

## 18. Open questions
- `num_matches` default — 4 (per design); confirm at keeper-config time vs. 3 or 5.
- `entry_price` — 0.02 SOL (locked range 0.02–0.03); confirm exact value.
- Uncertainty metric for auto-pick — favourite-probability vs. entropy across the 1X2 odds; pick at implementation.
- Whether to seed the genesis vault with a small starting pot for the first demo, or start from zero and let it grow.
