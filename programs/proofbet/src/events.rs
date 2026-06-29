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
    pub num_buckets: u8,
    pub settle_authority: Pubkey,
}

#[event]
pub struct BetPlaced {
    pub market: Pubkey,
    pub bettor: Pubkey,
    pub bucket: u8,
    pub amount: u64,
    pub bucket_totals: [u64; crate::state::MAX_BUCKETS],
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

#[event]
pub struct ContestCreated {
    pub contest: Pubkey,
    pub contest_id: u64,
    pub num_matches: u8,
    pub entry_price: u64,
    pub lock_ts: i64,
    pub settle_after_ts: i64,
    pub settle_authority: Pubkey,
}

#[event]
pub struct EnteredContest {
    pub contest: Pubkey,
    pub bettor: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub entry_count: u64,
    pub edited: bool,
}

#[event]
pub struct ContestSettled {
    pub contest: Pubkey,
    pub contest_id: u64,
    pub winning_buckets: [u8; crate::contest_state::MAX_MATCHES],
    pub perfect_count: u64,
    pub pot_snapshot: u64,
    pub distributable: u64,
    pub rake: u64,
    pub rolled_over: bool,
}

#[event]
pub struct ContestVoided {
    pub contest: Pubkey,
    pub contest_id: u64,
}

#[event]
pub struct ContestClaimed {
    pub contest: Pubkey,
    pub bettor: Pubkey,
    pub nonce: u64,
    pub payout: u64,
    /// 0 = no payout (loser/rolled), 1 = win share, 2 = void refund.
    pub kind: u8,
}
