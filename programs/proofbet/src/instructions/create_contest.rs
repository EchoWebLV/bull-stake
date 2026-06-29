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
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Contest::INIT_SPACE,
        seeds = [b"contest", contest_id.to_le_bytes().as_ref()],
        bump
    )]
    pub contest: Account<'info, Contest>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn handler(
    ctx: Context<CreateContest>,
    contest_id: u64,
    fixtures: [i64; MAX_MATCHES],
    num_matches: u8,
    entry_price: u64,
    lock_ts: i64,
    settle_after_ts: i64,
    fee_recipient: Pubkey,
    fee_bps: u16,
) -> Result<()> {
    // Pure argument validation first (independent of vault state), then the
    // one-live-contest guard last — so a bad-args test fails with its specific
    // error regardless of whether another contest happens to be live.
    require!(contest_id != 0, ProofBetError::InvalidContestId);
    require!(
        (3..=MAX_MATCHES as u8).contains(&num_matches),
        ProofBetError::InvalidMatchCount
    );
    require!(entry_price > 0, ProofBetError::ZeroAmount);
    require!(fee_bps <= MAX_FEE_BPS, ProofBetError::FeeTooHigh);
    let now = Clock::get()?.unix_timestamp;
    require!(now < lock_ts && lock_ts < settle_after_ts, ProofBetError::EntryCloseInPast);
    for i in 0..(num_matches as usize) {
        require!(fixtures[i] != 0, ProofBetError::InvalidFixtureId);
    }
    require!(
        ctx.accounts.vault.active_contest_id == 0,
        ProofBetError::ContestStillLive
    );

    let keeper_key = ctx.accounts.keeper.key();
    let c = &mut ctx.accounts.contest;
    c.contest_id = contest_id;
    c.settle_authority = keeper_key;
    c.fee_recipient = fee_recipient;
    c.fixtures = fixtures;
    c.num_matches = num_matches;
    c.entry_price = entry_price;
    c.lock_ts = lock_ts;
    c.settle_after_ts = settle_after_ts;
    c.fee_bps = fee_bps;
    c.status = ContestStatus::Open;
    c.winning_buckets = [0; MAX_MATCHES];
    c.entry_count = 0;
    c.perfect_count = 0;
    c.pot_snapshot = 0;
    c.distributable = 0;
    c.claimed_count = 0;
    c.claimed_total = 0;
    c.settled_ts = 0;
    c.bump = ctx.bumps.contest;

    ctx.accounts.vault.active_contest_id = contest_id;

    emit!(ContestCreated {
        contest: ctx.accounts.contest.key(),
        contest_id,
        num_matches,
        entry_price,
        lock_ts,
        settle_after_ts,
        settle_authority: keeper_key,
    });
    Ok(())
}
