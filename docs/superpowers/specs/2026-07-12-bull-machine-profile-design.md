# Bull Machine → Bull Stake Profile (devnet NFT membership PFP)

**Date:** 2026-07-12 · **Branch:** `feat/streak-pivot` · **Status:** user-approved (machine UI = hand-drawn 3×3; placement = Wallet tab → Profile)

## Goal

Bring the SOL bulls "Bull Machine" into Bull Stake as the profile surface: a user spins the machine on devnet, a provably-fair unique bull NFT mints **into their Privy wallet**, and that bull becomes their profile picture across the app (LoginBar chip, live HUD, profile). This is the NFT-membership foundation and the future MagicBlock-hackathon centerpiece; it stays **out of the TxODDS demo video**.

## Verified source facts (read 2026-07-12 from `~/Documents/GitHub/SOL bulls`, branch `phase-a`)

- **Bridge** `demo/er-chain.src.js` (436 lines): the whole flow needs a wallet only as `{ publicKey, signTransaction }`. Exactly **one player signature** (`openSession`: optional close-spent + create_session + session-key top-up transfer + delegate, bundled in one tx). Spins are **session-key-signed direct to the MagicBlock ER node** (router `devnet-router.magicblock.app`, VRF resolves sub-second). `cashOut` is **zero-signature**: session key cranks finalize (ER) → waits undelegation → `settle_mint` per ROLLED slot on L1 → sweeps leftovers back to the player. `closeSession` (player-signed) reclaims rent.
- **Mint recipient is the player wallet** (`settleMint` uses `player: _wallet.publicKey`) — with Privy connected, bulls land in the user's Privy wallet.
- **ER-capable program (devnet):** `CHRm6pgBYXHSW1xWYT8YKNfKXhM1LorGm2yMKxLdQy6i` (`demo/bull_machine.er.json` IDL). Config account self-describes treasury/collection/spinPrice — no hardcoded economics. E2E devnet run: VERDICT GREEN (SOL bulls port plan).
- **Art pipeline:** `demo/textures/manifest.json` — ordered categories, each trait `{name, weight, tile, layer}`; 9 on-chain trait indices → stack `layers/cX_tY.png` in category order = the bull image; `tiles/` are small reel faces. Total assets ≈ 5.8 MB.
- **Costs (devnet SOL, preflighted in plain English by the bridge):** spinPrice×n + 20M lamports session-key top-up + (5M + 10M×n) mint-crank headroom (swept back) + ~15M rent/fees margin.
- **Traits recovery limitation:** sessions close after cash-out; re-deriving a minted bull's traits later needs DAS/attribute reads (unverified). v1 stores `{asset, traits}` locally at mint time; on-chain re-derivation is a stretch item.

## Decisions

1. **Machine UI = native hand-drawn 3×3** in Bull Stake's visual language: a 3×3 grid of real trait *tiles* spinning, the lever as the one action, reveal card composed from *layers*. Same program, same VRF, same mint. The Three.js machine stays in SOL bulls.
2. **Placement = Wallet tab → Profile**: PFP block (bull if set, mascot silhouette otherwise) + address/balance + "Spin for your Bull · devnet" opening the machine as a full-screen in-app overlay. No nav changes.
3. **Bridge ported natively** to `web/src/lib/` (deps `@coral-xyz/anchor` + `@solana/web3.js` already in web/); wallet adapter = the existing Privy signer; RPC = `VITE_RPC_URL` (Helius) instead of the public devnet endpoint (bridge already has 429 backoff).
4. **Sequencing:** TxODDS-critical work (WS0 composer fix, tree commit, deploy) stays first in line; capture windows Jul 14/15 win any conflict. The machine build is isolated (new files + small `WalletView`/`LoginBar` edits) so it can't destabilize the submission path.

## Architecture

| Unit | Purpose | Depends on |
|---|---|---|
| `web/src/idl/bull_machine.er.json` | IDL copy (program id source of truth) | — |
| `web/src/lib/bullMachine.ts` | Port of er-chain bridge: PDAs, frozen Session layout decode, openSession/spin/pollRolled/cancelSpin/cashOut/closeSession/fetchState, `connectPrivy(pubkey, signTx)` adapter, Helius RPC, retry/confirm plumbing verbatim | IDL, Privy signer |
| `web/public/bull/` | `manifest.json` + `layers/` + `tiles/` copied from SOL bulls | — |
| `web/src/lib/bullArt.ts` | Manifest loader + canvas compositor: `traits[9] → image` (reveal card + PFP); lazy-loads layers on demand | assets |
| `web/src/lib/profile.ts` | PFP store: localStorage `{asset, traits, setAt}` + subscribe hook; fallback chain bull → mascot color | bullArt |
| `web/src/components/BullMachine.tsx` | Hand-drawn 3×3 overlay: states no-session → open (one Privy approval, 1–10 spins) → ready → spinning (tiles cycle) → rolled (reveal + "mints at cash-out") → cash-out (narrated: finalize/undelegate/mint/sweep) → done ("Set as profile picture") | bullMachine, bullArt, profile |
| `WalletView` Profile section · `LoginBar` chip · live HUD avatar | Consume the PFP hook; silhouette fallback keeps WS3 mascot work intact | profile |

**Error surfaces:** bridge preflight messages shown verbatim (they're already plain-English); VRF timeout → offer cancel-spin; undelegation stall (>60s) → "bulls are safe, retry cash-out" (cashOut is idempotent per slot: only ROLLED slots mint); duplicate-combo discard is narrated as a re-roll credit lost to cosmic rarity.

**Custody note (devnet demo):** session keys and burner-style storage live in localStorage exactly as the proven demo does; acceptable for devnet, flagged for any mainnet future.

## Testing

- `bullArt` mapper: trait indices → correct layer paths (manifest fixture), compositor order.
- `bullMachine` pure parts: Session byte-layout decode against a captured fixture; PDA derivations vs known devnet addresses; open-cost preflight math.
- `profile` store: set/clear/fallback.
- Component: state-machine rendering per phase (existing vitest+jsdom patterns).
- E2E (manual, devnet): one full run from a Privy wallet — open → spin → reveal → cash-out → bull in wallet (explorer link) → PFP set → survives reload. Evidence captured for the MagicBlock submission.

## Out of scope

Membership perks/gating; mainnet; attribute-based cross-device trait recovery (stretch); embedding the Three.js machine; any TxODDS-video appearance; changes to the bull_machine program or the SOL bulls repo.
