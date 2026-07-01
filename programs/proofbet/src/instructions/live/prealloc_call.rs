use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::live_state::*;

/// Pre-create one `Call` PDA on the base layer, in `CallState::Empty`.
///
/// Required for the ER model: no account can be created inside an Ephemeral
/// Rollup, so every `Call` a match will ever open must already exist on the base
/// layer *before* `delegate_live`. The keeper calls this once per `seq` (0 ..
/// num_calls) after `create_live_pool` and before delegation; `open_call` then
/// only mutates `Empty → Open`. One call per tx keeps this trivially correct;
/// batching is a keeper-side optimization, not a program concern.
#[derive(Accounts)]
#[instruction(seq: u32)]
pub struct PreallocCall<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
        constraint = pool.settle_authority == keeper.key() @ ProofBetError::Unauthorized,
    )]
    pub pool: Account<'info, LivePool>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Call::INIT_SPACE,
        seeds = [b"call", pool.key().as_ref(), seq.to_le_bytes().as_ref()],
        bump,
    )]
    pub call: Account<'info, Call>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PreallocCall>, seq: u32) -> Result<()> {
    // Pre-creation happens only while the pool is still joining (Open) — every
    // call must exist before the first `open_call` flips the pool Live and before
    // delegation. No mid-match allocation.
    require!(ctx.accounts.pool.status == PoolStatus::Open, ProofBetError::PoolNotOpen);
    require!(seq < ctx.accounts.pool.num_calls, ProofBetError::CallLimitReached);

    let pool_key = ctx.accounts.pool.key();
    let call = &mut ctx.accounts.call;
    call.pool = pool_key;
    call.seq = seq;
    call.kind = CallKind::NextGoal; // placeholder; overwritten by open_call
    call.state = CallState::Empty;
    call.opened_ts = 0;
    call.answer_secs = 0;
    call.num_options = 0;
    call.base_points = [0, 0, 0];
    call.outcome = OUTCOME_UNSET;
    call.bump = ctx.bumps.call;
    Ok(())
}
