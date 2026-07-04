/**
 * Unit tests for resolveFixturePhase — the settle-decision phase pick.
 *
 * No mocks, no RPC. Event shapes mirror real TxLINE devnet histories captured
 * 2026-07-04 while contest 777020637 was stuck: the feed appends post-match
 * StatusId 100 events AFTER the terminal phase, and can emit out-of-order
 * in-play codes after the terminal event (…PE→FPE→ET2→100,100). A naive
 * "latest event wins" pick resolves an unknown/in-play phase forever and the
 * contest never settles.
 */

import { describe, it, expect } from "vitest";
import { resolveFixturePhase, type ScoreEvent } from "../../spike/src/discover.js";
import { PHASE } from "../../spike/src/config.js";

const ev = (Seq: number, StatusId?: number | string): ScoreEvent => ({
  FixtureId: 1,
  Seq,
  ...(StatusId === undefined ? {} : { StatusId }),
});

describe("resolveFixturePhase", () => {
  it("F then trailing post-match 100s → F (the 07-04 stuck-settle regression)", () => {
    // fixture 18179549 shape: …H2 → F,F → 100,100 (+ a no-StatusId noise event)
    const events = [ev(3, PHASE.NS), ev(1024, PHASE.H2), ev(1035), ev(1036, PHASE.F), ev(1037, 100), ev(1038, 100)];
    expect(resolveFixturePhase(events)?.code).toBe(PHASE.F);
  });

  it("terminal FPE with out-of-order later ET2 and 100s → FPE (terminal is absorbing)", () => {
    // fixture 18176123 shape: …PE → FPE → ET2(!) → 100,100
    const events = [ev(1349, PHASE.PE), ev(1350, PHASE.FPE), ev(1351, PHASE.ET2), ev(1352, 100), ev(1353, 100)];
    expect(resolveFixturePhase(events)?.code).toBe(PHASE.FPE);
  });

  it("FET then trailing 100s → FET", () => {
    // fixture 18175918 shape: …ET2 → FET,FET → 100,100
    const events = [ev(1237, PHASE.ET2), ev(1240, PHASE.FET), ev(1241, 100), ev(1242, 100)];
    expect(resolveFixturePhase(events)?.code).toBe(PHASE.FET);
  });

  it("in-play history with a trailing unknown code → latest KNOWN in-play code", () => {
    const events = [ev(1, PHASE.NS), ev(50, PHASE.HT), ev(70, PHASE.H2), ev(80, 100)];
    expect(resolveFixturePhase(events)?.code).toBe(PHASE.H2);
  });

  it("abandoned with no finished event → the void code", () => {
    const events = [ev(10, PHASE.H1), ev(20, PHASE.A), ev(25, 100)];
    expect(resolveFixturePhase(events)?.code).toBe(PHASE.A);
  });

  it("finished beats a later void-ish coverage code (settle, don't refund)", () => {
    const events = [ev(100, PHASE.F), ev(110, PHASE.TXCS)];
    expect(resolveFixturePhase(events)?.code).toBe(PHASE.F);
  });

  it("multiple finished events → highest-Seq finished wins", () => {
    const events = [ev(1034, PHASE.F), ev(1036, PHASE.F)];
    const r = resolveFixturePhase(events);
    expect(r?.code).toBe(PHASE.F);
  });

  it("unknown codes only → null (caller must WAIT, never settle/void)", () => {
    const events = [ev(1, 100), ev(2, 100)];
    expect(resolveFixturePhase(events)).toBeNull();
  });

  it("no events → null", () => {
    expect(resolveFixturePhase([])).toBeNull();
  });
});
