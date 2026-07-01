use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::live_state::*;

#[derive(Accounts)]
pub struct LockPick<'info> {
    pub player: Signer<'info>,
    #[account(
        seeds = [b"call", call.pool.as_ref(), call.seq.to_le_bytes().as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,
    #[account(
        mut,
        seeds = [b"liveentry", call.pool.as_ref(), player.key().as_ref()],
        bump = entry.bump,
        has_one = player @ ProofBetError::Unauthorized,
    )]
    // Entry seeds bind to call.pool, so the pick can only land on a call of the
    // SAME pool this seat belongs to.
    pub entry: Account<'info, LiveEntry>,
}

pub fn handler(ctx: Context<LockPick>, option: u8) -> Result<()> {
    let call = &ctx.accounts.call;
    require!(call.state == CallState::Open, ProofBetError::CallNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(
        now <= call.opened_ts.saturating_add(call.answer_secs as i64),
        ProofBetError::AnswerWindowClosed
    );
    require!(option < call.num_options, ProofBetError::InvalidOption);

    let seq = call.seq as usize;
    require!(seq < MAX_CALLS, ProofBetError::CallLimitReached);
    ctx.accounts.entry.picks[seq] = option;
    Ok(())
}
