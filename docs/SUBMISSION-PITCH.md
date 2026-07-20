# BullStake — winning submission package

**For:** TxODDS World Cup hackathon · deadline **2026-07-19 23:59 UTC**
**Track (DECIDED):** Prediction Markets & Settlement — the flagship track (18k · 1st = 12k USDT)

Everything below is built on verified facts from [docs/HACKATHON.md](HACKATHON.md). Fill nothing in — the URLs, program id, contest ids and PDAs are the real ones.

---

## 0. Track decision — settled

**One project may enter only ONE track.** Per the hackathon FAQ ("Can a team enter multiple tracks?"): *"Yes, but not with the same project. You cannot submit one application to multiple tracks. If you want to enter a second track, you must submit a completely separate, distinct project."* So BullStake goes into exactly one track — and it's **Prediction Markets & Settlement**:

- **Fit:** the on-chain proof settlement moat (`validateStat`, no-result-args `settle_contest`, permissionless void) *is* this track's theme — "the flagship track… markets, resolution and settlement built on verifiable data." Nothing to reframe.
- **Prize:** 12k first (vs 10k on Consumer & Fan); 18k pool (vs 16k).
- **Competition, correctly read:** Consumer & Fan had *more* entries when checked (152 vs 142), and its #1 criterion — *"would a mainstream, non-technical fan regularly open it"* — is a structural ceiling for a real-money wallet-based betting PWA. That track also carries the gambling-disclaimer headwind ("do not endorse illegal betting"). Settlement rewards exactly the depth competitors can't fake; your consumer polish becomes a *bonus* differentiator there.

Sanity-check the settlement listing's exact 5 judging criteria before finalizing the form (its listing tab is JS-gated, so I couldn't extract them verbatim); the mapping in §4 is built around universal settlement dimensions and should hold.

---

## 1. Positioning — the spine of everything

**Name:** BullStake

**The sentence (settlement framing):**
> Most on-chain prediction products settle by trusting a cron to write the answer into an account. BullStake settles *only what the oracle can prove* — every result is a TxLINE Merkle proof verified on-chain, and the crank literally cannot inject a winner.

**The sentence (fan framing):**
> Every World Cup fan already watches with a phone in their hand. BullStake turns the match into a one-tap game — enter the day's card, ride your streak on live goals — and every payout is provably real, settled on-chain from TxLINE proofs.

**The narrative arc (same for both, different entry point):**
Onboarding is invisible (email login, no seed phrase, installable PWA) → the game is fun and *live* (Sweep survival card + per-match Live taps on real goals) → **and here's why you can trust the money: it self-resolves from proofs** → and it's a real business (on-chain rake dial, post-Cup continuity, provably-fair sim roadmap).

Settlement track leads with the trust; Consumer & Fan track leads with the fun. The middle and end are shared.

---

## 2. Demo video — script + shot list (the artifact that gets judged)

The listing says entries are "evaluated heavily based on the demo video" and it's an absolute screening gate. This is the priority.

### 2a. Timing plan for today (protect the submission)

External clock facts (not effort estimates): **WC final kicks off 19:00 UTC**, entries on the live final contest close at kickoff, **deadline 23:59 UTC**.

- **Before 19:00 UTC — record the entire video *except* the live-goal moment.** The full app walkthrough, login, entering a card, and all on-chain evidence are capturable **right now** from the deployed app + Solana explorer. Cut a complete, submittable video by ~18:30. **Do not make the submission depend on the final producing a convenient goal.**
- **19:00–~21:00 UTC (final running) — capture the hero segment:** a live goal moment (score flips, ticker fires, browser notification pops, a Live tap, a leg settling at the whistle). Enter the live final contest (`777020653`) on camera.
- **After the whistle —** drop the live moment into the cut, finalize ≤5 min, upload (YouTube unlisted or Loom).
- **Before 23:59 UTC —** submit the form(s). Sanity-check every link from an incognito window.

Rule of thumb: **the live goal is an upgrade to a video that is already done, never a dependency.**

### 2b. Shot-by-shot script (target ~4:20, hard cap 5:00)

Voiceover (VO) can be spoken or captions — your call. `[NOW]` = recordable before the final; `[LIVE]` = needs the final (or fall back to prior footage / keeper log b-roll).

| Time | On screen | Voiceover / caption |
|---|---|---|
| 0:00–0:15 | **[SETTLEMENT INTRO]** Title card → explorer showing a settled market account with the proof coordinates on it. | "Most on-chain prediction markets trust a cron to write the answer. BullStake settles only what TxLINE can *prove* on-chain. Here's the whole thing in four minutes." |
| 0:15–0:45 | `[NOW]` Open `bull-stake-production.up.railway.app` on a phone / narrow window. Email login via Privy. Install-to-home-screen prompt. | "No seed phrase, no extension — email login, installable as an app. It's real money on-chain end to end; this build runs on devnet SOL." |
| 0:45–1:45 | `[NOW]` **Sweep tab.** Today's card on the World Cup final. Show the legs (Match Result, Total Goals O/U 2.5, 1st-Half Result, 1st-Half O/U 0.5, Red Card Y/N). Show the **field-split bars** (crowd's money per bucket) moving. Make picks → enter → **share-card ticket** image. | "Sweep is the all-day survival card — up to six legs across the day's football. Your multiplier doubles per leg you carry, so a full card pays sixty-four to one. Every carried leg correct is a perfect card — perfect cards split the pot *plus* the rolling jackpot. Zero survivors and the whole pot rolls to tomorrow. And there are no buy-backs: once a leg kicks off, your picks freeze on-chain." |
| 1:45–2:30 | `[LIVE]` **Live tab** during the final. A goal goes in → score flips, ticker fires, notification pops. Tap a read before the window closes; streak ticks up. | "Live is the per-match game. It runs on MagicBlock Ephemeral Rollups so in-play taps land at rollup speed. As the match unfolds the keeper opens calls on live moments — you tap your read before the window closes, and correct calls build your streak. The pot pays out parimutuel at full time." |
| 2:30–3:40 | `[NOW]` **The moat.** Split screen / cuts: (1) a TxLINE `stat-validation` proof bundle JSON; (2) terminal running the keeper's on-chain `Txoracle.validateStat` view; (3) explorer on **settled contest `777020637`** with buckets `[0,1,0,0,1,1]`; (4) the **rollover tx** moving the pot into the **jackpot PDA `4LEY34Hv…MVBiq`**. | "Here's why the money is trustworthy. The keeper pulls TxLINE's three-stage Merkle proof for the stat, and verifies it *on-chain* against the day's root with `validateStat`. Settlement records the proof's coordinates — the event sequence, the timestamp, the proven value — right on the account, so anyone can re-fetch that proof and re-run the check. And the card settle takes *no result arguments at all*: it re-derives every market from the contest's own stored list and reads only proven buckets. The crank cannot invent a result. If the keeper ever disappears, anyone can void a stale contest and unlock refunds — the pot can't be frozen." |
| 3:40–4:10 | `[NOW]` Roadmap card + the rake parameter in code (`fee_bps = 0`). Feed scan showing international matches beyond the Cup. | "Monetization is already on-chain — rake is a program parameter, set to zero in this build; cosmetics are a second line. The free tier carries international matches past the tournament, so the app doesn't die when the Cup ends. Next: deeper football, then provably-fair *simulated* sports settled through this same pipeline — so 'no one can invent results' survives even when the sport is synthetic." |
| 4:10–4:25 | `[NOW]` Back to the live final contest open for entry. URLs on screen: app, repo, program id. | "Self-resolving on-chain markets on TxODDS. It's live right now on the final — link's below." |

**(Not used — settlement track only.)** Fan-cut alternative kept for reference: swap the 0:00–0:15 intro to a fan hook and trim the moat block. Since we're entering Prediction Markets & Settlement, keep the settlement intro and the full moat block — it's the winning beat, do not trim it.

### 2c. Recording checklist (tabs/windows to have ready)

- [ ] Deployed app in a **phone-shaped** window (it's a PWA — sell the mobile fan experience).
- [ ] A second wallet already funded with devnet SOL (so "enter" doesn't stall on faucet).
- [ ] Solana explorer (devnet) open to: settled contest `777020637`, its settle tx `52R5xMD3…`, and the jackpot PDA `4LEY34HvTdqfH8WKWuW6tjmxNzaP2ryzS5ce9WwMVBiq`.
- [ ] A terminal showing the keeper log / a `validateStat` run for b-roll of the proof check.
- [ ] A TxLINE `stat-validation` JSON response open (the proof bundle) — this is your "TxLINE powers the backend" visual proof, which the listing explicitly asks the video to show.
- [ ] Notifications enabled in the browser (so the live goal notification actually pops on camera).

---

## 3. Superteam form prose (paste-ready)

### Project name
**BullStake**

### Tagline / one-liner
- **Settlement track:** *Self-resolving on-chain prediction markets on TxODDS — the crank can't invent a result.*
- **Consumer & Fan:** *The World Cup as a one-tap game where every payout is provably real.*

### Short description (the summary box)
> BullStake is a real-money, on-chain football prediction market powered end-to-end by TxLINE. Two modes on one email-login wallet: **Sweep**, an all-day survival card where your multiplier doubles per leg and perfect cards split a rolling jackpot; and **Live**, a per-match tap game on MagicBlock rollups that reacts to real goals in-play. The differentiator is settlement: every result is a TxLINE Merkle proof verified **on-chain** (`Txoracle.validateStat`), and the settlement instruction takes no result arguments — so the operator physically cannot write a fake winner. Live on devnet at bull-stake-production.up.railway.app.

### Why it wins (map to the criteria)
- **Originality / value:** self-resolving markets — settlement that proves itself rather than trusting a cron. Nobody, including us, can inject a result on-chain.
- **Real-time responsiveness:** Live mode runs on MagicBlock Ephemeral Rollups; goals flip the score, fire the ticker, and pop a notification in-play; Sweep's field-split bars move as the crowd's money shifts pre-lock.
- **Distribution / liquidity:** settlement rails are worthless without bettors — email login (no seed phrase), installable PWA, one-tap picks. Ordinary fans onboard in seconds; they *are* the liquidity for these markets.
- **Monetization path:** rake is an on-chain parameter (`fee_bps`, 0 in this build) — the dial already exists; premium cosmetics are a second line; the free TxLINE tier carries international matches after the Cup, so the product has continuity.
- **Completeness / execution:** deployed, installable, real lamports moving on devnet, on-chain evidence readable right now, full test suites green (Anchor 114 · keeper 349 · engine 267 · web 187).
- **A platform, not one game:** three market types already run on the same proof-settled engine — the Live pools, the Sweep card, and an Above/Below **line market** (built and e2e-proven on devnet; hidden in this build to keep the demo focused). A **tradeable buy/sell market (LMSR)** is designed next — see `docs/secondary-prediction-market.md` in the repo: drain-proof cost-function math worked out, and it inherits the proof settlement for free.

### Links block
- **Live app:** https://bull-stake-production.up.railway.app
- **Public repo:** https://github.com/EchoWebLV/bull-stake
- **Demo video:** _<paste after upload>_
- **Program (Solana devnet):** `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`
- **Rolling jackpot PDA:** `4LEY34HvTdqfH8WKWuW6tjmxNzaP2ryzS5ce9WwMVBiq`
- **Live final contest (open now):** `777020653` (PDA `DQ2X5yjrCC89J9Ewt1Es8zm6nW7sqsH62yZg6RWtSnBP`)

### TxLINE endpoints used (the doc asks for this list)
`POST /auth/guest/start` → on-chain `Txoracle.subscribe` → `POST /api/token/activate` (wallet-signed) · `GET /api/fixtures/snapshot` · `GET /api/scores/historical/{id}` · `GET /api/scores/snapshot/{id}` · `GET /api/odds/snapshot/{id}` · `GET /api/odds/updates/{id}` · `GET /api/scores/stat-validation` · on-chain `Txoracle.validateStat`.

### TxLINE feedback (the doc asks for this)
Already written and substantive — reuse **§6 of [docs/HACKATHON.md](HACKATHON.md)** verbatim (wallet-signed activation praise; the on-chain-verifiable three-stage proof bundle; pull+push on one schema; post-Cup matches on the free tier = continuity; the constructive bites: no player-level data, the `StatusId 100` after-terminal quirk, thin devnet pre-match odds, activation re-subscribe cost).

**(Not used — settlement track only.)** Use the **settlement** tagline and lead with the settlement sentence. The fan framing above stays in §1 only as an alternative angle you can borrow a phrase from; the submission is Prediction Markets & Settlement.

---

## 4. Submission checklist (hard requirements)

| Requirement | Status | Note |
|---|---|---|
| Demo video ≤5 min (screening gate) | ☐ TODO | §2 — the priority. |
| Working deployed link | ✅ | Railway app live. Confirm it's up + a judge can log in cold, **and keep services up through Jul 29**. |
| Public repo | ✅ | `github.com/EchoWebLV/bull-stake`. Confirm it's public + history secret-scan clean. |
| Brief technical documentation | ✅ | [docs/HACKATHON.md](HACKATHON.md) — link it in the repo README. |
| TxLINE API feedback | ✅ | §6 of the tech doc. |
| Uses TxLINE as live input | ✅ | Enumerated above. |
| Sign up through Solana | ✅ | Privy wallet + on-chain `subscribe`. |
| Functional, not a mockup | ✅ | Real on-chain loop; evidence readable on devnet. |
| Superteam form submitted | ☐ TODO | §3. Submit to **Prediction Markets & Settlement** before 23:59 UTC; verify links from incognito. |
| Track decision | ✅ | One project = one track (FAQ). Decided: Prediction Markets & Settlement. §0. |

**Disqualifiers to avoid:** pitch-deck-only / mockup-only submissions are auto-rejected — you're safe (real product), just make sure the video shows the *working app*, not slides.

---

## 5. Risks for today

- **Cold post-Cup app.** Judges open the link *after* matches end. Make sure the app doesn't look dead with no live fixtures — a quiet-day/recap state (jackpot ticker + past cards) matters. If it currently looks empty, the video must carry the live feel.
- **MagicBlock undelegation intermittence** during the live capture → if Live wobbles on camera, the Sweep card + the on-chain settlement evidence carry the video. Don't gamble the hero take on ER cooperating.
- **Deadline compression.** Have the submittable cut done before kickoff; treat the live goal as a bonus reel.
