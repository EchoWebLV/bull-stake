import { describe, it, expect } from "vitest";
import { buildTicketModel, pickSharePath, type TicketModel } from "../src/lib/pearlyTicket.ts";
import { mapPearlyCard } from "../src/lib/pearlyCard.ts";
import type { Card, CardLeg, MyCard } from "../src/lib/api.ts";

/* ──────────────────────────────────────────────────────────────────────────
 * Share-ticket model — pure-function tests (node env, zero DOM). Mirrors the
 * pearlyCard.test.ts fixture idiom. The canvas renderer (ticketCanvas.ts) is
 * deliberately untested here — it's DOM-only and verified via /ticket-dev.html.
 * ────────────────────────────────────────────────────────────────────────── */

const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000; // fixed instant — deterministic date label

function leg(over: Partial<CardLeg> = {}): CardLeg {
  return {
    fixtureId: 1, home: "France", away: "Spain", kickoffTs: null,
    marketId: 12, label: "Match Result", group: "result", buckets: 3,
    lockTs: NOW + 3600,
    ...over,
  };
}
function myCard(over: Partial<MyCard> = {}): MyCard {
  return { picks: [0, 1], entryTs: NOW - 100, activeMask: [true, true], weight: 4, alive: true, ...over } as MyCard;
}
function card(over: Partial<Card> = {}): Card {
  return {
    contestId: 777, status: "open", lockTs: NOW + 3600, settleAfterTs: NOW + 999999,
    entryPrice: "50000000", pot: "1900000000", jackpot: "70000000",
    legs: [leg(), leg({ marketId: 17, label: "Red Card Shown", buckets: 2 })],
    myCard: myCard(),
    ...over,
  };
}
const vmOf = (c: Card) => mapPearlyCard(c, c.myCard, NOW_MS);

describe("buildTicketModel", () => {
  it("returns null when the wallet holds no card", () => {
    expect(buildTicketModel(mapPearlyCard(card({ myCard: null }), null, NOW_MS), { nowMs: NOW_MS })).toBeNull();
    expect(buildTicketModel(mapPearlyCard(null, null, NOW_MS), { nowMs: NOW_MS })).toBeNull();
  });

  it("builds one row per leg with the picked option's label and the chaos flag", () => {
    const m = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toMatchObject({ market: "Match Result", pick: "France", chaos: false });
    expect(m.rows[1]).toMatchObject({ market: "Red Card Shown", pick: "No", chaos: true });
  });

  it("carries brand, multiplier, contest file name, and jackpot money lines", () => {
    const m = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    expect(m.brand).toBe("BULL STAKE");
    expect(m.multiplierLabel).toBe("×4");
    expect(m.fileName).toBe("bull-stake-card-777.png");
    expect(m.moneyLine).toContain("◎1.97");   // pot+jackpot via potText
    expect(m.moneyLine.toUpperCase()).toContain("JACKPOT");
    expect(m.subtitle).toContain("#777");
  });

  it("sets the tone per card state: riding / busted / perfect / rolled", () => {
    expect((buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel).tone).toBe("riding");
    const dead = card({ myCard: myCard({ alive: false }) });
    expect((buildTicketModel(vmOf(dead), { nowMs: NOW_MS }) as TicketModel).tone).toBe("busted");
    const won = card({ status: "settled", myCard: myCard() });
    expect((buildTicketModel(vmOf(won), { nowMs: NOW_MS }) as TicketModel).tone).toBe("perfect");
    const rolled = card({ status: "rolledOver", myCard: myCard({ alive: false }) });
    expect((buildTicketModel(vmOf(rolled), { nowMs: NOW_MS }) as TicketModel).tone).toBe("rolled");
  });

  it("single-match card reads the match name; multi-match reads the count", () => {
    const one = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    expect(one.matchLine).toBe("France v Spain");
    const multi = card({
      legs: [leg(), leg({ fixtureId: 2, home: "Norway", away: "England" })],
      myCard: myCard(),
    });
    expect((buildTicketModel(vmOf(multi), { nowMs: NOW_MS }) as TicketModel).matchLine).toBe("2 matches · 2 legs");
  });

  it("derives the mascot color deterministically from the wallet seed", () => {
    const a = buildTicketModel(vmOf(card()), { nowMs: NOW_MS, wallet: "walletA" }) as TicketModel;
    const b = buildTicketModel(vmOf(card()), { nowMs: NOW_MS, wallet: "walletA" }) as TicketModel;
    expect(a.mascotColor).toBe(b.mascotColor);
  });

  it("never emits banned jargon in any string", () => {
    const m = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    const all = JSON.stringify(m).toLowerCase();
    for (const banned of ["weight", "2^", "mask", "active legs"]) expect(all).not.toContain(banned);
  });
});

describe("pickSharePath", () => {
  it("prefers native file share, then clipboard, then download", () => {
    expect(pickSharePath({ canShareFiles: true, hasClipboardItem: true })).toBe("share");
    expect(pickSharePath({ canShareFiles: false, hasClipboardItem: true })).toBe("clipboard");
    expect(pickSharePath({ canShareFiles: false, hasClipboardItem: false })).toBe("download");
  });
});
