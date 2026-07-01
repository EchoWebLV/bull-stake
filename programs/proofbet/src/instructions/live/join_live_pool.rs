use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ProofBetError;
use crate::events::JoinedLivePool;
use crate::live_state::*;

#[derive(Accounts)]
pub struct JoinLivePool<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    // The LivePool PDA escrows the pot: a new seat deposits straight into it.
    pub pool: Account<'info, LivePool>,
    #[account(
        init,
        payer = player,
        space = 8 + LiveEntry::INIT_SPACE,
        seeds = [b"liveentry", pool.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    // `init` (NOT init_if_needed): one seat per (pool, player), so the invariant
    // `pot == player_count * entry_price` holds exactly (void-refund solvency).
    pub entry: Account<'info, LiveEntry>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<JoinLivePool>) -> Result<()> {
    require!(ctx.accounts.pool.status == PoolStatus::Open, ProofBetError::PoolNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.pool.lock_ts, ProofBetError::JoinClosed);

    let price = ctx.accounts.pool.entry_price;
    let player_key = ctx.accounts.player.key();
    let pool_key = ctx.accounts.pool.key();

    // The player is a system-owned wallet, so a system_program transfer CPI can
    // credit the program-owned LivePool PDA (a system transfer may credit any
    // account). After this the pool holds (rent_floor + Σ entries).
    let cpi = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.player.to_account_info(),
            to: ctx.accounts.pool.to_account_info(),
        },
    );
    system_program::transfer(cpi, price)?;

    let entry = &mut ctx.accounts.entry;
    entry.player = player_key;
    entry.pool = pool_key;
    entry.amount = price;
    entry.base_pts = 0;
    entry.bonus_pts = 0;
    entry.streak = 0;
    entry.next_score_seq = 0;
    entry.picks = [NO_PICK; MAX_CALLS];
    entry.bump = ctx.bumps.entry;

    let pool = &mut ctx.accounts.pool;
    pool.player_count = pool.player_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;

    emit!(JoinedLivePool {
        pool: pool_key,
        player: player_key,
        amount: price,
        player_count: pool.player_count,
    });
    Ok(())
}
