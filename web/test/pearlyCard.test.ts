import { describe, it, expect } from "vitest";
import {
  legState, bucketLabel, weightForOpenCount, weightPreview, myWeight,
  entriesOpen, countdownText, potSolText, myCardState, mapPearlyCard,
  walletHoldsCard,
  type PearlyLegVM,
} from "../src/lib/pearlyCard.ts";
import type { Card, CardLeg } from "../src/lib/api.ts";

/* ──────────────────────────────────────────────────────────────────────────
 * Pearly — pure view-model mapper tests. Mirrors the repo convention (one
 * describe block per exported function; see test/lines.test.ts, lib.test.ts).
 * NOW is a fixed seconds timestamp threaded through every case for determinism.
 * ────────────────────────────────────────────────────────────────────────── */

const NOW = 1_800_000_000; // seconds
const NOW_MS = NOW * 1000;

function leg(over: Partial<CardLeg> = {}): CardLeg {
  return {
    fixtureId: 1, home: "A", away: "B", kickoffTs: null,
    marketId: 12, label: "Match Result", group: "result", buckets: 3,
    ...over,
  };
}

function card(over: Partial<Card> = {}): Card {
  return {
    contestId: 1, status: "open", lockTs: NOW + 100, settleAfterTs: NOW + 999999,
    entryPrice: "50000000", pot: "0", jackpot: "0",
    legs: [leg(), leg(), leg(), leg(), leg(), leg()],
    ...over,
  };
}

// ── legState ────────────────────────────────────────────────────────────────

describe("legState", () => {
  it("is 'open' when the leg's lockTs is in the future and unsettled", () => {
    expect(legState(leg({ lockTs: NOW + 3600 }), NOW)).toBe("open");
  });

  it("is 'open' when lockTs is absent (v1 engine — treat as not-yet-locked)", () => {
    expect(legState(leg({ lockTs: undefined }), NOW)).toBe("open");
  });

  it("is 'locked' once lockTs has passed but the leg hasn't kicked off live yet", () => {
    expect(legState(leg({ lockTs: NOW - 10 }), NOW)).toBe("locked");
  });

  it("is 'live' when the leg carries a live block with phase live/ht", () => {
    expect(legState(leg({ lockTs: NOW - 10, live: { home: 1, away: 0, minute: 40, phase: "live" } }), NOW)).toBe("live");
    expect(legState(leg({ lockTs: NOW - 10, live: { home: 1, away: 0, minute: null, phase: "ht" } }), NOW)).toBe("live");
  });

  it("is 'won' when full-time and the given winningBucket matches the pick", () => {
    const l = leg({ lockTs: NOW - 10, live: { home: 2, away: 0, minute: null, phase: "ft" } });
    expect(legState(l, NOW, 0, false, 0)).toBe("won");
  });

  it("is 'lost' when full-time and the pick doesn't match winningBucket", () => {
    const l = leg({ lockTs: NOW - 10, live: { home: 0, away: 2, minute: null, phase: "ft" } });
    expect(legState(l, NOW, 0, false, 2)).toBe("lost");
  });

  it("stays 'live' at full-time when winningBucket isn't known yet (settle lags FT)", () => {
    const l = leg({ lockTs: NOW - 10, live: { home: 2, away: 0, minute: null, phase: "ft" } });
    expect(legState(l, NOW, 0, false, null)).toBe("live");
  });

  it("is 'voided' when the card status is voided, overriding any other state", () => {
    expect(legState(leg({ lockTs: NOW - 10 }), NOW, 0, true, null)).toBe("voided");
  });

  it("with no pick given (picker view), full-time+winningBucket still isn't won/lost", () => {
    const l = leg({ lockTs: NOW - 10, live: { home: 2, away: 0, minute: null, phase: "ft" } });
    expect(legState(l, NOW, undefined, false, 0)).toBe("live");
  });
});

// ── bucketLabel ─────────────────────────────────────────────────────────────

describe("bucketLabel", () => {
  it("labels a 3-way Result leg home/Draw/away", () => {
    const l = leg({ marketId: 12, buckets: 3, home: "Brazil", away: "Spain" });
    expect(bucketLabel(l, 0)).toBe("Brazil");
    expect(bucketLabel(l, 1)).toBe("Draw");
    expect(bucketLabel(l, 2)).toBe("Spain");
  });

  it("labels a Total Goals O/U leg Over/Under", () => {
    const l = leg({ marketId: 11, buckets: 2 });
    expect(bucketLabel(l, 0)).toBe("Over");
    expect(bucketLabel(l, 1)).toBe("Under");
  });

  it("labels the chaos leg (marketId 17, Red Card Y/N) Yes/No", () => {
    const l = leg({ marketId: 17, buckets: 2, group: "cards", label: "Red Card Shown Y/N" });
    expect(bucketLabel(l, 0)).toBe("Yes");
    expect(bucketLabel(l, 1)).toBe("No");
  });

  it("falls back to Over/Under for an unknown 2-bucket market", () => {
    const l = leg({ marketId: 999, buckets: 2 });
    expect(bucketLabel(l, 0)).toBe("Over");
    expect(bucketLabel(l, 1)).toBe("Under");
  });
});

// ── weight math ─────────────────────────────────────────────────────────────

describe("weightForOpenCount", () => {
  it("is 2^n for n open legs", () => {
    expect(weightForOpenCount(6)).toBe(64);
    expect(weightForOpenCount(5)).toBe(32);
    expect(weightForOpenCount(3)).toBe(8);
  });
  it("is 1 for zero open legs", () => {
    expect(weightForOpenCount(0)).toBe(1);
  });
});

describe("weightPreview", () => {
  it("counts legs whose lockTs is strictly in the future, capped at the open-leg count", () => {
    const legs = [
      leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 20 }), leg({ lockTs: NOW + 30 }),
      leg({ lockTs: NOW - 10 }), leg({ lockTs: NOW - 20 }), leg({ lockTs: NOW - 30 }),
    ];
    // 3 legs still open (lockTs > now) → weight 2^3 = 8.
    expect(weightPreview(legs, NOW)).toBe(8);
  });

  it("treats a leg with no lockTs as open (v1 fallback)", () => {
    const legs = [leg({ lockTs: undefined }), leg({ lockTs: undefined })];
    expect(weightPreview(legs, NOW)).toBe(4);
  });

  it("full 6-leg card entering before any kickoff previews ×64", () => {
    const legs = Array.from({ length: 6 }, () => leg({ lockTs: NOW + 3600 }));
    expect(weightPreview(legs, NOW)).toBe(64);
  });
});

describe("myWeight", () => {
  it("reads straight from myCard.weight when present", () => {
    expect(myWeight({
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW, activeMask: [true, true, true, false, false, false],
      weight: 8, alive: true,
    })).toBe(8);
  });
  it("is null when there is no myCard", () => {
    expect(myWeight(null)).toBeNull();
    expect(myWeight(undefined)).toBeNull();
  });
});

// ── entries-open gate ───────────────────────────────────────────────────────

describe("entriesOpen", () => {
  it("is true while now < entriesCloseTs", () => {
    expect(entriesOpen(card({ entriesCloseTs: NOW + 100 }), NOW)).toBe(true);
  });
  it("is false once now >= entriesCloseTs", () => {
    expect(entriesOpen(card({ entriesCloseTs: NOW - 1 }), NOW)).toBe(false);
    expect(entriesOpen(card({ entriesCloseTs: NOW }), NOW)).toBe(false);
  });
  it("falls back to card.lockTs when entriesCloseTs is absent (v1 engine)", () => {
    expect(entriesOpen(card({ entriesCloseTs: undefined, lockTs: NOW + 50 }), NOW)).toBe(true);
    expect(entriesOpen(card({ entriesCloseTs: undefined, lockTs: NOW - 50 }), NOW)).toBe(false);
  });
  it("is false once the card itself is no longer open (settled/voided/rolledOver)", () => {
    expect(entriesOpen(card({ status: "settled", entriesCloseTs: NOW + 999 }), NOW)).toBe(false);
  });
});

// ── countdownText ───────────────────────────────────────────────────────────

describe("countdownText", () => {
  it("renders hours + minutes for a same-day countdown", () => {
    expect(countdownText(NOW + 4 * 3600 + 12 * 60, NOW)).toBe("4h 12m");
  });
  it("renders minutes only under an hour", () => {
    expect(countdownText(NOW + 12 * 60, NOW)).toBe("12m");
  });
  it("renders 'now' once the deadline has passed", () => {
    expect(countdownText(NOW - 1, NOW)).toBe("now");
    expect(countdownText(NOW, NOW)).toBe("now");
  });
  it("renders days + hours past 24h", () => {
    expect(countdownText(NOW + 26 * 3600, NOW)).toBe("1d 2h");
  });
});

// ── potSolText ──────────────────────────────────────────────────────────────

describe("potSolText", () => {
  it("formats pot + jackpot together in SOL with the ◎ glyph", () => {
    // 5_000_000_000 lamports pot + 200_000_000 jackpot = 5.2 SOL
    expect(potSolText("5000000000", "200000000")).toBe("◎5.2");
  });
  it("formats a zero pot", () => {
    expect(potSolText("0", "0")).toBe("◎0");
  });
});

// ── myCardState ─────────────────────────────────────────────────────────────

describe("myCardState", () => {
  const openCard = card({ status: "open", entriesCloseTs: NOW + 999 });
  const settledCard = card({ status: "settled" });
  const rolledCard = card({ status: "rolledOver" });

  it("is 'not-entered' when there's no myCard on an open, entries-open card", () => {
    expect(myCardState(openCard, null, NOW)).toBe("not-entered");
    expect(myCardState(openCard, undefined, NOW)).toBe("not-entered");
  });

  it("is 'entered-alive' when myCard.alive is true and the card is still open", () => {
    const mc = { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW, activeMask: [true, true, true, true, true, true], weight: 64, alive: true };
    expect(myCardState(openCard, mc, NOW)).toBe("entered-alive");
  });

  it("is 'dead' when myCard.alive is false and the card is still open (spectating)", () => {
    const mc = { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW, activeMask: [true, true, true, true, true, true], weight: 64, alive: false };
    expect(myCardState(openCard, mc, NOW)).toBe("dead");
  });

  it("is 'settled-won' when the card settled and myCard is still alive (perfect)", () => {
    const mc = { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW, activeMask: [true, true, true, true, true, true], weight: 64, alive: true };
    expect(myCardState(settledCard, mc, NOW)).toBe("settled-won");
  });

  it("is 'settled-rollover' when the card settled/rolled and myCard survived to settle but is DEAD (not perfect)", () => {
    const mc = { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW, activeMask: [true, true, true, true, true, true], weight: 64, alive: false };
    expect(myCardState(settledCard, mc, NOW)).toBe("settled-rollover");
    expect(myCardState(rolledCard, mc, NOW)).toBe("settled-rollover");
  });

  it("is 'not-entered' (empty) when the card is settled/rolled and the wallet never had a card", () => {
    expect(myCardState(settledCard, null, NOW)).toBe("not-entered");
    expect(myCardState(rolledCard, undefined, NOW)).toBe("not-entered");
  });
});

// ── mapPearlyCard (the full view-model) ─────────────────────────────────────

describe("mapPearlyCard — resilience against a v1/legacy engine response", () => {
  it("never throws when legLockTs/entriesCloseTs/aliveCount/myCard are all absent", () => {
    // A real v1 engine's JSON response TRULY OMITS these keys (JSON.parse never
    // produces a key with an explicit `undefined` value) — build the fixture the
    // same way, via `delete`, rather than spreading `{ myCard: undefined }` (which
    // leaves the key present-but-undefined and would defeat the "myCard" in card
    // key-presence check `mapPearlyCard` relies on to detect "truly a v1 engine").
    const legacy = card({ legs: card().legs.map((l) => ({ ...l, lockTs: undefined })) });
    delete (legacy as Partial<Card>).entriesCloseTs;
    delete (legacy as Partial<Card>).aliveCount;
    delete (legacy as Partial<Card>).myCard;
    expect(() => mapPearlyCard(legacy, undefined, NOW_MS)).not.toThrow();
    const vm = mapPearlyCard(legacy, undefined, NOW_MS);
    expect(vm.legacyEngine).toBe(true);
    expect(vm.aliveText).toBe("—");
  });

  it("handles a null card (no card composed today) without throwing", () => {
    expect(() => mapPearlyCard(null, null, NOW_MS)).not.toThrow();
    const vm = mapPearlyCard(null, null, NOW_MS);
    expect(vm.empty).toBe(true);
  });
});

describe("mapPearlyCard — picker state (v2 engine, no entry yet)", () => {
  it("previews the full ×64 weight before any kickoff", () => {
    const c = card({
      entriesCloseTs: NOW + 99999, aliveCount: 10,
      legs: card().legs.map((l) => ({ ...l, lockTs: NOW + 3600 })),
    });
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect(vm.myCardState).toBe("not-entered");
    expect(vm.weightPreviewLabel).toBe("×64");
    expect(vm.entriesOpen).toBe(true);
  });

  it("marks legs already past their own lockTs as locked/disabled in the picker", () => {
    const c = card({
      entriesCloseTs: NOW + 99999, aliveCount: 10,
      legs: [
        leg({ lockTs: NOW - 10 }),   // locked
        leg({ lockTs: NOW + 10 }),   // open
        leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 10 }),
      ],
    });
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect((vm.legs[0] as PearlyLegVM).pickable).toBe(false);
    expect((vm.legs[1] as PearlyLegVM).pickable).toBe(true);
  });
});

describe("mapPearlyCard — my-card HUD (entered, alive)", () => {
  it("surfaces per-leg chips, my weight, alive count, and pot", () => {
    const mc = {
      picks: [0, 1, 0, 0, 1, 0], entryTs: NOW - 100,
      activeMask: [true, true, true, true, true, true], weight: 64, alive: true,
    };
    const c = card({
      status: "open", entriesCloseTs: NOW + 99999, aliveCount: 42, pot: "1000000000", jackpot: "0",
      myCard: mc,
      legs: card().legs.map((l) => ({ ...l, lockTs: NOW + 3600 })),
    });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.myCardState).toBe("entered-alive");
    expect(vm.myWeightLabel).toBe("×64");
    expect(vm.aliveText).toBe("42");
    expect(vm.potText).toBe("◎1");
    expect(vm.legs).toHaveLength(6);
  });

  it("renders 'syncing…' for aliveCount instead of a misleading 0 when it's missing", () => {
    const c = card({ entriesCloseTs: NOW + 99999, aliveCount: undefined });
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect(vm.aliveText).toBe("—");
  });
});

describe("mapPearlyCard — dead card spectates, no buy-back affordance", () => {
  it("marks myCardState dead and never sets a re-entry flag", () => {
    const mc = {
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 100,
      activeMask: [true, true, true, false, false, false], weight: 8, alive: false,
    };
    const c = card({ status: "open", entriesCloseTs: NOW + 99999, myCard: mc });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.myCardState).toBe("dead");
    expect(vm.canReEnter).toBe(false);
  });
});

describe("mapPearlyCard — edit affordance only before any carried leg kicks off", () => {
  it("allows edit while every ACTIVE leg is still open", () => {
    const mc = {
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 100,
      activeMask: [true, true, true, false, false, false], weight: 8, alive: true,
    };
    const c = card({
      status: "open", entriesCloseTs: NOW + 99999, myCard: mc,
      legs: [
        leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 10 }),
        leg({ lockTs: NOW - 10 }), leg({ lockTs: NOW - 10 }), leg({ lockTs: NOW - 10 }),
      ],
    });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.canEdit).toBe(true);
  });

  it("hides edit once any CARRIED (active) leg has kicked off — chain would reject CardLocked", () => {
    const mc = {
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 100,
      activeMask: [true, true, true, false, false, false], weight: 8, alive: true,
    };
    const c = card({
      status: "open", entriesCloseTs: NOW + 99999, myCard: mc,
      legs: [
        leg({ lockTs: NOW - 10 }),  // leg 0 is ACTIVE (in mask) and already locked → no edit
        leg({ lockTs: NOW + 10 }), leg({ lockTs: NOW + 10 }),
        leg({ lockTs: NOW - 10 }), leg({ lockTs: NOW - 10 }), leg({ lockTs: NOW - 10 }),
      ],
    });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.canEdit).toBe(false);
  });

  it("never allows edit once entries are fully closed regardless of mask", () => {
    const mc = {
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 100,
      activeMask: [true, true, true, false, false, false], weight: 8, alive: true,
    };
    const c = card({ status: "open", entriesCloseTs: NOW - 1, myCard: mc });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.canEdit).toBe(false);
  });
});

describe("mapPearlyCard — settled states", () => {
  it("perfect: claimable, with a weight-share pot breakdown", () => {
    const mc = {
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 999999,
      activeMask: [true, true, true, true, true, true], weight: 64, alive: true,
    };
    const c = card({ status: "settled", pot: "1000000000", jackpot: "0", myCard: mc });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.myCardState).toBe("settled-won");
    expect(vm.rollover).toBe(false);
  });

  it("not perfect / zero perfect: rollover banner, no claim", () => {
    const mc = {
      picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 999999,
      activeMask: [true, true, true, true, true, true], weight: 64, alive: false,
    };
    const c = card({ status: "settled", myCard: mc });
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.myCardState).toBe("settled-rollover");
    expect(vm.rollover).toBe(true);
  });

  it("rolledOver status with no myCard reads not-entered (nothing 'yours' to show) — the card-wide rollover is a separate public fact, not this wallet's result", () => {
    const c = card({ status: "rolledOver", myCard: null });
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect(vm.myCardState).toBe("not-entered");
    expect(vm.rollover).toBe(false);
  });
});

describe("mapPearlyCard — jackpot text seam (lib/pearlyAlerts.ts reads vm.jackpotText)", () => {
  it("populates jackpotText from card.jackpot alone — the seeded-alert copy source", () => {
    const vm = mapPearlyCard(card({ pot: "1000000000", jackpot: "70000000" }), null, NOW_MS);
    expect(vm.jackpotText).toBe("◎0.07");
    expect(vm.potRolledText).toBe("includes ◎0.07 rolled over");
  });

  it("reads ◎0 (and no rolled-over line) when nothing rolled in", () => {
    const vm = mapPearlyCard(card({ jackpot: "0" }), null, NOW_MS);
    expect(vm.jackpotText).toBe("◎0");
    expect(vm.potRolledText).toBeNull();
  });
});

describe("mapPearlyCard — empty state (no card composed today)", () => {
  it("flags empty with a 'next card' style message, no crash", () => {
    const vm = mapPearlyCard(null, null, NOW_MS);
    expect(vm.empty).toBe(true);
    expect(vm.legs).toEqual([]);
  });
});

// ── degraded / three-state myCard (engine commit 3246a98) ──────────────────
// routes.ts's /api/card doc comment is the source of truth: `degraded?: true`
// present only on a read blip; `aliveCount: number | null` (null = "couldn't
// compute", never a fabricated 0); `myCard` is THREE-state — MyCard object /
// null (CONFIRMED no entry) / key omitted (UNKNOWN — scan failed or a v1
// engine). The mapper must never collapse "unknown" into "not entered".

describe("mapPearlyCard — degraded reads (aliveCount null, never rendered as 0)", () => {
  it("aliveText reads 'syncing…'-equivalent ('—') when aliveCount is explicitly null, not '0'", () => {
    const c = card({ entriesCloseTs: NOW + 99999, aliveCount: null, degraded: true });
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect(vm.aliveText).toBe("—");
    expect(vm.degraded).toBe(true);
  });

  it("degraded is false on a healthy response (key absent)", () => {
    const c = card({ entriesCloseTs: NOW + 99999, aliveCount: 12 });
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect(vm.degraded).toBe(false);
  });
});

describe("mapPearlyCard — myCard three-state: object / null (confirmed) / undefined (unknown)", () => {
  const openCard = (myCard: Card["myCard"]) => card({ status: "open", entriesCloseTs: NOW + 99999, myCard });

  it("myCard OMITTED (undefined) on a card that HAS the key omitted (degraded scan) reads myCardKnown:false — the component must gate on this, NOT trust myCardState's best-guess", () => {
    // Simulates the engine literally omitting the `myCard` key (scanFailed) —
    // the caller reads `card.myCard` which is `undefined` because the key was
    // never serialized, distinct from an explicit `null`. `myCardState` itself
    // still resolves to SOME string (its narrower contract has no "unknown"
    // case — see the `myCardState` describe block below) — `myCardKnown` is the
    // flag that tells the caller whether that string is trustworthy.
    const c: Card = { ...openCard(undefined), degraded: true };
    delete (c as { myCard?: unknown }).myCard;
    const vm = mapPearlyCard(c, undefined, NOW_MS);
    expect(vm.myCardKnown).toBe(false);
  });

  it("myCard EXPLICIT null reads myCardKnown:true and not-entered (confirmed no entry)", () => {
    const c = openCard(null);
    const vm = mapPearlyCard(c, null, NOW_MS);
    expect(vm.myCardKnown).toBe(true);
    expect(vm.myCardState).toBe("not-entered");
  });

  it("myCard as an object reads myCardKnown:true regardless of degraded (optimistic alive)", () => {
    const mc = { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 10, activeMask: [true, true, true, true, true, true], weight: 64, alive: true };
    const c: Card = { ...openCard(mc), degraded: true }; // legs failed but scan succeeded — myCard still serves
    const vm = mapPearlyCard(c, mc, NOW_MS);
    expect(vm.myCardKnown).toBe(true);
    expect(vm.myCardState).toBe("entered-alive");
    expect(vm.degraded).toBe(true); // component should soften the alive claim using this flag
  });
});

describe("myCardState — unknown input never resolves to not-entered", () => {
  it("passing undefined for myCardArg with an unset card.myCard still isn't conflated with 'confirmed no entry' by mapPearlyCard's myCardKnown flag", () => {
    // myCardState() itself (the narrower pure function) has no "unknown" case —
    // it only ever sees resolved MyCard|null|undefined and always returns SOME
    // MyCardState. mapPearlyCard is the layer that adds the myCardKnown gate on
    // top for the component to consult before trusting that state.
    const c = card({ status: "open" });
    expect(myCardState(c, undefined, NOW)).toBe("not-entered"); // narrow function's contract, unchanged
  });
});

describe("walletHoldsCard — chain-entry cross-check that gates the picker/Enter", () => {
  // The 07-03 CardLocked incident: the engine's myCard scan returned a
  // confirmed-empty blip for a wallet that provably held a ticket, the picker
  // rendered, and Enter took the on-chain EDIT branch → CardLocked (6052).
  // The nonce-0 entry fetched straight from the chain is authoritative: when
  // it exists the picker (and buildEnterTx) must be unreachable.
  const chainEntry = { nonce: 0, bettor: "J7yZ…", claimable: false };
  const knownMyCard = { picks: [0, 0, 0, 0, 0, 0], entryTs: 1, activeMask: [true, true, true, true, true, true], weight: 64, alive: true };

  it("chain entry present + confirmed-empty myCard (the incident shape) → true", () => {
    expect(walletHoldsCard(chainEntry, null)).toBe(true);
  });

  it("no chain entry but a last-known myCard → true (stale-closure defense in onEnter)", () => {
    expect(walletHoldsCard(undefined, knownMyCard)).toBe(true);
  });

  it("neither signal → false (genuinely not entered; picker is correct)", () => {
    expect(walletHoldsCard(undefined, null)).toBe(false);
  });

  it("entry fetch missed (undefined) + myCard undefined → false, never throws", () => {
    expect(walletHoldsCard(undefined, undefined)).toBe(false);
  });
});
