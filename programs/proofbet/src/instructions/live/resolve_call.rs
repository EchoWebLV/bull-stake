use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::CallResolved;
use crate::live_state::*;

#[derive(Accounts)]
pub struct ResolveCall<'info> {
    pub keeper: Signer<'info>,
    #[account(
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
        constraint = pool.settle_authority == keeper.key() @ ProofBetError::Unauthorized,
    )]
    pub pool: Account<'info, LivePool>,
    #[account(
        mut,
        seeds = [b"livecursor", pool.key().as_ref()],
        bump = cursor.bump,
    )]
    pub cursor: Account<'info, LiveCursor>,
    #[account(
        mut,
        seeds = [b"call", pool.key().as_ref(), call.seq.to_le_bytes().as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
}

pub fn handler(ctx: Context<ResolveCall>, outcome: u8) -> Result<()> {
    require!(ctx.accounts.call.state == CallState::Open, ProofBetError::CallNotOpen);
    // The call being resolved must be THE open call (single-open-call invariant).
    require!(ctx.accounts.call.seq == ctx.accounts.cursor.open_seq, ProofBetError::CallNotOpen);

    let call = &mut ctx.accounts.call;
    let voided = outcome == VOID_OUTCOME;
    if voided {
        // Global void: a disqualifying event landed while this call was open.
        call.state = CallState::Voided;
        call.outcome = VOID_OUTCOME;
    } else {
        require!(outcome < call.num_options, ProofBetError::InvalidOption);
        call.state = CallState::Resolved;
        call.outcome = outcome;
    }
    let seq = call.seq;

    let cursor = &mut ctx.accounts.cursor;
    cursor.open_seq = NONE_SEQ;
    cursor.resolved_count = cursor.resolved_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;

    emit!(CallResolved { pool: ctx.accounts.pool.key(), seq, outcome, voided });
    Ok(())
}
