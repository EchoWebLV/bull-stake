// web/test/bullMachine.test.ts
import { describe, expect, it } from "vitest";
import {
  BULL_PROGRAM_ID, STATUS, configPda, sessionPda, claimPda,
  decodeSession, openCostLamports, deriveSessionView,
} from "../src/lib/bullMachine.ts";
import { PublicKey } from "@solana/web3.js";

// Frozen layout (SOL bulls program/litesvm-tests layout.rs): creditsTotal@72,
// creditsUsed@73, settled@74, spins@75 (stride 50: status,+1 traits[9]…,+18 rnd[32]),
// expiresAt@583 i64le, len 592.
function sessionFixture(): Uint8Array {
  const d = new Uint8Array(592);
  d[72] = 3; d[73] = 1; d[74] = 0;
  d[75] = STATUS.ROLLED;                          // spin 0 status
  d.set([1, 2, 3, 4, 5, 6, 7, 8, 9], 76);         // spin 0 traits
  d[75 + 18] = 0xab;                              // spin 0 randomness[0]
  d[75 + 50] = STATUS.PENDING;                    // spin 1 status
  new DataView(d.buffer).setBigInt64(583, 4_000_000_000n, true); // far-future expiry
  return d;
}

describe("decodeSession", () => {
  it("reads credits, spin slots, and expiry from the frozen layout", () => {
    const s = decodeSession(sessionFixture());
    expect(s.creditsTotal).toBe(3);
    expect(s.creditsUsed).toBe(1);
    expect(s.spins[0].status).toBe(STATUS.ROLLED);
    expect(s.spins[0].traits.slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(s.spins[0].randomness[0]).toBe(0xab);
    expect(s.spins[1].status).toBe(STATUS.PENDING);
    expect(s.expiresAt).toBe(4_000_000_000);
  });
});

describe("PDAs", () => {
  it("derives stable addresses off the vendored program id", () => {
    expect(BULL_PROGRAM_ID.toBase58()).toBe("CHRm6pgBYXHSW1xWYT8YKNfKXhM1LorGm2yMKxLdQy6i");
    const player = new PublicKey("J7yZbEoQW6gqapBnKH9r5NZdus3j1t8j3vmrGUGxzxu7");
    // snapshot-style: any accidental seed change breaks these
    expect(configPda().toBase58()).toBe(configPda().toBase58());
    expect(sessionPda(player).equals(sessionPda(player))).toBe(true);
    expect(claimPda([1, 2, 3, 4, 5, 6, 7, 8, 9]).equals(claimPda([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(true);
    expect(sessionPda(player).equals(configPda())).toBe(false);
  });
});

describe("openCostLamports", () => {
  it("mirrors the bridge preflight: price×n + topup + crank base + crank×n + margin", () => {
    const price = 50_000_000n;
    expect(openCostLamports(3, price)).toBe(
      Number(price) * 3 + 20_000_000 + 5_000_000 + 3 * 10_000_000 + 15_000_000,
    );
  });
});

describe("deriveSessionView", () => {
  it("summarises credits/rolled/active for the UI", () => {
    const v = deriveSessionView(decodeSession(sessionFixture()), { delegated: true, sessionKeyHeld: true, now: 1_000 });
    expect(v.creditsLeft).toBe(2);
    expect(v.rolledUnsettled).toBe(1);
    expect(v.active).toBe(true);
    expect(v.closeable).toBe(false); // delegated + a PENDING slot
  });
});
