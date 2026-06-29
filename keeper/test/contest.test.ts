import { describe, it, expect } from "vitest";
import { computeContestParams, countPerfect } from "../contest.js";

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
