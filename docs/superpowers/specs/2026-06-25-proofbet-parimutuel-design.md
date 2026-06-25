# ProofBet Parimutuel Core — Design Spec

**Date:** 2026-06-25
**Status:** Approved (design); pending spec review → implementation plan
**Depends on:** the settlement spike (`spike/`, `docs/spike-runbook.md`) — `Txoracle.validateStat` is proven to settle granular WC soccer props on devnet.

## 1. Overview

An Anchor program on Solana that runs **parimutuel** betting pools for World Cup soccer props and settles them from TxLINE's on-chain Merkle proofs. Bettors stake native SOL into one of two outcome buckets (Over / Under). After the match, an off-chain **keeper** resolves the outcome with `validateStat.view()` and calls `settle`, recording the exact proof inputs on-chain so anyone can independently verify the result. Winners claim a pro-rata share of the pool.

### Goals
- Working end-to-end devnet demo: create → bet → (entry closes) → settle → claim/refund.
- Settlement that is **publicly verifiable**, not "trust me" — the on-chain record lets anyone re-run the proof.
- Liquidity by construction (parimutuel: the pool *is* the liquidity; no counterparty, no market maker).
- Two markets: **Total Goals O/U** and **Total Corners O/U**.

### Non-goals (this iteration)
- Web UI, live-odds display, shareable receipt rendering (next iteration).
- On-chain CPI settlement (Path B), NegRisk-style multi-market grouping, challenge windows — all roadmap.
- SPL/USDC collateral (native SOL only for now).

## 2. Key decisions (approved)

| Decision | Choice | Rationale |
|---|---|---|
| Settlement | **Path A: keeper `.view()` + signed `settle`** | Proven by the spike; fastest; program stays decoupled from Txoracle (fully testable on localnet). |
| Trust hardening | **On-chain proof-binding + immutable predicate** | `settle` records the exact `validateStat` inputs used; anyone re-runs them to catch a dishonest keeper. Predicate is fixed at creation, so the keeper supplies only the boolean, never the question. |
| Collateral | **Native SOL** | Zero token setup; trivial devnet funding; least code. |
| Buckets | **Binary (Over=0 / Under=1)** | The natural primitive for a boolean `validateStat` predicate; matches Polymarket (every market is binary; multi-outcome = bundled binary markets). Richer markets later = more binary markets per fixture, not N-ary buckets. |
| Fee | **Losing-pool-only**, `fee_bps` (default 0) | Winners never lose principal; clean conservation invariant. |
| Scope | **Program + keeper** | End-to-end settleable demo; no UI yet. |

## 3. Trust model

The program never calls Txoracle. The `settle_authority` (keeper key, set at creation) submits the winning bucket. Hardening that makes this **verifiable rather than trusted**:

1. **Immutable predicate** — `stat_key`, `stat_key2`, `op`, `comparison`, `threshold`, `entry_close_ts`, `fee_bps`, `settle_authority` are set at `initialize_market` and never mutated. The keeper cannot change the question, only answer it.
2. **Proof-binding** — `settle` stores `settled_seq` and `settled_ts` on the market and emits a `MarketSettled` event with the full predicate, the resolved value, and the derived `daily_scores_roots` PDA. Any observer reconstructs the exact `validateStat` call and confirms the keeper settled honestly.
3. **Liveness** — a dishonest keeper is *detectable* (above) but could still stall. Acceptable for the demo; production posture is a Squads multisig as `settle_authority`. Full trustlessness is Path B (CPI), kept as roadmap.

Honest framing (consistent with the spike): "verifiable, single-source, no separate oracle, no dispute window" — **never "trustless."**

## 4. Accounts (PDAs)

```rust
#[account]
pub struct Market {
    pub creator: Pubkey,
    pub settle_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,            // distinguishes markets on the same fixture (0=goals, 1=corners)
    // ── immutable predicate ──
    pub stat_key: u32,
    pub stat_key2: Option<u32>,   // Some => two-stat predicate
    pub op: Option<BinaryOp>,     // required iff stat_key2.is_some()
    pub comparison: Comparison,   // GreaterThan for O/U
    pub threshold: i32,
    // ── lifecycle / economics ──
    pub entry_close_ts: i64,      // unix seconds; bets rejected at/after this
    pub fee_bps: u16,             // <= MAX_FEE_BPS (1000 = 10%)
    pub status: MarketStatus,     // Open | Settled | Voided
    pub winning_bucket: Option<u8>,
    pub bucket_totals: [u64; 2],
    pub total_pool: u64,
    pub fee_collected: u64,
    // ── proof-binding (set at settle) ──
    pub settled_seq: u32,
    pub settled_ts: i64,
    pub settled_value: i32,       // resolved lhs (val_a [op val_b])
    pub bump: u8,
    pub vault_bump: u8,
}
```
Seeds: `["market", fixture_id.to_le_bytes(), market_id]`.

```rust
#[account]
pub struct Vault { pub bump: u8 }   // program-owned PDA; escrows pooled lamports
```
Seeds: `["vault", market.key()]`. Funded to rent-exemption at creation. Deposits via `system::transfer` (CPI, user signs); payouts via direct lamport debit (program owns it).

```rust
#[account]
pub struct Position {
    pub bettor: Pubkey,
    pub amounts: [u64; 2],
    pub bump: u8,
}
```
Seeds: `["position", market.key(), bettor]`. Closed on `claim` (rent returned to bettor → no double-claim possible).

Enums: `MarketStatus { Open, Settled, Voided }`, `BinaryOp { Add, Subtract }`, `Comparison { GreaterThan, LessThan, EqualTo }`. Bucket consts: `OVER = 0`, `UNDER = 1`.

## 5. Instructions

1. **`initialize_market(args)`** — creator pays rent for `Market` + `Vault`. Validates: `entry_close_ts` in the future; `fee_bps <= MAX_FEE_BPS`; `stat_key2.is_some() == op.is_some()`. Sets `status = Open`, totals 0, `fee_recipient = args.fee_recipient.unwrap_or(creator)`. Emits `MarketCreated`.
2. **`place_bet(bucket, amount)`** — requires `status == Open`, `now < entry_close_ts`, `bucket ∈ {0,1}`, `amount > 0`. `Position` via `init_if_needed` (verify/seed `bettor`). CPI `system::transfer` bettor→vault. Increments `position.amounts[bucket]`, `bucket_totals[bucket]`, `total_pool`. Emits `BetPlaced`.
3. **`settle(winning_bucket, settled_seq, settled_ts, settled_value)`** — signer must be `settle_authority`; requires `status == Open` and `now >= entry_close_ts`; `bucket ∈ {0,1}`. Records proof-binding fields. If `bucket_totals[winning_bucket] == 0` → `status = Voided` (no winners; full refunds, no fee). Else `status = Settled`, `winning_bucket = Some`, skim `fee = bucket_totals[loser] * fee_bps / 10000` from vault → `fee_recipient`, store `fee_collected`. Emits `MarketSettled { fixture_id, market_id, winning_bucket, stat_key, stat_key2, op, comparison, threshold, settled_seq, settled_ts, settled_value, daily_scores_pda }`.
4. **`void_market(settled_seq, settled_ts)`** — `settle_authority` only; `status == Open`; sets `status = Voided`. For phases 14–19 (Interrupted/Abandoned/Cancelled/TXCC/TXCS/Postponed). Emits `MarketVoided`.
5. **`claim()`** — bettor (signer); requires `status ∈ {Settled, Voided}`.
   - **Settled:** `stake = amounts[winning_bucket]`; `payout = stake > 0 ? floor(stake * (total_pool - fee_collected) / winner_total) : 0`. Losers claim 0 but still close their `Position` to reclaim rent (no error path, no stranded rent).
   - **Voided:** `payout = amounts[0] + amounts[1]` (refund principal).
   - Transfer `payout` vault→bettor (direct lamport debit); close `Position` (rent → bettor). Emits `Claimed`.

## 6. Parimutuel math & invariants

For a settled market: `winner_total = bucket_totals[winning_bucket]`, `loser_total = total_pool - winner_total`, `fee = floor(loser_total * fee_bps / 10000)`, `distributable = total_pool - fee`.

- **Per-winner:** `payout_i = floor(stake_i * distributable / winner_total)`.
- **Principal-safe:** since `distributable ≥ winner_total`, `payout_i ≥ stake_i` always — winners never lose principal.
- **Conservation:** `Σ payout_i ≤ distributable`; the remainder (**dust**, < winner_count lamports) stays in the vault. Tested invariant: `vault_lamports == rent_floor + total_pool − total_paid_out` at every step.
- **No push:** integer stats + integer `threshold` + strict `GreaterThan` ("O/U 9.5 corners" → `sum > 9`) → every settlement is decisive.
- All arithmetic uses checked ops; `u128` intermediates for the `stake * distributable` product to avoid overflow.

## 7. Keeper (`keeper/`)

A TS script reusing the spike's `validate.ts` / `config.ts` / `util.ts`:
1. Load the `Market`, read its immutable predicate.
2. From the scores feed, find the fixture's final event (phase ∈ {F, FET, FPE}); take its `Seq` and the batch `minTimestamp` (`settled_ts`).
3. Fetch the three-stage proof (`/api/scores/stat-validation`) for `(fixture_id, seq, stat_key[, stat_key2])`; run `validateStat.view()` → boolean; compute `settled_value`.
4. `winning_bucket = boolean ? OVER : UNDER`; call `settle(...)`.
5. If the fixture phase ∈ {14–19} → call `void_market` instead.

## 8. Testing

Anchor TS tests on **localnet** (no Txoracle dependency, because `settle` takes the bucket directly):
- Happy path: init → bets on both buckets (multiple bettors) → settle(OVER) → each winner claims; assert payouts are principal-safe and `Σpayout + fee + dust == total_pool`.
- Zero-winner: all stake on the losing side → `settle` voids → everyone refunds.
- `void_market` → everyone refunds.
- Fee: `fee_bps > 0` → `fee_recipient` receives `floor(loser_total * bps / 10000)`; winners still ≥ principal.
- Rejections: bet at/after `entry_close_ts`; claim before settle; double claim; settle by non-authority; invalid bucket; `amount == 0`.

## 9. Repo layout

Anchor workspace at repo root (the spike stays untouched):
```
Anchor.toml
Cargo.toml                      # workspace
programs/proofbet/
  Cargo.toml
  src/{lib.rs, state.rs, errors.rs, events.rs, instructions/*.rs}
tests/proofbet.ts               # localnet lifecycle + math tests
keeper/settle.ts                # reuses ../spike/src validate logic
package.json                    # anchor test / keeper deps
spike/                          # unchanged
```

## 10. Markets shipped

Both as binary Over/Under, both two-stat `Add` (the spike-proven path):
- **Total Goals O/U** — `stat_key=1` (P1 goals) + `stat_key2=2` (P2 goals), `op=Add`, `comparison=GreaterThan`, `threshold=N`.
- **Total Corners O/U** — `stat_key=7` (P1 corners) + `stat_key2=8` (P2 corners), `op=Add`, `comparison=GreaterThan`, `threshold=N`.

(Single-stat markets, e.g. "P1 goals O/U" via `stat_key=1`, are supported by the same code with `stat_key2=None, op=None`.)

## 11. Security & correctness checklist

- Conservation invariant tested; pooled lamports tracked separately from the vault's rent floor (payouts never touch rent-exemption).
- Zero-winner and void → full refunds; no stuck funds.
- Immutable economic terms; `settle`/`void` gated to `settle_authority`; entry close enforced via `Clock::unix_timestamp` (validator-clock drift acceptable for entry close).
- `claimed` enforced by closing the `Position` account.
- No oracle dependency in-program → cannot be rugged by bad data; the only trusted action (bucket pick) is publicly checkable via proof-binding.
- `init_if_needed` on `Position` guarded by `bettor` check (reinit-safe).
- Events on every state transition for indexers and the future receipt UI.

## 12. Roadmap (out of scope now)

On-chain CPI settlement (Path B) · NegRisk-style grouping of binary markets into events · challenge/timelock before claims · SPL/USDC collateral · web UI with live pool-implied odds and shareable provably-fair receipt · Squads multisig `settle_authority`.
