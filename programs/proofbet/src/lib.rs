use anchor_lang::prelude::*;

declare_id!("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

#[program]
pub mod proofbet {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
