use anchor_lang::prelude::*;

/// Maximum matches on a sweepstake card (3..=5 used; tail stays zero).
pub const MAX_MATCHES: usize = 5;
/// market_id of the per-fixture 1X2 "Match Result" market (engine MARKET_TEMPLATE).
/// settle_contest reads each card match's winning bucket from this 3-bucket market.
pub const RESULT_MARKET_ID: u8 = 12;
/// Grace period after `settle_after_ts` past which ANYONE may `void_contest`
/// (permissionless liveness backstop for a lost/absent keeper). Generous enough
/// to never race a live keeper, which settles within minutes of `settle_after_ts`.
pub const VOID_GRACE_SECS: i64 = 3 * 24 * 60 * 60; // 3 days

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ContestStatus {
    Open,
    Settled,
    RolledOver,
    Voided,
}

/// Singleton escrow whose lamport balance (above its own rent floor) IS the
/// rolling jackpot. Persists across every contest — that persistence is the rollover.
#[account]
#[derive(InitSpace)]
pub struct JackpotVault {
    /// contest_id of the live contest, or 0 when none is live (one-at-a-time guard).
    pub active_contest_id: u64,
    /// Lamports owed to ALREADY-TERMINAL contests' unclaimed tickets (winner shares
    /// not yet claimed, void refunds not yet claimed). Every pot read nets this out:
    /// free pot = lamports − rent_floor − reserved. This fences a prior contest's
    /// money so the next contest can never roll (and over-promise) lamports that are
    /// still owed — the cross-contest solvency invariant. += at settle/void by what
    /// will be paid; −= on each claim/refund.
    pub reserved: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Contest {
    pub contest_id: u64,          // epoch day at open; unique deterministic id
    pub settle_authority: Pubkey, // keeper
    pub fee_recipient: Pubkey,    // rake destination
    pub fixtures: [i64; MAX_MATCHES],
    pub num_matches: u8,          // 3..=5
    pub entry_price: u64,         // lamports per ticket
    pub lock_ts: i64,             // entries close (first kickoff)
    pub settle_after_ts: i64,     // earliest settle (latest kickoff + buffer)
    pub fee_bps: u16,             // 500 = 5%
    pub status: ContestStatus,
    pub winning_buckets: [u8; MAX_MATCHES],
    pub entry_count: u64,         // # tickets (drives new-entry rake + void refund)
    pub perfect_count: u64,       // keeper-supplied split divisor (capped at claim)
    pub pot_snapshot: u64,        // net pot (vault.lamports - rent_floor - reserved) at settle
    pub distributable: u64,       // pot_snapshot - rake, stored so every claim reads one value
    pub claimed_count: u64,       // # winning claims paid (caps at perfect_count)
    pub claimed_total: u64,       // lamports paid out (caps at distributable)
    pub settled_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub bettor: Pubkey,   // Pubkey::default() until first written → new-ticket sentinel
    pub contest: Pubkey,
    pub nonce: u64,       // ticket index for this wallet in this contest
    pub picks: [u8; MAX_MATCHES],
    pub amount: u64,      // lamports paid (= contest.entry_price)
    pub bump: u8,
}
