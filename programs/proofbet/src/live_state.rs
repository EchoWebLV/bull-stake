use anchor_lang::prelude::*;

/* ──────────────────────────────────────────────────────────────────────────
 * Streak — LIVE match game on-chain state (SLICE 1, base layer only).
 *
 * A per-match SOL pot: players join before kickoff; during the match the keeper
 * opens rapid "calls" (next goal / corner / booking / goal rush); players lock a
 * pick per call; the keeper resolves each call from the feed; points accrue
 * (rarity base + a 3-in-a-row streak escalator, a miss wipes the bonus keeps the
 * base); at full-time MOST POINTS wins the pot (ties split). See the design doc
 * docs/superpowers/specs/2026-07-01-streak-live-onchain-magicblock.md.
 *
 * Custody model mirrors Contest EXACTLY: the LivePool PDA holds the pot as native
 * lamports above its own rent floor (never a stored balance). Winner is
 * recomputed ON-CHAIN at settle over every seat — the keeper never declares it.
 *
 * SLICE 1 runs everything on the base layer. SLICE 2 relocates open/lock/resolve/
 * score onto a MagicBlock Ephemeral Rollup (delegating LiveCursor + LiveEntry +
 * Call, never LivePool); the logic here is unchanged.
 * ──────────────────────────────────────────────────────────────────────── */

/// Safety cap on calls per match (real matches use ~20–40). Bounds the per-seat
/// `picks` array and the call cursor.
pub const MAX_CALLS: usize = 64;
/// Sentinel written to `Call.outcome` on a global void (a disqualifying event
/// landed while a non-goal call was open — no penalty, no gain for anyone).
pub const VOID_OUTCOME: u8 = 0xFE;
/// `Call.outcome` before resolution.
pub const OUTCOME_UNSET: u8 = 0xFF;
/// `LiveEntry.picks[seq]` when the seat never locked a pick for call `seq`.
pub const NO_PICK: u8 = 0xFF;
/// `LiveCursor.open_seq` when no call is currently open for taps.
pub const NONE_SEQ: u32 = u32::MAX;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PoolStatus {
    Open,       // joining
    Live,       // calls happening
    Ended,      // full-time reached; awaiting settle
    Settled,    // winners paid on claim
    RolledOver, // nobody scored → pot swept to jackpot
    Voided,     // refund path
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CallKind {
    NextGoal,
    GoalRush,
    CornerSoon,
    CardSoon,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CallState {
    Empty,    // reserved for SLICE 2 pre-created calls; unused on base layer
    Open,     // accepting taps
    Resolved, // outcome posted
    Voided,   // globally voided — scored as a no-op for every seat
}

/// The pot + terminal state. **Base-layer only, never delegated.** Its lamport
/// balance above the rent floor IS the pot (like Contest). Seeds:
/// `[b"livepool", pool_id.to_le_bytes()]`.
#[account]
#[derive(InitSpace)]
pub struct LivePool {
    pub pool_id: u64,             // deterministic id (engine uses fixture_id)
    pub fixture_id: i64,          // the single match
    pub settle_authority: Pubkey, // keeper: opens/resolves calls, ends, settles
    pub fee_recipient: Pubkey,    // rake destination
    pub entry_price: u64,         // lamports per seat
    pub lock_ts: i64,             // joins close (kickoff)
    pub settle_after_ts: i64,     // earliest settle (FT + buffer)
    pub fee_bps: u16,             // rake bps (<= MAX_FEE_BPS)
    pub status: PoolStatus,
    pub num_calls: u32,           // max calls this pool may open (<= MAX_CALLS)
    pub player_count: u64,        // # seats (drives rake + void refund)
    pub winning_score: u64,       // set at settle: recomputed max(total) ON-CHAIN
    pub winner_count: u64,        // set at settle: |{total == winning_score}| ON-CHAIN
    pub distributable: u64,       // winners' total (== winner_count * share)
    pub claimed_count: u64,       // caps at winner_count
    pub claimed_total: u64,       // caps at distributable
    pub settled_ts: i64,
    pub bump: u8,
}

/// The LivePool PDA HOLDS this pool's pot: the free pot is the account's native
/// lamport balance above its own rent floor (never a stored field). Exact clone
/// of `contest_rent_floor`.
pub fn live_pool_rent_floor() -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(8 + LivePool::INIT_SPACE))
}

/// The live call cursor. Delegated to the ER alongside entries in SLICE 2; holds
/// no lamports beyond its own rent. Seeds: `[b"livecursor", pool_key]`.
#[account]
#[derive(InitSpace)]
pub struct LiveCursor {
    pub pool: Pubkey,
    pub next_seq: u32,       // next call index to open (monotonic)
    pub open_seq: u32,       // call currently open for taps (NONE_SEQ = none)
    pub resolved_count: u32, // # calls resolved/voided (== settle coverage bound)
    pub bump: u8,
}

/// One call window + its resolved outcome. Seeds: `[b"call", pool_key, seq]`.
#[account]
#[derive(InitSpace)]
pub struct Call {
    pub pool: Pubkey,
    pub seq: u32,
    pub kind: CallKind,
    pub state: CallState,
    pub opened_ts: i64,       // answer-window anchor
    pub answer_secs: u16,     // tap window
    pub num_options: u8,      // 2 or 3
    pub base_points: [u8; 3], // per-option base (e.g. [4,1,4] / [2,1,0])
    pub outcome: u8,          // winning option index; OUTCOME_UNSET / VOID_OUTCOME sentinels
    pub bump: u8,
}

/// A seat + running score. The account the ER mutates on every tap-resolve in
/// SLICE 2. Seeds: `[b"liveentry", pool_key, player_key]`. One seat per (pool,
/// player) — created with `init` (not `init_if_needed`), so the invariant
/// `pot == player_count * entry_price` holds exactly (the void-refund solvency
/// check depends on it).
#[account]
#[derive(InitSpace)]
pub struct LiveEntry {
    pub player: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,             // lamports paid (== entry_price)
    // running score: total = base_pts + bonus_pts
    pub base_pts: u32,
    pub bonus_pts: u32,
    pub streak: u16,             // current run of hits
    pub next_score_seq: u32,     // next call index to fold (sequential-scoring guard)
    /// Per-call locked option; `NO_PICK` = never locked. Indexed by call seq.
    /// A full per-call array (not a single pending slot) so a later tap never
    /// clobbers an earlier, not-yet-scored pick.
    pub picks: [u8; MAX_CALLS],
    pub bump: u8,
}
