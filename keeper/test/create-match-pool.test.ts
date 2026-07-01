/**
 * Unit tests for create-match-pool.ts — the base-layer CLI that creates a live
 * match pool (`create_live_pool`) then preallocates its `num_calls` Call PDAs
 * (`prealloc_call` loop).
 *
 * HERMETIC by construction: importing create-match-pool.ts fires ZERO side
 * effects (the `main()` call is behind an `isMain` guard), and every test here
 * either exercises the PURE `buildCreateLiveArgs` (no I/O) or drives the loop
 * body against a hand-rolled Program.methods SPY — a plain object that records
 * the args/accounts each `.createLivePool(...)`/`.preallocCall(...)` chain sees
 * and resolves `.rpc()` WITHOUT any Connection/RPC/network. No devnet, no SOL,
 * no wallet load. A test that spent SOL or hit the network would be a FAILING
 * test; none here does.
 */

import { describe, it, expect, vi } from "vitest";
import anchorDefault from "@coral-xyz/anchor";
import {
  buildCreateLiveArgs,
  createMatchPool,
  MAX_CALLS,
  MAX_FEE_BPS,
  type CreateLiveArgs,
} from "../create-match-pool.js";
import { livePoolPda, liveCursorPda, callPda } from "../live-pda.js";

const { BN } = anchorDefault;

// A fixed clock + kickoff far in the future so the happy-path args validate.
const NOW = 1_800_000_000; // arbitrary seconds
const KICKOFF_MS = (NOW + 3600) * 1000; // +1h — lock_ts is comfortably in the future
const FIXTURE = 777020634;

const okOpts = { entryPriceLamports: 35_000_000, feeBps: 500, numCalls: 8, nowSec: NOW };

// ── buildCreateLiveArgs (pure, invariant-enforcing) ─────────────────────────

describe("buildCreateLiveArgs", () => {
  it("pool_id === fixture_id (one pool per fixture)", () => {
    const a = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, okOpts);
    expect(a.poolId).toBe(FIXTURE);
    expect(a.fixtureId).toBe(FIXTURE);
  });

  it("lock_ts = floor(kickoffMs/1000); settle_after_ts = lock_ts + bufferSecs", () => {
    const a = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, bufferSecs: 3 * 3600 });
    expect(a.lockTs).toBe(Math.floor(KICKOFF_MS / 1000));
    expect(a.settleAfterTs).toBe(a.lockTs + 3 * 3600);
  });

  it("defaults numCalls to 8 when unspecified", () => {
    const a = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, {
      entryPriceLamports: 35_000_000,
      feeBps: 500,
      nowSec: NOW,
    });
    expect(a.numCalls).toBe(8);
  });

  it("throws when pool_id/fixture_id is 0 (InvalidPoolId / InvalidFixtureId)", () => {
    expect(() => buildCreateLiveArgs(0, KICKOFF_MS, okOpts)).toThrow();
  });

  it("throws when entry_price is not > 0 (ZeroAmount)", () => {
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, entryPriceLamports: 0 })).toThrow();
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, entryPriceLamports: -1 })).toThrow();
  });

  it("throws when fee_bps > MAX_FEE_BPS (FeeTooHigh); accepts exactly MAX_FEE_BPS", () => {
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, feeBps: MAX_FEE_BPS + 1 })).toThrow();
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, feeBps: MAX_FEE_BPS })).not.toThrow();
  });

  it("throws when num_calls < 1 or > MAX_CALLS; accepts 1 and MAX_CALLS", () => {
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: 0 })).toThrow();
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: MAX_CALLS + 1 })).toThrow();
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: 1 })).not.toThrow();
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: MAX_CALLS })).not.toThrow();
  });

  it("throws when now >= lock_ts (EntryCloseInPast — pool already locked)", () => {
    const pastKickoff = (NOW - 1) * 1000;
    expect(() => buildCreateLiveArgs(FIXTURE, pastKickoff, okOpts)).toThrow();
  });

  it("throws when lock_ts >= settle_after_ts (bufferSecs must be positive)", () => {
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, bufferSecs: 0 })).toThrow();
    expect(() => buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, bufferSecs: -60 })).toThrow();
  });
});

// ── createMatchPool driver: createLivePool + prealloc loop (spy, no RPC) ─────

/**
 * A hand-rolled Program.methods spy. Each method returns a chainable builder
 * whose terminal `.rpc()` resolves a fake signature and records the call. No
 * Connection is ever touched.
 */
function makeProgramSpy() {
  const calls: {
    method: string;
    args: unknown[];
    accounts: Record<string, unknown>;
  }[] = [];
  let sigN = 0;
  const builder = (method: string, args: unknown[]) => {
    const rec = { method, args, accounts: {} as Record<string, unknown> };
    return {
      accountsStrict(accts: Record<string, unknown>) {
        rec.accounts = accts;
        return {
          rpc: vi.fn(async () => {
            calls.push(rec);
            return `sig-${method}-${sigN++}`;
          }),
        };
      },
    };
  };
  const program = {
    programId: undefined as unknown, // set by caller
    methods: {
      createLivePool: vi.fn((...args: unknown[]) => builder("createLivePool", args)),
      preallocCall: vi.fn((...args: unknown[]) => builder("preallocCall", args)),
    },
  };
  return { program, calls };
}

const keeper = livePoolPda(new BN(1)); // any PublicKey works as a stand-in signer key

describe("createMatchPool driver", () => {
  it("emits exactly one createLivePool with the 8 args in IDL order", async () => {
    const { program, calls } = makeProgramSpy();
    const args = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, okOpts);
    await createMatchPool(program as never, keeper, keeper, args);

    const create = calls.filter((c) => c.method === "createLivePool");
    expect(create).toHaveLength(1);
    const a = create[0].args;
    // Order: pool_id, fixture_id, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps, num_calls
    expect(a).toHaveLength(8);
    expect((a[0] as { toNumber(): number }).toNumber()).toBe(args.poolId);
    expect((a[1] as { toNumber(): number }).toNumber()).toBe(args.fixtureId);
    expect((a[2] as { toNumber(): number }).toNumber()).toBe(args.entryPriceLamports);
    expect((a[3] as { toNumber(): number }).toNumber()).toBe(args.lockTs);
    expect((a[4] as { toNumber(): number }).toNumber()).toBe(args.settleAfterTs);
    expect(a[5]).toBe(keeper); // fee_recipient
    expect(a[6]).toBe(args.feeBps); // plain number (u16)
    expect(a[7]).toBe(args.numCalls); // plain number (u32)
  });

  it("createLivePool accountsStrict = {keeper, pool, cursor, systemProgram} with correct PDAs", async () => {
    const { program, calls } = makeProgramSpy();
    const args = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, okOpts);
    await createMatchPool(program as never, keeper, keeper, args);

    const create = calls.find((c) => c.method === "createLivePool")!;
    const pool = livePoolPda(new BN(FIXTURE));
    expect((create.accounts.keeper as { toBase58(): string }).toBase58()).toBe(keeper.toBase58());
    expect((create.accounts.pool as { toBase58(): string }).toBase58()).toBe(pool.toBase58());
    expect((create.accounts.cursor as { toBase58(): string }).toBase58()).toBe(
      liveCursorPda(pool).toBase58(),
    );
    expect(create.accounts.systemProgram).toBeDefined();
  });

  it("prealloc loop emits exactly numCalls preallocCall calls with seq 0..n-1", async () => {
    const { program, calls } = makeProgramSpy();
    const args = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: 5 });
    await createMatchPool(program as never, keeper, keeper, args);

    const prealloc = calls.filter((c) => c.method === "preallocCall");
    expect(prealloc).toHaveLength(5);
    expect(prealloc.map((c) => c.args[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it("prealloc call PDAs use u32le seq (match callPda) and accountsStrict shape", async () => {
    const { program, calls } = makeProgramSpy();
    const args = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: 3 });
    await createMatchPool(program as never, keeper, keeper, args);

    const pool = livePoolPda(new BN(FIXTURE));
    const prealloc = calls.filter((c) => c.method === "preallocCall");
    prealloc.forEach((c, seq) => {
      expect((c.accounts.call as { toBase58(): string }).toBase58()).toBe(callPda(pool, seq).toBase58());
      expect((c.accounts.keeper as { toBase58(): string }).toBase58()).toBe(keeper.toBase58());
      expect((c.accounts.pool as { toBase58(): string }).toBase58()).toBe(pool.toBase58());
      expect(c.accounts.systemProgram).toBeDefined();
    });
  });

  it("createLivePool runs BEFORE the prealloc loop (pool must exist first)", async () => {
    const { program, calls } = makeProgramSpy();
    const args = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, { ...okOpts, numCalls: 2 });
    await createMatchPool(program as never, keeper, keeper, args);
    expect(calls[0].method).toBe("createLivePool");
    expect(calls.slice(1).every((c) => c.method === "preallocCall")).toBe(true);
  });

  it("--dry-run performs ZERO .rpc() (no createLivePool, no preallocCall)", async () => {
    const { program, calls } = makeProgramSpy();
    const args = buildCreateLiveArgs(FIXTURE, KICKOFF_MS, okOpts);
    await createMatchPool(program as never, keeper, keeper, args, { dryRun: true });
    expect(calls).toHaveLength(0);
  });
});
