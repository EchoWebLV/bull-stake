use anchor_lang::prelude::*;

#[error_code]
pub enum ProofBetError {
    #[msg("entry_close_ts must be in the future")]
    EntryCloseInPast,
    #[msg("fee_bps exceeds the maximum allowed")]
    FeeTooHigh,
    #[msg("stat_key2 and op must both be set or both be None")]
    PredicateMismatch,
    #[msg("market is not open")]
    MarketNotOpen,
    #[msg("entry window has closed")]
    EntryClosed,
    #[msg("entry window is still open")]
    EntryNotClosed,
    #[msg("invalid bucket for this market's outcome count")]
    InvalidBucket,
    #[msg("bet amount must be greater than zero")]
    ZeroAmount,
    #[msg("market is not in a claimable state")]
    NotClaimable,
    #[msg("signer is not authorized for this action")]
    Unauthorized,
    #[msg("arithmetic overflow")]
    MathOverflow,
    #[msg("contest is not open")]
    ContestNotOpen,
    #[msg("contest is not in a terminal (claimable) state")]
    ContestNotTerminal,
    #[msg("a contest is already live; settle or void it first")]
    ContestStillLive,
    #[msg("contest_id must be non-zero")]
    InvalidContestId,
    #[msg("too early to settle this contest")]
    SettleTooEarly,
    #[msg("num_matches must be between 3 and 5")]
    InvalidMatchCount,
    #[msg("pick must be 0/1/2 within num_matches and 0 beyond it")]
    InvalidPick,
    #[msg("result market account does not match the card fixture")]
    ResultMarketMismatch,
    #[msg("result market is not settled")]
    ResultMarketNotSettled,
    #[msg("perfect_count must be greater than zero to pay a winner")]
    PerfectCountZero,
    #[msg("vault would drop below its rent floor or exceed distributable")]
    VaultInsolvent,
    #[msg("fixture_id must be non-zero for each carded match")]
    InvalidFixtureId,
    // Appended here (not mid-enum) so that, relative to `main`'s error enum, every
    // pre-existing parimutuel code keeps its ordinal: on `main` the order is
    // ...InvalidBucket, ZeroAmount, NotClaimable, Unauthorized, MathOverflow (no
    // InvalidBucketCount). Anchor assigns codes by ordinal, so appending ALL new
    // variants (the Contest* errors above + InvalidBucketCount) after MathOverflow
    // keeps ZeroAmount..MathOverflow byte-stable for off-chain/IDL consumers.
    #[msg("num_buckets must be 2 (binary) or 3 (three-way)")]
    InvalidBucketCount,
    // Appended at the END (after InvalidBucketCount) for the v2 per-leg market_id
    // guard, so every pre-existing ordinal stays byte-stable for IDL consumers.
    #[msg("market_id must be non-zero for each carded leg")]
    InvalidMarketId,
}
