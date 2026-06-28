# Streak M0 — Demo Runbook (devnet)

End-to-end walkthrough of the walking skeleton: **log in → bet → settle from a TxLINE proof → claim**, all on devnet.

## Live devnet artifacts
- **Program:** `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ` ([explorer](https://explorer.solana.com/address/By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ?cluster=devnet))
- **Operator key:** `~/.config/solana/lazer-probe.json` (`FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM`) — deployer, market creator, and keeper `settle_authority`.
- **Demo market (corners O/U 9.5, fixture 17952170):** `GuPJtcR882RYEC22PCxQ9Xm4uCsecc6oi3FVT8qkcCEh`
  Predicate: `(P1_corners[7] + P2_corners[8]) > 9`. Settled value for this fixture = **13 → OVER (bucket 0) wins**.

## Prerequisites
- Funded devnet operator key (above) — `solana balance -k ~/.config/solana/lazer-probe.json -ud`.
- `engine/.env` and `keeper/.env` configured (committed `.env.example` shows the keys; both use the operator key).
- `web/.env` with a real `VITE_PRIVY_APP_ID` (from dashboard.privy.io — Email + Google login + Solana wallets).

## Create a fresh market with a short window (for a tight demo)
The committed market has a fixed entry window; for a recordable bet→settle loop, create a fresh one with a short window and point the engine at it:
```bash
cd engine
npm run create-market -- --fixture 17952170 --market 2 --close-mins 6
# paste the printed M0_MARKET_PUBKEY (and M0_MARKET_ID=2) into engine/.env
```
(Each `(fixture_id, market_id)` is a unique market PDA, so bump `--market` for a new one.)

## Run it
**Terminal 1 — engine:**
```bash
cd engine && npm run start      # serves http://localhost:8787
```
**Terminal 2 — web:**
```bash
cd web && npm run dev           # serves http://localhost:5173
```

## Demo flow (~2 min)
1. Open http://localhost:5173 → **Log in** (Google/email via Privy) → an embedded Solana wallet is created.
2. Fund it: copy the wallet address shown, then `solana airdrop 1 <address> -ud`.
3. The market card shows **Brazil vs Spain — Total Corners O/U 9.5**, the live feed ticking corners, and pool-implied odds.
4. Pick **Over**, enter `0.1`, **Bet** → approve in the Privy modal. Pool + odds update on the next 3s poll.
5. Wait for the entry window to close (the `--close-mins` you set).
6. **Settle from the proof** (keeper, operator key):
   ```bash
   cd keeper && npx tsx settle.ts <M0_MARKET_PUBKEY>        # add --dry-run to preview
   ```
   Resolves fixture 17952170's corners via `validateStat` (13 > 9 → OVER) and submits `settle`.
7. The web app flips to **Settled — Winner: Over**. Click **Claim payout** → approve → SOL returns to the embedded wallet.

## Notes
- Settlement is **verifiable, single-source** (the on-chain record binds the exact proof inputs) — not "trustless"; full trustlessness is the CPI path (roadmap).
- For the video, the deterministic replay (`engine/data/replay.json`, captured from the real fixture) means the feed plays the same every run.
- Zero-winner markets auto-void on settle (full refunds via `claim`).
