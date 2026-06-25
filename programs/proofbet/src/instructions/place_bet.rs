use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::ProofBetError;
use crate::events::BetPlaced;
use crate::state::*;

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init_if_needed,
        payer = bettor,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceBet>, bucket: u8, amount: u64) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        ProofBetError::MarketNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.market.entry_close_ts, ProofBetError::EntryClosed);
    require!((bucket as usize) < 2, ProofBetError::InvalidBucket);
    require!(amount > 0, ProofBetError::ZeroAmount);

    // Escrow lamports: bettor -> vault (bettor signs, system CPI).
    let cpi = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        system_program::Transfer {
            from: ctx.accounts.bettor.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        },
    );
    system_program::transfer(cpi, amount)?;

    // Idempotent on re-bet: seeds bind the position to this bettor, so these
    // writes are always the same key/bump (reinit-safe).
    let bettor_key = ctx.accounts.bettor.key();
    let position = &mut ctx.accounts.position;
    position.bettor = bettor_key;
    position.bump = ctx.bumps.position;

    let idx = bucket as usize;
    position.amounts[idx] = position.amounts[idx]
        .checked_add(amount)
        .ok_or(ProofBetError::MathOverflow)?;

    let market = &mut ctx.accounts.market;
    market.bucket_totals[idx] = market.bucket_totals[idx]
        .checked_add(amount)
        .ok_or(ProofBetError::MathOverflow)?;
    market.total_pool = market.total_pool
        .checked_add(amount)
        .ok_or(ProofBetError::MathOverflow)?;

    emit!(BetPlaced {
        market: market.key(),
        bettor: bettor_key,
        bucket,
        amount,
        bucket_totals: market.bucket_totals,
        total_pool: market.total_pool,
    });
    Ok(())
}
