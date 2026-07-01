use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::LivePoolCreated;
use crate::live_state::*;
use crate::state::MAX_FEE_BPS;

#[derive(Accounts)]
#[instruction(pool_id: u64)]
pub struct CreateLivePool<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        init,
        payer = keeper,
        space = 8 + LivePool::INIT_SPACE,
        seeds = [b"livepool", pool_id.to_le_bytes().as_ref()],
        bump
    )]
    // The LivePool PDA also escrows this pool's pot (joins deposit here; payouts/
    // refunds debit here). Never delegated — custody stays on the base layer.
    pub pool: Account<'info, LivePool>,
    #[account(
        init,
        payer = keeper,
        space = 8 + LiveCursor::INIT_SPACE,
        seeds = [b"livecursor", pool.key().as_ref()],
        bump
    )]
    pub cursor: Account<'info, LiveCursor>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateLivePool>,
    pool_id: u64,
    fixture_id: i64,
    entry_price: u64,
    lock_ts: i64,
    settle_after_ts: i64,
    fee_recipient: Pubkey,
    fee_bps: u16,
    num_calls: u32,
) -> Result<()> {
    require!(pool_id != 0, ProofBetError::InvalidPoolId);
    require!(fixture_id != 0, ProofBetError::InvalidFixtureId);
    require!(entry_price > 0, ProofBetError::ZeroAmount);
    require!(fee_bps <= MAX_FEE_BPS, ProofBetError::FeeTooHigh);
    require!(
        num_calls >= 1 && (num_calls as usize) <= MAX_CALLS,
        ProofBetError::InvalidCallCount
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < lock_ts && lock_ts < settle_after_ts, ProofBetError::EntryCloseInPast);

    let keeper_key = ctx.accounts.keeper.key();
    let pool_key = ctx.accounts.pool.key();

    let pool = &mut ctx.accounts.pool;
    pool.pool_id = pool_id;
    pool.fixture_id = fixture_id;
    pool.settle_authority = keeper_key;
    pool.fee_recipient = fee_recipient;
    pool.entry_price = entry_price;
    pool.lock_ts = lock_ts;
    pool.settle_after_ts = settle_after_ts;
    pool.fee_bps = fee_bps;
    pool.status = PoolStatus::Open;
    pool.num_calls = num_calls;
    pool.player_count = 0;
    pool.winning_score = 0;
    pool.winner_count = 0;
    pool.distributable = 0;
    pool.claimed_count = 0;
    pool.claimed_total = 0;
    pool.settled_ts = 0;
    pool.bump = ctx.bumps.pool;

    let cursor = &mut ctx.accounts.cursor;
    cursor.pool = pool_key;
    cursor.next_seq = 0;
    cursor.open_seq = NONE_SEQ;
    cursor.resolved_count = 0;
    cursor.bump = ctx.bumps.cursor;

    emit!(LivePoolCreated {
        pool: pool_key,
        pool_id,
        fixture_id,
        entry_price,
        lock_ts,
        settle_after_ts,
        num_calls,
        settle_authority: keeper_key,
    });
    Ok(())
}
