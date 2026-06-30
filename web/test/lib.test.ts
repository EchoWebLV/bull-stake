import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { impliedOdds, displayMultiplier } from "../src/lib/odds.ts";
import { deriveMarketPda, deriveVaultPda, derivePositionPda, deriveJackpotPda, deriveContestPda, deriveEntryPda } from "../src/lib/pdas.ts";

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
