/**
 * Card allocator — the PURE brain that composes "Streak"'s one daily 6-leg card
 * from a day's World Cup matches. No network, no filesystem, no Solana: a keeper
 * feeds it fixtures + TxLINE-derived implied odds and gets back a deterministic
 * set of legs plus the lock / settle timestamps.
 *
 * A leg = (fixtureId, marketId). The market menu (confirmed against
 * markets.ts / TxLINE) is:
 *   12 = Match Result 1X2  (3 buckets)
 *   11 = Total Goals O/U   (2 buckets)
 *   16 = 1st-Half Result   (3 buckets)
 *   15 = 1st-Half Goals O/U (2 buckets)
 *
 * Allocation is SPREAD-FIRST: lay one Result leg across as many distinct matches
 * as possible before stacking a second market onto any single match. We only
 * climb the menu (stack more markets per match) when there aren't enough matches
 * to reach the target leg count.
 */

// ── Input types (self-contained — the keeper maps TxLINE onto these) ────────────

/** A single fixture (match) for the day. `kickoffTs` is unix seconds. */
export type Fixture = { fixtureId: number; home: string; away: string; kickoffTs: number };

/**
 * Implied probabilities for ONE (fixture, market) pair, one entry per bucket,
 * summing to ~1. Bucket order matches the on-chain market layout (e.g. Result =
 * [home, draw, away]). The keeper derives these from TxLINE pool/price data.
 */
export type Odds = { fixtureId: number; market: number; impliedProbs: number[] };

/** A chosen card leg. */
export type Leg = { fixtureId: number; marketId: number };

/** Confirmed default market menu, in spread/climb priority order. */
export const DEFAULT_MENU: number[] = [12, 11, 16, 15];

// ── Tunables ────────────────────────────────────────────────────────────────

/** Assumed match length (seconds) used for the eligibility window + settle buffer. */
const MATCH_LEN_SECS = 2 * 3600;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Index odds by `${fixtureId}:${market}` for O(1) lookup. */
function indexOdds(odds: Odds[]): Map<string, Odds> {
  const m = new Map<string, Odds>();
  for (const o of odds) m.set(`${o.fixtureId}:${o.market}`, o);
  return m;
}

/** The favorite's implied probability for a market (max across buckets), or null. */
function favoriteProb(o: Odds | undefined): number | null {
  if (!o || o.impliedProbs.length === 0) return null;
  return Math.max(...o.impliedProbs);
}

// ── Eligibility ────────────────────────────────────────────────────────────────

/**
 * Keep fixtures that kick off strictly after `lockTs` AND whose assumed end
 * (kickoff + ~2h) falls within `windowSecs` of `lockTs`. Order is preserved.
 */
export function filterEligible(fixtures: Fixture[], lockTs: number, windowSecs: number): Fixture[] {
  const windowEnd = lockTs + windowSecs;
  return fixtures.filter(
    (f) => f.kickoffTs > lockTs && f.kickoffTs + MATCH_LEN_SECS <= windowEnd,
  );
}

// ── Clustering (coherent slate) ──────────────────────────────────────────────────

/**
 * Collapse a day's eligible fixtures to a COHERENT slate: the cluster that starts
 * at the EARLIEST kickoff and includes only fixtures kicking off within
 * `maxSpreadSecs` of that earliest one. Everything later is dropped.
 *
 * Why: on a real World Cup day the eligible matches can span ~19h. Without this,
 * the card would lock at the first kickoff and sit locked for most of the day
 * waiting for the last match. Bounding the kickoff spread keeps lock (first
 * kickoff) and settle (last kickoff + buffer) only a few hours apart, so there's
 * a real, short entry window.
 *
 * Input order is irrelevant (we anchor on the min kickoff); output preserves the
 * input order of the surviving fixtures so downstream ranking stays stable.
 */
export function clusterBySpread(fixtures: Fixture[], maxSpreadSecs: number): Fixture[] {
  if (fixtures.length === 0) return [];
  const earliest = Math.min(...fixtures.map((f) => f.kickoffTs));
  return fixtures.filter((f) => f.kickoffTs - earliest <= maxSpreadSecs);
}

// ── Ranking ────────────────────────────────────────────────────────────────────

/**
 * Rank by competitiveness on the Result market (12): the closer the odds, the
 * lower the favorite's implied probability, the earlier it ranks. Fixtures with
 * no Result odds sink to the bottom (they can't anchor a spread leg). Stable on
 * ties via the original index.
 */
export function rankMatches(fixtures: Fixture[], odds: Odds[]): Fixture[] {
  const idx = indexOdds(odds);
  const score = (f: Fixture): number => {
    const fav = favoriteProb(idx.get(`${f.fixtureId}:12`));
    // Missing Result odds → treat as maximally lopsided so it ranks last.
    return fav ?? Number.POSITIVE_INFINITY;
  };
  return fixtures
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.f);
}

// ── Allocation (balanced mix: Result + Goals, then HT for texture) ───────────────

/** Market ids, by role, that the balanced allocation composes with. */
const M_RESULT = 12; // Match Result 1X2
const M_GOALS = 11; // Total Goals O/U
const M_HT_RESULT = 16; // 1st-Half Result
const M_HT_GOALS = 15; // 1st-Half Goals O/U

/**
 * Balanced-mix allocation. Instead of laying one whole market across every match
 * before touching the next (which made the card's texture swing wildly with the
 * match count — a 6-match day was 6 Results and ZERO Goals; a 3-match day was
 * 3+3), we deterministically compose a genuine MIX of bet types on every card:
 * winners AND goals, plus half-time markets for texture only when matches are
 * scarce.
 *
 * We still lead SPREAD-FIRST (cover as many distinct matches as we can) by
 * capping the Result pass and preferring unused matches in later passes:
 *
 *   1. RESULT pass  — add Result (12) to matches in rank order, capped at
 *      floor(target/2) legs (≤3 for target 6) or until matches run out. This
 *      reserves half the card for other bet types so a Result-heavy day can't
 *      crowd out Goals.
 *   2. GOALS pass   — add Goals O/U (11) in rank order, but PREFERRING matches
 *      that don't yet carry a leg (to widen the spread) before doubling up on
 *      matches that do, until target is reached or Goals are exhausted.
 *   3. HT-RESULT (16) then HT-GOALS (15) passes — same "prefer unused matches
 *      first" fill, used only to reach the target when matches are scarce.
 *   4. COMPLETION — if still short (e.g. a 1-match day), sweep the priceable
 *      universe in menu order and add any pair not yet taken. A (fixture, market)
 *      pair is NEVER laid twice: a duplicate would double-count one outcome's
 *      multiplier and break the survival premise. When the distinct universe is
 *      exhausted the card ships short — create_contest accepts 3..=6 legs, so a
 *      1-match day yields 12,11,16,15 (+ the composer's chaos leg) and stops.
 *
 * Each pass only adds a (fixture, market) leg when that fixture actually has odds
 * for that market (never invent a leg TxLINE can't price) and skips pairs already
 * taken or in `exclude`. `exclude` lets the orchestrator re-allocate while
 * skipping (fixture, market) pairs the quality gate rejected, so a backfill pass
 * pulls DIFFERENT legs instead of re-proposing a blowout; excluded pairs are
 * dropped from every pass and from the completion sweep.
 *
 * `menu` still governs the COMPLETION order (and keeps callers' signature). A
 * caller passing a restricted menu (e.g. [12]) only ever gets that market — the
 * role passes below are intersected with `menu` membership, so an out-of-menu
 * market is never laid.
 */
export function allocateLegs(
  ranked: Fixture[],
  odds: Odds[],
  target: number,
  menu: number[],
  exclude: Set<string> = new Set(),
): Leg[] {
  const idx = indexOdds(odds);
  const legs: Leg[] = [];
  const taken = new Set<string>();
  const inMenu = new Set(menu);

  const usable = (fixtureId: number, market: number) =>
    inMenu.has(market) &&
    idx.has(`${fixtureId}:${market}`) &&
    !exclude.has(`${fixtureId}:${market}`);

  /** True once a fixture already carries at least one leg. */
  const hasLeg = (fixtureId: number) =>
    legs.some((l) => l.fixtureId === fixtureId);

  /** Try to add one (fixture, market) leg; returns false if not addable. */
  const add = (fixtureId: number, market: number): boolean => {
    if (legs.length >= target) return false;
    const key = `${fixtureId}:${market}`;
    if (taken.has(key)) return false;
    if (!usable(fixtureId, market)) return false;
    taken.add(key);
    legs.push({ fixtureId, marketId: market });
    return true;
  };

  // ── Pass 1: RESULT (12), capped so half the card is reserved for other types. ──
  // floor(target/2) (≤3 for target 6), but at least 1 so a degenerate single-leg
  // card (target 1) still gets its one Result rather than being starved to empty.
  const resultCap = Math.max(1, Math.floor(target / 2));
  let results = 0;
  for (const f of ranked) {
    if (legs.length >= target || results >= resultCap) break;
    if (add(f.fixtureId, M_RESULT)) results++;
  }

  // ── Passes 2–4: fill a market, preferring matches with no leg yet (spread),
  //    then matches that already have one. Goals first (the intended mix), then
  //    the HT markets purely to reach the target on scarce slates. ──
  const fillPreferringUnused = (market: number) => {
    if (legs.length >= target) return;
    for (const f of ranked) if (!hasLeg(f.fixtureId)) add(f.fixtureId, market);
    for (const f of ranked) add(f.fixtureId, market);
  };
  fillPreferringUnused(M_GOALS);
  fillPreferringUnused(M_HT_RESULT);
  fillPreferringUnused(M_HT_GOALS);

  if (legs.length >= target) return legs.slice(0, target);

  // ── Completion: still short → sweep the priceable universe in menu order for
  // pairs the role passes didn't take (e.g. a menu market with no role pass).
  // add() refuses taken pairs, so a (fixture, market) pair is never laid twice;
  // when the distinct universe is exhausted the card ships short of the target
  // (the program accepts 3..=6 legs) rather than double-counting a market.
  for (const market of menu) {
    for (const f of ranked) {
      if (legs.length >= target) return legs;
      add(f.fixtureId, market);
    }
  }
  return legs;
}

// ── Quality gate ────────────────────────────────────────────────────────────────

/**
 * Drop "foregone conclusion" legs: any leg whose favorite's implied probability
 * exceeds `maxImplied`. The threshold is inclusive (a leg exactly at maxImplied
 * survives). Legs whose odds are missing are dropped too — we can't certify
 * quality without prices.
 */
export function qualityGate(legs: Leg[], odds: Odds[], maxImplied: number): Leg[] {
  const idx = indexOdds(odds);
  return legs.filter((l) => {
    const fav = favoriteProb(idx.get(`${l.fixtureId}:${l.marketId}`));
    if (fav === null) return false;
    return fav <= maxImplied;
  });
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

export type Card = { legs: Leg[]; lockTs: number; settleAfterTs: number };

export type BuildCardOpts = {
  lockTs: number;
  windowSecs: number;
  target: number;
  menu: number[];
  maxImplied: number;
  /**
   * Max kickoff spread (seconds) for the coherent slate. After eligibility we keep
   * only the cluster of fixtures kicking off within this many seconds of the
   * earliest eligible kickoff; everything later is excluded. This bounds
   * lock↔settle to `maxSpreadSecs + MATCH_LEN_SECS`. Default 6h (21600) when
   * omitted — effectively unbounded relative to a 24h eligibility window would be
   * the old behavior, so callers wanting a tight card pass e.g. 21600.
   */
  maxSpreadSecs?: number;
};

/** Default coherent-slate kickoff spread (6h) when `maxSpreadSecs` is omitted. */
const DEFAULT_MAX_SPREAD_SECS = 6 * 3600;

/**
 * Compose the day's card end-to-end:
 *   1. filter to eligible fixtures,
 *   2. collapse to a COHERENT slate — the cluster starting at the earliest
 *      eligible kickoff and spanning at most `maxSpreadSecs` (default 6h); later
 *      fixtures are excluded so lock↔settle stays a few hours, not the whole day,
 *   3. rank by competitiveness,
 *   4. allocate spread-first,
 *   5. apply the quality gate, and — if the gate dropped legs — re-allocate at
 *      the SAME target while excluding the rejected (fixture, market) pairs, so
 *      the gate's casualties get backfilled with different legs (never repeats of
 *      a blowout, never more legs than the menu naturally supports), then gate
 *      again until the surviving count stops improving,
 *   6. stamp lockTs (earliest selected kickoff, clamped to the passed-in lockTs)
 *      and settleAfterTs (latest selected kickoff + match-length buffer). Because
 *      the slate is clustered, lock↔settle ≤ maxSpreadSecs + MATCH_LEN_SECS.
 *
 * On an empty/ineligible slate the card has no legs and falls back to the
 * passed-in lockTs (settleAfterTs = lockTs + buffer).
 */
export function buildCard(fixtures: Fixture[], odds: Odds[], opts: BuildCardOpts): Card {
  const { lockTs, windowSecs, target, menu, maxImplied } = opts;
  const maxSpreadSecs = opts.maxSpreadSecs ?? DEFAULT_MAX_SPREAD_SECS;

  const eligible = filterEligible(fixtures, lockTs, windowSecs);
  const slate = clusterBySpread(eligible, maxSpreadSecs);
  const ranked = rankMatches(slate, odds);

  // Allocate, gate, then backfill by EXCLUSION at a constant target. Every leg
  // the gate rejects is added to `banned` and we re-allocate; the allocator then
  // pulls the next eligible leg in its place. We iterate to a fixed point so a
  // backfilled leg that ALSO fails the gate gets replaced in turn. This recovers
  // a full card after blowouts without inflating the target (so a small menu
  // still can't fabricate repeat legs) and without ever exceeding the universe.
  const banned = new Set<string>();
  let legs = allocateLegs(ranked, odds, target, menu, banned);
  let gated = qualityGate(legs, odds, maxImplied);
  let guard = 0;
  const guardMax = menu.length * Math.max(ranked.length, 1) + target;
  while (gated.length < legs.length && guard < guardMax) {
    // Ban exactly the legs that were just rejected, then re-allocate + re-gate.
    for (const l of legs) {
      if (!gated.some((g) => g.fixtureId === l.fixtureId && g.marketId === l.marketId)) {
        banned.add(`${l.fixtureId}:${l.marketId}`);
      }
    }
    const next = allocateLegs(ranked, odds, target, menu, banned);
    const nextGated = qualityGate(next, odds, maxImplied);
    if (nextGated.length <= gated.length) {
      // No improvement → universe exhausted; keep the best clean set we have.
      legs = next;
      gated = nextGated;
      break;
    }
    legs = next;
    gated = nextGated;
    guard++;
  }
  legs = gated;

  // Timestamps from the SELECTED fixtures only.
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const kicks = legs
    .map((l) => byId.get(l.fixtureId)?.kickoffTs)
    .filter((k): k is number => typeof k === "number");

  const outLock = kicks.length ? Math.max(lockTs, Math.min(...kicks)) : lockTs;
  const settleBase = kicks.length ? Math.max(...kicks) : lockTs;
  const settleAfterTs = settleBase + MATCH_LEN_SECS;

  return { legs, lockTs: outLock, settleAfterTs };
}

// ── Pearly (all-day, cross-fixture card) ─────────────────────────────────────────

/** A pearly leg carries its own entry lock (its fixture's kickoff). */
export type PearlyLeg = Leg & { lockTs: number };

export type PearlyCard = {
  legs: PearlyLeg[];
  lockTs: number;          // min leg lock (first kickoff)
  entriesCloseTs: number;  // the (n - MIN_OPEN_LEGS)-th smallest leg lock
  settleAfterTs: number;   // last kickoff + match buffer
};

/** Chaos market: Red Card Shown Y/N on the marquee fixture. */
const M_RED_CARD = 17;
/** Mirrors the program's MIN_OPEN_LEGS (contest_state.rs). */
const MIN_OPEN_LEGS = 3;

/**
 * Compose the Daily Pearly: the WHOLE day's eligible slate (no cluster collapse —
 * the day IS the game), one Result leg per fixture (up to 4), one Goals leg on the
 * most competitive fixture, remaining slots from the HT menu, and the final slot
 * RESERVED for the chaos leg: Red Card Y/N (market 17) on the marquee (top-ranked)
 * fixture. Per-leg lockTs = the leg's own fixture kickoff; entriesCloseTs is the
 * (n − MIN_OPEN_LEGS)-th smallest lock so ≥3 legs are always open to a new entry.
 */
export function buildPearlyCard(
  fixtures: Fixture[],
  odds: Odds[],
  opts: Omit<BuildCardOpts, "maxSpreadSecs">,
): PearlyCard {
  const { lockTs, windowSecs, target, menu, maxImplied } = opts;
  const eligible = filterEligible(fixtures, lockTs, windowSecs);
  const ranked = rankMatches(eligible, odds);
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));

  // Reserve one slot for the chaos leg; allocate the rest with a 4-winner cap.
  // allocateLegs caps Results at floor(target/2); with target-1 == 5 that is 2 —
  // too few. Run the Result pass manually to 4, then let allocateLegs fill the
  // remainder from the non-Result menu with the chosen legs excluded.
  const legs: Leg[] = [];
  const idx = new Set(odds.map((o) => `${o.fixtureId}:${o.market}`));
  for (const f of ranked) {
    if (legs.length >= Math.min(4, target - 2)) break;
    if (idx.has(`${f.fixtureId}:12`) && menu.includes(12)) {
      legs.push({ fixtureId: f.fixtureId, marketId: 12 });
    }
  }
  const exclude = new Set(legs.map((l) => `${l.fixtureId}:${l.marketId}`));
  const fillTarget = target - 1; // one slot reserved for chaos
  const fill = allocateLegs(ranked, odds, fillTarget - legs.length, menu.filter((m) => m !== 12), exclude);
  legs.push(...fill);

  const gated = qualityGate(legs, odds, maxImplied);

  // Chaos leg — marquee fixture (top-ranked), market 17, NOT quality-gated (a
  // red card is never a foregone conclusion) and always priced (Y/N).
  const out: Leg[] = gated.slice(0, target - 1);
  if (ranked.length > 0) out.push({ fixtureId: ranked[0].fixtureId, marketId: M_RED_CARD });

  const pearlyLegs: PearlyLeg[] = out.map((l) => ({
    ...l,
    lockTs: byId.get(l.fixtureId)?.kickoffTs ?? lockTs,
  }));

  const locks = pearlyLegs.map((l) => l.lockTs).sort((a, b) => a - b);
  const first = locks[0] ?? lockTs;
  const closeIdx = Math.max(0, pearlyLegs.length - MIN_OPEN_LEGS);
  const entriesCloseTs = locks[closeIdx] ?? first;
  const last = locks[locks.length - 1] ?? lockTs;

  return {
    legs: pearlyLegs,
    lockTs: first,
    entriesCloseTs,
    settleAfterTs: last + 2 * 3600,
  };
}
