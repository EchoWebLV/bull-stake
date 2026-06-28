/**
 * Catalog unit tests — pure logic only; no network or chain calls.
 *
 * Covers:
 *   - inSlateWindow: the upcoming-fixture time-window predicate
 *   - fetchSlate: World Cup competition filter (mocked getFixtures)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inSlateWindow } from "../src/catalog.ts";

// ── inSlateWindow tests ───────────────────────────────────────────────────────

describe("inSlateWindow", () => {
  const NOW = 1_000_000_000_000; // arbitrary epoch ms
  const HOURS = 36;

  it("returns true for a fixture kicking off 1 hour from now", () => {
    expect(inSlateWindow(NOW + 1 * 3_600_000, NOW, HOURS)).toBe(true);
  });

  it("returns true for a fixture kicking off exactly hoursAhead ms from now", () => {
    expect(inSlateWindow(NOW + HOURS * 3_600_000, NOW, HOURS)).toBe(true);
  });

  it("returns false for a fixture that has already started (in the past)", () => {
    expect(inSlateWindow(NOW - 1, NOW, HOURS)).toBe(false);
  });

  it("returns false for a fixture kicking off exactly now (not strictly future)", () => {
    expect(inSlateWindow(NOW, NOW, HOURS)).toBe(false);
  });

  it("returns false for a fixture kicking off beyond the window", () => {
    expect(inSlateWindow(NOW + HOURS * 3_600_000 + 1, NOW, HOURS)).toBe(false);
  });

  it("works with a smaller window (e.g. 2 hours)", () => {
    expect(inSlateWindow(NOW + 1 * 3_600_000, NOW, 2)).toBe(true);
    expect(inSlateWindow(NOW + 3 * 3_600_000, NOW, 2)).toBe(false);
  });
});

// ── fetchSlate World Cup filter (mocked getFixtures) ─────────────────────────

// We mock the discover module so that getFixtures returns controllable data.
vi.mock("../../spike/src/discover.js", () => ({
  getFixtures: vi.fn(),
}));

// We also need to control Date.now() to make the window deterministic.
const FIXED_NOW = 1_750_000_000_000; // ~2025

describe("fetchSlate — World Cup filter", () => {
  let getFixturesMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    const mod = await import("../../spike/src/discover.js");
    getFixturesMock = mod.getFixtures as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeFixture(
    id: number,
    competition: string,
    competitionId: number,
    offsetMs: number,
  ) {
    return {
      FixtureId: id,
      Competition: competition,
      CompetitionId: competitionId,
      Participant1: "Home" + id,
      Participant2: "Away" + id,
      StartTime: FIXED_NOW + offsetMs,
    };
  }

  it("returns only World Cup fixtures within the window", async () => {
    const wcId = 99;
    getFixturesMock.mockResolvedValue([
      makeFixture(1, "World Cup", wcId, 1 * 3_600_000),   // 1h ahead → in window
      makeFixture(2, "Premier League", 1, 2 * 3_600_000), // wrong competition
      makeFixture(3, "World Cup", wcId, 40 * 3_600_000),  // 40h ahead → outside 36h window
      makeFixture(4, "World Cup", wcId, 20 * 3_600_000),  // 20h ahead → in window
    ]);

    // Build a minimal fake ctx + auth (fetchSlate passes them to getFixtures).
    const fakeCtx = { baseUrl: "http://fake" } as never;
    const fakeAuth = { jwt: "j", apiToken: "a" };

    const { fetchSlate } = await import("../src/catalog.ts");
    const slate = await fetchSlate(fakeCtx, fakeAuth, { hoursAhead: 36 });

    expect(slate.map((s) => s.fixtureId)).toEqual(expect.arrayContaining([1, 4]));
    expect(slate.map((s) => s.fixtureId)).not.toContain(2);
    expect(slate.map((s) => s.fixtureId)).not.toContain(3);
    expect(slate).toHaveLength(2);
  });

  it("maps fixture fields correctly", async () => {
    const wcId = 99;
    getFixturesMock.mockResolvedValue([
      makeFixture(42, "World Cup", wcId, 5 * 3_600_000),
    ]);

    const fakeCtx = { baseUrl: "http://fake" } as never;
    const fakeAuth = { jwt: "j", apiToken: "a" };

    const { fetchSlate } = await import("../src/catalog.ts");
    const slate = await fetchSlate(fakeCtx, fakeAuth, { hoursAhead: 36 });

    expect(slate).toHaveLength(1);
    const s = slate[0];
    expect(s.fixtureId).toBe(42);
    expect(s.home).toBe("Home42");
    expect(s.away).toBe("Away42");
    expect(s.kickoffMs).toBe(FIXED_NOW + 5 * 3_600_000);
    expect(s.competitionId).toBe(wcId);
  });

  it("deduplicates fixtures returned by both day pages", async () => {
    const wcId = 99;
    const fixture = makeFixture(7, "World Cup", wcId, 10 * 3_600_000);
    // Both calls return the same fixture.
    getFixturesMock.mockResolvedValue([fixture]);

    const fakeCtx = { baseUrl: "http://fake" } as never;
    const fakeAuth = { jwt: "j", apiToken: "a" };

    const { fetchSlate } = await import("../src/catalog.ts");
    const slate = await fetchSlate(fakeCtx, fakeAuth, { hoursAhead: 36 });

    // Should appear only once despite being returned twice.
    expect(slate.filter((s) => s.fixtureId === 7)).toHaveLength(1);
  });

  it("returns empty array when no WC fixtures are in the window", async () => {
    getFixturesMock.mockResolvedValue([
      makeFixture(10, "World Cup", 99, 50 * 3_600_000), // 50h → outside window
      makeFixture(11, "Serie A", 5, 1 * 3_600_000),
    ]);

    const fakeCtx = { baseUrl: "http://fake" } as never;
    const fakeAuth = { jwt: "j", apiToken: "a" };

    const { fetchSlate } = await import("../src/catalog.ts");
    const slate = await fetchSlate(fakeCtx, fakeAuth, { hoursAhead: 36 });

    expect(slate).toHaveLength(0);
  });
});
