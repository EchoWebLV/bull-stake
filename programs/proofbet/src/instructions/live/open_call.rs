use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::CallOpened;
use crate::live_state::*;

#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct OpenCall<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        mut,
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
        init,
        payer = keeper,
        space = 8 + Call::INIT_SPACE,
        seeds = [b"call", pool.key().as_ref(), seq.to_le_bytes().as_ref()],
        bump,
    )]
    // SLICE 1 creates the Call lazily here (base layer). SLICE 2 pre-creates all
    // calls at pool creation so none is created inside the ER.
    pub call: Account<'info, Call>,
    pub system_program: Program<'info, System>,
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

    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();

    let call = &mut ctx.accounts.call;
    call.pool = pool_key;
    call.seq = seq;
    call.kind = kind;
    call.state = CallState::Open;
    call.opened_ts = now;
    call.answer_secs = answer_secs;
    call.num_options = num_options;
    call.base_points = base_points;
    call.outcome = OUTCOME_UNSET;
    call.bump = ctx.bumps.call;

    let cursor = &mut ctx.accounts.cursor;
    cursor.next_seq = seq.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
    cursor.open_seq = seq;

    ctx.accounts.pool.status = PoolStatus::Live;

    emit!(CallOpened { pool: pool_key, seq, kind, num_options });
    Ok(())
}
