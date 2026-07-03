import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { impliedOdds, displayMultiplier } from "../src/lib/odds.ts";
import { deriveMarketPda, deriveVaultPda, derivePositionPda, deriveJackpotPda, deriveContestPda, deriveEntryPda } from "../src/lib/pdas.ts";
import { legLiveStatus, fmtLiveScore, fmtLivePhase } from "../src/lib/liveStatus.ts";
import { legRowLabel, legSummary } from "../src/lib/cardLegs.ts";
import type { CardLeg, CardLegLive } from "../src/lib/api.ts";

const P = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("web odds", () => {
  it("matches the engine formula", () => {
    expect(impliedOdds([300n, 100n], 0, 0)).toBeCloseTo(1.3333, 3);
  });
});

describe("displayMultiplier — only the selected outcome reacts to stake", () => {
  // 1X2 pool: Brazil 0.30 / Draw 0.15 / Japan 0.10 (total 0.55).
  const totals = ["300000000", "150000000", "100000000"];
  const STAKE = 500_000_000; // 0.5 SOL
  // Live-market (stake-free) odds = total / side.
  const oddsBrazil = 1.8333, oddsDraw = 3.6667, oddsJapan = 5.5;

  it("an unselected outcome ignores the stake (stays at live-market odds)", () => {
    // Japan is selected; the Draw button must NOT move when stake is entered.
    expect(displayMultiplier(totals, 1, 2, STAKE, oddsDraw)).toBeCloseTo(oddsDraw, 3);
    expect(displayMultiplier(totals, 0, 2, STAKE, oddsBrazil)).toBeCloseTo(oddsBrazil, 3);
  });

  it("the selected outcome reflects the stake (its own side is diluted)", () => {
    // Staking 0.5 on Japan: (0.55+0.5)/(0.10+0.5) = 1.05/0.60 = 1.75.
    expect(displayMultiplier(totals, 2, 2, STAKE, oddsJapan)).toBeCloseTo(1.75, 2);
  });

  it("with nothing selected, every button shows live-market odds", () => {
    expect(displayMultiplier(totals, 2, null, STAKE, oddsJapan)).toBeCloseTo(oddsJapan, 3);
  });

  it("the selected outcome with zero stake shows live-market odds", () => {
    expect(displayMultiplier(totals, 2, 2, 0, oddsJapan)).toBeCloseTo(oddsJapan, 3);
  });
});
describe("web pdas", () => {
  it("derives market/vault/position", () => {
    const m = deriveMarketPda(P, 17952170, 1);
    const v = deriveVaultPda(P, m);
    const pos = derivePositionPda(P, m, PublicKey.default);
    expect(m).toBeInstanceOf(PublicKey);
    expect(v.toBase58()).not.toBe(pos.toBase58());
  });
});

describe("live status — Result 1X2 (3 buckets)", () => {
  const live = (h: number, a: number, phase: CardLegLive["phase"], minute: number | null = 55): CardLegLive =>
    ({ home: h, away: a, minute, phase });

  it("home pick leading → on track (green)", () => {
    expect(legLiveStatus(3, 0, live(2, 0, "live"))).toEqual({ tone: "good", label: "on track", final: false });
  });
  it("home pick behind → trailing (red)", () => {
    expect(legLiveStatus(3, 0, live(0, 1, "live"))).toEqual({ tone: "bad", label: "trailing", final: false });
  });
  it("home pick level → trailing (draw isn't a home lead)", () => {
    expect(legLiveStatus(3, 0, live(1, 1, "live")).tone).toBe("bad");
  });
  it("draw pick level → on track", () => {
    expect(legLiveStatus(3, 1, live(1, 1, "live"))).toEqual({ tone: "good", label: "on track", final: false });
  });
  it("away pick leading → on track", () => {
    expect(legLiveStatus(3, 2, live(0, 2, "live")).tone).toBe("good");
  });
  it("full-time resolves to hit / miss", () => {
    expect(legLiveStatus(3, 0, live(2, 1, "ft", null))).toEqual({ tone: "good", label: "hit", final: true });
    expect(legLiveStatus(3, 2, live(2, 1, "ft", null))).toEqual({ tone: "bad", label: "miss", final: true });
  });
});

describe("live status — Total Goals O/U 2.5 (2 buckets)", () => {
  const live = (h: number, a: number, phase: CardLegLive["phase"]): CardLegLive =>
    ({ home: h, away: a, minute: 70, phase });

  it("Over pick with 3 goals in → on track", () => {
    expect(legLiveStatus(2, 0, live(2, 1, "live"))).toEqual({ tone: "good", label: "on track", final: false });
  });
  it("Over pick with under 3 goals → at risk (amber)", () => {
    expect(legLiveStatus(2, 0, live(1, 1, "live"))).toEqual({ tone: "warn", label: "at risk", final: false });
  });
  it("Under pick still under → on track", () => {
    expect(legLiveStatus(2, 1, live(1, 1, "live")).tone).toBe("good");
  });
  it("Under pick already blown → at risk", () => {
    expect(legLiveStatus(2, 1, live(2, 1, "live")).tone).toBe("warn");
  });
  it("full-time resolves to hit / miss on the total", () => {
    expect(legLiveStatus(2, 0, live(2, 1, "ft"))).toEqual({ tone: "good", label: "hit", final: true }); // 3 > 2.5
    expect(legLiveStatus(2, 0, live(1, 1, "ft"))).toEqual({ tone: "bad", label: "miss", final: true });  // 2 < 2.5
  });
});

describe("live formatting", () => {
  it("score is home–away with an en-dash", () => {
    expect(fmtLiveScore({ home: 2, away: 1, minute: 60, phase: "live" })).toBe("2–1");
  });
  it("phase caption: minute when live, HT/FT otherwise", () => {
    expect(fmtLivePhase({ home: 0, away: 0, minute: 78, phase: "live" })).toBe("78'");
    expect(fmtLivePhase({ home: 0, away: 0, minute: null, phase: "ht" })).toBe("HT");
    expect(fmtLivePhase({ home: 1, away: 0, minute: null, phase: "ft" })).toBe("FT");
    expect(fmtLivePhase({ home: 0, away: 0, minute: null, phase: "pre" })).toBe("kickoff");
  });
});

describe("card leg summary + row labels", () => {
  const leg = (marketId: number, buckets: number): CardLeg =>
    ({ fixtureId: 1, home: "A", away: "B", kickoffTs: null, marketId, label: "", group: "", buckets });

  it("row label maps each marketId (with bucket fallback)", () => {
    expect(legRowLabel(leg(12, 3))).toBe("Result");
    expect(legRowLabel(leg(11, 2))).toBe("Goals O/U 2.5");
    expect(legRowLabel(leg(16, 3))).toBe("HT result");
    expect(legRowLabel(leg(15, 2))).toBe("HT goals O/U");
    expect(legRowLabel(leg(99, 2))).toBe("O/U");   // unknown → bucket fallback
    expect(legRowLabel(leg(99, 3))).toBe("Result");
  });

  it("summarizes a 3-winner + 3-goals card dynamically", () => {
    const legs = [leg(12, 3), leg(12, 3), leg(12, 3), leg(11, 2), leg(11, 2), leg(11, 2)];
    expect(legSummary(legs)).toBe("6 legs · 3 winners + 3 goals");
  });

  it("pluralizes winners and orders winner→goals", () => {
    expect(legSummary([leg(12, 3), leg(11, 2)])).toBe("2 legs · 1 winner + 1 goals");
  });

  it("includes HT markets when present", () => {
    const legs = [leg(12, 3), leg(16, 3), leg(11, 2), leg(15, 2)];
    expect(legSummary(legs)).toBe("4 legs · 1 winner + 1 HT result + 1 goals + 1 HT goals");
  });

  it("all-Result day reads N winners", () => {
    expect(legSummary([leg(12, 3), leg(12, 3), leg(12, 3), leg(12, 3), leg(12, 3), leg(12, 3)]))
      .toBe("6 legs · 6 winners");
  });

  it("unknown markets still count toward the leg total", () => {
    expect(legSummary([leg(99, 2), leg(12, 3)])).toBe("2 legs · 1 winner");
  });
});

describe("contest pdas", () => {
  it("derives jackpot/contest/entry and varies by id + nonce", () => {
    const jp = deriveJackpotPda(P);
    expect(jp).toBeInstanceOf(PublicKey);
    expect(jp.toBase58()).toBe(deriveJackpotPda(P).toBase58()); // stable
    expect(jp.toBase58()).not.toBe(deriveContestPda(P, 1).toBase58());
    const c1 = deriveContestPda(P, 20269);
    const c2 = deriveContestPda(P, 20270);
    const e0 = deriveEntryPda(P, c1, PublicKey.default, 0);
    const e1 = deriveEntryPda(P, c1, PublicKey.default, 1);
    expect(c1.toBase58()).not.toBe(c2.toBase58());
    expect(e0.toBase58()).not.toBe(e1.toBase58());
  });
});
