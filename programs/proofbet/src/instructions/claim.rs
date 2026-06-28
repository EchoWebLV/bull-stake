use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::Claimed;
use crate::state::*;

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
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
        mut,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref()],
        bump = position.bump,
        has_one = bettor @ ProofBetError::Unauthorized,
        close = bettor,
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<Claim>) -> Result<()> {
    let status = ctx.accounts.market.status;
    require!(
        status == MarketStatus::Settled || status == MarketStatus::Voided,
        ProofBetError::NotClaimable
    );

    let amounts = ctx.accounts.position.amounts;
    let payout: u64 = match status {
        // Refund every bucket the bettor staked (unused buckets are zero).
        MarketStatus::Voided => amounts
            .iter()
            .try_fold(0u64, |acc, &a| acc.checked_add(a))
            .ok_or(ProofBetError::MathOverflow)?,
        MarketStatus::Settled => {
            // Always Some for a Settled market (settle sets it before transitioning);
            // use a typed error rather than a panic to keep the money path graceful.
            let wb = ctx.accounts.market.winning_bucket
                .ok_or(ProofBetError::NotClaimable)? as usize;
            // Only the winning-bucket stake pays out. A bettor who hedged both
            // sides forfeits the losing side (it funded the pool) — standard parimutuel.
            let stake = amounts[wb];
            if stake == 0 {
                0
            } else {
                let winner_total = ctx.accounts.market.bucket_totals[wb];
                let distributable = ctx.accounts.market.total_pool
                    .checked_sub(ctx.accounts.market.fee_collected)
                    .ok_or(ProofBetError::MathOverflow)?;
                ((stake as u128)
                    .checked_mul(distributable as u128)
                    .ok_or(ProofBetError::MathOverflow)?
                    .checked_div(winner_total as u128)
                    .ok_or(ProofBetError::MathOverflow)?) as u64
            }
        }
        MarketStatus::Open => return err!(ProofBetError::NotClaimable),
    };

    if payout > 0 {
        // Direct lamport move from the program-owned vault to the bettor,
        // using Anchor's checked Lamports-trait helpers (same as settle.rs).
        // Solvency invariant: vault holds rent_floor + total_pool, and
        // Σpayout ≤ distributable ≤ total_pool, so the vault never dips into
        // its rent reserve regardless of claim order.
        ctx.accounts.vault.sub_lamports(payout)?;
        ctx.accounts.bettor.add_lamports(payout)?;
    }

    emit!(Claimed {
        market: ctx.accounts.market.key(),
        bettor: ctx.accounts.bettor.key(),
        payout,
        voided: status == MarketStatus::Voided,
    });
    Ok(())
    // `close = bettor` returns the Position rent and deletes the record, so a
    // loser still reclaims rent and a double-claim fails (account gone).
}
