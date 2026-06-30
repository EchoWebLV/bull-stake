use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::EnteredContest;

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Enter<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    // The Contest PDA escrows the entry pot: new tickets deposit straight into it.
    pub contest: Account<'info, Contest>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Entry::INIT_SPACE,
        seeds = [b"entry", contest.key().as_ref(), bettor.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub entry: Account<'info, Entry>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Enter>, nonce: u64, picks: [u8; MAX_LEGS]) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.contest.lock_ts, ProofBetError::EntryClosed);

    // Validate picks: a valid bucket (< MAX_BUCKETS) within num_legs, and exactly 0
    // beyond it (tail guard). MAX_BUCKETS (3) is the maximum outcome space; we do
    // NOT special-case per-leg bucket counts — a leg that is 2-way simply never has
    // a winning bucket of 2, so a pick of 2 on it is a guaranteed loser, not invalid.
    let nl = ctx.accounts.contest.num_legs as usize;
    for (i, &p) in picks.iter().enumerate() {
        if i < nl {
            require!((p as usize) < crate::state::MAX_BUCKETS, ProofBetError::InvalidPick);
        } else {
            require!(p == 0, ProofBetError::InvalidPick);
        }
    }

    let bettor_key = ctx.accounts.bettor.key();
    // Deterministic new-ticket detection: a fresh PDA is zero-initialized.
    let is_new = ctx.accounts.entry.bettor == Pubkey::default();

    if is_new {
        let price = ctx.accounts.contest.entry_price;
        // The bettor is a wallet (system-owned signer), so a system_program transfer
        // CPI can credit the program-owned Contest PDA — a system transfer may credit
        // ANY account. After this the Contest PDA holds (rent_floor + Σ entries).
        let cpi = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.bettor.to_account_info(),
                to: ctx.accounts.contest.to_account_info(),
            },
        );
        system_program::transfer(cpi, price)?;

        let contest_key = ctx.accounts.contest.key();
        let entry = &mut ctx.accounts.entry;
        entry.bettor = bettor_key;
        entry.contest = contest_key;
        entry.nonce = nonce;
        entry.amount = price;
        entry.picks = picks;
        entry.bump = ctx.bumps.entry;

        let c = &mut ctx.accounts.contest;
        c.entry_count = c.entry_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;

        emit!(EnteredContest {
            contest: contest_key,
            bettor: bettor_key,
            nonce,
            amount: price,
            entry_count: c.entry_count,
            edited: false,
        });
    } else {
        require_keys_eq!(ctx.accounts.entry.bettor, bettor_key, ProofBetError::Unauthorized);
        ctx.accounts.entry.picks = picks;
        emit!(EnteredContest {
            contest: ctx.accounts.contest.key(),
            bettor: bettor_key,
            nonce,
            amount: ctx.accounts.entry.amount,
            entry_count: ctx.accounts.contest.entry_count,
            edited: true,
        });
    }
    Ok(())
}
