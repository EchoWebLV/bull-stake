use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::MarketCreated;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitMarketArgs {
    pub settle_authority: Pubkey,
    pub fee_recipient: Option<Pubkey>,
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    pub entry_close_ts: i64,
    pub fee_bps: u16,
}

#[derive(Accounts)]
#[instruction(fixture_id: i64, market_id: u8, args: InitMarketArgs)]
pub struct InitializeMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", fixture_id.to_le_bytes().as_ref(), market_id.to_le_bytes().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", market.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitializeMarket>,
    fixture_id: i64,
    market_id: u8,
    args: InitMarketArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.entry_close_ts > now, ProofBetError::EntryCloseInPast);
    require!(args.fee_bps <= MAX_FEE_BPS, ProofBetError::FeeTooHigh);
    require!(
        args.stat_key2.is_some() == args.op.is_some(),
        ProofBetError::PredicateMismatch
    );

    let creator_key = ctx.accounts.creator.key();
    let market = &mut ctx.accounts.market;
    market.creator = creator_key;
    market.settle_authority = args.settle_authority;
    market.fee_recipient = args.fee_recipient.unwrap_or(creator_key);
    market.fixture_id = fixture_id;
    market.market_id = market_id;
    market.stat_key = args.stat_key;
    market.stat_key2 = args.stat_key2;
    market.op = args.op;
    market.comparison = args.comparison;
    market.threshold = args.threshold;
    market.entry_close_ts = args.entry_close_ts;
    market.fee_bps = args.fee_bps;
    market.status = MarketStatus::Open;
    market.winning_bucket = None;
    market.bucket_totals = [0, 0];
    market.total_pool = 0;
    market.fee_collected = 0;
    market.settled_seq = 0;
    market.settled_ts = 0;
    market.settled_value = 0;
    market.bump = ctx.bumps.market;
    market.vault_bump = ctx.bumps.vault;

    ctx.accounts.vault.bump = ctx.bumps.vault;

    // Emit from `args` (all Copy) rather than re-reading the just-written
    // market, so the event can't silently drift if assignments are reordered.
    emit!(MarketCreated {
        market: market.key(),
        fixture_id,
        market_id,
        stat_key: args.stat_key,
        stat_key2: args.stat_key2,
        op: args.op,
        comparison: args.comparison,
        threshold: args.threshold,
        entry_close_ts: args.entry_close_ts,
        fee_bps: args.fee_bps,
        settle_authority: args.settle_authority,
    });
    Ok(())
}
