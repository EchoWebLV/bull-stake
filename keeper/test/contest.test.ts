import { describe, it, expect } from "vitest";
import {
  countPerfect,
  countPerfectWeighted,
  selectParlayMatches,
  parlayParams,
  previewSettle,
  buildCreateArgs,
  type SlateMatch,
} from "../contest.js";

describe("buildCreateArgs", () => {
  it("assembles padded create_contest args for a one-fixture, 4-leg parlay", () => {
    const p = parlayParams(12345, 1_700_000_000_000);
    const a = buildCreateArgs(p);
    // contest_id == fixtureId
    expect(a.contestId).toBe(12345);
    // fixtures = fixtureId repeated num_legs (4) times, padded to MAX_LEGS (6) with 0
    expect(a.fixtures).toEqual([12345, 12345, 12345, 12345, 0, 0]);
    expect(a.fixtures.length).toBe(6);
    // market_ids = [16, 15, 12, 11] padded to MAX_LEGS (6) with 0
    expect(a.marketIds).toEqual([16, 15, 12, 11, 0, 0]);
    expect(a.marketIds.length).toBe(6);
    // num_legs = 4
    expect(a.numLegs).toBe(4);
    // window carried straight through from parlayParams
    expect(a.lockTs).toBe(p.lockTs);
    expect(a.settleAfterTs).toBe(p.settleAfterTs);
    expect(a.settleAfterTs).toBe(a.lockTs + 3 * 3600);
  });

  it("uses the SAME fixture for every leg (single-match parlay)", () => {
    const a = buildCreateArgs(parlayParams(777, 1_700_000_000_000));
    // every non-pad fixture entry equals the one fixtureId
    expect(a.fixtures.slice(0, a.numLegs)).toEqual([777, 777, 777, 777]);
  });
});

describe("countPerfect", () => {
  const winning = [0, 1, 2];
  it("counts only entries matching every leg", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 0] }, // perfect
      { picks: [0, 1, 2, 1, 1] }, // perfect (tail beyond numLegs ignored)
      { picks: [0, 1, 1, 0, 0] }, // wrong on leg 3
      { picks: [2, 1, 2, 0, 0] }, // wrong on leg 1
    ];
    expect(countPerfect(entries, winning, 3)).toBe(2);
  });
  it("returns 0 when nobody is perfect", () => {
    expect(countPerfect([{ picks: [1, 1, 1, 0, 0] }], winning, 3)).toBe(0);
  });
});

describe("countPerfectWeighted", () => {
  const legLockTs = [100, 200, 300, 400, 500, 600];
  const winning = [0, 1, 2, 0, 1, 2];
  it("full-mask early entry counts weight 64; late 5-leg entry (leg0 locked, leg0 pick wrong) counts weight 32", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 1, 2], entryTs: 50 },   // perfect, 6 active → 64
      { picks: [9, 1, 2, 0, 1, 2], entryTs: 150 },  // leg0 locked at entry → masked out → perfect on 5 → 32
      { picks: [0, 1, 2, 0, 1, 9], entryTs: 50 },   // active leg 5 wrong → imperfect
    ];
    const r = countPerfectWeighted(entries, winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 2, perfectWeight: 96 });
  });
  it("rollover: nobody perfect → 0/0", () => {
    const r = countPerfectWeighted([{ picks: [9, 9, 9, 9, 9, 9], entryTs: 50 }], winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 0, perfectWeight: 0 });
  });
  // RIDER A: mirrors claim_contest.rs's fail-closed seed `perfect = entry_ts > 0` —
  // an entry_ts <= 0 is impossible for a legitimate entry (real clocks are always
  // positive), so the chain refuses to ever pay it. The keeper must not count or
  // weight an entry the chain will never honor.
  it("entryTs <= 0 is fail-closed (mirrors claim_contest.rs `entry_ts > 0` seed): excluded even with all-correct picks", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 1, 2], entryTs: 0 }, // all-correct picks but entryTs 0 → excluded
    ];
    const r = countPerfectWeighted(entries, winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 0, perfectWeight: 0 });
  });
  it("entryTs <= 0 exclusion doesn't disturb other perfect entries", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 1, 2], entryTs: 0 },  // excluded (fail-closed)
      { picks: [0, 1, 2, 0, 1, 2], entryTs: 50 }, // perfect, 6 active → 64
    ];
    const r = countPerfectWeighted(entries, winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 1, perfectWeight: 64 });
  });
  // RIDER A boundary: pins strict inequality `leg_lock_ts[i] > entry_ts` — an
  // entryTs exactly equal to a leg's lock means that leg is NOT active (the
  // chain's `>` is strict, not `>=`).
  it("entryTs exactly equal to a leg's lock: that leg is NOT active (strict >, not >=)", () => {
    const entries = [
      // leg0 lock is 100; entryTs 100 → 100 > 100 is false → leg0 NOT active.
      // Other 5 legs (locks 200..600) are all > 100 → active. leg0 pick is wrong
      // (9 vs winning 0) but since leg0 is inactive it's ignored → still perfect
      // on the other 5 → weight 2^5 = 32.
      { picks: [9, 1, 2, 0, 1, 2], entryTs: 100 },
    ];
    const r = countPerfectWeighted(entries, winning, legLockTs, 6);
    expect(r).toEqual({ perfectCount: 1, perfectWeight: 32 });
  });
});

describe("selectParlayMatches", () => {
  const base = 1_700_000_000_000; // arbitrary epoch-ms anchor
  const MIN = 60_000;
  // 5-match slate, varied kickoffs (out of order on purpose).
  const slate: SlateMatch[] = [
    { fixtureId: 1, home: "A", away: "B", kickoffMs: base + 0 * MIN },   // t=0
    { fixtureId: 2, home: "C", away: "D", kickoffMs: base + 60 * MIN },  // t=60  (<120 after #1)
    { fixtureId: 3, home: "E", away: "F", kickoffMs: base + 130 * MIN }, // t=130 (≥120 after #1)
    { fixtureId: 4, home: "G", away: "H", kickoffMs: base + 200 * MIN }, // t=200 (<120 after #3 @130)
    { fixtureId: 5, home: "I", away: "J", kickoffMs: base + 260 * MIN }, // t=260 (≥120 after #3 @130)
  ];

  it("picks ≤maxN with ≥minGap, earliest-first, skipping too-close kickoffs", () => {
    const r = selectParlayMatches(slate, 3, 120);
    expect(r.map((m) => m.fixtureId)).toEqual([1, 3, 5]);
    expect(r.length).toBeLessThanOrEqual(3);
    // each pick ≥120 min after the previous
    for (let i = 1; i < r.length; i++) {
      expect(r[i].kickoffMs - r[i - 1].kickoffMs).toBeGreaterThanOrEqual(120 * MIN);
    }
    // earliest-first
    for (let i = 1; i < r.length; i++) {
      expect(r[i].kickoffMs).toBeGreaterThan(r[i - 1].kickoffMs);
    }
  });

  it("caps at maxN even when more spaced matches exist", () => {
    const r = selectParlayMatches(slate, 2, 120);
    expect(r.map((m) => m.fixtureId)).toEqual([1, 3]);
    expect(r.length).toBe(2);
  });

  it("excludes matches with kickoffMs <= 0", () => {
    const dirty: SlateMatch[] = [
      { fixtureId: 9, home: "X", away: "Y", kickoffMs: 0 },
      { fixtureId: 10, home: "Z", away: "W", kickoffMs: -5 },
      ...slate,
    ];
    const r = selectParlayMatches(dirty, 5, 120);
    expect(r.map((m) => m.fixtureId)).not.toContain(9);
    expect(r.map((m) => m.fixtureId)).not.toContain(10);
    expect(r.every((m) => m.kickoffMs > 0)).toBe(true);
  });

  it("returns fewer than maxN on a thin day (all kickoffs bunched)", () => {
    const thin: SlateMatch[] = [
      { fixtureId: 1, home: "A", away: "B", kickoffMs: base + 0 * MIN },
      { fixtureId: 2, home: "C", away: "D", kickoffMs: base + 30 * MIN },
      { fixtureId: 3, home: "E", away: "F", kickoffMs: base + 60 * MIN },
    ];
    const r = selectParlayMatches(thin, 3, 120);
    expect(r.map((m) => m.fixtureId)).toEqual([1]); // only the first fits
    expect(r.length).toBeLessThan(3);
  });

  it("returns empty for an empty slate", () => {
    expect(selectParlayMatches([], 3, 120)).toEqual([]);
  });
});

describe("parlayParams", () => {
  it("derives a one-fixture, 4-fixed-leg window with contestId == fixtureId", () => {
    const kickoffMs = 1_700_000_000_000;
    const p = parlayParams(12345, kickoffMs);
    expect(p.contestId).toBe(12345);
    expect(p.fixtureId).toBe(12345);
    expect(p.marketIds).toEqual([16, 15, 12, 11]);
    expect(p.numLegs).toBe(4);
    expect(p.lockTs).toBe(Math.floor(kickoffMs / 1000));
    expect(p.settleAfterTs).toBe(Math.floor(kickoffMs / 1000) + 3 * 3600);
  });

  it("honors a custom buffer", () => {
    const kickoffMs = 1_700_000_000_000;
    const p = parlayParams(7, kickoffMs, 7200);
    expect(p.settleAfterTs).toBe(Math.floor(kickoffMs / 1000) + 7200);
  });
});

describe("previewSettle (v2, jackpot-aware, weighted-claim era) — mirrors settle_contest.rs line-by-line (commit 542d57c)", () => {
  // Contest holds 1_000_000; rent floor 890_880 → pot 109_120.
  // 5 entries × 20_000 = 100_000 new stakes; 5% rake = 5_000 → potNet 104_120.
  // Jackpot rent floor 890_880 throughout.
  const JFLOOR = 890_880n;
  const base = {
    contestLamports: 1_000_000n,
    contestRentFloor: 890_880n,
    jackpotRentFloor: JFLOOR,
    entryCount: 5n,
    entryPrice: 20_000n,
    feeBps: 500,
  };

  it("winners, jpool=0: distributable == pot−rake, no jackpot movement", () => {
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR, perfectCount: 2n });
    expect(p.pot).toBe(109_120n);
    expect(p.rake).toBe(5_000n);             // (5 × 20_000 × 500) / 10_000
    expect(p.jpool).toBe(0n);
    expect(p.distributable).toBe(104_120n);  // potNet + jpool(0) — the FULL raw pool, undivided
    expect(p.jackpotIn).toBe(0n);            // jpool is 0 → nothing to pull in
    expect(p.jackpotOut).toBe(0n);           // winners branch never sweeps back out
    expect(p.rolledOver).toBe(false);
  });

  it("rollover (perfectCount=0): distributable==0, jackpotOut==pot−rake, jackpotIn==0", () => {
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR + 500_000n, perfectCount: 0n });
    expect(p.rolledOver).toBe(true);
    expect(p.rake).toBe(5_000n);             // rake still taken on new stakes
    expect(p.distributable).toBe(0n);
    expect(p.jackpotIn).toBe(0n);
    expect(p.jackpotOut).toBe(104_120n);     // potNet swept contest → jackpot
  });

  it("scoop (jpool>0): distributable==(pot−rake)+jpool, jackpotIn==jpool (whole pool pulled in), jackpotOut==0", () => {
    const jpool = 500_000n;
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR + jpool, perfectCount: 1n });
    expect(p.pot).toBe(109_120n);
    expect(p.rake).toBe(5_000n);
    expect(p.jpool).toBe(jpool);
    // distributable = potNet(104_120) + jpool(500_000) — no division/floor at settle.
    expect(p.distributable).toBe(604_120n);
    expect(p.jackpotIn).toBe(jpool);         // whole pool pulled into contest, unconditionally
    expect(p.jackpotOut).toBe(0n);
    expect(p.rolledOver).toBe(false);
  });

  it("distributable/jackpotIn/jackpotOut are INDEPENDENT of perfectCount (no more floor-by-count at settle)", () => {
    // Same pot + jpool, three different perfectCounts (was 2/3/7 pre-542d57c and used
    // to produce different share/dust/signed-jackpot-delta outputs). Post-542d57c
    // settle no longer divides by perfect_count at all — division-by-weight moved to
    // claim_contest.rs — so every one of these must report IDENTICAL money movement;
    // only `rolledOver` (driven off perfectCount==0) can differ.
    const jpool = 1_000_000n;
    const p2 = previewSettle({ ...base, jackpotLamports: JFLOOR + jpool, perfectCount: 2n });
    const p3 = previewSettle({ ...base, jackpotLamports: JFLOOR + jpool, perfectCount: 3n });
    const p7 = previewSettle({ ...base, jackpotLamports: JFLOOR + jpool, perfectCount: 7n });
    for (const p of [p2, p3, p7]) {
      expect(p.distributable).toBe(1_104_120n); // potNet(104_120) + jpool(1_000_000)
      expect(p.jackpotIn).toBe(jpool);
      expect(p.jackpotOut).toBe(0n);
      expect(p.rolledOver).toBe(false);
    }
  });

  it("rake capped at pot when nominal fees exceed the pot", () => {
    const p = previewSettle({
      contestLamports: 891_880n, contestRentFloor: 890_880n, // pot = 1_000
      jackpotLamports: JFLOOR, jackpotRentFloor: JFLOOR,
      entryCount: 100n, entryPrice: 20_000n, feeBps: 500, // rakeRaw = 100_000
      perfectCount: 1n,
    });
    expect(p.pot).toBe(1_000n);
    expect(p.rake).toBe(1_000n);             // min(100_000, 1_000)
    // potNet 0, jpool 0 → distributable 0
    expect(p.distributable).toBe(0n);
    expect(p.jackpotIn).toBe(0n);
    expect(p.jackpotOut).toBe(0n);
  });

  it("clamps pot and jpool to 0 when below their rent floors", () => {
    const p = previewSettle({
      contestLamports: 890_000n, contestRentFloor: 890_880n, // below floor
      jackpotLamports: 800_000n, jackpotRentFloor: JFLOOR,   // below floor
      entryCount: 0n, entryPrice: 0n, feeBps: 500, perfectCount: 0n,
    });
    expect(p.pot).toBe(0n);
    expect(p.jpool).toBe(0n);
    expect(p.rake).toBe(0n);
    expect(p.rolledOver).toBe(true);
    expect(p.jackpotOut).toBe(0n);
  });
});
