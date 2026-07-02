import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  process.env.PROOFBET_PROGRAM_ID ?? "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
);
export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

/**
 * MagicBlock Ephemeral Rollup RPC. While a live pool is in play its Call /
 * LiveCursor / LiveEntry PDAs are delegated to the ER, and their LIVE state
 * (the open call, taps landing, points ticking up) exists ONLY here — the
 * base-layer copy is frozen at the last `commit_live`, which the keeper only
 * ever runs AFTER a call resolves, so an open call is never visible on base.
 * The engine reads delegated accounts ER-first (base as pre-lock / post-settle
 * fallback). LivePool is never delegated → always base.
 */
export const ER_RPC = process.env.ER_RPC ?? "https://devnet.magicblock.app";

// M0 market identity (filled in after create-market).
export const M0 = {
  fixtureId: Number(process.env.M0_FIXTURE_ID ?? 0),
  marketId: Number(process.env.M0_MARKET_ID ?? 1),
  marketPubkey: process.env.M0_MARKET_PUBKEY ?? "",
  // Display metadata for the demo card:
  home: process.env.M0_HOME ?? "Brazil",
  away: process.env.M0_AWAY ?? "Spain",
  line: 9.5,
  label: "Total Corners",
};

export const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Minutes before kickoff that a game's join window opens — the keeper creates the
 * pool at T-minus this (its own JOIN_AHEAD_MIN mirrors it), and /api/live/next
 * reports `joinOpensTs` from it so the countdown can say when Join lights up.
 * On-chain, joins hard-close at lock_ts (= kickoff); this only sets the OPEN edge.
 */
export const JOIN_AHEAD_MIN = Number(process.env.JOIN_AHEAD_MIN ?? 45);

/**
 * Competitions eligible for the slate / sweepstake card.
 * Default: World Cup only (what the devnet free tier carries). Year-round
 * operation needs a broader TxLINE entitlement — once it's available, widen via
 *   COMPETITION_ALLOWLIST="World Cup,Premier League,La Liga,…"
 * with no code change. Comparison is against TxLINE's `Competition` string.
 */
export const COMPETITION_ALLOWLIST: string[] = (process.env.COMPETITION_ALLOWLIST ?? "World Cup")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
