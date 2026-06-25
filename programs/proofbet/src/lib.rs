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

    pub fn place_bet(ctx: Context<PlaceBet>, bucket: u8, amount: u64) -> Result<()> {
        instructions::place_bet::handler(ctx, bucket, amount)
    }

    pub fn settle(
        ctx: Context<Settle>,
        winning_bucket: u8,
        settled_seq: u32,
        settled_ts: i64,
        settled_value: i32,
    ) -> Result<()> {
        instructions::settle::handler(ctx, winning_bucket, settled_seq, settled_ts, settled_value)
    }

    pub fn void_market(ctx: Context<VoidMarket>, settled_seq: u32, settled_ts: i64) -> Result<()> {
        instructions::void_market::handler(ctx, settled_seq, settled_ts)
    }
}
