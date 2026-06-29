# Single-Match Parlay — v2 Program Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the sweepstake on-chain program to support **1–3 concurrent single-match parlay contests** with a **per-contest escrow** and a **shared rolling jackpot**, while keeping the across-match model as a valid configuration.

**Architecture:** Replace the singleton `JackpotVault` (with `reserved` + `active_contest_id`) with (a) a `Jackpot` PDA `[b"jackpot"]` holding only the rolling pool, and (b) **each `Contest` PDA holding its own entry pot** (per-contest isolation — no cross-contest `reserved` accounting). Generalize a contest leg from `(fixture, RESULT_MARKET_ID)` to `(fixtures[i], market_ids[i])`. `settle_contest` reads each leg's market, then either scoops the jackpot into the contest (winners) or sweeps the contest pot into the jackpot (no winners).

**Tech Stack:** Anchor (Rust), `anchor test` (TypeScript/Mocha) on a local validator. Program id unchanged (`By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`). The parimutuel `Market`/`Vault`/`Position` side is untouched.

**Spec:** `docs/superpowers/specs/2026-06-30-single-match-parlay-design.md`

**Worktree:** build in `.worktrees/parlay-v2` (branch `feat/parlay-v2`, off `feat/streak-pivot`), where `anchor test` is known to work on this machine.

---

## Design reference (frozen — every task conforms to this)

### Accounts (v2)
```rust
// contest_state.rs
pub const MAX_LEGS: usize = 5;            // renamed from MAX_MATCHES (legs, not matches)
pub const RESULT_MARKET_ID: u8 = 12;      // kept: across-match config + default
pub const VOID_GRACE_SECS: i64 = 3 * 24 * 60 * 60;

#[account]
#[derive(InitSpace)]
pub struct Jackpot {                       // replaces JackpotVault
    pub bump: u8,                          // lamports above rent floor == rolling pool
}
pub fn jackpot_rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + Jackpot::INIT_SPACE))
}

#[account]
#[derive(InitSpace)]
pub struct Contest {
    pub contest_id: u64,
    pub settle_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub fixtures: [i64; MAX_LEGS],
    pub market_ids: [u8; MAX_LEGS],        // NEW — leg i = (fixtures[i], market_ids[i])
    pub num_legs: u8,                      // renamed from num_matches (3..=MAX_LEGS; parlay uses 4)
    pub entry_price: u64,
    pub lock_ts: i64,
    pub settle_after_ts: i64,
    pub fee_bps: u16,
    pub status: ContestStatus,             // Open|Settled|RolledOver|Voided (unchanged)
    pub winning_buckets: [u8; MAX_LEGS],
    pub entry_count: u64,
    pub perfect_count: u64,
    pub distributable: u64,                // winners' total (== payable, exactly divisible)
    pub claimed_count: u64,
    pub claimed_total: u64,
    pub settled_ts: i64,
    pub bump: u8,
}
// The Contest PDA HOLDS the entry pot: pot = contest.lamports - contest_rent_floor().
pub fn contest_rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + Contest::INIT_SPACE))
}

#[account]
#[derive(InitSpace)]
pub struct Entry {                         // unchanged except picks length tracks MAX_LEGS
    pub bettor: Pubkey,
    pub contest: Pubkey,
    pub nonce: u64,
    pub picks: [u8; MAX_LEGS],
    pub amount: u64,
    pub bump: u8,
}
```
> Note: `pot_snapshot` is dropped (pot is now read directly from the Contest PDA's
> lamports at settle and never re-read). `reserved` and `active_contest_id` are dropped
> (per-contest isolation). `Jackpot` carries no `active_contest_id` — contests are
> independent and concurrent.

### PDAs
- `jackpot` = `[b"jackpot"]`
- `contest` = `[b"contest", contest_id.to_le_bytes()]` (also the escrow that holds the pot)
- `entry`   = `[b"entry", contest, bettor, nonce.to_le_bytes()]`
- leg market = `[b"market", fixtures[i].to_le_bytes(), [market_ids[i]]]` (existing parimutuel PDA)

### settle_contest math (the heart — exact)
```
require contest.status == Open && now >= settle_after_ts
require remaining_accounts.len() == num_legs
for i in 0..num_legs:
    acc = remaining_accounts[i]
    expect = PDA([b"market", fixtures[i], [market_ids[i]]])
    require acc.key == expect && acc.owner == program_id
    market = Market::try_deserialize(acc)
    require market.settle_authority == contest.settle_authority   // oracle binding (kept)
    require market.status == Settled || Voided                    // void-with-bucket ok
    require (winning_buckets[i] = market.winning_bucket).is_some() // None => abandoned => caller voids
    // NOTE: removed the v1 `num_buckets == 3` constraint — legs may be 2- or 3-way.

floor   = contest_rent_floor()
pot     = contest.lamports - floor                         // all entries
rake    = min((entry_count * entry_price * fee_bps)/10_000, pot)  // u128 math, capped
if rake > 0: contest -> fee_recipient (rake)

jpool   = jackpot.lamports - jackpot_rent_floor()          // current rolling pool

if perfect_count == 0:                                     // ROLLOVER
    sweep = pot - rake                                     // remaining entries
    contest -> jackpot (sweep)                             // pot rolls forward
    distributable = 0
    status = RolledOver
else:                                                      // WINNERS
    raw   = (pot - rake) + jpool                           // entries(net) + jackpot
    share = raw / perfect_count                            // floor
    payable = share * perfect_count
    dust  = raw - payable
    // contest must end holding exactly `payable`; jackpot must end holding `dust`.
    // it currently holds (pot - rake); move (jpool - dust) jackpot -> contest.
    move = jpool - dust
    jackpot -> contest (move)                              // contest now holds payable
    distributable = payable
    status = Settled
    // jackpot left with `dust` (>= 0); dust rolls into the next contest. ✅ "dust -> jackpot"

// per-contest solvency invariant (winners): contest.lamports >= floor + distributable
// (rollover): contest.lamports >= floor   (pot fully swept)
assert and store winning_buckets/perfect_count/distributable/settled_ts/status
```

### claim_contest (per-contest; mirrors v1 logic, vault = the Contest PDA)
```
require status in {Settled, RolledOver, Voided}
Voided  -> payout = entry.amount
Settled & perfect (picks[0..num_legs] == winning_buckets) ->
    require perfect_count > 0
    share = distributable / perfect_count
    require claimed_count < perfect_count
    require claimed_total + share <= distributable
    payout = share ; claimed_count += 1 ; claimed_total += share
RolledOver | non-perfect -> payout = 0
if payout > 0:
    contest -> bettor (payout)
    require contest.lamports >= contest_rent_floor() + (distributable - claimed_total)  // winners
    // (void path uses entry-pot remaining; see Task 6)
close Entry (-> bettor)   // double-claim impossible
```

### void_contest (refunds from the Contest PDA)
```
permissionless after settle_after_ts + VOID_GRACE_SECS (or keeper anytime pre-settle, per v1)
status Open -> Voided ; refunds happen at claim_contest (Voided branch), paid from Contest PDA
```

---

## Task 1: State + constants rewrite (`contest_state.rs`)

**Files:**
- Modify: `programs/proofbet/src/contest_state.rs`
- Modify: `programs/proofbet/src/errors.rs` (append new variants at END to keep ordinals stable)
- Test: `programs/proofbet/tests/contest_state.ts` (new) — INIT_SPACE / layout sanity

- [ ] **Step 1: Write the failing test** — assert the program builds and the new
  accounts decode. Add a test that fetches a created `Jackpot` and `Contest` (after a
  later task) — for now, a compile/size assertion:
  ```ts
  // size guard: Contest::INIT_SPACE accommodates market_ids[5] + num_legs
  // (computed expectation; fails until field added)
  ```
- [ ] **Step 2: Replace `JackpotVault` with `Jackpot`** (drop `active_contest_id`,
  `reserved`); add `jackpot_rent_floor()`. Rename `vault_rent_floor` usages.
- [ ] **Step 3: Add `market_ids: [u8; MAX_LEGS]` to `Contest`; rename
  `MAX_MATCHES`→`MAX_LEGS`, `num_matches`→`num_legs`; drop `pot_snapshot`; add
  `contest_rent_floor()`.** Keep `picks`/`fixtures`/`winning_buckets` lengths at
  `MAX_LEGS`.
- [ ] **Step 4: Append any new error variants** (`InvalidMarketId` if needed) at the END
  of `ProofBetError`.
- [ ] **Step 5: `anchor build`** — Expected: compiles; downstream instruction files will
  break (fixed in later tasks). Commit state + errors only after the program compiles
  once all tasks land; for now keep the worktree building by stubbing instruction edits
  in their own tasks. (Implementer: do Tasks 1–7 as one coherent compile unit, committing
  per task once the whole compiles — Anchor can't half-compile.)

> **Implementer note:** because Anchor compiles the whole crate, Tasks 1–7 form one
> compile unit. Implement them in order, keeping the crate compiling by updating each
> instruction as you change shared state. Each task's *tests* are still added and run
> incrementally.

## Task 2: `initialize_jackpot` (replaces `initialize_vault`)

**Files:**
- Rename/Modify: `programs/proofbet/src/instructions/initialize_vault.rs` →
  `initialize_jackpot.rs`
- Modify: `programs/proofbet/src/lib.rs` (rename instruction + module)
- Test: `programs/proofbet/tests/contest_jackpot.ts` (new)

- [ ] **Step 1: Failing test** — call `initialize_jackpot`, fetch the `Jackpot` PDA,
  assert it exists with `bump` set and lamports == its rent floor.
- [ ] **Step 2:** Implement `InitializeJackpot` accounts (`[b"jackpot"]`, `init`,
  payer = keeper) + handler (`bump` only).
- [ ] **Step 3:** Wire into `lib.rs`. **Step 4:** `anchor test` the new test → PASS.
- [ ] **Step 5:** Commit.

## Task 3: `create_contest` v2 (concurrent, per-contest pot, leg market_ids)

**Files:**
- Modify: `programs/proofbet/src/instructions/create_contest.rs`
- Modify: `programs/proofbet/src/events.rs` (`ContestCreated` — add nothing required; keep)
- Test: `programs/proofbet/tests/contest_create.ts` (new or extend)

- [ ] **Step 1: Failing tests** —
  (a) create a contest with `market_ids = [16,15,12,11,0]`, `num_legs = 4`,
  `fixtures = [F,F,F,F,0]`; fetch and assert fields.
  (b) **concurrency:** create a SECOND contest with a different `contest_id` while the
  first is still Open → succeeds (no `ContestStillLive`).
  (c) validation: `num_legs` out of `3..=MAX_LEGS` → `InvalidMatchCount`; `entry_price
  0` → `ZeroAmount`; `lock_ts >= settle_after_ts` → `EntryCloseInPast`; a leg with
  `fixtures[i]==0` within `num_legs` → `InvalidFixtureId`.
- [ ] **Step 2:** Drop the `JackpotVault` account + the `active_contest_id == 0` guard +
  the `vault.active_contest_id = contest_id` write. The `CreateContest` accounts become
  `{ keeper, contest(init, holds pot), system_program }`. Add `market_ids: [u8; MAX_LEGS]`
  param; validate each leg's `market_ids[i] != 0` within `num_legs`. Initialize
  `c.market_ids`, drop `c.pot_snapshot`.
- [ ] **Step 3:** `anchor test` → PASS. **Step 4:** Commit.

## Task 4: `enter` v2 (deposit into the Contest PDA)

**Files:**
- Modify: `programs/proofbet/src/instructions/enter.rs`
- Test: `programs/proofbet/tests/contest_enter.ts` (new or extend)

- [ ] **Step 1: Failing tests** —
  (a) enter a new ticket → `contest.lamports` increases by `entry_price`;
  `entry_count == 1`; Entry has the picks.
  (b) multi-ticket: a second nonce → `entry_count == 2`, contest balance += price.
  (c) re-use a nonce → edits picks, NO charge, `entry_count` unchanged.
  (d) pick validation: a pick `>= num_buckets` of that leg's market is rejected. Since
  picks validate against `MAX_BUCKETS` (3) generically, keep the existing
  `< MAX_BUCKETS` within `num_legs` + `== 0` tail guard (a 2-way leg simply never has
  bucket 2 as a winning value, so an over-pick of 2 on an O/U leg can never be perfect —
  acceptable; do NOT special-case per-leg bucket counts here).
- [ ] **Step 2:** Change the `Enter` accounts: drop `vault`, transfer to the `contest`
  account instead (`to: contest.to_account_info()`). Keep `init_if_needed` Entry +
  new-ticket sentinel + `num_legs`-aware pick validation.
- [ ] **Step 3:** `anchor test` → PASS. **Step 4:** Commit.

## Task 5: `settle_contest` v2 (leg-by-market_id + jackpot mechanic)

**Files:**
- Modify: `programs/proofbet/src/instructions/settle_contest.rs`
- Modify: `programs/proofbet/src/events.rs` (`ContestSettled` — replace `pot_snapshot`
  with `pot`+`jackpot_in`/`jackpot_out` or keep minimal; keep `rake`, `rolled_over`)
- Test: `programs/proofbet/tests/contest_settle.ts` (rewrite for v2)

- [ ] **Step 1: Failing tests** (use the keeper as each leg's market `settle_authority`):
  (a) **winners:** 1 contest, 2 perfect tickets, jackpot starts 0 → `distributable ==
  pot - rake`, `share == distributable/2`, status Settled.
  (b) **rollover:** 0 perfect → contest pot (− rake) moves to `jackpot`; `distributable
  == 0`; status RolledOver; jackpot balance increased by `pot - rake`.
  (c) **jackpot scoop:** after (b), a new contest with 1 perfect ticket → `distributable
  == its_pot - rake + jackpot_pool`; jackpot pool drained to `dust`.
  (d) **dust:** distributable not divisible by perfect_count → `distributable ==
  share*perfect_count` and `jackpot` ends holding the remainder.
  (e) **leg by market_id:** legs `[16,15,12,11]` on the same fixture settle from those
  exact markets; a 2-way leg (market 11/15) reads bucket 0/1 correctly.
  (f) **oracle binding kept:** a leg market whose `settle_authority != contest.settle_
  authority` → `ResultMarketMismatch`.
  (g) **too early / wrong remaining count / abandoned (no bucket)** → respective errors.
- [ ] **Step 2:** Implement the Design-reference math exactly: read pot from
  `contest.lamports - contest_rent_floor()`; per-leg PDA from `(fixtures[i],
  market_ids[i])`; remove the `num_buckets == 3` check; rake from contest → fee_recipient;
  jackpot in/out via `Jackpot` PDA lamport moves (use `sub_lamports`/`add_lamports` on the
  program-owned PDAs — both are program-owned, so direct lamport math, not a system CPI);
  set `distributable = payable`; sweep `dust` to jackpot on the winners path; assert the
  per-contest solvency invariant.
- [ ] **Step 3:** `anchor test` → PASS. **Step 4:** Commit.

## Task 6: `claim_contest` v2 (pay from the Contest PDA)

**Files:**
- Modify: `programs/proofbet/src/instructions/claim_contest.rs`
- Test: `programs/proofbet/tests/contest_claim.ts` (rewrite for v2)

- [ ] **Step 1: Failing tests** —
  (a) perfect winner claims `share`; contest balance drops by `share`; `claimed_count/
  total` advance; Entry closed (rent → bettor).
  (b) second winner claims; after all winners, contest holds ≈ rent (exactly, since
  distributable was made divisible).
  (c) loser claim → payout 0, Entry closed (reclaim rent), no balance move.
  (d) double-claim → fails `AccountNotInitialized`.
  (e) cap: a phantom extra winner beyond `perfect_count` → `VaultInsolvent`.
- [ ] **Step 2:** Replace the `vault` account with the `contest` PDA as payer source;
  use `contest_rent_floor()`; drop all `reserved` logic; keep the dual caps; pay via
  `contest.sub_lamports` / `bettor.add_lamports`; assert `contest.lamports >=
  contest_rent_floor() + (distributable - claimed_total)` after a winner payout.
- [ ] **Step 3:** `anchor test` → PASS. **Step 4:** Commit.

## Task 7: `void_contest` v2 (refund from the Contest PDA)

**Files:**
- Modify: `programs/proofbet/src/instructions/void_contest.rs`
- Test: `programs/proofbet/tests/contest_void.ts` (rewrite for v2)

- [ ] **Step 1: Failing tests** —
  (a) keeper voids an Open contest (pre-settle) → status Voided.
  (b) permissionless void after `settle_after_ts + VOID_GRACE_SECS` by a non-keeper.
  (c) after void, each ticket claims a full `entry.amount` refund from the contest;
  contest ends at ≈ rent; conservation holds.
- [ ] **Step 2:** Drop `reserved`/vault; status transition only (refunds flow through
  `claim_contest`'s Voided branch, already paying from the Contest PDA). Keep the grace
  + permissionless logic.
- [ ] **Step 3:** `anchor test` → PASS. **Step 4:** Commit.

## Task 8: Jackpot rollover integration test (cross-contest, concurrent)

**Files:**
- Test: `programs/proofbet/tests/contest_jackpot_rollover.ts` (new)

- [ ] **Step 1:** Full-lifecycle test: contest A (no winner) → jackpot grows by A's net
  pot → contest B (1 winner) → winner receives B's net pot + the jackpot → jackpot left
  at dust. Run A and B **overlapping** (both created Open before A settles) to prove
  concurrency.
- [ ] **Step 2:** Assert exact lamport accounting end-to-end. **Step 3:** Commit.

## Task 9: Safety + conservation audit tests

**Files:**
- Test: `programs/proofbet/tests/contest_safety.ts` (rewrite for v2)

- [ ] **Step 1:** Conservation: across create→enter→settle→claim, sum of all lamport
  deltas (bettors + fee_recipient + jackpot + contest rents) == 0 (minus tx fees).
- [ ] **Step 2:** Per-contest isolation: draining one contest's winners cannot touch
  another contest's pot (no shared vault). A malformed `perfect_count` is bounded to
  THIS contest's distributable.
- [ ] **Step 3:** `anchor test` (full suite) → all PASS. **Step 4:** Commit.

---

## Final review (after all tasks)
- [ ] Whole-branch adversarial money-safety audit (Workflow, multi-lens, each finding
  refutation-tested) — same gate that caught the v1 oracle-binding bug. Focus: the
  jackpot lamport-move math (no mint/burn), per-contest solvency, dust accounting,
  concurrency (two contests touching the one jackpot PDA), and that across-match
  (`market_ids = [12,…]`) still settles.
- [ ] `anchor test` green; then merge `feat/parlay-v2` `--no-ff` into `feat/streak-pivot`.

## Deploy note (operational, not part of this plan's tests)
v2 changes the `Contest` layout and removes `JackpotVault`. The live contest **20635**
is on the v1 layout. **Settle/finish 20635 on the current program FIRST** (tomorrow, via
the existing runbook), THEN upgrade-in-place to v2 — OR deploy v2 under a fresh program
id. Decide at deploy time; it does not affect this plan's local `anchor test`.

## Out of scope (separate plan #2 — off-chain)
- `markets.ts`: add `marketId 16` (1st-Half Result; `statKey 1001−1002`, subtract,
  `numBuckets 3`, `settleAt HT`).
- Engine: generalize the contest reader (`marketIds`, per-leg labels), turn
  `/api/contest/today` into a **list** of live contests, add `/api/jackpot`.
- Keeper: `selectParlayMatches` (1–3 staggered), `create-parlay`, settle with jackpot
  preview, and the new **`void-contest` CLI**.
- Web: parlay view (4 legs, 1–3 contests, jackpot headline); reuse the v1 ticket/claim
  polish.
