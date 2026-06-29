use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestVoided;

#[derive(Accounts)]
pub struct VoidContest<'info> {
    /// The caller. Must equal `contest.settle_authority` (the keeper) UNLESS the
    /// grace period past `settle_after_ts` has elapsed, in which case anyone may
    /// void. Because that authorization is conditional it's checked in the handler,
    /// not via a fixed `has_one` (the account stays named `settle_authority` so the
    /// common keeper call sites read naturally).
    // NOTE (IDL-naming, tracked): an IDL consumer reading only this struct may
    // assume `settle_authority` is always required to be the keeper. It is NOT —
    // the handler permits any signer after the grace window. Revisit renaming to
    // `caller` when the engine/keeper/web client plans are written.
    pub settle_authority: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    pub contest: Account<'info, Contest>,
}

pub fn handler(ctx: Context<VoidContest>) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    // Authorization: the keeper may void any time; ANYONE may void once the grace
    // period past settle_after_ts has elapsed (permissionless liveness backstop so
    // a lost/absent keeper can't freeze the whole vault forever).
    let is_keeper =
        ctx.accounts.settle_authority.key() == ctx.accounts.contest.settle_authority;
    // saturating_add: a bogus settle_after_ts near i64::MAX saturates rather than
    // wrapping negative, so grace_elapsed stays false → permissionless void never
    // fires → fails closed (the safe direction).
    let grace_elapsed =
        now > ctx.accounts.contest.settle_after_ts.saturating_add(VOID_GRACE_SECS);
    require!(is_keeper || grace_elapsed, ProofBetError::Unauthorized);

    // Fence the refundable stake (Σ entry.amount = entry_count * entry_price) as a
    // cross-contest liability so the next contest can't roll lamports we owe back.
    // u128 mul then a CHECKED narrow to u64 (never a silent truncating cast).
    let refundable = u64::try_from(
        (ctx.accounts.contest.entry_count as u128)
            .checked_mul(ctx.accounts.contest.entry_price as u128)
            .ok_or(ProofBetError::MathOverflow)?,
    )
    .map_err(|_| ProofBetError::MathOverflow)?;
    ctx.accounts.vault.reserved = ctx
        .accounts
        .vault
        .reserved
        .checked_add(refundable)
        .ok_or(ProofBetError::MathOverflow)?;
    ctx.accounts.vault.active_contest_id = 0;

    let c = &mut ctx.accounts.contest;
    c.status = ContestStatus::Voided;
    c.settled_ts = now;
    emit!(ContestVoided { contest: c.key(), contest_id: c.contest_id });
    Ok(())
}
