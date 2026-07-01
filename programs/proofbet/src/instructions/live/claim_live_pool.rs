use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::LivePoolClaimed;
use crate::live_state::*;

/// A seat claims its outcome: a winner (total == winning_score) takes its share,
/// a void refunds the stake, anyone else just closes for rent. `close = player`
/// deletes the seat so a double-claim fails and a loser still reclaims rent.
#[derive(Accounts)]
pub struct ClaimLivePool<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    #[account(
        mut,
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, LivePool>,
    #[account(
        mut,
        seeds = [b"liveentry", pool.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
        has_one = player @ ProofBetError::Unauthorized,
        close = player,
    )]
    pub entry: Account<'info, LiveEntry>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimLivePool>) -> Result<()> {
    let status = ctx.accounts.pool.status;
    require!(
        matches!(
            status,
            PoolStatus::Settled | PoolStatus::RolledOver | PoolStatus::Voided
        ),
        ProofBetError::PoolNotTerminal
    );

    let floor = live_pool_rent_floor()?;
    let mut payout: u64 = 0;
    let mut kind: u8 = 0;

    match status {
        PoolStatus::Voided => {
            // Mutual exclusion with the permissionless bulk `refund_voided` — BY
            // STATE, not by lamport slack. refund_voided pays every seat and sets
            // claimed_count = player_count (it is the ONLY writer of claimed_count
            // on a Voided pool; per-seat void-claims don't touch it and a Settled
            // pool can never become Voided). claimed_count > 0 here therefore means
            // every seat was already made whole: a second stake payout would
            // double-pay out of any lamports later landing in the PDA
            // (donation/dust) — the rent-floor solvency check alone cannot see
            // that. The claim still SUCCEEDS as close-only (payout 0, kind 0): the
            // seat's stake came back via refund_voided (which cannot close a
            // delegated entry), and `close = player` here returns the entry rent.
            if ctx.accounts.pool.claimed_count == 0 {
                payout = ctx.accounts.entry.amount;
                kind = 2;
            }
        }
        PoolStatus::Settled => {
            let total =
                (ctx.accounts.entry.base_pts as u64) + (ctx.accounts.entry.bonus_pts as u64);
            if ctx.accounts.pool.winning_score > 0 && total == ctx.accounts.pool.winning_score {
                require!(ctx.accounts.pool.winner_count > 0, ProofBetError::WinnerCountZero);
                let share = u64::try_from(
                    (ctx.accounts.pool.distributable as u128)
                        .checked_div(ctx.accounts.pool.winner_count as u128)
                        .ok_or(ProofBetError::MathOverflow)?,
                )
                .map_err(|_| ProofBetError::MathOverflow)?;
                // Solvency caps: never pay more claims than winner_count, never
                // exceed distributable in total.
                require!(
                    ctx.accounts.pool.claimed_count < ctx.accounts.pool.winner_count,
                    ProofBetError::VaultInsolvent
                );
                require!(
                    ctx.accounts.pool.claimed_total
                        .checked_add(share)
                        .ok_or(ProofBetError::MathOverflow)?
                        <= ctx.accounts.pool.distributable,
                    ProofBetError::VaultInsolvent
                );
                payout = share;
                kind = 1;
            }
        }
        // RolledOver: no payout, close-only.
        PoolStatus::RolledOver => {}
        PoolStatus::Open | PoolStatus::Live | PoolStatus::Ended => {
            return err!(ProofBetError::PoolNotTerminal)
        }
    }

    if payout > 0 {
        ctx.accounts.pool.sub_lamports(payout)?;
        ctx.accounts.player.add_lamports(payout)?;
        if kind == 1 {
            {
                let p = &mut ctx.accounts.pool;
                p.claimed_count = p.claimed_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
                p.claimed_total = p.claimed_total.checked_add(payout).ok_or(ProofBetError::MathOverflow)?;
            }
            // After a win payout the pool must still cover its rent floor AND every
            // share not yet claimed.
            let outstanding = ctx
                .accounts
                .pool
                .distributable
                .checked_sub(ctx.accounts.pool.claimed_total)
                .ok_or(ProofBetError::MathOverflow)?;
            require!(
                ctx.accounts.pool.to_account_info().lamports()
                    >= floor.checked_add(outstanding).ok_or(ProofBetError::MathOverflow)?,
                ProofBetError::VaultInsolvent
            );
        } else {
            // Void refund: pot == Σ entry.amount exactly (no rake/jackpot on a void),
            // so each refund leaves the PDA at >= its rent floor.
            require!(
                ctx.accounts.pool.to_account_info().lamports() >= floor,
                ProofBetError::VaultInsolvent
            );
        }
    }

    emit!(LivePoolClaimed {
        pool: ctx.accounts.pool.key(),
        player: ctx.accounts.player.key(),
        payout,
        kind,
    });
    Ok(())
    // `close = player` returns the LiveEntry rent and deletes it → a double-claim
    // fails (account gone) and a loser still reclaims rent.
}
