# BullStake — demo video script

**Track:** Prediction Markets & Settlement · **Target run time:** ~4:20 (hard cap 5:00)
**Read:** voiceover *or* on-screen captions — your call. Tags: `[NOW]` = recordable before kickoff · `[LIVE]` = wants the final (fall back to prior footage / keeper-log b-roll if needed).

Delivery notes: talk like you're showing a mate the thing you're proud of, not reading a spec. Slow down on the settlement section — that's the beat that wins. Let the on-chain explorer sit on screen a second longer than feels natural; judges want to *see* it's real.

---

## 1 — Cold open: the flaw everyone ships (0:00–0:25) `[NOW]`

**On screen:** Black title card: **BULLSTAKE**. Cut to a Solana explorer, zoomed on a settled market account with the proof fields visible.

> "Almost every on-chain prediction market ships the same quiet flaw. The bet is on-chain. The money is on-chain. But the moment the match ends, a script the operator controls just *writes the winner* into the contract. The whole thing is trustless — right up until the one step that decides who gets paid. BullStake fixes exactly that step."

---

## 2 — What it is (0:25–0:55) `[NOW]`

**On screen:** Open `bull-stake-production.up.railway.app` in a phone-shaped window. Email login (Privy). "Add to Home Screen" prompt.

> "BullStake is a real-money football prediction market, powered end to end by TxLINE. You log in with an email — no seed phrase, no extension — and it installs like a normal app. Everything you're about to see is real lamports moving on-chain; this build runs on Solana devnet."

---

## 3 — The game, part one: Sweep (0:55–1:45) `[NOW]`

**On screen:** Sweep tab. Today's card on the World Cup final. Scroll the legs. Point at the **field-split bars**. Make picks → enter → the **share-card ticket** image. *(Optional b-roll: the keeper's `create-daily-pearly --dry-run` output composing the card, to back the "no human builds it" line.)*

> "There are two ways to play. This is Sweep — one card, up to six legs across the day's football. And nobody hand-builds it: every morning the keeper composes the card by itself — it pulls the day's real fixtures from TxLINE, an allocator picks the legs, and it opens the markets on-chain. Your multiplier doubles for every leg you carry, so a full six-leg card pays sixty-four to one. These bars are the crowd's money on each side, live — so the odds are something you watch move before you commit. Once a leg kicks off, your picks freeze on-chain. No buy-backs. Carry every leg correct and you've got a perfect card — perfect cards split the pot *and* the entire rolling jackpot. Nobody survives the day, and the whole pot rolls into tomorrow's card."

---

## 4 — The game, part two: Live (1:45–2:20) `[LIVE]`

**On screen:** Live tab during the final. A goal goes in — score flips, ticker fires, a browser notification pops. Tap a read before the window closes. Streak ticks up.

> "And this is Live — the per-match game. It runs on MagicBlock ephemeral rollups, so your in-play taps land at rollup speed. As the match unfolds, the keeper opens quick calls on live moments — you read the game and tap before the window closes. Correct calls build your streak, and the pot pays out parimutuel at full time."

---

## 5 — The moat: settlement that proves itself (2:20–3:40) `[NOW]` — *slow down here*

**On screen, cut between:** (1) a TxLINE `stat-validation` JSON response — the proof bundle; (2) a terminal running the on-chain `validateStat` view; (3) explorer on **settled contest `777020637`** with buckets `[0,1,0,0,1,1]` and the recorded proof coordinates; (4) the `settle_contest` source, highlighting that it takes no result arguments.

> "Now the part that matters. When a match ends, the keeper doesn't *decide* the result — it *proves* it. It pulls TxLINE's Merkle proof for the stat: the stat, its proof up to an event root, the fixture summary, and the main-tree proof. Then it runs that proof through the oracle's own on-chain program — `validateStat` — which re-hashes it against the day's root that lives on-chain, and checks the outcome. Only a *proven* result becomes a winning bucket.
>
> When the market settles, it records the proof's coordinates — the event sequence, the timestamp, the proven value — right on the account. So anyone can re-fetch that exact proof and re-run the check themselves.
>
> And the card settle goes one step further. `settle_contest` takes *no result arguments at all*. It re-derives every market from the contest's own stored list, rejects any account that doesn't match, and reads only the proven buckets. There is no input, anywhere, where an operator could type in a winner. The crank *cannot* invent a result. And if the keeper ever disappears, anyone can void a stale contest and unlock refunds — the pot can't be frozen.
>
> Put it together and there's no operator discretion anywhere. The markets are composed by an allocator; the results are decided by proofs. Not by us."

---

## 6 — Proof it's real (3:40–4:05) `[NOW]`

**On screen:** Explorer on settled contest `777020637`, its settle/rollover tx, and the **jackpot PDA** balance. Flash the green test-suite counts.

> "This isn't a mockup. Here's a contest that settled from six proof-gated legs, with zero survivors, rolling its whole pot into the jackpot — real lamports, on devnet, readable right now. The full stack is tested green, and it's live on the World Cup final as we speak."

---

## 7 — Business, roadmap, close (4:05–4:35) `[NOW]`

**On screen:** `fee_bps` in the program source. Feed scan showing international matches beyond the Cup. Roadmap card. End card: wordmark + the three links.

> "The business is already wired in — rake is an on-chain parameter, set to zero for the hackathon, with cosmetics as a second line. The free data tier carries international matches well past the Cup, so this doesn't die when the tournament does. Next: deeper football, then provably-fair *simulated* sports settled through this same pipeline — so 'no one can invent results' holds even when the sport is synthetic. Self-resolving on-chain markets on TxODDS. That's BullStake."

**End card (hold 3s):**
`bull-stake-production.up.railway.app` · `github.com/EchoWebLV/bull-stake` · program `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`

---

## If you need a 3:00 cut
Drop Section 4 (Live) to a single 8-second shot with one line ("a per-match tap game on MagicBlock rollups"), and trim Section 3 to picks→enter without the field-bar aside. **Never** cut Section 5 — the moat is the submission.

## Word count / pacing
~530 words of VO ≈ 3:30 spoken; the extra minute is visual beats (explorer holds, the live goal, the ticket render). Comfortably under 5:00.

## Recording checklist
See §2c of [SUBMISSION-PITCH.md](SUBMISSION-PITCH.md) — funded second wallet, explorer tabs pre-opened to the real accounts, keeper terminal for b-roll, notifications enabled, phone-shaped window.
