use anchor_lang::prelude::*;

use crate::contest_state::*;
use crate::errors::ProofBetError;
use crate::events::ContestSettled;
use crate::state::{Market, MarketStatus};

#[derive(Accounts)]
pub struct SettleContest<'info> {
    pub settle_authority: Signer<'info>,
    #[account(mut, seeds = [b"jackpot_vault"], bump = vault.bump)]
    pub vault: Account<'info, JackpotVault>,
    #[account(
        mut,
        seeds = [b"contest", contest.contest_id.to_le_bytes().as_ref()],
        bump = contest.bump,
        has_one = settle_authority @ ProofBetError::Unauthorized,
    )]
    pub contest: Account<'info, Contest>,
    /// CHECK: receives rake via direct lamport credit; pinned to contest.fee_recipient.
    #[account(mut, address = contest.fee_recipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    // remaining_accounts: exactly `num_matches` result-market accounts, card order.
}

pub fn handler(ctx: Context<SettleContest>, perfect_count: u64) -> Result<()> {
    require!(
        ctx.accounts.contest.status == ContestStatus::Open,
        ProofBetError::ContestNotOpen
    );
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.contest.settle_after_ts, ProofBetError::SettleTooEarly);

    let nm = ctx.accounts.contest.num_matches as usize;
    require!(
        ctx.remaining_accounts.len() == nm,
        ProofBetError::ResultMarketMismatch
    );

    // Read + verify each card match's result market (PDA-bound to the fixture).
    let mut winning = [0u8; MAX_MATCHES];
    for i in 0..nm {
        let acc = &ctx.remaining_accounts[i];
        let fixture_id = ctx.accounts.contest.fixtures[i];
        let (expected, _) = Pubkey::find_program_address(
            &[b"market", fixture_id.to_le_bytes().as_ref(), &[RESULT_MARKET_ID]],
            &crate::ID,
        );
        require_keys_eq!(acc.key(), expected, ProofBetError::ResultMarketMismatch);
        require_keys_eq!(*acc.owner, crate::ID, ProofBetError::ResultMarketMismatch);
        let data = acc.try_borrow_data()?;
        let market = Market::try_deserialize(&mut &data[..])?;
        require!(
            market.num_buckets == crate::state::MAX_BUCKETS as u8,
            ProofBetError::ResultMarketMismatch
        );
        // Bind the result market's oracle to THIS contest's keeper. The result
        // market PDA ([b"market", fixture, RESULT_MARKET_ID]) is permissionless to
        // create (initialize_market) and deterministic, so without this an attacker
        // who front-runs the keeper and squats the PDA with their own
        // settle_authority could `settle` each leg to whatever makes their own
        // ticket the perfect line. Requiring market.settle_authority ==
        // contest.settle_authority accepts ONLY results settled by the contest's own
        // keeper: a squat with a foreign authority fails here (keeper then voids the
        // contest → refunds), and a squat that names the keeper as authority can only
        // be settled BY the keeper (settle has_one settle_authority) → true result.
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

    let floor = vault_rent_floor()?;
    let reserved = ctx.accounts.vault.reserved;
    let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
    // The free pot nets out BOTH the rent floor and lamports already owed to prior
    // terminal contests (reserved) — that free balance is all this contest may touch.
    let pot_snapshot = vault_lamports.saturating_sub(floor).saturating_sub(reserved);

    // Rake on THIS contest's new entries only (never the rolled-in pot).
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
    let rake = rake.min(pot_snapshot);

    if rake > 0 {
        ctx.accounts.vault.sub_lamports(rake)?;
        ctx.accounts.fee_recipient.add_lamports(rake)?;
        // Prior contests' owed funds must still be covered after the rake debit.
        require!(
            ctx.accounts.vault.to_account_info().lamports()
                >= floor.checked_add(reserved).ok_or(ProofBetError::MathOverflow)?,
            ProofBetError::VaultInsolvent
        );
    }

    ctx.accounts.vault.active_contest_id = 0;

    let rolled_over = perfect_count == 0;
    let distributable = if rolled_over {
        0
    } else {
        pot_snapshot.checked_sub(rake).ok_or(ProofBetError::MathOverflow)?
    };

    // Settled (winner): fence the payable amount (share * perfect_count) as a
    // cross-contest liability so the next contest can't roll lamports owed to this
    // contest's winners. Floor-division dust is NOT reserved — it stays free and
    // rolls forward. RolledOver owes no one, so reserved is unchanged.
    //
    // perfect_count is keeper-supplied (trust model, §9). The reserve/claim machinery
    // bounds both error directions WITHOUT risking other contests' funds:
    //   - UNDER-report (fewer winners declared than real): extra perfect tickets hit
    //     the claim cap (claimed_count < perfect_count) and revert — early claimers
    //     over-collect, but no cross-contest drain. (Tested in contest_safety.ts.)
    //   - OVER-report (more declared than real): unclaimed phantom shares stay fenced
    //     in `reserved` forever — those lamports remain in the vault (no loss) but do
    //     NOT roll into a future pot. Acceptable under the trust model; an exact
    //     keeper avoids it. Both are bounded to THIS contest's own distributable.
    if !rolled_over {
        let share = u64::try_from(
            (distributable as u128)
                .checked_div(perfect_count as u128)
                .ok_or(ProofBetError::MathOverflow)?,
        )
        .map_err(|_| ProofBetError::MathOverflow)?;
        let payable = share.checked_mul(perfect_count).ok_or(ProofBetError::MathOverflow)?;
        ctx.accounts.vault.reserved = ctx
            .accounts
            .vault
            .reserved
            .checked_add(payable)
            .ok_or(ProofBetError::MathOverflow)?;
    }
    // Global solvency invariant holds after reserving (by construction it must).
    require!(
        ctx.accounts.vault.to_account_info().lamports()
            >= floor
                .checked_add(ctx.accounts.vault.reserved)
                .ok_or(ProofBetError::MathOverflow)?,
        ProofBetError::VaultInsolvent
    );

    let c = &mut ctx.accounts.contest;
    c.winning_buckets = winning;
    c.perfect_count = perfect_count;
    c.pot_snapshot = pot_snapshot;
    c.distributable = distributable;
    c.settled_ts = now;
    c.status = if rolled_over { ContestStatus::RolledOver } else { ContestStatus::Settled };

    emit!(ContestSettled {
        contest: c.key(),
        contest_id: c.contest_id,
        winning_buckets: winning,
        perfect_count,
        pot_snapshot,
        distributable,
        rake,
        rolled_over,
    });
    Ok(())
}
