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
    #[msg("invalid bucket (must be 0 or 1)")]
    InvalidBucket,
    #[msg("bet amount must be greater than zero")]
    ZeroAmount,
    #[msg("market is not in a claimable state")]
    NotClaimable,
    #[msg("signer is not authorized for this action")]
    Unauthorized,
    #[msg("arithmetic overflow")]
    MathOverflow,
}
