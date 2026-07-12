# Bull Stake — hackathon submission run (final week)

**Date:** 2026-07-12 · **Branch:** `feat/streak-pivot` · **Deadline:** submissions close **2026-07-19 23:59 UTC** (TxODDS World Cup hackathon, Consumer & Fan Experiences track, 1st = 10k USDT).

**Goal:** a 10/10 submission against the five judging criteria (fan UX, real-time responsiveness, originality, monetization path, completeness), with every hard submission requirement met.

## How judges actually experience the entry

1. **Demo video (≤5 min)** — the screening gate; the listing says submissions are "evaluated heavily based on the demo video" because matches end before review.
2. **Deployed link** — opened *after* July 19, when no matches are live. The app must not look dead post-tournament.
3. **Public repo + tech doc + TxLINE feedback** — skimmed for substance.
4. Shortlist → live interviews.

Artifact priority is therefore: **video > deployed first-impression > docs/repo**.

## Verified ground truth (2026-07-12 ~15:20 UTC)

- All suites green: **web 166, engine 261, keeper 347** (run 2026-07-12). Anchor suite not re-run today (~20 min run); the program is unchanged since its last green run.
- **~1,150 lines uncommitted** on `feat/streak-pivot`: Bull Stake rename, engine SWR live-bundle (shared scan for `/api/card` + `/api/contest/live`, fixes the frozen Sweep tab + RPC 429 storm), keep-alive tab panes, wallet menu, voided-with-bucket leg reads, `JOIN_AHEAD_MIN` 45→1440 (all-day live joins).
- **TxLINE slate** (`list-slate.ts 200 24`): only **France–Spain 2026-07-14 19:00 UTC** and **England–Argentina 2026-07-15 19:00 UTC** ahead. Bronze (Jul 18) / final (Jul 19) absent until teams are known. The final kicks off hours before the submission cutoff — never the plan-of-record capture.
- **No git remote. Nothing deployed** (`web/.env` → localhost engine). No video, no tech doc.
- Skin assets: hand-drawn fonts vendored **and wired** (`@font-face` in `App.css`); 49 flag SVGs vendored, `flags.ts` wired into Sweep only; `Mascot.tsx` is a placeholder silhouette, used nowhere; `web/public/mascot/` holds only a README expecting 5 PNGs (red "busted" not yet drawn).
- Bank-or-ride = mockups only (21/22); zero code.
- Env hygiene: `.env` gitignored everywhere, only `.env.example` tracked. History secret-scan still owed before going public.
- No leaderboard, no in-app faucet (WalletView shows guidance copy only).

## Decisions (user-approved 2026-07-12)

1. **Visual scope = skin the current app.** Keep the proven 4-tab structure (Live / Sweep / My Bets / Wallet); land the hand-drawn identity on it (fonts + App.css finish, mascot avatars, flags in Live, first-run tour). No unified one-screen rebuild (mockup 25 stays a mockup this cycle).
2. **Live game = polish existing.** No bank-or-ride mechanic this cycle. Mascot reactions + flags + copy polish + reliability drill only.

Standing directives that bind this plan: **real-money framing only** (never demo/paper/free-to-play), **Railway-only deploys**, multiplier UI copy (banned: "weight", "2^", "mask", "active legs", "perfect_weight"), **no on-chain program changes** (deployed, battle-tested; anchor suite ~20 min), do not merge to `main` without the user.

## Workstreams

### WS0 — Pre-flight: semi-day card composition (do first, blocks everything demo-shaped)

The Sweep composer has only ever run against multi-fixture days. **Jul 14 and Jul 15 each have exactly ONE fixture.** If `create-daily-pearly` can't compose a 6-leg card from a one-match slate (multiple markets + chaos leg on the same fixture), there is no Sweep card during either capture window — the demo's centerpiece vanishes.

- Dry-run the composer locally against the Jul 14 slate window today. If it under-fills or refuses, fix allocator config/leg-count fallback (keeper-side only) + tests.
- Definition of done: a composed card for a one-fixture day, with legs/locks printed and sane.

### WS1 — Lock in + public repo

- Commit the current green tree as logical commits (engine SWR bundle; web rename/keep-alive/wallet-menu; keeper settle/schedule changes; flags/fonts/Mascot/lib; mockups; `.gitignore`). `keeper/audit-owners.tmp.ts` stays untracked.
- Full-history secret scan (gitleaks or equivalent). Expected clean (env files ignored since early); rotate anything found — never rewrite history.
- Create the **public GitHub repo** (suggest name `bull-stake`; local dir can stay `ProofBet`), push `feat/streak-pivot`, set it as the remote default branch (avoids merging to `main` without the user).
- Definition of done: public URL shows the real product + full commit history; secret scan logged clean.

### WS2 — Deploy on Railway (live before Jul 14 19:00 UTC)

- **Engine service**: Fastify on Railway; env per `engine/.env.example` (Helius RPC key server-side, `WEB_ORIGIN` = deployed web origin for CORS).
- **Keeper service**: `cron.ts` with `PEARLY_CREATE=1` + whatever the semis need for live pools (`POOL_SCHEDULE`) — confirm exact flags against current cron behavior at execution.
- **Web static service**: Vite build; `VITE_ENGINE_URL` → engine URL; PWA manifest + installability check; drop the stale Google Fonts preconnect (fonts are vendored).
- Known adaptation: engine/keeper expect `WALLET_SECRET_KEY` as a **file path** — on Railway, write the key from a secret env var to a file at boot (start-command step; no code change).
- Keep services up through **July 29** (winner announcement) — judges test late.
- Definition of done: full loop (login → fund → enter Sweep → live pool join) succeeds on the deployed URL from a fresh device.

### WS3 — The skin (approved scope; lands between now and semi 2)

- **Mascot art (USER)**: draw/export the missing red "busted"; deliver 5 PNGs per `web/public/mascot/README.md` mapping.
- Swap `Mascot.tsx` placeholder → `<img>`; wire avatars into LoginBar, Sweep HUD (alive = riding-green, dead = busted-red identity variants — UI-only), live-view entries.
- Flags into `LiveMatchView` (Sweep already wired).
- Finish the hand-drawn `App.css` pass (in-flight, large diff already in tree).
- **First-run tour**: 3 panels (mockup 20 as reference), localStorage-gated.
- **Post-tournament recap state**: when the slate is empty and no card is live → recap (final jackpot total, your settled cards, the self-resolving one-liner). This is what judges see Jul 20+.
- Copy pass: multiplier framing everywhere; judge-proof onboarding (logged-out state, zero-balance state pointing at a devnet faucet with copy-address).
- Definition of done: every screen a judge can reach looks intentional in the hand-drawn identity, including logged-out/empty/post-cup states.

### WS4 — Demo video (the artifact that gets judged)

- **Script before semi 1** so the live shots are known in advance: problem (fan + phone) → email login, no seed phrase → enter the day's Sweep card → **live goal moment on camera** (score flips, ticker fires, browser notification pops) → leg settles at FT → on-chain settle + claim in the explorer → rollover jackpot story → "self-resolving on-chain markets on TxODDS" → rake parameter (monetization).
- Record the **full loop on both semis**: Jul 14 = safety take + dress rehearsal of the deployed app; Jul 15 = hero take. Keeper-log terminal + explorer tabs as B-roll. This is also the shot at the still-owed perfect-card weighted-claim capture.
- Edit to ≤5 min, voiceover or captions (USER choice), upload (YouTube unlisted / Loom).
- Definition of done: uploaded link that passes the listing's screening bar and shows TxLINE visibly powering the app.

### WS5 — Docs + submission (complete before the final)

- **README** as the public cover: what/why, stack, run instructions, live link, video link.
- **Tech doc**: architecture (TxLINE → keeper/engine → Anchor program → web), exact TxLINE endpoints enumerated from `engine/src/catalog.ts` + `keeper/live-feed.ts` + spike auth, judging-criteria mapping, monetization paragraph (configurable on-chain rake bps; premium mascot cosmetics as a second line).
- **TxLINE feedback section** (explicitly requested): StatusId-100-after-terminal-phase quirk (and our absorbing-terminal fix), devnet pre-match odds absence (neutral-priors workaround), praise for the normalized schema + free hackathon access, auth/activate token-caching note.
- **Superteam form (USER submits)**; target **Jul 18**, using bronze/final only as bonus footage. Check T&C whether the same project may also enter the Prediction Markets & Settlement track (18k pool) with a settlement-angled writeup.
- Definition of done: submission confirmed on Superteam Earn before Jul 19; all links resolve from an incognito browser.

## Calendar anchors (external facts, not effort estimates)

| When (UTC) | What must be true |
|---|---|
| Jul 12–13 | WS0 pre-flight done; tree committed; repo public; Railway deploy live; video script written |
| Jul 14 08:00 | Keeper composes the semi-1 card on the deployed stack — verify |
| Jul 14 19:00 | Semi 1: dress rehearsal on deployed app; safety capture; enter real card + live pool |
| Jul 15 19:00 | Semi 2: hero capture on the polished skin |
| Jul 16–17 | Edit video; docs; fixes from rehearsal findings; post-cup recap state verified |
| Jul 18 | Bronze = buffer capture; **submit** |
| Jul 19 | Final = bonus footage only; deadline 23:59 |

## Cut list (protects the deadline)

No bank-or-ride mechanic · no new markets · no leaderboard · no SSE · Market tab stays hidden · no on-chain program changes · no unified one-screen rebuild · no re-entry/buy-backs (spec §11 stands).

## Risks & mitigations

- **MagicBlock undelegation intermittence** during a capture window → keeper is handback-gated + idempotent; `void-live-pool.ts` refund path proven; the Sweep card carries the demo if Live wobbles.
- **One-fixture semi days break the composer** → WS0 pre-flight today, keeper-side fix if needed.
- **Bronze/final missing from slate until teams known** → re-check after semi 2; plan never depends on them.
- **Public-repo secret leak** → history scan gates the push; rotate on hit.
- **RPC rate limits under judge traffic** → SWR bundle already collapses scans; Helius key server-side.
- **Mascot art late (USER dependency)** → everything else proceeds; placeholder silhouette remains the fallback.
- **Deployed-app cold judges post-cup** → WS3 recap state is mandatory, not stretch.
