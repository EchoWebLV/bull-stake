/**
 * Unit tests for the pure scheduling helpers in cron.ts.
 *
 * No child processes, no RPC, no Anchor — these cover only the wall-clock math
 * that decides WHEN the daily-create job fires (msUntilNextUtcHour) and the
 * per-UTC-day double-fire guard (isSameUtcDay). The settle pass itself is the
 * already-tested settle-contest.ts (this scheduler only spawns it), so there is
 * nothing new to test on the money path here.
 */

import { describe, it, expect, vi } from "vitest";
import { msUntilNextUtcHour, isSameUtcDay, liveIntervalMs, makeTickLive } from "../cron.js";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("msUntilNextUtcHour", () => {
  it("returns the gap to today's HH:00Z when we're before it", () => {
    // 06:00Z now, target 08:00Z → 2h.
    expect(msUntilNextUtcHour(at("2026-07-01T06:00:00Z"), 8)).toBe(2 * HOUR_MS);
  });

  it("rolls to TOMORROW's HH:00Z when we're past it", () => {
    // 09:00Z now, target 08:00Z → 23h (tomorrow).
    expect(msUntilNextUtcHour(at("2026-07-01T09:00:00Z"), 8)).toBe(23 * HOUR_MS);
  });

  it("never returns 0 at the exact boundary (rolls a full day forward)", () => {
    // exactly 08:00:00Z, target 08:00Z → full day, not 0 (prevents a misfire spin).
    expect(msUntilNextUtcHour(at("2026-07-01T08:00:00Z"), 8)).toBe(DAY_MS);
  });

  it("accounts for minutes/seconds within the hour", () => {
    // 07:30:00Z → 08:00Z is 30 min.
    expect(msUntilNextUtcHour(at("2026-07-01T07:30:00Z"), 8)).toBe(30 * 60_000);
  });

  it("is always in (0, DAY_MS] for any time of day", () => {
    const base = at("2026-07-01T00:00:00Z");
    for (let m = 0; m < 24 * 60; m += 37) {
      const v = msUntilNextUtcHour(base + m * 60_000, 8);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(DAY_MS);
    }
  });

  it("uses UTC, not local time (crosses the UTC midnight correctly)", () => {
    // 23:00Z, target 00:00Z → 1h into the next UTC day.
    expect(msUntilNextUtcHour(at("2026-07-01T23:00:00Z"), 0)).toBe(1 * HOUR_MS);
  });
});

describe("isSameUtcDay", () => {
  it("true for two instants in the same UTC day", () => {
    expect(isSameUtcDay(at("2026-07-01T08:00:00Z"), at("2026-07-01T23:59:59Z"))).toBe(true);
  });

  it("false across the UTC midnight boundary", () => {
    expect(isSameUtcDay(at("2026-07-01T23:59:59Z"), at("2026-07-02T00:00:00Z"))).toBe(false);
  });

  it("true at the exact same instant", () => {
    const t = at("2026-07-01T12:00:00Z");
    expect(isSameUtcDay(t, t)).toBe(true);
  });

  it("guards a double-fire: a second create the same UTC day is suppressed", () => {
    // first fire 08:00Z, a drifted tick at 08:10Z is the same day → skip.
    const first = at("2026-07-01T08:00:00Z");
    const drift = at("2026-07-01T08:10:00Z");
    expect(isSameUtcDay(drift, first)).toBe(true); // → scheduler skips
  });

  it("allows the next day's create (different UTC day)", () => {
    const yesterday = at("2026-07-01T08:00:00Z");
    const today = at("2026-07-02T08:00:00Z");
    expect(isSameUtcDay(today, yesterday)).toBe(false); // → scheduler fires
  });
});

// ── S3-T8: fast live job — pure interval + per-pool in-flight guard ───────────

describe("liveIntervalMs", () => {
  it("defaults to 30s when LIVE_INTERVAL_SEC is unset", () => {
    expect(liveIntervalMs({})).toBe(30 * 1000);
  });

  it("reads LIVE_INTERVAL_SEC (seconds → ms)", () => {
    expect(liveIntervalMs({ LIVE_INTERVAL_SEC: "45" })).toBe(45 * 1000);
  });

  it("floors at 1s (never 0, so a misfire can't spin)", () => {
    expect(liveIntervalMs({ LIVE_INTERVAL_SEC: "0" })).toBe(1 * 1000);
    expect(liveIntervalMs({ LIVE_INTERVAL_SEC: "-5" })).toBe(1 * 1000);
  });

  it("ignores non-numeric values (falls back to the 30s default)", () => {
    expect(liveIntervalMs({ LIVE_INTERVAL_SEC: "abc" })).toBe(30 * 1000);
  });

  it("is INDEPENDENT of SETTLE_INTERVAL_MIN (different env key, different unit)", () => {
    // A settle-interval env must not influence the live interval at all.
    expect(liveIntervalMs({ SETTLE_INTERVAL_MIN: "10" })).toBe(30 * 1000);
    // And the derived settle interval (minutes) is a different magnitude entirely.
    expect(liveIntervalMs({ LIVE_INTERVAL_SEC: "30" })).not.toBe(10 * MINUTE_MS);
  });
});

describe("makeTickLive — per-pool in-flight guard", () => {
  const POOL_A = "AAAApool";
  const POOL_B = "BBBBpool";

  it("runs runLiveMatch for each discovered Open/Ended pool", async () => {
    const inFlight = new Set<string>();
    const run = vi.fn().mockResolvedValue(undefined);
    const discover = vi.fn().mockResolvedValue([POOL_A, POOL_B]);
    const tickLive = makeTickLive({ inFlight, discover, run });

    await tickLive();

    expect(discover).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    const ran = run.mock.calls.map((c) => c[0]);
    expect(ran).toContain(POOL_A);
    expect(ran).toContain(POOL_B);
  });

  it("skips a pool already in-flight (per-pool guard)", async () => {
    const inFlight = new Set<string>([POOL_A]); // A is mid-run from a prior tick
    const run = vi.fn().mockResolvedValue(undefined);
    const discover = vi.fn().mockResolvedValue([POOL_A, POOL_B]);
    const tickLive = makeTickLive({ inFlight, discover, run });

    await tickLive();

    // Only B runs — A is guarded.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(POOL_B);
  });

  it("marks a pool in-flight for the duration of its run then clears it", async () => {
    const inFlight = new Set<string>();
    let inFlightDuringRun = false;
    const run = vi.fn().mockImplementation(async (pool: string) => {
      inFlightDuringRun = inFlight.has(pool);
    });
    const discover = vi.fn().mockResolvedValue([POOL_A]);
    const tickLive = makeTickLive({ inFlight, discover, run });

    await tickLive();

    expect(inFlightDuringRun).toBe(true); // guarded while running
    expect(inFlight.has(POOL_A)).toBe(false); // cleared after
  });

  it("clears the guard in `finally` even when a run throws", async () => {
    const inFlight = new Set<string>();
    const run = vi.fn().mockRejectedValue(new Error("ER exploded mid-match"));
    const discover = vi.fn().mockResolvedValue([POOL_A]);
    const tickLive = makeTickLive({ inFlight, discover, run });

    // A throwing run must NOT reject the tick (a bad pool can't kill the loop)…
    await expect(tickLive()).resolves.toBeUndefined();
    // …and MUST leave the guard clear so the next tick can retry the pool.
    expect(inFlight.has(POOL_A)).toBe(false);
  });

  it("does not run a pool twice concurrently across overlapping ticks", async () => {
    const inFlight = new Set<string>();
    let resolveRun: (() => void) | undefined;
    const run = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolveRun = () => r(); }),
    );
    const discover = vi.fn().mockResolvedValue([POOL_A]);
    const tickLive = makeTickLive({ inFlight, discover, run });

    const first = tickLive();      // starts A, leaves it in-flight (run pending)
    await Promise.resolve();       // let the first tick reach the pending run
    await tickLive();              // overlapping tick: A is guarded → no 2nd run

    expect(run).toHaveBeenCalledTimes(1);
    resolveRun?.();
    await first;
    expect(inFlight.has(POOL_A)).toBe(false);
  });

  it("a discover failure does not reject the tick (loop survives)", async () => {
    const inFlight = new Set<string>();
    const run = vi.fn();
    const discover = vi.fn().mockRejectedValue(new Error("RPC down"));
    const tickLive = makeTickLive({ inFlight, discover, run });

    await expect(tickLive()).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });
});
