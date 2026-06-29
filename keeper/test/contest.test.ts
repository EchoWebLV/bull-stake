import { describe, it, expect } from "vitest";
import { computeContestParams, countPerfect, previewSettle } from "../contest.js";

const DAY = 86_400_000;

describe("computeContestParams", () => {
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
  it("counts only entries matching every carded match", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 0] }, // perfect
      { picks: [0, 1, 2, 1, 1] }, // perfect (tail beyond numMatches ignored)
      { picks: [0, 1, 1, 0, 0] }, // wrong on match 3
      { picks: [2, 1, 2, 0, 0] }, // wrong on match 1
    ];
    expect(countPerfect(entries, winning, 3)).toBe(2);
  });
  it("returns 0 when nobody is perfect", () => {
    expect(countPerfect([{ picks: [1, 1, 1, 0, 0] }], winning, 3)).toBe(0);
  });
});

describe("previewSettle — mirrors settle_contest.rs", () => {
  // Vault holds 1_000_000; rent floor 890_880; reserved 0 → free pot 109_120.
  // 5 entries × 20_000 = 100_000 new stakes; 5% rake = 5_000.
  const base = {
    vaultLamports: 1_000_000n, rentFloor: 890_880n, reserved: 0n,
    entryCount: 5n, entryPrice: 20_000n, feeBps: 500,
  };

  it("winner case: pot − rake split among winners, dust stays free", () => {
    const p = previewSettle({ ...base, perfectCount: 2n });
    expect(p.potSnapshot).toBe(109_120n);
    expect(p.rake).toBe(5_000n);               // (5 × 20_000 × 500) / 10_000
    expect(p.distributable).toBe(104_120n);    // 109_120 − 5_000
    expect(p.share).toBe(52_060n);             // floor(104_120 / 2)
    expect(p.payable).toBe(104_120n);
    expect(p.dust).toBe(0n);
    expect(p.rolledOver).toBe(false);
  });

  it("dust: odd distributable across 3 winners leaves remainder free", () => {
    const p = previewSettle({ ...base, perfectCount: 3n });
    expect(p.distributable).toBe(104_120n);
    expect(p.share).toBe(34_706n);             // floor(104_120 / 3)
    expect(p.payable).toBe(104_118n);          // 34_706 × 3
    expect(p.dust).toBe(2n);                    // 104_120 − 104_118 rolls forward
  });

  it("rollover: perfectCount 0 → no winners, distributable 0, pot rolls forward", () => {
    const p = previewSettle({ ...base, perfectCount: 0n });
    expect(p.rolledOver).toBe(true);
    expect(p.rake).toBe(5_000n);               // rake still taken on new stakes
    expect(p.distributable).toBe(0n);
    expect(p.share).toBe(0n);
    expect(p.payable).toBe(0n);
  });

  it("reserved liabilities reduce the free pot", () => {
    const p = previewSettle({ ...base, reserved: 100_000n, perfectCount: 1n });
    expect(p.potSnapshot).toBe(9_120n);        // 109_120 − 100_000 reserved
  });

  it("rake is capped at the pot when fees exceed the free balance", () => {
    // Tiny pot but large nominal stakes → rake would exceed pot, so it's capped.
    const p = previewSettle({
      vaultLamports: 891_880n, rentFloor: 890_880n, reserved: 0n, // pot = 1_000
      entryCount: 100n, entryPrice: 20_000n, feeBps: 500, perfectCount: 1n,
    });
    expect(p.potSnapshot).toBe(1_000n);
    expect(p.rake).toBe(1_000n);               // min(100_000, 1_000)
    expect(p.distributable).toBe(0n);          // 1_000 − 1_000
  });

  it("clamps pot to 0 when the vault is below floor + reserved", () => {
    const p = previewSettle({
      vaultLamports: 890_000n, rentFloor: 890_880n, reserved: 0n, // below floor
      entryCount: 0n, entryPrice: 0n, feeBps: 500, perfectCount: 0n,
    });
    expect(p.potSnapshot).toBe(0n);
    expect(p.rake).toBe(0n);
  });
});
