use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::{MarketSettled, MarketVoided};
use crate::state::*;

#[derive(Accounts)]
pub struct Settle<'info> {
    pub settle_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market", market.fixture_id.to_le_bytes().as_ref(), market.market_id.to_le_bytes().as_ref()],
        bump = market.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: receives the fee via direct lamport credit; pinned to market.fee_recipient.
    #[account(mut, address = market.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
}

pub fn handler(
    ctx: Context<Settle>,
    winning_bucket: u8,
    settled_seq: u32,
    settled_ts: i64,
    settled_value: i32,
) -> Result<()> {
    require!(
        ctx.accounts.market.status == MarketStatus::Open,
        ProofBetError::MarketNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.market.entry_close_ts, ProofBetError::EntryNotClosed);
    require!(
        (winning_bucket as usize) < ctx.accounts.market.num_buckets as usize,
        ProofBetError::InvalidBucket
    );

    let total_pool = ctx.accounts.market.total_pool;
    let winner_total = ctx.accounts.market.bucket_totals[winning_bucket as usize];
    let fee_bps = ctx.accounts.market.fee_bps;
    let fixture_id = ctx.accounts.market.fixture_id;
    let market_id = ctx.accounts.market.market_id;

    // Zero-winner -> void (full refunds, no fee).
    if winner_total == 0 {
        let market = &mut ctx.accounts.market;
        market.status = MarketStatus::Voided;
        market.settled_seq = settled_seq;
        market.settled_ts = settled_ts;
        market.settled_value = settled_value;
        emit!(MarketVoided { market: market.key(), fixture_id, market_id, settled_seq, settled_ts });
        return Ok(());
    }

    let loser_total = total_pool
        .checked_sub(winner_total)
        .ok_or(ProofBetError::MathOverflow)?;
    let fee: u64 = (loser_total as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ProofBetError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(ProofBetError::MathOverflow)? as u64;

    if fee > 0 {
        // Direct lamport math: move fee from vault to fee_recipient.
        // The System Program cannot debit a program-owned account, so we use
        // Anchor's Lamports trait (sub_lamports / add_lamports) which calls
        // try_borrow_mut_lamports internally without conflicting with Anchor's
        // typed-account deserialization borrow.
        ctx.accounts.vault.sub_lamports(fee)?;
        ctx.accounts.fee_recipient.add_lamports(fee)?;
    }

    let market = &mut ctx.accounts.market;
    market.status = MarketStatus::Settled;
    market.winning_bucket = Some(winning_bucket);
    market.fee_collected = fee;
    market.settled_seq = settled_seq;
    market.settled_ts = settled_ts;
    market.settled_value = settled_value;

    emit!(MarketSettled {
        market: market.key(),
        fixture_id,
        market_id,
        winning_bucket,
        stat_key: market.stat_key,
        stat_key2: market.stat_key2,
        op: market.op,
        comparison: market.comparison,
        threshold: market.threshold,
        settled_seq,
        settled_ts,
        settled_value,
        fee_collected: fee,
    });
    Ok(())
}
