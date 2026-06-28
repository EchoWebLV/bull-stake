/**
 * Unit tests for the auth-cache decision layer.
 * No network calls — all I/O dependencies are stubbed.
 */
import { describe, it, expect } from "vitest";
import { shouldReuse } from "../src/auth-cache.js";

const WALLET_A = "11111111111111111111111111111112";
const WALLET_B = "So11111111111111111111111111111111111111112";
const NOW_MS = 1_700_000_000_000; // arbitrary fixed "now"
const FRESH_CREATED = NOW_MS - 1 * 86_400_000; // 1 day ago (well within 21d)
const STALE_CREATED = NOW_MS - 22 * 86_400_000; // 22 days ago (expired)

describe("shouldReuse", () => {
  it("returns true when cache is fresh and wallet matches", () => {
    expect(
      shouldReuse({ wallet: WALLET_A, jwt: "j", apiToken: "t", createdAt: FRESH_CREATED }, WALLET_A, NOW_MS),
    ).toBe(true);
  });

  it("returns false when cache is null (missing file)", () => {
    expect(shouldReuse(null, WALLET_A, NOW_MS)).toBe(false);
  });

  it("returns false when cache is stale (>21 days old)", () => {
    expect(
      shouldReuse({ wallet: WALLET_A, jwt: "j", apiToken: "t", createdAt: STALE_CREATED }, WALLET_A, NOW_MS),
    ).toBe(false);
  });

  it("returns false when wallet does not match", () => {
    expect(
      shouldReuse({ wallet: WALLET_B, jwt: "j", apiToken: "t", createdAt: FRESH_CREATED }, WALLET_A, NOW_MS),
    ).toBe(false);
  });

  it("returns false at exactly 21 days (boundary — not fresh)", () => {
    const exactBoundary = NOW_MS - 21 * 86_400_000;
    expect(
      shouldReuse({ wallet: WALLET_A, jwt: "j", apiToken: "t", createdAt: exactBoundary }, WALLET_A, NOW_MS),
    ).toBe(false);
  });

  it("returns true at one millisecond before 21 days", () => {
    const justInside = NOW_MS - 21 * 86_400_000 + 1;
    expect(
      shouldReuse({ wallet: WALLET_A, jwt: "j", apiToken: "t", createdAt: justInside }, WALLET_A, NOW_MS),
    ).toBe(true);
  });
});
