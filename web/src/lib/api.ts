const ENGINE = import.meta.env.VITE_ENGINE_URL ?? "http://localhost:8787";

export interface MatchState {
  fixtureId: number; home: string; away: string; minute: number; phase: string;
  scoreH: number; scoreA: number; corners1: number; corners2: number;
  totalCorners: number; isFinal: boolean;
}
export interface MarketState {
  pubkey: string; status: "open" | "settled" | "voided"; fixtureId: number; marketId: number;
  bucketTotals: [string, string]; totalPool: string; feeBps: number; winningBucket: number | null;
  entryCloseTs: number; settledValue: number | null;
  meta: { home: string; away: string; line: number; label: string };
  impliedOdds: { over: number; under: number };
}

// --- M1 list endpoints -----------------------------------------------------
export interface LiveMatch {
  fixtureId: number; home: string; away: string; kickoffMs: number;
  status: "live" | "upcoming" | "ft"; minute: number; phase: string;
  scoreH: number; scoreA: number; corners: number; goals: number; yellows: number;
}
export interface LiveMarket {
  marketId: number; label: string; group: "corners" | "goals" | "result" | "cards";
  line: number; settleAt: "HT" | "FT"; numBuckets: number;
  status: "open" | "settled" | "voided" | "none";
  bucketTotals: string[]; totalPool: string;
  /** Per-bucket implied multiplier (length numBuckets). */
  odds: number[]; winningBucket: number | null;
}

// --- Bet history ----------------------------------------------------------
export type HistoryStatus =
  | "pending" | "won" | "lost" | "refunded" | "claimable-won" | "claimable-refund" | "legacy";

/** One outcome of a market, from the bettor's point of view. */
export interface HistoryLeg {
  bucket: number;
  side: string;            // team name | "Draw" | "Over" | "Under"
  backed: boolean;         // you staked on this outcome
  stakeLamports: string;
  odds: number;            // current pool-implied multiplier (0 = no price)
  payoutLamports: string;  // projected (open) / realized (settled win) / refund (void)
  result: "won" | "lost" | "refunded" | null;
}

export interface HistoryEntry {
  market: string;
  fixtureId: number;
  marketId: number;
  label: string;
  group: string;
  line: number;
  settleAt: "HT" | "FT";
  home: string;
  away: string;
  side: string;
  bucket: number;
  stakeLamports: string;
  payoutLamports: string;
  status: HistoryStatus;
  settledValue: number | null;
  legs: HistoryLeg[];
  betSig: string;
  claimSig: string | null;
  tsMs: number;
}

const json = async (r: Response) => { if (!r.ok) throw new Error(`engine ${r.status}`); return r.json(); };
export const getMatch = (): Promise<MatchState> => fetch(`${ENGINE}/api/match`).then(json);
export const getMarket = (): Promise<MarketState> => fetch(`${ENGINE}/api/market`).then(json);
export const getMatches = (): Promise<LiveMatch[]> => fetch(`${ENGINE}/api/matches`).then(json);
export const getMarkets = (fixtureId: number): Promise<LiveMarket[]> =>
  fetch(`${ENGINE}/api/markets?fixtureId=${fixtureId}`).then(json);
export const getHistory = (wallet: string): Promise<HistoryEntry[]> =>
  fetch(`${ENGINE}/api/history?wallet=${wallet}`).then(json);

// --- Daily sweepstake (contest)
export interface ContestCardMatch { fixtureId: number; home: string; away: string; kickoffMs: number | null }
export interface ContestToday {
  status: "open" | "settled" | "rolledOver" | "voided" | "paused";
  pot: string;
  contest?: null; // present only when paused
  contestId?: number;
  entryPrice?: string;
  lockTs?: number;
  settleAfterTs?: number;
  entryCount?: number;
  numMatches?: number;
  perfectCount?: number;
  distributable?: string;
  winningBuckets?: number[];
  card?: ContestCardMatch[];
}
export interface ContestEntry { pubkey: string; nonce: number; picks: number[]; amount: string }

export const getContestToday = (): Promise<ContestToday> =>
  fetch(`${ENGINE}/api/contest/today`).then(json);
export const getContestEntries = (wallet: string): Promise<ContestEntry[]> =>
  fetch(`${ENGINE}/api/contest/entries?wallet=${wallet}`).then(json);
