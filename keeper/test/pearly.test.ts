/**
 * Unit tests for create-daily-pearly.ts — the keeper that composes + creates the
 * Daily Pearly (all-day, cross-fixture card with PER-LEG entry locks + a chaos
 * leg, `initialize_market` per leg, then `create_contest` with the trailing
 * `leg_lock_ts` arg).
 *
 * Mirrors keeper/test/create-daily-card.test.ts's HERMETIC Program-spy pattern:
 * importing create-daily-pearly.ts fires ZERO side effects (`main()` is behind an
 * `isMain` guard), and the driver is exercised against a hand-rolled Program spy
 * that records the args/accounts each `.initializeMarket(...)`/`.createContest(...)`
 * chain sees and resolves `.rpc()` WITHOUT any Connection/RPC/network.
 *
 * WHY the wire-arg test is picky about arg count/order: create_contest now
 * serializes a TRAILING [i64;6] `leg_lock_ts` array (the per-leg-lock feature) in
 * addition to the original 9 args — under-counting or mis-ordering it
 * under-serializes silently, the same bug class every other wire-arg test in this
 * repo guards against.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { createDailyPearly } from "../create-daily-pearly.js";
import type { PearlyCard, Fixture } from "../../engine/src/allocator.js";

const { PublicKey } = pkg;
const { BN } = anchorDefault;

type PublicKeyT = InstanceType<typeof PublicKey>;
type BNLike = { toString(): string; toNumber(): number };

// ── independent PDA derivations (from the program's seed spec, NOT the module) ──

function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }

const PROGRAM_ID = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

const contestPda = (contestId: number): PublicKeyT =>
  PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(contestId)], PROGRAM_ID)[0];
const marketPda = (fixtureId: number, marketId: number): PublicKeyT =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])], PROGRAM_ID,
  )[0];
const vaultPda = (market: PublicKeyT): PublicKeyT =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], PROGRAM_ID)[0];

// Distinct deterministic stand-in signer/recipient keys (keeper !== feeRecipient
// so an arg-slot swap between them cannot pass the tests).
const KEEPER = PublicKey.findProgramAddressSync([Buffer.from("test-keeper")], PROGRAM_ID)[0];
const FEE_RECIPIENT = PublicKey.findProgramAddressSync([Buffer.from("test-fee-recipient")], PROGRAM_ID)[0];

// ── shared fixtures ───────────────────────────────────────────────────────────

const NOW = 1_900_000_000; // arbitrary seconds anchor
const CONTEST_ID = 777_020_640;

// 6-leg pearly card: 4 distinct fixtures carry Result (12), one carries Goals
// (11), and the marquee fixture (101) also carries the chaos leg (17) —
// mirrors the composer's real shape (one fixture can host >1 leg, e.g.
// Result + chaos on the top-ranked match).
const FIXTURES: Fixture[] = [101, 102, 103, 104].map((id, i) => ({
  fixtureId: id, home: `H${id}`, away: `A${id}`, kickoffTs: NOW + (i + 1) * 3_600,
}));
const CARD: PearlyCard = {
  legs: [
    { fixtureId: 101, marketId: 12, lockTs: NOW + 3_600 },
    { fixtureId: 102, marketId: 12, lockTs: NOW + 7_200 },
    { fixtureId: 103, marketId: 12, lockTs: NOW + 10_800 },
    { fixtureId: 104, marketId: 12, lockTs: NOW + 14_400 },
    { fixtureId: 101, marketId: 11, lockTs: NOW + 3_600 },
    { fixtureId: 101, marketId: 17, lockTs: NOW + 3_600 },
  ],
  lockTs: NOW + 3_600,
  entriesCloseTs: NOW + 10_800,
  settleAfterTs: NOW + 14_400 + 7_200,
};
const OK_OPTS = { entryPriceLamports: 50_000_000, feeBps: 0 }; // 0.05 SOL (spec §12 default), rake-free

// ── Program spy: records every method call + accounts; .rpc() never networks ──

interface SpyCall { method: string; args: unknown[]; accounts: Record<string, unknown>; }

function makeProgramSpy(opts: { contestExists?: boolean | "undecodable"; marketsExist?: boolean } = {}) {
  const calls: SpyCall[] = [];
  let sigN = 0;
  const builder = (method: string, args: unknown[]) => {
    const rec: SpyCall = { method, args, accounts: {} };
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
    programId: PROGRAM_ID,
    account: {
      contest: {
        fetchNullable: vi.fn(async () => {
          if (opts.contestExists === "undecodable") throw new Error("decode fail");
          return opts.contestExists ? {} : null;
        }),
      },
      market: {
        fetchNullable: vi.fn(async () => (opts.marketsExist ? {} : null)),
      },
    },
    methods: {
      initializeMarket: vi.fn((...args: unknown[]) => builder("initializeMarket", args)),
      createContest: vi.fn((...args: unknown[]) => builder("createContest", args)),
    },
  };
  return { program, calls };
}

const drive = (
  spy: ReturnType<typeof makeProgramSpy>,
  card: PearlyCard = CARD,
  opts: { entryPriceLamports: number; feeBps: number; dryRun?: boolean } = OK_OPTS,
) => createDailyPearly(spy.program as never, KEEPER, FEE_RECIPIENT, card, FIXTURES, CONTEST_ID, opts);

describe("createDailyPearly driver", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  const createContestCalls = (calls: SpyCall[]) => calls.filter((c) => c.method === "createContest");
  const initMarketCalls = (calls: SpyCall[]) => calls.filter((c) => c.method === "initializeMarket");

  it("passes per-leg locks (leg_lock_ts) as the trailing createContest arg and ensures the chaos market", async () => {
    const spy = makeProgramSpy();
    const res = await drive(spy);
    expect(res.action).toBe("created");

    // chaos market 17 got an initializeMarket call (fixture 101, market 17).
    const inits = initMarketCalls(spy.calls);
    expect(inits.some((c) => (c.args[0] as BNLike).toString() === "101" && c.args[1] === 17)).toBe(true);

    // createContest wire args: [id, fixtures, marketIds, numLegs, price, lock,
    // settleAfter, feeRecipient, feeBps, legLockTs] — 10 total.
    const args = createContestCalls(spy.calls)[0].args;
    expect(args).toHaveLength(10);

    const legLocks = (args[9] as BNLike[]).map((b) => b.toNumber());
    expect(legLocks).toEqual([
      NOW + 3_600, NOW + 7_200, NOW + 10_800, NOW + 14_400, NOW + 3_600, NOW + 3_600,
    ]);

    // settle_after_ts (slot 6) equals card.settleAfterTs.
    expect(BN.isBN(args[6])).toBe(true);
    expect((args[6] as BNLike).toNumber()).toBe(CARD.settleAfterTs);
  });

  it("R1 — thin slate (< 3 legs) skips: zero createContest/initializeMarket calls", async () => {
    const spy = makeProgramSpy();
    const thin: PearlyCard = { ...CARD, legs: CARD.legs.slice(0, 2) };
    const res = await drive(spy, thin);
    expect(res.action).toBe("skipped");
    if (res.action === "skipped") expect(res.reason).toMatch(/thin slate: 2 legs < 3/);
    expect(createContestCalls(spy.calls)).toHaveLength(0);
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();
  });

  it("R2 — duplicate (fixtureId, marketId) leg skips: zero createContest/initializeMarket calls", async () => {
    const spy = makeProgramSpy();
    const dup: PearlyCard = {
      ...CARD,
      legs: [...CARD.legs, { fixtureId: 101, marketId: 12, lockTs: NOW + 3_600 }], // repeats leg[0]
    };
    const res = await drive(spy, dup);
    expect(res.action).toBe("skipped");
    if (res.action === "skipped") expect(res.reason).toMatch(/duplicate leg 101:12/);
    expect(createContestCalls(spy.calls)).toHaveLength(0);
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();
  });
});
