import { describe, it, expect } from "vitest";
import {
  filterEligible,
  clusterBySpread,
  rankMatches,
  allocateLegs,
  qualityGate,
  buildCard,
  buildPearlyCard,
  DEFAULT_MENU,
  type Fixture,
  type Odds,
} from "../src/allocator.ts";

const HOUR = 3600;

/** Make a fixture with a kickoff `hoursAfter` lock. */
function fx(id: number, kickoffTs: number): Fixture {
  return { fixtureId: id, home: `H${id}`, away: `A${id}`, kickoffTs };
}

/** Result (market 12) odds for a fixture, given the home implied prob and a
 *  competitiveness shape; draw/away split the remainder evenly by default. */
function resultOdds(fixtureId: number, probs: [number, number, number]): Odds {
  return { fixtureId, market: 12, impliedProbs: probs };
}

/** A balanced 2-bucket O/U market for a fixture. */
function ouOdds(fixtureId: number, market: number, probs: [number, number] = [0.5, 0.5]): Odds {
  return { fixtureId, market, impliedProbs: probs };
}

/** Full market set (12/11/16/15) for one fixture, all reasonably balanced. */
function fullOdds(fixtureId: number, resultProbs: [number, number, number] = [0.4, 0.3, 0.3]): Odds[] {
  return [
    resultOdds(fixtureId, resultProbs),
    ouOdds(fixtureId, 11, [0.55, 0.45]),
    { fixtureId, market: 16, impliedProbs: [0.4, 0.35, 0.25] },
    ouOdds(fixtureId, 15, [0.6, 0.4]),
  ];
}

describe("filterEligible", () => {
  const lockTs = 1_000_000;
  const windowSecs = 24 * HOUR;

  it("keeps fixtures kicking off after lockTs and finishing within the window", () => {
    const fixtures = [
      fx(1, lockTs + 1 * HOUR),
      fx(2, lockTs + 10 * HOUR),
      fx(3, lockTs + 21 * HOUR), // +2h match end = +23h, inside the 24h window
    ];
    const out = filterEligible(fixtures, lockTs, windowSecs);
    expect(out.map((f) => f.fixtureId)).toEqual([1, 2, 3]);
  });

  it("excludes a fixture whose kickoff+2h lands past the window", () => {
    // kickoff at +23h → match end +25h, past the 24h window → dropped.
    const late = fx(9, lockTs + 23 * HOUR);
    const ok = fx(1, lockTs + 1 * HOUR);
    const out = filterEligible([ok, late], lockTs, windowSecs);
    expect(out.map((f) => f.fixtureId)).toEqual([1]);
  });

  it("excludes a fixture kicking off before (or at) lockTs", () => {
    const past = fx(8, lockTs - 1); // already started
    const atLock = fx(7, lockTs); // not strictly after lock
    const ok = fx(1, lockTs + 2 * HOUR);
    const out = filterEligible([past, atLock, ok], lockTs, windowSecs);
    expect(out.map((f) => f.fixtureId)).toEqual([1]);
  });
});

describe("clusterBySpread", () => {
  it("keeps only fixtures within maxSpread of the earliest kickoff", () => {
    const base = 1_000_000;
    // Kickoffs at +0h, +2h, +5h, +7h, +19h relative to the earliest.
    const fixtures = [
      fx(1, base + 0 * HOUR),
      fx(2, base + 2 * HOUR),
      fx(3, base + 5 * HOUR),
      fx(4, base + 7 * HOUR),
      fx(5, base + 19 * HOUR),
    ];
    // 6h spread → keep +0h/+2h/+5h; drop +7h and +19h.
    const out = clusterBySpread(fixtures, 6 * HOUR);
    expect(out.map((f) => f.fixtureId)).toEqual([1, 2, 3]);
  });

  it("anchors on the earliest kickoff regardless of input order", () => {
    const base = 1_000_000;
    const fixtures = [
      fx(5, base + 19 * HOUR),
      fx(3, base + 5 * HOUR),
      fx(1, base + 0 * HOUR), // earliest, but last in the input
      fx(2, base + 2 * HOUR),
    ];
    const out = clusterBySpread(fixtures, 6 * HOUR);
    // Cluster anchored on +0h; survivors keep INPUT order (3, 1, 2).
    expect(out.map((f) => f.fixtureId)).toEqual([3, 1, 2]);
  });

  it("keeps a fixture exactly at the spread boundary (inclusive)", () => {
    const base = 1_000_000;
    const fixtures = [fx(1, base), fx(2, base + 6 * HOUR)];
    expect(clusterBySpread(fixtures, 6 * HOUR).map((f) => f.fixtureId)).toEqual([1, 2]);
  });

  it("returns an empty cluster for an empty input", () => {
    expect(clusterBySpread([], 6 * HOUR)).toEqual([]);
  });
});

describe("rankMatches", () => {
  it("ranks more competitive matches (lower max implied prob on Result) first", () => {
    const fixtures = [fx(1, 100), fx(2, 100), fx(3, 100)];
    const odds = [
      resultOdds(1, [0.6, 0.25, 0.15]), // max 0.60
      resultOdds(2, [0.34, 0.33, 0.33]), // max 0.34 — most competitive
      resultOdds(3, [0.5, 0.3, 0.2]), // max 0.50
    ];
    const ranked = rankMatches(fixtures, odds);
    expect(ranked.map((f) => f.fixtureId)).toEqual([2, 3, 1]);
  });

  it("sinks fixtures with no Result-market odds to the bottom", () => {
    const fixtures = [fx(1, 100), fx(2, 100)];
    const odds = [resultOdds(2, [0.45, 0.3, 0.25])]; // fixture 1 has no result odds
    const ranked = rankMatches(fixtures, odds);
    expect(ranked.map((f) => f.fixtureId)).toEqual([2, 1]);
  });
});

describe("allocateLegs (balanced mix)", () => {
  it("6 matches → 3 Result (12) on the top 3 + 3 Goals (11) on the next 3 = a mix over 6 fixtures", () => {
    const ranked = [1, 2, 3, 4, 5, 6].map((id) => fx(id, 100));
    const odds = ranked.flatMap((f) => fullOdds(f.fixtureId));
    const legs = allocateLegs(ranked, odds, 6, DEFAULT_MENU);

    expect(legs).toHaveLength(6);
    // Result pass is capped at floor(6/2)=3; Goals pass fills the other half.
    expect(legs.filter((l) => l.marketId === 12)).toHaveLength(3);
    expect(legs.filter((l) => l.marketId === 11)).toHaveLength(3);
    // Every fixture is distinct — one bet type each, spread across the whole slate.
    expect(new Set(legs.map((l) => l.fixtureId)).size).toBe(6);
    // Results land on the top-3 ranked fixtures; Goals on fixtures 4–6.
    expect(legs.filter((l) => l.marketId === 12).map((l) => l.fixtureId).sort()).toEqual([1, 2, 3]);
    expect(legs.filter((l) => l.marketId === 11).map((l) => l.fixtureId).sort()).toEqual([4, 5, 6]);
  });

  it("3 matches → 3 Result (12) + 3 Goals (11), one of each bet type per fixture", () => {
    const ranked = [1, 2, 3].map((id) => fx(id, 100));
    const odds = ranked.flatMap((f) => fullOdds(f.fixtureId));
    const legs = allocateLegs(ranked, odds, 6, DEFAULT_MENU);

    expect(legs).toHaveLength(6);
    expect(legs.filter((l) => l.marketId === 12)).toHaveLength(3);
    expect(legs.filter((l) => l.marketId === 11)).toHaveLength(3);
    // Result pass runs first (capped at 3 = all 3 matches), then Goals on all 3.
    expect(legs.slice(0, 3).every((l) => l.marketId === 12)).toBe(true);
    // Each of the 3 fixtures carries exactly a Result and a Goals leg.
    for (const id of [1, 2, 3]) {
      const forFx = legs.filter((l) => l.fixtureId === id).map((l) => l.marketId).sort();
      expect(forFx).toEqual([11, 12]);
    }
    // No duplicate (fixture, market) leg.
    expect(new Set(legs.map((l) => `${l.fixtureId}:${l.marketId}`)).size).toBe(6);
  });

  it("2 matches → 2 Result (12) + 2 Goals (11) + 2 HT-Result (16) for texture", () => {
    const ranked = [1, 2].map((id) => fx(id, 100));
    const odds = ranked.flatMap((f) => fullOdds(f.fixtureId));
    const legs = allocateLegs(ranked, odds, 6, DEFAULT_MENU);

    expect(legs).toHaveLength(6);
    expect(legs.filter((l) => l.marketId === 12)).toHaveLength(2);
    expect(legs.filter((l) => l.marketId === 11)).toHaveLength(2);
    expect(legs.filter((l) => l.marketId === 16)).toHaveLength(2);
    // HT-Goals (15) isn't needed to reach 6 with two matches, so it stays off.
    expect(legs.some((l) => l.marketId === 15)).toBe(false);
  });

  it("1 match → Result, Goals, HT-Result, HT-Goals across the menu, then STOPS — a pair is never laid twice", () => {
    const ranked = [fx(1, 100)];
    const odds = fullOdds(1);
    const legs = allocateLegs(ranked, odds, 6, DEFAULT_MENU);

    // Only 4 distinct (fixture, market) pairs exist; the card stays short of the
    // target rather than double-counting one market (the program floor is 3 legs).
    expect(legs).toHaveLength(4);
    expect(legs.every((l) => l.fixtureId === 1)).toBe(true);
    expect(legs.map((l) => l.marketId)).toEqual([12, 11, 16, 15]);
    expect(new Set(legs.map((l) => `${l.fixtureId}:${l.marketId}`)).size).toBe(4);
  });

  it("skips a market a fixture has no odds for and returns short — never invents or repeats", () => {
    const ranked = [fx(1, 100)];
    // Fixture 1 is missing market 16 (HT Result); it should be skipped, not invented.
    const odds = [resultOdds(1, [0.4, 0.3, 0.3]), ouOdds(1, 11), ouOdds(1, 15)];
    const legs = allocateLegs(ranked, odds, 4, DEFAULT_MENU);
    // distinct markets available = 12, 11, 15 → stop at 3; no repeat pads the 4th.
    expect(legs.map((l) => l.marketId)).toEqual([12, 11, 15]);
  });

  it("respects a restricted menu — never lays a market outside it, never repeats within it", () => {
    const ranked = [1, 2, 3].map((id) => fx(id, 100));
    const odds = ranked.flatMap((f) => fullOdds(f.fixtureId)); // all markets priceable
    // Menu is Result-only: even though Goals/HT odds exist, only 12 may be laid.
    const legs = allocateLegs(ranked, odds, 6, [12]);
    expect(legs.every((l) => l.marketId === 12)).toBe(true);
    // 3 distinct Results and nothing else — no repeat padding toward 6.
    expect(legs).toHaveLength(3);
  });

  it("fills un-taken menu pairs the role passes don't know before stopping (widened menu)", () => {
    const ranked = [fx(1, 100)];
    // Market 13 is priceable and in the menu but has no dedicated role pass.
    const odds = [...fullOdds(1), ouOdds(1, 13)];
    const legs = allocateLegs(ranked, odds, 6, [...DEFAULT_MENU, 13]);

    // The completion pass lays (1, 13) rather than repeating (1, 12).
    expect(legs).toHaveLength(5);
    expect(legs.some((l) => l.marketId === 13)).toBe(true);
    expect(new Set(legs.map((l) => `${l.fixtureId}:${l.marketId}`)).size).toBe(5);
  });

  it("never exceeds the available leg universe when target is unreachable", () => {
    const ranked = [fx(1, 100)];
    const odds = [resultOdds(1, [0.4, 0.3, 0.3])]; // only one market, no repeats requested
    // With a single market and target 1 we still get exactly 1.
    expect(allocateLegs(ranked, odds, 1, [12])).toHaveLength(1);
  });

  it("every multi-match card is a genuine mix: both a Result and a Goals leg, Results ≤ floor(target/2)", () => {
    // Sweep 2..6 matches; each card must contain BOTH bet types and cap Results.
    for (const n of [2, 3, 4, 5, 6]) {
      const ranked = Array.from({ length: n }, (_, i) => fx(i + 1, 100));
      const odds = ranked.flatMap((f) => fullOdds(f.fixtureId));
      const legs = allocateLegs(ranked, odds, 6, DEFAULT_MENU);
      expect(legs).toHaveLength(6);
      expect(legs.some((l) => l.marketId === 12)).toBe(true); // has a Result
      expect(legs.some((l) => l.marketId === 11)).toBe(true); // has a Goals
      expect(legs.filter((l) => l.marketId === 12).length).toBeLessThanOrEqual(3); // floor(6/2)
    }
  });
});

describe("qualityGate", () => {
  it("drops legs whose favorite implied prob exceeds maxImplied (blowouts)", () => {
    const legs = [
      { fixtureId: 1, marketId: 12 },
      { fixtureId: 2, marketId: 12 },
    ];
    const odds = [
      resultOdds(1, [0.9, 0.07, 0.03]), // blowout — favorite 0.90 > 0.85
      resultOdds(2, [0.45, 0.3, 0.25]), // fine
    ];
    const out = qualityGate(legs, odds, 0.85);
    expect(out.map((l) => l.fixtureId)).toEqual([2]);
  });

  it("keeps a leg exactly at the threshold (inclusive)", () => {
    const legs = [{ fixtureId: 1, marketId: 11 }];
    const odds = [ouOdds(1, 11, [0.85, 0.15])];
    expect(qualityGate(legs, odds, 0.85)).toHaveLength(1);
  });

  it("drops a leg whose odds are missing (cannot verify quality)", () => {
    const legs = [{ fixtureId: 1, marketId: 11 }];
    expect(qualityGate(legs, [], 0.9)).toHaveLength(0);
  });
});

describe("buildCard (orchestrator)", () => {
  const lockTs = 1_000_000;
  const windowSecs = 24 * HOUR;

  it("assembles 6 legs across 6 eligible matches with sensible lock/settle stamps", () => {
    // All 6 kickoffs fall within +1h..+6h → a 5h spread, inside the 6h cluster.
    const kicks = [3, 1, 5, 2, 6, 4].map((h) => lockTs + h * HOUR);
    const fixtures = kicks.map((k, i) => fx(i + 1, k));
    const odds = fixtures.flatMap((f) => fullOdds(f.fixtureId));

    const card = buildCard(fixtures, odds, {
      lockTs,
      windowSecs,
      target: 6,
      menu: DEFAULT_MENU,
      maxImplied: 0.85,
      maxSpreadSecs: 6 * HOUR,
    });

    expect(card.legs).toHaveLength(6);
    // A genuine mix: 3 Results + 3 Goals across all 6 distinct matches.
    expect(card.legs.filter((l) => l.marketId === 12)).toHaveLength(3);
    expect(card.legs.filter((l) => l.marketId === 11)).toHaveLength(3);
    expect(new Set(card.legs.map((l) => l.fixtureId)).size).toBe(6);
    // lockTs = earliest selected kickoff, clamped to be >= the passed-in lockTs.
    const earliestSelected = Math.min(
      ...card.legs.map((l) => fixtures.find((f) => f.fixtureId === l.fixtureId)!.kickoffTs),
    );
    expect(card.lockTs).toBe(Math.max(lockTs, earliestSelected));
    // settleAfterTs = latest selected kickoff + 2h buffer.
    const latestSelected = Math.max(
      ...card.legs.map((l) => fixtures.find((f) => f.fixtureId === l.fixtureId)!.kickoffTs),
    );
    expect(card.settleAfterTs).toBe(latestSelected + 2 * HOUR);
  });

  it("clusters a day-spanning slate to the earliest window and bounds lock↔settle", () => {
    // Real-WC-shaped day: matches span ~19h (e.g. 01:00Z … 20:00Z). The eligible
    // set spans far more than maxSpread; only the earliest cluster should survive,
    // and lock↔settle must stay ≤ maxSpread + 2h buffer (not ~19h).
    const maxSpreadSecs = 6 * HOUR;
    const window = 24 * HOUR;
    const kicks = [1, 3, 5, 6, 12, 19].map((h) => lockTs + h * HOUR);
    const fixtures = kicks.map((k, i) => fx(i + 1, k));
    const odds = fixtures.flatMap((f) => fullOdds(f.fixtureId));

    const card = buildCard(fixtures, odds, {
      lockTs,
      windowSecs: window,
      target: 6,
      menu: DEFAULT_MENU,
      maxImplied: 0.85,
      maxSpreadSecs,
    });

    // Only fixtures 1..4 kick off within 6h of the earliest (+1h): +1,+3,+5,+6.
    // Fixtures 5 (+12h) and 6 (+19h) are excluded from the slate entirely.
    const selectedFixtureIds = new Set(card.legs.map((l) => l.fixtureId));
    expect(selectedFixtureIds.has(5)).toBe(false);
    expect(selectedFixtureIds.has(6)).toBe(false);
    // Earliest cluster kickoff is +1h; latest kept is +6h.
    expect(card.lockTs).toBe(lockTs + 1 * HOUR);
    expect(card.settleAfterTs).toBe(lockTs + 6 * HOUR + 2 * HOUR);
    // lock↔settle is bounded by the spread + the 2h match buffer, not the day.
    expect(card.settleAfterTs - card.lockTs).toBeLessThanOrEqual(maxSpreadSecs + 2 * HOUR);
  });

  it("backfills after the quality gate drops a blowout so the card still reaches 6 legs", () => {
    // 4 matches: one is a blowout on the Result market. With target 6 the
    // allocator first spreads 4 Results then climbs; the gate drops the blowout
    // Result, and buildCard re-allocates to recover a full 6-leg card.
    const fixtures = [1, 2, 3, 4].map((id) => fx(id, lockTs + id * HOUR));
    const odds = [
      ...fullOdds(1, [0.9, 0.06, 0.04]), // fixture 1 Result is a blowout
      ...fullOdds(2),
      ...fullOdds(3),
      ...fullOdds(4),
    ];

    const card = buildCard(fixtures, odds, {
      lockTs,
      windowSecs,
      target: 6,
      menu: DEFAULT_MENU,
      maxImplied: 0.85,
    });

    expect(card.legs).toHaveLength(6);
    // No surviving leg may be the blowout Result on fixture 1.
    const hasBlowout = card.legs.some((l) => l.fixtureId === 1 && l.marketId === 12);
    expect(hasBlowout).toBe(false);
    // All survivors pass the gate.
    const survivorsClean = qualityGate(card.legs, odds, 0.85);
    expect(survivorsClean).toHaveLength(6);
  });

  it("excludes ineligible fixtures (too late / before lock) before allocating", () => {
    const fixtures = [
      fx(1, lockTs + 1 * HOUR), // ok
      fx(2, lockTs + 2 * HOUR), // ok
      fx(3, lockTs - HOUR), // before lock → excluded
      fx(99, lockTs + 23 * HOUR), // +2h end past window → excluded
    ];
    const odds = fixtures.flatMap((f) => fullOdds(f.fixtureId));
    const card = buildCard(fixtures, odds, {
      lockTs,
      windowSecs,
      target: 6,
      menu: DEFAULT_MENU,
      maxImplied: 0.95,
    });
    // Only fixtures 1 and 2 survive → all legs are on those two.
    expect(new Set(card.legs.map((l) => l.fixtureId))).toEqual(new Set([1, 2]));
  });

  it("returns fewer legs than target when the eligible universe is too small", () => {
    const fixtures = [fx(1, lockTs + HOUR)];
    const odds = [resultOdds(1, [0.4, 0.3, 0.3])]; // single market, single match
    const card = buildCard(fixtures, odds, {
      lockTs,
      windowSecs,
      target: 6,
      menu: [12], // menu of one → only one possible leg, no repeats beyond it
      maxImplied: 0.9,
    });
    expect(card.legs).toHaveLength(1);
    expect(card.lockTs).toBe(lockTs + HOUR);
    expect(card.settleAfterTs).toBe(lockTs + HOUR + 2 * HOUR);
  });

  it("yields an empty card (no legs) when nothing is eligible", () => {
    const fixtures = [fx(1, lockTs - HOUR)]; // before lock
    const card = buildCard(fixtures, [], {
      lockTs,
      windowSecs,
      target: 6,
      menu: DEFAULT_MENU,
      maxImplied: 0.9,
    });
    expect(card.legs).toHaveLength(0);
    // With no selected matches, fall back to the passed-in lockTs and lock+buffer.
    expect(card.lockTs).toBe(lockTs);
    expect(card.settleAfterTs).toBe(lockTs + 2 * HOUR);
  });
});

describe("pearly card v2", () => {
  const fx = (id: number, ko: number) => ({ fixtureId: id, home: `H${id}`, away: `A${id}`, kickoffTs: ko });
  const neutral = (id: number, market: number, buckets: number) =>
    ({ fixtureId: id, market, impliedProbs: Array(buckets).fill(1 / buckets) });

  it("buildPearlyCard: 4 fixtures → 4 winners + 1 goals + chaos leg 17 on the marquee, per-leg locks from kickoffs", () => {
    const t0 = 1_000_000;
    const fixtures = [fx(1, t0 + 3600), fx(2, t0 + 7200), fx(3, t0 + 10800), fx(4, t0 + 14400)];
    const odds = fixtures.flatMap((f) => [neutral(f.fixtureId, 12, 3), neutral(f.fixtureId, 11, 2)]);
    const card = buildPearlyCard(fixtures, odds, {
      lockTs: t0, windowSecs: 24 * 3600, target: 6, menu: DEFAULT_MENU, maxImplied: 0.82,
    });
    expect(card.legs).toHaveLength(6);
    expect(card.legs.filter((l) => l.marketId === 12)).toHaveLength(4);
    expect(card.legs.filter((l) => l.marketId === 11)).toHaveLength(1);
    const chaos = card.legs.find((l) => l.marketId === 17)!;
    expect(chaos.fixtureId).toBe(1); // marquee = top-ranked (neutral odds → first)
    // Per-leg locks = each leg's own fixture kickoff.
    for (const leg of card.legs) {
      const f = fixtures.find((x) => x.fixtureId === leg.fixtureId)!;
      expect(leg.lockTs).toBe(f.kickoffTs);
    }
    // entriesCloseTs = 4th-smallest leg lock.
    const sorted = card.legs.map((l) => l.lockTs).sort((a, b) => a - b);
    expect(card.entriesCloseTs).toBe(sorted[3]);
    expect(card.lockTs).toBe(sorted[0]);
  });

  it("buildPearlyCard: one-fixture final day → 5 distinct legs (4 markets + chaos), no duplicates", () => {
    const t0 = 3_000_000;
    const ko = t0 + 6 * 3600;
    const fixtures = [fx(21, ko)];
    const odds = [12, 11, 16, 15].map((m) => neutral(21, m, m === 12 || m === 16 ? 3 : 2));
    const card = buildPearlyCard(fixtures, odds, {
      lockTs: t0, windowSecs: 24 * 3600, target: 6, menu: DEFAULT_MENU, maxImplied: 0.82,
    });

    // 4 distinct markets + the chaos leg — legal for the program (3..=6), and no
    // (fixture, market) pair appears twice.
    expect(card.legs).toHaveLength(5);
    expect(new Set(card.legs.map((l) => `${l.fixtureId}:${l.marketId}`)).size).toBe(5);
    expect(card.legs.map((l) => l.marketId).sort((a, b) => a - b)).toEqual([11, 12, 15, 16, 17]);
    expect(card.legs.every((l) => l.fixtureId === 21 && l.lockTs === ko)).toBe(true);
    // All locks equal → entries close at kickoff; settle after last kickoff + buffer.
    expect(card.entriesCloseTs).toBe(ko);
    expect(card.settleAfterTs).toBe(ko + 2 * 3600);
  });

  it("buildPearlyCard: no clusterBySpread — a 12h-spread slate keeps all fixtures", () => {
    const t0 = 2_000_000;
    const fixtures = [fx(11, t0 + 3600), fx(12, t0 + 12 * 3600)];
    const odds = fixtures.flatMap((f) => [neutral(f.fixtureId, 12, 3), neutral(f.fixtureId, 11, 2)]);
    const card = buildPearlyCard(fixtures, odds, {
      lockTs: t0, windowSecs: 24 * 3600, target: 6, menu: DEFAULT_MENU, maxImplied: 0.82,
    });
    expect(new Set(card.legs.map((l) => l.fixtureId)).size).toBe(2);
  });
});
