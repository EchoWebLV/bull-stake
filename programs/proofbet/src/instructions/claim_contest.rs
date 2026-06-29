use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestClaimed;

#[derive(Accounts)]
pub struct ClaimContest<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    pub contest: Account<'info, Contest>,
    #[account(
        mut,
        seeds = [b"entry", contest.key().as_ref(), bettor.key().as_ref(), entry.nonce.to_le_bytes().as_ref()],
        bump = entry.bump,
        has_one = bettor @ ProofBetError::Unauthorized,
        close = bettor,
    )]
    pub entry: Account<'info, Entry>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ClaimContest>) -> Result<()> {
    let status = ctx.accounts.contest.status;
    require!(
        matches!(
            status,
            ContestStatus::Settled | ContestStatus::RolledOver | ContestStatus::Voided
        ),
        ProofBetError::ContestNotTerminal
    );

    let floor = vault_rent_floor()?;

    let mut payout: u64 = 0;
    let mut kind: u8 = 0;

    match status {
        ContestStatus::Voided => {
            payout = ctx.accounts.entry.amount;
            kind = 2;
        }
        ContestStatus::Settled => {
            let nm = ctx.accounts.contest.num_matches as usize;
            let mut perfect = true;
            for i in 0..nm {
                if ctx.accounts.entry.picks[i] != ctx.accounts.contest.winning_buckets[i] {
                    perfect = false;
                    break;
                }
            }
            if perfect {
                require!(ctx.accounts.contest.perfect_count > 0, ProofBetError::PerfectCountZero);
                let share = u64::try_from(
                    (ctx.accounts.contest.distributable as u128)
                        .checked_div(ctx.accounts.contest.perfect_count as u128)
                        .ok_or(ProofBetError::MathOverflow)?,
                )
                .map_err(|_| ProofBetError::MathOverflow)?;
                // Solvency cap: never pay more claims than perfect_count, and never
                // pay out more than distributable in total. Bounds a bad (too-low)
                // perfect_count to over-paying early claimers, never cross-contest.
                require!(
                    ctx.accounts.contest.claimed_count < ctx.accounts.contest.perfect_count,
                    ProofBetError::VaultInsolvent
                );
                require!(
                    ctx.accounts.contest.claimed_total
                        .checked_add(share)
                        .ok_or(ProofBetError::MathOverflow)?
                        <= ctx.accounts.contest.distributable,
                    ProofBetError::VaultInsolvent
                );
                payout = share;
                kind = 1;
            }
        }
        // RolledOver: no payout, close-only.
        ContestStatus::RolledOver => {}
        ContestStatus::Open => return err!(ProofBetError::ContestNotTerminal),
    }

    if payout > 0 {
        ctx.accounts.vault.sub_lamports(payout)?;
        ctx.accounts.bettor.add_lamports(payout)?;
        // Release the reserved liability by exactly what left the vault (win share
        // or void refund). vault.lamports and reserved drop together, so the
        // invariant vault.lamports >= floor + reserved is preserved by construction
        // — a legitimate winner/refund is always payable, even after a LATER contest
        // has settled. checked_sub can only fire on a real accounting bug.
        ctx.accounts.vault.reserved = ctx
            .accounts
            .vault
            .reserved
            .checked_sub(payout)
            .ok_or(ProofBetError::MathOverflow)?;
        require!(
            ctx.accounts.vault.to_account_info().lamports()
                >= floor
                    .checked_add(ctx.accounts.vault.reserved)
                    .ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
        if kind == 1 {
            let c = &mut ctx.accounts.contest;
            c.claimed_count = c.claimed_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
            c.claimed_total = c.claimed_total.checked_add(payout).ok_or(ProofBetError::MathOverflow)?;
        }
    }

    emit!(ContestClaimed {
        contest: ctx.accounts.contest.key(),
        bettor: ctx.accounts.bettor.key(),
        nonce: ctx.accounts.entry.nonce,
        payout,
        kind,
    });
    Ok(())
    // `close = bettor` returns the Entry rent and deletes it → loser still
    // reclaims rent and a double-claim fails (account gone).
}
