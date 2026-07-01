use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::errors::ProofBetError;
use crate::live_state::*;

/// Fixed ER commit cadence (ms). NEVER `u32::MAX` (the SDK default = no time-based
/// commit, a documented footgun) — with this set, a crashed ER loses at most one
/// window, itself re-derivable from the committed `Call.outcome`.
pub const COMMIT_FREQUENCY_MS: u32 = 5_000;

/// Shared context for delegating one of a pool's live PDAs (cursor / entry / call)
/// to the Ephemeral Rollup. `LivePool` is READ here (authority + the >=2-seat gate)
/// and is NEVER delegated — the pot stays program-owned on the base layer for the
/// entire match, so `void_live_pool` can always refund on the base layer. The
/// `#[delegate]` macro injects the delegation-CPI plumbing accounts.
#[delegate]
#[derive(Accounts)]
pub struct DelegateLiveAccount<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
        constraint = pool.settle_authority == keeper.key() @ ProofBetError::Unauthorized,
    )]
    pub pool: Account<'info, LivePool>,
    /// CHECK: the LiveCursor / LiveEntry / Call PDA to delegate. Its identity is
    /// enforced by the seeds passed to `delegate_pda` — a wrong account fails to
    /// re-derive. `del` wires the `#[delegate]` macro's delegation CPI.
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
}

fn cfg(validator: Option<Pubkey>) -> DelegateConfig {
    DelegateConfig { commit_frequency_ms: COMMIT_FREQUENCY_MS, validator }
}

/// Every delegation is gated on `player_count >= 2`: a pool that never reaches two
/// seats is voided-and-refunded on the base layer before kickoff, never delegated
/// (resolves the lone-player confiscation risk — the pot never leaves the base layer).
fn gate(pool: &LivePool) -> Result<()> {
    require!(pool.player_count >= 2, ProofBetError::NotEnoughToDelegate);
    Ok(())
}

/// Optional pinned validator, supplied as the first remaining account.
fn validator_of(ctx: &Context<DelegateLiveAccount>) -> Option<Pubkey> {
    ctx.remaining_accounts.first().map(|a| a.key())
}

pub fn delegate_cursor_handler(ctx: Context<DelegateLiveAccount>) -> Result<()> {
    gate(&ctx.accounts.pool)?;
    let pool_key = ctx.accounts.pool.key();
    let validator = validator_of(&ctx);
    ctx.accounts
        .delegate_pda(&ctx.accounts.keeper, &[&b"livecursor"[..], pool_key.as_ref()], cfg(validator))?;
    Ok(())
}

pub fn delegate_entry_handler(ctx: Context<DelegateLiveAccount>, player: Pubkey) -> Result<()> {
    gate(&ctx.accounts.pool)?;
    let pool_key = ctx.accounts.pool.key();
    let validator = validator_of(&ctx);
    ctx.accounts.delegate_pda(
        &ctx.accounts.keeper,
        &[&b"liveentry"[..], pool_key.as_ref(), player.as_ref()],
        cfg(validator),
    )?;
    Ok(())
}

pub fn delegate_call_handler(ctx: Context<DelegateLiveAccount>, seq: u32) -> Result<()> {
    gate(&ctx.accounts.pool)?;
    let pool_key = ctx.accounts.pool.key();
    let seq_bytes = seq.to_le_bytes();
    let validator = validator_of(&ctx);
    ctx.accounts.delegate_pda(
        &ctx.accounts.keeper,
        &[&b"call"[..], pool_key.as_ref(), seq_bytes.as_ref()],
        cfg(validator),
    )?;
    Ok(())
}
