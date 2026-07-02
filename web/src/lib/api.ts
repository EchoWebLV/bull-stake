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

// --- Contest tickets (shared by the live parlay view) ---------------------
export interface ContestEntry {
  pubkey: string; nonce: number; picks: number[]; amount: string;
  contestId: number;   // which contest this ticket belongs to (groups tickets per card)
  won: boolean;        // all carded picks matched (settled contests only)
  claimable: boolean;  // claiming now pays out (winner share or void refund)
  payout: string;      // lamports paid if claimed now ("0" if none)
}

/** The wallet's tickets. Pass `contestId` to scope to a single contest
 *  (the engine route accepts `&contestId=`); omit it to aggregate across all. */
export const getContestEntries = (wallet: string, contestId?: number): Promise<ContestEntry[]> =>
  fetch(
    `${ENGINE}/api/contest/entries?wallet=${wallet}` +
      (contestId !== undefined ? `&contestId=${contestId}` : ""),
  ).then(json);

// --- Single-match parlay (live contests) ----------------------------------
export interface ParlayLeg {
  fixtureId: number; marketId: number; label: string;
  group: "corners" | "goals" | "result" | "cards"; numBuckets: 2 | 3; line?: number;
  winningBucket: number | null;
}
export interface ContestLive {
  contestId: number; status: "open" | "settled" | "rolledOver" | "voided"; pot: string;
  entryPrice: string; lockTs: number; settleAfterTs: number; entryCount: number;
  perfectCount: number; distributable: string; numLegs: number;
  match: { fixtureId: number; home: string; away: string; kickoffMs: number | null };
  legs: ParlayLeg[];
}

export const getContestLive = (): Promise<ContestLive[]> =>
  fetch(`${ENGINE}/api/contest/live`).then(json);
export const getJackpot = (): Promise<{ pot: string }> =>
  fetch(`${ENGINE}/api/jackpot`).then(json);

// --- Today's card (single daily 6-leg card) -------------------------------
/** Live in-play state stamped onto a leg once its fixture kicks off.
 *  `home`/`away` here are the current SCORES (numbers) — distinct from the leg's
 *  `home`/`away` team-name strings. Absent when the engine has no live row. */
export interface CardLegLive {
  home: number;            // current home score
  away: number;            // current away score
  minute: number | null;   // match minute (null at pre/ft or when unknown)
  phase: "pre" | "live" | "ht" | "ft";
}
/** One leg of today's card: a (fixture, market) pick with its match + catalog join. */
export interface CardLeg {
  fixtureId: number;
  home: string;            // team name, or "#<fixtureId>" when unresolved
  away: string;            // team name, or "" when unresolved
  kickoffTs: number | null; // SECONDS (null when the fixture's kickoff is unknown)
  marketId: number;
  label: string;           // catalog label ("" if unknown marketId)
  group: "corners" | "goals" | "result" | "cards" | "";
  line?: number;           // catalog O/U line; omitted (not null) for an unknown market
  buckets: number;         // catalog bucket count (2 = O/U, 3 = three-way; 0 if unknown)
  live?: CardLegLive;      // in-play score/minute/phase (present once kicked off)
}
/** TODAY's single card. `getCard()` resolves to `{ card: null }` when none is open yet. */
export interface Card {
  contestId: number;
  status: "open" | "settled" | "rolledOver" | "voided";
  lockTs: number;          // entries close (seconds)
  settleAfterTs: number;   // earliest settle (seconds)
  entryPrice: string;      // lamports
  pot: string;             // this contest's own escrow (lamports)
  jackpot: string;         // standalone jackpot pot (lamports; "0" pre-launch)
  legs: CardLeg[];
}

/** Today's card, or null when no card is open for today yet (engine returns `{ card: null }`). */
export const getCard = (): Promise<Card | null> =>
  fetch(`${ENGINE}/api/card`).then(json).then((r: Card | { card: null }) =>
    "card" in r ? r.card : r,
  );

// --- Live-match pool (Slice 5) --------------------------------------------
// View shapes mirror engine/src/chain.ts. LiveEntry is 159 bytes on devnet
// (carries picks:[u8;64]); picks map 0xFF → null.
export type PoolStatus = "open" | "live" | "ended" | "settled" | "rolledOver" | "voided";
export type CallState = "empty" | "open" | "resolved" | "voided";
/** Engine emits kind as a STRING (engine/src/chain.ts CALL_KIND), not the u8 ordinal. */
export type CallKind = "nextGoal" | "goalRush" | "cornerSoon" | "cardSoon";

export interface LivePoolView {
  pubkey: string; poolId: number; fixtureId: number;
  settleAuthority: string; feeRecipient: string; entryPrice: string;
  lockTs: number; settleAfterTs: number; feeBps: number;
  status: PoolStatus; numCalls: number; playerCount: number;
  winningScore: number; winnerCount: number; distributable: string;
  claimedCount: number; claimedTotal: string; settledTs: number;
}
export interface CallView {
  pubkey: string; pool: string; seq: number; kind: CallKind;
  state: CallState; openedTs: number; answerSecs: number;
  numOptions: number; basePoints: number[]; outcome: number | "void" | null;
}
export interface LiveEntryView {
  pubkey: string; player: string; pool: string; amount: string;
  basePts: number; bonusPts: number; total: number; streak: number;
  nextScoreSeq: number; picks: (number | null)[];
}
/** GET /api/live/pool?fixtureId — pool (null when none), plus best-effort
 *  open-call, standings, and the fixture name/live-drama join. */
export interface LivePoolResponse {
  pool: LivePoolView | null;
  openCall?: CallView | null;
  /** The most-recently-resolved/voided call — the web flashes its verdict in the
   *  gap between calls (openCall only ever carries the OPEN one). */
  lastCall?: CallView | null;
  standings?: LiveEntryView[];
  match?: {
    fixtureId: number; home: string; away: string; kickoffMs: number | null;
    live?: { home: number; away: number; minute: number | null; phase: "pre" | "live" | "ht" | "ft" };
  } | null;
}

/** GET /api/live/next — the ONE game the home tab features: an in-play pool, else a
 *  joinable pool (45-min window), else the soonest upcoming fixture (pool null,
 *  countdown only), else nothing (all nulls). Superset of LivePoolResponse. */
export interface NextGameResponse extends LivePoolResponse {
  kickoffMs: number | null;
  /** When the join window opens (seconds) — kickoff − 45 min. */
  joinOpensTs: number | null;
}

export const getLivePool = (fixtureId: number): Promise<LivePoolResponse> =>
  fetch(`${ENGINE}/api/live/pool?fixtureId=${fixtureId}`).then(json);
export const getNextGame = (): Promise<NextGameResponse> =>
  fetch(`${ENGINE}/api/live/next`).then(json);
export const getPoolStandings = (poolId: number): Promise<LiveEntryView[]> =>
  fetch(`${ENGINE}/api/live/pool/${poolId}/standings`).then(json);
export const getLiveEntry = (wallet: string, poolId: number): Promise<LiveEntryView | null> =>
  fetch(`${ENGINE}/api/live/entry?wallet=${wallet}&poolId=${poolId}`)
    .then(json)
    .then((r: { entry: LiveEntryView | null }) => r.entry);

/** Any terminal state accepts a claim (winner share / void refund / close-only). */
export const poolIsClaimable = (p: Pick<LivePoolView, "status">): boolean =>
  p.status === "settled" || p.status === "rolledOver" || p.status === "voided";
/** This seat won iff the pool settled with a positive winning score it matches. */
export const isWinner = (
  p: Pick<LivePoolView, "status" | "winningScore">,
  e: Pick<LiveEntryView, "total">,
): boolean => p.status === "settled" && p.winningScore > 0 && e.total === p.winningScore;
