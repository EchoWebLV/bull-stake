use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod contest_state;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod live_state;
pub mod state;

use instructions::*;

declare_id!("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

#[ephemeral]
#[program]
pub mod proofbet {
    use super::*;

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        fixture_id: i64,
        market_id: u8,
        args: InitMarketArgs,
    ) -> Result<()> {
        instructions::initialize_market::handler(ctx, fixture_id, market_id, args)
    }

    pub fn place_bet(ctx: Context<PlaceBet>, bucket: u8, amount: u64) -> Result<()> {
        instructions::place_bet::handler(ctx, bucket, amount)
    }

    pub fn settle(
        ctx: Context<Settle>,
        winning_bucket: u8,
        settled_seq: u32,
        settled_ts: i64,
        settled_value: i32,
    ) -> Result<()> {
        instructions::settle::handler(ctx, winning_bucket, settled_seq, settled_ts, settled_value)
    }

    pub fn void_market(ctx: Context<VoidMarket>, settled_seq: u32, settled_ts: i64) -> Result<()> {
        instructions::void_market::handler(ctx, settled_seq, settled_ts)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::claim::handler(ctx)
    }

    pub fn initialize_jackpot(ctx: Context<InitializeJackpot>) -> Result<()> {
        instructions::initialize_jackpot::handler(ctx)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_contest(
        ctx: Context<CreateContest>,
        contest_id: u64,
        fixtures: [i64; crate::contest_state::MAX_LEGS],
        market_ids: [u8; crate::contest_state::MAX_LEGS],
        num_legs: u8,
        entry_price: u64,
        lock_ts: i64,
        settle_after_ts: i64,
        fee_recipient: Pubkey,
        fee_bps: u16,
        leg_lock_ts: [i64; crate::contest_state::MAX_LEGS],
    ) -> Result<()> {
        instructions::create_contest::handler(
            ctx, contest_id, fixtures, market_ids, num_legs, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps,
            leg_lock_ts,
        )
    }

    pub fn void_contest(ctx: Context<VoidContest>) -> Result<()> {
        instructions::void_contest::handler(ctx)
    }

    pub fn enter(ctx: Context<Enter>, nonce: u64, picks: [u8; crate::contest_state::MAX_LEGS]) -> Result<()> {
        instructions::enter::handler(ctx, nonce, picks)
    }

    pub fn settle_contest(ctx: Context<SettleContest>, perfect_count: u64, perfect_weight: u64) -> Result<()> {
        instructions::settle_contest::handler(ctx, perfect_count, perfect_weight)
    }

    pub fn claim_contest(ctx: Context<ClaimContest>) -> Result<()> {
        instructions::claim_contest::handler(ctx)
    }

    // ── Live match game (SLICE 1 — base layer) ────────────────────────────────
    #[allow(clippy::too_many_arguments)]
    pub fn create_live_pool(
        ctx: Context<CreateLivePool>,
        pool_id: u64,
        fixture_id: i64,
        entry_price: u64,
        lock_ts: i64,
        settle_after_ts: i64,
        fee_recipient: Pubkey,
        fee_bps: u16,
        num_calls: u32,
    ) -> Result<()> {
        instructions::live::create_live_pool::handler(
            ctx, pool_id, fixture_id, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps, num_calls,
        )
    }

    pub fn join_live_pool(ctx: Context<JoinLivePool>) -> Result<()> {
        instructions::live::join_live_pool::handler(ctx)
    }

    pub fn prealloc_call(ctx: Context<PreallocCall>, seq: u32) -> Result<()> {
        instructions::live::prealloc_call::handler(ctx, seq)
    }

    pub fn open_call(
        ctx: Context<OpenCall>,
        seq: u32,
        kind: crate::live_state::CallKind,
        num_options: u8,
        base_points: [u8; 3],
        answer_secs: u16,
    ) -> Result<()> {
        instructions::live::open_call::handler(ctx, seq, kind, num_options, base_points, answer_secs)
    }

    pub fn lock_pick(ctx: Context<LockPick>, option: u8) -> Result<()> {
        instructions::live::lock_pick::handler(ctx, option)
    }

    pub fn resolve_call(ctx: Context<ResolveCall>, outcome: u8) -> Result<()> {
        instructions::live::resolve_call::handler(ctx, outcome)
    }

    pub fn score_entry(ctx: Context<ScoreEntry>) -> Result<()> {
        instructions::live::score_entry::handler(ctx)
    }

    pub fn end_live_pool(ctx: Context<EndLivePool>) -> Result<()> {
        instructions::live::end_live_pool::handler(ctx)
    }

    pub fn settle_live_pool(ctx: Context<SettleLivePool>) -> Result<()> {
        instructions::live::settle_live_pool::handler(ctx)
    }

    pub fn claim_live_pool(ctx: Context<ClaimLivePool>) -> Result<()> {
        instructions::live::claim_live_pool::handler(ctx)
    }

    pub fn void_live_pool(ctx: Context<VoidLivePool>) -> Result<()> {
        instructions::live::void_live_pool::handler(ctx)
    }

    /// Permissionless all-seats refund for a Voided pool whose entries are still
    /// delegated (the keeper-death case `claim_live_pool` can't handle). See
    /// `refund_voided.rs`. remaining_accounts = [entry, player] pairs.
    pub fn refund_voided(ctx: Context<RefundVoided>) -> Result<()> {
        instructions::live::refund_voided::handler(ctx)
    }

    // ── MagicBlock Ephemeral Rollup layer (SLICE 2) ──────────────────────────
    // Delegate the score-carrying PDAs (cursor / entries / calls) to the ER so
    // taps are cheap+fast; LivePool (the pot) is never delegated. Runtime-proven
    // on devnet (needs the ER validator); these entrypoints establish the surface.
    pub fn delegate_cursor(ctx: Context<DelegateLiveAccount>) -> Result<()> {
        instructions::live::delegate_live::delegate_cursor_handler(ctx)
    }

    pub fn delegate_entry(ctx: Context<DelegateLiveAccount>, player: Pubkey) -> Result<()> {
        instructions::live::delegate_live::delegate_entry_handler(ctx, player)
    }

    pub fn delegate_call(ctx: Context<DelegateLiveAccount>, seq: u32) -> Result<()> {
        instructions::live::delegate_live::delegate_call_handler(ctx, seq)
    }

    pub fn commit_live<'info>(
        ctx: Context<'_, '_, '_, 'info, CommitLive<'info>>,
    ) -> Result<()> {
        instructions::live::commit_live::commit_live_handler(ctx)
    }

    pub fn end_and_undelegate<'info>(
        ctx: Context<'_, '_, '_, 'info, CommitLive<'info>>,
    ) -> Result<()> {
        instructions::live::commit_live::end_and_undelegate_handler(ctx)
    }
}
