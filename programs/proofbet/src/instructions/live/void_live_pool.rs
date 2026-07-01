use anchor_lang::prelude::*;

use crate::contest_state::VOID_GRACE_SECS;
use crate::errors::ProofBetError;
use crate::events::LivePoolVoided;
use crate::live_state::*;

/// Void a non-terminal pool → refund path (claim_live_pool's Voided branch pays
/// each seat `entry.amount`). The keeper may void any time before settle; ANYONE
/// may void once the grace period past `settle_after_ts` elapses (permissionless
/// liveness backstop for a lost/absent keeper). Reachable because LivePool is
/// never delegated, so its status can always be mutated on the base layer.
#[derive(Accounts)]
pub struct VoidLivePool<'info> {
    // Named `settle_authority` so keeper call sites read naturally; the handler
    // permits ANY signer after the grace window (checked below, not via has_one).
    pub settle_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LivePool>,
}

pub fn handler(ctx: Context<VoidLivePool>) -> Result<()> {
    require!(
        matches!(
            ctx.accounts.pool.status,
            PoolStatus::Open | PoolStatus::Live | PoolStatus::Ended
        ),
        ProofBetError::PoolNotVoidable
    );
    let now = Clock::get()?.unix_timestamp;
    let is_keeper =
        ctx.accounts.settle_authority.key() == ctx.accounts.pool.settle_authority;
    // saturating_add: a bogus settle_after_ts near i64::MAX saturates rather than
    // wrapping negative, so permissionless void fails closed (the safe direction).
    let grace_elapsed =
        now > ctx.accounts.pool.settle_after_ts.saturating_add(VOID_GRACE_SECS);
    require!(is_keeper || grace_elapsed, ProofBetError::Unauthorized);

    let pool = &mut ctx.accounts.pool;
    pool.status = PoolStatus::Voided;
    pool.settled_ts = now;
    emit!(LivePoolVoided { pool: pool.key(), pool_id: pool.pool_id });
    Ok(())
}
