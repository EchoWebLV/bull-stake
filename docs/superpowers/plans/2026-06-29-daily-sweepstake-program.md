# Daily Sweepstake — On-Chain Contest Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the on-chain daily perfect-parlay sweepstake to `programs/proofbet`: a persistent jackpot vault, per-contest records, per-ticket entries, and the create/enter/settle/claim/void lifecycle — with the spec's six safety must-fixes **and the v3 audit fixes** built in: a cross-contest `reserved` liability fence on the vault (so a prior contest's unclaimed winnings/refunds can never be rolled or double-counted into a later contest), acceptance of a zero-stake `Voided`-with-bucket result leg at settle, and a permissionless `void_contest` backstop after a grace period.

**Architecture:** A new `contest_state` module (`JackpotVault` singleton + `Contest` + `Entry`) and six new instructions alongside the existing parimutuel `Market` program. Rollover = the vault's lamports persist across contests. Settlement reads winning buckets from the card's already-settled per-match result markets (`market_id = 12`, 3-bucket), passed as `remaining_accounts` and bound by re-derived PDA. `perfect_count` is keeper-supplied but blast-radius-capped per contest. Mirrors the existing `Market`/`Vault`/`Position` patterns verbatim (lamport math via `sub_lamports`/`add_lamports`, `close = bettor`, `has_one`, `InitSpace`, checked arithmetic).

**Tech Stack:** Rust + Anchor 0.31.1, native SOL lamports, TypeScript integration tests via `ts-mocha` (`anchor test`).

**Spec:** [docs/superpowers/specs/2026-06-29-daily-sweepstake-design.md](../specs/2026-06-29-daily-sweepstake-design.md) — this plan implements §5 (Accounts), §6 (Instructions), §8 (Economics), §9 (Settlement trust), §15 (Testing, program portion). Engine/keeper and web are separate plans.

**Scope of this plan:** the program only — `programs/proofbet/src/**` and `tests/**`. Out of scope (follow-on plans): engine `/api/contest` routes, keeper card-build/settle calls, web `SweepstakeView`.

**Conventions to follow (read these existing files first):**
- `programs/proofbet/src/instructions/place_bet.rs` — escrow via `system_program::transfer` (bettor → program-owned vault), `init_if_needed` position, checked math.
- `programs/proofbet/src/instructions/settle.rs` — program-owned-vault payout via `sub_lamports`/`add_lamports`, `fee_recipient` pinned via `#[account(mut, address = …)]` on `UncheckedAccount`.
- `programs/proofbet/src/instructions/claim.rs` — `has_one = bettor` + `close = bettor` (rent back + double-claim prevention), u128 intermediate payout math, rent-floor solvency reasoning.
- `tests/helpers.ts` + `tests/three_way.ts` — provider/program setup, `freshFunded`, `marketPda`, `expectError`, the entry-window `sleep` pattern.

**Testing notes:**
- `anchor test` (root) builds the program, boots a local validator, deploys, and runs all `tests/**/*.ts`. Each "run the test" step runs the whole suite; the new test should be the one that flips fail→pass.
- Entry/settle windows use real wall-clock (`Clock::unix_timestamp`). Tests use short windows (`lock_ts = nowSec()+5`, then `sleep(6000)`), exactly like `tests/three_way.ts`.
- `freshFunded()` funds keypairs from the provider wallet (the validator faucet is unreliable on this CLI).

---

## Task 1: Contest state, constants, errors, events

**Files:**
- Create: `programs/proofbet/src/contest_state.rs`
- Modify: `programs/proofbet/src/lib.rs` (add `pub mod contest_state;`)
- Modify: `programs/proofbet/src/errors.rs` (add contest error variants)
- Modify: `programs/proofbet/src/events.rs` (add contest events)

- [ ] **Step 1: Create the contest state module**

Create `programs/proofbet/src/contest_state.rs`:

```rust
use anchor_lang::prelude::*;

/// Maximum matches on a sweepstake card (3..=5 used; tail stays zero).
pub const MAX_MATCHES: usize = 5;
/// market_id of the per-fixture 1X2 "Match Result" market (engine MARKET_TEMPLATE).
/// settle_contest reads each card match's winning bucket from this 3-bucket market.
pub const RESULT_MARKET_ID: u8 = 12;
/// Grace period after `settle_after_ts` past which ANYONE may `void_contest`
/// (permissionless liveness backstop for a lost/absent keeper). Generous enough
/// to never race a live keeper, which settles within minutes of `settle_after_ts`.
pub const VOID_GRACE_SECS: i64 = 3 * 24 * 60 * 60; // 3 days

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ContestStatus {
    Open,
    Settled,
    RolledOver,
    Voided,
}

/// Singleton escrow whose lamport balance (above its own rent floor) IS the
/// rolling jackpot. Persists across every contest — that persistence is the rollover.
#[account]
#[derive(InitSpace)]
pub struct JackpotVault {
    /// contest_id of the live contest, or 0 when none is live (one-at-a-time guard).
    pub active_contest_id: u64,
    /// Lamports owed to ALREADY-TERMINAL contests' unclaimed tickets (winner shares
    /// + void refunds not yet claimed). Every pot read nets this out:
    /// free pot = lamports − rent_floor − reserved. Fences a prior contest's money
    /// so the next contest can never roll (and over-promise) lamports still owed.
    /// += at settle/void by what will be paid; −= on each claim/refund.
    pub reserved: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Contest {
    pub contest_id: u64,          // epoch day at open; unique deterministic id
    pub settle_authority: Pubkey, // keeper
    pub fee_recipient: Pubkey,    // rake destination
    pub fixtures: [i64; MAX_MATCHES],
    pub num_matches: u8,          // 3..=5
    pub entry_price: u64,         // lamports per ticket
    pub lock_ts: i64,             // entries close (first kickoff)
    pub settle_after_ts: i64,     // earliest settle (latest kickoff + buffer)
    pub fee_bps: u16,             // 500 = 5%
    pub status: ContestStatus,
    pub winning_buckets: [u8; MAX_MATCHES],
    pub entry_count: u64,         // # tickets (drives new-entry rake + void refund)
    pub perfect_count: u64,       // keeper-supplied split divisor (capped at claim)
    pub pot_snapshot: u64,        // net pot (vault.lamports - rent_floor) at settle
    pub distributable: u64,       // pot_snapshot - rake, stored so every claim reads one value
    pub claimed_count: u64,       // # winning claims paid (caps at perfect_count)
    pub claimed_total: u64,       // lamports paid out (caps at distributable)
    pub settled_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub bettor: Pubkey,   // Pubkey::default() until first written → new-ticket sentinel
    pub contest: Pubkey,
    pub nonce: u64,       // ticket index for this wallet in this contest
    pub picks: [u8; MAX_MATCHES],
    pub amount: u64,      // lamports paid (= contest.entry_price)
    pub bump: u8,
}
```

- [ ] **Step 2: Wire the module into lib.rs**

In `programs/proofbet/src/lib.rs`, add `contest_state` to the module list (keep the list alphabetical — `contest_state` sorts first):

```rust
pub mod contest_state;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
```

- [ ] **Step 3: Add contest error variants**

In `programs/proofbet/src/errors.rs`, add these variants inside `ProofBetError` (before the closing `}`):

```rust
    #[msg("contest is not open")]
    ContestNotOpen,
    #[msg("contest is not in a terminal (claimable) state")]
    ContestNotTerminal,
    #[msg("a contest is already live; settle or void it first")]
    ContestStillLive,
    #[msg("contest_id must be non-zero")]
    InvalidContestId,
    #[msg("too early to settle this contest")]
    SettleTooEarly,
    #[msg("num_matches must be between 3 and 5")]
    InvalidMatchCount,
    #[msg("pick must be 0/1/2 within num_matches and 0 beyond it")]
    InvalidPick,
    #[msg("result market account does not match the card fixture")]
    ResultMarketMismatch,
    #[msg("result market is not settled")]
    ResultMarketNotSettled,
    #[msg("perfect_count must be greater than zero to pay a winner")]
    PerfectCountZero,
    #[msg("vault would drop below its rent floor or exceed distributable")]
    VaultInsolvent,
    #[msg("fixture_id must be non-zero for each carded match")]
    InvalidFixtureId,
```

- [ ] **Step 4: Add contest events**

In `programs/proofbet/src/events.rs`, append (after the existing `Claimed` event):

```rust
#[event]
pub struct ContestCreated {
    pub contest: Pubkey,
    pub contest_id: u64,
    pub num_matches: u8,
    pub entry_price: u64,
    pub lock_ts: i64,
    pub settle_after_ts: i64,
    pub settle_authority: Pubkey,
}

#[event]
pub struct EnteredContest {
    pub contest: Pubkey,
    pub bettor: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub entry_count: u64,
    pub edited: bool,
}

#[event]
pub struct ContestSettled {
    pub contest: Pubkey,
    pub contest_id: u64,
    pub winning_buckets: [u8; crate::contest_state::MAX_MATCHES],
    pub perfect_count: u64,
    pub pot_snapshot: u64,
    pub distributable: u64,
    pub rake: u64,
    pub rolled_over: bool,
}

#[event]
pub struct ContestVoided {
    pub contest: Pubkey,
    pub contest_id: u64,
}

#[event]
pub struct ContestClaimed {
    pub contest: Pubkey,
    pub bettor: Pubkey,
    pub nonce: u64,
    pub payout: u64,
    /// 0 = no payout (loser/rolled), 1 = win share, 2 = void refund.
    pub kind: u8,
}
```

- [ ] **Step 5: Verify it builds**

Run: `anchor build`
Expected: compiles with no errors (the `InitSpace` derive sizes the new accounts; no instruction references them yet).

- [ ] **Step 6: Commit**

```bash
git add programs/proofbet/src/contest_state.rs programs/proofbet/src/lib.rs programs/proofbet/src/errors.rs programs/proofbet/src/events.rs
git commit -m "feat(program): contest state, errors, events scaffolding"
```

---

## Task 2: `initialize_vault` instruction

**Files:**
- Create: `programs/proofbet/src/instructions/initialize_vault.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/contest_helpers.ts`
- Create: `tests/contest_lifecycle.ts`

- [ ] **Step 1: Add shared test helpers**

Create `tests/contest_helpers.ts`:

```ts
import {
  program, marketPda, vaultPda, positionPda, freshFunded, resultArgs, nowSec, sleep,
  BN, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
} from "./helpers";
import type { Keypair } from "@solana/web3.js";

export const RESULT_MARKET_ID = 12;

export function jackpotVaultPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], program.programId)[0];
}

export function contestPda(contestId: number | BN): PublicKey {
  const id = new BN(contestId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("contest"), id.toArrayLike(Buffer, "le", 8)],
    program.programId,
  )[0];
}

export function entryPda(contest: PublicKey, bettor: PublicKey, nonce: number | BN): PublicKey {
  const n = new BN(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), contest.toBuffer(), bettor.toBuffer(), n.toArrayLike(Buffer, "le", 8)],
    program.programId,
  )[0];
}

/** Pad a fixture list to the fixed [i64; 5] the program expects. */
export function fixtureArray(ids: number[]): BN[] {
  const out = ids.map((x) => new BN(x));
  while (out.length < 5) out.push(new BN(0));
  return out;
}

/** Pad a pick list to the fixed [u8; 5] (tail zeros). */
export function pickArray(picks: number[]): number[] {
  const out = [...picks];
  while (out.length < 5) out.push(0);
  return out;
}

/**
 * Create a per-fixture result market (market_id 12, 3-bucket) and settle it to
 * `winningBucket`, so settle_contest can read it. Mirrors tests/three_way.ts.
 */
export async function makeSettledResultMarket(
  fixtureId: number,
  winningBucket: number,
  settleAuth: Keypair,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, RESULT_MARKET_ID);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), RESULT_MARKET_ID, resultArgs({
      settleAuthority: settleAuth.publicKey,
      entryCloseTs: nowSec() + 3,
    }))
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  // A tiny bet on the winning bucket so settle() does NOT hit the zero-winner
  // void path (settle.rs voids a market whose winning bucket has no stake).
  const bettor = await freshFunded();
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(winningBucket, new BN(1000))
    .accountsStrict({ bettor: bettor.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([bettor]).rpc();
  await sleep(3500);
  await program.methods
    .settle(winningBucket, 1, new BN(1700000000000), 0)
    .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient: creator.publicKey })
    .signers([settleAuth]).rpc();
  return market;
}

/**
 * Create a per-fixture result market and drive it to the ZERO-WINNER void path:
 * the only stake sits on a NON-winning bucket, then `settle` declares
 * `winningBucket` (which has no stake). settle.rs Voids the market but RECORDS
 * `winning_bucket`. settle_contest must still read that bucket from the Voided
 * market (audit fix B) — a match that played but drew no stake on the winning side
 * settles the contest instead of bricking it.
 */
export async function makeZeroWinnerResultMarket(
  fixtureId: number,
  winningBucket: number,
  settleAuth: Keypair,
): Promise<PublicKey> {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, RESULT_MARKET_ID);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), RESULT_MARKET_ID, resultArgs({
      settleAuthority: settleAuth.publicKey,
      entryCloseTs: nowSec() + 3,
    }))
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  // Stake on a bucket OTHER than the eventual winner → winner bucket has 0 stake.
  const loserBucket = (winningBucket + 1) % 3;
  const bettor = await freshFunded();
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(loserBucket, new BN(1000))
    .accountsStrict({ bettor: bettor.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([bettor]).rpc();
  await sleep(3500);
  await program.methods
    .settle(winningBucket, 1, new BN(1700000000000), 0)
    .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient: creator.publicKey })
    .signers([settleAuth]).rpc();
  return market;
}

export { LAMPORTS_PER_SOL };
```

- [ ] **Step 2: Write the failing test**

Create `tests/contest_lifecycle.ts`:

```ts
import {
  program, freshFunded, SystemProgram, assert, expectError,
} from "./helpers";
import { jackpotVaultPda } from "./contest_helpers";

describe("daily sweepstake — vault", () => {
  it("initializes the singleton jackpot vault once", async () => {
    // The vault is one global PDA shared across the whole validator run, and test
    // files run in alphabetical order — another suite (e.g. contest_enter) may have
    // initialized it first. So ensure it exists rather than assuming we're first.
    const keeper = await freshFunded();
    const vault = jackpotVaultPda();
    let createdHere = false;
    try {
      await program.methods.initializeVault()
        .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();
      createdHere = true;
    } catch (_) { /* already initialized by an earlier suite */ }

    // Fresh-init values are only guaranteed when THIS test created the vault
    // (reserved accumulates globally once other suites settle/void).
    if (createdHere) {
      const v = await program.account.jackpotVault.fetch(vault);
      assert.equal(v.activeContestId.toNumber(), 0);
      assert.equal(v.reserved.toNumber(), 0);
    }

    // The singleton guarantee, order-independent: a duplicate init always fails.
    const keeper2 = await freshFunded();
    await expectError(
      program.methods.initializeVault()
        .accountsStrict({ keeper: keeper2.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper2]).rpc(),
      "already in use",
    );
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `program.methods.initializeVault` is not a function / instruction unknown.

- [ ] **Step 4: Implement the instruction**

Create `programs/proofbet/src/instructions/initialize_vault.rs`:

```rust
use anchor_lang::prelude::*;

use crate::contest_state::JackpotVault;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        init,
        payer = keeper,
        space = 8 + JackpotVault::INIT_SPACE,
        seeds = [b"jackpot_vault"],
        bump
    )]
    pub vault: Account<'info, JackpotVault>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVault>) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    v.active_contest_id = 0;
    v.reserved = 0;
    v.bump = ctx.bumps.vault;
    Ok(())
}
```

- [ ] **Step 5: Register the module and the program entrypoint**

In `programs/proofbet/src/instructions/mod.rs`, add (following the existing block style):

```rust
pub mod initialize_vault;
pub use initialize_vault::*;
```

In `programs/proofbet/src/lib.rs`, add this handler inside `pub mod proofbet { … }` (after `claim`):

```rust
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handler(ctx)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — vault initializes; the duplicate init rejects with "already in use".

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/instructions/initialize_vault.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/contest_helpers.ts tests/contest_lifecycle.ts
git commit -m "feat(program): initialize_vault singleton jackpot vault"
```

---

## Task 3: `create_contest` + `void_contest` instructions

> Both are implemented together: `void_contest` is the teardown that frees the
> singleton vault's one-live-contest guard, so every later test that opens a
> contest can reset the vault. (Its refund path is tested in Task 7, once
> `claim_contest` exists.)

**Files:**
- Create: `programs/proofbet/src/instructions/create_contest.rs`
- Create: `programs/proofbet/src/instructions/void_contest.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Modify: `tests/contest_lifecycle.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("daily sweepstake — vault", …)` file a new block in `tests/contest_lifecycle.ts`:

```ts
import { contestPda, fixtureArray } from "./contest_helpers";
import { BN, nowSec } from "./helpers";

describe("daily sweepstake — create_contest", () => {
  async function freshVault() {
    // The vault is a singleton; init once per validator run. Ignore "already in use".
    const keeper = await freshFunded();
    const vault = jackpotVaultPda();
    try {
      await program.methods.initializeVault()
        .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();
    } catch (_) { /* already initialized by an earlier test */ }
    return { keeper, vault };
  }

  it("creates an Open contest and marks the vault active", async () => {
    const { keeper, vault } = await freshVault();
    const contestId = 30001;
    const contest = contestPda(contestId);
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray([8001, 8002, 8003, 8004]), 4,
        new BN(20_000_000), new BN(lock), new BN(lock + 10), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { open: {} });
    assert.equal(c.numMatches, 4);
    assert.equal(c.entryPrice.toNumber(), 20_000_000);
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), contestId);

    // Teardown: void to free the singleton vault for later tests/files.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
    assert.equal((await program.account.jackpotVault.fetch(vault)).activeContestId.toNumber(), 0);
  });

  it("rejects num_matches outside 3..=5", async () => {
    const { keeper, vault } = await freshVault();
    // Vault may already be active from the previous test; use a distinct id and
    // expect the match-count check to fire before/independently — run on a clean
    // vault by voiding is out of scope here, so assert the validation error code.
    const contest = contestPda(30002);
    const lock = nowSec() + 5;
    await expectError(
      program.methods
        .createContest(
          new BN(30002), fixtureArray([8001, 8002]), 2,
          new BN(20_000_000), new BN(lock), new BN(lock + 10), keeper.publicKey, 500,
        )
        .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "InvalidMatchCount",
    );
  });
});
```

> Teardown convention (applies to every contest-creating test): the singleton vault holds one live contest at a time, so each `it` that opens a contest MUST free the vault before the next one runs — by reaching a terminal state (`settle_contest`) or by `void_contest` (the happy-path test above does the latter). Argument-validation tests (e.g. `InvalidMatchCount`) don't need teardown: `create_contest` validates args **before** the live-guard (Step 3 ordering), so they fail with their specific error and never set `active_contest_id`, and Anchor reverts the `init` on failure.

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `createContest` unknown.

- [ ] **Step 3: Implement the instruction**

Create `programs/proofbet/src/instructions/create_contest.rs`:

```rust
use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestCreated;
use crate::state::MAX_FEE_BPS;

#[derive(Accounts)]
#[instruction(contest_id: u64)]
pub struct CreateContest<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Contest::INIT_SPACE,
        seeds = [b"contest", contest_id.to_le_bytes().as_ref()],
        bump
    )]
    pub contest: Account<'info, Contest>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateContest>,
    contest_id: u64,
    fixtures: [i64; MAX_MATCHES],
    num_matches: u8,
    entry_price: u64,
    lock_ts: i64,
    settle_after_ts: i64,
    fee_recipient: Pubkey,
    fee_bps: u16,
) -> Result<()> {
    // Pure argument validation first (independent of vault state), then the
    // one-live-contest guard last — so a bad-args test fails with its specific
    // error regardless of whether another contest happens to be live.
    require!(contest_id != 0, ProofBetError::InvalidContestId);
    require!(
        (3..=MAX_MATCHES as u8).contains(&num_matches),
        ProofBetError::InvalidMatchCount
    );
    require!(entry_price > 0, ProofBetError::ZeroAmount);
    require!(fee_bps <= MAX_FEE_BPS, ProofBetError::FeeTooHigh);
    let now = Clock::get()?.unix_timestamp;
    require!(now < lock_ts && lock_ts < settle_after_ts, ProofBetError::EntryCloseInPast);
    for i in 0..(num_matches as usize) {
        require!(fixtures[i] != 0, ProofBetError::InvalidFixtureId);
    }
    require!(
        ctx.accounts.vault.active_contest_id == 0,
        ProofBetError::ContestStillLive
    );

    let keeper_key = ctx.accounts.keeper.key();
    let c = &mut ctx.accounts.contest;
    c.contest_id = contest_id;
    c.settle_authority = keeper_key;
    c.fee_recipient = fee_recipient;
    c.fixtures = fixtures;
    c.num_matches = num_matches;
    c.entry_price = entry_price;
    c.lock_ts = lock_ts;
    c.settle_after_ts = settle_after_ts;
    c.fee_bps = fee_bps;
    c.status = ContestStatus::Open;
    c.winning_buckets = [0; MAX_MATCHES];
    c.entry_count = 0;
    c.perfect_count = 0;
    c.pot_snapshot = 0;
    c.distributable = 0;
    c.claimed_count = 0;
    c.claimed_total = 0;
    c.settled_ts = 0;
    c.bump = ctx.bumps.contest;

    ctx.accounts.vault.active_contest_id = contest_id;

    emit!(ContestCreated {
        contest: ctx.accounts.contest.key(),
        contest_id,
        num_matches,
        entry_price,
        lock_ts,
        settle_after_ts,
        settle_authority: keeper_key,
    });
    Ok(())
}
```

- [ ] **Step 4: Implement `void_contest` (teardown + abandoned-card escape hatch)**

Create `programs/proofbet/src/instructions/void_contest.rs`:

```rust
use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestVoided;

#[derive(Accounts)]
pub struct VoidContest<'info> {
    /// The caller. Must equal `contest.settle_authority` (the keeper) UNLESS the
    /// grace period past `settle_after_ts` has elapsed, in which case anyone may
    /// void. Because that authorization is conditional it's checked in the handler,
    /// not via a fixed `has_one` (the account stays named `settle_authority` so the
    /// common keeper call sites read naturally).
    // NOTE (IDL-naming, tracked): an IDL consumer reading only this struct may
    // assume `settle_authority` is always required to be the keeper. It is NOT —
    // the handler permits any signer after the grace window. Revisit renaming to
    // `caller` when the engine/keeper/web client plans are written.
    pub settle_authority: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    pub contest: Account<'info, Contest>,
}

pub fn handler(ctx: Context<VoidContest>) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    // Authorization: the keeper may void any time; ANYONE may void once the grace
    // period past settle_after_ts has elapsed (permissionless liveness backstop so
    // a lost/absent keeper can't freeze the whole vault forever).
    let is_keeper =
        ctx.accounts.settle_authority.key() == ctx.accounts.contest.settle_authority;
    // saturating_add: a bogus settle_after_ts near i64::MAX saturates rather than
    // wrapping negative, so grace_elapsed stays false → permissionless void never
    // fires → fails closed (the safe direction).
    let grace_elapsed =
        now > ctx.accounts.contest.settle_after_ts.saturating_add(VOID_GRACE_SECS);
    require!(is_keeper || grace_elapsed, ProofBetError::Unauthorized);

    // Fence the refundable stake (Σ entry.amount = entry_count * entry_price) as a
    // cross-contest liability so the next contest can't roll lamports we owe back.
    // u128 mul then a CHECKED narrow to u64 (never a silent truncating cast).
    let refundable = u64::try_from(
        (ctx.accounts.contest.entry_count as u128)
            .checked_mul(ctx.accounts.contest.entry_price as u128)
            .ok_or(ProofBetError::MathOverflow)?,
    )
    .map_err(|_| ProofBetError::MathOverflow)?;
    ctx.accounts.vault.reserved = ctx
        .accounts
        .vault
        .reserved
        .checked_add(refundable)
        .ok_or(ProofBetError::MathOverflow)?;
    ctx.accounts.vault.active_contest_id = 0;

    let c = &mut ctx.accounts.contest;
    c.status = ContestStatus::Voided;
    c.settled_ts = now;
    emit!(ContestVoided { contest: c.key(), contest_id: c.contest_id });
    Ok(())
}
```

- [ ] **Step 5: Register both modules + entrypoints**

`instructions/mod.rs`:

```rust
pub mod create_contest;
pub use create_contest::*;

pub mod void_contest;
pub use void_contest::*;
```

`lib.rs` (inside `pub mod proofbet`):

```rust
    #[allow(clippy::too_many_arguments)]
    pub fn create_contest(
        ctx: Context<CreateContest>,
        contest_id: u64,
        fixtures: [i64; crate::contest_state::MAX_MATCHES],
        num_matches: u8,
        entry_price: u64,
        lock_ts: i64,
        settle_after_ts: i64,
        fee_recipient: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::create_contest::handler(
            ctx, contest_id, fixtures, num_matches, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps,
        )
    }

    pub fn void_contest(ctx: Context<VoidContest>) -> Result<()> {
        instructions::void_contest::handler(ctx)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — contest created, `active_contest_id` set then cleared by the teardown void; bad `num_matches` rejected.

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/instructions/create_contest.rs programs/proofbet/src/instructions/void_contest.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/contest_lifecycle.ts
git commit -m "feat(program): create_contest + void_contest (one-live-contest guard + teardown)"
```

---

## Task 4: `enter` instruction (multi-ticket, edit-before-lock)

**Files:**
- Create: `programs/proofbet/src/instructions/enter.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/contest_enter.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/contest_enter.ts`:

```ts
import {
  program, freshFunded, SystemProgram, assert, expectError, balance,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import { jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray } from "./contest_helpers";

async function openContest(contestId: number, lockInSec = 6) {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  const contest = contestPda(contestId);
  const lock = nowSec() + lockInSec;
  await program.methods
    .createContest(
      new BN(contestId), fixtureArray([9001, 9002, 9003, 9004]), 4,
      new BN(20_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500,
    )
    .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  return { keeper, vault, contest };
}

describe("daily sweepstake — enter", () => {
  let live: any = null;
  afterEach(async () => {
    if (!live) return;
    try {
      await program.methods.voidContest()
        .accountsStrict({ settleAuthority: live.keeper.publicKey, vault: live.vault, contest: live.contest })
        .signers([live.keeper]).rpc();
    } catch (_) { /* already terminal */ }
    live = null;
  });

  it("escrows one ticket and edits picks without re-charging", async () => {
    live = await openContest(40001);
    const { vault, contest } = live;
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);

    const vBefore = await balance(vault);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(vault) - vBefore, 20_000_000, "one ticket escrowed");
    let c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 1);

    // Edit the SAME nonce before lock — no second charge, no entry_count change.
    const vAfterFirst = await balance(vault);
    await program.methods.enter(new BN(0), pickArray([2, 2, 2, 2]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(vault), vAfterFirst, "edit does not re-charge");
    c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 1, "edit does not increment entry_count");
    const e = await program.account.entry.fetch(entry0);
    assert.deepEqual(e.picks, [2, 2, 2, 2, 0]);
  });

  it("a second nonce is a second ticket and a second charge", async () => {
    live = await openContest(40002);
    const { vault, contest } = live;
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    const entry1 = entryPda(contest, player.publicKey, 1);
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    const vMid = await balance(vault);
    await program.methods.enter(new BN(1), pickArray([1, 1, 1, 1]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry1, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(vault) - vMid, 20_000_000, "second ticket charged");
    const c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 2);
  });

  it("rejects entry after lock and rejects an out-of-range pick", async () => {
    live = await openContest(40003, 4);
    const { vault, contest } = live;
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    await expectError(
      program.methods.enter(new BN(0), pickArray([3, 0, 0, 0]))
        .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "InvalidPick",
    );
    await sleep(4500); // pass lock_ts
    await expectError(
      program.methods.enter(new BN(0), pickArray([0, 0, 0, 0]))
        .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "EntryClosed",
    );
  });
});
```

> The `afterEach` voids whatever contest the test opened, freeing the singleton vault's one-live-contest guard for the next test and the next file. `void_contest` already exists from Task 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `enter` unknown.

- [ ] **Step 3: Implement the instruction**

Create `programs/proofbet/src/instructions/enter.rs`:

```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::EnteredContest;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Enter<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    pub contest: Account<'info, Contest>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Entry::INIT_SPACE,
        seeds = [b"entry", contest.key().as_ref(), bettor.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub entry: Account<'info, Entry>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Enter>, nonce: u64, picks: [u8; MAX_MATCHES]) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.contest.lock_ts, ProofBetError::EntryClosed);

    // Validate picks: 0..3 within num_matches, exactly 0 beyond it (tail guard).
    let nm = ctx.accounts.contest.num_matches as usize;
    for (i, &p) in picks.iter().enumerate() {
        if i < nm {
            require!(p < 3, ProofBetError::InvalidPick);
        } else {
            require!(p == 0, ProofBetError::InvalidPick);
        }
    }

    let bettor_key = ctx.accounts.bettor.key();
    // Deterministic new-ticket detection: a fresh PDA is zero-initialized.
    let is_new = ctx.accounts.entry.bettor == Pubkey::default();

    if is_new {
        let price = ctx.accounts.contest.entry_price;
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.bettor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi, price)?;

        let contest_key = ctx.accounts.contest.key();
        let entry = &mut ctx.accounts.entry;
        entry.bettor = bettor_key;
        entry.contest = contest_key;
        entry.nonce = nonce;
        entry.amount = price;
        entry.picks = picks;
        entry.bump = ctx.bumps.entry;

        let c = &mut ctx.accounts.contest;
        c.entry_count = c.entry_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;

        emit!(EnteredContest {
            contest: contest_key,
            bettor: bettor_key,
            nonce,
            amount: price,
            entry_count: c.entry_count,
            edited: false,
        });
    } else {
        require_keys_eq!(ctx.accounts.entry.bettor, bettor_key, ProofBetError::Unauthorized);
        ctx.accounts.entry.picks = picks;
        emit!(EnteredContest {
            contest: ctx.accounts.contest.key(),
            bettor: bettor_key,
            nonce,
            amount: ctx.accounts.entry.amount,
            entry_count: ctx.accounts.contest.entry_count,
            edited: true,
        });
    }
    Ok(())
}
```

- [ ] **Step 4: Register module + entrypoint**

`instructions/mod.rs`:

```rust
pub mod enter;
pub use enter::*;
```

`lib.rs` (inside `pub mod proofbet`):

```rust
    pub fn enter(ctx: Context<Enter>, nonce: u64, picks: [u8; crate::contest_state::MAX_MATCHES]) -> Result<()> {
        instructions::enter::handler(ctx, nonce, picks)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — escrow on new ticket, no re-charge on edit, second nonce = second charge, post-lock + bad-pick rejected.

- [ ] **Step 6: Commit**

```bash
git add programs/proofbet/src/instructions/enter.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/contest_enter.ts
git commit -m "feat(program): enter — multi-ticket escrow + edit-before-lock"
```

---

## Task 5: `settle_contest` (verified buckets, new-entry rake, rollover, reserved fence)

**Files:**
- Create: `programs/proofbet/src/instructions/settle_contest.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/contest_settle.ts`

> **Prerequisite (audit fix B, already applied to the base):** the per-match `settle.rs` zero-winner branch records `market.winning_bucket = Some(winning_bucket)` before voting the market to `Voided`. `settle_contest` below accepts a result leg that is `Settled` **or** `Voided`-with-a-recorded-bucket, so a match that played but drew no stake on the winning side settles the contest instead of bricking it (a `Voided` market with no bucket = abandoned → `settle_contest` rejects, keeper voids). The existing `settle.ts` "voids when the winning bucket has no stake" test asserts the bucket is now recorded.

- [ ] **Step 1: Write the failing test**

Create `tests/contest_settle.ts`:

```ts
import {
  program, freshFunded, SystemProgram, assert, balance, Keypair,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray, makeSettledResultMarket,
} from "./contest_helpers";

async function ensureVault() {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  return vault;
}

describe("daily sweepstake — settle_contest", () => {
  it("reads winning buckets from bound result markets and rakes new entries only", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const feeRecip = Keypair.generate(); // separate from the signer → clean rake measurement
    const contestId = 50001;
    const contest = contestPda(contestId);
    const fixtures = [50010, 50011, 50012, 50013];
    const lock = nowSec() + 5;

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 4,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), feeRecip.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // One perfect ticket: picks == eventual results [0,1,2,0].
    const winner = await freshFunded();
    const e0 = entryPda(contest, winner.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e0, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();

    // Settle the four per-match result markets to [0,1,2,0].
    const settleAuth = await freshFunded();
    const results = [0, 1, 2, 0];
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], settleAuth));

    await sleep(6500); // pass settle_after_ts
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: feeRecip.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} });
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0]);
    assert.equal(c.perfectCount.toNumber(), 1);
    // rake = 5% of new entries (1 ticket * 1 SOL) = 0.05 SOL → paid to the separate
    // fee recipient (not the tx signer), so its whole balance == rake exactly.
    assert.equal(await balance(feeRecip.publicKey), 0.05 * LAMPORTS_PER_SOL, "rake = 5% of the 1 SOL of new entries");
    assert.equal(c.distributable.toNumber(), 0.95 * LAMPORTS_PER_SOL);
  });

  it("perfect_count == 0 rolls over and leaves the (post-rake) pot in the vault", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 50002;
    const contest = contestPda(contestId);
    const fixtures = [50020, 50021, 50022, 50023];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 4,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const loser = await freshFunded();
    const e0 = entryPda(contest, loser.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([2, 2, 2, 2]))
      .accountsStrict({ bettor: loser.publicKey, vault, contest, entry: e0, systemProgram: SystemProgram.programId })
      .signers([loser]).rpc();
    const settleAuth = await freshFunded();
    const results = [0, 1, 2, 0];
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], settleAuth));
    await sleep(6500);
    await program.methods.settleContest(new BN(0))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { rolledOver: {} });
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), 0, "vault freed for the next contest");
    // The post-rake remainder (0.95 SOL) stays escrowed → rolls forward.
    assert.isAtLeast(await balance(vault), 0.95 * LAMPORTS_PER_SOL);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `settleContest` unknown.

- [ ] **Step 3: Implement the instruction**

Create `programs/proofbet/src/instructions/settle_contest.rs`:

```rust
use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestSettled;
use crate::state::{Market, MarketStatus};

#[derive(Accounts)]
pub struct SettleContest<'info> {
    pub settle_authority: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub contest: Account<'info, Contest>,
    /// CHECK: receives rake via direct lamport credit; pinned to contest.fee_recipient.
    #[account(mut, address = contest.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    // remaining_accounts: exactly `num_matches` result-market accounts, card order.
}

fn rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + JackpotVault::INIT_SPACE))
}

pub fn handler(ctx: Context<SettleContest>, perfect_count: u64) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.contest.settle_after_ts, ProofBetError::SettleTooEarly);

    let nm = ctx.accounts.contest.num_matches as usize;
    require!(
        ctx.remaining_accounts.len() == nm,
        ProofBetError::ResultMarketMismatch
    );

    // Read + verify each card match's result market (PDA-bound to the fixture).
    let mut winning = [0u8; MAX_MATCHES];
    for i in 0..nm {
        let acc = &ctx.remaining_accounts[i];
        let fixture_id = ctx.accounts.contest.fixtures[i];
        let (expected, _) = Pubkey::find_program_address(
            &[b"market", fixture_id.to_le_bytes().as_ref(), &[RESULT_MARKET_ID]],
            &crate::ID,
        );
        require_keys_eq!(acc.key(), expected, ProofBetError::ResultMarketMismatch);
        require_keys_eq!(*acc.owner, crate::ID, ProofBetError::ResultMarketMismatch);
        let data = acc.try_borrow_data()?;
        let market = Market::try_deserialize(&mut &data[..])?;
        require!(market.num_buckets == 3, ProofBetError::ResultMarketMismatch);
        // Accept Settled OR a zero-winner Voided market that still recorded its
        // proof-determined winning_bucket (settle.rs sets it on the void). A Voided
        // market with NO bucket is a genuinely abandoned match → ok_or below fails →
        // settle_contest rejects and the keeper voids the contest instead.
        require!(
            market.status == MarketStatus::Settled || market.status == MarketStatus::Voided,
            ProofBetError::ResultMarketNotSettled
        );
        winning[i] = market.winning_bucket.ok_or(ProofBetError::ResultMarketNotSettled)?;
    }

    let floor = rent_floor()?;
    let reserved = ctx.accounts.vault.reserved;
    let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
    // The free pot nets out BOTH the rent floor and lamports already owed to prior
    // terminal contests (reserved) — that free balance is all this contest may touch.
    let pot_snapshot = vault_lamports.saturating_sub(floor).saturating_sub(reserved);

    // Rake on THIS contest's new entries only (never the rolled-in pot).
    let new_stakes = (ctx.accounts.contest.entry_count as u128)
        .checked_mul(ctx.accounts.contest.entry_price as u128)
        .ok_or(ProofBetError::MathOverflow)?;
    let rake = u64::try_from(
        new_stakes
            .checked_mul(ctx.accounts.contest.fee_bps as u128)
            .ok_or(ProofBetError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(ProofBetError::MathOverflow)?,
    )
    .map_err(|_| ProofBetError::MathOverflow)?;
    let rake = rake.min(pot_snapshot);

    if rake > 0 {
        ctx.accounts.vault.sub_lamports(rake)?;
        ctx.accounts.fee_recipient.add_lamports(rake)?;
        // Prior contests' owed funds must still be covered after the rake debit.
        require!(
            ctx.accounts.vault.to_account_info().lamports()
                >= floor.checked_add(reserved).ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
    }

    ctx.accounts.vault.active_contest_id = 0;

    let rolled_over = perfect_count == 0;
    let distributable = if rolled_over {
        0
    } else {
        pot_snapshot.checked_sub(rake).ok_or(ProofBetError::MathOverflow)?
    };

    // Settled (winner): fence the payable amount (share * perfect_count) as a
    // cross-contest liability so the next contest can't roll lamports owed to this
    // contest's winners. Floor-division dust is NOT reserved — it stays free and
    // rolls forward. RolledOver owes no one, so reserved is unchanged.
    if !rolled_over {
        let share = u64::try_from(
            (distributable as u128)
                .checked_div(perfect_count as u128)
                .ok_or(ProofBetError::MathOverflow)?,
        )
        .map_err(|_| ProofBetError::MathOverflow)?;
        let payable = share.checked_mul(perfect_count).ok_or(ProofBetError::MathOverflow)?;
        ctx.accounts.vault.reserved = ctx
            .accounts
            .vault
            .reserved
            .checked_add(payable)
            .ok_or(ProofBetError::MathOverflow)?;
    }
    // Global solvency invariant holds after reserving (by construction it must).
    require!(
        ctx.accounts.vault.to_account_info().lamports()
            >= floor
                .checked_add(ctx.accounts.vault.reserved)
                .ok_or(ProofBetError::MathOverflow)?,
        ProofBetError::VaultInsolvent
    );

    let c = &mut ctx.accounts.contest;
    c.winning_buckets = winning;
    c.perfect_count = perfect_count;
    c.pot_snapshot = pot_snapshot;
    c.distributable = distributable;
    c.settled_ts = now;
    c.status = if rolled_over { ContestStatus::RolledOver } else { ContestStatus::Settled };

    emit!(ContestSettled {
        contest: c.key(),
        contest_id: c.contest_id,
        winning_buckets: winning,
        perfect_count,
        pot_snapshot,
        distributable,
        rake,
        rolled_over,
    });
    Ok(())
}
```

- [ ] **Step 4: Register module + entrypoint**

`instructions/mod.rs`:

```rust
pub mod settle_contest;
pub use settle_contest::*;
```

`lib.rs` (inside `pub mod proofbet`):

```rust
    pub fn settle_contest(ctx: Context<SettleContest>, perfect_count: u64) -> Result<()> {
        instructions::settle_contest::handler(ctx, perfect_count)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — buckets read from the bound markets, rake = 5% of new entries, rollover frees the vault and leaves the net pot escrowed.

- [ ] **Step 6: Commit**

```bash
git add programs/proofbet/src/instructions/settle_contest.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/contest_settle.ts
git commit -m "feat(program): settle_contest — verified buckets, new-entry rake, rollover"
```

---

## Task 6: `claim_contest` (payout / close, solvency cap, rent floor)

**Files:**
- Create: `programs/proofbet/src/instructions/claim_contest.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/contest_claim.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/contest_claim.ts`:

```ts
import {
  program, freshFunded, SystemProgram, assert, balance, expectError,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray, makeSettledResultMarket,
} from "./contest_helpers";

async function ensureVault() {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  return vault;
}

// Open a contest, enter the given (player, picks) tickets, settle to `results`
// with `perfectCount`, and return handles for claiming.
async function runContest(opts: {
  contestId: number;
  fixtures: number[];
  results: number[];
  entries: { player: any; nonce: number; picks: number[] }[];
  perfectCount: number;
}) {
  const vault = await ensureVault();
  const keeper = await freshFunded();
  const settleAuth = await freshFunded();
  const contest = contestPda(opts.contestId);
  const lock = nowSec() + 5;
  await program.methods
    .createContest(
      new BN(opts.contestId), fixtureArray(opts.fixtures), opts.fixtures.length,
      new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
    )
    .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  for (const en of opts.entries) {
    const entry = entryPda(contest, en.player.publicKey, en.nonce);
    await program.methods.enter(new BN(en.nonce), pickArray(en.picks))
      .accountsStrict({ bettor: en.player.publicKey, vault, contest, entry, systemProgram: SystemProgram.programId })
      .signers([en.player]).rpc();
  }
  const markets = [];
  for (let i = 0; i < opts.fixtures.length; i++) {
    markets.push(await makeSettledResultMarket(opts.fixtures[i], opts.results[i], settleAuth));
  }
  await sleep(6500);
  await program.methods.settleContest(new BN(opts.perfectCount))
    .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
    .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
    .signers([keeper]).rpc();
  return { vault, contest };
}

async function claim(vault: any, contest: any, player: any, nonce: number) {
  const entry = entryPda(contest, player.publicKey, nonce);
  await program.methods.claimContest()
    .accountsStrict({ bettor: player.publicKey, vault, contest, entry, systemProgram: SystemProgram.programId })
    .signers([player]).rpc();
}

describe("daily sweepstake — claim_contest", () => {
  it("pays the perfect ticket its share and blocks a double-claim", async () => {
    const winner = await freshFunded();
    const loser = await freshFunded();
    const fixtures = [60010, 60011, 60012];
    const results = [0, 1, 2];
    const { vault, contest } = await runContest({
      contestId: 60001, fixtures, results, perfectCount: 1,
      entries: [
        { player: winner, nonce: 0, picks: [0, 1, 2] },
        { player: loser, nonce: 0, picks: [1, 1, 1] },
      ],
    });

    const c = await program.account.contest.fetch(contest);
    const distributable = c.distributable.toNumber(); // 0.95 * 2 SOL = 1.9 SOL (2 entries, perfect_count 1)

    // Measure the winner's payout via the vault delta (avoids tx-fee/rent noise).
    const vBeforeWin = await balance(vault);
    await claim(vault, contest, winner, 0);
    assert.equal(vBeforeWin - (await balance(vault)), distributable, "winner sweeps the full distributable (perfect_count = 1)");

    // Double-claim: the entry account is closed → fails.
    await expectError(claim(vault, contest, winner, 0), "AccountNotInitialized");

    // Loser draws nothing from the vault (closes its entry for rent only).
    const vBeforeLose = await balance(vault);
    await claim(vault, contest, loser, 0);
    assert.equal(await balance(vault), vBeforeLose, "loser draws nothing from the vault");
  });

  it("two perfect tickets split the pot; vault stays above its rent floor", async () => {
    const a = await freshFunded();
    const b = await freshFunded();
    const fixtures = [60020, 60021, 60022];
    const results = [2, 0, 1];
    const { vault, contest } = await runContest({
      contestId: 60002, fixtures, results, perfectCount: 2,
      entries: [
        { player: a, nonce: 0, picks: [2, 0, 1] },
        { player: b, nonce: 0, picks: [2, 0, 1] },
      ],
    });
    await claim(vault, contest, a, 0);
    await claim(vault, contest, b, 0);
    // Vault account must still exist (never GC'd below rent) and hold ≥ its rent floor.
    const v = await program.account.jackpotVault.fetch(vault); // throws if GC'd
    assert.ok(v);
    assert.isAbove(await balance(vault), 0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `claimContest` unknown.

- [ ] **Step 3: Implement the instruction**

Create `programs/proofbet/src/instructions/claim_contest.rs`:

```rust
use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestClaimed;

#[derive(Accounts)]
pub struct ClaimContest<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    pub contest: Account<'info, Contest>,
    #[account(
        mut,
        seeds = [b"entry", contest.key().as_ref(), bettor.key().as_ref(), entry.nonce.to_le_bytes().as_ref()],
        bump = entry.bump,
        has_one = bettor @ ProofBetError::Unauthorized,
        close = bettor,
    )]
    pub entry: Account<'info, Entry>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimContest>) -> Result<()> {
    let status = ctx.accounts.contest.status;
    require!(
        matches!(
            status,
            ContestStatus::Settled | ContestStatus::RolledOver | ContestStatus::Voided
        ),
        ProofBetError::ContestNotTerminal
    );

    let floor = Rent::get()?.minimum_balance(8 + JackpotVault::INIT_SPACE);

    let mut payout: u64 = 0;
    let mut kind: u8 = 0;

    match status {
        ContestStatus::Voided => {
            payout = ctx.accounts.entry.amount;
            kind = 2;
        }
        ContestStatus::Settled => {
            let nm = ctx.accounts.contest.num_matches as usize;
            let mut perfect = true;
            for i in 0..nm {
                if ctx.accounts.entry.picks[i] != ctx.accounts.contest.winning_buckets[i] {
                    perfect = false;
                    break;
                }
            }
            if perfect {
                require!(ctx.accounts.contest.perfect_count > 0, ProofBetError::PerfectCountZero);
                let share = u64::try_from(
                    (ctx.accounts.contest.distributable as u128)
                        .checked_div(ctx.accounts.contest.perfect_count as u128)
                        .ok_or(ProofBetError::MathOverflow)?,
                )
                .map_err(|_| ProofBetError::MathOverflow)?;
                // Solvency cap: never pay more claims than perfect_count, and never
                // pay out more than distributable in total. Bounds a bad (too-low)
                // perfect_count to over-paying early claimers, never cross-contest.
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
        // RolledOver: no payout, close-only.
        ContestStatus::RolledOver => {}
        ContestStatus::Open => return err!(ProofBetError::ContestNotTerminal),
    }

    if payout > 0 {
        ctx.accounts.vault.sub_lamports(payout)?;
        ctx.accounts.bettor.add_lamports(payout)?;
        // Release the reserved liability by exactly what left the vault (win share
        // or void refund). vault.lamports and reserved drop together, so the
        // invariant vault.lamports >= floor + reserved is preserved by construction
        // — a legitimate winner/refund is always payable, even after a LATER contest
        // has settled. checked_sub can only fire on a real accounting bug.
        ctx.accounts.vault.reserved = ctx
            .accounts
            .vault
            .reserved
            .checked_sub(payout)
            .ok_or(ProofBetError::MathOverflow)?;
        require!(
            ctx.accounts.vault.to_account_info().lamports()
                >= floor
                    .checked_add(ctx.accounts.vault.reserved)
                    .ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
        if kind == 1 {
            let c = &mut ctx.accounts.contest;
            c.claimed_count = c.claimed_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
            c.claimed_total = c.claimed_total.checked_add(payout).ok_or(ProofBetError::MathOverflow)?;
        }
    }

    emit!(ContestClaimed {
        contest: ctx.accounts.contest.key(),
        bettor: ctx.accounts.bettor.key(),
        nonce: ctx.accounts.entry.nonce,
        payout,
        kind,
    });
    Ok(())
    // `close = bettor` returns the Entry rent and deletes it → loser still
    // reclaims rent and a double-claim fails (account gone).
}
```

- [ ] **Step 4: Register module + entrypoint**

`instructions/mod.rs`:

```rust
pub mod claim_contest;
pub use claim_contest::*;
```

`lib.rs` (inside `pub mod proofbet`):

```rust
    pub fn claim_contest(ctx: Context<ClaimContest>) -> Result<()> {
        instructions::claim_contest::handler(ctx)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — perfect ticket paid, double-claim blocked, two winners split, vault never GC'd.

- [ ] **Step 6: Commit**

```bash
git add programs/proofbet/src/instructions/claim_contest.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/contest_claim.ts
git commit -m "feat(program): claim_contest — split payout, solvency cap, rent-floor guard"
```

---

## Task 7: `void_contest` refund path (integration test)

**Files:**
- Create: `tests/contest_void.ts`

`void_contest` is already implemented (Task 3). This task tests its refund path end-to-end: void an open contest, then `claim_contest` refunds each ticket's `entry.amount`. Integration test only — no new program code.

- [ ] **Step 1: Write the test**

Create `tests/contest_void.ts`:

```ts
import {
  program, freshFunded, SystemProgram, assert, balance,
  BN, nowSec, LAMPORTS_PER_SOL,
} from "./helpers";
import { jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray } from "./contest_helpers";

async function ensureVault() {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  return vault;
}

describe("daily sweepstake — void_contest", () => {
  it("voids an abandoned card and refunds each ticket its stake", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 70001;
    const contest = contestPda(contestId);
    const lock = nowSec() + 4;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray([70010, 70011, 70012]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();

    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { voided: {} });
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), 0);

    // Refund: claim_contest on a Voided contest returns entry.amount (+ rent).
    const before = await balance(player.publicKey);
    await program.methods.claimContest()
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    const gained = (await balance(player.publicKey)) - before;
    assert.isAtLeast(gained, 1 * LAMPORTS_PER_SOL, "stake refunded");
  });
});
```

- [ ] **Step 2: Run the test**

Run: `anchor test`
Expected: PASS — contest voided, vault freed (`active_contest_id == 0`), stake refunded via `claim_contest`. (Both instructions already exist; this is an integration test.)

- [ ] **Step 3: Commit**

```bash
git add tests/contest_void.ts
git commit -m "test(program): void_contest refund path"
```

---

## Task 8: Safety + conservation integration tests

**Files:**
- Create: `tests/contest_safety.ts`

These tests assert the must-fix invariants end-to-end. No new program code — if any fails, fix the corresponding instruction from Tasks 5–6.

- [ ] **Step 1: Write the safety tests**

Create `tests/contest_safety.ts`:

```ts
import {
  program, freshFunded, SystemProgram, assert, expectError, balance,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray,
  makeSettledResultMarket, makeZeroWinnerResultMarket,
} from "./contest_helpers";

async function ensureVault() {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  return vault;
}

describe("daily sweepstake — safety", () => {
  it("rejects a foreign/wrong result-market account at settle", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const settleAuth = await freshFunded();
    const contestId = 80001;
    const contest = contestPda(contestId);
    const fixtures = [80010, 80011, 80012];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // Build markets for the WRONG fixtures (not on the card).
    const wrong = [99910, 99911, 99912];
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(wrong[i], 0, settleAuth));
    await sleep(6500);
    await expectError(
      program.methods.settleContest(new BN(0))
        .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
        .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
        .signers([keeper]).rpc(),
      "ResultMarketMismatch",
    );
    // Clean up: void so the singleton vault frees for later runs.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
  });

  it("conserves funds: payout + rake + dust == pot_snapshot", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const settleAuth = await freshFunded();
    const contestId = 80002;
    const contest = contestPda(contestId);
    const fixtures = [80020, 80021, 80022];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // 3 perfect tickets so the split has a remainder (dust).
    const players = [await freshFunded(), await freshFunded(), await freshFunded()];
    for (const p of players) {
      const e = entryPda(contest, p.publicKey, 0);
      await program.methods.enter(new BN(0), pickArray(results))
        .accountsStrict({ bettor: p.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], settleAuth));
    await sleep(6500);

    const vBeforeSettle = await balance(vault);
    await program.methods.settleContest(new BN(3))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const rake = vBeforeSettle - (await balance(vault)); // vault loses exactly the rake at settle

    const c = await program.account.contest.fetch(contest);
    const potSnapshot = c.potSnapshot.toNumber();
    const distributable = c.distributable.toNumber();
    const share = Math.floor(distributable / 3);

    let paid = 0;
    for (const p of players) {
      const before = await balance(vault);
      const e = entryPda(contest, p.publicKey, 0);
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
      paid += before - (await balance(vault));
    }
    const dust = distributable - paid;
    assert.equal(paid, share * 3, "each winner got floor(distributable/3)");
    assert.equal(rake + paid + dust, potSnapshot, "rake + payouts + dust == pot_snapshot");
    assert.isBelow(dust, 3, "dust < perfect_count lamports");
  });

  it("rollover continuity: next contest's pot carries the prior remainder", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const settleAuth = await freshFunded();

    // Contest A: one losing ticket → rollover.
    const idA = 80003;
    const contestA = contestPda(idA);
    const fA = [80030, 80031, 80032];
    let lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idA), fixtureArray(fA), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: contestA, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const loser = await freshFunded();
    const eA = entryPda(contestA, loser.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([1, 1, 1]))
      .accountsStrict({ bettor: loser.publicKey, vault, contest: contestA, entry: eA, systemProgram: SystemProgram.programId })
      .signers([loser]).rpc();
    const mA = [];
    for (let i = 0; i < 3; i++) mA.push(await makeSettledResultMarket(fA[i], [0, 1, 2][i], settleAuth));
    await sleep(6500);
    await program.methods.settleContest(new BN(0))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: contestA, feeRecipient: keeper.publicKey })
      .remainingAccounts(mA.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const carried = await balance(vault); // ≈ rent_floor + 0.95 SOL
    // Contest B opens; its starting pot IS the carried vault balance.
    const idB = 80004;
    const contestB = contestPda(idB);
    lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idB), fixtureArray([80040, 80041, 80042]), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: contestB, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    assert.equal(await balance(vault), carried, "B starts from A's carried pot (rollover-for-free)");
    // Tidy up.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: contestB })
      .signers([keeper]).rpc();
  });

  it("cross-contest solvency: a prior contest's straggler is still paid after the next contest settles", async () => {
    // THE audit regression. Without the `reserved` fence, contest B's pot_snapshot
    // double-counts A's unclaimed winner share and the straggler reverts forever.
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const settleAuth = await freshFunded();

    // Contest A: two perfect tickets (perfect_count = 2). Only ONE claims now.
    const idA = 80005;
    const cA = contestPda(idA);
    const fA = [80050, 80051, 80052];
    const resA = [0, 1, 2];
    let lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idA), fixtureArray(fA), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: cA, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const a1 = await freshFunded();
    const a2 = await freshFunded();
    for (const p of [a1, a2]) {
      await program.methods.enter(new BN(0), pickArray(resA))
        .accountsStrict({ bettor: p.publicKey, vault, contest: cA, entry: entryPda(cA, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const mA = [];
    for (let i = 0; i < 3; i++) mA.push(await makeSettledResultMarket(fA[i], resA[i], settleAuth));
    await sleep(6500);
    await program.methods.settleContest(new BN(2))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: cA, feeRecipient: keeper.publicKey })
      .remainingAccounts(mA.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const shareA = Math.floor((await program.account.contest.fetch(cA)).distributable.toNumber() / 2);

    // a1 claims; a2 is the STRAGGLER (does not claim yet). reserved holds a2's share.
    const a1VBefore = await balance(vault);
    await program.methods.claimContest()
      .accountsStrict({ bettor: a1.publicKey, vault, contest: cA, entry: entryPda(cA, a1.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([a1]).rpc();
    assert.equal(a1VBefore - (await balance(vault)), shareA, "a1 paid its share from the vault");
    assert.equal((await program.account.jackpotVault.fetch(vault)).reserved.toNumber(), shareA, "a2's share stays reserved");

    // Contest B opens (active_contest_id == 0 after A settled), 2 perfect tickets, settles.
    const idB = 80006;
    const cB = contestPda(idB);
    const fB = [80060, 80061, 80062];
    const resB = [2, 0, 1];
    lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idB), fixtureArray(fB), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: cB, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const b1 = await freshFunded();
    const b2 = await freshFunded();
    for (const p of [b1, b2]) {
      await program.methods.enter(new BN(0), pickArray(resB))
        .accountsStrict({ bettor: p.publicKey, vault, contest: cB, entry: entryPda(cB, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const mB = [];
    for (let i = 0; i < 3; i++) mB.push(await makeSettledResultMarket(fB[i], resB[i], settleAuth));
    await sleep(6500);
    await program.methods.settleContest(new BN(2))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: cB, feeRecipient: keeper.publicKey })
      .remainingAccounts(mB.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    // B's pot must EXCLUDE a2's reserved share: distributable_B = 2 SOL new − 5% rake
    // = 1.9 SOL (NOT 2.95 SOL, which is the double-counting bug). Integer math, no float.
    const expectedDistB = 2 * LAMPORTS_PER_SOL - Math.floor((2 * LAMPORTS_PER_SOL * 500) / 10000);
    assert.equal((await program.account.contest.fetch(cB)).distributable.toNumber(), expectedDistB, "B's pot excludes A's reserved straggler share (1.9 SOL, not 2.95)");

    // B's winners both claim.
    for (const p of [b1, b2]) {
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, vault, contest: cB, entry: entryPda(cB, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }

    // THE REGRESSION: A's straggler a2 claims LAST and MUST be paid its full share.
    const a2VBefore = await balance(vault);
    await program.methods.claimContest()
      .accountsStrict({ bettor: a2.publicKey, vault, contest: cA, entry: entryPda(cA, a2.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([a2]).rpc();
    assert.equal(a2VBefore - (await balance(vault)), shareA, "straggler a2 paid its full share — no cross-contest insolvency");
    assert.equal((await program.account.jackpotVault.fetch(vault)).reserved.toNumber(), 0, "all liabilities released");
  });

  it("settles a contest whose result leg is a zero-stake (voided-with-bucket) market", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const settleAuth = await freshFunded();
    const contestId = 80007;
    const contest = contestPda(contestId);
    const fixtures = [80070, 80071, 80072];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(contestId), fixtureArray(fixtures), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const winner = await freshFunded();
    const e = entryPda(contest, winner.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray(results))
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    // Legs 0 & 1 settle normally; leg 2 is a ZERO-WINNER market → Voided WITH bucket.
    const markets = [
      await makeSettledResultMarket(fixtures[0], results[0], settleAuth),
      await makeSettledResultMarket(fixtures[1], results[1], settleAuth),
      await makeZeroWinnerResultMarket(fixtures[2], results[2], settleAuth),
    ];
    await sleep(6500);
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} }, "contest settles despite a zero-stake result leg");
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0], "winning bucket read from the voided-with-bucket market");
    const vBefore = await balance(vault);
    await program.methods.claimContest()
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    assert.isAbove(vBefore - (await balance(vault)), 0, "perfect ticket paid");
  });

  it("rejects void_contest by a non-keeper before the grace period (deny path of the permissionless backstop)", async () => {
    // The ALLOW-after-grace path (now > settle_after_ts + VOID_GRACE, 3 days) can't be
    // wall-clock tested on a local validator; it is reviewed in void_contest.rs. Here we
    // assert the deny path: a stranger cannot void early.
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 80008;
    const contest = contestPda(contestId);
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(contestId), fixtureArray([80080, 80081, 80082]), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const stranger = await freshFunded();
    await expectError(
      program.methods.voidContest()
        .accountsStrict({ settleAuthority: stranger.publicKey, vault, contest })
        .signers([stranger]).rpc(),
      "Unauthorized",
    );
    // Keeper can still void any time (teardown).
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
  });
});
```

- [ ] **Step 2: Run the safety tests**

Run: `anchor test`
Expected: PASS — wrong-market rejected, conservation holds, rollover carries the pot. If a conservation or rent assertion fails, revisit the `pot_snapshot`/`distributable`/rake math in `settle_contest.rs` and the cap/floor guards in `claim_contest.rs`.

- [ ] **Step 3: Commit**

```bash
git add tests/contest_safety.ts
git commit -m "test(program): sweepstake safety + conservation + rollover invariants"
```

---

## Done criteria

- `anchor test` runs the full suite green, including the existing `Market` tests (no regressions — note the updated `settle.ts` zero-winner assertion) and all new `contest_*` tests.
- Six new instructions exist and are wired in `lib.rs`: `initialize_vault`, `create_contest`, `enter`, `settle_contest`, `claim_contest`, `void_contest`.
- `JackpotVault` carries `reserved`; every pot read nets it out; settle/void increment it and each claim/refund decrements it, keeping `vault.lamports ≥ rent_floor + reserved` at all times.
- Every spec §15 program invariant has a passing test: escrow + no-double-charge edit, multi-ticket, post-lock reject, verified buckets + wrong-market reject, new-entry-only rake, rollover, perfect split + double-claim block, rent-floor survival, solvency cap, void refund, conservation, rollover continuity, one-live-contest, **cross-contest solvency (straggler paid after the next contest settles), zero-stake result leg settles, permissionless-void deny-before-grace**.

## Follow-on plans (not in this plan)
1. **Engine** — `/api/contest/{today,entries,alive}` reading the new accounts via `chain.ts`; the `COMPETITION_ALLOWLIST` is already wired in `catalog.ts`.
2. **Keeper** — adaptive card from `fetchSlate` (floor 3 / target 4 / cap 5 / skip-on-thin), `create_contest`, then `settle_contest` with the card's result-market accounts.
3. **Web** — `SweepstakeView` + `BottomNav` change (Sweepstake first, board → "Markets").
