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
    #[account(
        init,
        payer = keeper,
        space = 8 + Contest::INIT_SPACE,
        seeds = [b"contest", contest_id.to_le_bytes().as_ref()],
        bump
    )]
    // The Contest PDA also escrows THIS contest's entry pot (entries deposit here,
    // payouts/refunds debit here). Contests are independent and concurrent — no
    // jackpot account is touched at creation, so two Open contests can coexist.
    pub contest: Account<'info, Contest>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateContest>,
    contest_id: u64,
    fixtures: [i64; MAX_LEGS],
    market_ids: [u8; MAX_LEGS],
    num_legs: u8,
    entry_price: u64,
    lock_ts: i64,
    settle_after_ts: i64,
    fee_recipient: Pubkey,
    fee_bps: u16,
) -> Result<()> {
    require!(contest_id != 0, ProofBetError::InvalidContestId);
    require!(
        (3..=MAX_LEGS as u8).contains(&num_legs),
        ProofBetError::InvalidMatchCount
    );
    require!(entry_price > 0, ProofBetError::ZeroAmount);
    require!(fee_bps <= MAX_FEE_BPS, ProofBetError::FeeTooHigh);
    let now = Clock::get()?.unix_timestamp;
    require!(now < lock_ts && lock_ts < settle_after_ts, ProofBetError::EntryCloseInPast);
    // Each carded leg is a (fixture, market_id) pair; both must be non-zero so the
    // leg's result-market PDA at settle ([b"market", fixture, market_id]) is real.
    for i in 0..(num_legs as usize) {
        require!(fixtures[i] != 0, ProofBetError::InvalidFixtureId);
        require!(market_ids[i] != 0, ProofBetError::InvalidMarketId);
    }

    let keeper_key = ctx.accounts.keeper.key();
    let c = &mut ctx.accounts.contest;
    c.contest_id = contest_id;
    c.settle_authority = keeper_key;
    c.fee_recipient = fee_recipient;
    c.fixtures = fixtures;
    c.market_ids = market_ids;
    c.num_legs = num_legs;
    c.entry_price = entry_price;
    c.lock_ts = lock_ts;
    c.settle_after_ts = settle_after_ts;
    c.fee_bps = fee_bps;
    c.status = ContestStatus::Open;
    c.winning_buckets = [0; MAX_LEGS];
    c.entry_count = 0;
    c.perfect_count = 0;
    c.distributable = 0;
    c.claimed_count = 0;
    c.claimed_total = 0;
    c.settled_ts = 0;
    c.bump = ctx.bumps.contest;

    emit!(ContestCreated {
        contest: ctx.accounts.contest.key(),
        contest_id,
        num_legs,
        entry_price,
        lock_ts,
        settle_after_ts,
        settle_authority: keeper_key,
    });
    Ok(())
}
