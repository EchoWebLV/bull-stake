use anchor_lang::prelude::*;

pub mod contest_state;
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

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handler(ctx)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_contest(
        ctx: Context<CreateContest>,
        contest_id: u64,
        fixtures: [i64; crate::contest_state::MAX_MATCHES],
        num_matches: u8,
        entry_price: u64,
        lock_ts: i64,
        settle_after_ts: i64,
        fee_recipient: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::create_contest::handler(
            ctx, contest_id, fixtures, num_matches, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps,
        )
    }

    pub fn void_contest(ctx: Context<VoidContest>) -> Result<()> {
        instructions::void_contest::handler(ctx)
    }

    pub fn enter(ctx: Context<Enter>, nonce: u64, picks: [u8; crate::contest_state::MAX_MATCHES]) -> Result<()> {
        instructions::enter::handler(ctx, nonce, picks)
    }

    pub fn settle_contest(ctx: Context<SettleContest>, perfect_count: u64) -> Result<()> {
        instructions::settle_contest::handler(ctx, perfect_count)
    }
}
