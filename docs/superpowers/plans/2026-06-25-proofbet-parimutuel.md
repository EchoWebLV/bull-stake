# ProofBet Parimutuel Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Anchor program that runs native-SOL parimutuel betting pools for World Cup soccer props, settled from a keeper-supplied winning bucket with on-chain proof-binding, plus the keeper script that derives that bucket from TxLINE Merkle proofs.

**Architecture:** A single Anchor program `proofbet` with three PDAs (`Market`, `Vault`, `Position`) and five instructions (`initialize_market`, `place_bet`, `settle`, `void_market`, `claim`). The program never calls Txoracle — the `settle_authority` keeper submits the winning bucket plus immutable proof-binding fields (`settled_seq`, `settled_ts`, `settled_value`) so anyone can re-derive the result. All correctness (parimutuel math, conservation, refunds) is testable on localnet because `settle` takes the bucket directly. A separate TS keeper reuses the spike's `validate.ts` to compute the bucket on devnet.

**Tech Stack:** Anchor 0.31.1, Rust (edition 2021), Solana 4.1, `@coral-xyz/anchor` 0.31.1, ts-mocha + chai for tests, tsx for the keeper. Spec: [docs/superpowers/specs/2026-06-25-proofbet-parimutuel-design.md](../specs/2026-06-25-proofbet-parimutuel-design.md).

---

## Spec deviations (deliberate, with justification)

- **`MarketSettled` event omits `daily_scores_pda`.** The spec listed it, but the program would have to hardcode the Txoracle program id and seed to derive it. Instead we bind `settled_ts` (the batch `minTimestamp`), which is the *sole input* the daily-scores PDA is a pure function of. Any observer derives the PDA off-chain from `settled_ts`. This is strictly cleaner and loses no verifiability.
- **Toolchain is Anchor 0.31.1** (installed), not 0.30 as the spec summary mentioned. All code below targets 0.31.1.
- **`settled_ts` is stored in milliseconds** (the TxLINE batch `minTimestamp`), because the Txoracle daily-scores PDA derivation is `epochDay = floor(minTimestamp / 86_400_000)`. This is intentionally a *different unit* from `entry_close_ts` (unix seconds, from `Clock`). Both are documented at their definitions.

## File structure

Anchor workspace at repo root; the spike stays untouched.

| Path | Responsibility |
|---|---|
| `Anchor.toml` | Workspace config, localnet program id, npm package manager, test script |
| `Cargo.toml` | Rust workspace (members, release profile w/ overflow-checks) |
| `programs/proofbet/Cargo.toml` | Program crate manifest |
| `programs/proofbet/src/lib.rs` | `declare_id!` + `#[program]` thin dispatch to handlers |
| `programs/proofbet/src/state.rs` | `Market`, `Vault`, `Position`, enums, consts |
| `programs/proofbet/src/errors.rs` | `ProofBetError` codes |
| `programs/proofbet/src/events.rs` | `MarketCreated`, `BetPlaced`, `MarketSettled`, `MarketVoided`, `Claimed` |
| `programs/proofbet/src/instructions/mod.rs` | Re-exports |
| `programs/proofbet/src/instructions/initialize_market.rs` | `InitMarketArgs`, accounts, handler |
| `programs/proofbet/src/instructions/place_bet.rs` | accounts + handler (deposit, init_if_needed position) |
| `programs/proofbet/src/instructions/settle.rs` | accounts + handler (winner pick, fee skim, zero-winner→void) |
| `programs/proofbet/src/instructions/void_market.rs` | accounts + handler |
| `programs/proofbet/src/instructions/claim.rs` | accounts + handler (payout/refund, close position) |
| `tests/helpers.ts` | provider/program singletons, PDA derivers, airdrop/balance/sleep, `expectError` |
| `tests/initialize.ts` | `initialize_market` happy + rejections |
| `tests/place_bet.ts` | `place_bet` happy + rejections |
| `tests/settle.ts` | `settle` happy + fee + zero-winner-void + rejections |
| `tests/void.ts` | `void_market` happy + rejections |
| `tests/claim.ts` | `claim` winner/loser/void + double-claim/before-settle rejections |
| `tests/conservation.ts` | multi-bettor end-to-end conservation invariant + dust + fee |
| `keeper/package.json`, `keeper/tsconfig.json` | keeper module config (ESM, tsx) |
| `keeper/settle.ts` | reads a Market, derives bucket via spike `validate.ts`, calls `settle`/`void_market` |
| `package.json`, `tsconfig.json` | root test deps + ts-mocha config |
| `.gitignore` | add `target/`, `.anchor/`, `test-ledger/` |

---

## Task 1: Scaffold the Anchor workspace

**Files:**
- Create: `Anchor.toml`, `Cargo.toml`, `package.json`, `tsconfig.json`
- Create: `programs/proofbet/Cargo.toml`, `programs/proofbet/src/lib.rs`
- Create: `tests/smoke.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write `Anchor.toml`**

```toml
[toolchain]
anchor_version = "0.31.1"
package_manager = "npm"

[features]
resolution = true
skip-lint = false

[programs.localnet]
proofbet = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "npx ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

- [ ] **Step 2: Write `Cargo.toml` (workspace root)**

```toml
[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
```

- [ ] **Step 3: Write `programs/proofbet/Cargo.toml`**

```toml
[package]
name = "proofbet"
version = "0.1.0"
description = "ProofBet parimutuel market for World Cup soccer props"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "proofbet"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = { version = "0.31.1", features = ["init-if-needed"] }
```

- [ ] **Step 4: Write a minimal `programs/proofbet/src/lib.rs`**

```rust
use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod proofbet {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
```

- [ ] **Step 5: Write root `package.json`**

```json
{
  "name": "proofbet",
  "version": "0.1.0",
  "license": "ISC",
  "scripts": {
    "test": "anchor test",
    "typecheck": "tsc --noEmit -p ./tsconfig.json"
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.31.1"
  },
  "devDependencies": {
    "@types/bn.js": "^5.1.0",
    "@types/chai": "^4.3.0",
    "@types/mocha": "^9.0.0",
    "@types/node": "^22.5.0",
    "chai": "^4.3.4",
    "mocha": "^9.0.3",
    "ts-mocha": "^10.0.0",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 6: Write root `tsconfig.json`**

```json
{
  "compilerOptions": {
    "types": ["mocha", "chai", "node"],
    "typeRoots": ["./node_modules/@types"],
    "lib": ["es2020"],
    "module": "commonjs",
    "target": "es6",
    "esModuleInterop": true,
    "moduleResolution": "node",
    "resolveJsonModule": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 7: Append Anchor/Rust ignores to `.gitignore`**

Add these lines to the existing `.gitignore`:

```
# anchor / rust
target/
.anchor/
test-ledger/
**/*.rs.bk
```

- [ ] **Step 8: Write `tests/smoke.ts`**

```ts
import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";

describe("smoke", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  it("loads the program from the workspace", () => {
    const program = (anchor.workspace as any).proofbet;
    assert.ok(program, "anchor.workspace.proofbet should be defined");
    assert.ok(program.programId, "program should have a programId");
  });
});
```

- [ ] **Step 9: Install JS deps**

Run: `npm install`
Expected: dependencies install, `node_modules/` created, no errors.

- [ ] **Step 10: Build and sync the program id**

Run: `anchor build`
Expected: compiles; generates `target/idl/proofbet.json`, `target/types/proofbet.ts`, `target/deploy/proofbet-keypair.json`.

Run: `anchor keys sync`
Expected: writes the real program pubkey into `Anchor.toml` and the `declare_id!` in `lib.rs` (output lists the synced key). If it changed anything, run `anchor build` again.

- [ ] **Step 11: Run the smoke test end-to-end**

Run: `anchor test`
Expected: validator starts, program deploys, `smoke` suite passes (1 passing).

- [ ] **Step 12: Commit**

```bash
git add Anchor.toml Cargo.toml package.json package-lock.json tsconfig.json programs/proofbet/Cargo.toml programs/proofbet/src/lib.rs tests/smoke.ts .gitignore
git commit -m "chore: scaffold proofbet anchor workspace

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Define state, enums, errors, and events

This task adds the type foundation. There is no behavior to TDD yet — the verification is that `anchor build` compiles the new modules. The minimal `lib.rs` from Task 1 is replaced with the full module wiring at the end.

**Files:**
- Create: `programs/proofbet/src/state.rs`
- Create: `programs/proofbet/src/errors.rs`
- Create: `programs/proofbet/src/events.rs`
- Create: `programs/proofbet/src/instructions/mod.rs` (empty re-export stub for now)
- Modify: `programs/proofbet/src/lib.rs`

- [ ] **Step 1: Write `programs/proofbet/src/state.rs`**

```rust
use anchor_lang::prelude::*;

/// Bucket indices. Over = predicate TRUE, Under = predicate FALSE.
pub const OVER: u8 = 0;
pub const UNDER: u8 = 1;
/// Hard ceiling on the losing-pool fee (10%).
pub const MAX_FEE_BPS: u16 = 1000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Open,
    Settled,
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BinaryOp {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub creator: Pubkey,
    pub settle_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub fixture_id: i64,
    /// Distinguishes markets on the same fixture (0 = goals, 1 = corners).
    pub market_id: u8,
    // ── immutable predicate ──
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    // ── lifecycle / economics ──
    /// Entry deadline in UNIX SECONDS (Clock::unix_timestamp). Bets rejected at/after.
    pub entry_close_ts: i64,
    pub fee_bps: u16,
    pub status: MarketStatus,
    pub winning_bucket: Option<u8>,
    pub bucket_totals: [u64; 2],
    pub total_pool: u64,
    pub fee_collected: u64,
    // ── proof-binding (set at settle/void) ──
    pub settled_seq: u32,
    /// The TxLINE batch minTimestamp in MILLISECONDS used to derive the
    /// Txoracle daily_scores PDA (epochDay = settled_ts / 86_400_000).
    pub settled_ts: i64,
    /// Resolved left-hand side: val_a, or (val_a op val_b) for two-stat predicates.
    pub settled_value: i32,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Program-owned PDA that escrows pooled lamports. Holds rent floor + pool.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bettor: Pubkey,
    pub amounts: [u64; 2],
    pub bump: u8,
}
```

- [ ] **Step 2: Write `programs/proofbet/src/errors.rs`**

```rust
use anchor_lang::prelude::*;

#[error_code]
pub enum ProofBetError {
    #[msg("entry_close_ts must be in the future")]
    EntryCloseInPast,
    #[msg("fee_bps exceeds the maximum allowed")]
    FeeTooHigh,
    #[msg("stat_key2 and op must both be set or both be None")]
    PredicateMismatch,
    #[msg("market is not open")]
    MarketNotOpen,
    #[msg("entry window has closed")]
    EntryClosed,
    #[msg("entry window is still open")]
    EntryNotClosed,
    #[msg("invalid bucket (must be 0 or 1)")]
    InvalidBucket,
    #[msg("bet amount must be greater than zero")]
    ZeroAmount,
    #[msg("market is not in a claimable state")]
    NotClaimable,
    #[msg("signer is not authorized for this action")]
    Unauthorized,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
```

- [ ] **Step 3: Write `programs/proofbet/src/events.rs`**

```rust
use anchor_lang::prelude::*;
use crate::state::{BinaryOp, Comparison};

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    pub entry_close_ts: i64,
    pub fee_bps: u16,
    pub settle_authority: Pubkey,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub bucket: u8,
    pub amount: u64,
    pub bucket_totals: [u64; 2],
    pub total_pool: u64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,
    pub winning_bucket: u8,
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    pub settled_seq: u32,
    pub settled_ts: i64,
    pub settled_value: i32,
    pub fee_collected: u64,
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,
    pub settled_seq: u32,
    pub settled_ts: i64,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub payout: u64,
    pub voided: bool,
}
```

- [ ] **Step 4: Write a placeholder `programs/proofbet/src/instructions/mod.rs`**

It is empty for now (handlers added in later tasks):

```rust
// Instruction modules are added in Tasks 3–7.
```

- [ ] **Step 5: Replace `programs/proofbet/src/lib.rs` with module wiring**

```rust
use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod proofbet {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
```

Note: keep the `declare_id!` value that `anchor keys sync` wrote in Task 1 (it may differ from the placeholder shown here).

- [ ] **Step 6: Build**

Run: `anchor build`
Expected: compiles cleanly (warnings about unused `OVER`/`UNDER`/errors/events are fine at this stage).

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/state.rs programs/proofbet/src/errors.rs programs/proofbet/src/events.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs
git commit -m "feat: add proofbet state, errors, and events

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Shared test helpers

Foundation for all instruction tests. No program code; verified by `npm run typecheck` (the `target/types/proofbet.ts` from Task 2's build must exist).

**Files:**
- Create: `tests/helpers.ts`

- [ ] **Step 1: Write `tests/helpers.ts`**

```ts
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import { Proofbet } from "../target/types/proofbet";

export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
export const program = (anchor.workspace as any).proofbet as Program<Proofbet>;
export const connection = provider.connection;

export function marketPda(fixtureId: number | BN, marketId: number): PublicKey {
  const fid = new BN(fixtureId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), fid.toArrayLike(Buffer, "le", 8), Buffer.from([marketId])],
    program.programId,
  )[0];
}

export function vaultPda(market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    program.programId,
  )[0];
}

export function positionPda(market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()],
    program.programId,
  )[0];
}

export async function airdrop(pubkey: PublicKey, sol = 100): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  const bh = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
}

export async function freshFunded(sol = 100): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, sol);
  return kp;
}

export async function balance(pubkey: PublicKey): Promise<number> {
  return connection.getBalance(pubkey);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Default predicate fields for a Total-Goals O/U market (two-stat Add). */
export function goalsArgs(opts: {
  settleAuthority: PublicKey;
  threshold: number;
  entryCloseTs: number;
  feeBps?: number;
  feeRecipient?: PublicKey | null;
}) {
  return {
    settleAuthority: opts.settleAuthority,
    feeRecipient: opts.feeRecipient ?? null,
    statKey: 1,
    statKey2: 2,
    op: { add: {} },
    comparison: { greaterThan: {} },
    threshold: opts.threshold,
    entryCloseTs: new BN(opts.entryCloseTs),
    feeBps: opts.feeBps ?? 0,
  };
}

/** Assert a transaction promise rejects with the given Anchor error code (or substring). */
export async function expectError(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
    assert.fail(`expected error "${code}" but the call succeeded`);
  } catch (e: any) {
    const anchorCode = e?.error?.errorCode?.code;
    const haystack = anchorCode ?? e?.message ?? String(e);
    assert.include(String(haystack), code, `expected "${code}", got: ${haystack}`);
  }
}

export { BN, Program, PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram, anchor, assert };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (confirms `target/types/proofbet.ts` resolves and helper types are sound).

- [ ] **Step 3: Commit**

```bash
git add tests/helpers.ts
git commit -m "test: add shared test helpers and PDA derivers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `initialize_market`

**Files:**
- Create: `programs/proofbet/src/instructions/initialize_market.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/initialize.ts`

- [ ] **Step 1: Write the failing test `tests/initialize.ts`**

```ts
import {
  program, marketPda, vaultPda, freshFunded, goalsArgs,
  expectError, nowSec, BN, Keypair, SystemProgram, assert,
} from "./helpers";

describe("initialize_market", () => {
  const fixtureId = 1001;

  it("creates a market with the immutable predicate", async () => {
    const creator = await freshFunded();
    const settleAuth = Keypair.generate();
    const market = marketPda(fixtureId, 0);
    const vault = vaultPda(market);
    const closeTs = nowSec() + 3600;

    await program.methods
      .initializeMarket(new BN(fixtureId), 0, goalsArgs({
        settleAuthority: settleAuth.publicKey,
        threshold: 2,
        entryCloseTs: closeTs,
        feeBps: 250,
      }))
      .accountsStrict({
        creator: creator.publicKey,
        market,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.fixtureId.toNumber(), fixtureId);
    assert.equal(m.marketId, 0);
    assert.equal(m.statKey, 1);
    assert.equal(m.statKey2, 2);
    assert.deepEqual(m.op, { add: {} });
    assert.deepEqual(m.comparison, { greaterThan: {} });
    assert.equal(m.threshold, 2);
    assert.equal(m.feeBps, 250);
    assert.deepEqual(m.status, { open: {} });
    assert.isNull(m.winningBucket);
    assert.equal(m.totalPool.toNumber(), 0);
    assert.equal(m.bucketTotals[0].toNumber(), 0);
    assert.equal(m.bucketTotals[1].toNumber(), 0);
    // fee_recipient defaults to creator when None
    assert.ok(m.feeRecipient.equals(creator.publicKey));
    assert.ok(m.settleAuthority.equals(settleAuth.publicKey));
  });

  it("rejects an entry_close_ts in the past", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 1);
    const vault = vaultPda(market);
    await expectError(
      program.methods
        .initializeMarket(new BN(fixtureId), 1, goalsArgs({
          settleAuthority: creator.publicKey,
          threshold: 2,
          entryCloseTs: nowSec() - 100,
        }))
        .accountsStrict({
          creator: creator.publicKey, market, vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator]).rpc(),
      "EntryCloseInPast",
    );
  });

  it("rejects fee_bps above the maximum", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 2);
    const vault = vaultPda(market);
    await expectError(
      program.methods
        .initializeMarket(new BN(fixtureId), 2, goalsArgs({
          settleAuthority: creator.publicKey,
          threshold: 2,
          entryCloseTs: nowSec() + 3600,
          feeBps: 1001,
        }))
        .accountsStrict({
          creator: creator.publicKey, market, vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator]).rpc(),
      "FeeTooHigh",
    );
  });

  it("rejects a predicate where stat_key2 is set but op is not", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 3);
    const vault = vaultPda(market);
    const args = goalsArgs({
      settleAuthority: creator.publicKey,
      threshold: 2,
      entryCloseTs: nowSec() + 3600,
    });
    (args as any).op = null; // stat_key2 = 2 but op = null
    await expectError(
      program.methods
        .initializeMarket(new BN(fixtureId), 3, args)
        .accountsStrict({
          creator: creator.publicKey, market, vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator]).rpc(),
      "PredicateMismatch",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `program.methods.initializeMarket` is not a function / instruction does not exist.

- [ ] **Step 3: Write `programs/proofbet/src/instructions/initialize_market.rs`**

```rust
use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::MarketCreated;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitMarketArgs {
    pub settle_authority: Pubkey,
    pub fee_recipient: Option<Pubkey>,
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    pub entry_close_ts: i64,
    pub fee_bps: u16,
}

#[derive(Accounts)]
#[instruction(fixture_id: i64, market_id: u8, args: InitMarketArgs)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", fixture_id.to_le_bytes().as_ref(), market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    fixture_id: i64,
    market_id: u8,
    args: InitMarketArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.entry_close_ts > now, ProofBetError::EntryCloseInPast);
    require!(args.fee_bps <= MAX_FEE_BPS, ProofBetError::FeeTooHigh);
    require!(
        args.stat_key2.is_some() == args.op.is_some(),
        ProofBetError::PredicateMismatch
    );

    let creator_key = ctx.accounts.creator.key();
    let market = &mut ctx.accounts.market;
    market.creator = creator_key;
    market.settle_authority = args.settle_authority;
    market.fee_recipient = args.fee_recipient.unwrap_or(creator_key);
    market.fixture_id = fixture_id;
    market.market_id = market_id;
    market.stat_key = args.stat_key;
    market.stat_key2 = args.stat_key2;
    market.op = args.op;
    market.comparison = args.comparison;
    market.threshold = args.threshold;
    market.entry_close_ts = args.entry_close_ts;
    market.fee_bps = args.fee_bps;
    market.status = MarketStatus::Open;
    market.winning_bucket = None;
    market.bucket_totals = [0, 0];
    market.total_pool = 0;
    market.fee_collected = 0;
    market.settled_seq = 0;
    market.settled_ts = 0;
    market.settled_value = 0;
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;

    ctx.accounts.vault.bump = ctx.bumps.vault;

    emit!(MarketCreated {
        market: market.key(),
        fixture_id,
        market_id,
        stat_key: market.stat_key,
        stat_key2: market.stat_key2,
        op: market.op,
        comparison: market.comparison,
        threshold: market.threshold,
        entry_close_ts: market.entry_close_ts,
        fee_bps: market.fee_bps,
        settle_authority: market.settle_authority,
    });
    Ok(())
}
```

- [ ] **Step 4: Wire it into `instructions/mod.rs`**

```rust
pub mod initialize_market;
pub use initialize_market::*;
```

- [ ] **Step 5: Add the dispatch in `lib.rs`**

Replace the `#[program]` module body so it reads:

```rust
#[program]
pub mod proofbet {
    use super::*;
    use crate::instructions::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fixture_id: i64,
        market_id: u8,
        args: InitMarketArgs,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, fixture_id, market_id, args)
    }
}
```

(Delete the `ping` fn and `Ping` accounts struct — they were scaffolding.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — `initialize_market` suite (4 passing). The `smoke` suite may now fail because `ping` was removed; delete `tests/smoke.ts` in this step (`git rm tests/smoke.ts`).

- [ ] **Step 7: Commit**

```bash
git rm tests/smoke.ts
git add programs/proofbet/src/instructions/initialize_market.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/initialize.ts
git commit -m "feat: implement initialize_market with immutable predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `place_bet`

**Files:**
- Create: `programs/proofbet/src/instructions/place_bet.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/place_bet.ts`

- [ ] **Step 1: Write the failing test `tests/place_bet.ts`**

```ts
import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, sleep, balance,
  BN, Keypair, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

async function initMarket(fixtureId: number, marketId: number, closeTs: number) {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, marketId);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), marketId, goalsArgs({
      settleAuthority: creator.publicKey, threshold: 2, entryCloseTs: closeTs,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { creator, market, vault };
}

describe("place_bet", () => {
  it("accepts bets and accumulates totals + escrows lamports", async () => {
    const { market, vault } = await initMarket(2001, 0, nowSec() + 3600);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    const vaultBefore = await balance(vault);

    const amount = new BN(LAMPORTS_PER_SOL); // 1 SOL on OVER
    await program.methods
      .placeBet(0, amount)
      .accountsStrict({
        bettor: bettor.publicKey, market, vault, position,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettor]).rpc();

    // second bet on UNDER from same bettor (init_if_needed reuses the position)
    await program.methods
      .placeBet(1, new BN(LAMPORTS_PER_SOL / 2))
      .accountsStrict({
        bettor: bettor.publicKey, market, vault, position,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettor]).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.bucketTotals[0].toNumber(), LAMPORTS_PER_SOL);
    assert.equal(m.bucketTotals[1].toNumber(), LAMPORTS_PER_SOL / 2);
    assert.equal(m.totalPool.toNumber(), LAMPORTS_PER_SOL * 1.5);

    const p = await program.account.position.fetch(position);
    assert.ok(p.bettor.equals(bettor.publicKey));
    assert.equal(p.amounts[0].toNumber(), LAMPORTS_PER_SOL);
    assert.equal(p.amounts[1].toNumber(), LAMPORTS_PER_SOL / 2);

    const vaultAfter = await balance(vault);
    assert.equal(vaultAfter - vaultBefore, LAMPORTS_PER_SOL * 1.5);
  });

  it("rejects amount = 0", async () => {
    const { market, vault } = await initMarket(2002, 0, nowSec() + 3600);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    await expectError(
      program.methods.placeBet(0, new BN(0))
        .accountsStrict({
          bettor: bettor.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([bettor]).rpc(),
      "ZeroAmount",
    );
  });

  it("rejects an invalid bucket", async () => {
    const { market, vault } = await initMarket(2003, 0, nowSec() + 3600);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    await expectError(
      program.methods.placeBet(2, new BN(LAMPORTS_PER_SOL))
        .accountsStrict({
          bettor: bettor.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([bettor]).rpc(),
      "InvalidBucket",
    );
  });

  it("rejects bets at/after entry_close_ts", async () => {
    const { market, vault } = await initMarket(2004, 0, nowSec() + 2);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    await sleep(3500);
    await expectError(
      program.methods.placeBet(0, new BN(LAMPORTS_PER_SOL))
        .accountsStrict({
          bettor: bettor.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([bettor]).rpc(),
      "EntryClosed",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `placeBet` instruction does not exist.

- [ ] **Step 3: Write `programs/proofbet/src/instructions/place_bet.rs`**

```rust
use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ProofBetError;
use crate::events::BetPlaced;
use crate::state::*;

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBet>, bucket: u8, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        ProofBetError::MarketNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.market.entry_close_ts, ProofBetError::EntryClosed);
    require!((bucket as usize) < 2, ProofBetError::InvalidBucket);
    require!(amount > 0, ProofBetError::ZeroAmount);

    // Escrow lamports: bettor -> vault (bettor signs, system CPI).
    let cpi = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.bettor.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        },
    );
    system_program::transfer(cpi, amount)?;

    // Idempotent on re-bet: seeds bind the position to this bettor, so these
    // writes are always the same key/bump (reinit-safe).
    let bettor_key = ctx.accounts.bettor.key();
    let position = &mut ctx.accounts.position;
    position.bettor = bettor_key;
    position.bump = ctx.bumps.position;

    let idx = bucket as usize;
    position.amounts[idx] = position.amounts[idx]
        .checked_add(amount)
        .ok_or(ProofBetError::MathOverflow)?;

    let market = &mut ctx.accounts.market;
    market.bucket_totals[idx] = market.bucket_totals[idx]
        .checked_add(amount)
        .ok_or(ProofBetError::MathOverflow)?;
    market.total_pool = market.total_pool
        .checked_add(amount)
        .ok_or(ProofBetError::MathOverflow)?;

    emit!(BetPlaced {
        market: market.key(),
        bettor: bettor_key,
        bucket,
        amount,
        bucket_totals: market.bucket_totals,
        total_pool: market.total_pool,
    });
    Ok(())
}
```

- [ ] **Step 4: Wire it into `instructions/mod.rs`**

Append:

```rust
pub mod place_bet;
pub use place_bet::*;
```

- [ ] **Step 5: Add the dispatch in `lib.rs`** (inside `#[program] mod proofbet`)

```rust
    pub fn place_bet(ctx: Context<PlaceBet>, bucket: u8, amount: u64) -> Result<()> {
        instructions::place_bet::handler(ctx, bucket, amount)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — `place_bet` suite (4 passing) plus `initialize_market` (4 passing).

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/instructions/place_bet.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/place_bet.ts
git commit -m "feat: implement place_bet with lamport escrow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `settle`

**Files:**
- Create: `programs/proofbet/src/instructions/settle.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/settle.ts`

- [ ] **Step 1: Write the failing test `tests/settle.ts`**

```ts
import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, sleep, balance,
  BN, Keypair, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

async function setup(fixtureId: number, opts: {
  feeBps?: number; feeRecipient?: Keypair | null; closeInSec?: number;
} = {}) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  const closeTs = nowSec() + (opts.closeInSec ?? 2);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, goalsArgs({
      settleAuthority: settleAuth.publicKey,
      threshold: 2,
      entryCloseTs: closeTs,
      feeBps: opts.feeBps ?? 0,
      feeRecipient: opts.feeRecipient ? opts.feeRecipient.publicKey : null,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { creator, settleAuth, market, vault, feeRecipient: creator.publicKey };
}

async function bet(market: any, vault: any, bettor: any, bucket: number, lamports: number) {
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(bucket, new BN(lamports))
    .accountsStrict({
      bettor: bettor.publicKey, market, vault, position,
      systemProgram: SystemProgram.programId,
    })
    .signers([bettor]).rpc();
}

describe("settle", () => {
  it("settles to the winning bucket and records proof-binding", async () => {
    const { settleAuth, market, vault, feeRecipient } = await setup(3001);
    const a = await freshFunded(); const b = await freshFunded();
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(3500);

    await program.methods
      .settle(0, 951, new BN(1700000000000), 5)
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault, feeRecipient,
      })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { settled: {} });
    assert.equal(m.winningBucket, 0);
    assert.equal(m.settledSeq, 951);
    assert.equal(m.settledTs.toString(), "1700000000000");
    assert.equal(m.settledValue, 5);
    assert.equal(m.feeCollected.toNumber(), 0);
  });

  it("skims fee from the losing pool to fee_recipient", async () => {
    const feeKp = Keypair.generate();
    await (await import("./helpers")).airdrop(feeKp.publicKey, 1);
    const { settleAuth, market, vault } = await setup(3002, { feeBps: 100, feeRecipient: feeKp });
    const a = await freshFunded(); const b = await freshFunded();
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL); // winner pool
    await bet(market, vault, b, 1, 2 * LAMPORTS_PER_SOL); // loser pool
    await sleep(3500);

    const feeBefore = await balance(feeKp.publicKey);
    await program.methods
      .settle(0, 10, new BN(123), 4)
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault,
        feeRecipient: feeKp.publicKey,
      })
      .signers([settleAuth]).rpc();
    const feeAfter = await balance(feeKp.publicKey);

    const expectedFee = Math.floor((2 * LAMPORTS_PER_SOL * 100) / 10000); // 1% of loser pool
    assert.equal(feeAfter - feeBefore, expectedFee);
    const m = await program.account.market.fetch(market);
    assert.equal(m.feeCollected.toNumber(), expectedFee);
  });

  it("voids when the winning bucket has no stake", async () => {
    const { settleAuth, market, vault, feeRecipient } = await setup(3003);
    const a = await freshFunded();
    await bet(market, vault, a, 1, 2 * LAMPORTS_PER_SOL); // only UNDER has stake
    await sleep(3500);

    await program.methods
      .settle(0, 5, new BN(1), 1) // declare OVER the winner — but OVER has 0 stake
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault, feeRecipient,
      })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { voided: {} });
    assert.isNull(m.winningBucket);
  });

  it("rejects settle by a non-authority", async () => {
    const { market, vault, feeRecipient } = await setup(3004);
    const a = await freshFunded();
    await bet(market, vault, a, 0, LAMPORTS_PER_SOL);
    await sleep(3500);
    const imposter = await freshFunded();
    await expectError(
      program.methods.settle(0, 1, new BN(1), 1)
        .accountsStrict({
          settleAuthority: imposter.publicKey, market, vault, feeRecipient,
        })
        .signers([imposter]).rpc(),
      "Unauthorized",
    );
  });

  it("rejects settle before entry close", async () => {
    const { settleAuth, market, vault, feeRecipient } = await setup(3005, { closeInSec: 3600 });
    const a = await freshFunded();
    await bet(market, vault, a, 0, LAMPORTS_PER_SOL);
    await expectError(
      program.methods.settle(0, 1, new BN(1), 1)
        .accountsStrict({
          settleAuthority: settleAuth.publicKey, market, vault, feeRecipient,
        })
        .signers([settleAuth]).rpc(),
      "EntryNotClosed",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `settle` instruction does not exist.

- [ ] **Step 3: Write `programs/proofbet/src/instructions/settle.rs`**

```rust
use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::{MarketSettled, MarketVoided};
use crate::state::*;

#[derive(Accounts)]
pub struct Settle<'info> {
    pub settle_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: receives the fee via direct lamport credit; pinned to market.fee_recipient.
    #[account(mut, address = market.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<Settle>,
    winning_bucket: u8,
    settled_seq: u32,
    settled_ts: i64,
    settled_value: i32,
) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        ProofBetError::MarketNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.market.entry_close_ts, ProofBetError::EntryNotClosed);
    require!((winning_bucket as usize) < 2, ProofBetError::InvalidBucket);

    let total_pool = ctx.accounts.market.total_pool;
    let winner_total = ctx.accounts.market.bucket_totals[winning_bucket as usize];
    let fee_bps = ctx.accounts.market.fee_bps;
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_id = ctx.accounts.market.market_id;

    // Zero-winner -> void (full refunds, no fee).
    if winner_total == 0 {
        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Voided;
        market.settled_seq = settled_seq;
        market.settled_ts = settled_ts;
        market.settled_value = settled_value;
        emit!(MarketVoided { market: market.key(), fixture_id, market_id, settled_seq, settled_ts });
        return Ok(());
    }

    let loser_total = total_pool
        .checked_sub(winner_total)
        .ok_or(ProofBetError::MathOverflow)?;
    let fee: u64 = (loser_total as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ProofBetError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ProofBetError::MathOverflow)? as u64;

    if fee > 0 {
        let vault_ai = ctx.accounts.vault.to_account_info();
        let recipient_ai = ctx.accounts.fee_recipient.to_account_info();
        let vault_lamports = vault_ai.lamports();
        **vault_ai.try_borrow_mut_lamports()? = vault_lamports
            .checked_sub(fee)
            .ok_or(ProofBetError::MathOverflow)?;
        let recipient_lamports = recipient_ai.lamports();
        **recipient_ai.try_borrow_mut_lamports()? = recipient_lamports
            .checked_add(fee)
            .ok_or(ProofBetError::MathOverflow)?;
    }

    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Settled;
    market.winning_bucket = Some(winning_bucket);
    market.fee_collected = fee;
    market.settled_seq = settled_seq;
    market.settled_ts = settled_ts;
    market.settled_value = settled_value;

    emit!(MarketSettled {
        market: market.key(),
        fixture_id,
        market_id,
        winning_bucket,
        stat_key: market.stat_key,
        stat_key2: market.stat_key2,
        op: market.op,
        comparison: market.comparison,
        threshold: market.threshold,
        settled_seq,
        settled_ts,
        settled_value,
        fee_collected: fee,
    });
    Ok(())
}
```

- [ ] **Step 4: Wire it into `instructions/mod.rs`**

Append:

```rust
pub mod settle;
pub use settle::*;
```

- [ ] **Step 5: Add the dispatch in `lib.rs`** (inside `#[program] mod proofbet`)

```rust
    pub fn settle(
        ctx: Context<Settle>,
        winning_bucket: u8,
        settled_seq: u32,
        settled_ts: i64,
        settled_value: i32,
    ) -> Result<()> {
        instructions::settle::handler(ctx, winning_bucket, settled_seq, settled_ts, settled_value)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — `settle` suite (5 passing) plus all prior suites.

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/instructions/settle.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/settle.ts
git commit -m "feat: implement settle with fee skim and zero-winner void

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `void_market`

**Files:**
- Create: `programs/proofbet/src/instructions/void_market.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/void.ts`

- [ ] **Step 1: Write the failing test `tests/void.ts`**

```ts
import {
  program, marketPda, vaultPda, freshFunded, goalsArgs,
  expectError, nowSec, BN, Keypair, SystemProgram, assert,
} from "./helpers";

async function setup(fixtureId: number) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, goalsArgs({
      settleAuthority: settleAuth.publicKey, threshold: 2, entryCloseTs: nowSec() + 3600,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { settleAuth, market, vault };
}

describe("void_market", () => {
  it("voids an open market and records proof-binding (no time gate)", async () => {
    const { settleAuth, market } = await setup(4001);
    await program.methods
      .voidMarket(15, new BN(1700000000000))
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { voided: {} });
    assert.equal(m.settledSeq, 15);
    assert.equal(m.settledTs.toString(), "1700000000000");
  });

  it("rejects void by a non-authority", async () => {
    const { market } = await setup(4002);
    const imposter = await freshFunded();
    await expectError(
      program.methods.voidMarket(1, new BN(1))
        .accountsStrict({ settleAuthority: imposter.publicKey, market })
        .signers([imposter]).rpc(),
      "Unauthorized",
    );
  });

  it("rejects voiding a market that is not open", async () => {
    const { settleAuth, market } = await setup(4003);
    await program.methods.voidMarket(1, new BN(1))
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
      .signers([settleAuth]).rpc();
    // second void should fail — already Voided
    await expectError(
      program.methods.voidMarket(2, new BN(2))
        .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
        .signers([settleAuth]).rpc(),
      "MarketNotOpen",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `voidMarket` instruction does not exist.

- [ ] **Step 3: Write `programs/proofbet/src/instructions/void_market.rs`**

```rust
use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::MarketVoided;
use crate::state::*;

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub settle_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<VoidMarket>, settled_seq: u32, settled_ts: i64) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        ProofBetError::MarketNotOpen
    );
    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Voided;
    market.settled_seq = settled_seq;
    market.settled_ts = settled_ts;

    emit!(MarketVoided {
        market: market.key(),
        fixture_id: market.fixture_id,
        market_id: market.market_id,
        settled_seq,
        settled_ts,
    });
    Ok(())
}
```

- [ ] **Step 4: Wire it into `instructions/mod.rs`**

Append:

```rust
pub mod void_market;
pub use void_market::*;
```

- [ ] **Step 5: Add the dispatch in `lib.rs`** (inside `#[program] mod proofbet`)

```rust
    pub fn void_market(ctx: Context<VoidMarket>, settled_seq: u32, settled_ts: i64) -> Result<()> {
        instructions::void_market::handler(ctx, settled_seq, settled_ts)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — `void_market` suite (3 passing) plus all prior suites.

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/instructions/void_market.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/void.ts
git commit -m "feat: implement void_market for abandoned/cancelled fixtures

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `claim`

**Files:**
- Create: `programs/proofbet/src/instructions/claim.rs`
- Modify: `programs/proofbet/src/instructions/mod.rs`
- Modify: `programs/proofbet/src/lib.rs`
- Create: `tests/claim.ts`

- [ ] **Step 1: Write the failing test `tests/claim.ts`**

```ts
import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, sleep, balance,
  BN, Keypair, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

async function setup(fixtureId: number, closeInSec = 2) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, goalsArgs({
      settleAuthority: settleAuth.publicKey, threshold: 2, entryCloseTs: nowSec() + closeInSec,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { creator, settleAuth, market, vault, feeRecipient: creator.publicKey };
}

async function bet(market: any, vault: any, bettor: any, bucket: number, lamports: number) {
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(bucket, new BN(lamports))
    .accountsStrict({
      bettor: bettor.publicKey, market, vault, position,
      systemProgram: SystemProgram.programId,
    })
    .signers([bettor]).rpc();
}

function claim(market: any, vault: any, bettor: any) {
  const position = positionPda(market, bettor.publicKey);
  return program.methods.claim()
    .accountsStrict({
      bettor: bettor.publicKey, market, vault, position,
      systemProgram: SystemProgram.programId,
    })
    .signers([bettor]).rpc();
}

describe("claim", () => {
  it("pays a winner pro-rata (principal-safe) via vault debit", async () => {
    const { settleAuth, market, vault, feeRecipient } = await setup(5001);
    const a = await freshFunded(); const b = await freshFunded();
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL); // OVER (winner)
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL); // UNDER (loser)
    await sleep(3500);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();

    const vaultBefore = await balance(vault);
    await claim(market, vault, a);
    const vaultAfter = await balance(vault);

    // distributable = total(4) - fee(0) = 4; payout = stake(3) * 4 / winner_total(3) = 4 SOL
    const payout = vaultBefore - vaultAfter;
    assert.equal(payout, 4 * LAMPORTS_PER_SOL);
    assert.isAtLeast(payout, 3 * LAMPORTS_PER_SOL); // principal-safe

    // position is closed
    await expectError(program.account.position.fetch(positionPda(market, a.publicKey)), "Account does not exist");
  });

  it("lets a loser claim 0 and still closes the position (reclaims rent)", async () => {
    const { settleAuth, market, vault, feeRecipient } = await setup(5002);
    const a = await freshFunded(); const b = await freshFunded();
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(3500);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();

    const vaultBefore = await balance(vault);
    await claim(market, vault, b); // loser
    const vaultAfter = await balance(vault);
    assert.equal(vaultBefore - vaultAfter, 0); // no payout from vault
    await expectError(program.account.position.fetch(positionPda(market, b.publicKey)), "Account does not exist");
  });

  it("refunds principal on a voided market", async () => {
    const { settleAuth, market, vault } = await setup(5003);
    const a = await freshFunded();
    await bet(market, vault, a, 0, 1 * LAMPORTS_PER_SOL);
    await bet(market, vault, a, 1, 1 * LAMPORTS_PER_SOL); // same bettor, both buckets
    await program.methods.voidMarket(1, new BN(1))
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
      .signers([settleAuth]).rpc();

    const vaultBefore = await balance(vault);
    await claim(market, vault, a);
    const vaultAfter = await balance(vault);
    assert.equal(vaultBefore - vaultAfter, 2 * LAMPORTS_PER_SOL); // full refund
  });

  it("rejects a double claim", async () => {
    const { settleAuth, market, vault, feeRecipient } = await setup(5004);
    const a = await freshFunded(); const b = await freshFunded();
    await bet(market, vault, a, 0, 2 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(3500);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();
    await claim(market, vault, a);
    await expectError(claim(market, vault, a), "AccountNotInitialized");
  });

  it("rejects a claim before settle", async () => {
    const { market, vault } = await setup(5005, 3600);
    const a = await freshFunded();
    await bet(market, vault, a, 0, LAMPORTS_PER_SOL);
    await expectError(claim(market, vault, a), "NotClaimable");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `anchor test`
Expected: FAIL — `claim` instruction does not exist.

- [ ] **Step 3: Write `programs/proofbet/src/instructions/claim.rs`**

```rust
use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::Claimed;
use crate::state::*;

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump = position.bump,
        has_one = bettor @ ProofBetError::Unauthorized,
        close = bettor,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let status = ctx.accounts.market.status;
    require!(
        status == MarketStatus::Settled || status == MarketStatus::Voided,
        ProofBetError::NotClaimable
    );

    let amounts = ctx.accounts.position.amounts;
    let payout: u64 = match status {
        MarketStatus::Voided => amounts[0]
            .checked_add(amounts[1])
            .ok_or(ProofBetError::MathOverflow)?,
        MarketStatus::Settled => {
            let wb = ctx.accounts.market.winning_bucket.unwrap() as usize;
            let stake = amounts[wb];
            if stake == 0 {
                0
            } else {
                let winner_total = ctx.accounts.market.bucket_totals[wb];
                let distributable = ctx.accounts.market.total_pool
                    .checked_sub(ctx.accounts.market.fee_collected)
                    .ok_or(ProofBetError::MathOverflow)?;
                ((stake as u128)
                    .checked_mul(distributable as u128)
                    .ok_or(ProofBetError::MathOverflow)?
                    .checked_div(winner_total as u128)
                    .ok_or(ProofBetError::MathOverflow)?) as u64
            }
        }
        MarketStatus::Open => return err!(ProofBetError::NotClaimable),
    };

    if payout > 0 {
        let vault_ai = ctx.accounts.vault.to_account_info();
        let bettor_ai = ctx.accounts.bettor.to_account_info();
        let vault_lamports = vault_ai.lamports();
        **vault_ai.try_borrow_mut_lamports()? = vault_lamports
            .checked_sub(payout)
            .ok_or(ProofBetError::MathOverflow)?;
        let bettor_lamports = bettor_ai.lamports();
        **bettor_ai.try_borrow_mut_lamports()? = bettor_lamports
            .checked_add(payout)
            .ok_or(ProofBetError::MathOverflow)?;
    }

    emit!(Claimed {
        market: ctx.accounts.market.key(),
        bettor: ctx.accounts.bettor.key(),
        payout,
        voided: status == MarketStatus::Voided,
    });
    Ok(())
}
```

- [ ] **Step 4: Wire it into `instructions/mod.rs`**

Append:

```rust
pub mod claim;
pub use claim::*;
```

- [ ] **Step 5: Add the dispatch in `lib.rs`** (inside `#[program] mod proofbet`)

```rust
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `anchor test`
Expected: PASS — `claim` suite (5 passing) plus all prior suites.

- [ ] **Step 7: Commit**

```bash
git add programs/proofbet/src/instructions/claim.rs programs/proofbet/src/instructions/mod.rs programs/proofbet/src/lib.rs tests/claim.ts
git commit -m "feat: implement claim with pro-rata payout and refund

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: End-to-end conservation invariant

A test-only task (no program changes) that exercises the full lifecycle with multiple bettors and a non-zero fee, asserting the conservation invariant from the spec: `Σ payout + fee + dust == total_pool`, `0 ≤ dust < winner_count`, each winner is principal-safe, and the vault ends at exactly `rent_floor + dust`.

**Files:**
- Create: `tests/conservation.ts`

- [ ] **Step 1: Write `tests/conservation.ts`**

```ts
import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  nowSec, sleep, balance,
  BN, Keypair, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

describe("conservation invariant", () => {
  it("Σpayout + fee + dust == total_pool, dust < winner_count, winners principal-safe", async () => {
    const fixtureId = 6001;
    const creator = await freshFunded();
    const settleAuth = await freshFunded();
    const feeKp = Keypair.generate();
    await (await import("./helpers")).airdrop(feeKp.publicKey, 1);

    const market = marketPda(fixtureId, 0);
    const vault = vaultPda(market);
    const feeBps = 100; // 1% of the losing pool

    await program.methods
      .initializeMarket(new BN(fixtureId), 0, goalsArgs({
        settleAuthority: settleAuth.publicKey,
        threshold: 2,
        entryCloseTs: nowSec() + 3,
        feeBps,
        feeRecipient: feeKp.publicKey,
      }))
      .accountsStrict({
        creator: creator.publicKey, market, vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator]).rpc();

    // rent floor = vault balance right after init (before any bets)
    const rentFloor = BigInt(await balance(vault));

    // Amounts chosen so the pro-rata division leaves dust.
    const stakes = [
      { kp: await freshFunded(), bucket: 0, lamports: 1_000_000_000n }, // OVER winner
      { kp: await freshFunded(), bucket: 0, lamports: 300_000_000n },   // OVER winner
      { kp: await freshFunded(), bucket: 1, lamports: 2_000_000_000n }, // UNDER loser
    ];
    for (const s of stakes) {
      const position = positionPda(market, s.kp.publicKey);
      await program.methods.placeBet(s.bucket, new BN(s.lamports.toString()))
        .accountsStrict({
          bettor: s.kp.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([s.kp]).rpc();
    }

    const totalPool = stakes.reduce((acc, s) => acc + s.lamports, 0n);
    const winners = stakes.filter((s) => s.bucket === 0);
    const winnerTotal = winners.reduce((acc, s) => acc + s.lamports, 0n);
    const loserTotal = totalPool - winnerTotal;
    const fee = (loserTotal * BigInt(feeBps)) / 10_000n;
    const distributable = totalPool - fee;

    await sleep(4000);
    const feeBefore = BigInt(await balance(feeKp.publicKey));
    await program.methods.settle(0, 99, new BN(1700000000000), 7)
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault,
        feeRecipient: feeKp.publicKey,
      })
      .signers([settleAuth]).rpc();
    const feeAfter = BigInt(await balance(feeKp.publicKey));
    assert.equal((feeAfter - feeBefore).toString(), fee.toString(), "fee recipient credited exactly the fee");

    // Each participant claims; sum the vault debits.
    let totalPaid = 0n;
    for (const s of stakes) {
      const position = positionPda(market, s.kp.publicKey);
      const vaultBefore = BigInt(await balance(vault));
      await program.methods.claim()
        .accountsStrict({
          bettor: s.kp.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([s.kp]).rpc();
      const vaultAfter = BigInt(await balance(vault));
      const paid = vaultBefore - vaultAfter;
      totalPaid += paid;

      if (s.bucket === 0) {
        const expected = (s.lamports * distributable) / winnerTotal;
        assert.equal(paid.toString(), expected.toString(), "winner paid exact pro-rata share");
        assert.isTrue(paid >= s.lamports, "winner is principal-safe");
      } else {
        assert.equal(paid.toString(), "0", "loser receives nothing from the vault");
      }
    }

    const dust = distributable - totalPaid;
    assert.isTrue(dust >= 0n, "dust is non-negative");
    assert.isTrue(dust < BigInt(winners.length), "dust < winner_count");
    // Conservation: every lamport accounted for.
    assert.equal((totalPaid + fee + dust).toString(), totalPool.toString(), "conservation holds");
    // Vault ends at exactly rent_floor + dust.
    const vaultEnd = BigInt(await balance(vault));
    assert.equal(vaultEnd.toString(), (rentFloor + dust).toString(), "vault ends at rent_floor + dust");
  });
});
```

- [ ] **Step 2: Run the full suite**

Run: `anchor test`
Expected: PASS — `conservation invariant` (1 passing) plus all prior suites. Total green.

- [ ] **Step 3: Commit**

```bash
git add tests/conservation.ts
git commit -m "test: assert end-to-end parimutuel conservation invariant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Settlement keeper

The keeper reuses the spike's proven validate path (`createContext`/`authenticate`/`getScoreHistory`/`resolvePhase`/`fetchStatValidation`/`buildBaseArgs`/`viewValidate`) to compute a market's winning bucket from TxLINE + Txoracle on devnet, then submits `settle` (or `void_market`) to the proofbet program.

It is a self-contained ESM module pinned to the **same Anchor version as the spike (`^0.30.1`)** so the spike imports and the proofbet `Program` share one Anchor instance in-process. The 0.31-generated IDL loads fine under the 0.30.1 runtime (same IDL spec 0.1.0). The proofbet `Program` is typed loosely (`anchor.Program`) so the keeper does not depend on `target/types`.

**Three modes:**
- `--compute-only` — compute the bucket purely from TxLINE + Txoracle for explicit predicate flags; no proofbet program or market needed. **This is the independently-runnable verification** (it reproduces the spike's result).
- `<marketPubkey> --dry-run` — fetch the on-chain market, find its final event, compute the bucket, print the settle call it *would* send. Needs proofbet deployed + a market created on devnet.
- `<marketPubkey>` — same, then actually send `settle`/`void_market`.

> **Honest scope note:** only `--compute-only` is runnable without a devnet deploy + a created market. The full settle path is validated by structural review + `npm run typecheck` here; its live exercise happens in the demo (deploy → create market → run keeper), documented in Step 6.

**Files:**
- Create: `keeper/package.json`, `keeper/tsconfig.json`, `keeper/.env.example`, `keeper/settle.ts`

- [ ] **Step 1: Write `keeper/package.json`**

```json
{
  "name": "proofbet-keeper",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Settlement keeper: derive a market's winning bucket from TxLINE Merkle proofs and submit settle.",
  "scripts": {
    "keep": "tsx settle.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.30.1",
    "@solana/web3.js": "^1.95.3",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4"
  }
}
```

- [ ] **Step 2: Write `keeper/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"],
    "allowImportingTsExtensions": false
  },
  "include": ["settle.ts"]
}
```

- [ ] **Step 3: Write `keeper/.env.example`**

```
# Keeper config (copy to .env; .env is gitignored). Reuses the spike's TxLINE auth.
RPC_URL=https://api.devnet.solana.com
WALLET_SECRET_KEY=/Users/yordanlasonov/.config/solana/id.json
TXLINE_BASE_URL=https://txline-dev.txodds.com
TXLINE_AUTH_BASE_URL=
SERVICE_LEVEL_ID=1
DURATION_WEEKS=4

# Path to the proofbet IDL produced by `anchor build` (relative to keeper/).
PROOFBET_IDL=../target/idl/proofbet.json
```

- [ ] **Step 4: Write `keeper/settle.ts`**

```ts
/**
 * ProofBet settlement keeper.
 *
 * Reuses the spike's validate path (TxLINE three-stage Merkle proof ->
 * Txoracle.validateStat .view()) to derive a market's winning bucket, then
 * submits `settle` (or `void_market` for abandoned fixtures) to proofbet.
 *
 * Modes:
 *   tsx settle.ts --compute-only --fixture <id> --seq <n> --stat <k> \
 *        [--stat2 <k>] [--op add|subtract] --threshold <t> [--cmp greaterThan|lessThan|equalTo]
 *   tsx settle.ts <marketPubkey> [--dry-run]
 */

import { readFileSync } from "node:fs";
import * as anchor from "@coral-xyz/anchor";
import anchorDefault from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

import { createContext, authenticate } from "../spike/src/auth.js";
import { getScoreHistory, resolvePhase } from "../spike/src/discover.js";
import {
  fetchStatValidation, buildBaseArgs, viewValidate, dailyScoresPda,
  type BinaryOp, type Comparison,
} from "../spike/src/validate.js";
import { FINISHED_PHASES, VOID_PHASES, PHASE_NAME } from "../spike/src/config.js";

const BN = anchorDefault.BN;

interface Flags { [k: string]: string | boolean; }

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const opFromFlag = (s?: string): BinaryOp | null =>
  s === "add" || s === "subtract" ? s : null;
const opFromAnchor = (o: { add?: object; subtract?: object } | null): BinaryOp | null =>
  o == null ? null : "add" in o ? "add" : "subtract";
const cmpFromFlag = (s?: string): Comparison =>
  s === "lessThan" || s === "equalTo" ? s : "greaterThan";

/** Anchor enum {greaterThan:{}} -> spike's {greaterThan:{}} (identical wire form). */
type PredObj = { threshold: number; comparison: { [k: string]: object } };

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const ctx = createContext();
  const auth = await authenticate(ctx);

  // ── compute-only: reproduce the spike's result for explicit predicate flags ──
  if (flags["compute-only"]) {
    const fixtureId = Number(flags.fixture);
    const seq = Number(flags.seq);
    const statKey = Number(flags.stat);
    const statKey2 = flags.stat2 != null ? Number(flags.stat2) : undefined;
    const op = opFromFlag(flags.op as string | undefined);
    const threshold = Number(flags.threshold);
    const comparison = cmpFromFlag(flags.cmp as string | undefined);

    const v = await fetchStatValidation(ctx, auth, { fixtureId, seq, statKey, statKey2 });
    const base = buildBaseArgs(v, ctx.program.programId, op);
    const pred: PredObj = { threshold, comparison: { [comparison]: {} } };
    const truthy = await viewValidate(ctx.program, base, pred, op);
    const bucket = truthy ? 0 : 1; // OVER=0 (TRUE), UNDER=1 (FALSE)
    console.log(JSON.stringify({
      mode: "compute-only", fixtureId, seq, statKey, statKey2, op, threshold, comparison,
      lhs: base.lhs, predicateTrue: truthy, winningBucket: bucket,
      settledTs: v.summary.updateStats.minTimestamp,
      dailyScoresPda: dailyScoresPda(ctx.program.programId, v.summary.updateStats.minTimestamp).toBase58(),
    }, null, 2));
    return;
  }

  // ── market mode: fetch the on-chain market and settle it ──
  if (positional.length === 0) {
    throw new Error("usage: settle.ts <marketPubkey> [--dry-run]  |  settle.ts --compute-only ...");
  }
  const marketKey = new PublicKey(positional[0]);
  const dryRun = !!flags["dry-run"];

  const idlPath = (process.env.PROOFBET_IDL ?? "../target/idl/proofbet.json");
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const proofbet = new anchor.Program(idl, ctx.provider);
  const market: any = await proofbet.account.market.fetch(marketKey);

  if (!market.settleAuthority.equals(ctx.wallet.publicKey)) {
    console.warn(`WARNING: wallet ${ctx.wallet.publicKey.toBase58()} is not the settle_authority ` +
      `(${market.settleAuthority.toBase58()}); the transaction will fail unless you control that key.`);
  }

  const fixtureId = market.fixtureId.toNumber();
  const statKey = market.statKey as number;
  const statKey2 = market.statKey2 == null ? undefined : (market.statKey2 as number);
  const op = opFromAnchor(market.op);

  // Find the fixture's terminal event.
  const events = await getScoreHistory(ctx, auth, fixtureId);
  const withPhase = events.map((ev) => ({ ev, ...resolvePhase(ev) }));
  const finished = withPhase
    .filter((e) => e.code !== null && FINISHED_PHASES.has(e.code))
    .sort((a, b) => b.ev.Seq - a.ev.Seq)[0];
  const voided = withPhase
    .filter((e) => e.code !== null && VOID_PHASES.has(e.code))
    .sort((a, b) => b.ev.Seq - a.ev.Seq)[0];

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketKey.toBuffer()], proofbet.programId);

  if (!finished && voided) {
    const seq = voided.ev.Seq;
    const ts = Number(voided.ev.Ts ?? 0);
    console.log(JSON.stringify({ action: "void_market", fixtureId, seq, ts, phase: voided.label }, null, 2));
    if (dryRun) return;
    const sig = await proofbet.methods.voidMarket(seq, new BN(ts))
      .accountsStrict({ settleAuthority: ctx.wallet.publicKey, market: marketKey })
      .rpc();
    console.log(`voided: ${sig}`);
    return;
  }

  if (!finished) {
    console.log(JSON.stringify({ action: "none", reason: "fixture not final yet", fixtureId }, null, 2));
    return;
  }

  const seq = finished.ev.Seq;
  const v = await fetchStatValidation(ctx, auth, { fixtureId, seq, statKey, statKey2 });
  const base = buildBaseArgs(v, ctx.program.programId, op);
  const pred: PredObj = { threshold: market.threshold as number, comparison: market.comparison };
  const truthy = await viewValidate(ctx.program, base, pred, op);
  const winningBucket = truthy ? 0 : 1;
  const settledTs = v.summary.updateStats.minTimestamp; // ms (matches on-chain settled_ts unit)
  const settledValue = base.lhs;

  console.log(JSON.stringify({
    action: "settle", fixtureId, seq, statKey, statKey2, op,
    threshold: market.threshold, lhs: base.lhs, predicateTrue: truthy,
    winningBucket, settledTs, settledValue,
    dailyScoresPda: dailyScoresPda(ctx.program.programId, settledTs).toBase58(),
  }, null, 2));
  if (dryRun) return;

  const sig = await proofbet.methods
    .settle(winningBucket, seq, new BN(settledTs), settledValue)
    .accountsStrict({
      settleAuthority: ctx.wallet.publicKey,
      market: marketKey,
      vault: vaultPda,
      feeRecipient: market.feeRecipient,
    })
    .rpc();
  console.log(`settled: ${sig}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 5: Install + typecheck**

Run: `cd keeper && npm install && npm run typecheck && cd ..`
Expected: installs; `tsc --noEmit` passes (confirms the spike imports resolve and the keeper compiles).

> If `tsc` flags the `new anchor.Program(idl, ctx.provider)` 2-arg call under 0.30 types, cast the IDL: `new anchor.Program(idl as anchor.Idl, ctx.provider)`. If it flags `ctx.program.programId` typing, it is already correct from the spike — no change needed.

- [ ] **Step 6: Verify the compute-only path reproduces the spike (the real test)**

Run (uses the spike's proven Colombia-vs-Congo combined-corners case; substitute the live fixture/seq the spike last used if it differs):

```bash
cd keeper && npm run keep -- --compute-only \
  --fixture <FIXTURE_ID> --seq <SEQ> --stat 7 --stat2 8 --op add \
  --threshold <LINE> --cmp greaterThan ; cd ..
```

Expected: JSON with `predicateTrue` and `winningBucket` matching the spike's directional result (a threshold below the true combined-corners total → `predicateTrue: true, winningBucket: 0`; a threshold above → `false, 1`).

Document the full live settle procedure (not run automatically) in the commit message / a short `keeper/README.md` is optional — the canonical sequence is:
1. `anchor build && anchor deploy --provider.cluster devnet`
2. create a market with `settle_authority = keeper wallet` (a short TS snippet or `anchor run`),
3. `cd keeper && npm run keep -- <marketPubkey> --dry-run` then without `--dry-run`.

- [ ] **Step 7: Commit**

```bash
git add keeper/package.json keeper/package-lock.json keeper/tsconfig.json keeper/.env.example keeper/settle.ts
git commit -m "feat: add settlement keeper reusing spike validate path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Spec coverage map

| Spec section | Covered by |
|---|---|
| §4 `Market` account | Task 2 (struct), Task 4 (init) |
| §4 `Vault` PDA (program-owned, rent floor) | Task 2, Task 4 (init), Task 5 (deposit), Task 6/8 (debit) |
| §4 `Position` (closed on claim) | Task 2, Task 5 (init_if_needed), Task 8 (`close = bettor`) |
| §4 enums + bucket consts | Task 2 |
| §5.1 `initialize_market` (+validations) | Task 4 |
| §5.2 `place_bet` (+guards, escrow) | Task 5 |
| §5.3 `settle` (+fee, zero-winner void, proof-binding) | Task 6 |
| §5.4 `void_market` | Task 7 |
| §5.5 `claim` (settled winner/loser, void refund) | Task 8 |
| §6 parimutuel math + conservation invariant | Task 8 (impl), Task 9 (asserted) |
| §6 principal-safe / no-push / checked+u128 | Task 6/8 (impl), Task 9 (assert principal-safe) |
| §7 keeper | Task 10 |
| §8 testing (happy, zero-winner, void, fee, rejections) | Tasks 4–9 |
| §10 markets shipped (goals/corners two-stat Add) | Task 3 `goalsArgs` helper; corners = same shape with statKey 7/8 |
| §11 security checklist | Tasks 2/4/6/8 (immutable terms, gated settle/void, close-position, checked math) |

## Definition of done

- `anchor test` is fully green (all suites: initialize, place_bet, settle, void, claim, conservation).
- `npm run typecheck` (root) and `keeper` typecheck both pass.
- The conservation invariant test (Task 9) passes, proving no lamport leakage.
- The keeper `--compute-only` run (Task 10, Step 6) reproduces the spike's directional result.
- Every task committed with the `Co-Authored-By` trailer; no secrets staged (`.env`, `.spike-auth.json`, keypairs remain gitignored).

## Notes for the implementer

- **Anchor 0.31 `ctx.bumps`** are named fields: `ctx.bumps.market`, `ctx.bumps.vault`, `ctx.bumps.position`.
- **Direct lamport math** on a program-owned account (`Vault`) is via `**ai.try_borrow_mut_lamports()? = ...`. Crediting any account (e.g. `fee_recipient`, `bettor`) needs no ownership; debiting requires the program to own the account (`Vault` does). The vault never drops below its rent floor because `Σpayout ≤ distributable` and `fee ≤ loser_total`.
- **Borrow discipline:** in `settle`/`claim`, read all needed scalars from `ctx.accounts.market` first, perform the lamport transfers, *then* take `&mut ctx.accounts.market` for status writes — avoids holding a `&mut` across the vault `AccountInfo` borrow.
- **Time in tests:** settle/claim require `now >= entry_close_ts`. Tests set `entry_close_ts = now + 2s` and `sleep(3500)`. Localnet `Clock::unix_timestamp` tracks wall time closely; keep the buffer.
- **`init_if_needed`** requires the `init-if-needed` feature on `anchor-lang` (set in Task 1 Cargo.toml). The `Position` seed binds to `bettor`, so re-bets are reinit-safe.
- **Unit reminder:** `entry_close_ts` is unix **seconds**; `settled_ts` is the batch **milliseconds** timestamp (daily-scores PDA derivation). Do not mix them.
