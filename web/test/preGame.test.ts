import { describe, it, expect } from "vitest";
import { formatCountdown, preGameFromChain } from "../src/lib/liveGame.ts";
import type { NextGameResponse, LivePoolView, LiveEntryView } from "../src/lib/api.ts";

// ── formatCountdown ──────────────────────────────────────────────────────────
describe("formatCountdown", () => {
  it("formats under-24h as HH:MM:SS (zero-padded)", () => {
    expect(formatCountdown(2 * 3600_000 + 14 * 60_000 + 33_000)).toBe("02:14:33");
    expect(formatCountdown(5_000)).toBe("00:00:05");
    expect(formatCountdown(59 * 60_000)).toBe("00:59:00");
  });

  it("formats a day or more as Xd HHh", () => {
    expect(formatCountdown(86_400_000)).toBe("1d 00h");
    expect(formatCountdown(3 * 86_400_000 + 4 * 3600_000 + 1000)).toBe("3d 04h");
  });

  it("clamps at zero (never negative)", () => {
    expect(formatCountdown(-5_000)).toBe("00:00:00");
    expect(formatCountdown(0)).toBe("00:00:00");
  });
});

// ── preGameFromChain ─────────────────────────────────────────────────────────
const KICK = 1_750_000_000_000; // ms
const poolView: LivePoolView = {
  pubkey: "P", poolId: 9, fixtureId: 9,
  settleAuthority: "A", feeRecipient: "F", entryPrice: "35000000",
  lockTs: KICK / 1000, settleAfterTs: KICK / 1000 + 10_800, feeBps: 250,
  status: "open", numCalls: 8, playerCount: 4,
  winningScore: 0, winnerCount: 0, distributable: "0",
  claimedCount: 0, claimedTotal: "0", settledTs: 0,
};
const match = { fixtureId: 9, home: "Spain", away: "France", kickoffMs: KICK };
const entry: LiveEntryView = {
  pubkey: "E", player: "ME", pool: "P", amount: "35000000",
  basePts: 0, bonusPts: 0, total: 0, streak: 0, nextScoreSeq: 0,
  picks: Array(64).fill(null),
};
const base: NextGameResponse = {
  pool: null, openCall: null, lastCall: null, standings: [],
  match, kickoffMs: KICK, joinOpensTs: KICK / 1000 - 45 * 60,
};

describe("preGameFromChain", () => {
  it("upcoming fixture with no pool → 'upcoming' with a ticking countdown", () => {
    const pre = preGameFromChain(base, null, KICK - 2 * 3600_000)!;
    expect(pre.phase).toBe("upcoming");
    expect(pre.home).toBe("Spain");
    expect(pre.countdown).toBe("02:00:00");
    expect(pre.joined).toBe(false);
  });

  it("open pool before lock → 'joinable' with the real pot / players / entry", () => {
    const pre = preGameFromChain({ ...base, pool: poolView }, null, KICK - 20 * 60_000)!;
    expect(pre.phase).toBe("joinable");
    expect(pre.pot).toBe("◎0.14");   // 0.035 × 4
    expect(pre.players).toBe(4);
    expect(pre.entry).toBe("◎0.035");
    expect(pre.countdown).toBe("00:20:00");
    expect(pre.joined).toBe(false);
  });

  it("a held seat marks joined:true (the 'You're in' state)", () => {
    const pre = preGameFromChain({ ...base, pool: poolView }, entry, KICK - 60_000)!;
    expect(pre.joined).toBe(true);
  });

  it("post-kickoff pool (in-play) → null: the live game UI renders instead", () => {
    expect(preGameFromChain({ ...base, pool: poolView }, null, KICK + 60_000)).toBeNull();
  });

  it("terminal pool → null (over-card flow owns it)", () => {
    const settled = { ...poolView, status: "settled" as const };
    expect(preGameFromChain({ ...base, pool: settled }, null, KICK - 60_000)).toBeNull();
  });

  it("nothing scheduled (all nulls) → null (idle state renders)", () => {
    expect(preGameFromChain({ ...base, match: null, kickoffMs: null }, null, KICK)).toBeNull();
  });

  it("fixture already kicked off but no pool ever existed → null (not a countdown to the past)", () => {
    expect(preGameFromChain(base, null, KICK + 1)).toBeNull();
  });
});
