import { describe, it, expect } from "vitest";
import { Feed } from "../src/feed.ts";

const replay = {
  fixtureId: 1,
  home: "A",
  away: "B",
  frames: [
    { tMs: 0, minute: 0, phase: "NS", scoreH: 0, scoreA: 0, corners1: 0, corners2: 0 },
    { tMs: 100, minute: 45, phase: "H1", scoreH: 0, scoreA: 0, corners1: 3, corners2: 1 },
    { tMs: 200, minute: 90, phase: "F", scoreH: 1, scoreA: 0, corners1: 6, corners2: 4 },
  ],
};

describe("Feed", () => {
  it("returns the first frame at t=0", () => {
    const f = new Feed(replay, () => 1000);
    f.start(1000);
    expect(f.current().totalCorners).toBe(0);
    expect(f.current().phase).toBe("NS");
  });
  it("advances by elapsed wall-clock against frame tMs", () => {
    let now = 1000;
    const f = new Feed(replay, () => now);
    f.start(1000);
    now = 1000 + 150; // past frame[1] (tMs 100), before frame[2] (tMs 200)
    expect(f.current().totalCorners).toBe(4); // 3 + 1
    expect(f.current().phase).toBe("H1");
  });
  it("clamps to the final frame", () => {
    let now = 1000;
    const f = new Feed(replay, () => now);
    f.start(1000);
    now = 1000 + 9999;
    expect(f.current().totalCorners).toBe(10); // 6 + 4
    expect(f.current().phase).toBe("F");
    expect(f.current().isFinal).toBe(true);
  });
});
