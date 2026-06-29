import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "../src/chain.ts";
import {
  deriveJackpotVaultPda, deriveContestPda, deriveEntryPda, computePot,
} from "../src/chain.ts";

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

const PROG = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("contest PDAs", () => {
  it("jackpot vault PDA is deterministic", () => {
    expect(deriveJackpotVaultPda(PROG).toBase58()).toBe(deriveJackpotVaultPda(PROG).toBase58());
  });
  it("contest PDA varies by contest id", () => {
    const a = deriveContestPda(PROG, 20269);
    const b = deriveContestPda(PROG, 20270);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
  it("entry PDA varies by nonce", () => {
    const contest = deriveContestPda(PROG, 20269);
    const bettor = PublicKey.default;
    expect(deriveEntryPda(PROG, contest, bettor, 0).toBase58())
      .not.toBe(deriveEntryPda(PROG, contest, bettor, 1).toBase58());
  });
});

describe("computePot", () => {
  it("nets out rent floor and reserved", () => {
    expect(computePot(1_000_000_000n, 2_000_000n, 300_000_000n)).toBe("698000000");
  });
  it("clamps to zero when liabilities exceed balance", () => {
    expect(computePot(1_000_000n, 2_000_000n, 0n)).toBe("0");
  });
});
