# Bull Stake

Real-money on-chain parimutuel football on Solana (devnet today). Two modes, two pots, one wallet.

**Identity in one line: self-resolving on-chain markets on TxODDS data.** Most on-chain prediction products settle with a trusted cron writing answers into an account. Bull Stake settles only what the oracle proves: every result is validated on-chain by `Txoracle.validateStat` against a TxLINE Merkle proof. The crank relays results — it cannot invent them.

## Two modes

### ⚡ Live — the per-match streak game

A per-match pool running on MagicBlock Ephemeral Rollups, so in-play taps land at rollup speed. Entry ◎0.035. As the match runs, the keeper opens calls on live moments (next goal and friends); you tap your read before the window closes, correct calls build your streak, and the match pot pays out parimutuel at full time. Accounts delegate to the rollup for the match and settle back to devnet after.

### Sweep — the all-day survival card *(internal code name: "Pearly")*

One auto-composed card of up to six legs spanning the day's fixtures (a thin slate ships a shorter card — never duplicate markets). Entry ◎0.05, any time while at least three legs are still open — each leg locks at its own kickoff, and your card carries whatever legs were open when you entered. Survivors carrying more legs earn a bigger multiplier: a full six-leg card pays ×64. No buy-backs — once a carried leg kicks off, picks are frozen on-chain. On a day with zero survivors, the whole pot rolls into a growing jackpot for the next card.

## How settlement proves itself

1. TxLINE (TxODDS's on-chain data rail) publishes fixture stats with a three-stage Merkle proof.
2. The keeper fetches the proof bundle and calls `Txoracle.validateStat` as an on-chain view — the oracle program verifies the proof against its rooted state.
3. Only that validated result feeds the `proofbet` program's settle instructions. A fixture with no provable result voids and refunds instead of guessing.

## Architecture

| Piece | What it is |
|---|---|
| `programs/proofbet` | Anchor program: parimutuel markets, the Sweep contest card, the Live pool game, jackpot rollover |
| `keeper/` | The crank — one process, five interval jobs: settlement, live calls, pool scheduling, line markets, daily Sweep card composition |
| `engine/` | Fastify read API on `:8787` (`/api/card`, `/api/live`, `/api/matches`, `/api/jackpot`, …) serving the web app from chain + TxLINE state |
| `web/` | Vite PWA — Privy login, ⚡ Live and Sweep tabs, installable on phones |
| `spike/` | TxLINE auth/discovery/proof-validation client, reused by the keeper (the original prove-or-kill spike) |
| `tests/` | The Anchor program's ts-mocha suite |

Devnet program id: `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`

Deploys target Railway (engine + web) against Solana devnet.

## Quickstart

Prerequisites: Node 22+, the Anchor 0.32.1 toolchain (program builds/tests), a funded devnet wallet, TxLINE (TxODDS) API access.

```bash
npm install                  # root — anchor test harness
(cd engine && npm install)
(cd keeper && npm install)
(cd web    && npm install)
(cd spike  && npm install)
```

Copy each package's `.env.example` to `.env` and fill in your values (`.env` files are gitignored — never commit them):

| File | Variables |
|---|---|
| `engine/.env` | `PORT`, `RPC_URL`, `WALLET_SECRET_KEY`, `TXLINE_BASE_URL`, `SERVICE_LEVEL_ID`, `DURATION_WEEKS`, `PROOFBET_PROGRAM_ID`, `PROOFBET_IDL`, `WEB_ORIGIN` |
| `keeper/.env` | `RPC_URL`, `WALLET_SECRET_KEY`, `TXLINE_BASE_URL`, `TXLINE_AUTH_BASE_URL`, `SERVICE_LEVEL_ID`, `DURATION_WEEKS`, `PROOFBET_IDL` — cron gates: `PEARLY_CREATE`, `POOL_SCHEDULE`, `LIVE_INTERVAL_SEC` |
| `web/.env` | `VITE_PRIVY_APP_ID`, `VITE_RPC_URL`, `VITE_ENGINE_URL` |
| `spike/.env` | `RPC_URL`, `WALLET_SECRET_KEY`, `TXLINE_BASE_URL`, `TXLINE_AUTH_BASE_URL`, `SERVICE_LEVEL_ID`, `DURATION_WEEKS` — optional overrides: `FIXTURE_ID`, `SEQ`, `STAT_KEY`, `STAT_KEY2` |

Run the stack:

```bash
(cd engine && npm run dev)    # read API on :8787
(cd web    && npm run dev)    # PWA dev server
(cd keeper && npm run cron)   # the crank
```

## Tests

| Suite | Tests | Command |
|---|---|---|
| Anchor program | 114 | `anchor test` (root; spins a local validator) |
| keeper | 349 | `cd keeper && npm test` |
| engine | 267 | `cd engine && npm test` |
| web | 187 | `cd web && npm test` |

Root `npm run typecheck` covers the Anchor test suite; each package typechecks under its own `tsconfig.json`.

## Naming, for code navigation

- The product is **Bull Stake**; the repo and Anchor program keep the working name `proofbet`.
- **Sweep**'s internal code name is **Pearly**: `PearlyView.tsx`, `pearlyCard.ts`, `/api/card`, and the keeper's Pearly jobs are all the Sweep feature.

## Hackathon

Built for the **TxODDS World Cup hackathon**, Consumer & Fan Experiences track. This is a real-money product end to end: entries, pots, jackpots and payouts are SOL moving on-chain — devnet SOL in this build.
