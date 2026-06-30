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
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
    )]
    // Refunds flow through claim_contest's Voided branch, paid from this same PDA.
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
    // a lost/absent keeper can't freeze a contest's pot forever).
    let is_keeper =
        ctx.accounts.settle_authority.key() == ctx.accounts.contest.settle_authority;
    // saturating_add: a bogus settle_after_ts near i64::MAX saturates rather than
    // wrapping negative, so grace_elapsed stays false → permissionless void never
    // fires → fails closed (the safe direction).
    let grace_elapsed =
        now > ctx.accounts.contest.settle_after_ts.saturating_add(VOID_GRACE_SECS);
    require!(is_keeper || grace_elapsed, ProofBetError::Unauthorized);

    // Status transition only — the entry pot stays escrowed in the Contest PDA and
    // is refunded per-ticket via claim_contest's Voided branch (entry.amount each).
    // Per-contest isolation means there is nothing to fence cross-contest: this
    // contest's pot is its own, untouched by any other contest.
    let c = &mut ctx.accounts.contest;
    c.status = ContestStatus::Voided;
    c.settled_ts = now;
    emit!(ContestVoided { contest: c.key(), contest_id: c.contest_id });
    Ok(())
}
