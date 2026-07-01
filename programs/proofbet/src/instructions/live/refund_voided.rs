use anchor_lang::prelude::*;

use crate::errors::ProofBetError;
use crate::events::LivePoolRefunded;
use crate::live_state::*;

/// Permissionless, all-seats, single-shot refund for a **Voided** pool whose
/// entries are still **delegated** to an Ephemeral Rollup.
///
/// Why this exists (Slice 2b / Finding [2]): `claim_live_pool`'s Voided branch
/// declares the seat as `Account<'info, LiveEntry>`, which enforces
/// `owner == crate::ID`. A delegated entry is owned by the Delegation Program, so
/// that owner check reverts and the per-seat refund path freezes if the keeper
/// dies mid-match. The 2b devnet probe proved a delegated entry's DATA stays fully
/// readable on the base layer (only `.owner` flips) — so this instruction reads
/// every seat as a raw `AccountInfo` (no owner check), deserializes it manually,
/// binds it by PDA re-derivation (identical to `settle_live_pool`), and pays each
/// seat its `entry_price` from the **never-delegated** `LivePool`. Custody never
/// leaves the base layer, so the pot is always spendable here regardless of the
/// entries' delegation state.
///
/// `remaining_accounts` = interleaved `[entry_0, player_0, entry_1, player_1, …]`,
/// entries **strictly ascending by key**, exactly `player_count` pairs. Ascending
/// + coverage == every distinct real seat (a duplicate would break monotonicity),
/// so no seat can be paid twice and none omitted. The paired wallet must equal the
/// seat's stored `player`, so a refund can only ever reach its rightful owner.
#[derive(Accounts)]
pub struct RefundVoided<'info> {
    /// Permissionless: anyone may crank the refund (they only pay the tx fee; the
    /// money can only flow to each seat's bound player). Mut = fee payer.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"livepool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    // LivePool escrows the pot and is never delegated, so this refund always runs
    // on the base layer.
    pub pool: Account<'info, LivePool>,
    // remaining_accounts: [entry, player] pairs — see the struct doc.
}

pub fn handler(ctx: Context<RefundVoided>) -> Result<()> {
    require!(ctx.accounts.pool.status == PoolStatus::Voided, ProofBetError::PoolNotVoided);
    // Single-shot: once refunded, `claimed_count` is set to `player_count`; a second
    // call fails fast here (and would fail the solvency check anyway — the pot is
    // already drained to the rent floor).
    require!(ctx.accounts.pool.claimed_count == 0, ProofBetError::AlreadyRefunded);

    let pool_key = ctx.accounts.pool.key();
    let player_count = ctx.accounts.pool.player_count;
    let floor = live_pool_rent_floor()?;

    // Copy the slice ref (Copy) so `ctx.accounts.pool` stays independently borrowable.
    let ras: &[AccountInfo] = ctx.remaining_accounts;
    // Coverage by count: exactly one [entry, player] pair per seat.
    require!(
        ras.len() == (player_count as usize).checked_mul(2).ok_or(ProofBetError::MathOverflow)?,
        ProofBetError::ScoreMismatch
    );

    let mut prev: Option<Pubkey> = None;
    let mut total: u64 = 0;
    let mut i = 0usize;
    while i < ras.len() {
        let entry_ai = &ras[i];
        let player_ai = &ras[i + 1];
        i += 2;

        // Distinctness: strictly-ascending entry keys ⇒ every seat is unique. With
        // the count check above this makes the set provably all-seats, no dupes.
        let ekey = entry_ai.key();
        require!(prev.map_or(true, |p| ekey > p), ProofBetError::ScoreMismatch);
        prev = Some(ekey);

        // Deserialize the seat WITHOUT an owner check — a delegated entry is owned
        // by the Delegation Program, but its bytes are readable on base (proven 2b).
        let entry = {
            let data = entry_ai.try_borrow_data()?;
            LiveEntry::try_deserialize(&mut &data[..])?
        };

        // Bind: real LiveEntry PDA for its stored player, in THIS pool.
        require_keys_eq!(entry.pool, pool_key, ProofBetError::ScoreMismatch);
        let (expected, _) = Pubkey::find_program_address(
            &[b"liveentry", pool_key.as_ref(), entry.player.as_ref()],
            &crate::ID,
        );
        require_keys_eq!(entry_ai.key(), expected, ProofBetError::ScoreMismatch);
        // The paired wallet must be the seat's own player (refund can't be redirected).
        require_keys_eq!(player_ai.key(), entry.player, ProofBetError::ScoreMismatch);
        require!(player_ai.is_writable, ProofBetError::ScoreMismatch);

        // Refund the stake (== entry_price for every seat by the init-not-if-needed
        // invariant) from the pot to the seat's player.
        let amount = entry.amount;
        ctx.accounts.pool.sub_lamports(amount)?;
        player_ai.add_lamports(amount)?;
        total = total.checked_add(amount).ok_or(ProofBetError::MathOverflow)?;
    }

    // Solvency: the PDA must still hold at least its own rent floor. Since
    // pot == player_count * entry_price exactly, a full refund lands it at `floor`;
    // this guard also blocks any attempt to over-refund (e.g. a partially-claimed pot).
    require!(
        ctx.accounts.pool.to_account_info().lamports() >= floor,
        ProofBetError::VaultInsolvent
    );

    // Mark single-shot (mirrors the settled path's claimed_* bookkeeping).
    {
        let pool = &mut ctx.accounts.pool;
        pool.claimed_count = player_count;
        pool.claimed_total = total;
    }

    emit!(LivePoolRefunded {
        pool: pool_key,
        pool_id: ctx.accounts.pool.pool_id,
        seats: player_count,
        total,
    });
    Ok(())
}
