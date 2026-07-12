/**
 * schedule-pools tests — HERMETIC (no RPC, no TxLINE): the pure window selector +
 * the pass orchestrator through injected seams, plus the cron interval helper.
 */
import { describe, it, expect, vi } from "vitest";
import {
  selectPoolsToCreate,
  runSchedulePass,
  type SlateFixture,
} from "../schedule-pools.js";
import { scheduleIntervalMs } from "../cron.js";

const KICK = 1_750_000_000_000; // ms
const fx = (fixtureId: number, kickoffMs: number, competition = "World Cup"): SlateFixture => ({
  fixtureId, kickoffMs, competition,
});

describe("selectPoolsToCreate — the 45-min join-window filter (pure)", () => {
  it("selects a fixture inside [kickoff − 45min, kickoff) and skips the rest", () => {
    const now = KICK - 20 * 60_000; // T-20
    const picked = selectPoolsToCreate(
      [
        fx(1, KICK),                    // T-20 → inside the window
        fx(2, KICK + 3 * 3600_000),     // T-3h → too early
        fx(3, KICK - 30 * 60_000),      // kicked off 10 min ago → too late
      ],
      new Set(),
      now,
      45,
    );
    expect(picked.map((f) => f.fixtureId)).toEqual([1]);
  });

  it("boundary: exactly T-45 is IN, exactly kickoff is OUT", () => {
    expect(
      selectPoolsToCreate([fx(1, KICK)], new Set(), KICK - 45 * 60_000, 45).length,
    ).toBe(1);
    expect(selectPoolsToCreate([fx(1, KICK)], new Set(), KICK, 45).length).toBe(0);
  });

  it("skips fixtures that already have a pool and non-allowlisted competitions", () => {
    const now = KICK - 10 * 60_000;
    const picked = selectPoolsToCreate(
      [fx(1, KICK), fx(2, KICK, "Friendlies"), fx(3, KICK + 60_000)],
      new Set([3]), // 3 already pooled
      now,
      45,
      ["World Cup"],
    );
    expect(picked.map((f) => f.fixtureId)).toEqual([1]); // 2 wrong comp, 3 pooled
  });

  it("de-dupes a fixture that appears in both the today and tomorrow slate fetches", () => {
    // A kickoff near midnight UTC comes back from both getFixtures calls — the
    // wide (day) window surfaces both copies; the selector must keep just one.
    const now = KICK - 2 * 3600_000;
    const picked = selectPoolsToCreate(
      [fx(1, KICK), fx(1, KICK), fx(2, KICK + 60_000)],
      new Set(),
      now,
      1440,
    );
    expect(picked.map((f) => f.fixtureId)).toEqual([1, 2]);
  });

  it("orders overlapping fixtures earliest-kickoff first", () => {
    const now = KICK - 5 * 60_000;
    const picked = selectPoolsToCreate(
      [fx(2, KICK + 10 * 60_000), fx(1, KICK)],
      new Set(),
      now,
      45,
    );
    expect(picked.map((f) => f.fixtureId)).toEqual([1, 2]);
  });
});

describe("runSchedulePass — orchestration through injected seams", () => {
  const seams = (over: Partial<Parameters<typeof runSchedulePass>[0]> = {}) => ({
    fetchSlate: async () => [fx(1, KICK), fx(2, KICK + 60_000)],
    poolExists: vi.fn(async () => false),
    createPool: vi.fn(async () => {}),
    now: () => KICK - 10 * 60_000, // both fixtures inside the window
    log: vi.fn(),
    ...over,
  });

  it("creates a pool for every in-window fixture without one", async () => {
    const s = seams();
    const created = await runSchedulePass(s);
    expect(created).toEqual([1, 2]);
    expect(s.createPool).toHaveBeenCalledWith(1, KICK);
    expect(s.createPool).toHaveBeenCalledWith(2, KICK + 60_000);
  });

  it("is idempotent: an existing pool is skipped, no create issued", async () => {
    const s = seams({ poolExists: vi.fn(async (id: number) => id === 1) });
    const created = await runSchedulePass(s);
    expect(created).toEqual([2]);
    expect(s.createPool).toHaveBeenCalledTimes(1);
  });

  it("one fixture's create failure doesn't block the rest of the slate", async () => {
    const s = seams({
      createPool: vi.fn(async (id: number) => {
        if (id === 1) throw new Error("blockhash expired");
      }),
    });
    const created = await runSchedulePass(s);
    expect(created).toEqual([2]); // 1 failed, 2 still created
  });

  it("creates nothing when no fixture is inside the window", async () => {
    const s = seams({ now: () => KICK - 30 * 3600_000 }); // T-30h — beyond the 24h default window
    expect(await runSchedulePass(s)).toEqual([]);
    expect(s.createPool).not.toHaveBeenCalled();
  });

  it("a down slate fetch propagates (cron logs it; nothing is created blind)", async () => {
    const s = seams({ fetchSlate: async () => { throw new Error("txline down"); } });
    await expect(runSchedulePass(s)).rejects.toThrow("txline down");
  });
});

describe("scheduleIntervalMs — cron cadence helper (pure)", () => {
  it("defaults to 5 min and floors a bad value at 1s", () => {
    expect(scheduleIntervalMs({})).toBe(300_000);
    expect(scheduleIntervalMs({ SCHEDULE_INTERVAL_SEC: "60" })).toBe(60_000);
    expect(scheduleIntervalMs({ SCHEDULE_INTERVAL_SEC: "0" })).toBe(1_000);
    expect(scheduleIntervalMs({ SCHEDULE_INTERVAL_SEC: "junk" })).toBe(300_000);
  });
});
