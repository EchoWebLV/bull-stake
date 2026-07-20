# BullStake — TxODDS World Cup Hackathon submission (tech doc)

**Track:** Consumer & Fan Experiences · **Date:** 2026-07-19

| | |
|---|---|
| Live app | https://bull-stake-production.up.railway.app |
| Public repo | https://github.com/EchoWebLV/bull-stake |
| Program (Anchor, Solana devnet) | `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ` |
| Rolling jackpot PDA | `4LEY34HvTdqfH8WKWuW6tjmxNzaP2ryzS5ce9WwMVBiq` |

**Identity in one line: self-resolving on-chain markets on TxODDS data.** This is a real-money product end to end — entries, pots, jackpot rollovers and claims are actual lamports moving on-chain (devnet SOL in this build).

## 1. What it is — two modes, one wallet

**⚡ Live — the per-match game (entry ◎0.035).** A per-match pool running on MagicBlock Ephemeral Rollups, so in-play taps land at rollup speed. As the match runs, the keeper opens calls on live moments (next goal and friends); you tap your read before the window closes, correct calls build your streak, and the match pot pays out parimutuel at full time. Accounts delegate to the rollup for the match and settle back to devnet after.

**Sweep — the all-day survival card (entry ◎0.05).** One auto-composed card of up to six legs spanning the day's fixtures. Each leg locks at its own kickoff; you can enter any time while at least three legs are still open, and your card carries whatever was open when you entered. Survivors carrying more legs earn a bigger multiplier — it doubles per carried leg, so a full six-leg card pays ×64. **No buy-backs**: once a carried leg kicks off, picks are frozen on-chain. Every carried leg correct = a perfect card; perfect cards split the pot **plus the entire rolling jackpot** in proportion to their multipliers. Zero survivors → the whole pot rolls into the jackpot PDA and grows the next card's prize.

One wallet for both (Privy email login — no seed phrase), installable as a PWA. Rake is a program parameter (`fee_bps`, set to 0 in this build) — the monetization dial is already on-chain.

## 2. The moat — settlement that proves itself

Most on-chain prediction products settle with a trusted cron writing answers into an account. BullStake settles only what the oracle proves. The exact flow, as implemented:

1. **Terminal phase.** The keeper reads the fixture's score history (`GET /api/scores/historical/{fixtureId}`) and resolves its phase with terminal-absorbing precedence (FINISHED > VOID > latest known in-play) — see §6 for why that ordering matters.
2. **Proof fetch.** `GET /api/scores/stat-validation?fixtureId&seq&statKey[&statKey2]` returns TxLINE's three-stage Merkle proof bundle for the stat(s) at that terminal event: the stat + its proof up to an event-stat root, the fixture summary + subtree proof, and the main-tree proof.
3. **On-chain validation.** The keeper executes `Txoracle.validateStat` as a read-only on-chain view, passing one account: the oracle's per-day `daily_scores_merkle_roots` PDA (derived from the proof batch's day). The oracle program hashes the claimed stat up all three stages and checks it against the day root it holds on-chain, then evaluates the predicate (`greaterThan` / `lessThan` / `equalTo` a threshold, over one stat or two combined with `add`/`subtract`). Our original prove-or-kill spike (`spike/src/validate.ts`) also flips a single byte in a proof node and confirms the program rejects it.
4. **Bucket derivation.** Binary markets: predicate TRUE → bucket 0, FALSE → bucket 1. Three-way result markets: the sign of the *proven* goal difference (home − away via the two-stat `subtract` path) → HOME / DRAW / AWAY. The red-card chaos leg settles through this exact same machinery on the red-card stat keys.
5. **Market settle** (`programs/proofbet/src/instructions/settle.rs`). The keeper submits `settle(winning_bucket, settled_seq, settled_ts, settled_value)` against the market PDA (`["market", fixture_id, market_id]`, `has_one settle_authority`), its vault PDA and the pinned fee recipient. The instruction requires the market open and entries closed, then records the proof coordinates — the TxLINE event `Seq`, the proof batch timestamp, and the proven value — on the account, so anyone can re-fetch that exact proof and re-run the on-chain validation. If nobody staked the proven winner, the market **voids with the proven bucket still recorded**: standalone tickets refund, but the real result stays readable on-chain.
6. **Card settle** (`settle_contest.rs`) — **the crank cannot inject results here at all.** `settle_contest` takes *no result arguments*; it takes exactly `num_legs` market accounts. For each leg the program re-derives the expected market PDA from the contest's *own stored* (fixture, market) list, requires the passed account to match it, requires the account be program-owned, requires that market's settle authority equal the contest's (so a squatter who front-runs the permissionless market-create can't smuggle in results), requires it settled — or voided with a recorded result — and reads the winning bucket from account state. It then caps the reported winner count at the entry count, sanity-bands the reported multiplier totals against the card size, and moves lamports program-PDA-to-program-PDA: zero winners → pot into the jackpot PDA (`RolledOver`); winners → the whole jackpot pulled into the contest PDA and paid out by proportional claims, with solvency checks on both accounts.
7. **Unprovable fixtures refund, and liveness is permissionless.** A fixture with no provable result voids (`void_market` / `void_contest`) and every entry refunds. If the keeper ever disappears, **anyone** may void a contest 3 days past its settle gate (`VOID_GRACE_SECS`) and unlock refunds — the pot cannot be frozen by an absent operator.

## 3. Architecture

| Piece | What it is |
|---|---|
| `programs/proofbet` | Anchor program: parimutuel markets, the Sweep contest card, the Live pool game (MagicBlock delegate/undelegate lifecycle), jackpot rollover |
| `keeper/` | The crank — one process, five interval jobs: settlement, live calls, pool scheduling, line markets, daily Sweep card composition. The card composer never lays the same (fixture, market) pair twice; thin slates ship shorter cards (the program accepts 3–6 legs) |
| `engine/` | Fastify read API (`/api/card`, `/api/live`, `/api/matches`, `/api/jackpot`, …) serving the web app from chain + TxLINE state |
| `web/` | Vite PWA — Privy login, ⚡ Live and Sweep tabs |
| `spike/` | The TxLINE auth / discovery / proof-validation client, reused by the keeper (the original prove-or-kill spike) |

Deployed as a single Railway service: the Fastify engine serves `/api` and the built web PWA same-origin.

**TxLINE surface used:** `POST /auth/guest/start` → on-chain `Txoracle.subscribe` (devnet free tier) → wallet-signed `POST /api/token/activate`; `GET /api/fixtures/snapshot` (slate); `GET /api/scores/historical/{id}` + `/api/scores/snapshot/{id}` (phases + live events); `GET /api/odds/snapshot/{id}` + `/api/odds/updates/{id}` (StablePrice odds); `GET /api/scores/stat-validation` (Merkle proofs); `Txoracle.validateStat` (on-chain verification).

## 4. On-chain evidence (readable on devnet right now)

| What | Where | What it proves |
|---|---|---|
| **Contest 777020653 — LIVE today** | `DQ2X5yjrCC89J9Ewt1Es8zm6nW7sqsH62yZg6RWtSnBP` | A 5-leg card on the **World Cup final** (Spain v Argentina, fixture 18257739, kickoff 19:00 UTC): Match Result, Total Goals O/U 2.5, 1st-Half Result, 1st-Half Goals O/U 0.5, and the Red Card Y/N chaos leg. Entries ◎0.05, close at kickoff; settle gate 21:00 UTC. Composed by the keeper's allocator on a one-fixture slate — distinct markets, shorter card, live on submission day |
| **Contest 777020637 — settled 2026-07-04** | PDA `7KXmBHkfKkt5UZYn64BH8ZYaycuJDuhb2q4Xkdogz8Lk`; settle tx `52R5xMD3N3wE1NSXC7a9Snmw6aWoypGsQi5X1pbJQGKvZh1VB88ciq3NHTLwEUQqEZdF4chxxBkVP7stYuDCw9X2` | Six proof-gated leg settles produced winning buckets [0,1,0,0,1,1]; zero perfect cards → the **whole pot rolled into the jackpot PDA** (real lamports, program-PDA to program-PDA) |
| **Contest 777020640** | status `rolledOver` on-chain | The rollover is the repeatable steady state, not a one-off |
| **Jackpot** | `4LEY34HvTdqfH8WKWuW6tjmxNzaP2ryzS5ce9WwMVBiq` | The rolling pot every zero-survivor day feeds |

## 5. Run it yourself

Impatient: open **https://bull-stake-production.up.railway.app** (installable PWA, devnet SOL).

Full local stack: follow the **Quickstart** in [`README.md`](../README.md) (Node 22+, Anchor 0.32.1, a funded devnet wallet, TxLINE API access; per-package `.env` from each `.env.example`).

Test suites, all green: **Anchor program 114 · keeper 349 · engine 267 · web 187**.

## 6. TxLINE API feedback

Requested by the sponsor — everything below was hit for real in this repo's history.

**What worked**

- **Wallet-signed activation is the right shape.** Guest JWT → on-chain `subscribe` → sign `txSig:leagues:jwt` → API token. Access itself is chain-native and wallet-bound; it fits an on-chain settlement product perfectly.
- **The three-stage proof bundle is genuinely verifiable on-chain.** One GET returns everything `validateStat` needs, and the two-stat form (`statKey2` + `add`/`subtract`) lets a 1X2 result settle from a single proven goal-difference — our whole moat stands on this endpoint.
- **Both pull and push delivery on one schema.** We ship on REST polling of the score endpoints; the documented SSE score stream (`GET /api/scores/stream`) is our first post-deadline swap, and having it on the same normalized schema makes that a drop-in.
- **The free tier carries friendlies beyond the World Cup** (verified by feed scan 2026-07-12: Vietnam v Myanmar Jul 18, Australia v Brazil twice in late September) — that's post-Cup continuity for a consumer app, not just a hackathon sandbox.

**What bit us (constructively)**

- **No lineup / player-level data in the feed.** This rules out team-news and player-prop markets entirely — we rejected both in design because they'd be unsettleable trustlessly. Player stat keys would open a large market surface with zero oracle changes on our side.
- **The devnet feed appends a `StatusId 100` event *after* the terminal phase** (and can emit out-of-order in-play codes, e.g. …PE→FPE→ET2→100). Our "latest event wins" phase read never saw the finished phase, which stranded settles for ~3.5 hours on 2026-07-04 until we made terminal phases absorbing (`resolveFixturePhase`: FINISHED > VOID > latest known in-play; fix `a08b540`). Documenting `StatusId 100` semantics — or guaranteeing terminal-phase ordering — would save the next team that morning.
- **Devnet pre-match odds coverage is too thin to build on.** StablePrice rows exist for some fixtures (probed 2026-07-02; our line market consumed the demargined 1X2 consensus row where present), but they can't be relied on at card-compose time — so the Sweep composer falls back to neutral priors and its favorite-cap quality gate only bites once pool money creates real implied probabilities. Fuller pre-match coverage on devnet would let composition gate on real odds from the start.
- Minor: each fresh activation implies a re-subscribe (~0.2 devnet SOL), so we cache `{jwt, apiToken}` per wallet for 21 days and validate with one cheap authed call (`spike/src/auth-cache.ts`). A documented token TTL or refresh endpoint would remove the guesswork.

## 7. What's next

Deeper football coverage first (more provable markets per fixture; player markets the moment the feed carries player stats). Then a second vertical: **simulated sports that are provably fair end to end** — VRF-driven fixtures settled through the same self-resolving pipeline, so the "no one can invent results" property survives even when the sport itself is synthetic. Other sports verticals follow the same pattern after that.
