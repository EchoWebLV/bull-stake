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
  /** This leg's OWN kickoff lock (seconds) — Pearly (v2) locks legs one at a
   *  time through the day rather than all at once. OPTIONAL: absent on a v1
   *  engine response, which locked every leg together at `Card.lockTs`. */
  lockTs?: number;
  /** This leg's own on-chain RESULT bucket once resolved — Settled OR a
   *  voided-with-bucket leg-oracle Market (the SAME source as `aliveCount` /
   *  `myCard.alive`; see the engine's readLegWinningBuckets). null while the
   *  leg's match is unresolved; absent on a v1 engine response. */
  winningBucket?: number | null;
}
/** `GET /api/card?wallet=` — the wallet's own entry on today's card. Present
 *  fields mirror the on-chain Entry (see routes.ts's route doc for the full
 *  three-state `Card.myCard` contract this type participates in). */
export interface MyCard {
  picks: number[];          // per-leg bucket picks, length == card.legs.length (padded)
  entryTs: number;          // seconds — when this wallet entered
  activeMask: boolean[];    // leg i is CARRIED iff activeMask[i] (legLockTs[i] > entryTs)
  weight: number;           // 2 ** (carried leg count) — mirrors on-chain perfect_weight divisor
  alive: boolean;           // still perfect against every ACTIVE + already-settled leg (see
                             // `Card.degraded` — this is OPTIMISTIC on a degraded response,
                             // since it's computed against whatever leg outcomes DID read).
}
/** TODAY's single card. `getCard()` resolves to `{ card: null }` when none is open yet. */
export interface Card {
  contestId: number;
  status: "open" | "settled" | "rolledOver" | "voided";
  lockTs: number;          // entries close (seconds) — v1: the single all-legs lock
  settleAfterTs: number;   // earliest settle (seconds)
  entryPrice: string;      // lamports
  pot: string;             // this contest's own escrow (lamports)
  jackpot: string;         // standalone jackpot pot (lamports; "0" pre-launch)
  legs: CardLeg[];
  /** v2 (Pearly): true entries-close time — the KO that leaves only 2 legs open.
   *  OPTIONAL: falls back to `lockTs` against a v1 engine response. */
  entriesCloseTs?: number;
  /** v2: entries whose picks still match every settled+active leg — "cards still
   *  perfect" for the WHOLE card, independent of `?wallet=`.
   *    - a number       → healthy read, trust it.
   *    - null            → `degraded: true` this poll: "couldn't compute" —
   *                        NEVER render as "0 cards alive" (misreads as everyone
   *                        eliminated).
   *    - undefined (key absent) → a v1 (pre-Pearly) engine response.
   */
  aliveCount?: number | null;
  /** Present ONLY when the entry scan and/or ≥1 leg-market read failed THIS
   *  poll (routes.ts, engine/src/routes.ts's `/api/card` doc comment) — omitted
   *  entirely on a healthy response. When true: `aliveCount` is null, and if
   *  `myCard` IS present its `.alive` is optimistic (computed against only the
   *  leg outcomes that read OK) — soften any alive/dead claim in the UI.
   *  Absent on a v1 engine response too (same "unknown, don't over-claim" idea,
   *  just for a different reason — v1 never had this concept). */
  degraded?: true;
  /** THREE-STATE, driven by `?wallet=` (routes.ts's `/api/card` doc comment is
   *  the source of truth):
   *    - `MyCard` object → the wallet's lowest-nonce entry (web always enters
   *      nonce 0, so this is simply "the" entry in practice).
   *    - `null`          → CONFIRMED no entry: the scan succeeded and found
   *      none, OR no/invalid `wallet` was given — safe to show the picker/empty
   *      state.
   *    - `undefined` (key omitted) → UNKNOWN: either a valid wallet was given
   *      but the entry scan failed this poll (degraded), OR a v1 engine that
   *      predates `myCard` entirely. Never render "you haven't entered" for
   *      this case — show a retry/loading affordance instead.
   */
  myCard?: MyCard | null;
}

/** Today's card, or null when no card is open for today yet (engine returns `{ card: null }`).
 *  Pass `wallet` to also fetch `myCard` (v2 engines only — see `Card.myCard`). */
/** `test=true` → the TEST Sweep only (synthetic-fixture contest — the /test page);
 *  default → the real daily card. Mirrors getLiveNext's `?test=1` audience split. */
export const getCard = (wallet?: string | null, test = false): Promise<Card | null> => {
  const params = [wallet ? `wallet=${wallet}` : "", test ? "test=1" : ""].filter(Boolean).join("&");
  return fetch(`${ENGINE}/api/card${params ? `?${params}` : ""}`).then(json).then((r: Card | { card: null }) =>
    "card" in r ? r.card : r,
  );
};

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
    /** TEST fixtures only: per-side counters from the scripted feed (home first). */
    stats?: { shots: [number, number]; corners: [number, number]; cards: [number, number]; poss: [number, number] };
    /** TEST fixtures only: chronological scripted match events. */
    events?: { min: number | ""; txt: string; big: boolean }[];
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
/** `test=true` → only TEST matches (the /test page); default → only real fixtures. */
export const getNextGame = (test = false): Promise<NextGameResponse> =>
  fetch(`${ENGINE}/api/live/next${test ? "?test=1" : ""}`).then(json);
/** The wallet's most recent terminal pool whose entry is still open — a claim
 *  (winnings / refund / close) is owed. `{pool:null, entry:null}` when clear. */
export const getUnclaimed = (
  wallet: string,
  test = false,
): Promise<LivePoolResponse & { entry: LiveEntryView | null }> =>
  fetch(`${ENGINE}/api/live/unclaimed?wallet=${wallet}${test ? "&test=1" : ""}`).then(json);
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

// ── Beat the Market ──────────────────────────────────────────────────────────
export interface LineDto {
  fixtureId: number; home: string; away: string;
  favName: string; favSide: 1 | 2;
  kickoffMs: number; marketPk: string;
  status: "open" | "settled" | "voided";
  openMilli: number;
  current: { pctMilli: number; ts: number } | null;
  potLamports: string;
  bucketTotals: [string, string];
  houseBoostLamports: number;
  winningBucket: number | null;
  settledValueMilli: number | null;
  settledTs: number | null;
}
export interface LinesResponse { lines: LineDto[] }
export interface LineDetailResponse {
  line: LineDto;
  series: [number, number][];
  myStakes: [string, string] | null;
}
export const getLines = (): Promise<LinesResponse> =>
  fetch(`${ENGINE}/api/lines`).then(json);
export const getLineDetail = (fixtureId: number, wallet?: string | null): Promise<LineDetailResponse> =>
  fetch(`${ENGINE}/api/lines/${fixtureId}${wallet ? `?wallet=${wallet}` : ""}`).then(json);
