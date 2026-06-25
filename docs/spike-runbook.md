# ProofBet — 72-Hour Settlement Spike Runbook

**Purpose:** prove (or kill) the one assumption everything rests on — *that a World Cup soccer prop can be settled, end-to-end, from a live TxLINE three-stage Merkle proof, with `validateStat` returning the correct boolean that ProofBet can read.* Do this **before** building the parimutuel core. If it's green, you build with confidence. If it's red, you fall back to odds-validation markets on **day one**, not day twelve.

> **The one question this spike answers:** On a *live* WC/Friendly fixture, does `Txoracle.validateStat` return `true` for a real per-stat / per-phase soccer predicate, and can a ProofBet-side program/keeper obtain that boolean deterministically?

> **▶ The runnable version of this runbook lives in [`../spike`](../spike/).** It implements Phases 1–3 and prints Gate A–D results. `cd spike && npm install && npm run selfcheck` (offline), then fill `.env` and `npm run spike`. See [`spike/README.md`](../spike/README.md).

---

## What the docs already settled (so you don't re-discover it)

The original red-team doc worried the proof system "was built for US college sports." **It wasn't only.** TxLINE ships a first-class **Soccer Feed** with per-half stats, a dedicated **stat-validation proof** endpoint, and an on-chain **`Txoracle`** validation program on devnet. The remaining unknown is not "does soccer exist in the feed" — it's "**does it actually return `true` on a live in-play/finished match, and can I read that result from my own code.**" That is what the spike confirms.

| Primitive | Verified value | Source |
|---|---|---|
| Auth (free) | `POST https://txline.txodds.com/auth/guest/start` → guest JWT | quickstart |
| Free tiers | **Level 1** (60s delay) & **Level 12** (real-time): World Cup + International Friendlies, no payment, no card | worldcup |
| Activate | on-chain `program.methods.subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)` (no tokens for free tiers) → sign msg → `POST /api/token/activate` → API token | quickstart |
| API call headers | `Authorization: Bearer <JWT>` **+** `X-Api-Token: <api token>` | stat-validation ref |
| Proof endpoint | `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=[&statKey2=]` | scores API ref |
| Validation program | Anchor `Txoracle`, **devnet `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`** | programs/devnet |
| Instruction | `validateStat` (TS) / `validate_stat` (Rust); read-only via `.view()` → `bool` | onchain-validation example |

### Soccer stat keys (full-game base, keys 1–8)
| key | stat | key | stat |
|---|---|---|---|
| 1 | P1 total goals | 2 | P2 total goals |
| 3 | P1 yellow cards | 4 | P2 yellow cards |
| 5 | P1 red cards | 6 | P2 red cards |
| 7 | P1 corners | 8 | P2 corners |

**Period multipliers** (add to the base key): H1 `+1000` · H2 `+2000` · ET1 `+3000` · ET2 `+4000` · Pens `+5000`.
Examples: `1001` = P1 H1 goals · `2007` = P1 H2 corners · combined full-game corners = `statKey=7` + `statKey2=8` with `op=Add`.

### Phase codes (the finality + void map)
| code | meaning | use |
|---|---|---|
| 1 | NS — not started | no entry/settle |
| 2 | H1 in play | live |
| 3 | HT — halftime | **H1 props now final** |
| 4 | H2 in play | live |
| **5** | **F — Finished** | **full-game props final → settle** |
| 14 | Interrupted | **void → refund** |
| 15 | Abandoned | **void → refund** |
| 16 | Cancelled | **void → refund** |
| 17 | TX Coverage Cancelled | **void → refund** |
| 18 | TX Coverage Suspended | **void → refund** |
| 19 | Postponed | **void → refund** |

---

## Kill criterion (read this before you start)

- **PASS** = Gate C and Gate D both green → soccer scores-proof settlement is real. Proceed to build the parimutuel core on `validateStat`.
- **PARTIAL** = Gate A/B green, **C red** (proof endpoint returns nothing usable for live soccer, or `.view()` won't return `true`) → **fall back to odds-validation / match-result markets** (the `daily_*` batch-root path) and demo the proof receipt on a result market. Keep `validateStat` as a stretch goal. Still shippable.
- **BLOCKED** = A or B red (auth / data access) → routine; escalate to the sponsor (hackathon Discord / support) same day. Not an idea-killer.

Timebox: **72 hours.** If live WC data is flowing, Phases 1–3 can compress into a single day; the bands below are a ceiling, not a target.

---

## Phase 0 — Pre-flight (Hour 0, ~30 min)

- [ ] Solana **devnet** wallet + keypair; airdrop devnet SOL (`solana airdrop 2 --url devnet`).
- [ ] Toolchain: Node ≥18, `@solana/web3.js`, `@coral-xyz/anchor`, `tweetnacl` (Ed25519 detached signing), Anchor CLI + Rust (for Phase 4 only).
- [ ] Pull the devnet IDL + types: `https://txline-docs.txodds.com/documentation/programs/devnet.md` and the OpenAPI spec `https://txline.txodds.com/docs/docs.yaml` (or `https://txline-docs.txodds.com/api-reference/openapi.json`).
- [ ] Skim **World Cup Hackathon Terms** (`/documentation/legal/hackathon-terms.md`) — confirm P2P/parimutuel pools are permitted and devnet/no-real-money framing is compliant. *(The red-team doc asserts pools are allowed; verify the exact wording.)*

**Confirm-in-flight (things the docs imply but the spike nails down):** the free-tier `SERVICE_LEVEL_ID` (1 vs 12) and `DURATION_WEEKS` args to `subscribe`; the PDA seeds for `daily_scores_merkle_roots`; and the exact field-name mapping from the API proof object to the instruction args (see Phase 3).

---

## Phase 1 — Auth & free-tier access (Hours 0–8) → **Gate A**

1. **Guest session:** `POST https://txline.txodds.com/auth/guest/start` → capture the guest **JWT**.
2. **Subscribe on-chain (free):** call `Txoracle`/subscription program `subscribe(SERVICE_LEVEL_ID, DURATION_WEEKS)` for a free level (**Level 12** = real-time, preferred for in-play; **Level 1** = 60s delay). No TxL tokens needed for free tiers — but you pay devnet SOL fees. Capture the **transaction signature**.
3. **Sign the activation message:** build the message = (tx signature + selected league IDs + JWT), sign with the wallet secret key as a **base64 detached Ed25519** signature (`tweetnacl.sign.detached`).
4. **Activate:** `POST /api/token/activate` with `{ txSignature, walletSignature, leagues }` → receive the **long-lived API token**.
5. **Smoke test:** `GET` the latest **fixtures snapshot** with `Authorization: Bearer <JWT>` + `X-Api-Token: <token>`. Expect a 200 with World Cup / Friendly fixtures.

> **Gate A — PASS when:** fixtures snapshot returns 200 with real fixtures. **If 401/403:** re-check the dual-header auth and that the on-chain subscribe actually landed for the league set you requested.

---

## Phase 2 — Find a live stat to settle (Hours 8–24) → **Gate B**

1. **Find a candidate fixture:** check `/documentation/scores/schedule.md` for confirmed-coverage matches, cross-ref the fixtures snapshot for one that is **in-play or recently finished** (ideal: at HT or phase `F`).
2. **Pull its score events:** either
   - subscribe to the **scores SSE stream** (`/api/.../scores` real-time), or
   - poll "full sequence of score updates for a single fixture".
   Record, for one concrete stat: `fixtureId`, `seq` (the scores-event sequence number), `statKey`, `period`, `value`, and current **phase**.
3. **Pick the prop you'll prove** (start simple, one true + one false):
   - **Single-stat:** P1 H1 goals → `statKey=1001`, predicate `GreaterThan 0` (or `EqualTo <actual>`).
   - **Two-stat (the wedge):** combined full-game corners → `statKey=7`, `statKey2=8`, `op=Add`, predicate `GreaterThan N`.
4. **Respect finality:** only target a prop whose period is complete — H1 props once phase ≥ `3 (HT)`, full-game props once phase = `5 (F)`. (Settling on still-changing live values is how you pay the wrong side; the production engine settles **only on final phase + on-chain batch root** — see Risks.)

> **Gate B — PASS when:** you hold a concrete `(fixtureId, seq, statKey[, statKey2])` for a *real* soccer stat whose value you know and whose period is final.

---

## Phase 3 — Fetch proof + validate off-chain (Hours 24–48) → **Gate C (the big one)**

1. **Fetch the three-stage proof:**
   ```
   GET /api/scores/stat-validation?fixtureId={id}&seq={seq}&statKey={k}[&statKey2={k2}]
   Authorization: Bearer <JWT>
   X-Api-Token: <token>
   ```
   Response `ScoresStatValidation`:
   - `ts` · `statToProve {key, value, period}` · `eventStatRoot`
   - `summary` (`ScoresBatchSummary`): `fixtureId`, `updateStats`, `eventStatsSubTreeRoot`
   - `statProof[]` (stat → event root) · `subTreeProof[]` (event → fixture summary) · `mainTreeProof[]` (fixture summary → **on-chain batch root**)
   - optional `statToProve2`, `statProof2`
   - each `ProofNode = { hash, isRightSibling }`

2. **Map proof → instruction args.** `validateStat` (devnet IDL) takes:
   `ts: i64`, `fixture_summary: ScoresBatchSummary`, `fixture_proof: Vec<ProofNode>`, `main_tree_proof: Vec<ProofNode>`, `predicate: TraderPredicate`, `stat_a: StatTerm`, `stat_b: Option<StatTerm>`, `op: Option<BinaryExpression>`.
   - `BinaryExpression ∈ { Add, Subtract }` · `TraderPredicate` comparison ∈ `{ GreaterThan, LessThan, EqualTo }`.
   - Account: `daily_scores_merkle_roots` (read-only PDA).
   - **Confirm here:** the API exposes `statProof` / `subTreeProof` / `mainTreeProof`; the instruction names `fixture_proof` / `main_tree_proof` and a `StatTerm` that likely *embeds* the stat-level proof. Resolve the exact mapping against the IDL (`subTreeProof` → `fixture_proof` is the probable pairing). This naming reconciliation is the only fiddly part of the spike.

3. **Call it read-only:**
   ```ts
   const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
   const isValid = await program.methods
     .validateStat(ts, fixtureSummary, fixtureProof, mainTreeProof, predicate, statA, statB, op)
     .accounts({ dailyScoresMerkleRoots: dailyScoresPda })
     .preInstructions([computeBudgetIx])
     .view();        // simulation → returns the bool directly
   ```

4. **Prove both directions** (this is what makes the result trustworthy, not lucky):
   - Set the predicate so it **should be true** (e.g. corners `GreaterThan actual-1`) → expect `true`.
   - Set it so it **should be false** (e.g. `GreaterThan actual+5`) → expect `false`.
   - Tamper one `ProofNode.hash` → expect failure/`false` (confirms the proof is actually checked, not ignored).

> **Gate C — PASS when:** `.view()` returns `true` for the true predicate, `false` for the false one, and rejects a tampered proof — **on a live/finished WC fixture.** This is the prove-or-kill. ✅ green here = the idea is real.
>
> **If red:** capture the exact failure (empty proof? `daily_scores_merkle_roots` not yet populated for soccer? CU exhaustion? deserialization?). If the *batch root just isn't on-chain yet for soccer*, that's the fallback trigger → go to Outcome matrix.

---

## Phase 4 — Read the result from *your own* program (Hours 48–72) → **Gate D**

The keeper/settlement engine must obtain the boolean from inside ProofBet's flow, not just an off-chain `.view()`. Pick the lightest path that works:

- **Path A (preferred) — off-chain `.view()` + keeper post.** Keeper runs the Phase-3 `.view()`, then calls ProofBet's `settle(market, winningBucket)` with the result. Simplest; proof receipt = the stat-validation payload + the `validateStat` simulation. **If Gate C is green, Path A already works — Gate D is satisfied.**
- **Path B — on-chain CPI.** Minimal Anchor program that CPIs `Txoracle.validate_stat` and reads the return via `get_return_data()`, asserting it equals expected. Most "trustless-looking" for the demo, but verify `validate_stat` actually emits return data on the CPI path (the documented example uses `.view()`, not CPI).
- **Path C (fallback) — re-verify in-program.** If CPI return is awkward, replicate the three-stage Merkle verify inside ProofBet's program from the same proof bundle (you have leaf + branches + roots + the on-chain batch root account). More code, zero dependency on reading another program's return.

> **Gate D — PASS when:** a ProofBet-side component (keeper via Path A, or program via B/C) deterministically obtains the settlement boolean. Decide A/B/C now — it sets the architecture of the settle path.

---

## Outcome matrix (what each result means for the build)

| Result | Meaning | Next action |
|---|---|---|
| **A+B+C+D green** | Soccer scores-proof settlement is real | Build parimutuel core on `validateStat`; ship 2 prop markets (O/U goals via single stat; combined corners via `Add`) on 1 marquee knockout match, devnet |
| **C red — soccer not rooted live** | Granular soccer proofs not on-chain in time | **Fallback:** build **odds-validation / match-result** markets on the batch-root path; demo proof receipt on a result market; `validateStat` becomes stretch |
| **C red — CU / mapping bug only** | Mechanism works, plumbing wrong | Fix arg mapping / split instructions / raise CU; re-run Phase 3 |
| **A or B red** | Auth / data access | Escalate to sponsor same day; not an idea risk |

---

## Risks & guardrails (carry into the build)

- **Compute units:** `validateStat` can be heavy (~1.4M CU). Always prepend `setComputeUnitLimit`. If a two-stat predicate blows the budget, split or pre-verify off-chain (Path A).
- **Finality, not live values:** settle **only** when (a) the period is complete (phase `5` for full-game, `≥3` for H1) **and** (b) the batch root containing that stat is on-chain (`mainTreeProof` resolves against `daily_scores_merkle_roots`). Add a small per-market finality buffer.
- **Void → refund:** phases `14–19` (Interrupted/Abandoned/Cancelled/TXCC/TXCS/Postponed) → refund the pool, never settle.
- **Free-tier delay:** Level 1 is 60s-delayed; use **Level 12** (real-time) for in-play UX. Either way, settlement keys off final phase, not the live tick.
- **Auth is dual-header:** every data/proof call needs **both** `Authorization: Bearer <JWT>` and `X-Api-Token`. A 401 is almost always a missing second header or an expired guest JWT.
- **Language precision:** market it as **"verifiable, single-source, no separate oracle, no dispute window"** — never "trustless." The TxODDS engineers built this proof system; precision earns points.

---

## Appendix — quick reference

**Base:** `https://txline.txodds.com` · **Docs:** `https://txline-docs.txodds.com` · **LLM index:** `/llms.txt`
**Devnet `Txoracle`:** `6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J`

Endpoints used:
- `POST /auth/guest/start` — guest JWT
- `POST /api/token/activate` — activate subscription → API token
- `GET /api/scores/stat-validation?fixtureId=&seq=&statKey=[&statKey2=]` — three-stage proof
- fixtures snapshot · scores SSE stream · full score sequence (see `/llms.txt`)

Instruction `validateStat(ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b?, op?)` → `bool`; account `daily_scores_merkle_roots`; ops `Add|Subtract`; comparisons `GreaterThan|LessThan|EqualTo`.

**Key doc pages:**
- On-chain validation example: `/documentation/examples/onchain-validation.md`
- Soccer feed (stat keys + phases): `/documentation/scores/soccer-feed.md`
- Stat-validation proof endpoint: `/api-reference/scores/get-a-three-stage-merkle-proof-for-a-single-score-statistic.md`
- Programs (IDL/addresses): `/documentation/programs/devnet.md`, `/documentation/programs/addresses.md`
- World Cup free tier: `/documentation/worldcup.md`
- Hackathon terms: `/documentation/legal/hackathon-terms.md`
