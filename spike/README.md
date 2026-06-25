# ProofBet settlement spike

A runnable **prove-or-kill** for the one assumption ProofBet rests on:

> On a real World Cup soccer fixture, does `Txoracle.validateStat` return the
> correct boolean from a live TxLINE three-stage Merkle proof — and can ProofBet
> read that result?

It runs the runbook's Phases 1–3 against TxLINE **devnet** and prints Gate A–D
results. See [`../docs/spike-runbook.md`](../docs/spike-runbook.md) for the full
methodology, the outcome matrix, and the fallback plan.

## What it does

| Phase | Gate | Check |
|---|---|---|
| 1 Auth | **A** | guest JWT → on-chain free-tier `subscribe` → activate API token → fixtures snapshot returns 200 |
| 2 Discover | **B** | find a live/finished World Cup fixture and pick a settle-able stat (corners) |
| 3 Validate | **C** ⭐ | fetch the three-stage proof, run `validateStat().view()` → **true** for a true predicate, **false** for a false one, and **reject** a tampered proof |
| — | **D** | confirm the boolean is readable from ProofBet's flow (off-chain `.view()` keeper = Path A) |

Gate C is the prove-or-kill.

## Run it

```bash
cd spike
npm install
cp .env.example .env          # then fill in WALLET_SECRET_KEY
solana airdrop 2 <your-devnet-pubkey> --url devnet   # fees for the subscribe tx

npm run typecheck             # static check, no network
npm run spike                 # full Phases 1→3

# or run phases individually:
npm run spike -- --only=auth
npm run spike -- --only=discover
npm run spike -- --only=validate
```

Credentials from Phase 1 are cached to `.spike-auth.json` (gitignored) so
re-runs don't re-subscribe on-chain. Delete it to force a fresh auth.

## Pinning an exact stat

If discovery finds no rooted live match (e.g. early in the tournament), the spike
falls back to the documented example fixture so Phase 3 still exercises the
mechanism. To pin your own, set in `.env`:

```
FIXTURE_ID=17952170
SEQ=941
STAT_KEY=1002        # P2 first-half goals (period*1000 + base)
STAT_KEY2=1003       # optional → two-stat predicate
```

## Reading the result

- **Gate C green** → soccer scores-proof settlement is real. Build the parimutuel
  core on `validateStat`.
- **Gate C red, `daily_scores_roots` PDA missing** → that day isn't rooted on
  devnet yet → fall back to odds-validation / match-result markets (runbook
  Outcome Matrix).
- **Gate A red** → host/auth issue. Try flipping `TXLINE_BASE_URL` between the
  devnet and prod hosts (the docs are inconsistent about the auth host).

## Layout

| File | Role |
|---|---|
| `src/config.ts` | Verified constants: addresses, stat keys, period multipliers, phase/void codes |
| `src/idl.ts` | Local Anchor IDL for `txoracle` (not published on-chain) + discriminators |
| `src/auth.ts` | Phase 1: guest JWT, on-chain subscribe, activate |
| `src/discover.ts` | Phase 2: fixtures snapshot + score events → stat pick |
| `src/validate.ts` | Phase 3: fetch proof, map args, `validateStat().view()`, true/false/tamper |
| `src/run-spike.ts` | Orchestrates the phases and prints gates |
| `src/util.ts` | Wallet loading, dual-header HTTP client, logging |

## Caveats

This is a spike, not the product. It validates the **mechanism**; production
settlement must additionally enforce finality (settle only on phase `F`/`FET`/
`FPE`, refund on `14–19`) and read the batch root from on-chain. Devnet only,
no real money.
