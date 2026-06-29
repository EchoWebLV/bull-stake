# Secondary feature — Tradeable per-match prediction market (LMSR)

> **Status:** 🅿️ **Parked / design note.** Not being built now.
> **Priority:** Secondary — below the daily sweepstake (the new main feature).
> **Date captured:** 2026-06-29
> **Purpose:** Preserve the reasoning from the design discussion so we can pick it up later without re-deriving it.

---

## TL;DR

A per-match prediction market where users **buy and sell positions on outcomes at a live price** (Brazil / Draw / Japan), shown as Polymarket-style probability bars that sum to ~100%. The key user ask that drives the whole design: **"let people sell their entry before the match settles."**

- That one requirement (a tradeable exit at a movable price) is the exact line where **parimutuel ends**. The moment you allow exit, you've built either an **AMM** or an **order book**.
- For our scale (one match at a time, no professional market makers), the answer is an **AMM — specifically LMSR** — because an order book with no traders is an empty room: there'd be nobody to sell your entry *to*. An AMM is *always* a counterparty.
- The hard part is not the idea; it's **fixed-point `exp`/`ln` on Solana**, the funded liquidity subsidy, and slippage protection.
- Settlement is the easy part for us — we already have it (TxLINE proof → winning outcome).

---

## Product context

- **Main feature (current focus):** a **daily rolling sweepstake** — pay $1, pick outcomes across the top 3–5 matches of the day; if nobody wins, the pot **rolls into tomorrow**. A daily contest with a growing jackpot.
- **This feature (secondary):** a continuous, tradeable per-match market for users who want to take and adjust positions, not just enter a daily pick. It reuses the same match data, settlement, design language, and most of the on-chain scaffolding.

Both share: TxLINE live data + proof settlement, the keeper, Privy auth, the Streak UI shell, and devnet infra.

---

## Why parimutuel can't do "sell your entry"

Today's on-chain program is **parimutuel**: money goes into a bucket and is **locked until settlement**. There is no `cancel`/`withdraw` instruction — only `place_bet`, `claim`, `settle`, `void_market`. `claim` requires `Settled` or `Voided` ([claim.rs](../programs/proofbet/src/instructions/claim.rs)). So there is no exit and no movable price to trade against.

This is also why parimutuel **as-is has no drain risk** (see below): with no sell, there's no buy-low/sell-high loop. The "odds moving as you type" is pure front-end — the chain never reads a displayed price.

**Adding "sell" is what turns the market into an AMM** — and that is precisely when the drain math becomes mandatory.

---

## The drain risk (why the math matters)

"Drain" = a trade loop that prints free money **before** the match resolves, paid out of the pool/treasury, repeatable until empty. No waiting for a result, no risk.

A naive multi-outcome AMM (`price_i = weight_i ÷ Σ weights`, bump `weight_i` on buy) is **drainable**:

| Step | Action | Price | Cash | Weights after |
|------|--------|-------|------|---------------|
| 1 | Buy 1 Brazil | pay **0.333** | −0.333 | [11,10,10] |
| 2 | Sell that 1 Brazil | get **0.355** (11/31) | +0.355 | [10,10,10] |
|   |   |   | **+0.022** | back to start |

You returned to the exact starting state but pocketed money — because your own buy pushed the price up and you sold into your own splash.

**The fix:** you must pay the **area under the price curve** (an integral), not a single point — so a buy and its matching sell cancel to exactly zero. **LMSR's `exp`/`ln` is the closed form of that integral.** Any AMM derived from a single convex cost function `C(q)` (charge `C(q_after) − C(q_before)` for every trade) is path-independent and un-loopable by construction. Ad-hoc buy/sell rules almost always leak.

> Distinction: the market maker is *expected* to lose a small, **bounded, known-up-front** subsidy (`b·ln(N)`) — that's the rent for always-on liquidity, not a drain. The drain is the **unbounded, free, repeatable** loop. LMSR pays the rent but can't be looted.

---

## How LMSR works (the secondary engine)

- One market over N outcomes (N = 3 for 1X2). One shared cost function.
- **Cost function:** `C(q) = b · ln( Σ exp(q_i / b) )`, where `q_i` = shares outstanding on outcome `i`, `b` = liquidity parameter.
- **Price (= probability):** `p_i = exp(q_i/b) / Σ exp(q_j/b)`. Always in (0,1), **always sums to exactly 100%.**
- **Cost to buy** Δ shares of `i`: `C(q + Δ·eᵢ) − C(q)`. **Locked the instant you trade.**
- **Sell** = the reverse trade (buy negative shares).
- **Max market-maker loss:** bounded at **`b · ln(N)`** (≈ `1.10·b` for N=3). This is the capital you fund per live market.
- **Settlement:** winning outcome's shares redeem 1 unit each from escrow; losers redeem 0. (We already have `settle` + `winning_bucket`.)
- **Behaviour matches intuition:** buying Japan raises Japan's price and **lowers** Draw's and Brazil's prices (they must sum to 100%) — the opposite of parimutuel's counter-intuitive ripple, and exactly what users expect.

> `b` tuning: too small → prices jump on tiny trades; too big → prices barely move and the subsidy is larger.

---

## How Polymarket protects itself (and what we borrow)

Polymarket sidesteps the AMM drain by **not being an AMM** — it's an order book, so there's no formula to round-trip; every trade is matched against another user.

| Drain vector | Polymarket's defence | Available to us? |
|---|---|---|
| Round-trip money pump | No AMM — peer-matched order book | ❌ We *are* an AMM, so our defence **is the LMSR cost function itself** |
| Mint/redeem more than deposited | Complete-set = $1 conservation (conditional tokens) | ✅ Enforce `Σ redeemable ≤ Σ escrowed (collateral + subsidy)` — our `claim.rs` already reasons about this |
| Steal mid-trade | Atomic on-chain settlement, signed orders, non-custodial | ✅ Solana txs are atomic; keep escrow program-owned |
| Lie about the outcome | UMA bonded optimistic oracle + dispute/vote | ⚠️ We currently **trust the keeper** (`settle` records the supplied bucket). Stronger: **verify the TxLINE proof on-chain**, or tightly constrain who can `settle` |

**The trade in one line:** order book → drain-safety is free but liquidity isn't; AMM → liquidity is free but drain-safety is on your math. We chose AMM, so the math is the moat. Our softest spot is **settlement trust**, not trading.

---

## Scope — keep vs. build

| Keep (reuse / light touch) | Build new |
|---|---|
| TxLINE proof settlement + `settle` / `winning_bucket` | **LMSR cost-function math in fixed-point** (top risk) |
| N-bucket structure: `Market.bucket_totals` → share vector `q`; `Position.amounts` → share balances | `buy_shares(outcome, max_cost)` + `sell_shares(outcome, min_proceeds)` instructions |
| Vault/escrow + solvency invariant ([claim.rs](../programs/proofbet/src/instructions/claim.rs)) | A **treasury** seeding `b·ln(N)` per market + absorbing MM P&L |
| Keeper, slate, live data, market catalog | Slippage guards (`max_cost` / `min_proceeds`) against sandwiching |
| UI shell, board, history, Privy ([web/src](../web/src)) | Portfolio view: shares held, **mark-to-market value, Sell button**, price chart |
| Streak design language (already in `App.css`) | Probability-bar display (% per outcome, sums to 100%) |

Roughly **60% reused.** The genuinely new core: cost-function math + buy/sell + treasury + portfolio/sell UI.

---

## Risks to budget

1. **Fixed-point `exp`/`ln` on Solana — #1 risk.** No floats in a program; need a numerically-stable fixed-point implementation (log-sum-exp), heavily tested because it's real-money math.
2. **Liquidity capital.** Each live market needs `b·ln(3)` of subsidy at risk. *"One match at a time" is what makes this affordable* — only one market capitalized at once. (Free for play money.)
3. **Slippage / MEV.** Buy/sell need price bounds so trades can't be front-run.
4. **Legal** (real money only). Real-money prediction markets are heavily regulated/blocked in many jurisdictions. Mechanism-legit ≠ legally-legit — a lawyer conversation, separate from code.

---

## Phased path

- **Phase 0 — quick win (hours):** probability-bar display on the *current* parimutuel pool. Looks legit immediately, no engine change, no exit yet. (`% = side ÷ total = 1 ÷ multiplier`.)
- **Phase 1 — the real build:** LMSR AMM → buy/sell shares, fixed-point math, treasury, portfolio + Sell button. Play money, one match at a time. **This is the secondary feature.** It is the biggest single chunk of work in the whole product — a core money-program rewrite + careful math + test/audit pass.
- **Phase 2 — scale (later):** add a CLOB/order book for tighter spreads at volume; real money + compliance.

---

## Open decisions (deferred)

- Play-money first, or straight to real SOL? (Determines whether drain-grade math + audit are mandatory from day one.)
- Who funds the per-market subsidy, and what `b`?
- Fee model (flat spread vs. liquidity-sensitive LMSR to self-fund the subsidy).
- On-chain proof verification vs. keeper-trusted `settle` — close the settlement-trust gap before real money.

---

## Next step when we resume

Run a proper design pass (brainstorm → spec → task plan) focused on the fixed-point LMSR math and the treasury model, *before* any code.
