use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::LivePoolEnded;
use crate::live_state::*;

/// Keeper marks full-time: Open/Live → Ended, gating settle. Requires no call
/// still open (all opened calls resolved/voided). SLICE 2 folds this into
/// `end_and_undelegate` (final ER commit + ownership return).
#[derive(Accounts)]
pub struct EndLivePool<'info> {
    pub keeper: Signer<'info>,
    #[account(
        mut,
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
        constraint = pool.settle_authority == keeper.key() @ ProofBetError::Unauthorized,
    )]
    pub pool: Account<'info, LivePool>,
    #[account(
        seeds = [b"livecursor", pool.key().as_ref()],
        bump = cursor.bump,
    )]
    pub cursor: Account<'info, LiveCursor>,
}

pub fn handler(ctx: Context<EndLivePool>) -> Result<()> {
    require!(
        matches!(ctx.accounts.pool.status, PoolStatus::Open | PoolStatus::Live),
        ProofBetError::PoolNotLive
    );
    require!(ctx.accounts.cursor.open_seq == NONE_SEQ, ProofBetError::CallStillOpen);

    ctx.accounts.pool.status = PoolStatus::Ended;
    emit!(LivePoolEnded {
        pool: ctx.accounts.pool.key(),
        pool_id: ctx.accounts.pool.pool_id,
    });
    Ok(())
}
