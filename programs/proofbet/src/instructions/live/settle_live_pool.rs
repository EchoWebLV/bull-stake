use anchor_lang::prelude::*;

use crate::contest_state::{jackpot_rent_floor, Jackpot};
use crate::errors::ProofBetError;
use crate::events::LivePoolSettled;
use crate::live_state::*;

/// Settle: recompute the winning score ON-CHAIN over EVERY seat, then rake/split/
/// rollover exactly like `settle_contest`. The keeper supplies NO score — every
/// `LiveEntry` is passed as a remaining_account, each bound by PDA + program
/// ownership + pool, and the program itself computes `max(total)` and the winner
/// count. Coverage (`seen == player_count`) makes the max provably the true one.
#[derive(Accounts)]
pub struct SettleLivePool<'info> {
    pub settle_authority: Signer<'info>,
    #[account(mut, seeds = [b"jackpot"], bump = jackpot.bump)]
    pub jackpot: Account<'info, Jackpot>,
    #[account(
        mut,
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub pool: Account<'info, LivePool>,
    #[account(
        seeds = [b"livecursor", pool.key().as_ref()],
        bump = cursor.bump,
    )]
    pub cursor: Account<'info, LiveCursor>,
    /// CHECK: receives rake via direct lamport credit; pinned to pool.fee_recipient.
    #[account(mut, address = pool.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    // remaining_accounts: EVERY LiveEntry for this pool (exactly player_count of them).
}

pub fn handler(ctx: Context<SettleLivePool>) -> Result<()> {
    require!(ctx.accounts.pool.status == PoolStatus::Ended, ProofBetError::PoolNotEnded);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.pool.settle_after_ts, ProofBetError::SettleTooEarly);
    // Under-filled pools are voided-and-refunded, never settled (no lone-player
    // pool pays itself rake).
    require!(ctx.accounts.pool.player_count >= 2, ProofBetError::NotEnoughPlayers);

    let pool_key = ctx.accounts.pool.key();
    let resolved = ctx.accounts.cursor.resolved_count;

    // ── Recompute the max total over ALL seats, on-chain ──────────────────────
    let mut seen: u64 = 0;
    let mut top: u64 = 0;
    let mut count: u64 = 0;
    let mut prev: Option<Pubkey> = None;
    for acc in ctx.remaining_accounts.iter() {
        // Strictly-ascending keys ⇒ every passed account is DISTINCT. Combined
        // with the coverage check below, this stops a keeper from padding the
        // count with a duplicate seat while omitting the true top scorer.
        let key = acc.key();
        require!(prev.map_or(true, |p| key > p), ProofBetError::ScoreMismatch);
        prev = Some(key);
        // Bind: real LiveEntry PDA for its stored player, owned by THIS program.
        require_keys_eq!(*acc.owner, crate::ID, ProofBetError::ScoreMismatch);
        let data = acc.try_borrow_data()?;
        let entry = LiveEntry::try_deserialize(&mut &data[..])?;
        require_keys_eq!(entry.pool, pool_key, ProofBetError::ScoreMismatch);
        let (expected, _) = Pubkey::find_program_address(
            &[b"liveentry", pool_key.as_ref(), entry.player.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(acc.key(), expected, ProofBetError::ScoreMismatch);
        // Fairness: every seat must have folded every resolved call.
        require!(entry.next_score_seq == resolved, ProofBetError::NotAllScored);

        let total = (entry.base_pts as u64) + (entry.bonus_pts as u64);
        if total > top {
            top = total;
            count = 1;
        } else if total == top {
            count = count.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
        }
        seen = seen.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
    }
    // Coverage: EVERY seat present, or the max is unproven (a keeper could omit
    // the true top scorer). This makes winning_score a real seat's total.
    require!(seen == ctx.accounts.pool.player_count, ProofBetError::ScoreMismatch);

    // ── pot = this pool's own escrowed entries (above the PDA's rent floor) ──
    let floor = live_pool_rent_floor()?;
    let pool_lamports = ctx.accounts.pool.to_account_info().lamports();
    let pot = pool_lamports.checked_sub(floor).ok_or(ProofBetError::MathOverflow)?;

    // Rake on this pool's stakes (capped at the pot).
    let stakes = (ctx.accounts.pool.player_count as u128)
        .checked_mul(ctx.accounts.pool.entry_price as u128)
        .ok_or(ProofBetError::MathOverflow)?;
    let rake = u64::try_from(
        stakes
            .checked_mul(ctx.accounts.pool.fee_bps as u128)
            .ok_or(ProofBetError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(ProofBetError::MathOverflow)?,
    )
    .map_err(|_| ProofBetError::MathOverflow)?;
    let rake = rake.min(pot);

    if rake > 0 {
        ctx.accounts.pool.sub_lamports(rake)?;
        ctx.accounts.fee_recipient.add_lamports(rake)?;
    }
    let pot_net = pot.checked_sub(rake).ok_or(ProofBetError::MathOverflow)?;

    // Current rolling jackpot pool (above the jackpot PDA's own rent floor).
    let jpool = ctx
        .accounts
        .jackpot
        .to_account_info()
        .lamports()
        .checked_sub(jackpot_rent_floor()?)
        .ok_or(ProofBetError::MathOverflow)?;

    // A winner requires top > 0 (someone actually scored). Nobody scored → rollover.
    let has_winner = top > 0;
    let mut jackpot_in: u64 = 0;
    let mut jackpot_out: u64 = 0;
    let distributable: u64;

    if !has_winner {
        // ── ROLLOVER ── post-rake pot sweeps into the jackpot; nobody is owed.
        if pot_net > 0 {
            ctx.accounts.pool.sub_lamports(pot_net)?;
            ctx.accounts.jackpot.add_lamports(pot_net)?;
        }
        jackpot_out = pot_net;
        distributable = 0;
        require!(
            ctx.accounts.pool.to_account_info().lamports() >= floor,
            ProofBetError::VaultInsolvent
        );
    } else {
        // ── WINNERS ── pay net entries + the whole jackpot, split evenly by count.
        let raw = (pot_net as u128)
            .checked_add(jpool as u128)
            .ok_or(ProofBetError::MathOverflow)?;
        let share = raw.checked_div(count as u128).ok_or(ProofBetError::MathOverflow)?;
        let payable = u64::try_from(
            share.checked_mul(count as u128).ok_or(ProofBetError::MathOverflow)?,
        )
        .map_err(|_| ProofBetError::MathOverflow)?;

        // Net transfer is the signed delta payable - pot_net (== jpool - dust).
        if payable >= pot_net {
            let need = payable - pot_net; // jackpot → pool
            if need > 0 {
                ctx.accounts.jackpot.sub_lamports(need)?;
                ctx.accounts.pool.add_lamports(need)?;
            }
            jackpot_in = need;
        } else {
            let give = pot_net - payable; // pool → jackpot (dust > jpool edge)
            ctx.accounts.pool.sub_lamports(give)?;
            ctx.accounts.jackpot.add_lamports(give)?;
            jackpot_out = give;
        }
        distributable = payable;

        require!(
            ctx.accounts.pool.to_account_info().lamports()
                >= floor.checked_add(distributable).ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
        require!(
            ctx.accounts.jackpot.to_account_info().lamports() >= jackpot_rent_floor()?,
            ProofBetError::VaultInsolvent
        );
    }

    let pool = &mut ctx.accounts.pool;
    pool.winning_score = top;
    pool.winner_count = if has_winner { count } else { 0 };
    pool.distributable = distributable;
    pool.settled_ts = now;
    pool.status = if has_winner { PoolStatus::Settled } else { PoolStatus::RolledOver };

    emit!(LivePoolSettled {
        pool: pool_key,
        pool_id: pool.pool_id,
        pot,
        winning_score: pool.winning_score,
        winner_count: pool.winner_count,
        distributable,
        rake,
        jackpot_in,
        jackpot_out,
        rolled_over: !has_winner,
    });
    Ok(())
}
