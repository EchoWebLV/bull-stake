import { describe, it, expect } from "vitest";
import { snapshotForAlerts, diffCardAlerts, type AlertSnapshot } from "../src/lib/pearlyAlerts.ts";
import type { PearlyCardVM, PearlyLegVM } from "../src/lib/pearlyCard.ts";

const legVM = (over: Partial<PearlyLegVM> = {}): PearlyLegVM => ({
  fixtureId: 100, matchLabel: "Brazil v Spain", marketLabel: "Match Result",
  kickoffText: "", state: "open", pickable: true,
  buckets: 3,
  options: [{ bucket: 0, label: "Brazil" }, { bucket: 1, label: "Draw" }, { bucket: 2, label: "Spain" }],
  myPick: 0, carried: true,
  ...over,
});

// Minimal VM stub — only the fields snapshotForAlerts reads matter to the differ.
const vm = (legs: PearlyLegVM[], over: Partial<PearlyCardVM> = {}): PearlyCardVM => ({
  empty: false, legacyEngine: false, contestId: 7, status: "open", legs,
  entriesOpen: true, entriesCloseText: "", nextLockText: "", weightPreviewLabel: "×64",
  myCardState: "entered-alive", myCardKnown: true, myWeightLabel: "×64",
  aliveText: "1", degraded: false, potText: "◎0.05", jackpotText: "◎0.07",
  potRolledText: null, canEdit: false, canReEnter: false, rollover: false,
  ...over,
});

const snap = (legs: PearlyLegVM[], over: Partial<PearlyCardVM> = {}): AlertSnapshot =>
  snapshotForAlerts(vm(legs, over))!;

describe("snapshotForAlerts", () => {
  it("is null for an empty/legacy card (nothing to alert on)", () => {
    expect(snapshotForAlerts(vm([], { empty: true, contestId: undefined }))).toBeNull();
  });
  it("captures contestId, status, myCardState and per-leg state for carried legs", () => {
    const s = snap([legVM(), legVM({ fixtureId: 200, carried: false })]);
    expect(s.contestId).toBe(7);
    expect(s.legs).toHaveLength(2);
    expect(s.legs[0].carried).toBe(true);
    expect(s.legs[1].carried).toBe(false);
  });
});

describe("diffCardAlerts", () => {
  it("emits nothing on the first snapshot (prev null) — no reload spam", () => {
    expect(diffCardAlerts(null, snap([legVM()]))).toEqual([]);
  });

  it("emits nothing when nothing changed", () => {
    const s = snap([legVM()]);
    expect(diffCardAlerts(s, s)).toEqual([]);
  });

  it("leg open → live ⇒ leg-live with the pick riding", () => {
    const a = diffCardAlerts(snap([legVM({ state: "open" })]), snap([legVM({ state: "live" })]));
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("leg-live");
    expect(a[0].id).toBe("7:leg-live:100:Match Result");
    expect(a[0].text).toContain("Brazil v Spain");
    expect(a[0].text).toContain("Brazil"); // the pick label rides along
  });

  it("leg live → won ⇒ leg-hit", () => {
    const a = diffCardAlerts(snap([legVM({ state: "live" })]), snap([legVM({ state: "won" })]));
    expect(a[0].kind).toBe("leg-hit");
  });

  it("won → live flap (degraded winningBuckets join) emits NOTHING — leg-live fires on real kickoffs only", () => {
    const a = diffCardAlerts(snap([legVM({ state: "won" })]), snap([legVM({ state: "live" })]));
    expect(a).toEqual([]);
  });

  it("carried leg live → lost ⇒ leg-died (card busted)", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "live" })]),
      snap([legVM({ state: "lost" })], { myCardState: "dead" }),
    );
    expect(a[0].kind).toBe("leg-died");
    expect(a[0].text.toLowerCase()).toContain("busted");
  });

  it("a NOT-carried leg's transitions never alert (outcome can't touch this card)", () => {
    const a = diffCardAlerts(
      snap([legVM({ carried: false, state: "live" })]),
      snap([legVM({ carried: false, state: "lost" })]),
    );
    expect(a).toEqual([]);
  });

  it("all-but-one carried leg won while alive ⇒ one-away (once — id is stable)", () => {
    const prev = snap([legVM({ state: "won" }), legVM({ fixtureId: 101, state: "live" }), legVM({ fixtureId: 102, state: "live" })]);
    const next = snap([legVM({ state: "won" }), legVM({ fixtureId: 101, state: "won" }), legVM({ fixtureId: 102, state: "live" })]);
    const a = diffCardAlerts(prev, next);
    expect(a.map((x) => x.kind)).toContain("one-away");
    expect(a.find((x) => x.kind === "one-away")!.id).toBe("7:one-away");
  });

  it("a won→lost settle correction never fires one-away (won count didn't RISE) — the corrected leg just dies", () => {
    // prevWon=2 (100,101); next: 101 corrected won→lost, 102 lands live→won ⇒
    // won=2 = carried-1, but prevWon<won is false → the guard holds. myCardState
    // stays entered-alive to simulate the alive flag lagging the correction —
    // isolating the prevWon guard as the thing suppressing the false one-away.
    const prev = snap([legVM({ state: "won" }), legVM({ fixtureId: 101, state: "won" }), legVM({ fixtureId: 102, state: "live" })]);
    const next = snap([legVM({ state: "won" }), legVM({ fixtureId: 101, state: "lost" }), legVM({ fixtureId: 102, state: "won" })]);
    const a = diffCardAlerts(prev, next);
    expect(a.map((x) => x.kind)).not.toContain("one-away");
    expect(a.map((x) => x.kind)).toContain("leg-died");
  });

  it("status open → rolledOver ⇒ settled alert with rollover copy", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "won" })]),
      snap([legVM({ state: "won" })], { status: "rolledOver", myCardState: "settled-rollover" }),
    );
    expect(a[0].kind).toBe("settled");
    expect(a[0].text).toContain("roll");
  });

  it("status open → settled with a surviving card ⇒ settled alert with claim copy", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "won" })]),
      snap([legVM({ state: "won" })], { status: "settled", myCardState: "settled-won" }),
    );
    expect(a[0].kind).toBe("settled");
    expect(a[0].text.toLowerCase()).toContain("claim");
  });

  it("status open → settled with a DEAD card ⇒ payout copy, never a false 'rolls over' (someone's card was perfect)", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "lost" })], { myCardState: "dead" }),
      snap([legVM({ state: "lost" })], { status: "settled", myCardState: "settled-rollover" }),
    );
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("settled");
    expect(a[0].text).toContain("perfect cards took today's pot");
    expect(a[0].text.toLowerCase()).not.toContain("roll");
  });

  it("status open → voided ⇒ refund copy — even a still-alive card gets NO claim copy on a void", () => {
    // On a voided card an alive myCard maps to "settled-won" (myCardState treats
    // voided as settled) — status-first branching is what keeps claim copy out.
    const a = diffCardAlerts(
      snap([legVM({ state: "live" })]),
      snap([legVM({ state: "voided" })], { status: "voided", myCardState: "settled-won" }),
    );
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("settled");
    expect(a[0].text.toLowerCase()).toContain("refund");
    expect(a[0].text.toLowerCase()).not.toContain("claim");
    expect(a[0].text.toLowerCase()).not.toContain("roll");
  });

  it("contest change ⇒ single seeded alert carrying the jackpot, nothing else", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "won" })], { status: "rolledOver" }),
      snap([legVM({ state: "open" })], { contestId: 8 }),
    );
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("seeded");
    expect(a[0].id).toBe("8:seeded");
    expect(a[0].text).toContain("◎0.07");
  });
});
