use anchor_lang::prelude::*;
use crate::state::{BinaryOp, Comparison};

#[event]
pub struct MarketCreated {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    pub entry_close_ts: i64,
    pub fee_bps: u16,
    pub settle_authority: Pubkey,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub bucket: u8,
    pub amount: u64,
    pub bucket_totals: [u64; 2],
    pub total_pool: u64,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,
    pub winning_bucket: u8,
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    pub settled_seq: u32,
    /// TxLINE batch minTimestamp in MILLISECONDS (not seconds); derives the
    /// Txoracle daily_scores PDA via epochDay = settled_ts / 86_400_000.
    pub settled_ts: i64,
    pub settled_value: i32,
    pub fee_collected: u64,
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
    pub fixture_id: i64,
    pub market_id: u8,
    pub settled_seq: u32,
    /// TxLINE batch minTimestamp in MILLISECONDS (not seconds).
    pub settled_ts: i64,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub payout: u64,
    pub voided: bool,
}
