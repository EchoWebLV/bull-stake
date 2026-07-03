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
 * WHY the wire-arg tests are this picky: create_contest serializes fixed-size
 * borsh arrays ([i64;6] fixtures, [u8;6] market_ids, [i64;6] leg_lock_ts) and
 * mixed BN/number scalars. Passing a BN where borsh expects a raw u8 (or an
 * unpadded array, or two swapped same-shaped slots) under-serializes SILENTLY —
 * so every one of the 10 slots is pinned by value AND JS type against the
 * DEPLOYED IDL (target/idl/proofbet.json), exactly like the daily-card tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import { createDailyPearly } from "../create-daily-pearly.js";
import type { PearlyCard, Fixture } from "../../engine/src/allocator.js";

const { PublicKey } = pkg;
const { BN } = anchorDefault;

type PublicKeyT = InstanceType<typeof PublicKey>;
type BNLike = { toString(): string; toNumber(): number };

// ── deployed IDL (the wire spec every arg assertion below is pinned to) ──────

interface IdlArg { name: string; type: unknown; }
interface IdlAccount { name: string; writable?: boolean; signer?: boolean; }
interface IdlInstruction { name: string; args: IdlArg[]; accounts: IdlAccount[]; }

const IDL = JSON.parse(
  readFileSync(new URL("../../target/idl/proofbet.json", import.meta.url), "utf8"),
) as { address: string; instructions: IdlInstruction[] };

const CREATE_CONTEST = IDL.instructions.find((i) => i.name === "create_contest")!;
const PROGRAM_ID = new PublicKey(IDL.address);
/** Fixed leg-array length straight from the deployed IDL ([i64;6] / [u8;6] / [i64;6]). */
const IDL_LEGS = (CREATE_CONTEST.args[1].type as { array: [string, number] }).array[1];

// ── independent PDA derivations (from the program's seed spec, NOT the module) ──

function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }

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

// ── deployed-IDL spec pin ─────────────────────────────────────────────────────

describe("deployed IDL — create_contest wire spec (pearly)", () => {
  it("takes exactly these 10 args in this order", () => {
    expect(CREATE_CONTEST.args.map((a) => a.name)).toEqual([
      "contest_id", "fixtures", "market_ids", "num_legs", "entry_price",
      "lock_ts", "settle_after_ts", "fee_recipient", "fee_bps", "leg_lock_ts",
    ]);
  });

  it("arg types: u64 id, [i64;6] fixtures, [u8;6] market_ids, u8/u64/i64/i64/pubkey/u16, [i64;6] leg_lock_ts", () => {
    expect(CREATE_CONTEST.args.map((a) => a.type)).toEqual([
      "u64",
      { array: ["i64", 6] },
      { array: ["u8", 6] },
      "u8",
      "u64",
      "i64",
      "i64",
      "pubkey",
      "u16",
      { array: ["i64", 6] },
    ]);
  });

  it("accounts: keeper (writable signer), contest (writable), system_program", () => {
    expect(CREATE_CONTEST.accounts.map((a) => a.name)).toEqual(["keeper", "contest", "system_program"]);
    expect(CREATE_CONTEST.accounts[0].signer).toBe(true);
    expect(CREATE_CONTEST.accounts[0].writable).toBe(true);
    expect(CREATE_CONTEST.accounts[1].writable).toBe(true);
  });
});

// ── createDailyPearly driver (spy, no RPC) ────────────────────────────────────

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

  it("pins ALL 10 createContest wire slots (values + JS types), the accounts, and the chaos-market ensure", async () => {
    const spy = makeProgramSpy();
    const res = await drive(spy);
    expect(res.action).toBe("created");

    // ensure-markets: one initializeMarket per leg, ALL before createContest.
    expect(spy.calls.map((c) => c.method)).toEqual([
      ...Array(CARD.legs.length).fill("initializeMarket"), "createContest",
    ]);

    // chaos market 17 got an initializeMarket call (fixture 101, market 17) with
    // the exact wire shape: BN fixture, plain-number market id, keeper as
    // settle_authority, entry close at ITS fixture's kickoff, correct PDAs.
    const chaos = initMarketCalls(spy.calls).find((c) => c.args[1] === 17)!;
    expect(chaos).toBeDefined();
    expect(BN.isBN(chaos.args[0])).toBe(true);
    expect((chaos.args[0] as BNLike).toString()).toBe("101");
    expect(typeof chaos.args[1]).toBe("number"); // u8 — a BN here under-serializes
    const chaosInit = chaos.args[2] as { settleAuthority: PublicKeyT; entryCloseTs: BNLike; numBuckets: number };
    expect(chaosInit.settleAuthority.toBase58()).toBe(KEEPER.toBase58());
    expect(chaosInit.entryCloseTs.toString()).toBe(String(NOW + 3_600)); // fixture 101 kickoff
    expect(chaosInit.numBuckets).toBe(2); // Red Card Y/N
    const chaosMarket = marketPda(101, 17);
    expect((chaos.accounts.creator as PublicKeyT).toBase58()).toBe(KEEPER.toBase58());
    expect((chaos.accounts.market as PublicKeyT).toBase58()).toBe(chaosMarket.toBase58());
    expect((chaos.accounts.vault as PublicKeyT).toBase58()).toBe(vaultPda(chaosMarket).toBase58());
    expect(chaos.accounts.systemProgram).toBeDefined();

    // createContest wire args, arity bound to the DEPLOYED IDL (10):
    //   [id, fixtures, marketIds, numLegs, price, lock, settleAfter,
    //    feeRecipient, feeBps, legLockTs]
    const args = createContestCalls(spy.calls)[0].args;
    expect(args).toHaveLength(CREATE_CONTEST.args.length); // 10

    // [0] contest_id — BN u64
    expect(BN.isBN(args[0])).toBe(true);
    expect((args[0] as BNLike).toString()).toBe(String(CONTEST_ID));

    // [1] fixtures — BN[] full-array equality ([i64;6])
    const fixtures = args[1] as unknown[];
    expect(fixtures).toHaveLength(IDL_LEGS);
    expect(fixtures.every((f) => BN.isBN(f))).toBe(true);
    expect(fixtures.map((f) => (f as BNLike).toString())).toEqual([
      "101", "102", "103", "104", "101", "101",
    ]);

    // [2] market_ids — plain number[] (NOT BN: borsh [u8;6] wants raw bytes)
    const marketIds = args[2] as unknown[];
    expect(marketIds).toEqual([12, 12, 12, 12, 11, 17]);
    expect(marketIds).toHaveLength(IDL_LEGS);
    expect(marketIds.every((m) => typeof m === "number")).toBe(true);
    expect(marketIds.some((m) => BN.isBN(m))).toBe(false);

    // [3] num_legs — plain number u8
    expect(args[3]).toBe(6);
    expect(typeof args[3]).toBe("number");

    // [4] entry_price — BN u64
    expect(BN.isBN(args[4])).toBe(true);
    expect((args[4] as BNLike).toString()).toBe("50000000");

    // [5] lock_ts / [6] settle_after_ts — BN i64
    expect(BN.isBN(args[5])).toBe(true);
    expect((args[5] as BNLike).toNumber()).toBe(CARD.lockTs);
    expect(BN.isBN(args[6])).toBe(true);
    expect((args[6] as BNLike).toNumber()).toBe(CARD.settleAfterTs);

    // [7] fee_recipient — the feeRecipient pubkey, DISTINCT from the keeper
    // signer (a keeper/feeRecipient slot swap must fail here).
    expect((args[7] as PublicKeyT).toBase58()).toBe(FEE_RECIPIENT.toBase58());
    expect((args[7] as PublicKeyT).toBase58()).not.toBe(KEEPER.toBase58());

    // [8] fee_bps — plain number u16
    expect(args[8]).toBe(0);
    expect(typeof args[8]).toBe("number");

    // [9] leg_lock_ts — BN[] trailing per-leg locks ([i64;6])
    const legLocks = args[9] as unknown[];
    expect(legLocks).toHaveLength(IDL_LEGS);
    expect(legLocks.every((b) => BN.isBN(b))).toBe(true);
    expect((legLocks as BNLike[]).map((b) => b.toNumber())).toEqual([
      NOW + 3_600, NOW + 7_200, NOW + 10_800, NOW + 14_400, NOW + 3_600, NOW + 3_600,
    ]);

    // createContest accountsStrict = {keeper, contest PDA, systemProgram}
    const { accounts } = createContestCalls(spy.calls)[0];
    expect((accounts.keeper as PublicKeyT).toBase58()).toBe(KEEPER.toBase58());
    expect((accounts.contest as PublicKeyT).toBase58()).toBe(contestPda(CONTEST_ID).toBase58());
    expect(accounts.systemProgram).toBeDefined();
  });

  it("a 3-leg card zero-pads fixtures/marketIds/legLockTs to the IDL's fixed 6", async () => {
    const spy = makeProgramSpy();
    const three: PearlyCard = { ...CARD, legs: CARD.legs.slice(0, 3) };
    const res = await drive(spy, three);
    expect(res.action).toBe("created");
    const a = createContestCalls(spy.calls)[0].args;
    expect(a[3]).toBe(3); // num_legs — the real leg count, not the padded 6
    expect((a[1] as BNLike[]).map((f) => f.toString())).toEqual(["101", "102", "103", "0", "0", "0"]);
    expect(a[2]).toEqual([12, 12, 12, 0, 0, 0]);
    expect((a[9] as BNLike[]).map((b) => b.toNumber())).toEqual([
      NOW + 3_600, NOW + 7_200, NOW + 10_800, 0, 0, 0,
    ]);
  });

  // ── idempotency (spy contestExists / undecodable / marketsExist options) ──

  it("existing contest → exists, zero .rpc() (same-day re-run is a no-op)", async () => {
    const spy = makeProgramSpy({ contestExists: true });
    const res = await drive(spy);
    expect(res.action).toBe("exists");
    expect(spy.calls).toHaveLength(0);
  });

  it("undecodable contest PDA (fetch throws) → exists, zero .rpc()", async () => {
    // Live risk on this devnet: v1 Contest accounts decode to garbage under v2.
    const spy = makeProgramSpy({ contestExists: "undecodable" });
    const res = await drive(spy);
    expect(res.action).toBe("exists");
    expect(spy.calls).toHaveLength(0);
  });

  it("markets that already exist are skipped: zero initializeMarket, createContest still fires", async () => {
    const spy = makeProgramSpy({ marketsExist: true });
    const res = await drive(spy);
    expect(res.action).toBe("created");
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(createContestCalls(spy.calls)).toHaveLength(1);
  });

  // ── R1/R2/R3 create guards ─────────────────────────────────────────────────

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
      // 6 legs, but the last one repeats leg[0] — length is fine, content isn't.
      legs: [...CARD.legs.slice(0, 5), { fixtureId: 101, marketId: 12, lockTs: NOW + 3_600 }],
    };
    const res = await drive(spy, dup);
    expect(res.action).toBe("skipped");
    if (res.action === "skipped") expect(res.reason).toMatch(/duplicate leg 101:12/);
    expect(createContestCalls(spy.calls)).toHaveLength(0);
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();
  });

  it("R3 — more than MAX_LEGS legs skips loudly (NO silent truncation that would drop the chaos leg)", async () => {
    const spy = makeProgramSpy();
    const seven: PearlyCard = {
      ...CARD,
      // 7 DISTINCT legs — a composer bug: slicing to 6 would silently drop the
      // trailing leg, so the guard must refuse instead.
      legs: [...CARD.legs, { fixtureId: 104, marketId: 11, lockTs: NOW + 14_400 }],
    };
    const res = await drive(spy, seven);
    expect(res.action).toBe("skipped");
    if (res.action === "skipped") expect(res.reason).toMatch(/too many legs: 7 > 6/);
    expect(createContestCalls(spy.calls)).toHaveLength(0);
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();
  });

  it("dry-run on a guard-failing card surfaces the would-skip verdict, still sends nothing", async () => {
    // Thin card + dryRun: the operator sees the verdict a REAL run would reach
    // (cron uses the real path — a silent plausible dry-run is a footgun).
    const spy = makeProgramSpy();
    const thin: PearlyCard = { ...CARD, legs: CARD.legs.slice(0, 2) };
    const res = await drive(spy, thin, { ...OK_OPTS, dryRun: true });
    expect(res.action).toBe("dry-run");
    if (res.action === "dry-run") expect(res.wouldSkip).toMatch(/thin slate: 2 legs < 3/);
    expect(createContestCalls(spy.calls)).toHaveLength(0);
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();

    // A creatable card's dry-run carries NO would-skip verdict.
    const spy2 = makeProgramSpy();
    const ok = await drive(spy2, CARD, { ...OK_OPTS, dryRun: true });
    expect(ok.action).toBe("dry-run");
    if (ok.action === "dry-run") expect(ok.wouldSkip).toBeUndefined();
    expect(spy2.calls).toHaveLength(0);
  });
});
