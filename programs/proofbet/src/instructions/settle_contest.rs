use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestSettled;
use crate::state::{Market, MarketStatus};

#[derive(Accounts)]
pub struct SettleContest<'info> {
    pub settle_authority: Signer<'info>,
    #[account(mut, seeds = [b"jackpot"], bump = jackpot.bump)]
    pub jackpot: Account<'info, Jackpot>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    // The Contest PDA holds this contest's entry pot; rake/sweep/winner-funding all
    // move lamports in or out of it directly (it is program-owned, not a CPI debit).
    pub contest: Account<'info, Contest>,
    /// CHECK: receives rake via direct lamport credit; pinned to contest.fee_recipient.
    #[account(mut, address = contest.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    // remaining_accounts: exactly `num_legs` result-market accounts, leg order.
}

pub fn handler(ctx: Context<SettleContest>, perfect_count: u64) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.contest.settle_after_ts, ProofBetError::SettleTooEarly);

    // A parlay can have at most `entry_count` perfect tickets, so a winners-settle
    // with perfect_count > entry_count is impossible. Without this guard an over-
    // reported perfect_count (the extreme: settling an EMPTY contest with
    // perfect_count >= 1) sets distributable = (pot - rake) + jackpot_pool and pulls
    // the ENTIRE shared rolling jackpot into THIS contest PDA — where, with no matching
    // Entry to claim it, no way to un-settle (void requires Open) and no sweep path,
    // those jackpot lamports are permanently bricked for every future contest. Bounding
    // to entry_count keeps an empty/under-backed contest from scooping a jackpot it can
    // never pay back. (perfect_count == 0 is the rollover path and always passes.)
    require!(
        perfect_count <= ctx.accounts.contest.entry_count,
        ProofBetError::PerfectCountExceedsEntries
    );

    let nl = ctx.accounts.contest.num_legs as usize;
    require!(
        ctx.remaining_accounts.len() == nl,
        ProofBetError::ResultMarketMismatch
    );

    // Read + verify each leg's result market (PDA-bound to (fixture, market_id)).
    let mut winning = [0u8; MAX_LEGS];
    for i in 0..nl {
        let acc = &ctx.remaining_accounts[i];
        let fixture_id = ctx.accounts.contest.fixtures[i];
        let market_id = ctx.accounts.contest.market_ids[i];
        let (expected, _) = Pubkey::find_program_address(
            &[b"market", fixture_id.to_le_bytes().as_ref(), &[market_id]],
            &crate::ID,
        );
        require_keys_eq!(acc.key(), expected, ProofBetError::ResultMarketMismatch);
        require_keys_eq!(*acc.owner, crate::ID, ProofBetError::ResultMarketMismatch);
        let data = acc.try_borrow_data()?;
        let market = Market::try_deserialize(&mut &data[..])?;
        // NOTE: no num_buckets == 3 constraint in v2 — a leg may be 2-way (O/U) or
        // 3-way (1X2). The winning bucket is read as-is from the leg's own market.
        //
        // Bind the result market's oracle to THIS contest's keeper. The result market
        // PDA ([b"market", fixture, market_id]) is permissionless to create
        // (initialize_market) and deterministic, so without this an attacker who
        // front-runs the keeper and squats the PDA with their own settle_authority
        // could `settle` each leg to whatever makes their own ticket perfect.
        // Requiring market.settle_authority == contest.settle_authority accepts ONLY
        // results settled by the contest's own keeper: a squat with a foreign
        // authority fails here (keeper then voids the contest → refunds), and a squat
        // that names the keeper as authority can only be settled BY the keeper (settle
        // has_one settle_authority) → true result.
        require_keys_eq!(
            market.settle_authority,
            ctx.accounts.contest.settle_authority,
            ProofBetError::ResultMarketMismatch
        );
        // Accept Settled OR a zero-winner Voided market that still recorded its
        // proof-determined winning_bucket (settle.rs sets it on the void). A Voided
        // market with NO bucket is a genuinely abandoned match → ok_or below fails →
        // settle_contest rejects and the keeper voids the contest instead.
        require!(
            market.status == MarketStatus::Settled || market.status == MarketStatus::Voided,
            ProofBetError::ResultMarketNotSettled
        );
        winning[i] = market.winning_bucket.ok_or(ProofBetError::ResultMarketNotSettled)?;
    }

    // ── pot = this contest's own escrowed entries (above the PDA's rent floor) ──
    let floor = contest_rent_floor()?;
    let contest_lamports = ctx.accounts.contest.to_account_info().lamports();
    let pot = contest_lamports
        .checked_sub(floor)
        .ok_or(ProofBetError::MathOverflow)?;

    // Rake on THIS contest's entries (capped at the pot). u128 mul, checked narrow.
    let new_stakes = (ctx.accounts.contest.entry_count as u128)
        .checked_mul(ctx.accounts.contest.entry_price as u128)
        .ok_or(ProofBetError::MathOverflow)?;
    let rake = u64::try_from(
        new_stakes
            .checked_mul(ctx.accounts.contest.fee_bps as u128)
            .ok_or(ProofBetError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(ProofBetError::MathOverflow)?,
    )
    .map_err(|_| ProofBetError::MathOverflow)?;
    let rake = rake.min(pot);

    // Rake: Contest (program-owned) → fee_recipient via direct lamport move.
    if rake > 0 {
        ctx.accounts.contest.sub_lamports(rake)?;
        ctx.accounts.fee_recipient.add_lamports(rake)?;
    }
    // post-rake the Contest PDA holds exactly (floor + (pot - rake)).
    let pot_net = pot.checked_sub(rake).ok_or(ProofBetError::MathOverflow)?;

    // Current rolling jackpot pool (above the jackpot PDA's own rent floor).
    let jpool = ctx
        .accounts
        .jackpot
        .to_account_info()
        .lamports()
        .checked_sub(jackpot_rent_floor()?)
        .ok_or(ProofBetError::MathOverflow)?;

    let rolled_over = perfect_count == 0;
    let mut jackpot_in: u64 = 0;
    let mut jackpot_out: u64 = 0;
    let distributable: u64;

    if rolled_over {
        // ── ROLLOVER ── the remaining (post-rake) entries roll into the jackpot.
        // Contest (program-owned) → Jackpot (program-owned), direct lamport move.
        if pot_net > 0 {
            ctx.accounts.contest.sub_lamports(pot_net)?;
            ctx.accounts.jackpot.add_lamports(pot_net)?;
        }
        jackpot_out = pot_net;
        distributable = 0;
        // Solvency (rollover): the Contest PDA must end holding exactly its rent floor
        // (the pot was fully swept). Nothing is owed to winners.
        require!(
            ctx.accounts.contest.to_account_info().lamports() >= floor,
            ProofBetError::VaultInsolvent
        );
    } else {
        // ── WINNERS ── pay net entries + the whole jackpot pool, split evenly.
        // raw = (pot - rake) + jpool ; share = floor(raw / perfect_count)
        // payable = share * perfect_count ; dust = raw - payable (stays in jackpot)
        let raw = (pot_net as u128)
            .checked_add(jpool as u128)
            .ok_or(ProofBetError::MathOverflow)?;
        let share = raw
            .checked_div(perfect_count as u128)
            .ok_or(ProofBetError::MathOverflow)?;
        let payable = u64::try_from(
            share
                .checked_mul(perfect_count as u128)
                .ok_or(ProofBetError::MathOverflow)?,
        )
        .map_err(|_| ProofBetError::MathOverflow)?;
        let dust = u64::try_from(
            raw.checked_sub(payable as u128).ok_or(ProofBetError::MathOverflow)?,
        )
        .map_err(|_| ProofBetError::MathOverflow)?;

        // The Contest PDA currently holds (pot - rake); it must end holding exactly
        // `payable`. The jackpot holds `jpool`; it must end holding `dust`. The net
        // transfer is the SIGNED delta `payable - pot_net` (== `jpool - dust`):
        //   - usual case (jpool >= dust): move (payable - pot_net) jackpot → contest.
        //   - edge case (dust > jpool, possible when pot_net is small and
        //     perfect_count is large): payable < pot_net, so the contest holds MORE
        //     than payable; move (pot_net - payable) contest → jackpot instead, which
        //     leaves the jackpot holding exactly `dust` (> jpool). Either way both
        //     ledgers land exactly right and total lamports are conserved (= raw).
        if payable >= pot_net {
            let need = payable - pot_net; // == jpool - dust, jackpot → contest
            if need > 0 {
                ctx.accounts.jackpot.sub_lamports(need)?;
                ctx.accounts.contest.add_lamports(need)?;
            }
            jackpot_in = need;
        } else {
            let give = pot_net - payable; // == dust - jpool, contest → jackpot
            ctx.accounts.contest.sub_lamports(give)?;
            ctx.accounts.jackpot.add_lamports(give)?;
            jackpot_out = give;
        }
        distributable = payable;

        // Solvency (winners): the Contest PDA must hold floor + distributable so every
        // winner's share is payable; the jackpot must stay above its own rent floor.
        require!(
            ctx.accounts.contest.to_account_info().lamports()
                >= floor.checked_add(distributable).ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
        require!(
            ctx.accounts.jackpot.to_account_info().lamports() >= jackpot_rent_floor()?,
            ProofBetError::VaultInsolvent
        );
        let _ = dust; // dust is left implicitly in the jackpot (asserted via the floor checks)
    }

    let c = &mut ctx.accounts.contest;
    c.winning_buckets = winning;
    c.perfect_count = perfect_count;
    c.distributable = distributable;
    c.settled_ts = now;
    c.status = if rolled_over { ContestStatus::RolledOver } else { ContestStatus::Settled };

    emit!(ContestSettled {
        contest: c.key(),
        contest_id: c.contest_id,
        winning_buckets: winning,
        perfect_count,
        pot,
        jackpot_in,
        jackpot_out,
        distributable,
        rake,
        rolled_over,
    });
    Ok(())
}
