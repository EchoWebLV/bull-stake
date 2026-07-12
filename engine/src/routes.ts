import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { Feed, type Replay } from "./feed.ts";
import {
  readMarket,
  readLiveContests,
  readJackpot,
  listEntriesForWallet,
  listRawEntriesForContest,
  deriveMarketPda,
  readLivePoolByFixture,
  readLivePoolViews,
  readOpenCall,
  readLastResolvedCall,
  readPoolStandings,
  readLiveEntry,
  readLineMarkets,
  readLinePosition,
  type ContestView,
  type LivePoolView,
  type RawEntryView,
} from "./chain.ts";
import { marketById } from "./markets.ts";
import { impliedOdds } from "./odds.ts";
import { M0, JOIN_AHEAD_MIN, TEST_FIXTURE_MIN, PROGRAM_ID } from "./config.ts";
import { testMatchState, testMatchDurationSecs } from "./testMatch.ts";
import { livePhase, type LiveStore } from "./live.ts";
import type { LinesStore } from "./lines.ts";

function loadReplay(): Replay {
  const url = new URL("../data/replay.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Replay;
}

/**
 * Pick "today's" single card from the set of live contests.
 *
 * "Streak" runs one daily card, but the chain may briefly hold more than one
 * Open contest (e.g. yesterday's card mid-settlement alongside today's). The
 * selection mirrors the task spec:
 *   1. Consider only Open contests (settled/voided/rolledOver are never "today").
 *   2. Prefer one whose in-play window [lockTs, settleAfterTs] covers `now`.
 *   3. Otherwise fall back to the most recent Open contest.
 *   4. Tie-break (in BOTH groups) by the latest lockTs, then highest contestId
 *      for full determinism.
 * Returns null when no Open contest exists (caller serves `{ card: null }`).
 *
 * `nowSec` is injected (defaults to wall-clock seconds) so it can be unit-tested.
 */
export function selectTodaysCard(
  contests: ContestView[],
  nowSec: number = Math.floor(Date.now() / 1000),
): ContestView | null {
  const open = contests.filter((c) => c.status === "open");
  if (open.length === 0) return null;
  // Latest first: by lockTs desc, then contestId desc (stable, deterministic).
  const byLatest = (a: ContestView, b: ContestView) =>
    (b.lockTs - a.lockTs) || (b.contestId - a.contestId);
  const covering = open
    .filter((c) => c.lockTs <= nowSec && nowSec <= c.settleAfterTs)
    .sort(byLatest);
  if (covering.length > 0) return covering[0];
  // No window covers now → most recent Open card.
  return [...open].sort(byLatest)[0];
}

/**
 * Per-leg winning buckets for a card's OWN leg markets — mid-day, a leg settles
 * (its own Market account) long before the whole Contest does (Contest.winning_buckets
 * is only written in bulk by settle_contest once every leg is ready). `null` for a
 * leg whose market isn't settled yet. A leg whose READ threw (RPC blip / missing
 * market account) also reads null, but flips `failed` — "unknown" must stay
 * distinguishable from "not settled yet" upstream: a silently-skipped failed leg
 * would make aliveCount an overcount with no signal to the client. Never rejects.
 */
async function readLegWinningBuckets(
  card: ContestView,
): Promise<{ buckets: (number | null)[]; failed: boolean }> {
  let failed = false;
  const buckets = await Promise.all(
    card.legs.map(async (leg) => {
      try {
        const pda = deriveMarketPda(PROGRAM_ID, leg.fixtureId, leg.marketId).toBase58();
        const m = await readMarket(pda);
        // Accept Settled OR a Voided market that still recorded a
        // proof-determined winning_bucket — a leg-result Market with NO direct
        // bets (bucketTotals all 0, which every Sweep/parlay leg oracle is)
        // VOIDS on settle rather than Settles, but settle.rs still writes the
        // real winning_bucket onto it. The on-chain settle_contest reads exactly
        // this ("Settled OR a zero-winner Voided market that recorded its
        // winning_bucket" — settle_contest.rs), so this read MUST mirror it:
        // treating a voided-with-bucket leg as "unresolved" (null) is what let a
        // provably-dead card keep showing "still perfect". A voided leg with NO
        // bucket (a true abandonment) stays null — it can't score a card, exactly
        // as on-chain (settle_contest errors ResultMarketNotSettled on it).
        const resolved = m.status === "settled" || m.status === "voided";
        return resolved && m.winningBucket != null ? m.winningBucket : null;
      } catch {
        failed = true; // this leg's outcome is UNKNOWN (not "unsettled") — degrade visibly
        return null;
      }
    }),
  );
  return { buckets, failed };
}

/**
 * One entry's active-leg mask against a card's per-leg locks: leg i is active iff
 * legLockTs[i] > entryTs. `legLockTs` here is the ContestView's numLegs-TRIMMED
 * view, and create_contest requires every carded leg's lock to be a real future
 * kickoff (`leg_lock_ts[i] >= lock_ts > now`, create_contest.rs) with the zero
 * tail confined strictly BEYOND num_legs — so a 0 lock never reaches this mask,
 * and every real entryTs (> 0, stamped from the chain clock) compares against
 * genuine kickoffs only.
 */
function activeMask(legLockTs: number[], entryTs: number): boolean[] {
  return legLockTs.map((lockTs) => lockTs > entryTs);
}

/**
 * Mirrors `claim_contest.rs`'s mid-settle perfect check, generalized to MID-DAY
 * polling where not every leg has settled yet: an entry is ALIVE iff, for every
 * ACTIVE leg (legLockTs[i] > entryTs) whose OWN market has already settled, its
 * pick matches that leg's winning bucket. A leg that hasn't settled yet — or is
 * inactive for this entry (locked before the entry was placed) — never
 * disqualifies. Fail-closed on entryTs <= 0 (the chain will never pay it; see
 * claim_contest.rs's own `entry_ts > 0` guard) — such an entry is never alive.
 */
function isEntryAlive(
  picks: number[], mask: boolean[], winningBuckets: (number | null)[], entryTs: number,
): boolean {
  if (entryTs <= 0) return false;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue; // inactive leg — outside this entry's card
    const wb = winningBuckets[i];
    if (wb === null) continue; // not settled yet — can't disqualify
    if (picks[i] !== wb) return false;
  }
  return true;
}

/**
 * The full pool body served by /api/live/pool AND /api/live/next: the pool plus its
 * best-effort open call, just-resolved call, standings, and the single-fixture
 * name/live-drama join (live board row → fixture-meta → "#<fixtureId>"; `livePhase`
 * fold, `live` key omitted when the board doesn't track the fixture). A hiccup on
 * any enrichment degrades to null/[] rather than failing an otherwise-good pool.
 */
async function assemblePoolResponse(pool: LivePoolView, store?: LiveStore) {
  let openCall = null;
  try {
    openCall = await readOpenCall(pool.pubkey);
  } catch {
    openCall = null;
  }
  // The just-resolved call (if any) — the web flashes its verdict in the gap
  // between calls, since `openCall` only ever carries the OPEN one.
  let lastCall = null;
  try {
    lastCall = await readLastResolvedCall(pool.pubkey);
  } catch {
    lastCall = null;
  }
  let standings = [] as Awaited<ReturnType<typeof readPoolStandings>>;
  try {
    standings = await readPoolStandings(pool.poolId);
  } catch {
    standings = [];
  }

  // Test fixtures have no TxLINE presence — their match state is the scripted
  // feed the keeper resolves against, computed deterministically from the
  // pool's own on-chain timestamps (see testMatch.ts).
  if (pool.fixtureId >= TEST_FIXTURE_MIN) {
    const sim = testMatchState(
      pool.lockTs,
      testMatchDurationSecs(pool.lockTs, pool.settleAfterTs),
      Date.now(),
    );
    const match = { fixtureId: pool.fixtureId, kickoffMs: pool.lockTs * 1000, ...sim };
    return { pool, openCall, lastCall, standings, match };
  }

  const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
  const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();
  const live = byId.get(pool.fixtureId);
  const meta = names.get(pool.fixtureId);
  const match = {
    fixtureId: pool.fixtureId,
    home: live?.home ?? meta?.home ?? `#${pool.fixtureId}`,
    away: live?.away ?? meta?.away ?? "",
    kickoffMs: live?.kickoffMs ?? null,
    ...(live
      ? {
          live: {
            home: live.scoreH,
            away: live.scoreA,
            minute: live.minute,
            phase: livePhase(live.status, live.phase),
          },
        }
      : {}),
  };

  return { pool, openCall, lastCall, standings, match };
}

export function registerRoutes(app: FastifyInstance, store?: LiveStore, linesStore?: LinesStore): void {
  const feed = new Feed(loadReplay());
  feed.start(); // demo clock starts when the engine boots

  // ── M0 back-compat routes (single-fixture skeleton) ─────────────────────

  app.get("/api/match", async () => feed.current());

  app.get("/api/market", async (_req, reply) => {
    if (!M0.marketPubkey) {
      reply.code(503);
      return { error: "M0_MARKET_PUBKEY not set — run create-market first" };
    }
    const m = await readMarket(M0.marketPubkey);
    const totals: [bigint, bigint] = [BigInt(m.bucketTotals[0]), BigInt(m.bucketTotals[1])];
    return {
      ...m,
      meta: { home: M0.home, away: M0.away, line: M0.line, label: M0.label },
      impliedOdds: {
        over: impliedOdds(totals, 0, m.feeBps),
        under: impliedOdds(totals, 1, m.feeBps),
      },
    };
  });

  // ── List endpoints (Task 4) ───────────────────────────────────────────────

  /**
   * GET /api/matches
   * Returns all slate fixtures sorted live → upcoming → ft.
   */
  app.get("/api/matches", async (_req, reply) => {
    if (!store) {
      reply.code(503);
      return { error: "LiveStore not available" };
    }
    return store.getMatches();
  });

  /**
   * GET /api/markets?fixtureId=<number>
   * Returns the 8 markets for a fixture, with pool-implied odds.
   */
  app.get("/api/markets", async (req, reply) => {
    if (!store) {
      reply.code(503);
      return { error: "LiveStore not available" };
    }
    const { fixtureId } = (req.query as Record<string, string>);
    if (!fixtureId) {
      reply.code(400);
      return { error: "fixtureId query param required" };
    }
    const id = Number(fixtureId);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "fixtureId must be a number" };
    }
    return store.getMarkets(id);
  });

  /**
   * GET /api/history?wallet=<base58>
   * Returns the wallet's bet/win history, reconstructed from on-chain events.
   */
  app.get("/api/history", async (req, reply) => {
    const { wallet } = (req.query as Record<string, string>);
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    const { fetchHistory } = await import("./history.ts");
    const meta = store?.getFixtureMeta() ?? new Map();
    try {
      return await fetchHistory(wallet, meta);
    } catch (e) {
      reply.code(502);
      return { error: `history fetch failed: ${(e as Error).message}` };
    }
  });

  // ── Contest endpoints (daily sweepstake) ──────────────────────────────────

  /**
   * GET /api/contest/live
   * Every live single-match parlay contest, each joined with its fixture's
   * team names/kickoff (the `match`) and its per-leg catalog metadata (the
   * `legs`, with the O/U `line` joined from markets.ts). Returns a (possibly
   * empty) array — the jackpot is now its own `/api/jackpot` endpoint, so an
   * empty live set is just `[]`, not a "paused" object.
   */
  app.get("/api/contest/live", async (_req, reply) => {
    let contests;
    try {
      // Shared SWR scan (see the live-bundle block above): served instantly from
      // the last-good bundle, 502 only on a cold miss whose scan actually fails.
      contests = (await getLiveBundle()).contests;
    } catch (e) {
      reply.code(502);
      return { error: `contest read failed: ${(e as Error).message}` };
    }

    const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
    const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();

    return contests.map((contest) => {
      // Each contest is a single-match parlay: join its one fixture (fixtures[0]).
      const fixtureId = contest.fixtures[0];
      const live = byId.get(fixtureId);
      const meta = names.get(fixtureId);
      const match = {
        fixtureId,
        home: live?.home ?? meta?.home ?? `#${fixtureId}`,
        away: live?.away ?? meta?.away ?? "",
        kickoffMs: live?.kickoffMs ?? null,
      };
      // The engine LegView already carries marketId/label/group/numBuckets/
      // fixtureId/winningBucket; add the catalog `line` for the web's O/U control.
      const legs = contest.legs.map((leg) => ({
        fixtureId: leg.fixtureId,
        marketId: leg.marketId,
        label: leg.label,
        group: leg.group,
        numBuckets: leg.numBuckets,
        line: marketById(leg.marketId)?.line,
        winningBucket: leg.winningBucket,
      }));
      return {
        contestId: contest.contestId,
        status: contest.status,
        pot: contest.pot,
        entryPrice: contest.entryPrice,
        lockTs: contest.lockTs,
        settleAfterTs: contest.settleAfterTs,
        entryCount: contest.entryCount,
        perfectCount: contest.perfectCount,
        distributable: contest.distributable,
        numLegs: contest.numLegs,
        match,
        legs,
      };
    });
  });

  // Shared live-scan bundle (stale-while-revalidate). BOTH /api/card and
  // /api/contest/live run the identical `readLiveContests()` getProgramAccounts
  // scan (+ each contest's pot), which takes 5–15s on devnet and intermittently
  // 429s. The web polls both every ~5s, so before this every poll blocked on —
  // and re-issued — that scan: the tab felt frozen, flashed empty (a slow/failed
  // scan couldn't surface your entry until it happened to succeed), and the two
  // routes DOUBLED the RPC load feeding the rate-limit storm. Now ONE scan feeds
  // both routes: the whole slow bundle (contests + selected card + its jackpot,
  // per-leg winning buckets and entry scan) is cached per-server-instance (single
  // slot — one live card at a time, so test-safe like the old micro-caches) and
  // served STALE the instant it's older than the TTL, with at most one refresh in
  // flight behind it. Only the CHEAP per-request parts stay live: the myCard
  // wallet filter (pure CPU over cached entries) and the leg name/score join
  // (in-memory `store`), so live drama never goes stale on a served-stale bundle.
  const LIVE_BUNDLE_TTL_MS = 5_000;
  type LiveBundle = {
    at: number;
    contests: ContestView[];       // full live set — /api/contest/live
    card: ContestView | null;      // selectTodaysCard(contests) — /api/card
    jackpot: string;
    winningBuckets: (number | null)[];
    rawEntries: RawEntryView[];
    legsFailed: boolean;
    entriesFailed: boolean;
  };
  let liveBundle: LiveBundle | null = null;
  let liveBundleInFlight: Promise<LiveBundle> | null = null;

  // One full slow-read pass. Rejects ONLY when the CONTEST scan itself fails —
  // that's the one read with no safe degraded value (no contests today ≠ scan
  // failed), and the one both routes turn into a 502 on a cold miss. Every other
  // read fails soft into a flag (legsFailed / entriesFailed) so a partial blip
  // still yields a usable, visibly-degraded bundle. `readLegWinningBuckets` never
  // rejects (it sets `.failed`); the entry scan and jackpot are wrapped.
  async function loadLiveBundle(): Promise<LiveBundle> {
    const at = Date.now();
    const contests = await readLiveContests();
    const card = selectTodaysCard(contests);
    let jackpot = "0";
    try { jackpot = (await readJackpot()).pot; } catch { jackpot = "0"; }
    let winningBuckets: (number | null)[] = [];
    let rawEntries: RawEntryView[] = [];
    let legsFailed = false;
    let entriesFailed = false;
    if (card) {
      const r = await readLegWinningBuckets(card);
      winningBuckets = r.buckets;
      legsFailed = r.failed;
      try {
        rawEntries = await listRawEntriesForContest(card.pubkey);
      } catch {
        entriesFailed = true; // fail-soft, but VISIBLY: degraded + aliveCount null, myCard OMITTED
      }
    }
    return { at, contests, card, jackpot, winningBuckets, rawEntries, legsFailed, entriesFailed };
  }

  // In-flight dedup: many polls (across both routes) can land during one 5–15s
  // scan; they all share the single refresh rather than stacking N concurrent
  // scans on an already rate-limited RPC.
  function refreshLiveBundle(): Promise<LiveBundle> {
    if (!liveBundleInFlight) {
      liveBundleInFlight = loadLiveBundle()
        .then((b) => { liveBundle = b; return b; })
        .finally(() => { liveBundleInFlight = null; });
    }
    return liveBundleInFlight;
  }

  // SWR accessor shared by both routes: hand back the last-good bundle instantly
  // and refresh behind it once stale; block ONLY on a cold miss (whose scan
  // failure the caller renders as a 502). A failed background refresh just leaves
  // the last-good bundle in place until the next poll (never surfaces here).
  async function getLiveBundle(): Promise<LiveBundle> {
    const now = Date.now();
    if (!liveBundle) return await refreshLiveBundle();
    if (now - liveBundle.at >= LIVE_BUNDLE_TTL_MS) void refreshLiveBundle().catch(() => {});
    return liveBundle;
  }

  /**
   * GET /api/card[?wallet=<base58>]
   * TODAY's single 6-leg card — the focused view the new web reads. It reuses
   * `readLiveContests` (same per-leg catalog join as `/api/contest/live`) and
   * `selectTodaysCard` to pick the current day's Open contest, then folds in the
   * standalone jackpot pot.
   *
   * Shape: `{ contestId, status, lockTs, entriesCloseTs, settleAfterTs, entryPrice,
   *           pot, jackpot, aliveCount, myCard, degraded?,
   *           legs: [{ fixtureId, home, away, kickoffTs, marketId, label, group,
   *                    line, buckets, lockTs }] }`.
   * Every leg is one match (single-match parlay), so home/away/kickoffTs are the
   * same fixture join on each leg — resolved like `/api/contest/live`: live row,
   * then fixture-meta names, then `#<fixtureId>`. `kickoffTs` is SECONDS (the
   * store carries kickoffMs), null when unknown. `buckets` is the catalog bucket
   * count; `line` is omitted (not null) for an out-of-catalog market. Each leg's
   * own `lockTs` (`legLockTs[i]`) is its individual kickoff — Pearly locks legs
   * one at a time through the day, not all at once at the card's first `lockTs`.
   *
   * `aliveCount: number | null` — entries whose picks still match every ACTIVE
   * leg that has ALREADY settled (each leg's own Market, not the bulk
   * Contest.winning_buckets — see `readLegWinningBuckets`); a running "how many
   * cards are still perfect" count, independent of `?wallet=`. `null` means
   * "couldn't compute this poll" (see `degraded`), NEVER "zero cards alive".
   *
   * `myCard` — three-state, driven by `?wallet=`:
   *   - object          → the wallet's entry (LOWEST nonce if it somehow holds
   *                       several — the product model is one card per wallet and
   *                       the web always enters nonce 0), mapped to
   *                       `{ picks, entryTs, activeMask, weight, alive }` with
   *                       `weight = 2**activeCount` (perfect_weight's divisor).
   *   - null            → CONFIRMED no entry: the scan succeeded and found none,
   *                       or no/invalid `wallet` was given (incl. a repeated
   *                       ?wallet= — Fastify parses that as an array, which
   *                       `new PublicKey` would silently resolve to the system
   *                       program address rather than throw, so anything but a
   *                       single non-empty string is treated as absent).
   *   - KEY OMITTED     → unknown: a valid wallet asked but the entry scan
   *                       failed this poll — retry, don't render "no entry".
   *
   * `degraded?: true` — present ONLY when the entry scan and/or ≥1 leg-market
   * read failed; the key is omitted entirely on a healthy response. When set,
   * `aliveCount` is null and `myCard.alive` (if myCard is served at all) is
   * computed against only the leg outcomes that could be read — optimistic;
   * trust `alive`/`aliveCount` only on non-degraded responses. Fail-soft by
   * design: a read blip must not blank the whole card view.
   *
   * Empty case: when no Open contest exists, responds `{ card: null }` with 200
   * (NOT 404 / not a paused object) so the web can render an "open later" state.
   * A genuine RPC failure on the CONTEST read itself still 502s.
   */
  app.get("/api/card", async (req, reply) => {
    let bundle: LiveBundle;
    try {
      // Shared SWR scan (see the live-bundle block above): served instantly from
      // the last-good bundle, 502 only on a cold miss whose scan actually fails.
      bundle = await getLiveBundle();
    } catch (e) {
      reply.code(502);
      return { error: `card read failed: ${(e as Error).message}` };
    }

    const card = bundle.card;
    if (!card) return { card: null }; // 200 + null sentinel: no card for today (yet)

    const jackpot = bundle.jackpot;
    const winningBuckets = bundle.winningBuckets;
    const rawEntries = bundle.rawEntries;
    const scanFailed = bundle.entriesFailed;

    // degraded → aliveCount null ("couldn't compute"), never a misleading 0.
    const degraded = bundle.legsFailed || bundle.entriesFailed;
    const aliveCount = degraded
      ? null
      : rawEntries.filter((e) =>
          isEntryAlive(e.picks, activeMask(card.legLockTs, e.entryTs), winningBuckets, e.entryTs),
        ).length;

    // myCard (three-state contract — see the route doc above). The wallet param
    // must be a single non-empty string: Fastify parses ?wallet=A&wallet=B as an
    // ARRAY, and new PublicKey(array) silently resolves to the system program
    // address instead of throwing — validate BEFORE PublicKey ever sees it.
    const walletRaw = (req.query as Record<string, unknown>).wallet;
    const wallet = typeof walletRaw === "string" && walletRaw.length > 0 ? walletRaw : undefined;
    let myCard: {
      picks: number[]; entryTs: number; activeMask: boolean[]; weight: number; alive: boolean;
    } | null = null;
    let myCardKnown = true; // false → omit the key entirely (asked, but scan failed)
    if (wallet) {
      try {
        const walletKey = new PublicKey(wallet).toBase58();
        if (scanFailed) {
          myCardKnown = false; // can't distinguish "no entry" from "scan blip" — say neither
        } else {
          // LOWEST nonce wins deterministically (web enters nonce 0; scan order
          // from getProgramAccounts is arbitrary).
          const mine = rawEntries
            .filter((e) => e.bettor === walletKey)
            .sort((a, b) => a.nonce - b.nonce)[0];
          if (mine) {
            const mask = activeMask(card.legLockTs, mine.entryTs);
            myCard = {
              picks: mine.picks,
              entryTs: mine.entryTs,
              activeMask: mask,
              weight: 2 ** mask.filter(Boolean).length,
              alive: isEntryAlive(mine.picks, mask, winningBuckets, mine.entryTs),
            };
          }
        }
      } catch {
        myCard = null; // not a valid pubkey → same as "no wallet given"
      }
    }

    // Single-match parlay: resolve the one fixture's names/kickoff once, exactly
    // like /api/contest/live (live row → fixture-meta → "#<fixtureId>"), then
    // stamp it onto every leg per the card shape.
    const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
    const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();

    const legs = card.legs.map((leg, i) => {
      const live = byId.get(leg.fixtureId);
      const meta = names.get(leg.fixtureId);
      // markets catalog supplies the O/U `line`; omit the key (not null) for an
      // unknown marketId, matching the /api/contest/live web contract.
      const line = marketById(leg.marketId)?.line;
      // When the live store tracks this fixture, fold in current score/minute/phase
      // so the web can render live drama. No live row → OMIT `live` entirely (per
      // contract) rather than emitting a zeroed placeholder.
      const liveField = live
        ? {
            live: {
              home: live.scoreH,
              away: live.scoreA,
              minute: live.minute,
              phase: livePhase(live.status, live.phase),
            },
          }
        : {};
      return {
        fixtureId: leg.fixtureId,
        home: live?.home ?? meta?.home ?? `#${leg.fixtureId}`,
        away: live?.away ?? meta?.away ?? "",
        // store carries kickoffMs; the card contract is seconds (null if unknown).
        kickoffTs: live?.kickoffMs != null ? Math.floor(live.kickoffMs / 1000) : null,
        marketId: leg.marketId,
        label: leg.label,
        group: leg.group,
        ...(line !== undefined ? { line } : {}),
        buckets: leg.numBuckets,
        lockTs: card.legLockTs[i],
        // Per-leg on-chain result: the leg's OWN Market winning_bucket once it's
        // resolved (Settled or voided-with-bucket — see readLegWinningBuckets),
        // else null. This is the SAME array `aliveCount`/`myCard.alive` are
        // computed from, so the web reads won/lost per leg here — consistent with
        // the card's alive/dead state — instead of the contest-level
        // winning_buckets, which only populate once the WHOLE card settles.
        winningBucket: winningBuckets[i] ?? null,
        ...liveField,
      };
    });

    return {
      contestId: card.contestId,
      status: card.status,
      lockTs: card.lockTs,
      entriesCloseTs: card.entriesCloseTs,
      settleAfterTs: card.settleAfterTs,
      entryPrice: card.entryPrice,
      pot: card.pot,
      jackpot,
      // `degraded` key present ONLY when a read failed (healthy → omitted).
      ...(degraded ? { degraded: true } : {}),
      aliveCount,
      // Omit `myCard` entirely when a valid wallet asked but the scan failed
      // (unknown ≠ null "confirmed no entry" — see the route doc).
      ...(myCardKnown ? { myCard } : {}),
      legs,
    };
  });

  /**
   * GET /api/jackpot
   * The standalone jackpot escrow view: `{ lamports, rentFloor, pot }`. The web
   * only reads `.pot`. Pre-launch chain.ts degrades the missing account to a
   * pot "0" sentinel, so this 502s only on a genuine RPC error.
   */
  app.get("/api/jackpot", async (_req, reply) => {
    try {
      return await readJackpot();
    } catch (e) {
      reply.code(502);
      return { error: `jackpot read failed: ${(e as Error).message}` };
    }
  });

  /**
   * GET /api/contest/entries?wallet=<base58>[&contestId=<number>]
   * The wallet's Entry tickets, enriched with won/claimable/payout. Without
   * `contestId` they're aggregated across all live contests; with a numeric
   * `contestId` the lookup is scoped to that single contest.
   */
  app.get("/api/contest/entries", async (req, reply) => {
    const { wallet, contestId } = req.query as Record<string, string>;
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    const id = contestId !== undefined ? Number(contestId) : undefined;
    try {
      return id !== undefined && Number.isFinite(id)
        ? await listEntriesForWallet(wallet, id)
        : await listEntriesForWallet(wallet);
    } catch (e) {
      reply.code(502);
      return { error: `entries fetch failed: ${(e as Error).message}` };
    }
  });

  // ── Live-match endpoints (Slice 4) ────────────────────────────────────────

  /**
   * GET /api/live/pool?fixtureId=<number>
   * The live-match pool for a fixture, enriched with its currently-open Call and
   * the standings leaderboard, plus the single-fixture name/live-drama join that
   * `/api/card` uses (live row → fixture-meta → `#<fixtureId>`; `livePhase` fold).
   *
   * Empty case: no pool for this fixture → 200 `{ pool: null }` (NOT 404), so the
   * web can render a "no live game yet" state. A genuine RPC failure 502s.
   */
  app.get("/api/live/pool", async (req, reply) => {
    const { fixtureId } = req.query as Record<string, string>;
    if (!fixtureId) {
      reply.code(400);
      return { error: "fixtureId query param required" };
    }
    const id = Number(fixtureId);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "fixtureId must be a number" };
    }

    let pool;
    try {
      pool = await readLivePoolByFixture(id);
    } catch (e) {
      reply.code(502);
      return { error: `live pool read failed: ${(e as Error).message}` };
    }
    if (!pool) return { pool: null }; // 200 + null sentinel: no live pool (yet)

    return assemblePoolResponse(pool, store);
  });

  /**
   * GET /api/live/next
   * The ONE game the home tab should feature, picked in priority order:
   *   1. an IN-PLAY pool  — status open, lockTs ≤ now < settleAfterTs (a playing
   *      pool's on-chain status stays "open"; in-play is a time fact) — earliest
   *      lockTs wins;
   *   2. a JOINABLE pool  — status open, now < lockTs (the 45-min join window);
   *   3. the soonest UPCOMING fixture with no pool yet — countdown only, pool null;
   *   4. nothing scheduled → all-null body.
   * The body is a superset of /api/live/pool (same assembly) plus `kickoffMs` and
   * `joinOpensTs` (kickoff − JOIN_AHEAD_MIN). Terminal/ended pools are never
   * featured — the next game takes over. Replaces web-side discovery (finding #5).
   *
   * `?test=1` flips the audience: ONLY test pools (fixtureId ≥ TEST_FIXTURE_MIN —
   * the /test page); without it, test pools are EXCLUDED so the main Live tab
   * carries exclusively real fixtures.
   */
  app.get("/api/live/next", async (req, reply) => {
    const wantTest = (req.query as Record<string, string>).test === "1";
    let pools;
    try {
      pools = await readLivePoolViews();
    } catch (e) {
      reply.code(502);
      return { error: `live pool scan failed: ${(e as Error).message}` };
    }
    const nowMs = Date.now();
    const open = pools.filter(
      (p) => p.status === "open" && (p.fixtureId >= TEST_FIXTURE_MIN) === wantTest,
    );
    const byLock = (a: { lockTs: number }, b: { lockTs: number }) => a.lockTs - b.lockTs;
    const inPlay = open
      .filter((p) => p.lockTs * 1000 <= nowMs && nowMs < p.settleAfterTs * 1000)
      .sort(byLock)[0];
    const joinable = open.filter((p) => nowMs < p.lockTs * 1000).sort(byLock)[0];
    const featured = inPlay ?? joinable ?? null;

    if (featured) {
      const body = await assemblePoolResponse(featured, store);
      // lock_ts == kickoff by construction; prefer the board's kickoff when known.
      const kickoffMs = body.match.kickoffMs ?? featured.lockTs * 1000;
      return { ...body, kickoffMs, joinOpensTs: featured.lockTs - JOIN_AHEAD_MIN * 60 };
    }

    // No pool anywhere → the soonest upcoming fixture (pure countdown state).
    // Real tab only: TxLINE has no test fixtures, so /test skips straight to nulls.
    const up = wantTest
      ? undefined
      : (store?.getMatches() ?? [])
          .filter((m) => m.status === "upcoming")
          .sort((a, b) => a.kickoffMs - b.kickoffMs)[0];
    if (up) {
      return {
        pool: null, openCall: null, lastCall: null, standings: [],
        match: { fixtureId: up.fixtureId, home: up.home, away: up.away, kickoffMs: up.kickoffMs },
        kickoffMs: up.kickoffMs,
        joinOpensTs: Math.floor(up.kickoffMs / 1000) - JOIN_AHEAD_MIN * 60,
      };
    }
    return {
      pool: null, openCall: null, lastCall: null, standings: [],
      match: null, kickoffMs: null, joinOpensTs: null,
    };
  });

  /**
   * GET /api/live/pool/:id/standings
   * The pool's standings leaderboard — every LiveEntry sorted by `total`
   * (base_pts + bonus_pts) descending. Empty pool → 200 `[]` (never 404); a
   * genuine RPC failure 502s. `:id` is the poolId (== fixtureId in practice).
   */
  app.get("/api/live/pool/:id/standings", async (req, reply) => {
    const { id } = req.params as Record<string, string>;
    const poolId = Number(id);
    if (!Number.isFinite(poolId)) {
      reply.code(400);
      return { error: "pool id must be a number" };
    }
    try {
      return await readPoolStandings(poolId);
    } catch (e) {
      reply.code(502);
      return { error: `standings read failed: ${(e as Error).message}` };
    }
  });

  /**
   * GET /api/live/entry?wallet=<base58>&poolId=<number>
   * One wallet's LiveEntry ticket for a pool (there is at most one per player per
   * pool). BOTH params are required → 400 otherwise. No matching entry → 200
   * `{ entry: null }` (never 404); a genuine RPC failure 502s.
   */
  app.get("/api/live/entry", async (req, reply) => {
    const { wallet, poolId } = req.query as Record<string, string>;
    if (!wallet || !poolId) {
      reply.code(400);
      return { error: "wallet and poolId query params required" };
    }
    const id = Number(poolId);
    if (!Number.isFinite(id)) {
      reply.code(400);
      return { error: "poolId must be a number" };
    }
    try {
      const entry = await readLiveEntry(wallet, id);
      return { entry }; // entry is null when no ticket exists
    } catch (e) {
      reply.code(502);
      return { error: `live entry read failed: ${(e as Error).message}` };
    }
  });

  /**
   * GET /api/live/unclaimed?wallet=<base58>[&test=1]
   * The wallet's most recent UNFINISHED terminal pool: settled/voided/rolledOver
   * with the wallet's LiveEntry account still open — claiming (winner share /
   * refund / seat close) is what closes the entry, so an open entry on a
   * terminal pool == money or a close still owed to this wallet. The web PINS
   * this pool over the featured rotation: /api/live/next only ever serves open
   * pools, so without the pin a winner's claim button rotates away the moment
   * the next pool spawns. Same audience split as /next (`test=1`). Scans the
   * newest 12 terminal pools; `{pool:null, entry:null}` when nothing is owed.
   */
  app.get("/api/live/unclaimed", async (req, reply) => {
    const { wallet } = req.query as Record<string, string>;
    const wantTest = (req.query as Record<string, string>).test === "1";
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    let pools;
    try {
      pools = await readLivePoolViews();
    } catch (e) {
      reply.code(502);
      return { error: `live pool scan failed: ${(e as Error).message}` };
    }
    const terminal = pools
      .filter(
        (p) =>
          (p.status === "settled" || p.status === "voided" || p.status === "rolledOver") &&
          (p.fixtureId >= TEST_FIXTURE_MIN) === wantTest,
      )
      .sort((a, b) => b.settleAfterTs - a.settleAfterTs)
      .slice(0, 12);
    for (const p of terminal) {
      try {
        const entry = await readLiveEntry(wallet, p.poolId);
        if (entry) {
          const body = await assemblePoolResponse(p, store);
          return { ...body, entry };
        }
      } catch {
        // Unreadable entry (RPC blip) → skip; the web re-polls within seconds.
      }
    }
    return { pool: null, entry: null };
  });

  // ── Beat the Market ────────────────────────────────────────────────────────
  const HOUSE_BOOST_LAMPORTS = Math.round(Number(process.env.LINES_SEED_SOL ?? "0.05") * 2 * 1e9);
  // Money-read micro-cache: /api/lines fans out from every client poll; a 5s
  // TTL keeps getProgramAccounts off the hot path (same idea as the ER cache).
  let linesCache: { at: number; data: Awaited<ReturnType<typeof readLineMarkets>> } | null = null;
  async function cachedLineMarkets() {
    if (linesCache && Date.now() - linesCache.at < 5_000) return linesCache.data;
    const data = await readLineMarkets();
    linesCache = { at: Date.now(), data };
    return data;
  }

  function lineDto(m: Awaited<ReturnType<typeof readLineMarkets>>[number]) {
    const names = linesStore?.name(m.fixtureId);
    const home = names?.home ?? `Fixture #${m.fixtureId}`;
    const away = names?.away ?? "";
    return {
      fixtureId: m.fixtureId,
      home, away,
      favName: m.favSide === 1 ? home : (away || home),
      favSide: m.favSide,
      kickoffMs: m.entryCloseTs * 1000,
      marketPk: m.pubkey,
      status: m.status,
      openMilli: m.openMilli,
      current: linesStore?.current(m.fixtureId) ?? null, // {pctMilli, ts} | null — never invented
      potLamports: m.totalPool,
      bucketTotals: m.bucketTotals,
      houseBoostLamports: HOUSE_BOOST_LAMPORTS,
      winningBucket: m.winningBucket,
      settledValueMilli: m.status === "settled" ? m.settledValueMilli : null,
      settledTs: m.settledTs || null,
    };
  }

  app.get("/api/lines", async () => {
    const markets = await cachedLineMarkets();
    const lines = markets
      .map(lineDto)
      .sort((a, b) => a.kickoffMs - b.kickoffMs);
    return { lines };
  });

  app.get("/api/lines/:fixtureId", async (req, reply) => {
    const fixtureId = Number((req.params as { fixtureId: string }).fixtureId);
    const wallet = (req.query as { wallet?: string }).wallet;
    const m = (await cachedLineMarkets()).find((x) => x.fixtureId === fixtureId);
    if (!m) { reply.code(404); return { error: "no line for fixture" }; }
    return {
      line: lineDto(m),
      series: linesStore?.series(fixtureId) ?? [],
      myStakes: wallet ? await readLinePosition(fixtureId, wallet) : null,
    };
  });
}
