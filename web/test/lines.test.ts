import { describe, it, expect } from "vitest";
import { mapSlateRow, mapLineDetail, estWinLamports, LINE_STAKE_PRESETS } from "../src/lib/lines.ts";
import type { LineDto } from "../src/lib/api.ts";

const NOW = 1_800_000_000_000;
function dto(over: Partial<LineDto> = {}): LineDto {
  return {
    fixtureId: 7, home: "Spain", away: "Austria", favName: "Spain", favSide: 1,
    kickoffMs: NOW + 3_600_000, marketPk: "Line111", status: "open",
    openMilli: 60000, current: { pctMilli: 61200, ts: NOW - 30_000 },
    potLamports: "100000000", bucketTotals: ["50000000", "50000000"],
    houseBoostLamports: 100000000, winningBucket: null,
    settledValueMilli: null, settledTs: null, ...over,
  };
}

describe("estWinLamports", () => {
  it("pre-bet preview includes your own stake in pot and side", () => {
    // pot 0.1, side 0.05, stake 0.01 → (0.11 * 0.01) / 0.06
    expect(estWinLamports(dto(), 0, 10_000_000n, null)).toBe(18_333_333n);
  });
  it("post-bet estimate uses your recorded stake against live totals", () => {
    // my 0.01 already inside side total 0.06, pot 0.11
    const d = dto({ bucketTotals: ["60000000", "50000000"], potLamports: "110000000" });
    expect(estWinLamports(d, 0, 0n, ["10000000", "0"])).toBe(18_333_333n);
  });
});

describe("mapSlateRow", () => {
  it("open line with odds → live pct, direction vs open, pot text", () => {
    const r = mapSlateRow(dto(), NOW);
    expect(r).toMatchObject({
      fixtureId: 7, title: "Spain v Austria", favName: "Spain",
      pctText: "61.2%", dirUp: true, status: "open", clickable: true,
    });
    expect(r.potText).toContain("0.1");
  });
  it("odds missing → honest dash, still clickable", () => {
    const r = mapSlateRow(dto({ current: null }), NOW);
    expect(r.pctText).toBe("—");
    expect(r.dirUp).toBeNull();
  });
  it("settled line summarises open → close and the winner", () => {
    const r = mapSlateRow(dto({
      status: "settled", winningBucket: 0, settledValueMilli: 61500, current: null,
    }), NOW);
    expect(r.status).toBe("settled");
    expect(r.resultText).toBe("opened 60.0% → closed 61.5% · Above won");
  });
});

describe("mapLineDetail", () => {
  const detail = { line: dto(), series: [[NOW - 120_000, 60000], [NOW - 60_000, 61200]] as [number, number][], myStakes: null };

  it("no position → both options biddable with est-win previews per preset", () => {
    const d = mapLineDetail(detail, NOW);
    expect(d.canBet).toBe(true);
    expect(d.options[0].label).toBe("Above");
    expect(d.options[1].label).toBe("Below");
    expect(d.deltaText).toBe("▲ +1.2 vs open");
    expect(d.presets).toEqual(LINE_STAKE_PRESETS);
  });
  it("with a position → verdict tracks the live line vs open", () => {
    const d = mapLineDetail({ ...detail, myStakes: ["10000000", "0"] }, NOW);
    expect(d.canBet).toBe(false);
    expect(d.verdict).toEqual({ tone: "win", text: "your Above is ahead ✓ · 61.2% vs 60.0% open" });
  });
  it("behind side → lose tone; voided → refund claim", () => {
    const behind = mapLineDetail({ ...detail, myStakes: ["0", "10000000"] }, NOW);
    expect(behind.verdict?.tone).toBe("lose");
    const voided = mapLineDetail({
      ...detail, line: dto({ status: "voided", current: null }), myStakes: ["0", "10000000"],
    }, NOW);
    expect(voided.claim).toEqual({ kind: "refund", amountLamports: 10_000_000n });
  });
  it("settled won → claim with pro-rata share; lost → no claim", () => {
    const won = mapLineDetail({
      ...detail,
      line: dto({ status: "settled", winningBucket: 0, settledValueMilli: 61500, current: null }),
      myStakes: ["10000000", "0"],
    }, NOW);
    // share = pot * my / sideTotal = 0.1 * 0.01 / 0.05
    expect(won.claim).toEqual({ kind: "won", amountLamports: 20_000_000n });
    const lost = mapLineDetail({
      ...detail,
      line: dto({ status: "settled", winningBucket: 1, settledValueMilli: 58000, current: null }),
      myStakes: ["10000000", "0"],
    }, NOW);
    expect(lost.claim).toBeNull();
  });
});
