use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::EntryScored;
use crate::live_state::*;

/// Permissionless crank: folds ONE resolved call into ONE seat's score. Anyone
/// may call it (the fold is a deterministic function of immutable inputs). Must
/// process calls in order (seq == entry.next_score_seq) so every call is folded
/// exactly once — which is what lets settle recompute the max fairly.
#[derive(Accounts)]
pub struct ScoreEntry<'info> {
    pub cranker: Signer<'info>,
    #[account(
        seeds = [b"call", call.pool.as_ref(), call.seq.to_le_bytes().as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
    #[account(
        mut,
        seeds = [b"liveentry", entry.pool.as_ref(), entry.player.as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, LiveEntry>,
}

pub fn handler(ctx: Context<ScoreEntry>) -> Result<()> {
    let call = &ctx.accounts.call;
    let entry = &mut ctx.accounts.entry;

    require_keys_eq!(entry.pool, call.pool, ProofBetError::ScoreMismatch);
    require!(call.seq == entry.next_score_seq, ProofBetError::ScoreOutOfOrder);
    require!(
        matches!(call.state, CallState::Resolved | CallState::Voided),
        ProofBetError::CallNotResolved
    );

    let seq = call.seq as usize;
    require!(seq < MAX_CALLS, ProofBetError::CallLimitReached);

    // Voided call: no-op for every seat (no penalty, no gain) — streak/bonus/base
    // all unchanged. Only advance the scoring cursor.
    if call.state == CallState::Resolved {
        let pick = entry.picks[seq];
        if pick != NO_PICK && pick == call.outcome {
            // hit: bank rarity base + advance the streak escalator
            let base = call.base_points[call.outcome as usize] as u32;
            entry.base_pts = entry.base_pts.checked_add(base).ok_or(ProofBetError::MathOverflow)?;
            entry.streak = entry.streak.checked_add(1).ok_or(ProofBetError::MathOverflow)?;
            if entry.streak >= 3 {
                let bonus = (entry.streak - 2) as u32; // +1 at 3, +2 at 4, +3 at 5…
                entry.bonus_pts = entry.bonus_pts.checked_add(bonus).ok_or(ProofBetError::MathOverflow)?;
            }
        } else {
            // wrong pick OR no pick (timeout) => miss: keep base, wipe streak+bonus
            entry.streak = 0;
            entry.bonus_pts = 0;
        }
    }

    entry.next_score_seq = entry.next_score_seq.checked_add(1).ok_or(ProofBetError::MathOverflow)?;

    emit!(EntryScored {
        pool: entry.pool,
        player: entry.player,
        seq: call.seq,
        base_pts: entry.base_pts,
        bonus_pts: entry.bonus_pts,
        streak: entry.streak,
    });
    Ok(())
}
