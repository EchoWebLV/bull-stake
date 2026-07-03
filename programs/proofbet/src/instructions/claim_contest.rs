use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestClaimed;

#[derive(Accounts)]
pub struct ClaimContest<'info> {
    #[account(mut)]
    pub bettor: Signer<'info>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    // The Contest PDA holds this contest's pot; both win-shares and void refunds are
    // paid from it directly (program-owned → sub_lamports, no system CPI).
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

    let floor = contest_rent_floor()?;

    let mut payout: u64 = 0;
    let mut kind: u8 = 0;

    match status {
        ContestStatus::Voided => {
            payout = ctx.accounts.entry.amount;
            kind = 2;
        }
        ContestStatus::Settled => {
            let nl = ctx.accounts.contest.num_legs as usize;
            // The entry's ACTIVE legs are those still open when its picks were
            // (last) written. Locked-at-entry legs are outside the card: their
            // picks are ignored. weight = 2^active — matches the keeper's count.
            let entry_ts = ctx.accounts.entry.entry_ts;
            let mut active: u32 = 0;
            // Fail closed on an impossible zero entry_ts (defense-in-depth: zero
            // would mark every leg active since all real locks are > 0; legit
            // entries always stamp a positive clock time).
            let mut perfect = entry_ts > 0;
            for i in 0..nl {
                if ctx.accounts.contest.leg_lock_ts[i] > entry_ts {
                    active += 1;
                    if ctx.accounts.entry.picks[i] != ctx.accounts.contest.winning_buckets[i] {
                        perfect = false;
                    }
                }
            }
            // Entries are only accepted while >= MIN_OPEN_LEGS legs are open, so
            // active >= MIN_OPEN_LEGS for every legitimate entry.
            if perfect && active > 0 {
                require!(ctx.accounts.contest.perfect_count > 0, ProofBetError::PerfectCountZero);
                require!(ctx.accounts.contest.perfect_weight > 0, ProofBetError::PerfectCountZero);
                let weight = 1u128 << active;
                let share = u64::try_from(
                    (ctx.accounts.contest.distributable as u128)
                        .checked_mul(weight)
                        .ok_or(ProofBetError::MathOverflow)?
                        .checked_div(ctx.accounts.contest.perfect_weight as u128)
                        .ok_or(ProofBetError::MathOverflow)?,
                )
                .map_err(|_| ProofBetError::MathOverflow)?;
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
        ctx.accounts.contest.sub_lamports(payout)?;
        ctx.accounts.bettor.add_lamports(payout)?;
        if kind == 1 {
            {
                let c = &mut ctx.accounts.contest;
                c.claimed_count = c.claimed_count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
                c.claimed_total = c.claimed_total.checked_add(payout).ok_or(ProofBetError::MathOverflow)?;
            }
            // Solvency (winners): after a win payout the Contest PDA must still cover
            // its rent floor AND every share not yet claimed (distributable -
            // claimed_total). distributable was made exactly divisible at settle, so a
            // legitimate winner is always payable — this can only fire on over-claim.
            let outstanding = ctx
                .accounts
                .contest
                .distributable
                .checked_sub(ctx.accounts.contest.claimed_total)
                .ok_or(ProofBetError::MathOverflow)?;
            require!(
                ctx.accounts.contest.to_account_info().lamports()
                    >= floor
                        .checked_add(outstanding)
                        .ok_or(ProofBetError::MathOverflow)?,
                ProofBetError::VaultInsolvent
            );
        } else {
            // Void refund: the Contest PDA pays the entry stake from its own pot. The
            // pot exactly equals Σ entry.amount (no rake/jackpot on a void), so each
            // refund leaves the PDA at >= its rent floor; a real accounting bug would
            // be the only way to underflow here.
            require!(
                ctx.accounts.contest.to_account_info().lamports() >= floor,
                ProofBetError::VaultInsolvent
            );
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
