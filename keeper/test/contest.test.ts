import { describe, it, expect } from "vitest";
import {
  computeContestParams,
  countPerfect,
  selectParlayMatches,
  parlayParams,
  previewSettle,
  type SlateMatch,
} from "../contest.js";

const DAY = 86_400_000;

describe("computeContestParams (v1 — left in place for create-contest.ts)", () => {
  it("orders fixtures by kickoff and derives lock/settle/contest id", () => {
    const r = computeContestParams([
      { fixtureId: 200, kickoffMs: 3 * DAY + 7_200_000 }, // later
      { fixtureId: 100, kickoffMs: 3 * DAY + 3_600_000 }, // earlier
    ], 3 * 3600);
    expect(r.orderedFixtures).toEqual([100, 200]);
    expect(r.numMatches).toBe(2);
    expect(r.lockTs).toBe(Math.floor((3 * DAY + 3_600_000) / 1000));
    expect(r.settleAfterTs).toBe(Math.floor((3 * DAY + 7_200_000) / 1000) + 3 * 3600);
    expect(r.contestId).toBe(3); // epoch day of the first kickoff
    expect(r.contestId).toBeGreaterThan(0);
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

describe("previewSettle (v2, jackpot-aware) — mirrors settle_contest.rs line-by-line", () => {
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

  it("winners, jpool=0: distributable == pot−rake, share == distributable/perfectCount, no jackpot movement", () => {
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR, perfectCount: 2n });
    expect(p.pot).toBe(109_120n);
    expect(p.rake).toBe(5_000n);             // (5 × 20_000 × 500) / 10_000
    expect(p.jpool).toBe(0n);
    expect(p.distributable).toBe(104_120n);  // pot − rake
    expect(p.share).toBe(52_060n);           // floor(104_120 / 2)
    expect(p.payable).toBe(104_120n);
    expect(p.dust).toBe(0n);
    expect(p.jackpotIn).toBe(0n);            // payable == potNet → no movement
    expect(p.jackpotOut).toBe(0n);
    expect(p.rolledOver).toBe(false);
  });

  it("rollover (perfectCount=0): distributable==0, jackpotOut==pot−rake, jackpotIn==0", () => {
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR + 500_000n, perfectCount: 0n });
    expect(p.rolledOver).toBe(true);
    expect(p.rake).toBe(5_000n);             // rake still taken on new stakes
    expect(p.distributable).toBe(0n);
    expect(p.share).toBe(0n);
    expect(p.payable).toBe(0n);
    expect(p.dust).toBe(0n);
    expect(p.jackpotIn).toBe(0n);
    expect(p.jackpotOut).toBe(104_120n);     // potNet swept contest → jackpot
  });

  it("scoop (jpool>0, single winner): distributable==(pot−rake)+jpool, jackpotIn==jpool, jackpot left at dust(==0)", () => {
    const jpool = 500_000n;
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR + jpool, perfectCount: 1n });
    expect(p.pot).toBe(109_120n);
    expect(p.rake).toBe(5_000n);
    expect(p.jpool).toBe(jpool);
    // raw = potNet(104_120) + jpool(500_000) = 604_120; 1 winner → share = raw, dust 0
    expect(p.distributable).toBe(604_120n);  // (pot − rake) + jpool
    expect(p.share).toBe(604_120n);
    expect(p.payable).toBe(604_120n);
    expect(p.dust).toBe(0n);                  // divides evenly with 1 winner
    expect(p.jackpotIn).toBe(jpool);         // whole pool pulled into contest
    expect(p.jackpotOut).toBe(0n);
    expect(p.rolledOver).toBe(false);
  });

  it("dust case: payable==share*perfectCount, dust==raw−payable (stays in jackpot)", () => {
    // jpool=0, 3 winners on potNet 104_120 → share floor(104_120/3)=34_706,
    // payable 104_118, dust 2.
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR, perfectCount: 3n });
    expect(p.jpool).toBe(0n);
    const raw = p.pot - p.rake + p.jpool; // 104_120
    expect(p.share).toBe(34_706n);           // floor(104_120 / 3)
    expect(p.payable).toBe(34_706n * 3n);    // 104_118
    expect(p.payable).toBe(p.share * 3n);
    expect(p.dust).toBe(raw - p.payable);    // 2
    expect(p.dust).toBe(2n);
    expect(p.distributable).toBe(p.payable);
    // payable(104_118) < potNet(104_120) → contest → jackpot (signed-delta DOWN)
    expect(p.jackpotIn).toBe(0n);
    expect(p.jackpotOut).toBe(2n);           // potNet − payable == dust − jpool
  });

  it("signed-delta UP (jackpot → contest): payable > potNet pulls lamports IN", () => {
    // jpool large, 3 winners. raw = 104_120 + 1_000_000 = 1_104_120.
    // share = floor(1_104_120 / 3) = 368_040; payable = 1_104_120; dust = 0.
    const jpool = 1_000_000n;
    const p = previewSettle({ ...base, jackpotLamports: JFLOOR + jpool, perfectCount: 3n });
    expect(p.jpool).toBe(jpool);
    const raw = p.pot - p.rake + jpool; // 1_104_120
    expect(p.share).toBe(raw / 3n);          // 368_040
    expect(p.payable).toBe(p.share * 3n);    // 1_104_120
    expect(p.dust).toBe(raw - p.payable);    // 0
    expect(p.distributable).toBe(p.payable);
    const potNet = p.pot - p.rake;           // 104_120
    expect(p.payable).toBeGreaterThan(potNet);
    expect(p.jackpotIn).toBe(p.payable - potNet); // jackpot → contest
    expect(p.jackpotOut).toBe(0n);
  });

  it("signed-delta DOWN edge (dust > jpool): small pot, many winners, tiny jpool", () => {
    // potNet small, perfectCount large, jpool tiny → payable < potNet, dust > jpool.
    // pot = 100; rake on stakes (entryCount 0 → rake 0) so potNet = 100.
    // jpool = 1. raw = 101. perfectCount = 7 → share = floor(101/7)=14,
    // payable = 98, dust = 3 (> jpool 1).
    const p = previewSettle({
      contestLamports: 890_880n + 100n, // pot = 100
      contestRentFloor: 890_880n,
      jackpotLamports: JFLOOR + 1n,     // jpool = 1
      jackpotRentFloor: JFLOOR,
      entryCount: 0n,
      entryPrice: 0n,
      feeBps: 500,
      perfectCount: 7n,
    });
    expect(p.pot).toBe(100n);
    expect(p.rake).toBe(0n);
    expect(p.jpool).toBe(1n);
    const raw = 101n;
    expect(p.share).toBe(raw / 7n);          // 14
    expect(p.payable).toBe(14n * 7n);        // 98
    expect(p.dust).toBe(raw - p.payable);    // 3
    expect(p.dust).toBeGreaterThan(p.jpool); // dust(3) > jpool(1)
    const potNet = 100n;
    expect(p.payable).toBeLessThan(potNet);
    expect(p.jackpotOut).toBe(potNet - p.payable); // contest → jackpot == 2
    expect(p.jackpotOut).toBe(2n);
    expect(p.jackpotIn).toBe(0n);
    // conservation: jackpot ends with jpool + jackpotOut == dust
    expect(p.jpool + p.jackpotOut).toBe(p.dust);
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
    // potNet 0, jpool 0, 1 winner → distributable 0
    expect(p.distributable).toBe(0n);
    expect(p.share).toBe(0n);
    expect(p.dust).toBe(0n);
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
