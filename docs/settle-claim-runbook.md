# Settle + Claim Runbook (daily sweepstake)

Operational steps to close out a daily Streak contest: settle each match's result
market, settle the contest, then let winners claim. Written for the live devnet
contest **20635** (locks `2026-07-01T01:00Z`, 4 carded matches), but the flow is
the same for any contest.

The mechanism (program `settle_contest`/`claim_contest`, keeper `settle-contest.ts`,
web Claim button) is already built and unit/integration tested. This runbook is the
operator checklist for running it against real, finished matches.

---

## 0. Preconditions

- [ ] **All carded matches are final.** Every fixture in the contest has reached a
      finished phase on TxLINE (FT). Check the board / `getScoreHistory`. A match
      still in play cannot be settled.
- [ ] **TxLINE result proofs are available.** `settle.ts` fetches a three-stage
      Merkle proof from `/api/scores/stat-validation` and verifies it via
      `Txoracle.validateStat`. The `daily_scores_roots` PDA for the match's batch
      timestamp must be published. If a leg is final but the root isn't up yet,
      wait and retry (no auto-retry in the keeper).
- [ ] **`now >= contest.settle_after_ts`.** `settle_contest` rejects with
      `SettleTooEarly` before this. For 20635 it's last-kickoff + 3h buffer.
- [ ] **Keeper wallet funded + matches the contest's `settle_authority`.** The
      keeper signs both `settle` (per leg) and `settle_contest`. `settle_contest`
      requires `market.settle_authority == contest.settle_authority` for every leg,
      so the keeper that created the result markets must be the one settling.
- [ ] **`.txline-auth.json` cached and valid** (21-day window). Otherwise the keeper
      re-authenticates on first call.
- [ ] **`keeper/.env` set**: `RPC_URL` (devnet), `WALLET_SECRET_KEY` (keeper keypair),
      `TXLINE_BASE_URL`, `PROOFBET_IDL` (→ `target/idl/proofbet.json`).

---

## 1. Settle — dry run first (no broadcast)

```bash
cd keeper
npx tsx settle-contest.ts --dry-run
```

This reads `jackpot_vault.active_contest_id` → the live contest, settles each result
market in **dry-run** (no tx), reads each `winning_bucket`, counts perfect entries
off-chain (`countPerfect`), and prints the **settle preview**:

```
settle preview · pot 0.1234 ◎ · rake 0.0020 ◎ · distributable 0.1214 ◎ · 1 winner(s) → 0.1214 ◎ each · dust 0.0000 ◎
```

**Sanity-check before going live:**
- `winningBuckets` match the real results (`0=home, 1=draw, 2=away`, in card order).
- `perfectCount` looks right (this is the one trusted input — see Trust note below).
- `distributable` = pot − rake; `share` = distributable / perfectCount.
- `ROLLOVER (no winners)` appears iff zero perfect tickets — then the pot rolls
  forward to the next contest (no payouts), which is the intended jackpot mechanic.

If a result market shows no winning bucket, the keeper aborts with
`abandoned-match` — see §4.

---

## 2. Settle — live

```bash
cd keeper
npx tsx settle-contest.ts
```

Settles each result market on-chain (idempotent — skips already settled/voided),
then broadcasts `settle_contest(perfect_count)` with the result markets as
`remainingAccounts`. On success the contest transitions to **Settled** (winners) or
**RolledOver** (zero winners), the rake is paid to `fee_recipient`, and the winners'
payable amount is fenced into `vault.reserved`.

> Optional: `npx tsx settle-all.ts --once` settles result markets across the whole
> World Cup board (HT/FT waves) independently of any contest. `settle-contest.ts`
> already settles its own legs, so this is only needed if you also run standalone
> parimutuel markets.

---

## 3. Verify, then winners claim

Verify on-chain via the engine:

```bash
curl -s localhost:8787/api/contest/today | jq '{status, winningBuckets, perfectCount, distributable}'
curl -s "localhost:8787/api/contest/entries?wallet=<WINNER_WALLET>" \
  | jq '.[] | {nonce, won, claimable, payout}'
```

Expect `status: "settled"`, populated `winningBuckets`, and winners showing
`won: true, claimable: true, payout: <share>`. Losers show `won: false`.

**Claim (client-side, in the PWA):**
1. Winner logs in (Privy) and opens the sweepstake view.
2. Each ticket shows a status pill: **Won X ◎** / **No win** / **Refund due**.
3. Only winners (and void refunds) get a **Claim** / **Refund** button — clicking it
   builds `claim_contest`, signs, and broadcasts. Payout lands in the wallet; the
   Entry account closes (rent returned). A loser has no button (a loser's claim is a
   0-payout close that just wastes a fee).

Double-claim is impossible — the Entry is closed on first claim, so a second attempt
fails with `AccountNotInitialized`.

---

## 4. Edge cases

- **Abandoned match (no result market bucket).** `settle-contest.ts` aborts with
  `abandoned-match` and does NOT settle the contest. The correct action is to
  **void the contest** (refunds every ticket its stake via `claim_contest` on a
  `Voided` contest). ⚠️ **There is no `void-contest` keeper CLI yet** — `void_contest`
  is on-chain (permissionless after the grace period) but needs a one-off script or
  manual `program.methods.voidContest()` call. _Build this before relying on it in
  production._
- **Wrong `perfect_count`.** The on-chain solvency caps bound the damage to *this*
  contest, never cross-contest:
  - *Under-report* → early claimers over-collect; later real winners revert with
    `VaultInsolvent`.
  - *Over-report* → phantom shares stay fenced in `vault.reserved` forever (no loss,
    but they don't roll forward).
  Always confirm `perfectCount` from the dry-run before going live.
- **Stale TxLINE root.** Final match but proof not yet published → `settle.ts` fails.
  Wait and retry; do not force.

---

## Trust model (M0 / hackathon)

The keeper **is** the oracle: `settle_contest` trusts the keeper-submitted
`winning_bucket` (proof-verified off-chain) and `perfect_count` (`countPerfect` over
live on-chain entries). There is no on-chain re-verification of the result. This is
acceptable for a devnet demo and is disclosed in the spec (§9). A production system
would add on-chain proof verification and/or a committed `perfect_count`.

## Quick reference

| Step | Command |
|---|---|
| Dry-run settle + preview | `npx tsx settle-contest.ts --dry-run` |
| Live settle | `npx tsx settle-contest.ts` |
| Settle whole board (optional) | `npx tsx settle-all.ts --once` |
| Verify contest | `curl -s localhost:8787/api/contest/today \| jq` |
| Verify a wallet's tickets | `curl -s "localhost:8787/api/contest/entries?wallet=…" \| jq` |
| Claim | In the PWA — winner clicks **Claim** |
