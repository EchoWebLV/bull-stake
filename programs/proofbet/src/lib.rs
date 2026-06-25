use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

#[program]
pub mod proofbet {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fixture_id: i64,
        market_id: u8,
        args: InitMarketArgs,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, fixture_id, market_id, args)
    }
}
