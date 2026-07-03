# Pearly Core (program + keeper + engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Daily Pearly's on-chain + backend core: all-day entry with per-leg locks, 2^legs payout weights, perfect-or-rollover settlement, a cross-fixture card composer with a red-card chaos leg, and `/api/card` v2 — end-to-end on devnet.

**Architecture:** Extend the existing Contest/Entry parimutuel program (per-leg `leg_lock_ts`, `entry_ts` on entries, weighted split at settle/claim — keeper stays the trusted counter, on-chain caps stay the guard). The pure allocator gains per-leg locks + a marquee red-card leg; `create-daily-pearly` composes and opens the card; the settle keeper counts perfect entries **and their weights**; the engine exposes the card, per-leg locks, alive count, and the caller's own card.

**Tech Stack:** Anchor 0.31 (Rust) · ts-mocha anchor tests (`npm test` at repo root) · TypeScript keeper/engine with vitest (`npm test` in `keeper/`, `engine/`) · TxLINE REST (spike client) · devnet.

**Spec:** `docs/superpowers/specs/2026-07-03-streak-hackathon-live-pearly-design.md` (as amended by Task 0).

**Plan split:** This is Plan A of three. Plan B = Pearly web tab (mockup 17 → React). Plan C = Live roar layer + cross-links + notifications. B and C get written after A lands (spec §10).

---

### Task 0: Spec amendments (chaos leg v1 scope, void path)

**Files:**
- Modify: `docs/superpowers/specs/2026-07-03-streak-hackathon-live-pearly-design.md`

- [ ] **Step 1: Amend §2 chaos leg + §3 void handling**

In §2, replace the bullet text "**one day-wide chaos leg** (\"a red card in any match today\", settled off per-fixture reds at last FT)" with:

```markdown
**one chaos leg** — "Red card shown? (Y/N)" on the day's marquee (top-ranked) fixture, new catalog market 17 settling off TxLINE red-card keys 5/6 through the existing per-fixture settle machinery. (Day-wide "any match today" aggregation = post-hackathon; it needs a synthetic-fixture market the settle path can't proof-validate today.)
```

In §3, replace the "Voided legs" bullet with:

```markdown
- **Unresolvable legs** (postponed/abandoned fixture with no proof-determined bucket): the keeper voids the whole contest → every entry refunds (existing `void_contest` path). No per-leg void exclusion this cycle.
```

In §1, append to the Pearly bullet's "One entry per wallet per day — no buy-backs." sentence:

```markdown
(Enforced at the product layer: web/engine always use entry nonce 0, so a wallet has one card. The program's nonce channel remains for legacy parlays; extra raw-CLI tickets just feed the pot.)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-07-03-streak-hackathon-live-pearly-design.md
git commit -m "docs(spec): pearly v1 — chaos leg on marquee fixture; whole-contest void for unresolvable legs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 1: Program state — per-leg locks, entry timestamps, perfect weight

**Files:**
- Modify: `programs/proofbet/src/contest_state.rs`
- Modify: `programs/proofbet/src/errors.rs`

- [ ] **Step 1: Add the constant + Contest/Entry fields**

In `programs/proofbet/src/contest_state.rs`, under the `VOID_GRACE_SECS` const, add:

```rust
/// Minimum legs still open (unlocked) for a new entry to be accepted. Entries
/// close for the day the moment fewer than this many legs remain open — that
/// instant is precomputed at create as `entries_close_ts`.
pub const MIN_OPEN_LEGS: usize = 3;
```

In `struct Contest`, insert after `pub lock_ts: i64,`:

```rust
    /// Per-leg entry lock (the leg's own kickoff). Indices >= num_legs stay 0.
    /// An entry's ACTIVE legs are those with leg_lock_ts[i] > entry.entry_ts.
    pub leg_lock_ts: [i64; MAX_LEGS],
    /// The moment open legs would drop below MIN_OPEN_LEGS — no entries after
    /// this. Derived at create: the (num_legs - MIN_OPEN_LEGS)-th smallest
    /// active leg_lock_ts (0-indexed). For num_legs == 3 this equals lock_ts.
    pub entries_close_ts: i64,
```

In `struct Contest`, insert after `pub perfect_count: u64,`:

```rust
    /// Σ 2^(active legs) over all perfect entries — the weighted-split divisor
    /// (keeper-supplied at settle, same trust class as perfect_count).
    pub perfect_weight: u64,
```

In `struct Entry`, insert after `pub amount: u64,` (BEFORE `bump` so the keeper's
`memcmp` on `contest` at offset 40 is unchanged):

```rust
    /// Unix time of the LAST picks write (init or edit). Refreshing on edit means
    /// a re-pick after a leg locks shrinks the mask instead of cheating it.
    pub entry_ts: i64,
```

- [ ] **Step 2: Add the new error variants**

In `programs/proofbet/src/errors.rs`, add to the `ProofBetError` enum (match the file's existing `#[msg]` style):

```rust
    #[msg("Per-leg lock timestamps are inconsistent with lock_ts/settle_after_ts")]
    InvalidLegLockTs,
    #[msg("perfect_weight is inconsistent with perfect_count")]
    WeightMismatch,
```

- [ ] **Step 3: Build (expect create_contest arg errors next task — state compiles)**

Run: `anchor build 2>&1 | tail -20`
Expected: compile errors ONLY in `create_contest.rs`/`enter.rs`/`settle_contest.rs` handlers if field initialization is now incomplete (`missing field` on Contest init). No errors in `contest_state.rs` itself. (Anchor requires all fields set at init — fixed in Tasks 2–4.)

---

### Task 2: `create_contest` — take per-leg locks, derive `entries_close_ts`

**Files:**
- Modify: `programs/proofbet/src/instructions/create_contest.rs`
- Modify: `programs/proofbet/src/lib.rs` (handler signature passthrough)

- [ ] **Step 1: Extend the handler**

In `create_contest.rs`, change the handler signature (new LAST param, so existing arg order is preserved):

```rust
#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateContest>,
    contest_id: u64,
    fixtures: [i64; MAX_LEGS],
    market_ids: [u8; MAX_LEGS],
    num_legs: u8,
    entry_price: u64,
    lock_ts: i64,
    settle_after_ts: i64,
    fee_recipient: Pubkey,
    fee_bps: u16,
    leg_lock_ts: [i64; MAX_LEGS],
) -> Result<()> {
```

After the existing per-leg `fixtures[i] != 0` loop, add validation + derivation:

```rust
    // Per-leg locks: every active leg locks at its own kickoff — no earlier than
    // the global lock_ts (which must be their minimum) and strictly before settle.
    // Tail entries stay zero (same convention as fixtures/market_ids).
    let nl = num_legs as usize;
    let mut sorted_locks = [i64::MAX; MAX_LEGS];
    for i in 0..MAX_LEGS {
        if i < nl {
            require!(
                leg_lock_ts[i] >= lock_ts && leg_lock_ts[i] < settle_after_ts,
                ProofBetError::InvalidLegLockTs
            );
            sorted_locks[i] = leg_lock_ts[i];
        } else {
            require!(leg_lock_ts[i] == 0, ProofBetError::InvalidLegLockTs);
        }
    }
    require!(
        (0..nl).any(|i| leg_lock_ts[i] == lock_ts),
        ProofBetError::InvalidLegLockTs // lock_ts must BE the earliest leg lock
    );
    sorted_locks[..nl].sort_unstable();
    // Entries close when open legs would drop below MIN_OPEN_LEGS: the
    // (nl - MIN_OPEN_LEGS)-th smallest lock (0-indexed). nl >= 3 is already
    // guaranteed by the num_legs range check above.
    let close_idx = nl.saturating_sub(MIN_OPEN_LEGS);
    let entries_close_ts = sorted_locks[close_idx];
```

In the field-initialization block, add (after `c.lock_ts = lock_ts;`):

```rust
    c.leg_lock_ts = leg_lock_ts;
    c.entries_close_ts = entries_close_ts;
```

and after `c.perfect_count = 0;`:

```rust
    c.perfect_weight = 0;
```

- [ ] **Step 2: Thread the new arg through lib.rs**

In `programs/proofbet/src/lib.rs`, find the `create_contest` program fn and add the trailing param, passing it through to the handler:

```rust
    #[allow(clippy::too_many_arguments)]
    pub fn create_contest(
        ctx: Context<CreateContest>,
        contest_id: u64,
        fixtures: [i64; contest_state::MAX_LEGS],
        market_ids: [u8; contest_state::MAX_LEGS],
        num_legs: u8,
        entry_price: u64,
        lock_ts: i64,
        settle_after_ts: i64,
        fee_recipient: Pubkey,
        fee_bps: u16,
        leg_lock_ts: [i64; contest_state::MAX_LEGS],
    ) -> Result<()> {
        instructions::create_contest::handler(
            ctx, contest_id, fixtures, market_ids, num_legs, entry_price, lock_ts,
            settle_after_ts, fee_recipient, fee_bps, leg_lock_ts,
        )
    }
```

(Adapt to the file's actual passthrough style — keep its existing param names/order and only append `leg_lock_ts`.)

- [ ] **Step 3: Build**

Run: `anchor build 2>&1 | tail -20`
Expected: remaining `missing field entry_ts` / enter/settle errors only (Tasks 3–4); `create_contest.rs` clean.

- [ ] **Step 4: Add the test helper + fix ALL existing createContest callers in tests**

In `tests/contest_helpers.ts`, add and export:

```typescript
/** [lockTs; n legs] padded with 0 — every leg locks at the global lock (legacy shape). */
export function legLockArray(lockTs: number, numLegs: number): BN[] {
  const out: BN[] = [];
  for (let i = 0; i < MAX_LEGS; i++) out.push(new BN(i < numLegs ? lockTs : 0));
  return out;
}
```

Then update EVERY `program.methods.createContest(...)` call in `tests/contest_create.ts`, `tests/contest_enter.ts`, `tests/contest_settle.ts`, `tests/contest_safety.ts`, `tests/contest_six_legs.ts` to append the new trailing argument. Example for `contest_six_legs.ts` (lock var is `lock`, 6 legs):

```typescript
      .createContest(
        new BN(contestId),
        fixtureArray(fixtures),
        marketIdArray(fixtures.map(() => 12)),
        6,
        new BN(1 * LAMPORTS_PER_SOL),
        new BN(lock),
        new BN(lock + 6),
        keeper.publicKey,
        500,
        legLockArray(lock, 6),
      )
```

Use `grep -rn "createContest(" tests/` to find every call site; each gets `legLockArray(<its lock var>, <its numLegs>)` appended.

- [ ] **Step 5: Run the create test (only) to verify the new arg path**

Run: `npx ts-mocha -p ./tsconfig.json -t 1000000 tests/contest_create.ts`
Expected: PASS (may need `anchor build` + local validator per repo convention — use the same command the repo's `npm test` (`anchor test`) uses if standalone mocha lacks a validator; `anchor test` runs the whole suite, which is fine too: expect contest_create green, enter/settle possibly red until Tasks 3–4).

- [ ] **Step 6: Commit**

```bash
git add programs/proofbet/src tests/contest_helpers.ts tests/contest_create.ts tests/contest_enter.ts tests/contest_settle.ts tests/contest_safety.ts tests/contest_six_legs.ts
git commit -m "feat(program): per-leg lock_ts on Contest + derived entries_close_ts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `enter` — gate on `entries_close_ts`, stamp/refresh `entry_ts`

**Files:**
- Modify: `programs/proofbet/src/instructions/enter.rs`
- Test: `tests/contest_pearly.ts` (new)

- [ ] **Step 1: Write the failing test (rolling entry accepted after first leg locks)**

Create `tests/contest_pearly.ts`:

```typescript
import {
  program, freshFunded, SystemProgram, assert, balance, BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  legLockArray, makeSettledResultMarket,
} from "./contest_helpers";

// The Pearly's core on-chain mechanic: per-leg locks + entry_ts. An entry placed
// AFTER a leg has locked is still accepted (until entries_close_ts) and its
// active mask/weight shrinks accordingly (asserted end-to-end in Task 5's test).
describe("pearly — rolling entry", () => {
  it("accepts an entry after the first leg locks but before entries_close_ts; rejects after", async () => {
    await ensureJackpot();
    const keeper = await freshFunded();
    const early = await freshFunded();
    const late = await freshFunded();

    const contestId = 770001;
    const contest = contestPda(contestId);
    const fixtures = [770010, 770011, 770012, 770013, 770014, 770015];
    const t0 = nowSec();
    // Staggered kickoffs: legs lock at +4, +6, +8, +10, +12, +14s.
    // entries_close = 4th smallest (6 - MIN_OPEN_LEGS(3) = index 3) = t0+10.
    const locks = [t0 + 4, t0 + 6, t0 + 8, t0 + 10, t0 + 12, t0 + 14];
    const legLocks = locks.map((l) => new BN(l)); // exactly MAX_LEGS wide

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(0.1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 60),
        keeper.publicKey, 0, legLocks,
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const created = await program.account.contest.fetch(contest);
    assert.equal(created.entriesCloseTs.toNumber(), locks[3], "entries close at the 4th-smallest leg lock");

    // Early entry (all 6 legs open).
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: early.publicKey, contest, entry: entryPda(contest, early.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([early]).rpc();
    const e1 = await program.account.entry.fetch(entryPda(contest, early.publicKey, 0));
    assert.isAtLeast(e1.entryTs.toNumber(), t0, "entry_ts stamped");

    // Late entry: after leg 0 locks (t0+4) but before entries_close (t0+10).
    await sleep(5000);
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([late]).rpc();
    const e2 = await program.account.entry.fetch(entryPda(contest, late.publicKey, 0));
    assert.isAbove(e2.entryTs.toNumber(), locks[0], "late entry stamped after leg 0 locked");

    // After entries_close_ts every enter is rejected.
    await sleep(6000); // now > t0+11 > entries_close (t0+10)
    let rejected = false;
    try {
      await program.methods.enter(new BN(1), pickArray([0, 0, 0, 0, 0, 0]))
        .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 1), systemProgram: SystemProgram.programId })
        .signers([late]).rpc();
    } catch { rejected = true; }
    assert.isTrue(rejected, "enter after entries_close_ts rejected");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `anchor test 2>&1 | grep -A3 "pearly"`
Expected: FAIL — `entriesCloseTs`/`entryTs` unknown fields until enter.rs stamps them (and the late entry is currently rejected at `lock_ts` = first kickoff).

- [ ] **Step 3: Implement in enter.rs**

Replace the lock gate line (`require!(now < ctx.accounts.contest.lock_ts, ...)`) with:

```rust
    // Rolling entry: open until entries_close_ts (the instant fewer than
    // MIN_OPEN_LEGS legs remain open) — NOT the first kickoff.
    require!(
        now < ctx.accounts.contest.entries_close_ts,
        ProofBetError::EntryClosed
    );
```

In the `is_new` branch, after `entry.picks = picks;` add:

```rust
        entry.entry_ts = now;
```

In the edit branch (the `else`), after `ctx.accounts.entry.picks = picks;` add:

```rust
        // Editing re-times the card: the mask is computed from the LAST write, so
        // re-picking after a leg locked shrinks the mask instead of cheating it.
        ctx.accounts.entry.entry_ts = now;
```

- [ ] **Step 4: Build + run the test to verify it passes**

Run: `anchor test 2>&1 | grep -B2 -A6 "pearly"`
Expected: `pearly — rolling entry` PASS. (Other suites must also stay green — `enter` tests previously asserting rejection AT first kickoff may need their assertion moved to `entries_close_ts`; for legacy same-lock contests (`legLockArray(lock, n)`) entries_close == lock, so behavior is unchanged and existing tests pass as-is.)

- [ ] **Step 5: Commit**

```bash
git add programs/proofbet/src/instructions/enter.rs tests/contest_pearly.ts
git commit -m "feat(program): rolling entry — gate on entries_close_ts, stamp entry_ts on write

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `settle_contest` — accept `perfect_weight`, distributable = full raw pool

**Files:**
- Modify: `programs/proofbet/src/instructions/settle_contest.rs`
- Modify: `programs/proofbet/src/lib.rs` (signature passthrough)
- Modify: `programs/proofbet/src/events.rs` (`ContestSettled.perfect_weight`)

- [ ] **Step 1: Extend handler signature + guards**

In `settle_contest.rs`, change the handler to:

```rust
pub fn handler(ctx: Context<SettleContest>, perfect_count: u64, perfect_weight: u64) -> Result<()> {
```

After the existing `perfect_count <= entry_count` require, add:

```rust
    // Weight sanity: zero iff no winners; otherwise between perfect_count × 2^MIN_OPEN_LEGS
    // (every winner carried the minimum mask) and perfect_count × 2^MAX_LEGS.
    if perfect_count == 0 {
        require!(perfect_weight == 0, ProofBetError::WeightMismatch);
    } else {
        let min_w = perfect_count
            .checked_mul(1u64 << MIN_OPEN_LEGS as u64)
            .ok_or(ProofBetError::MathOverflow)?;
        let max_w = perfect_count
            .checked_mul(1u64 << MAX_LEGS as u64)
            .ok_or(ProofBetError::MathOverflow)?;
        require!(perfect_weight >= min_w && perfect_weight <= max_w, ProofBetError::WeightMismatch);
    }
```

- [ ] **Step 2: Replace the even-share winners math with full-raw distributable**

Replace the winners-branch share/payable/dust block (the `let raw = ...` through `let _ = dust;` lines) with:

```rust
        // Weighted split: distributable is the FULL raw pool (net entries + the
        // whole jackpot). Claims pay floor(distributable * w_i / perfect_weight);
        // flooring residue (< perfect_count lamports) stays in the Contest PDA.
        let raw = (pot_net as u128)
            .checked_add(jpool as u128)
            .ok_or(ProofBetError::MathOverflow)?;
        let payable = u64::try_from(raw).map_err(|_| ProofBetError::MathOverflow)?;

        // Contest must end holding floor + payable: pull the whole jackpot in.
        if jpool > 0 {
            ctx.accounts.jackpot.sub_lamports(jpool)?;
            ctx.accounts.contest.add_lamports(jpool)?;
        }
        jackpot_in = jpool;
        distributable = payable;

        require!(
            ctx.accounts.contest.to_account_info().lamports()
                >= floor.checked_add(distributable).ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
        require!(
            ctx.accounts.jackpot.to_account_info().lamports() >= jackpot_rent_floor()?,
            ProofBetError::VaultInsolvent
        );
```

(The rollover branch is untouched. Delete the now-unused `payable >= pot_net` delta logic.)

- [ ] **Step 3: Persist + emit the weight**

In the final mutation block, after `c.perfect_count = perfect_count;` add:

```rust
    c.perfect_weight = perfect_weight;
```

In `programs/proofbet/src/events.rs`, add to `ContestSettled`:

```rust
    pub perfect_weight: u64,
```

and set `perfect_weight,` in the `emit!(ContestSettled { ... })` in settle_contest.rs.

In `lib.rs`, update the `settle_contest` program fn to `(ctx, perfect_count: u64, perfect_weight: u64)` and pass both through.

- [ ] **Step 4: Fix existing settle callers in tests**

`grep -rn "settleContest(" tests/` — every `settleContest(new BN(n))` becomes `settleContest(new BN(n), new BN(w))` where **w = n × 2^(that contest's num_legs)**: legacy entries all pre-date the lock so their active mask is the full card — a 6-leg contest winner weighs 64 (`contest_six_legs.ts`: `settleContest(new BN(1), new BN(64))`), a 4-leg winner weighs 16, a 3-leg winner 8. Read each test's `num_legs` — do NOT blanket-apply 64, or claim's recomputed 2^active shares will mismatch the test's payout assertions. Rollover calls use `settleContest(new BN(0), new BN(0))`. Leave `keeper/settle-contest.ts` alone here — the keeper is its own tsc project (not part of `anchor test`) and gets its real weighted update in Task 9.

- [ ] **Step 5: Build + full anchor suite**

Run: `anchor test 2>&1 | tail -30`
Expected: all suites PASS (six_legs distributable assertion still holds: 1 winner, weight 64/64 → sweeps full raw).

- [ ] **Step 6: Commit**

```bash
git add programs/proofbet/src tests/
git commit -m "feat(program): weighted settle — perfect_weight arg, distributable = full raw pool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `claim_contest` — masked perfect check + weighted share

**Files:**
- Modify: `programs/proofbet/src/instructions/claim_contest.rs`
- Test: extend `tests/contest_pearly.ts`

> **AMENDMENT 2026-07-03 (Task 3 code review finding — land as Part 0 of this task, its own commit, BEFORE the claim change):** the edit path as shipped in Task 3 is a free buy-back, violating spec §1/§7 ("no buy-backs", "a dead card spectates"): a bettor whose carried leg already locked-and-lost can re-submit `enter` (same nonce, even identical picks) before `entries_close_ts`; the re-stamp sheds the dead leg and revives the card at reduced weight. Close it with **weight-neutral edits** — once any carried leg has kicked off, the card is immutable:
>
> - `programs/proofbet/src/instructions/enter.rs`, edit (else) branch, BEFORE writing picks / re-stamping (the guard must read the OLD `entry_ts`):
> ```rust
>         // Weight-neutral edits only: once any carried leg has kicked off, the
>         // card is immutable — a dead card spectates (spec: no buy-backs). A leg
>         // left the mask iff old entry_ts < leg_lock <= now.
>         for i in 0..(ctx.accounts.contest.num_legs as usize) {
>             let ll = ctx.accounts.contest.leg_lock_ts[i];
>             require!(
>                 !(ll > ctx.accounts.entry.entry_ts && ll <= now),
>                 ProofBetError::CardLocked
>             );
>         }
> ```
> - `programs/proofbet/src/errors.rs`: append `#[msg("card has a locked leg; picks are immutable")] CardLocked,` at the enum END (ordinal stability).
> - Tests appended to `tests/contest_pearly.ts` ("pearly — edit freeze" describe): (a) edit after a carried leg locked → rejected `CardLocked` (use the `expectError` idiom, not catch-any); (b) edit before any carried leg locked → accepted and `entryTs` refreshed (assert new > old via fetched values). Legacy contests are unaffected (all locks == lock_ts; the entries-close gate already rejects at that instant — guard unreachable).
> - Post-guard, the re-stamp is provably mask-preserving (a leg leaves the mask iff old_ts < lock <= now — exactly what the guard forbids).
> - Riders in the same Part-0 commit: fix stale `contest_state.rs:57` comment (`lock_ts` = "first kickoff (min of leg_lock_ts)" — no longer entry close); tighten the Task-3 pearly test's catch-any rejection to `expectError(..., "EntryClosed")`; drop the unused `legLockArray` import from contest_pearly.ts if still unused; optionally add the drift-immune `assert.isAbove(e2.entryTs.toNumber(), e1.entryTs.toNumber())` hardening.
> - Part-0 commit message: `fix(program): weight-neutral edits — card freezes once a carried leg kicks off`
> - ONE full `anchor test` run at the end of the whole task covers Part 0 + the claim change together.

- [ ] **Step 1: Write the failing end-to-end weighted test**

Append to `tests/contest_pearly.ts`:

```typescript
describe("pearly — weighted split", () => {
  it("early full card takes 64/96 of the pool, late 5-leg card takes 32/96", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const early = await freshFunded();
    const late = await freshFunded();

    const contestId = 770002;
    const contest = contestPda(contestId);
    const fixtures = [770020, 770021, 770022, 770023, 770024, 770025];
    const t0 = nowSec();
    // Leg 0 locks at +4s; the rest at +11..+15s → entries_close = 4th smallest = t0+13.
    const locks = [t0 + 4, t0 + 11, t0 + 12, t0 + 13, t0 + 14, t0 + 15];
    const results = [0, 1, 2, 0, 1, 2];

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 12),
        keeper.publicKey, 0, locks.map((l) => new BN(l)),
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // EARLY enters before any lock: mask = all 6, weight 64. Picks all correct.
    await program.methods.enter(new BN(0), pickArray(results))
      .accountsStrict({ bettor: early.publicKey, contest, entry: entryPda(contest, early.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([early]).rpc();

    // LATE enters after leg 0 locks (t0+4) with leg 0 WRONG — leg 0 is not in
    // their mask, so they are still perfect on their 5 active legs. Weight 32.
    await sleep(6000);
    const latePicks = [2, results[1], results[2], results[3], results[4], results[5]]; // leg0 wrong on purpose
    await program.methods.enter(new BN(0), pickArray(latePicks))
      .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([late]).rpc();

    // Settle all 6 leg markets, pass settle_after, settle with count=2 weight=96.
    const markets = [];
    for (let i = 0; i < 6; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    await sleep(22000); // past settle_after = locks[5]+12 ≈ t0+27 (we are at ~t0+6 after the late entry)
    await program.methods.settleContest(new BN(2), new BN(96))
      .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const settled = await program.account.contest.fetch(contest);
    assert.equal(settled.perfectWeight.toNumber(), 96);
    const D = settled.distributable.toNumber();

    // Claims: early gets floor(D*64/96), late gets floor(D*32/96).
    const b0 = await balance(early.publicKey);
    await program.methods.claimContest()
      .accountsStrict({ bettor: early.publicKey, contest, entry: entryPda(contest, early.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([early]).rpc();
    const gotEarly = (await balance(early.publicKey)) - b0;
    const b1 = await balance(late.publicKey);
    await program.methods.claimContest()
      .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([late]).rpc();
    const gotLate = (await balance(late.publicKey)) - b1;

    const shareEarly = Math.floor((D * 64) / 96);
    const shareLate = Math.floor((D * 32) / 96);
    // balance() deltas include the closed Entry rent refund — compare against
    // share + entryRent (fetch rent for the Entry size once) OR assert the
    // CONTEST's balance drop instead, which is exactly the share:
    // (preferred, rent-free assertion — restructure to capture contest balances)
    assert.approximately(gotEarly - gotLate, shareEarly - shareLate, 2, "64/96 vs 32/96 split");
  });
});
```

(The executing engineer should prefer contest-balance-delta assertions — the
pattern `cBeforeWin - (await balance(contest))` from `contest_six_legs.ts:92` —
for exact share checks; the wallet-delta `approximately` is the fallback.)

- [ ] **Step 2: Run to verify it fails**

Run: `anchor test 2>&1 | grep -B2 -A8 "weighted split"`
Expected: FAIL — `perfectWeight` exists (Task 4) but claim pays even shares (`distributable / perfect_count`), and the late entry's wrong leg-0 pick marks it imperfect.

- [ ] **Step 3: Implement masked + weighted claim**

In `claim_contest.rs`, replace the `ContestStatus::Settled` arm's perfect-check + share block with:

```rust
        ContestStatus::Settled => {
            let nl = ctx.accounts.contest.num_legs as usize;
            // The entry's ACTIVE legs are those still open when its picks were
            // (last) written. Locked-at-entry legs are outside the card: their
            // picks are ignored. weight = 2^active — matches the keeper's count.
            let entry_ts = ctx.accounts.entry.entry_ts;
            let mut active: u32 = 0;
            // Fail closed on an impossible zero entry_ts (defense-in-depth: zero
            // would mark every leg active since all real locks are > 0; legit
            // entries always stamp a positive clock time).
            let mut perfect = entry_ts > 0;
            for i in 0..nl {
                if ctx.accounts.contest.leg_lock_ts[i] > entry_ts {
                    active += 1;
                    if ctx.accounts.entry.picks[i] != ctx.accounts.contest.winning_buckets[i] {
                        perfect = false;
                    }
                }
            }
            // Entries are only accepted while >= MIN_OPEN_LEGS legs are open, so
            // active >= MIN_OPEN_LEGS for every legitimate entry.
            if perfect && active > 0 {
                require!(ctx.accounts.contest.perfect_count > 0, ProofBetError::PerfectCountZero);
                require!(ctx.accounts.contest.perfect_weight > 0, ProofBetError::PerfectCountZero);
                let weight = 1u128 << active;
                let share = u64::try_from(
                    (ctx.accounts.contest.distributable as u128)
                        .checked_mul(weight)
                        .ok_or(ProofBetError::MathOverflow)?
                        .checked_div(ctx.accounts.contest.perfect_weight as u128)
                        .ok_or(ProofBetError::MathOverflow)?,
                )
                .map_err(|_| ProofBetError::MathOverflow)?;
                require!(
                    ctx.accounts.contest.claimed_count < ctx.accounts.contest.perfect_count,
                    ProofBetError::VaultInsolvent
                );
                require!(
                    ctx.accounts.contest.claimed_total
                        .checked_add(share)
                        .ok_or(ProofBetError::MathOverflow)?
                        <= ctx.accounts.contest.distributable,
                    ProofBetError::VaultInsolvent
                );
                payout = share;
                kind = 1;
            }
        }
```

(The post-payout solvency block keeps working: `outstanding = distributable - claimed_total` over-reserves by the flooring residue, which the PDA actually holds — the checks stay valid.)

- [ ] **Step 4: Run the pearly suite + full suite to verify pass**

Run: `anchor test 2>&1 | tail -30`
Expected: `pearly — weighted split` PASS; ALL legacy suites PASS (legacy contests: every leg locks at lock_ts and every entry predates it → active == num_legs → weight uniform → shares = distributable × 64 / (64 × perfect_count) = the old even split, minus flooring dust).

- [ ] **Step 5: Commit**

```bash
git add programs/proofbet/src/instructions/claim_contest.rs tests/contest_pearly.ts
git commit -m "feat(program): claim — masked perfect check + 2^active weighted share

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Red-card market (id 17) in the catalog

**Files:**
- Modify: `engine/src/markets.ts` (the `MARKET_TEMPLATE`-adjacent defs table at ~line 43)
- Test: extend the existing markets vitest (find with `grep -rln "marketById" engine/test/`)

- [ ] **Step 1: Write the failing test**

In the engine test file that already covers `marketById` (e.g. `engine/test/lib.test.ts` or the markets test found by grep), add:

```typescript
it("market 17: red card shown Y/N settles off red-card stat keys 5/6", () => {
  const def = marketById(17)!;
  expect(def.label).toBe("Red Card Shown Y/N");
  expect(def.group).toBe("cards");
  expect(def.numBuckets).toBe(2);
  expect(def.statKey).toBe(5);
  expect(def.statKey2).toBe(6);
  expect(def.op).toBe("add");
  expect(def.comparison).toBe("greaterThan");
  expect(def.threshold).toBe(0);
  expect(def.settleAt).toBe("FT");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd engine && npm test 2>&1 | grep -A4 "market 17"`
Expected: FAIL — `marketById(17)` undefined.

- [ ] **Step 3: Add the def**

In `engine/src/markets.ts`, after the marketId 16 row, add (matching the table's exact column style):

```typescript
  { marketId: 17, label: "Red Card Shown Y/N",          group: "cards",   line: 0.5, statKey: 5,    statKey2: 6,    op: "add",      comparison: "greaterThan", threshold: 0, settleAt: "FT", numBuckets: 2 },
```

(TxLINE soccer feed base keys: 1/2 goals, 3/4 yellows, **5/6 reds**, 7/8 corners — per the TxLINE scores/soccer-feed docs. Bucket 0 = "yes" (total reds > 0), bucket 1 = "no" — same over/under convention as every 2-bucket def.)

- [ ] **Step 4: Run engine tests to verify pass**

Run: `cd engine && npm test 2>&1 | tail -5`
Expected: PASS (all).

- [ ] **Step 5: Verify the settle classifier accepts key 5/6 (read, no code change expected)**

Run: `grep -n "statKey" keeper/settle-contest.ts keeper/contest.ts engine/src/live.ts | head`
Expected: stat keys flow generically from the def (no hardcoded 1–4/7–8 allowlist). If any hardcoded key allowlist exists, extend it with 5 and 6 in this task and note it in the commit.

- [ ] **Step 6: Commit**

```bash
git add engine/src/markets.ts engine/test/
git commit -m "feat(engine): market 17 — Red Card Shown Y/N off TxLINE red keys 5/6

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Allocator v2 — per-leg locks, winner-cap 4, marquee chaos leg

**Files:**
- Modify: `engine/src/allocator.ts`
- Test: the allocator vitest (find with `grep -rln "buildCard" engine/test/`)

- [ ] **Step 1: Write the failing tests**

In the allocator test file, add:

```typescript
describe("pearly card v2", () => {
  const fx = (id: number, ko: number) => ({ fixtureId: id, home: `H${id}`, away: `A${id}`, kickoffTs: ko });
  const neutral = (id: number, market: number, buckets: number) =>
    ({ fixtureId: id, market, impliedProbs: Array(buckets).fill(1 / buckets) });

  it("buildPearlyCard: 4 fixtures → 4 winners + 1 goals + chaos leg 17 on the marquee, per-leg locks from kickoffs", () => {
    const t0 = 1_000_000;
    const fixtures = [fx(1, t0 + 3600), fx(2, t0 + 7200), fx(3, t0 + 10800), fx(4, t0 + 14400)];
    const odds = fixtures.flatMap((f) => [neutral(f.fixtureId, 12, 3), neutral(f.fixtureId, 11, 2)]);
    const card = buildPearlyCard(fixtures, odds, {
      lockTs: t0, windowSecs: 24 * 3600, target: 6, menu: DEFAULT_MENU, maxImplied: 0.82,
    });
    expect(card.legs).toHaveLength(6);
    expect(card.legs.filter((l) => l.marketId === 12)).toHaveLength(4);
    expect(card.legs.filter((l) => l.marketId === 11)).toHaveLength(1);
    const chaos = card.legs.find((l) => l.marketId === 17)!;
    expect(chaos.fixtureId).toBe(1); // marquee = top-ranked (neutral odds → first)
    // Per-leg locks = each leg's own fixture kickoff.
    for (const leg of card.legs) {
      const f = fixtures.find((x) => x.fixtureId === leg.fixtureId)!;
      expect(leg.lockTs).toBe(f.kickoffTs);
    }
    // entriesCloseTs = 4th-smallest leg lock.
    const sorted = card.legs.map((l) => l.lockTs).sort((a, b) => a - b);
    expect(card.entriesCloseTs).toBe(sorted[3]);
    expect(card.lockTs).toBe(sorted[0]);
  });

  it("buildPearlyCard: no clusterBySpread — a 12h-spread slate keeps all fixtures", () => {
    const t0 = 2_000_000;
    const fixtures = [fx(11, t0 + 3600), fx(12, t0 + 12 * 3600)];
    const odds = fixtures.flatMap((f) => [neutral(f.fixtureId, 12, 3), neutral(f.fixtureId, 11, 2)]);
    const card = buildPearlyCard(fixtures, odds, {
      lockTs: t0, windowSecs: 24 * 3600, target: 6, menu: DEFAULT_MENU, maxImplied: 0.82,
    });
    expect(new Set(card.legs.map((l) => l.fixtureId)).size).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd engine && npm test 2>&1 | grep -A4 "pearly card v2"`
Expected: FAIL — `buildPearlyCard` not exported.

- [ ] **Step 3: Implement `buildPearlyCard` in allocator.ts**

Append to `engine/src/allocator.ts` (reusing the existing helpers; do NOT modify `buildCard` — the legacy path stays for the single-match parlay):

```typescript
// ── Pearly (all-day, cross-fixture card) ─────────────────────────────────────────

/** A pearly leg carries its own entry lock (its fixture's kickoff). */
export type PearlyLeg = Leg & { lockTs: number };

export type PearlyCard = {
  legs: PearlyLeg[];
  lockTs: number;          // min leg lock (first kickoff)
  entriesCloseTs: number;  // the (n - MIN_OPEN_LEGS)-th smallest leg lock
  settleAfterTs: number;   // last kickoff + match buffer
};

/** Chaos market: Red Card Shown Y/N on the marquee fixture. */
const M_RED_CARD = 17;
/** Mirrors the program's MIN_OPEN_LEGS (contest_state.rs). */
const MIN_OPEN_LEGS = 3;

/**
 * Compose the Daily Pearly: the WHOLE day's eligible slate (no cluster collapse —
 * the day IS the game), one Result leg per fixture (up to 4), one Goals leg on the
 * most competitive fixture, remaining slots from the HT menu, and the final slot
 * RESERVED for the chaos leg: Red Card Y/N (market 17) on the marquee (top-ranked)
 * fixture. Per-leg lockTs = the leg's own fixture kickoff; entriesCloseTs is the
 * (n − MIN_OPEN_LEGS)-th smallest lock so ≥3 legs are always open to a new entry.
 */
export function buildPearlyCard(
  fixtures: Fixture[],
  odds: Odds[],
  opts: Omit<BuildCardOpts, "maxSpreadSecs">,
): PearlyCard {
  const { lockTs, windowSecs, target, menu, maxImplied } = opts;
  const eligible = filterEligible(fixtures, lockTs, windowSecs);
  const ranked = rankMatches(eligible, odds);
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));

  // Reserve one slot for the chaos leg; allocate the rest with a 4-winner cap.
  // allocateLegs caps Results at floor(target/2); with target-1 == 5 that is 2 —
  // too few. Run the Result pass manually to 4, then let allocateLegs fill the
  // remainder from the non-Result menu with the chosen legs excluded.
  const legs: Leg[] = [];
  const idx = new Set(odds.map((o) => `${o.fixtureId}:${o.market}`));
  for (const f of ranked) {
    if (legs.length >= Math.min(4, target - 2)) break;
    if (idx.has(`${f.fixtureId}:12`) && menu.includes(12)) {
      legs.push({ fixtureId: f.fixtureId, marketId: 12 });
    }
  }
  const exclude = new Set(legs.map((l) => `${l.fixtureId}:${l.marketId}`));
  const fillTarget = target - 1; // one slot reserved for chaos
  const fill = allocateLegs(ranked, odds, fillTarget - legs.length, menu.filter((m) => m !== 12), exclude);
  legs.push(...fill);

  const gated = qualityGate(legs, odds, maxImplied);

  // Chaos leg — marquee fixture (top-ranked), market 17, NOT quality-gated (a
  // red card is never a foregone conclusion) and always priced (Y/N).
  const out: Leg[] = gated.slice(0, target - 1);
  if (ranked.length > 0) out.push({ fixtureId: ranked[0].fixtureId, marketId: M_RED_CARD });

  const pearlyLegs: PearlyLeg[] = out.map((l) => ({
    ...l,
    lockTs: byId.get(l.fixtureId)?.kickoffTs ?? lockTs,
  }));

  const locks = pearlyLegs.map((l) => l.lockTs).sort((a, b) => a - b);
  const first = locks[0] ?? lockTs;
  const closeIdx = Math.max(0, pearlyLegs.length - MIN_OPEN_LEGS);
  const entriesCloseTs = locks[closeIdx] ?? first;
  const last = locks[locks.length - 1] ?? lockTs;

  return {
    legs: pearlyLegs,
    lockTs: first,
    entriesCloseTs,
    settleAfterTs: last + 2 * 3600,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd engine && npm test 2>&1 | tail -5`
Expected: PASS (all — legacy `buildCard` tests untouched).

- [ ] **Step 5: Commit**

```bash
git add engine/src/allocator.ts engine/test/
git commit -m "feat(engine): buildPearlyCard — whole-day slate, 4-winner cap, marquee red-card chaos leg, per-leg locks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `create-daily-pearly` keeper (compose + open the card)

**Files:**
- Create: `keeper/create-daily-pearly.ts` (start from a copy of `keeper/create-daily-card.ts` — same auth/slate/odds plumbing)
- Test: `keeper/test/pearly.test.ts` (new; mirror the `createDailyCard` spy pattern in `keeper/test/contest.test.ts`)

- [ ] **Step 1: Write the failing wire-args test**

Create `keeper/test/pearly.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { createDailyPearly } from "../create-daily-pearly.js";

// Program.methods spy — the create-daily-card test pattern: capture wire args,
// never touch the network.
function programSpy() {
  const calls: Record<string, unknown[][]> = { createContest: [], initializeMarket: [] };
  const rpc = vi.fn().mockResolvedValue("SIG");
  const chain = { accountsStrict: () => ({ rpc }) };
  return {
    calls,
    program: {
      programId: new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ"),
      account: {
        contest: { fetchNullable: vi.fn().mockResolvedValue(null) },
        market: { fetchNullable: vi.fn().mockResolvedValue(null) },
      },
      methods: {
        createContest: (...a: unknown[]) => { calls.createContest.push(a); return chain; },
        initializeMarket: (...a: unknown[]) => { calls.initializeMarket.push(a); return chain; },
      },
    },
  };
}

describe("createDailyPearly", () => {
  it("passes per-leg locks (leg_lock_ts) as the trailing createContest arg and ensures the chaos market", async () => {
    const { calls, program } = programSpy();
    const kp = Keypair.generate().publicKey;
    const t0 = 1_900_000_000;
    const card = {
      legs: [
        { fixtureId: 101, marketId: 12, lockTs: t0 + 3600 },
        { fixtureId: 102, marketId: 12, lockTs: t0 + 7200 },
        { fixtureId: 103, marketId: 12, lockTs: t0 + 10800 },
        { fixtureId: 104, marketId: 12, lockTs: t0 + 14400 },
        { fixtureId: 101, marketId: 11, lockTs: t0 + 3600 },
        { fixtureId: 101, marketId: 17, lockTs: t0 + 3600 },
      ],
      lockTs: t0 + 3600,
      entriesCloseTs: t0 + 10800,
      settleAfterTs: t0 + 14400 + 7200,
    };
    const fixtures = [101, 102, 103, 104].map((id, i) => ({
      fixtureId: id, home: `H${id}`, away: `A${id}`, kickoffTs: t0 + (i + 1) * 3600,
    }));

    const res = await createDailyPearly(program as never, kp, kp, card, fixtures, 777_020_640, {
      entryPriceLamports: 50_000_000, feeBps: 0,
    });
    expect(res.action).toBe("created");
    // chaos market 17 got an initialize_market call
    expect(calls.initializeMarket.some((a) => a[1] === 17)).toBe(true);
    // createContest wire args: [id, fixtures, marketIds, numLegs, price, lock, settleAfter, feeRecipient, feeBps, legLockTs]
    const args = calls.createContest[0];
    expect(args).toHaveLength(10);
    const legLocks = (args[9] as { toNumber(): number }[]).map((b) => b.toNumber());
    expect(legLocks).toEqual([t0 + 3600, t0 + 7200, t0 + 10800, t0 + 14400, t0 + 3600, t0 + 3600]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd keeper && npm test 2>&1 | grep -A4 "createDailyPearly"`
Expected: FAIL — module `../create-daily-pearly.js` not found.

- [ ] **Step 3: Implement `keeper/create-daily-pearly.ts`**

Copy `keeper/create-daily-card.ts` → `keeper/create-daily-pearly.ts`, then apply these changes (everything else — auth, `fetchSlate`, `buildOdds`, `dailyContestId`, PDA helpers, printer — stays as-is):

1. Import the pearly composer and type:
```typescript
import { buildPearlyCard, DEFAULT_MENU, type PearlyCard, type Fixture, type Odds } from "../engine/src/allocator.js";
```
2. Widen the menu used by `buildOdds` so chaos is priceable (market 17 is always Y/N — include it so `marketById` lookups at ensure-time succeed): `const MENU = [...DEFAULT_MENU, 17];` and pass `MENU` to `buildOdds` (17 gets a neutral [0.5, 0.5] prior when its pool is absent — the normal case).
3. Compose with the pearly builder (NO `maxSpreadSecs` — the day is the game):
```typescript
  const card = buildPearlyCard(fixtures, odds, {
    lockTs: nowSecs, windowSecs, target: TARGET_LEGS, menu: DEFAULT_MENU, maxImplied: MAX_IMPLIED,
  });
```
4. Rename the driver `createDailyCard` → `createDailyPearly` with `card: PearlyCard`, and in the `createContest` call append the per-leg locks as the trailing arg:
```typescript
  const legLockArr = pad(legs.map((l) => new BN(l.lockTs)), new BN(0));
  // ...
      .createContest(
        new BN(contestId),
        fixturesArr.map((f) => new BN(f)),
        marketIdsArr,
        numLegs,
        new BN(opts.entryPriceLamports),
        new BN(card.lockTs),
        new BN(card.settleAfterTs),
        feeRecipient,
        opts.feeBps,
        legLockArr,
      )
```
5. Per-leg market ensure already iterates `legs` and calls `initializeMarket(fixtureId, marketId, ...)` — market 17 flows through unchanged (its `entryCloseSec` = its fixture kickoff, already the code's behavior).
6. Entry price default: `--entry-price` default `"0.05"` (spec §12).
7. `isMain` guard string → `"create-daily-pearly.ts"`.

- [ ] **Step 4: Run to verify pass**

Run: `cd keeper && npm test 2>&1 | tail -5`
Expected: PASS (all keeper tests).

- [ ] **Step 5: Devnet dry-run (compose against the real slate)**

Run: `cd keeper && npx tsx create-daily-pearly.ts --dry-run`
Expected: printed card with ≤6 legs across today's real WC fixtures, a `mkt 17` leg on the top-ranked fixture, per-leg locks visible, `entries_close` between first and last kickoff. (If no eligible fixtures right now, expected: "no legs" message — rerun on a match day morning.)

- [ ] **Step 6: Commit**

```bash
git add keeper/create-daily-pearly.ts keeper/test/pearly.test.ts
git commit -m "feat(keeper): create-daily-pearly — cross-fixture card with per-leg locks + chaos market ensure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Settle keeper — weighted perfect counting

**Files:**
- Modify: `keeper/contest.ts` (pure helper)
- Modify: `keeper/settle-contest.ts` (pass `perfect_weight`)
- Test: extend `keeper/test/contest.test.ts`

- [ ] **Step 1: Write the failing helper test**

In `keeper/test/contest.test.ts`, add:

```typescript
import { countPerfectWeighted } from "../contest.js";

describe("countPerfectWeighted", () => {
  const legLockTs = [100, 200, 300, 400, 500, 600];
  const winning = [0, 1, 2, 0, 1, 2];
  it("full-mask early entry counts weight 64; late 5-leg entry (leg0 locked, leg0 pick wrong) counts weight 32", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 1, 2], entryTs: 50 },   // perfect, 6 active → 64
      { picks: [9, 1, 2, 0, 1, 2], entryTs: 150 },  // leg0 locked at entry → masked out → perfect on 5 → 32
      { picks: [0, 1, 2, 0, 1, 9], entryTs: 50 },   // active leg 5 wrong → imperfect
    ];
    const r = countPerfectWeighted(entries, winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 2, perfectWeight: 96 });
  });
  it("rollover: nobody perfect → 0/0", () => {
    const r = countPerfectWeighted([{ picks: [9, 9, 9, 9, 9, 9], entryTs: 50 }], winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 0, perfectWeight: 0 });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `cd keeper && npm test 2>&1 | grep -A4 "countPerfectWeighted"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helper in `keeper/contest.ts`**

Add next to the existing `countPerfect` (keep that one — legacy callers):

```typescript
/** Weighted perfect tally for the Pearly: an entry's ACTIVE legs are those whose
 * leg lock is strictly after its entryTs; perfect = all active picks match; each
 * perfect entry contributes 2^active to the weight. Mirrors claim_contest.rs. */
export function countPerfectWeighted(
  entries: { picks: number[]; entryTs: number }[],
  winningBuckets: number[],
  legLockTs: number[],
  numLegs: number,
): { perfectCount: number; perfectWeight: number } {
  let perfectCount = 0;
  let perfectWeight = 0;
  for (const e of entries) {
    let active = 0;
    let perfect = true;
    for (let i = 0; i < numLegs; i++) {
      if (legLockTs[i] > e.entryTs) {
        active++;
        if (e.picks[i] !== winningBuckets[i]) perfect = false;
      }
    }
    if (perfect && active > 0) {
      perfectCount++;
      perfectWeight += 2 ** active;
    }
  }
  return { perfectCount, perfectWeight };
}
```

- [ ] **Step 4: Wire it into `keeper/settle-contest.ts`**

Where the file currently maps entries and calls `countPerfect` (~line 236–241), change the mapping to carry `entryTs` and use the weighted counter, then pass BOTH args to `settleContest`:

```typescript
  const { perfectCount, perfectWeight } = countPerfectWeighted(
    entries.map((e) => ({
      picks: e.account.picks as number[],
      entryTs: Number(e.account.entryTs),
    })),
    winningBuckets,
    (contestAcc.legLockTs as { toString(): string }[]).map((b) => Number(b.toString())),
    numLegs,
  );
```

and at the `.settleContest(...)` call (~line 299):

```typescript
    .settleContest(new BN(perfectCount), new BN(perfectWeight))
```

Update the file's preview/log lines that referenced the even share (`${perfectCount}/${entryCount} winner(s) → ... each`) to print the weight instead: `` `${perfectCount} winner(s), total weight ${perfectWeight}` `` (each winner's share differs now — drop the per-head preview or compute per-entry previews from the weights).

- [ ] **Step 5: Run keeper tests**

Run: `cd keeper && npm test 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add keeper/contest.ts keeper/settle-contest.ts keeper/test/contest.test.ts
git commit -m "feat(keeper): weighted perfect counting → settle_contest(perfect_count, perfect_weight)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Anchor build + devnet redeploy + size constants

**Files:**
- Modify: `engine/src/chain.ts:97` (`CONTEST_SIZE`)
- Modify: any other hardcoded Contest/Entry size (find: `grep -rn "217\|CONTEST_SIZE\|ENTRY_SIZE" engine/src keeper/*.ts web/src`)

- [ ] **Step 1: Build and read the authoritative sizes from the IDL**

Run:
```bash
anchor build && node -e "
const idl = require('./target/idl/proofbet.json');
for (const a of idl.accounts) console.log(a.name);
" && node -e "
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
const idl = require('./target/idl/proofbet.json');
const c = new BorshAccountsCoder(idl);
console.log('Contest size:', c.size(idl.accounts.find(a=>a.name==='Contest') ?? 'Contest'));
console.log('Entry size:', c.size(idl.accounts.find(a=>a.name==='Entry') ?? 'Entry'));
"
```
Expected: Contest = **281** (217 + 48 leg locks + 8 entries_close + 8 perfect_weight), Entry = **103** (95 + 8 entry_ts). If the coder API differs, compute by hand from `contest_state.rs` and verify against `(program.account as any).contest.size` in a scratch script — the number, not the method, is the deliverable.

- [ ] **Step 2: Update the fallback constants**

In `engine/src/chain.ts` set `const CONTEST_SIZE = 281;` (was 217) and update the comment. Fix any other match from the grep (keeper scanners, web constants) to the new numbers.

- [ ] **Step 3: Full local suite green**

Run: `npm test` (repo root — `anchor test`)
Expected: ALL anchor suites PASS.

- [ ] **Step 4: Deploy in place to devnet (same program id — the v2/v3 pattern)**

Run: `anchor deploy --provider.cluster devnet 2>&1 | tail -3`
Expected: `Deploy success` for program `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`.
NOTE: pre-change Contest/Entry accounts (old size) become undecodable under the new IDL — the engine's `dataSize` filter (now 281) excludes them by design, same as the v1→v2 orphaning. Any OPEN old-size contest should be settled/voided BEFORE deploying (check: `cd keeper && npx tsx settle-contest.ts --dry-run`).
OPERATIONAL (verified 07-03): a local engine (`engine src/server.ts`) and keeper cron (`keeper cron.ts`, LIVE+LINES jobs) are RUNNING with the old IDL in memory — do NOT restart them before this deploy; restart BOTH right after it so they pick up the new IDL + program. Market/LivePool layouts are untouched, so LINES and LIVE jobs are unaffected throughout.

- [ ] **Step 5: Commit**

```bash
git add engine/src/chain.ts target/idl/proofbet.json
git commit -m "chore: contest/entry account sizes 281/103 after pearly fields; devnet redeploy in place

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(The regenerated `target/idl/proofbet.json` is tracked and runtime-loaded by engine/keeper — it commits HERE, with the deploy, so the committed IDL always matches the deployed program.)

---

### Task 11: Engine — `/api/card` v2 (locks, alive count, my card)

**Files:**
- Modify: `engine/src/chain.ts` (`ContestView` + `toContestView`: add `legLockTs: number[]`, `entriesCloseTs: number`, `perfectWeight: string`)
- Modify: `engine/src/routes.ts:292` (`GET /api/card`)
- Test: extend `engine/test/routes.test.ts` + `engine/test/chain.contest.test.ts`

- [ ] **Step 1: Write the failing view-mapper test**

In `engine/test/chain.contest.test.ts`, extend the existing `toContestView`-shaped fixture (follow the file's current mock-account pattern) asserting the three new fields pass through:

```typescript
it("contest view carries pearly fields", () => {
  // extend the existing decoded-contest fixture object with:
  //   legLockTs: [1000, 2000, 3000, 4000, 5000, 6000].map(BN),
  //   entriesCloseTs: new BN(4000), perfectWeight: new BN(0)
  // and assert on the mapped view:
  expect(view.legLockTs).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
  expect(view.entriesCloseTs).toBe(4000);
  expect(view.perfectWeight).toBe("0");
});
```

(Write it against the file's real fixture helper — the assertion block above is the contract.)

- [ ] **Step 2: Run to verify fail, implement, re-run**

Run: `cd engine && npm test 2>&1 | grep -A4 "pearly fields"` → FAIL.
Implement in `chain.ts`: add to `ContestView` interface —

```typescript
  legLockTs: number[];      // per-leg entry locks (unix sec), tail zeros trimmed to numLegs
  entriesCloseTs: number;   // no entries after this
  perfectWeight: string;    // u64 as string (settled contests)
```

and in `toContestView` map them from the decoded account (same BN-to-number/string idiom the function already uses for `lockTs`/`perfectCount`):

```typescript
    legLockTs: (c.legLockTs as { toNumber(): number }[]).slice(0, Number(c.numLegs)).map((b) => b.toNumber()),
    entriesCloseTs: Number(c.entriesCloseTs),
    perfectWeight: String(c.perfectWeight),
```

Re-run → PASS.

- [ ] **Step 3: Extend `/api/card` — alive count + my card (failing route test first)**

In `engine/test/routes.test.ts`, following the file's existing `/api/card` test setup (injected chain readers), add:

```typescript
it("/api/card returns per-leg locks, entriesCloseTs, aliveCount and myCard for ?wallet=", async () => {
  // arrange the existing card fixture so:
  //  - contest has legLockTs/entriesCloseTs (from Step 2's view)
  //  - two entries exist: one with picks matching all currently-settled legs, one not
  //  - one leg's market is settled with winningBucket 1
  const res = await app.inject({ method: "GET", url: `/api/card?wallet=${WALLET}` });
  const body = res.json();
  expect(body.card.entriesCloseTs).toBeTypeOf("number");
  expect(body.card.legs[0].lockTs).toBeTypeOf("number");
  expect(body.card.aliveCount).toBe(1);          // one entry still perfect on settled legs
  expect(body.card.myCard.weight).toBe(64);      // wallet entered pre-lock, 6 active legs
  expect(body.card.myCard.picks).toHaveLength(6);
});
```

- [ ] **Step 4: Implement the route additions**

In `routes.ts` `/api/card` handler:
1. Pass through `legLockTs` (zip into the existing per-leg objects as `lockTs`) and top-level `entriesCloseTs` from the `ContestView`.
2. **aliveCount:** fetch the contest's entries (reuse the pattern from `/api/contest/entries` — `(program.account as any).entry.all([{ memcmp: { offset: 40, bytes: contestPda.toBase58() } }])`), fetch each leg's market state (the handler already resolves leg markets for labels/winning buckets); an entry is ALIVE iff for every leg with a settled winning bucket that is ACTIVE for it (`legLockTs[i] > entryTs`), `picks[i] === winningBucket`. Count alive entries.
3. **myCard** (only when `?wallet=` parses as a pubkey): the wallet's entry mapped to `{ picks, entryTs, activeMask: boolean[], weight: 2**activeCount, alive: boolean }`, `null` when absent.
4. Cache note: entry scans per request are acceptable at demo scale; reuse the route's existing read-through style (no new cache layer).

- [ ] **Step 5: Run engine tests**

Run: `cd engine && npm test 2>&1 | tail -5`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add engine/src/chain.ts engine/src/routes.ts engine/test/
git commit -m "feat(engine): /api/card v2 — per-leg locks, entriesCloseTs, aliveCount, myCard weight

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Cron — schedule the pearly create job

**Files:**
- Modify: `keeper/cron.ts` (the CREATE job — find with `grep -n "create-daily-card\|DAILY_CARD_CREATE" keeper/cron.ts`)

- [ ] **Step 1: Swap the job target + env flag**

Point the daily CREATE job at `create-daily-pearly.ts` gated on `PEARLY_CREATE=1` (replacing the paused `DAILY_CARD_CREATE` gate; keep the same spawn/`--dry-run` passthrough and 08:00 UTC `DAILY_CREATE_HOUR_UTC` default). Match the file's existing job-definition style exactly — this is a two-line retarget, not a rewrite.

- [ ] **Step 2: Dry-run the scheduler decision path**

Run: `cd keeper && PEARLY_CREATE=1 npx tsx cron.ts --dry-run 2>&1 | head -20`
Expected: the job table lists the pearly create (with next-run time) and the LIVE/SETTLE/SCHEDULE/LINES jobs unchanged; no transactions sent.

- [ ] **Step 3: Commit**

```bash
git add keeper/cron.ts
git commit -m "feat(keeper): cron CREATE job → create-daily-pearly (PEARLY_CREATE gate)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Devnet end-to-end VERIFY (evidence before done)

**Files:** none (verification only; fixes loop back into the relevant task)

- [ ] **Step 1: Create today's real card on devnet**

Run: `cd keeper && npx tsx create-daily-pearly.ts`
Expected: `create_contest: <sig>` + contest pubkey; legs across today's real WC fixtures incl. the market-17 chaos leg. (No match day → run on the next one; R16/QF run daily July 4–11.)

- [ ] **Step 2: Enter twice — early full card + post-first-KO late card**

Using the repo's existing entry path (the web app against devnet, or a scratch script with `buildEnterTx`): place one entry before first KO and one after the first fixture kicks off but before `entriesCloseTs`.
Expected: both land; `curl "$ENGINE/api/card?wallet=<late-wallet>"` shows `myCard.weight` < 64 for the late one.

- [ ] **Step 3: Watch settle waves + final settle**

Run: `cd keeper && npx tsx settle-contest.ts --dry-run` during/after the matches, then the real run after the last whistle (or let cron do it).
Expected: log shows `countPerfectWeighted` results; on-chain contest reaches `Settled` with `perfect_weight` set, or `RolledOver` with the pot visible in `/api/jackpot`.

- [ ] **Step 4: Claim + verify weighted share**

Claim from the early wallet; verify received lamports ≈ `distributable × 64 / perfect_weight` (explorer or balance delta).
Expected: matches within rounding; `/api/card` flips the entry to claimed on next poll.

- [ ] **Step 5: Record the evidence**

Append sigs + numbers (create sig, entry sigs, settle sig, weights, shares) to `docs/superpowers/plans/2026-07-03-pearly-core.md` under a "## E2E evidence" heading, commit:

```bash
git add docs/superpowers/plans/2026-07-03-pearly-core.md
git commit -m "docs(plan): pearly core devnet e2e evidence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Not in this plan (deliberately)

- **Web Pearly tab** (picker/day HUD/death/over card from mockup 17) → Plan B, written after Task 13's evidence lands.
- **Live roar layer, cross-links, notifications, SSE migration** → Plan C.
- **Public GitHub remote + Railway deploy + demo video** → submission checklist (spec §9), scheduled 07/17–18.
