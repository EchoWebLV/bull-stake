# Streak — Live Match Game: Real Implementation Architecture (v2, review-hardened)

**Author:** Lead architect · **Date:** 2026-07-01 · **Branch target:** `feat/streak-pivot`
**Program ID:** `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ` (`lib.rs:11`) — an **extension of the existing program**, not a new one.

**The one-sentence shape:** a per-match SOL pot; players join before kickoff; during the match rapid "calls" appear; each **tap locks a pick on-chain via a MagicBlock Ephemeral Rollup (ER)** (10–50 ms, cheap); the keeper resolves each call from the TxLINE feed and posts the outcome; points accrue on the ER (rarity base + 3-in-a-row escalator, miss wipes bonus keeps base); at full-time the **score state is committed + undelegated back to base layer**, where **the program itself recomputes the max over every seat** and settles — most points wins, ties split. The client sim `web/src/lib/liveGame.ts` is the *starting* spec; where the on-chain model must diverge from it (per-player timing → shared calls), **the on-chain rules defined here are the spec of record**, and the TS port is rewritten to match them.

**Two things stated up front, because this is real money:**

1. **Custody stays on base layer, always.** The pot lamports never leave the base-layer `LivePool` PDA, which is **never delegated**. Only per-seat *score* state and a small *live cursor* are handed to the ER. This is a change from the first draft (which delegated the pot) — see §1.3/§H2-resolved — and it is what keeps the permissionless void backstop reachable if the keeper dies mid-match (§H1-resolved).

2. **The keeper never declares who wins.** Settlement recomputes `winning_score = max(total)` and `winner_count = |{total == max}|` **on-chain, over every committed `LiveEntry`, in a single transaction**, with each entry bound by PDA seeds + program ownership. The keeper's only on-chain writes are per-call *outcomes* (single scalars, oracle-anchored). This closes the argmax prize-theft hole the review found (§C1-resolved); it means `settle_live_pool` is **not** a verbatim `settle_contest` clone — it is new code with new tests, budgeted as such.

**Devnet vs. mainnet honesty:** the full real-time tap-lock-before-outcome loop is a **mainnet** product. Devnet TxLINE is Level-1 (60 s delayed), so true in-play settlement is exploitable there (§2). Slices 1–3 are fully demoable on devnet as real-money SOL mechanics; the real-time *fairness* posture (and even then only a *mitigated*, never *eliminated*, courtsiding edge — §H3-resolved) arrives with mainnet Level-12. Every seam is marked accordingly.

---

## 1) TARGET ARCHITECTURE

### 1.0 Scoring rules — the on-chain spec of record

These begin as an extraction from the sim (`web/src/lib/liveGame.ts`) but are **redefined here as the authoritative on-chain semantics**. Where the sim's behavior depends on per-player wall-clock timing, the on-chain rule is stated explicitly and the TS port is rewritten to match (see §1.0.1). The headline fidelity test asserts on-chain totals against *this* spec, not against the un-modified sim.

**Base points by rarity** (from `nextGoal`/`cornerSoon`/`cardSoon`/`goalRush`, `liveGame.ts:210–242`, the `weight`/`p` fields): scorer / next-goal-team = **4**, goal-rush YES = **3**, booking YES = **3**, corner YES = **2**, "nothing"/NO = **1**. Base for a correct pick = `weight[outcome]`, default 1. On-chain this table lives **per call** in `Call.base_points` so scoring never trusts an off-chain number.

**Streak escalator** (`grade`, `:264–268`): on a hit, `streak++`; if `streak >= 3`, that call's bonus = `streak - 2` (+1 at streak 3, +2 at 4, +3 at 5…); `bonus_pts += bonus`.

**Miss** (`grade`, `:269–272`): wrong pick keeps base already banked, sets `streak = 0` and `bonus_pts = 0` (wipes accumulated bonus). Gains 0 base this call.

**Timeout = miss** (`skipCall`, `:276–282`): no pick for a resolved call → same as miss.

**Void** (`voidCall`, `:283–288`): call voided → no penalty, no gain, streak/bonus **unchanged**. See §1.0.1 for how per-player void becomes a **global** void on-chain.

**Total = base_pts + bonus_pts** (`tot`, `:141`).

**Settlement** (`endMatch`, `:301–326`): `top = max(total)`; `winners = {p : total == top}`; `share = pot_net / |winners|`; **a winner requires `top > 0`**. Ties split evenly; dust rolls to jackpot.

#### 1.0.1 Where the on-chain model deliberately diverges from the sim (resolves C2)

The first draft claimed "a player's total is a pure fold over (call → pick → outcome)" and that on-chain totals would match the TS sim *exactly*. That is **false for two sim mechanisms**, both verified in `liveGame.ts`:

- **Per-player void.** `onGoal` (`:190–193`) calls `voidCall` only when *that player's* call is still in the `answer` phase. Whether a call voids is a function of when the player was still deciding — wall-clock, per player. A shared on-chain `Call` has **one** `state`/`outcome` for all seats and cannot represent "voided for Alice, resolved for Bob."
- **Timeout-vs-lock race.** In the sim a single-threaded clock decides timeout (`tick`, `:340`). On the ER, a late `lock_pick` vs. `resolve_call` is a transaction-ordering question, not a deterministic clock tick.

**On-chain rules of record (these are what SLICE 1 tests assert):**

1. **Void is global and keeper-driven.** A call is `Voided` for *everyone* iff the keeper posts `resolve_call(seq, VOID)` — used when the feed shows a disqualifying event (a goal) landed while a non-goal call was open. `score_entry` on a `Voided` call is a **no-op for every seat** (streak/bonus/base all unchanged), mirroring `voidCall`'s "no penalty" but applied uniformly. This is a deliberate, documented product change from the sim's per-player void.
2. **Pick validity is decided by state, not clock.** A pick counts iff it was accepted (`lock_pick` succeeded, i.e. the `Call` was `Open` and within `answer_secs`) and stored in `LiveEntry.pending_call_seq == seq`. At `resolve_call`, the `Call` transitions `Open → Resolving/Resolved` and **no further `lock_pick` for that seq is accepted** (guarded by `Call.state != Open`). This makes "did my pick land in time?" a total order enforced by the runtime, removing the race. A seat with no accepted pick for a `Resolved` call is scored as a miss.
3. **Determinism after resolve.** Once every call is `Resolved` or `Voided`, each seat's `total` is a deterministic fold over the immutable `(Call.base_points, Call.outcome/void, LiveEntry.pending_pick)` triples. That determinism is what lets the base layer recompute `max` at settle (§1.2) — it is *not* claimed to equal the sim on a during-answer-goal scenario, and the TS `driveMatch` oracle is written to these rules.

**Consequence for tests:** the SLICE-1 fidelity test is `test('driveMatch total matches the on-chain scoring spec (this doc §1.0/§1.0.1) fold exactly')`, and the TS `liveGame` port used as the oracle is the **rewritten** one with global void + state-gated picks. The un-modified UI sim remains the *product* animation but is not the test oracle.

---

### 1.1 On-chain accounts (new — extend the existing program)

Precedent followed exactly: **PDA-as-escrow, pot = native lamports above rent floor, no stored balance field** (`contest_state.rs:67–71`), and **account size as the discovery discriminator** (Contest 217, v1 207; live accounts get their own sizes so size-filtered `getProgramAccounts` scans separate cleanly — the keeper/engine already rely on this, `settle-contest.ts:334–357`, `chain.ts:323–365`).

New file: `programs/proofbet/src/live_state.rs` (sibling to `contest_state.rs`).

**Design change from draft (resolves H2 + M4): custody, liveness, and score are split across three accounts so money and liveness never fight over one account.**

- `LivePool` — holds the pot lamports, terminal status, settle results. **Base-layer only, never delegated.**
- `LiveCursor` — the live call cursor (`call_seq`, `open_call_seq`). **Delegated to the ER** alongside entries so `open_call`/`resolve_call` can advance it there. Holds no lamports beyond its own rent.
- `LiveEntry` — a seat + running score. **Delegated to the ER** (the account the ER mutates on every tap-resolve).
- `Call` — one call window + resolved outcome. **Created on base layer at pool creation, then delegated** (resolves M2 — no ER-side account creation).

#### `LivePool` — the pot + terminal state (base-layer, non-delegated)

```rust
pub const MAX_CALLS: usize = 64; // safety cap; matches liveGame MAX_EVENTS=40 headroom
pub const VOID_OUTCOME: u8 = 0xFE; // sentinel written to Call.outcome on a global void
pub const OUTCOME_UNSET: u8 = 0xFF;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PoolStatus { Open, Live, Ended, Settled, RolledOver, Voided } // 1 byte

#[account]
#[derive(InitSpace)]
pub struct LivePool {
    pub pool_id: u64,            // 8  — deterministic; == fixture_id (one pool per match)
    pub fixture_id: i64,         // 8  — single match (NOT the [i64;6] leg array)
    pub settle_authority: Pubkey,// 32 — keeper (opens/resolves calls, ends, settles)
    pub fee_recipient: Pubkey,   // 32 — rake destination
    pub entry_price: u64,        // 8  — lamports/seat (0.035 SOL)
    pub lock_ts: i64,            // 8  — joins close (kickoff)
    pub settle_after_ts: i64,    // 8  — earliest settle (FT + buffer)
    pub fee_bps: u16,            // 2  — rake bps (<= MAX_FEE_BPS)
    pub status: PoolStatus,      // 1
    pub player_count: u64,       // 8  — # seats (drives rake + void refund)
    pub num_calls: u32,          // 4  — # Call PDAs pre-created at pool creation (== created cursor bound)
    pub winning_score: u64,      // 8  — set at settle: recomputed max(total) ON-CHAIN
    pub winner_count: u64,       // 8  — recomputed |{total == winning_score}| ON-CHAIN
    pub scored_seat_count: u64,  // 8  — # seats verified during settle (must == player_count)
    pub distributable: u64,      // 8  — winners' total (== winner_count * share)
    pub claimed_count: u64,      // 8  — caps at winner_count
    pub claimed_total: u64,      // 8  — caps at distributable
    pub settled_ts: i64,         // 8
    pub bump: u8,                // 1
}
```

**Byte size:** 8 disc + 8+8+32+32+8+8+8+2+1+8+4+8+8+8+8+8+8+8+1 = 8 + 174 = **182 bytes**. Distinct from Contest (217) and v1 (207) — clean size-filtered discovery. **Do not hardcode 182** anywhere (resolves L1): the keeper/engine read `program.account.livePool.size` at runtime exactly as `settle-contest.ts:342` already does. `182` is hereby **reserved** in the size-as-discriminator contract; `LiveCursor`, `Call`, and `LiveEntry` sizes below are likewise reserved.

**Seeds:** `[b"livepool", pool_id.to_le_bytes()]` — distinct from `b"contest"` so PDAs never alias.

**Escrow:** the `LivePool` PDA holds pot = `lamports - live_pool_rent_floor()` (exact clone of `contest_rent_floor()`, `contest_state.rs:69–71`).

**What extends vs. Contest:** drops `fixtures[6]`/`market_ids[6]`/`num_legs`/`winning_buckets[6]` (single-match, no legs). Replaces `perfect_count` (a keeper-supplied divisor for a *self-provable* binary predicate) with **program-recomputed** `winning_score` + `winner_count` + `scored_seat_count` (argmax has no self-provable predicate — §C1-resolved). Adds `num_calls` (delegation/settlement bound). Cursor fields (`call_seq`/`open_call_seq`) live on `LiveCursor`, not here.

#### `LiveCursor` — the delegated live cursor (resolves M4)

```rust
#[account]
#[derive(InitSpace)]
pub struct LiveCursor {
    pub pool: Pubkey,        // 32
    pub call_seq: u32,       // 4  — next call index; monotonic
    pub open_call_seq: u32,  // 4  — call currently open for taps (u32::MAX = none)
    pub bump: u8,            // 1
}
```

**Byte size:** 8 + 32+4+4+1 = **49 bytes**. **Seeds:** `[b"livecursor", pool_key]`. Delegated with the entries; `open_call`/`resolve_call` advance it on the ER without touching custody.

#### `Call` — one call window + resolved outcome (created base-layer, then delegated)

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CallKind { NextGoal, GoalRush, CornerSoon, CardSoon } // 1 byte

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CallState { Empty, Open, Resolving, Resolved, Voided } // 1 byte; Empty = pre-created, not yet opened

#[account]
#[derive(InitSpace)]
pub struct Call {
    pub pool: Pubkey,        // 32
    pub seq: u32,            // 4  — call index within the pool
    pub kind: CallKind,      // 1
    pub state: CallState,    // 1
    pub opened_ts: i64,      // 8  — set by open_call; answer-window anchor
    pub answer_secs: u16,    // 2  — tap window (mirror ANSWER_MS=9s; see §L2)
    pub num_options: u8,     // 1  — 2 or 3 (mirrors opts.length)
    pub base_points: [u8; 3],// 3  — per-option base (e.g. [4,1,4] / [2,1,0])
    pub outcome: u8,         // 1  — winning option index; OUTCOME_UNSET/VOID_OUTCOME sentinels
    pub bump: u8,            // 1
}
```

**Byte size:** 8 + 32+4+1+1+8+2+1+3+1+1 = 8 + 54 = **62 bytes**. **Seeds:** `[b"call", pool_key, seq.to_le_bytes()]` — deterministic, so ER, keeper, and clients derive the same PDA for `(pool, seq)`.

**Lifecycle (resolves M2):** all `num_calls` `Call` PDAs are **allocated and initialized on base layer at pool creation** in `CallState::Empty` (or lazily but always base-layer), then **delegated in the same batch as the cursor + entries**. On the ER, `open_call` mutates `Empty → Open` (sets `kind`/`base_points`/`opened_ts`/…), and `resolve_call` mutates `Open → Resolved/Voided`. **No account is ever created inside the ER** — every `Call` exists on base layer first and commits its final `outcome`/`state` back. `num_calls` is a keeper-chosen upper bound at creation (≤ `MAX_CALLS`); real matches use ~20–40. If the keeper needs more mid-match than pre-created, the match is capped at `num_calls` (documented product limit), never an ER-side allocation.

`base_points` carries the rarity table **on-chain per call**: NextGoal `[4,1,4]` (H/N/A), CornerSoon `[2,1,0]`, CardSoon `[3,1,0]`, GoalRush `[3,1,0]` — the on-chain image of `liveGame.ts` `weight`.

#### `LiveEntry` — a seat + running score (the ER-mutated account)

```rust
#[account]
#[derive(InitSpace)]
pub struct LiveEntry {
    pub player: Pubkey,       // 32 — set at join (init, never default-sentinel — one seat per pool)
    pub pool: Pubkey,         // 32
    pub amount: u64,          // 8  — lamports paid (== entry_price)
    // running score (mirrors liveGame Player): total = base_pts + bonus_pts
    pub base_pts: u32,        // 4
    pub bonus_pts: u32,       // 4
    pub streak: u16,          // 2  — current run of hits
    pub last_scored_seq: u32, // 4  — highest call seq folded in (idempotent-scoring guard)
    // the pick LOCKED for the currently-open call (the tap target):
    pub pending_call_seq: u32,// 4  — u32::MAX = no pending pick
    pub pending_pick: u8,     // 1  — option index locked on the ER
    pub bump: u8,             // 1
}
```

**Byte size:** 8 + 32+32+8+4+4+2+4+4+1+1 = 8 + 92 = **100 bytes**. **Seeds:** `[b"liveentry", pool_key, player_key]`. **One seat per (pool, player)** — uses `init` (not `init_if_needed`), so a second join by the same wallet fails at account-already-exists (resolves M3). `total = base_pts + bonus_pts`, both `u32`; `winning_score`/`winner_count` are `u64` (no overflow at settle).

**What extends vs. Entry:** drops `nonce`/`picks[6]`; adds the running-score fold (`base_pts`, `bonus_pts`, `streak`, `last_scored_seq`) and the pending-tap fields. **Uses `init`, not the draft's `init_if_needed` clone of `enter.rs:21`** — this is deliberate: there is no edit/multi-ticket path, so the invariant `pot == player_count * entry_price` holds exactly, which the void-refund solvency check (`claim_contest.rs:123–126` analogue) depends on (resolves M3).

---

### 1.2 Instructions (new)

New submodule `programs/proofbet/src/instructions/live/` (mirror the `instructions/mod.rs` glob-reexport pattern). Each notes **where it runs** (Base = L1 Solana, ER = ephemeral rollup) and **what existing handler it clones**.

| # | Instruction | Runs on | Clones / extends | Purpose |
|---|---|---|---|---|
| 1 | `initialize_jackpot()` | Base | reuse as-is | (optional) shared rolling pot, unchanged |
| 2 | `create_live_pool(pool_id, fixture_id, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps, num_calls)` | Base | `create_contest` | Init `LivePool` (Open) + `LiveCursor` + `num_calls` `Call` PDAs (Empty); keeper pays rent |
| 3 | `join_live_pool()` | Base | `enter` (`enter.rs:56–68`), **`init` not `init_if_needed`** | System-transfer `entry_price` into pool PDA; `init` `LiveEntry`; `player_count++`. Requires Open + `now < lock_ts` |
| 4 | `delegate_live(...)` | Base | MagicBlock `#[delegate]` | Delegate `LiveCursor` + each `LiveEntry` + each `Call` to the ER (**LivePool is NOT delegated** — §H2-resolved). Requires `player_count >= 2` (§H1-resolved) |
| 5 | `open_call(seq, kind, num_options, base_points, answer_secs)` | ER | NEW | Keeper opens call `seq`: `Call` Empty→Open, set fields; set `cursor.open_call_seq = seq`. `has_one`-style keeper check |
| 6 | `lock_pick(seq, option)` | **ER** | NEW — the tap | Player locks `option` on call `seq`: requires `Call.state == Open` + within `answer_secs`; writes `LiveEntry.pending_*`. **10–50 ms** |
| 7 | `resolve_call(seq, outcome)` | ER | NEW — keeper posts result | Keeper writes `Call.outcome` (or `VOID_OUTCOME`), `Open→Resolved`/`Voided`; **no further `lock_pick` accepted**. Emits so clients score instantly |
| 8 | `score_entry(seq)` | ER | NEW — the fold | For one `LiveEntry`: apply §1.0 rules; Voided call = no-op; **idempotent** (guarded by `last_scored_seq`). Batchable via `remaining_accounts` |
| 9 | `commit_live()` | ER | MagicBlock `#[commit]` | Checkpoint cursor+entries+calls to L1 mid-match (§1.3 cadence) |
| 10 | `end_and_undelegate()` | ER | MagicBlock `commit_and_undelegate` | Final commit + return ownership of cursor/entries/calls to program; (base) `pool.status → Ended` |
| 11 | `settle_live_pool()` | Base | **NEW — argmax recompute (NOT a `settle_contest` clone)** | Recompute `max`/`count` over **all** committed `LiveEntry` in one tx; then rake/jackpot/split math ported from `settle_contest.rs:99–214` |
| 12 | `claim_live_pool()` | Base | `claim_contest` | Winner self-proves `entry.total == pool.winning_score`; pays `share`; `close = player` |
| 13 | `void_live_pool()` | Base | `void_contest` | Keeper anytime while not settled; ANYONE after `settle_after_ts + VOID_GRACE_SECS`. Refund path. **Reachable because LivePool is never delegated** (§H1-resolved) |

**Scoring — the pure on-chain fold** (`score_entry`, ER-side) reads immutable inputs and applies §1.0/§1.0.1 exactly:

```rust
// score_entry(seq): mirrors the on-chain scoring spec (§1.0), incl. global void (§1.0.1)
require!(entry.last_scored_seq < seq, AlreadyScored);          // idempotent
let call = /* Call PDA for (pool, seq); seeds+owner verified; must be Resolved or Voided */;
require!(matches!(call.state, CallState::Resolved | CallState::Voided), CallNotResolved);

if call.state == CallState::Voided {
    entry.last_scored_seq = seq;                              // global void: no-op, no penalty
    return Ok(());
}
let picked = entry.pending_call_seq == seq;
if picked && entry.pending_pick == call.outcome {
    let base = call.base_points[call.outcome as usize] as u32; // rarity base
    entry.base_pts += base;
    entry.streak += 1;
    if entry.streak >= 3 { entry.bonus_pts += (entry.streak - 2) as u32; } // escalator
} else {
    // wrong pick OR no accepted pick (timeout) => miss: keep base, wipe streak+bonus
    entry.streak = 0;
    entry.bonus_pts = 0;
}
entry.last_scored_seq = seq;
```

Because this runs on the ER against delegated accounts it's ~free and fast, and because it's a deterministic fold over immutable inputs, **the base-layer copy after commit/undelegate is provably the same number.** The keeper writes only per-call outcomes (single scalars, oracle-anchored). This is the anti-cheat spine for *scoring* — and the **argmax step below** is what closes the remaining hole.

**Argmax at settle — recomputed on-chain (resolves C1).** `settle_live_pool` takes **no `winning_score`/`winner_count` arguments.** It receives **all** `LiveEntry` accounts as `remaining_accounts` and, for each, **verifies it is the true PDA** (`seeds = [b"liveentry", pool_key, entry.player]` re-derived and `require_keys_eq!`) and **program-owned** (`require_keys_eq!(*acc.owner, crate::ID)`) — the draft omitted this owner+PDA binding, which was itself exploitable (a keeper could pass fake accounts). It then:

```rust
// settle_live_pool: recompute the max on-chain; the keeper supplies NO score.
let mut seen = 0u64;
let mut top = 0u64;
let mut count = 0u64;
for acc in ctx.remaining_accounts {
    // 1) bind: acc must be the real LiveEntry PDA for its stored player, owned by this program
    let entry = LiveEntry::try_deserialize(&mut &acc.try_borrow_data()?[..])?;
    let (expected, _) = Pubkey::find_program_address(
        &[b"liveentry", pool_key.as_ref(), entry.player.as_ref()], &crate::ID);
    require_keys_eq!(acc.key(), expected, ScoreMismatch);
    require_keys_eq!(*acc.owner, crate::ID, ScoreMismatch);
    require_keys_eq!(entry.pool, pool_key, ScoreMismatch);
    let total = (entry.base_pts as u64) + (entry.bonus_pts as u64);
    if total > top { top = total; count = 1; }
    else if total == top { count += 1; }
    seen += 1;
}
// 2) coverage: EVERY seat must be present, or the max is unproven.
require!(seen == pool.player_count, ScoreMismatch);
pool.scored_seat_count = seen;
pool.winning_score = top;      // program-declared max, not keeper-declared
pool.winner_count = count;
```

**Why coverage (`seen == player_count`) is load-bearing:** without it, the keeper could omit the real top scorer, making its own seat the apparent max. Requiring every seat and re-deriving each PDA makes `winning_score` provably the true maximum and `winning_score ∈ {observed totals}` **by construction** (resolves M1 — the pot can never be bricked by an unclaimable score, because the max is a real seat's total). Because `total` is `u32+u32` and `winning_score` is `u64`, equality at claim is exact and always satisfiable.

**Payout math** is then ported **verbatim from `settle_contest.rs:157–214`** with `N = winner_count`: `raw = pot_net + jpool`; `share = raw / N`; `payable = share * N`; `dust → jackpot`; the two solvency `require!`s (`:204–212`) and the jackpot-in/out signed-delta logic (`:187–199`) port directly. **Winner requires `top > 0`** (from `endMatch:310`): if `winning_score == 0` (nobody scored), `winner_count` is meaningless → take the **rollover branch** (`settle_contest.rs:142–156`): `status = RolledOver`, `pot_net → jackpot`, `distributable = 0`. This also handles the degenerate 1-seat-scores-0 case (§H1-resolved). The `perfect_count <= entry_count` guard has no analogue (no keeper count to bound); its spiritual replacement is the coverage check above.

**Scale note (all seats in one tx):** at `FIELD = 24` seats × 100 bytes, plus `num_calls` unaffected (calls aren't iterated at settle), the single-tx recompute is well within limits — 24 `remaining_accounts` reads + a `find_program_address` each is far under the CU ceiling. If a future pool exceeds a safe per-tx account count, settlement becomes a two-phase accumulate (running `top`/`count`/`seen` persisted on `LivePool` across N txs, finalized when `seen == player_count`); the invariant is identical. `FIELD = 24` needs only the single-tx path.

---

### 1.3 MagicBlock ER delegation flow

Pinned to the **canonical `magicblock-engine-examples/anchor-counter` pattern** (SDK `ephemeral-rollups-sdk`). **This entire layer is unvalidated in-repo (resolves C3): SLICE 2 opens with a throwaway spike before any of it is depended on** (§3, and §D2). Versions and the Anchor-migration risk are budgeted there, not assumed.

**What is delegated, and what is NOT:**

- **Delegated set = `{LiveCursor, all LiveEntry, all Call}`.** These carry score/liveness only.
- **NEVER delegated = `LivePool`** (the pot). Custody stays program-owned on base layer the entire match (resolves H2). `open_call`/`resolve_call` only need to *read* `LivePool` (status/authority) and *write* `LiveCursor` — reads don't require delegation.

**Timeline:**

1. **Pre-kickoff (Base):** pool + cursor + all `Call` PDAs created; players `join_live_pool` (real SOL escrowed in `LivePool`). At `lock_ts` the keeper calls `delegate_live(...)` — **only if `player_count >= 2`** (resolves H1's 1-seat confiscation) — delegating cursor + entries + calls to the Delegation Program (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`). `LivePool` ownership is untouched.
   - `commit_frequency_ms` in `DelegateConfig` set to a real value (e.g. `5000`) — **never left at the `u32::MAX` default** (verified gotcha: default = no time-based commit).
   - Pin a validator (devnet `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`) via `DelegateConfig.validator`.
2. **During the match (ER, 10–50 ms/tx):** `open_call` (Empty→Open, cursor advanced) → `lock_pick` taps (session-key-signed, §1.5) → `resolve_call` (outcome or `VOID_OUTCOME`) → `score_entry` batch. **Void-on-goal** (§1.0.1): a goal on the feed while a non-goal call is Open → `resolve_call(seq, VOID_OUTCOME)` → global void, no penalty.
3. **Full-time (ER → Base):** `end_and_undelegate()` = `commit_and_undelegate(&[cursor + all entries + all calls])`. Final state commits to L1; ownership returns to the program (async two-phase — **confirm via `GetCommitmentSignature`, never assume synchronous return**). Then (base) `pool.status = Ended`.
4. **Settle (Base):** `settle_live_pool` (on-chain argmax over committed entries) + `claim_live_pool`. **All real-SOL custody/payout happen on base layer against `LivePool`, which never left it.**

**Commit cadence:** time-based `commit_frequency_ms ≈ 5s` **plus** explicit `commit_live()` after each `resolve_call` (a crashed ER loses at most one call window, itself re-derivable from the on-chain `Call.outcome`). Final `commit_and_undelegate` at FT is authoritative.

**Permissionless recovery if the keeper dies mid-match (resolves H1's deadlock):** because `LivePool` is never delegated, `void_live_pool` on the base layer can always mutate it. After `settle_after_ts + VOID_GRACE_SECS`, **anyone** voids the pool and every seat refunds `entry.amount` from `LivePool` — regardless of whether cursor/entries are still delegated (they carry no lamports; their delegated state is irrelevant to the refund, which reads only `player_count` and per-seat `amount`). This is the exact window the backstop exists for, and it is now reachable. *If* MagicBlock later offers forced/permissionless undelegation, it's a nice-to-have for reclaiming cursor/call rent, not a safety dependency. **SLICE 2 test:** `test('keeper delegates then vanishes → anyone voids LivePool after grace → every seat refunds in full')`.

**Blockhash routing:** ER txs use an ER blockhash — Magic Router (`https://devnet-router.magicblock.app`, `ConnectionMagicRouter.getBlockhashForAccounts`), OR the two-provider pattern (base `api.devnet.solana.com`, ER `https://devnet-as.magicblock.app`). Router recommended (single endpoint, auto-forwards by writable-account owner).

---

### 1.4 Jackpot reuse

**Keep the `Jackpot` singleton, make it optional per pool.** A pool that ends with `winner_count == 0` **or `winning_score == 0`** (nobody scored > 0) takes the rollover branch — `pot_net → jackpot`, exactly `settle_contest.rs:142–156`. Winner-settles add the jackpot pool to `raw` and leave dust behind (`:157–213`). Near-verbatim reuse; cross-pool prize continuity for free. Pass a null jackpot for fully self-contained pools and the branch degrades to pot-only — same code path, so it's kept. **Note:** the confiscation-of-a-lone-player concern (§H1) is handled *before* this branch, by the `player_count >= 2` delegation gate: a pool that never reaches 2 seats is voided-and-refunded on base layer before kickoff, never settled into a rollover.

---

### 1.5 Session keys / gasless

Taps must not pop a wallet. Use MagicBlock **session keys**: ER instructions (`lock_pick`) gate on a session token (`#[session_auth_or(entry.player == session.authority, …)]`, `session-keys` crate); the client mints an ephemeral session keypair once at join (`SessionTokenManager`, `@magicblock-labs/gum-sdk`) authorized to sign `lock_pick` for the match. One signature at join → every tap is popup-free and (on the ER) effectively gasless. **The base-layer money instructions (`join`, `settle`, `claim`, `void`) always require the real wallet — session keys never touch custody.** This is SLICE 6, gated behind the SLICE-2 spike confirming session keys work with this program's Anchor version (§C3).

---

### 1.6 Feed / oracle model

**Who posts calls + outcomes:** the keeper. Calls are keeper-authored (`open_call`) on a pacing loop; outcomes (`resolve_call`) are keeper-posted from TxLINE.

**Trust/proof:** existing settlement uses TxLINE's Merkle-attested `Txoracle.validateStat` (`.view()`, ~1.4M CU — `settle.ts:89–180`, `spike/src/validate.js`), not a raw trusted write. For a live call ("corner in next 3 min"), the keeper resolves the cumulative stat via the **same `validateStat` proof path** and posts the delta, so `resolve_call` inherits the same trust anchor as `settle` today — the outcome is provable against a TxODDS-published root, not the keeper's word. (For the fastest calls this proof lags the live event by the root-publish cadence — the crux latency issue, below and §H3-resolved.)

**Latency + see-then-lock — stated plainly and *not* oversold (resolves H3):**

- **Devnet reality:** TxLINE devnet is **Level-1, 60s delayed** (`config.ts:47–48`); engine polls every **8s** (`live.ts:184`). A 60s window where a courtsider knows a goal and the chain doesn't is **catastrophic for real money.** On devnet, in-play calls are **demo-only**; real-money in-play requires mainnet.
- **Mainnet fix for the 60s hole (only):** TxLINE **Level-12 = real-time, World Cup + friendlies, FREE** — same vendor, same `validateStat` plumbing, zero incremental cost. Replace the 8s poll with the SSE stream (`/api/scores/stream`). **This fixes the 60-second data-staleness hole. It does NOT make in-play "fair."**
- **The residual courtsiding edge is structural and unclosable by any data feed.** A person watching the in-stadium feed observes an imminent goal/corner/card **1–5 seconds before any data feed** (Level-12 included) publishes it. "Void-on-event" fires only *after your feed sees the event* — i.e., *after* the courtsider already locked the correct pick on a not-yet-voided call. So void-on-event closes the "outcome already public in the data" case but **not** the "stadium truth leads the feed" case. This is the known, unsolved problem of live betting. **The design does not claim to solve it.**
- **Real mitigations (reduce, never eliminate):**
  1. **Bet-acceptance / lock-delay:** accept the tap but timestamp it and **reject it if a qualifying event is observed within N ms after** (commit-reveal on the tap helps here). Tunable per call kind.
  2. **Tight suspension windows + coarser calls:** prefer "goal in next N min" / end-of-period over instantaneous next-event; larger resolution horizon shrinks the feed-lag edge.
  3. **Per-call exposure caps** so a single courtsided call can't drain a pool.
  4. **Void-on-event** (§1.0.1) as one layer — it handles the already-public case, not the stadium-lead case.
- **Honest table row:** "Fair real-money in-play" is marked **"structurally mitigated, never fully fair"** — *not* ✅ — even on mainnet Level-12 (§2 table).

---

## 2) HARD DEPENDENCIES & RISKS (decisions, not hand-waving)

**D1 — Real-time feed. DECISION: TxLINE, upgrade devnet Level-1 → mainnet Level-12.**
Source: TxLINE (TxODDS). Devnet = Level-1, **60s delayed**, WC-only, free. Mainnet = Level-12, **real-time**, WC + friendlies, **free**. Cost: **$0** for the World Cup on either tier; post-WC real-time all-leagues is $5k–$25k/mo (Levels 7–11), out of scope now. Do **not** switch vendors — `Txoracle.validateStat` Merkle proof is already integrated and confirmed on devnet (per MEMORY); alternatives (Sportradar/Genius $10k+/mo + license gates; API-Football ~15s polling) are worse on every axis.
**Risk:** real-money in-play on devnet's 60s feed is exploitable → **blocks real-money in-play until mainnet.** Even on mainnet Level-12, the residual stadium-lead courtsiding edge persists and is only mitigated (§H3-resolved). Slices 1–3 (join/score/settle mechanics) are safe on devnet; the live tap loop is demo-only on devnet, real-money only on mainnet + lock-delay + caps.

**D2 — MagicBlock ER. DECISION: Magic Router (`https://devnet-router.magicblock.app`), fall back to two-provider (`api.devnet.solana.com` + `devnet-as.magicblock.app`).**
**This layer has ZERO in-repo footprint today** — a grep for `ephemeral`/`magicblock`/`delegate`/`MagicIntent`/`session`/`gum` across `Cargo.toml`, `package.json`, `web/package.json`, and all `.rs`/`.ts` sources returns **nothing**, and `magicblock-engine-examples/` is not vendored. SLICE 2 therefore **begins with a throwaway spike** (like the existing `spike/`) that: delegates one dummy PDA, does one ER write, commits, and undelegates on devnet — **measuring** (a) the exact ER compute-unit ceiling, (b) whether "gasless" is unconditional, (c) whether in-ER lamport moves are permitted (**assume NOT; the design never moves lamports in the ER**), and critically (d) **whether the ER example's required `anchor-lang`/SDK versions can coexist with this program.** The current program uses **classic Anchor** (`#[account]`/`InitSpace`, append-only-enum IDL discipline — `errors.rs:51–66`); a jump to `anchor-lang 1.0.2` is a **major migration of the whole program** that risks all 24 existing passing tests and the deployed IDL's byte-stability. The spike pins the *older* canonical example versions first to get a green build, confirms the base program still builds/deploys **under the `#[ephemeral]` program-global macro** (verify existing base instructions unaffected), and only then bumps toward newer SDK. **No `live_state.rs` ER dependency is designed on top of unproven assumptions — the spike comes first (resolves C3).**

**D3 — Legal. STATED PLAINLY.** Real-money wagering on live sporting events. Per the standing real-money-only directive this is built as a real product — which means real regulatory exposure (unlicensed sports betting/gambling in most jurisdictions). Devnet SOL has no monetary value, so devnet demos are not gambling; **mainnet launch with real SOL is a licensed-activity decision (geofencing, KYC, jurisdiction) that must be made explicitly before any mainnet deploy.** Architecture supports it (per-pool, keeper-gated, auditable, on-chain-verifiable settlement); the go/no-go is a legal decision, not an engineering one. Flagging, not deciding.

**Demoable on devnet NOW vs. needs mainnet/paid:**

| Capability | Devnet NOW | Needs |
|---|---|---|
| Per-match SOL pot: join, escrow, **on-chain argmax settle**, split, claim, void | ✅ real devnet SOL | — |
| On-chain scoring fold (rarity + streak, global void) mirroring **this doc's spec** | ✅ | — |
| `player_count >= 2` gate + permissionless void-refund of under-filled/abandoned pools | ✅ | — |
| ER per-tap lock (10–50 ms) + session-key gasless taps | ⚠️ *pending SLICE-2 spike* | MagicBlock devnet ER (free) + spike validation |
| Keeper feed→call outcomes via `validateStat` | ✅ on **60s-delayed** data | — |
| **Fair real-money in-play** (lock before outcome observable) | ❌ 60s window exploitable | mainnet Level-12 **+ lock-delay + caps** — and even then **structurally mitigated, never fully fair** |
| Real-time SSE ingestion (replace 8s poll) | ⚠️ Level-1 only | mainnet Level-12 |

---

## 3) PHASED TDD PLAN

Each slice ships tested, working software. **SLICE 1 has NO ER dependency** — it is the base-layer money program, buildable immediately with the existing Anchor/TS harness, and it is the strongest, most-reusable part. **SLICE 2 begins with an ER spike** before any ER design is depended on.

### SLICE 1 — Base-layer `LivePool` program (NO ER). The foundation.

Everything except the live tap *latency*: create → join → (open/lock/resolve/score run **on base layer here**) → **on-chain argmax settle** → claim/split → void. Pure clone-and-adapt of the Contest instructions for the money path, **plus genuinely-new argmax-recompute settlement** (not a `settle_contest` clone — budgeted as new code with new tests). The ER (SLICE 2) later only *relocates where* `lock_pick`/`resolve_call`/`score_entry` execute; their logic is identical and tested here.

**Two review findings that live inside SLICE 1 and are resolved here, not deferred:**
- **C1 (settlement security):** `settle_live_pool` takes **no keeper score** — it recomputes `max`/`count` over all seats on-chain with PDA+owner+coverage binding (§1.2). The insecure `settle_live_pool(winning_score, winner_count)` signature from the draft is **removed**.
- **C2 (sim fidelity):** the scoring oracle is the **rewritten** TS `liveGame` port implementing global void + state-gated picks (§1.0.1); the fidelity test asserts against *that*, not the un-modified UI sim.

**Files to create:**
- `programs/proofbet/src/live_state.rs` — `LivePool`, `LiveCursor`, `Call`, `LiveEntry`, enums, `live_pool_rent_floor()`, `MAX_CALLS`, `VOID_OUTCOME`, `OUTCOME_UNSET`.
- `programs/proofbet/src/instructions/live/mod.rs` + `create_live_pool.rs`, `join_live_pool.rs`, `open_call.rs`, `resolve_call.rs`, `lock_pick.rs`, `score_entry.rs`, `settle_live_pool.rs`, `claim_live_pool.rs`, `void_live_pool.rs`.
- `programs/proofbet/src/events.rs` — append `LivePoolCreated`, `JoinedLivePool`, `CallOpened`, `CallResolved`, `EntryScored`, `LivePoolSettled`, `LivePoolRolledOver`, `LivePoolVoided` (**append-only, never mid-enum** — byte-stability rule).
- `programs/proofbet/src/errors.rs` — append `PoolNotOpen`, `PoolNotLive`, `PoolNotEnded`, `JoinClosed`, `CallNotOpen`, `CallNotResolved`, `AnswerWindowClosed`, `AlreadyScored`, `ScoreMismatch`, `InvalidOption`, `NotEnoughPlayers` (**append-only**). (`WinnerCountExceedsSeats` from the draft is dropped — no keeper count to bound; `ScoreMismatch` covers coverage/PDA/owner failures.)
- `programs/proofbet/src/lib.rs` — wire the new entrypoints; add `pub mod live_state;`.
- Tests: `tests/live_pool_create.ts`, `tests/live_pool_join.ts`, `tests/live_pool_score.ts`, `tests/live_pool_settle.ts`, `tests/live_pool_safety.ts`, `tests/live_helpers.ts` (PDA derivations + `driveMatch(picks, outcomes)` that opens/resolves/scores a synthetic match on base layer, plus a **rewritten** TS `liveGame` `grade` port — global void, state-gated picks — used as the assertion oracle).

**Instruction signatures (SLICE 1):**
```
create_live_pool(pool_id: u64, fixture_id: i64, entry_price: u64, lock_ts: i64,
                 settle_after_ts: i64, fee_recipient: Pubkey, fee_bps: u16, num_calls: u32)
join_live_pool()                                   // init LiveEntry (NOT init_if_needed)
open_call(seq: u32, kind: CallKind, num_options: u8, base_points: [u8;3], answer_secs: u16)
lock_pick(seq: u32, option: u8)                    // requires Call.state==Open + in window
resolve_call(seq: u32, outcome: u8)                // outcome or VOID_OUTCOME; has_one keeper
score_entry(seq: u32)                              // folds one LiveEntry per §1.2
settle_live_pool()                                 // NO score args; remaining_accounts = ALL seats
claim_live_pool()                                  // self-proves total == winning_score; close=player
void_live_pool()
```

**TDD task order (write test first, watch it fail, implement, watch it pass — per the TDD skill):**

1. **`live_pool_create.ts`**
   - `test('inits LivePool (Open) + LiveCursor + num_calls Empty Call PDAs; correct escrow floor; keeper as settle_authority')`
   - `test('rejects pool_id == 0 / entry_price == 0 / fee_bps > MAX_FEE_BPS / num_calls > MAX_CALLS')`
   - `test('rejects lock_ts >= settle_after_ts and now >= lock_ts')`
   - `test('idempotent: second create for same pool_id fails (account exists)')`
2. **`live_pool_join.ts`**
   - `test('join transfers entry_price into LivePool PDA, inits LiveEntry, increments player_count')` (assert pool lamports == floor + n*price, `enter.rs:56–68` pattern)
   - `test('rejects join after lock_ts (JoinClosed)')`
   - `test('rejects second join by same wallet — init, not init_if_needed (account exists)')` ← resolves M3
   - `test('rejects join when pool not Open')`
3. **`live_pool_score.ts`** — scoring fidelity vs. the **rewritten** oracle (resolves C2).
   - `test('correct pick banks base_points[outcome]; streak increments')`
   - `test('3rd consecutive hit +1 bonus; 4th +2; 5th +3 (escalator == streak-2)')`
   - `test('wrong pick keeps base, wipes streak and bonus (miss)')`
   - `test('no accepted pick scores as miss: streak+bonus wiped, no base')`
   - `test('globally-voided call: score_entry is a no-op for every seat, no penalty')` ← §1.0.1
   - `test('lock_pick after resolve_call is rejected (Call.state != Open) — no timeout race')` ← §1.0.1
   - `test('score_entry idempotent — replaying seq does not double-count (AlreadyScored)')`
   - `test('rejects score_entry on unresolved call (CallNotResolved)')`
   - `test('driveMatch total matches the on-chain scoring spec (rewritten liveGame port) exactly')`
4. **`live_pool_settle.ts`** — **on-chain argmax** + split + rake + jackpot (resolves C1/M1).
   - `test('settle recomputes winning_score = max(total) over all seats — keeper passes NO score')`
   - `test('single top scorer takes pot_net; distributable == pot_net (+jpool)')`
   - `test('N-way tie at max splits evenly; dust stays in jackpot')`
   - `test('rake == player_count*entry_price*fee_bps/10000, capped at pot, sent to fee_recipient')`
   - `test('winning_score == 0 (nobody scored) → RolledOver, pot_net into jackpot')`
   - `test('SECURITY: settle rejects if not all seats passed (seen != player_count → ScoreMismatch)')` ← the coverage guard
   - `test('SECURITY: settle rejects a fake/foreign LiveEntry account (PDA/owner mismatch → ScoreMismatch)')`
   - `test('SECURITY: keeper cannot make its own seat win by omitting the true top scorer')`
   - `test('rejects settle before settle_after_ts (SettleTooEarly)')`
   - `test('rejects settle when pool not Ended')`
   - `test('cannot settle twice (status guard)')`
5. **`live_pool_settle.ts` (claim block)**
   - `test('winner (entry.total == winning_score) claims share; claimed_count/total advance; entry closed to player')`
   - `test('winning_score is always some real seat total → a winner can always claim (no brick)')` ← resolves M1
   - `test('non-winner claim pays 0 and closes')`
   - `test('double-claim impossible (entry closed)')`
   - `test('claim caps: claimed_count < winner_count and claimed_total + share <= distributable')`
6. **`live_pool_safety.ts`**
   - `test('keeper void refunds entry.amount per seat; no rake on void; pot == player_count*entry_price holds exactly')` ← resolves M3 invariant
   - `test('permissionless void after settle_after_ts + VOID_GRACE_SECS')`
   - `test('under-filled pool (player_count < 2) can be voided-and-refunded before kickoff')` ← resolves H1 (1-seat case)
   - `test('resolve_call/open_call reject non-keeper (Unauthorized)')`
   - `test('lock_pick rejects after answer window (AnswerWindowClosed) and unknown option (InvalidOption)')`
   - `test('solvency: settle/claim math never lets LivePool hold < floor + outstanding (VaultInsolvent)')`

**Exit criterion for SLICE 1:** `anchor test` green (including all 24 pre-existing tests still passing); IDL regenerated with byte-stable pre-existing ordinals; the whole real-SOL money path works end-to-end on devnet with the keeper driving synthetic calls on base layer. **This alone is a demoable real-money game** (keeper-paced, no ER latency benefit yet) with **provably-honest settlement**.

---

### SLICE 2 — ER spike, then delegation + per-tap lock

**Starts with the throwaway spike (resolves C3 — do this before designing on the ER):**
- `spike/live-er/` — delegate one dummy PDA, one ER write, `commit`, `undelegate`; **measure** ER CU ceiling, confirm gasless behavior, **confirm no lamports move in-ER**, and **confirm the ER SDK's Anchor version coexists with this program** (base program still builds/deploys under `#[ephemeral]`, all 24 tests still green). Pin canonical example versions first.

Then relocate `lock_pick`/`resolve_call`/`score_entry` onto the ER; add delegate/commit/undelegate for **cursor + entries + calls only (LivePool stays base-layer)**:
- `#[ephemeral]` on the program mod; `#[delegate]` for `LiveCursor`/`LiveEntry`/`Call`; `delegate_live` (gated on `player_count >= 2`); `commit_live`; `end_and_undelegate` via `MagicIntentBundleBuilder`.
- Pin SDK + Anchor per the spike's finding; validator `MAS1Dt9…`; `commit_frequency_ms = 5000`.
- Tests: `tests/live_er.ts` — two-provider (base + `devnet-as`), `delegate_live`, `lock_pick` on ER (assert ~sub-second), `resolve_call`+`score_entry` on ER, `commit`, `GetCommitmentSignature` confirms L1; `end_and_undelegate` → L1 ownership restored → `settle_live_pool` on base succeeds against committed scores; **`test('keeper delegates then vanishes → anyone voids LivePool after grace → every seat refunds')`** (resolves H1 deadlock).

**Exit:** taps land in 10–50 ms on the ER; final committed L1 scores settle correctly via on-chain argmax; the "cheap+fast lock" promise is real; the keeper-death recovery path is proven.

---

### SLICE 3 — Keeper: feed → call outcomes
- `keeper/create-match-pool.ts` (clone `create-parlay.ts`, `pool_id == fixture_id`, pass `num_calls`).
- `keeper/live-runner.ts`: per open pool — (a) pace `open_call` (mirror `spawnCall` pacing/kinds), (b) read `getScoreHistory` + `validateStat` (reuse `settle.ts:89–180` proof core) to `resolve_call`, (c) **void-on-goal** (§1.0.1) posts `VOID_OUTCOME` on open non-matching calls, (d) `score_entry` batch, (e) `commit_live`, (f) `end_and_undelegate` + `settle_live_pool` at FT (passing all seats as `remaining_accounts`), (g) **lock-delay + per-call caps** enforcement (§H3-resolved).
- Fast job in `keeper/cron.ts` (tight interval, overlap-guarded like the existing `settling` flag).
- Tests: `keeper/test/live-runner.test.ts` — pacing + outcome-mapping against a replay of `spike/src/discover.ts` events; assert void-on-goal fires; assert `resolve_call` outcome == `validateStat` result; assert settle passes **all** seats.
- **Honest gate:** on devnet this runs on 60s-delayed data (demo). Real-money requires mainnet Level-12 + SSE + lock-delay + caps — and even then in-play is *mitigated, not fair* (§H3-resolved).

### SLICE 4 — Engine read routes
- `engine/src/chain.ts`: `readLivePools()` (size-filtered `getProgramAccounts` **at the runtime-read `livePool.size`, not a hardcoded 182** — resolves L1), `readLiveEntry(pool, wallet)`, `readCall(pool, seq)`, `readLiveCursor(pool)`.
- `engine/src/routes.ts`: `GET /api/live/pool?fixtureId=` (pool + open call + standings), `GET /api/live/pool/:id/standings`, `GET /api/live/entry?wallet=&poolId=`. Follow `/api/card` + `/api/contest/live` shapes and LiveStore fixture-name-join conventions.
- Tests: `engine/test/live-routes.test.ts` (pure decoders + route shapes, mirror `routes.test.ts`).

### SLICE 5 — Web wiring
- Point `web/src/lib/liveGame.ts`'s `lock()` seam at the real ER `lock_pick` (the class was written as "the seam a real TxLINE feed replaces later"). Add `web/src/lib/livePoolClient.ts` (delegate-aware tx builders, `ConnectionMagicRouter`). Wire join (base), taps (ER), standings/score (engine poll or ER read), settle/claim (base) into `SweepstakeView`/live UI. **The UI animation may keep per-player void cosmetically, but the authoritative score is the on-chain global-void fold** — the UI reconciles to the on-chain standings on each poll.
- Tests: `web/test/livePool.test.ts` (client tx-builder shapes + score-fold parity with the **rewritten** on-chain-spec port).

### SLICE 6 — Session keys / gasless
- Program: `#[session_auth_or(...)]` on `lock_pick`. Client: mint ephemeral session keypair at join via `SessionTokenManager` (`@magicblock-labs/gum-sdk`); taps signed by the session key, popup-free. **Gated behind the SLICE-2 spike confirming session-keys work with this program's Anchor version.**
- Tests: session-authorized `lock_pick` succeeds without the main wallet; expired/foreign session rejected.

---

## Key file references (for the implementer)

- **Clone targets (money path):** escrow-deposit `enter.rs:56–68` (**but `init`, not `init_if_needed` at `:21` — §M3**); rake/jackpot/split/dust/solvency `settle_contest.rs:99–214`; solvency guards `settle_contest.rs:204–212`; claim caps + `close = bettor` `claim_contest.rs:52–140`; void + grace `void_contest.rs:28–55` + `VOID_GRACE_SECS`/`contest_rent_floor` `contest_state.rs:13,69–71`.
- **NEW code (not a clone):** on-chain argmax recompute in `settle_live_pool` — PDA re-derivation + `owner == crate::ID` + `seen == player_count` coverage over all `LiveEntry` (§1.2). Contrast `settle_contest.rs:56–97`, which iterates *leg markets*, not entries, and defers the winner predicate to self-prove at `claim_contest.rs:52–58` — a model argmax cannot use.
- **Scoring spec (rewritten as the on-chain oracle):** `web/src/lib/liveGame.ts` — base points `:210–242`, streak escalator + miss `:264–282`, per-player void `:190–193`/`:283–288` (**replaced on-chain by global keeper-driven void, §1.0.1**), settlement/split `:301–326`.
- **Feed/proof reuse:** `keeper/settle.ts:89–180` (`validateStat` core), `spike/src/discover.ts:90–114`, latency `spike/src/config.ts:47–48` + `engine/src/live.ts:184`.
- **Discovery precedent (size filter, read at runtime):** `keeper/settle-contest.ts:334–357` (esp. `.size` at `:342`), `engine/src/chain.ts:323–365`.
- **ER pattern (UNVALIDATED — spike first, §C3/§D2):** `magicblock-engine-examples/anchor-counter` (`MagicIntentBundleBuilder`), router `https://devnet-router.magicblock.app`, delegation program `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, validator `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`.

**New files introduced:** `programs/proofbet/src/live_state.rs`; `programs/proofbet/src/instructions/live/*.rs`; `spike/live-er/*`; `keeper/create-match-pool.ts`, `keeper/live-runner.ts`; `engine/src/chain.ts` + `routes.ts` additions; `web/src/lib/livePoolClient.ts`; tests `tests/live_*.ts`, `tests/live_er.ts`, `keeper/test/live-runner.test.ts`, `engine/test/live-routes.test.ts`, `web/test/livePool.test.ts`.

---

## Appendix — Review findings disposition (traceability)

| # | Finding | Disposition |
|---|---|---|
| **C1** | Argmax "verified on-chain" was false; keeper-declared `winning_score` = prize-theft / brick | **FIXED.** `settle_live_pool` takes no score; recomputes `max`/`count` over **all** seats with PDA+owner+coverage binding (§1.2). Insecure signature removed. New code + `SECURITY:` tests in SLICE 1. |
| **C2** | Sim's per-player void/timeout can't be mirrored by a shared `Call`; "exact parity" unachievable | **FIXED.** On-chain rules are the spec of record: **global keeper-driven void** + **state-gated picks** (§1.0.1). TS oracle rewritten to match; fidelity test asserts against it. |
| **C3** | Entire ER layer unvalidated; no SDK in repo; Anchor major-version migration risk | **ACKNOWLEDGED + SEQUENCED.** SLICE 2 opens with a throwaway spike measuring CU/gasless/no-in-ER-lamports **and Anchor coexistence** before any ER design is depended on (§D2). |
| **H1** | Under-filled pool confiscation + keeper-death deadlock (void can't touch delegated PDA) | **FIXED.** `player_count >= 2` gate before delegation; under-filled pools voided-and-refunded on base layer. `LivePool` never delegated → `void_live_pool` always reachable (§1.3). Tests in SLICE 1 + SLICE 2. |
| **H2** | Delegating the escrow account is unnecessary and dangerous | **FIXED.** Only `LiveCursor` + `LiveEntry` + `Call` are delegated; `LivePool` (custody) stays base-layer, non-delegated (§1.1/§1.3). |
| **H3** | Void-on-event doesn't close see-then-lock; "Level-12 = fair" oversold | **ACKNOWLEDGED honestly.** In-play reframed around lock-delay + suspension + caps; residual stadium-lead courtsiding stated as structural/unclosable; table row = "structurally mitigated, never fully fair" (§1.6/§2). |
| **M1** | `winning_score` could be unclaimable (brick) | **FIXED by C1.** `winning_score = max(real seat total)` by construction → equality always satisfiable. |
| **M2** | ER-side `Call` creation unproven | **FIXED.** All `Call` PDAs created on **base layer** at pool creation (Empty), then delegated; ER only mutates state (§1.1). |
| **M3** | rake/void invariant + `init` vs `init_if_needed` | **FIXED.** `LiveEntry` uses `init`; one-seat-per-pool; `pot == player_count * entry_price` holds exactly (§1.1). Tested. |
| **M4** | Live cursor vs. custody fighting over one account | **FIXED.** Split into base-layer `LivePool` (money) + delegated `LiveCursor` (liveness) (§1.1). |
| **L1** | Don't hardcode byte sizes | **FIXED.** All sizes read at runtime via `.size`; 182/100/62/49 reserved in the size-discriminator contract (§1.1/§4-slice). |
| **L2** | 9s answer window vs. proof cadence | **ACKNOWLEDGED.** `answer_secs` tunable per call; interacts with lock-delay (§1.6/§H3). |

---

Final complete design doc is above. It is self-contained and buildable: **SLICE 1 (base-layer `LivePool` program) is fully specified with zero ER or feed dependency** — create/join/open/lock/resolve/score/settle/claim/void all run on base layer with the existing `anchor test` harness, and the two review criticals that live *inside* SLICE 1 (C1 on-chain argmax recompute; C2 rewritten scoring oracle) are resolved in the signatures and tests rather than deferred. All ten other findings are either fixed in the design or explicitly acknowledged with a concrete sequencing decision (C3/H3), traced in the appendix.

Key structural changes from the draft, verified against the actual code: settlement no longer takes keeper-supplied scores (`settle_contest.rs:56–97` reads oracle markets and self-proves at claim — argmax cannot, so the program now recomputes `max` over all seats with PDA/owner/coverage binding); custody (`LivePool`) is never delegated so `void_contest`-style permissionless refund (`void_contest.rs:28–55`) stays reachable if the keeper dies; `LiveEntry` uses `init` not `enter.rs:21`'s `init_if_needed`; and the ER layer (absent from the repo entirely) is gated behind a mandatory SLICE-2 spike.
---

## Spike log — SLICE 2 kickoff (2026-07-01)

**Status: SLICE 1 committed (`56242e9`, 34/34 tests). ER compatibility spike opened.**

### Finding 1 (the make-or-break): NO Anchor 1.0 migration required.
`ephemeral-rollups-sdk` latest is **0.15.5** (Jun 2026). Its feature flags include
**`anchor-compat`** (→ `anchor-lang >=0.28,<1.0` + `backward-compat`) alongside the
default `anchor` = `anchor-modern` (→ `anchor-lang ^1.0`). The docs' quickstart now
recommends Anchor 1.0.2 / Solana 3.1.9, but `anchor-compat` targets exactly our
0.28–0.31 range. The throwaway crate `spike/live-er/` (`ephemeral-rollups-sdk 0.15.5`,
`features=["anchor-compat"]`, `anchor-lang 0.31.1`, `#[ephemeral]` program) **builds
clean under our Anchor 0.31 + Agave SBF toolchain** (`cargo build-sbf` → 196 KB .so,
warnings only). So the whole ER layer does NOT force the feared program rewrite.

### Finding 2 (the next thing to resolve): transitive version split.
`cargo tree` on the spike shows `anchor-compat` pulled **`anchor-lang 0.32.1`** (highest
matching `<1.0`) for the SDK's own glue, and **two `solana-program` versions coexist
(2.3.0 via our anchor-0.31 + 3.0.0 via the SDK's modern sub-crates)**. `#[ephemeral]`
(a program-level proc-macro) is fine across that, but `delegate`/`commit_accounts`/
`commit_and_undelegate_accounts` cross the SDK↔program boundary via `AccountInfo`, whose
type differs between solana-program 2.3 and 3.0. So the real risk moved from "Anchor
major migration" (ruled out) to "pin the SDK/anchor/solana trio so the delegate/commit
boundary types are single-version."

### Next spike steps (before touching `live_state.rs`):
1. Extend `spike/live-er/` with a real `Counter` + `delegate` + `increment` (ER) +
   `commit_and_undelegate` flow; `cargo build-sbf` until the `AccountInfo` boundary
   resolves single-version. Options if it doesn't: (a) pin an **older** SDK line that
   targets anchor 0.30/0.31 + solana ~1.18/2.x cleanly (the "canonical example"
   approach), or (b) a **minor** program bump 0.31.1 → 0.32.1 (NOT 1.0) to align with
   the SDK's compat anchor — re-run all 24 + 34 tests under it.
2. On green build: deploy to **devnet**, delegate one PDA to the delegation program
   (`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, validator
   `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`), one ER write via the router
   (`https://devnet-router.magicblock.app`), `commit_and_undelegate`, confirm via
   `GetCommitmentSignature`. Measure: ER CU ceiling, gasless behavior, and confirm
   **no lamports move in-ER** (the design keeps custody on base layer).
3. Only then wire `delegate_live` / `commit_live` / `end_and_undelegate` into the real
   program (cursor + entries + calls delegated; `LivePool` never delegated).

### Finding 3 (RESOLVED): the exact ER integration pin — a MINOR anchor bump, no 1.0.
Extended `spike/live-er/` to the full delegate → (ER) increment → `commit_and_undelegate`
flow (mirrors magicblock's canonical `00-LEGACY_EXAMPLES/anchor-counter/public-counter`).
Results:
- **anchor-lang 0.31.1 + sdk 0.14.4 → FAILS** with `MagicProgram: anchor_lang::Id is not
  satisfied`. The `#[commit]` macro injects `Program<'info, MagicProgram>`, and the SDK
  implements `Id` for `MagicProgram` against ITS anchor (0.32.1); our 0.31.1 `Id` is a
  different trait. So delegate/commit needs our program on the SDK's compat anchor.
- **anchor-lang 0.32.1 + sdk 0.14.4 (`anchor-compat`) → BUILDS CLEAN** (343 KB .so).
  `cargo tree`: single `anchor-lang v0.32.1` + `ephemeral-rollups-sdk v0.14.4` — the
  dual-version split from Finding 2 is gone. This is exactly the canonical example's pin.

**DECISION — the ER integration path (no Anchor 1.0 migration):**
1. Bump `programs/proofbet` **anchor-lang 0.31.1 → 0.32.1** (minor) + `Anchor.toml`
   `anchor_version = "0.32.1"` (avm already has it). Rebuild; re-run ALL 24 existing +
   34 live tests under 0.32 — this bump is the prerequisite and the main local risk.
2. Add `ephemeral-rollups-sdk = { version = "0.14.4", features = ["anchor-compat"] }`.
3. Working API surface (verified in the spike):
   - `use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};`
   - `use ephemeral_rollups_sdk::cpi::DelegateConfig;`
   - `use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;`
   - `#[ephemeral]` on the program mod; `#[delegate]` + `#[account(mut, del)] pda: AccountInfo`
     on the delegate ctx → generates `ctx.accounts.delegate_<field>(&payer, &[seeds], DelegateConfig{ validator, ..})`.
   - `#[commit]` on the commit ctx injects `magic_context` + `magic_program`;
     `MagicIntentBundleBuilder::new(payer, magic_context, magic_program).commit(&[..]).build_and_invoke()`
     and `.commit_and_undelegate(&[..])`. Call `acct.exit(&crate::ID)?` before committing a mutated Anchor account.
4. THEN the devnet runtime proof (delegate a PDA → ER write → undelegate) — needs a funded
   devnet keypair; pause for the go-ahead before spending.

---

## SLICE 2a — local ER layer built + adversarially reviewed (2026-07-01)

**Landed locally (no devnet spend):**
- anchor-lang **0.31.1 → 0.32.1** bump; full suite **98/98 green** under 0.32 (commit `55965f8`).
- `#[ephemeral]` on the program mod + `ephemeral-rollups-sdk 0.14.4` dep — proven NOT to disturb the money layer (isolated 98/98 run).
- **Call lifecycle reconciled for the ER:** new `prealloc_call` (base-layer, creates `CallState::Empty`) + `open_call` reworked from `init` → mutate `Empty → Open`. No account is ever created inside the ER.
- **Delegation instructions** (compile-verified vs the 0.14.4 SDK; runtime-proven in 2b): `delegate_cursor` / `delegate_entry` / `delegate_call` (gated `player_count >= 2`; `LivePool` never delegated) + `commit_live` + `end_and_undelegate` (`MagicIntentBundleBuilder`). GOTCHA: the commit handlers need an explicit `<'info>` binding — `Context<'_, '_, '_, 'info, CommitLive<'info>>` — or `remaining_accounts`'s `'info` and the accounts struct's `'info` are independent elided lifetimes and `MagicIntentBundleBuilder<'info>` (invariant) won't unify them. Also: `build_and_invoke` is a `FoldableIntentBuilder` trait method → must import the trait.

**Adversarial review (5-lens workflow, each finding refute-or-confirm): 4 CONFIRMED, 0 false positives.**
- **[FIXED]** `open_call` wrote `pool.status = Live` to the never-delegated `LivePool` — illegal on the ER (only delegated accounts are writable), so the first ER `open_call` would be rejected and the in-play loop would be dead on-chain. Now `pool` is read-only in `open_call`. (Base-layer tests never assert "live", so this was invisible to the passing suite — caught only by the ER-semantics lens.)
- **[FIXED]** test harness: `createPool`'s sequential prealloc loop burned the join window → `JoinClosed` (5 real test failures). Now preallocs fire concurrently (`Promise.all`).
- **[DEFERRED to 2b — TOP ITEM] keeper-death refund freezes when entries are delegated.** `claim_live_pool`'s Voided branch reads `entry.amount` via an owner-checked `Account<LiveEntry>` + `close = player`; a delegated entry (owner = Delegation Program) makes the refund revert, and there is no permissionless undelegate → the pot is frozen. This breaks §1.3's promised keeper-death recovery ("every seat refunds regardless of whether entries are still delegated"). **The fix is 2b-gated because it depends on an unproven ER runtime fact: is a delegated account's data readable on the base layer?**
  - If YES → permissionless atomic all-seats `refund_voided`: read each entry as `UncheckedAccount` for the player pubkey + PDA-bind, pay `entry_price` from the non-delegated `LivePool`, coverage `seen == player_count`, status-guarded against re-run — works regardless of entry ownership.
  - If NO → require a permissionless force-undelegate path (if MagicBlock exposes one) before refund.
  - DECIDE after the 2b spike observes a real delegated account on the base layer. Add the SLICE-2 test: *keeper delegates then vanishes → anyone voids after grace → every seat refunds in full*, against genuinely-delegated entries.
