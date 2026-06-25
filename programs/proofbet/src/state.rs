use anchor_lang::prelude::*;

/// Bucket indices into `bucket_totals[idx]` and `Position::amounts[idx]`.
/// OVER (0) = predicate TRUE, UNDER (1) = predicate FALSE.
pub const OVER: u8 = 0;
pub const UNDER: u8 = 1;
/// Hard ceiling on the losing-pool fee (10%).
pub const MAX_FEE_BPS: u16 = 1000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MarketStatus {
    Open,
    Settled,
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BinaryOp {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub creator: Pubkey,
    pub settle_authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub fixture_id: i64,
    /// Distinguishes markets on the same fixture (0 = goals, 1 = corners).
    pub market_id: u8,
    // ── immutable predicate ──
    pub stat_key: u32,
    pub stat_key2: Option<u32>,
    pub op: Option<BinaryOp>,
    pub comparison: Comparison,
    pub threshold: i32,
    // ── lifecycle / economics ──
    /// Entry deadline in UNIX SECONDS (Clock::unix_timestamp). Bets rejected at/after.
    pub entry_close_ts: i64,
    pub fee_bps: u16,
    pub status: MarketStatus,
    pub winning_bucket: Option<u8>,
    pub bucket_totals: [u64; 2],
    pub total_pool: u64,
    pub fee_collected: u64,
    // ── proof-binding (set at settle/void) ──
    pub settled_seq: u32,
    /// The TxLINE batch minTimestamp in MILLISECONDS used to derive the
    /// Txoracle daily_scores PDA (epochDay = settled_ts / 86_400_000).
    pub settled_ts: i64,
    /// Resolved left-hand side: val_a, or (val_a op val_b) for two-stat predicates.
    /// Only meaningful when `status == Settled` (and on settle's zero-winner void).
    /// A standalone `void_market` leaves this 0 — an abandoned fixture has no stat.
    pub settled_value: i32,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Program-owned PDA that escrows pooled lamports.
/// The pool balance is the account's native lamport balance (not a stored field);
/// this struct holds only the PDA bump so the program can sign for / debit it.
#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bettor: Pubkey,
    pub amounts: [u64; 2],
    pub bump: u8,
}
