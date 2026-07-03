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
    // Appended at the END for the v2 jackpot-brick guard: perfect_count must not
    // exceed entry_count (a parlay can have at most entry_count perfect tickets).
    #[msg("perfect_count cannot exceed entry_count")]
    PerfectCountExceedsEntries,
    // ── Live match game (SLICE 1) — appended at the END, byte-stable ordinals ──
    #[msg("pool_id must be non-zero")]
    InvalidPoolId,
    #[msg("num_calls must be between 1 and MAX_CALLS")]
    InvalidCallCount,
    #[msg("live pool is not open for joining")]
    PoolNotOpen,
    #[msg("live pool is not open or live")]
    PoolNotLive,
    #[msg("live pool has not ended")]
    PoolNotEnded,
    #[msg("live pool is not in a terminal (claimable) state")]
    PoolNotTerminal,
    #[msg("live pool cannot be voided from its current state")]
    PoolNotVoidable,
    #[msg("joins have closed for this pool")]
    JoinClosed,
    #[msg("a call is already open; resolve it first")]
    CallStillOpen,
    #[msg("call seq must equal the cursor's next_seq")]
    CallSeqMismatch,
    #[msg("call limit reached for this pool")]
    CallLimitReached,
    #[msg("call is not open")]
    CallNotOpen,
    #[msg("call is not resolved")]
    CallNotResolved,
    #[msg("the answer window for this call has closed")]
    AnswerWindowClosed,
    #[msg("calls must be scored in order (seq == next_score_seq)")]
    ScoreOutOfOrder,
    #[msg("every seat must be scored through all resolved calls before settle")]
    NotAllScored,
    #[msg("a passed entry account failed PDA/owner/coverage binding")]
    ScoreMismatch,
    #[msg("option must be within the call's num_options")]
    InvalidOption,
    #[msg("a live pool needs at least 2 players to settle")]
    NotEnoughPlayers,
    #[msg("winner_count must be greater than zero to pay a winner")]
    WinnerCountZero,
    #[msg("call must be pre-created (Empty) before it can be opened")]
    CallNotEmpty,
    #[msg("a live pool needs at least 2 players before it can be delegated")]
    NotEnoughToDelegate,
    #[msg("pool must be Voided to refund its seats")]
    PoolNotVoided,
    #[msg("this voided pool's seats have already been refunded")]
    AlreadyRefunded,
    #[msg("Per-leg lock timestamps are inconsistent with lock_ts/settle_after_ts")]
    InvalidLegLockTs,
    #[msg("perfect_weight is inconsistent with perfect_count")]
    WeightMismatch,
}
