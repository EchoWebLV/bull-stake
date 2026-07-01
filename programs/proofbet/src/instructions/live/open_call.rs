use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::CallOpened;
use crate::live_state::*;

#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct OpenCall<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    // Read-only: open_call runs on the ER, where LivePool (never delegated) is NOT
    // writable. Only cursor + call (delegated) are mutated here; the pool is read
    // for the keeper constraint / seq bound / seeds only. (Never write LivePool from
    // an ER instruction — see resolve_call, which is also read-only on the pool.)
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
        seeds = [b"call", pool.key().as_ref(), seq.to_le_bytes().as_ref()],
        bump = call.bump,
    )]
    // The Call is pre-created on the base layer by `prealloc_call` (CallState::Empty)
    // so that no account is ever created inside the ER. `open_call` only mutates
    // Empty → Open, which is legal on a delegated account.
    pub call: Account<'info, Call>,
}

pub fn handler(
    ctx: Context<OpenCall>,
    seq: u32,
    kind: CallKind,
    num_options: u8,
    base_points: [u8; 3],
    answer_secs: u16,
) -> Result<()> {
    require!(
        matches!(ctx.accounts.pool.status, PoolStatus::Open | PoolStatus::Live),
        ProofBetError::PoolNotLive
    );
    require!(ctx.accounts.cursor.open_seq == NONE_SEQ, ProofBetError::CallStillOpen);
    require!(seq == ctx.accounts.cursor.next_seq, ProofBetError::CallSeqMismatch);
    require!(seq < ctx.accounts.pool.num_calls, ProofBetError::CallLimitReached);
    require!(num_options == 2 || num_options == 3, ProofBetError::InvalidOption);
    // The Call must have been pre-created (Empty) by `prealloc_call`; opening is a
    // mutation, never a creation (ER-compatible).
    require!(ctx.accounts.call.state == CallState::Empty, ProofBetError::CallNotEmpty);

    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();

    let call = &mut ctx.accounts.call;
    // pool/seq/bump were set at prealloc; open_call fills the live fields.
    call.kind = kind;
    call.state = CallState::Open;
    call.opened_ts = now;
    call.answer_secs = answer_secs;
    call.num_options = num_options;
    call.base_points = base_points;
    call.outcome = OUTCOME_UNSET;

    let cursor = &mut ctx.accounts.cursor;
    cursor.next_seq = seq.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
    cursor.open_seq = seq;

    emit!(CallOpened { pool: pool_key, seq, kind, num_options });
    Ok(())
}
