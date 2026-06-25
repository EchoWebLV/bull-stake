/**
 * Verified constants for the TxLINE soccer scores feed and the Txoracle program.
 * Sources (txline-docs.txodds.com): scores/soccer-feed, programs/devnet,
 * programs/addresses, worldcup, subscription-tiers, examples/onchain-validation,
 * and the OpenAPI spec at txline.txodds.com/docs/docs.yaml.
 *
 * Everything here was confirmed verbatim from the docs during the research pass.
 * Documented ambiguities (the auth/data host conflict, whether live data is
 * rooted) are surfaced as comments and handled defensively at runtime.
 */

import { PublicKey } from "@solana/web3.js";

// ── Cluster addresses (programs/addresses) ────────────────────────────────────

export const DEVNET = {
  programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
  txlMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
  usdtMint: new PublicKey("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh"),
  /** Devnet API endpoint per the addresses page. Examples hardcode the prod host. */
  apiBase: "https://txline-dev.txodds.com",
} as const;

export const MAINNET = {
  programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
  txlMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
  usdtMint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
  apiBase: "https://txline.txodds.com",
} as const;

/** The spike targets devnet (that is where the program ID above is deployed). */
export const TXORACLE_PROGRAM_ID = DEVNET.programId;
export const SUBSCRIPTION_TOKEN_MINT = DEVNET.txlMint;
export const DEFAULT_TXLINE_BASE_URL = DEVNET.apiBase;

// ── PDA seed prefixes (programs/addresses) ────────────────────────────────────

export const SEED = {
  TOKEN_TREASURY: "token_treasury_v2",
  PRICING_MATRIX: "pricing_matrix",
  DAILY_SCORES_ROOTS: "daily_scores_roots",
  DAILY_BATCH_ROOTS: "daily_batch_roots",
} as const;

// ── Free World Cup tier (worldcup / subscription-tiers) ───────────────────────

/** Devnet free tier is Level 1 only (Level 12 real-time is mainnet-only). */
export const FREE_SERVICE_LEVEL_DEVNET = 1;
/** Subscriptions are sold in multiples of 4 weeks; minimum (and free default) is 4. */
export const DEFAULT_DURATION_WEEKS = 4;
/** World Cup / Int Friendlies free tier is a "standard matrix" sub → empty leagues. */
export const STANDARD_TIER_LEAGUES: number[] = [];

// ── Soccer feed: stat keys (scores/soccer-feed) ───────────────────────────────

/** Soccer full-game base stat keys (1-8). Encoding: (period * 1000) + base. */
export const SOCCER_STAT = {
  P1_GOALS: 1,
  P2_GOALS: 2,
  P1_YELLOW: 3,
  P2_YELLOW: 4,
  P1_RED: 5,
  P2_RED: 6,
  P1_CORNERS: 7,
  P2_CORNERS: 8,
} as const;

/** Period multipliers added to a base stat key to select a period. */
export const PERIOD = {
  FULL_GAME: 0,
  H1: 1000,
  H2: 2000,
  ET1: 3000,
  ET2: 4000,
  PENS: 5000,
} as const;

/** Compose a period-specific stat key, e.g. statKey(P1_GOALS, H1) === 1001. */
export function statKey(base: number, period: number = PERIOD.FULL_GAME): number {
  return base + period;
}

// ── Soccer feed: phase codes (scores/soccer-feed) ─────────────────────────────

export const PHASE = {
  NS: 1, // not started
  H1: 2, // first half in play
  HT: 3, // halftime  -> H1 props final
  H2: 4, // second half in play
  F: 5, // ended (finished) -> full-game props final
  WET: 6, // waiting for extra time
  ET1: 7,
  HTET: 8,
  ET2: 9,
  FET: 10, // ended after extra time
  WPE: 11, // waiting for penalty shootout
  PE: 12, // penalty shootout in progress
  FPE: 13, // ended after penalty shootout
  I: 14, // interrupted
  A: 15, // abandoned
  C: 16, // cancelled
  TXCC: 17, // tx coverage cancelled
  TXCS: 18, // tx coverage suspended
  P: 19, // postponed
} as const;

export const PHASE_NAME: Record<number, string> = {
  1: "NS", 2: "H1", 3: "HT", 4: "H2", 5: "F", 6: "WET", 7: "ET1", 8: "HTET",
  9: "ET2", 10: "FET", 11: "WPE", 12: "PE", 13: "FPE", 14: "I", 15: "A",
  16: "C", 17: "TXCC", 18: "TXCS", 19: "P",
};

/** Phases on which a full-game prop is final and safe to settle. */
export const FINISHED_PHASES = new Set<number>([PHASE.F, PHASE.FET, PHASE.FPE]);

/** Phases on which a pool must be refunded rather than settled. */
export const VOID_PHASES = new Set<number>([
  PHASE.I, PHASE.A, PHASE.C, PHASE.TXCC, PHASE.TXCS, PHASE.P,
]);

export const isFullGameFinal = (phase: number) => FINISHED_PHASES.has(phase);
export const isH1Final = (phase: number) =>
  phase >= PHASE.HT && !VOID_PHASES.has(phase);
export const isVoid = (phase: number) => VOID_PHASES.has(phase);

// ── Misc ──────────────────────────────────────────────────────────────────────

/** validateStat can be compute-heavy; budget generously. */
export const VALIDATE_STAT_CU = 1_400_000;

/**
 * Documented working example from examples/onchain-validation — used as a
 * smoke-test fallback when live discovery finds no rooted soccer stat.
 */
export const EXAMPLE_STAT = {
  fixtureId: 17952170,
  seq: 941,
  statKey: 1002, // P2 first-half goals
  statKey2: 1003, // P1 first-half yellow cards
} as const;
