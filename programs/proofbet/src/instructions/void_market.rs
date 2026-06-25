use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::MarketVoided;
use crate::state::*;

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub settle_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
}

pub fn handler(ctx: Context<VoidMarket>, settled_seq: u32, settled_ts: i64) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        ProofBetError::MarketNotOpen
    );
    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Voided;
    market.settled_seq = settled_seq;
    market.settled_ts = settled_ts;
    // `settled_value` is intentionally left at its zero-initialized default:
    // an abandoned/postponed fixture has no resolved stat to record. (settle's
    // zero-winner void path does set it; claim ignores it on both paths.)

    emit!(MarketVoided {
        market: market.key(),
        fixture_id: market.fixture_id,
        market_id: market.market_id,
        settled_seq,
        settled_ts,
    });
    Ok(())
}
