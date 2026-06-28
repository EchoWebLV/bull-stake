import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "../src/chain.ts";

const PROGRAM = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("PDA derivation", () => {
  it("market PDA is deterministic for (fixtureId, marketId)", () => {
    const a = deriveMarketPda(PROGRAM, 17952170, 1);
    const b = deriveMarketPda(PROGRAM, 17952170, 1);
    expect(a.toBase58()).toBe(b.toBase58());
  });
  it("vault and position derive from the market pubkey", () => {
    const market = deriveMarketPda(PROGRAM, 17952170, 1);
    const vault = deriveVaultPda(PROGRAM, market);
    const bettor = new PublicKey("11111111111111111111111111111112");
    const pos = derivePositionPda(PROGRAM, market, bettor);
    expect(vault).toBeInstanceOf(PublicKey);
    expect(pos).toBeInstanceOf(PublicKey);
    expect(vault.toBase58()).not.toBe(pos.toBase58());
  });
});
