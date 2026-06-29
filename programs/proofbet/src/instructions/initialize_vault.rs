use anchor_lang::prelude::*;

use crate::contest_state::JackpotVault;

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(
        init,
        payer = keeper,
        space = 8 + JackpotVault::INIT_SPACE,
        seeds = [b"jackpot_vault"],
        bump
    )]
    pub vault: Account<'info, JackpotVault>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeVault>) -> Result<()> {
    let v = &mut ctx.accounts.vault;
    v.active_contest_id = 0;
    v.reserved = 0;
    v.bump = ctx.bumps.vault;
    Ok(())
}
