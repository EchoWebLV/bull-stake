use anchor_lang::prelude::*;

/// Maximum legs on a single-match parlay card (3..=6 used; tail stays zero).
/// A leg is a (fixture, market_id) pair, NOT necessarily a distinct match — a v2
/// parlay reads several markets (e.g. 16/15/12/11) on the SAME fixture.
pub const MAX_LEGS: usize = 6;
/// Default 1X2 "Match Result" market_id (engine MARKET_TEMPLATE). Kept as the
/// across-match default; v2 legs each name their own market_id explicitly.
pub const RESULT_MARKET_ID: u8 = 12;
/// Grace period after `settle_after_ts` past which ANYONE may `void_contest`
/// (permissionless liveness backstop for a lost/absent keeper). Generous enough
/// to never race a live keeper, which settles within minutes of `settle_after_ts`.
pub const VOID_GRACE_SECS: i64 = 3 * 24 * 60 * 60; // 3 days
/// Minimum legs still open (unlocked) for a new entry to be accepted. Entries
/// close for the day the moment fewer than this many legs remain open — that
/// instant is precomputed at create as `entries_close_ts`.
pub const MIN_OPEN_LEGS: usize = 3;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ContestStatus {
    Open,
    Settled,
    RolledOver,
    Voided,
}

/// Singleton escrow whose lamport balance (above its own rent floor) IS the
/// rolling jackpot. Persists across every contest — that persistence is the
/// rollover. In v2 it carries NO `active_contest_id`/`reserved`: contests are
/// independent and each holds its OWN entry pot (the Contest PDA), so the only
/// cross-contest money path is this rolling pool (in on rollover, out on a win).
#[account]
#[derive(InitSpace)]
pub struct Jackpot {
    /// lamports above this PDA's rent floor == the rolling pool.
    pub bump: u8,
}

/// The Jackpot's rent-exempt minimum. NEVER part of the pool — every pool read
/// nets it out. Shared by settle_contest so the floor is computed identically.
pub fn jackpot_rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + Jackpot::INIT_SPACE))
}

#[account]
#[derive(InitSpace)]
pub struct Contest {
    pub contest_id: u64,          // unique deterministic id
    pub settle_authority: Pubkey, // keeper
    pub fee_recipient: Pubkey,    // rake destination
    pub fixtures: [i64; MAX_LEGS],
    /// market_id per leg: leg i = (fixtures[i], market_ids[i]). Indices >= num_legs
    /// stay zero. A v2 parlay reads, e.g., markets [16,15,12,11] on one fixture.
    pub market_ids: [u8; MAX_LEGS],
    pub num_legs: u8,             // 3..=MAX_LEGS (daily card uses 6)
    pub entry_price: u64,         // lamports per ticket
    pub lock_ts: i64,             // entries close (first kickoff)
    /// Per-leg entry lock (the leg's own kickoff). Indices >= num_legs stay 0.
    /// An entry's ACTIVE legs are those with leg_lock_ts[i] > entry.entry_ts.
    pub leg_lock_ts: [i64; MAX_LEGS],
    /// The moment open legs would drop below MIN_OPEN_LEGS — no entries after
    /// this. Derived at create: the (num_legs - MIN_OPEN_LEGS)-th smallest
    /// active leg_lock_ts (0-indexed). For num_legs == 3 this equals lock_ts.
    pub entries_close_ts: i64,
    pub settle_after_ts: i64,     // earliest settle (latest kickoff + buffer)
    pub fee_bps: u16,             // 500 = 5%
    pub status: ContestStatus,
    pub winning_buckets: [u8; MAX_LEGS],
    pub entry_count: u64,         // # tickets (drives new-entry rake + void refund)
    pub perfect_count: u64,       // keeper-supplied split divisor (capped at claim)
    /// Σ 2^(active legs) over all perfect entries — the weighted-split divisor
    /// (keeper-supplied at settle, same trust class as perfect_count).
    pub perfect_weight: u64,
    pub distributable: u64,       // winners' total (== payable; exactly divisible by perfect_count)
    pub claimed_count: u64,       // # winning claims paid (caps at perfect_count)
    pub claimed_total: u64,       // lamports paid out (caps at distributable)
    pub settled_ts: i64,
    pub bump: u8,
}

/// The Contest PDA HOLDS this contest's entry pot: the free pot is the account's
/// native lamport balance above its own rent floor (never a stored field).
pub fn contest_rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + Contest::INIT_SPACE))
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub bettor: Pubkey,   // Pubkey::default() until first written → new-ticket sentinel
    pub contest: Pubkey,
    pub nonce: u64,       // ticket index for this wallet in this contest
    pub picks: [u8; MAX_LEGS],
    pub amount: u64,      // lamports paid (= contest.entry_price)
    /// Unix time of the LAST picks write (init or edit). Refreshing on edit means
    /// a re-pick after a leg locks shrinks the mask instead of cheating it.
    pub entry_ts: i64,
    pub bump: u8,
}
