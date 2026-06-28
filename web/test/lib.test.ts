import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { impliedOdds } from "../src/lib/odds.ts";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "../src/lib/pdas.ts";

const P = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("web odds", () => {
  it("matches the engine formula", () => {
    expect(impliedOdds([300n, 100n], 0, 0)).toBeCloseTo(1.3333, 3);
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
