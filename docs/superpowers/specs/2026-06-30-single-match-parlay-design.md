# Single-Match Parlay Sweepstake — Design Spec (v2)

**Status:** design — pending user review, then implementation plan.
**Supersedes:** the v1 daily across-match sweepstake as the *primary* product. v1 is
NOT deleted — the on-chain model is generalized so an across-match contest remains a
valid configuration (back-burner, see §10).

**Goal:** Replace the daily across-match jackpot with a **single-match parlay**: each
day, run **1–3** sweepstakes (one per featured match, kickoffs staggered so they
settle at different times). Each parlay is **4 fixed legs within one match**; predict
all four correctly and you share that contest's pot with every other perfect ticket.
If nobody is perfect, the pot rolls forward into a shared jackpot that the next
perfect winner scoops.

---

## 1. The parlay — what people guess

Every parlay is the **same 4 fixed legs** (learnable, predictable UI). All four are
settleable from a TxLINE Merkle proof — the hard constraint.

| # | Leg | Outcomes (buckets) | Settles | Market |
|---|---|---|---|---|
| 1 | **1st-Half Result** — who leads at half-time | Home / Level / Away (3) | HT | `marketId 16` — NEW |
| 2 | **1st-Half Goals O/U 0.5** — ≥1 goal before HT? | Over / Under (2) | HT | `marketId 15` — built |
| 3 | **Full Match Result (1X2)** | Home / Draw / Away (3) | FT | `marketId 12` — built |
| 4 | **Total Goals O/U 2.5** | Over / Under (2) | FT | `marketId 11` — built |

- **Bucket encoding** stays canonical: 3-way = `0 home/lead, 1 draw/level, 2 away`;
  2-way O/U = `0 over, 1 under` (match existing template/keeper mapping).
- **Leg 1 (1st-Half Result)** is the only new market: same proof pattern as the full
  result but on 1st-half stats — `statKey 1001 − 1002` (subtract), keeper maps the
  goal-diff sign to bucket (lead-home `>0`, level `==0`, lead-away `<0`),
  `numBuckets 3`, `settleAt HT`.
- **Two-stage suspense:** legs 1–2 are decided at HT, legs 3–4 at FT. A ticket can die
  at halftime, or survive into the second half. (A live "still-alive at HT" board is a
  nice-to-have — see §10, M1.)

**Difficulty / correlation (note, not a blocker):** ~4 legs ⇒ a hard parlay (roughly
single-digit % to hit all four, eased by natural correlation — HT leader often wins,
1st-half goal often means total Over). Hard ⇒ the jackpot rolls often and grows; the
eventual hit is a big shared payout. If real hit-rate proves too low for engagement we
can drop to 3 legs or loosen a line (e.g. keep 1st-Half Goals at the easy O/U 0.5).
Lines are tunable in the market template.

---

## 2. Lifecycle

```
keeper builds card → create_contest (per match) → users enter (pick 4) →
match plays → keeper settles the 4 result markets (HT wave + FT wave) →
settle_contest (count perfects, apply jackpot) → winners claim their share
```

- **1–3 per day**, chosen by the keeper from the day's *good* matches whose kickoffs
  are **staggered** (so contests settle at different times, never all at once). Fewer
  on a thin day; up to 3 when there are several quality, non-overlapping matches.
- **Entry window:** open until the match's kickoff (`lock_ts`). After kickoff, no new
  tickets / pick edits.
- **Settle window:** `settle_after_ts = kickoff + full-match buffer` (covers 90' + ET +
  stoppage). By then all 4 legs (2 HT, 2 FT) are settleable in one `settle_contest`.

---

## 3. Win-sharing + the rolling jackpot

**Within a contest:** a ticket is *perfect* iff all 4 picks match all 4 winning
buckets. **All perfect tickets split the pot equally** (parimutuel perfect-parlay —
already how v1 works).

**Shared jackpot (the rollover):** one `jackpot` PDA holds a rolling balance. At
`settle_contest`:

- `pot = entries_in_contest_vault − rake` (rake on new stakes only).
- **If `perfect_count > 0`:** `distributable = pot + jackpot_balance`; the jackpot's
  lamports move into this contest's vault and `jackpot_balance → 0`; each winner's
  share = `distributable / perfect_count`. Status → **Settled**.
- **If `perfect_count == 0`:** `pot` moves into the jackpot (`jackpot_balance += pot`);
  status → **RolledOver**; nothing paid.

So a no-winner contest **feeds** the jackpot; the **next contest that has a perfect
winner scoops the whole accumulated jackpot** on top of its own pot. This is
order-independent and concurrency-safe — the jackpot PDA is read-modify-written
atomically inside `settle_contest`, so even with 1–3 staggered contests, exactly one
winning settle drains it and the rest see `0`.

### Worked example
> **Mon — Brazil v Spain**, pot 2.0 ◎, jackpot 0 ◎. Nobody perfect → 2.0 ◎ → jackpot.
> **Tue — France v Argentina**, pot 1.5 ◎, jackpot 2.0 ◎. 3 perfect tickets →
> distributable = 1.5 + 2.0 = **3.5 ◎** → **1.166 ◎ each**; jackpot resets to 0.

**Dust:** floor division leaves ≤ `perfect_count − 1` lamports in the contest vault;
it rolls into the jackpot at... (decision §9) — default: swept to jackpot at settle.

**Void / abandoned match:** contest voids → every ticket refunds its stake from the
contest vault (the jackpot is untouched). ⚠️ needs a `void-contest` keeper path
(currently no CLI — see §9).

---

## 4. On-chain model (the v2 redesign)

### What changes from v1
1. **Generalized legs.** A Contest leg becomes a `(fixtureId, marketId)` pair instead
   of `(fixtureId, RESULT_MARKET_ID=12)`. Add `market_ids: [u8; MAX_LEGS]` alongside the
   existing `fixtures: [i64; MAX_LEGS]`. Leg `i` = `(fixtures[i], market_ids[i])`.
   - **Single-match parlay:** `fixtures = [F,F,F,F]`, `market_ids = [16,15,12,11]`.
   - **Across-match (v1, preserved):** `fixtures = [A,B,C]`, `market_ids = [12,12,12]`.
   - `MAX_LEGS = 5` (room for the 4 legs; `picks: [u8;5]` unchanged).
2. **Per-contest escrow.** Replace the **singleton `JackpotVault` + `reserved` fence**
   (which existed only because one shared vault served sequential contests) with:
   - a **per-contest vault PDA** `[b"contest_vault", contest_id.to_le_bytes()]` — holds
     that contest's entry pot; winners/refunds draw only from here. Self-contained, so
     **no cross-contest `reserved` accounting is needed.**
   - a singleton **`jackpot` PDA** `[b"jackpot"]` — holds the rolling jackpot balance
     only.
3. **Concurrent contests.** Drop the `active_contest_id` one-at-a-time guard;
   `create_contest` may open while others are still live.

### Accounts / instructions (deltas)
- `initialize_jackpot` — one-time create the `jackpot` PDA (balance 0).
- `create_contest(contest_id, fixtures[], market_ids[], num_legs, entry_price, lock_ts,
  settle_after_ts, fee_bps, fee_recipient)` — also creates the contest_vault PDA. No
  active-contest guard. Validates `num_legs ≤ MAX_LEGS`, timestamps ordered, leg market
  PDAs derivable.
- `enter(nonce, picks[num_legs])` — deposit `entry_price` into the contest_vault; create
  `Entry` (unchanged seeds: `[b"entry", contest, bettor, nonce]`). Multi-ticket via
  nonce (as today).
- `settle_contest(perfect_count)` — read each leg's market by `(fixtures[i],
  market_ids[i])`; verify owner + `market.settle_authority == contest.settle_authority`
  + status `Settled|Voided(with bucket)`; record `winning_buckets[i]`; compute pot/rake;
  apply jackpot rule (§3). Relax the old `num_buckets == 3` check to per-leg
  (`bucket < num_buckets`).
- `claim_contest()` — pay a perfect ticket `distributable / perfect_count` from the
  contest_vault (caps: `claimed_count < perfect_count`, `claimed_total + share ≤
  distributable`); void → refund `entry.amount`; close Entry. Per-contest solvency
  invariant: `contest_vault.lamports ≥ rent_floor + (distributable − claimed_total)`.
- `void_contest()` — permissionless after `settle_after_ts + grace`; marks Voided so
  entries refund. (Add a keeper CLI — §9.)

### Migration / deploy
- This is a **v2 program**. Same Anchor program id can be upgraded in place, but the
  Contest layout changes and the vault PDAs are new — **old v1 contests don't migrate**
  (none are mid-flight on devnet except 20635; settle/finish it first, or leave it
  orphaned). New contests use the new PDAs. Bump any incompatible account
  discriminators / sizes cleanly.
- Devnet: redeploy, run `initialize_jackpot`, then keeper creates the first parlay.

---

## 5. Keeper

- **Card selection:** pick 1–3 of the day's allow-listed matches that (a) are
  good/marquee and (b) have **staggered kickoffs** (settle at different times). Pure,
  testable selector (`selectParlayMatches(fixtures, maxN, minGapMins)`).
- **create-parlay:** ensure the 4 result markets exist for the fixture (incl. the new
  `marketId 16`, keeper as `settle_authority`) **before** `create_contest`.
- **settle:** settle the 4 result markets (HT legs at/after HT, FT legs at/after FT —
  reuse `settle-all` two-wave logic), then `settle_contest(perfect_count)` with the 4
  markets as `remainingAccounts`. Extend the existing `previewSettle` dry-run to show
  jackpot in/out.

## 6. Engine

- Generalize the contest reader: `ContestView` gains `marketIds: number[]` and a
  per-leg label/group; `/api/contest/today` becomes **`/api/contest/live` → an array**
  (1–3 active contests), each with its 4 legs + the current shared **jackpot** balance.
- `entryOutcome` (already built) is unchanged — it scores picks vs winning_buckets and
  computes payout; it just needs the contest's `distributable` to already include the
  jackpot (it does, post-settle).
- Add `GET /api/jackpot` → rolling balance for the headline number.

## 7. Web

- **Parlay view:** the day's 1–3 parlays as cards; each shows the match, the **4 legs**
  with pick controls (reuse `.r3` for 3-way, a 2-way toggle for O/U), an Enter button,
  and the live **jackpot** headline.
- Tickets / claim: unchanged from the v1 polish (status pill Won/No-win/Refund, Claim
  gated on `claimable`) — now per parlay.
- Multi-ticket per parlay via nonce (as today).

## 8. Provability boundary (explicit)
- **In scope (provable now or trivial add):** full result, total goals, total corners,
  total cards, **1st-half** goals/corners/result. Leg 1 is the only new market def.
- **Out of scope (needs new proof plumbing):** any **2nd-half-specific** leg (2nd-half
  goals/result). 2nd half = `full − 1st half`, a 2-stat computation the current
  single-predicate proof can't express. If wanted later, scope a pipeline extension
  separately — NOT in this build.

## 9. Decisions (resolved)
1. **Leg count = 4** (confirmed). The four legs in §1.
2. **Rake (`fee_bps`) = 5%** on new stakes (configurable per contest), same as v1.
3. **Dust** at settle: **swept to the jackpot** (no lamports stranded in a closed
   contest vault).
4. **`void-contest` keeper CLI**: **build it** in this work (abandoned-match refund).
5. **`perfect_count` trust**: unchanged from v1 (keeper-supplied, dual-capped on
   claim). Acceptable for devnet; on-chain proof verification deferred.
6. **`perfect_count <= entry_count` guard** (added post-audit). The adversarial
   money-safety audit found that `settle_contest` folds the whole shared jackpot into
   `distributable` (`raw = (pot − rake) + jackpot_pool`) and eagerly moves it into the
   contest PDA, with no bound on `perfect_count`. An over-reported count — the extreme
   being settling an **empty** contest with `perfect_count >= 1` — pulled the entire
   jackpot into a contest no `Entry` could claim and no path could unwind (a `Settled`
   contest can't be re-voided; no sweep), permanently **bricking the shared jackpot**.
   Fix: `settle_contest` now requires `perfect_count <= entry_count`
   (`PerfectCountExceedsEntries`). This kills the catastrophic/unbounded brick.
   **Known bounded residual (accepted for devnet):** a trusted keeper that over-*counts*
   actual winners up to `entry_count` can still strand a *bounded* amount of jackpot in
   an unclaimable contest — inside the existing keeper-trust model, no longer unbounded.

## 10. Out of scope (future / back-burner)
- **Across-match daily card** — preserved as a `market_ids = [12,12,…]` configuration of
  the same model; not actively run.
- **M1 polish:** live "still-alive at HT" board (show which HT legs survived before FT),
  streak chip, jackpot history.
- **2nd-half legs** (needs proof extension).
- On-chain result-proof verification (vs trusted keeper).
- **Lazy jackpot draw (residual hardening):** eliminate the §9.6 bounded residual by
  recording the jackpot allocation at settle and pulling each winner's jackpot share
  *lazily at claim*, so unclaimed jackpot never leaves the pool. Alternative: a
  permissioned recover/sweep instruction returning unclaimed residual to the jackpot
  after a grace window. Deferred — the §9.6 guard makes the residual bounded + keeper-
  trust-scoped, not an external attack surface.
