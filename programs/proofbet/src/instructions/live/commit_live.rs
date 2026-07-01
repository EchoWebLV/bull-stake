use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::errors::ProofBetError;
use crate::live_state::*;

/// Context for committing (and optionally undelegating) the pool's delegated live
/// accounts back to the base layer. `#[commit]` injects `magic_context` +
/// `magic_program`. The accounts to commit/undelegate are passed as
/// `remaining_accounts` (cursor + entries + calls, batched to fit a tx) — never
/// `LivePool`, which is not delegated. `pool` here is read-only, for keeper auth.
#[commit]
#[derive(Accounts)]
pub struct CommitLive<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
        constraint = pool.settle_authority == keeper.key() @ ProofBetError::Unauthorized,
    )]
    pub pool: Account<'info, LivePool>,
}

/// Mid-match checkpoint: commit the current ER state of the passed accounts to the
/// base layer WITHOUT undelegating — the match keeps running on the ER. Called after
/// each `resolve_call` (plus the time-based `commit_frequency_ms` cadence).
pub fn commit_live_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CommitLive<'info>>,
) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.keeper.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(ctx.remaining_accounts)
    .build_and_invoke()?;
    Ok(())
}

/// Full-time: final commit + return ownership of the passed accounts to the program.
/// The base-layer `end_live_pool` then flips status to Ended and `settle_live_pool`
/// recomputes the winner (on-chain argmax) against the committed scores.
pub fn end_and_undelegate_handler<'info>(
    ctx: Context<'_, '_, '_, 'info, CommitLive<'info>>,
) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.keeper.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(ctx.remaining_accounts)
    .build_and_invoke()?;
    Ok(())
}
