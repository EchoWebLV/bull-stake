use anchor_lang::prelude::*;

use crate::contest_state::Jackpot;

#[derive(Accounts)]
pub struct InitializeJackpot<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        init,
        payer = keeper,
        space = 8 + Jackpot::INIT_SPACE,
        seeds = [b"jackpot"],
        bump
    )]
    pub jackpot: Account<'info, Jackpot>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeJackpot>) -> Result<()> {
    let j = &mut ctx.accounts.jackpot;
    j.bump = ctx.bumps.jackpot;
    Ok(())
}
