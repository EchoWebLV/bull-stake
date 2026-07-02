/**
 * Unit tests for create-daily-card.ts — the keeper that composes + creates the
 * ONE daily 6-leg card (`initialize_market` per leg, then `create_contest`).
 *
 * HERMETIC by construction (the create-match-pool.test.ts pattern): importing
 * create-daily-card.ts fires ZERO side effects (`main()` is behind an `isMain`
 * guard), and every test either exercises a PURE export (dailyContestId,
 * poolImpliedProbs, parseArgs) or drives the exported `createDailyCard` driver
 * against a hand-rolled Program SPY — a plain object that records the
 * args/accounts each `.initializeMarket(...)`/`.createContest(...)` chain sees
 * and resolves `.rpc()` WITHOUT any Connection/RPC/network. No devnet, no SOL,
 * no wallet load.
 *
 * WHY the wire-arg tests are this picky: create_contest serializes fixed-size
 * borsh arrays ([i64;6] fixtures, [u8;6] market_ids) and mixed BN/number
 * scalars. Passing a BN where borsh expects a raw u8 (or an unpadded array)
 * under-serializes SILENTLY — the same bug class caught elsewhere in this repo —
 * so we assert the exact 9-arg order and the exact JS type of every slot
 * against the DEPLOYED IDL (target/idl/proofbet.json).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
import {
  createDailyCard,
  dailyContestId,
  poolImpliedProbs,
  parseArgs,
} from "../create-daily-card.js";
import type { Card, Fixture } from "../../engine/src/allocator.js";

const { PublicKey } = pkg;
const { BN } = anchorDefault;

type PublicKeyT = InstanceType<typeof PublicKey>;
type BNLike = { toString(): string };

// ── deployed IDL (the wire spec every arg assertion below is pinned to) ──────

interface IdlArg { name: string; type: unknown; }
interface IdlAccount { name: string; writable?: boolean; signer?: boolean; }
interface IdlInstruction { name: string; args: IdlArg[]; accounts: IdlAccount[]; }

const IDL = JSON.parse(
  readFileSync(new URL("../../target/idl/proofbet.json", import.meta.url), "utf8"),
) as { address: string; instructions: IdlInstruction[] };

const CREATE_CONTEST = IDL.instructions.find((i) => i.name === "create_contest")!;
const PROGRAM_ID = new PublicKey(IDL.address);
/** Fixed leg-array length straight from the deployed IDL ([i64;6] / [u8;6]). */
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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000; // arbitrary seconds, same anchor as create-match-pool.test.ts

// Live demo day: epochDay 20_634 → the actually-deployed contest id 777_020_634.
const LIVE_EPOCH_DAY = 20_634;
const CONTEST_ID = 777_020_634;

// A 4-leg card over DEFAULT_MENU market ids (12=Result/3-way, 11=O/U 2.5,
// 16=1H Result, 15=1H O/U 0.5) — 4 legs so the pad-to-6 zero fill is visible.
const FIXTURES: Fixture[] = [
  { fixtureId: 20001, home: "AAA", away: "BBB", kickoffTs: NOW + 3_600 },
  { fixtureId: 20002, home: "CCC", away: "DDD", kickoffTs: NOW + 7_200 },
  { fixtureId: 20003, home: "EEE", away: "FFF", kickoffTs: NOW + 10_800 },
  { fixtureId: 20004, home: "GGG", away: "HHH", kickoffTs: NOW + 14_400 },
];
const CARD: Card = {
  legs: [
    { fixtureId: 20001, marketId: 12 },
    { fixtureId: 20002, marketId: 11 },
    { fixtureId: 20003, marketId: 16 },
    { fixtureId: 20004, marketId: 15 },
  ],
  lockTs: NOW + 3_600,
  settleAfterTs: NOW + 21_600,
};
const OK_OPTS = { entryPriceLamports: 20_000_000, feeBps: 0 }; // 0.02 SOL, rake-free (main()'s wiring)

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
  card: Card = CARD,
  opts: { entryPriceLamports: number; feeBps: number; dryRun?: boolean } = OK_OPTS,
) => createDailyCard(spy.program as never, KEEPER, FEE_RECIPIENT, card, FIXTURES, CONTEST_ID, opts);

// ── deployed-IDL spec pin ─────────────────────────────────────────────────────

describe("deployed IDL — create_contest wire spec", () => {
  it("takes exactly these 9 args in this order", () => {
    expect(CREATE_CONTEST.args.map((a) => a.name)).toEqual([
      "contest_id", "fixtures", "market_ids", "num_legs", "entry_price",
      "lock_ts", "settle_after_ts", "fee_recipient", "fee_bps",
    ]);
  });

  it("arg types: u64 id, [i64;6] fixtures, [u8;6] market_ids, u8/u64/i64/i64/pubkey/u16", () => {
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
    ]);
  });

  it("accounts: keeper (writable signer), contest (writable), system_program", () => {
    expect(CREATE_CONTEST.accounts.map((a) => a.name)).toEqual(["keeper", "contest", "system_program"]);
    expect(CREATE_CONTEST.accounts[0].signer).toBe(true);
    expect(CREATE_CONTEST.accounts[0].writable).toBe(true);
    expect(CREATE_CONTEST.accounts[1].writable).toBe(true);
  });
});

// ── dailyContestId (pure, deterministic) ──────────────────────────────────────

describe("dailyContestId", () => {
  it("epochDay 20_634 → the live demo contest id 777_020_634", () => {
    const { contestId, epochDay } = dailyContestId(LIVE_EPOCH_DAY * DAY_MS);
    expect(contestId).toBe(777_020_634);
    expect(epochDay).toBe(20_634);
  });

  it("every ms of the same UTC day maps to the SAME id (idempotent re-runs)", () => {
    const midnight = LIVE_EPOCH_DAY * DAY_MS;
    expect(dailyContestId(midnight).contestId).toBe(CONTEST_ID);
    expect(dailyContestId(midnight + 12 * 3_600_000).contestId).toBe(CONTEST_ID);
    expect(dailyContestId(midnight + DAY_MS - 1).contestId).toBe(CONTEST_ID);
  });

  it("rolls to the next id exactly at UTC midnight", () => {
    const midnight = LIVE_EPOCH_DAY * DAY_MS;
    expect(dailyContestId(midnight + DAY_MS).contestId).toBe(777_020_635);
  });

  it("is namespaced ≥ 777_000_000 so it can never collide with fixtureId-keyed parlays", () => {
    expect(dailyContestId(0).contestId).toBe(777_000_000);
    expect(dailyContestId(LIVE_EPOCH_DAY * DAY_MS).contestId).toBeGreaterThan(777_000_000);
  });
});

// ── poolImpliedProbs (pure) ───────────────────────────────────────────────────

describe("poolImpliedProbs", () => {
  it("returns null on zero liquidity (caller falls back to the neutral prior)", () => {
    expect(poolImpliedProbs([0n, 0n, 0n])).toBeNull();
    expect(poolImpliedProbs([])).toBeNull();
  });

  it("returns per-bucket money share summing to 1", () => {
    expect(poolImpliedProbs([60n, 30n, 10n])).toEqual([0.6, 0.3, 0.1]);
  });
});

// ── parseArgs (feeds the --dry-run path) ──────────────────────────────────────

describe("parseArgs", () => {
  it("bare --dry-run parses to the string 'true'", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ "dry-run": "true" });
  });

  it("--k=v flags parse to their values; non-flags are ignored", () => {
    expect(parseArgs(["--entry-price=0.05", "--window-hours=12", "positional"])).toEqual({
      "entry-price": "0.05",
      "window-hours": "12",
    });
  });
});

// ── createDailyCard driver (spy, no RPC) ──────────────────────────────────────

describe("createDailyCard driver", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  const createContestCalls = (calls: SpyCall[]) => calls.filter((c) => c.method === "createContest");
  const initMarketCalls = (calls: SpyCall[]) => calls.filter((c) => c.method === "initializeMarket");

  // (a) the 9 createContest args in deployed-IDL order with exact wire types

  it("emits exactly one createContest with the 9 args in deployed-IDL order", async () => {
    const spy = makeProgramSpy();
    const res = await drive(spy);
    expect(res.action).toBe("created");
    const create = createContestCalls(spy.calls);
    expect(create).toHaveLength(1);
    expect(create[0].args).toHaveLength(CREATE_CONTEST.args.length); // 9
  });

  it("u64/i64 slots (contest_id, entry_price, lock_ts, settle_after_ts) are BN with the right values", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const a = createContestCalls(spy.calls)[0].args;
    expect(BN.isBN(a[0])).toBe(true);
    expect((a[0] as BNLike).toString()).toBe(String(CONTEST_ID));
    expect(BN.isBN(a[4])).toBe(true);
    expect((a[4] as BNLike).toString()).toBe("20000000");
    expect(BN.isBN(a[5])).toBe(true);
    expect((a[5] as BNLike).toString()).toBe(String(CARD.lockTs));
    expect(BN.isBN(a[6])).toBe(true);
    expect((a[6] as BNLike).toString()).toBe(String(CARD.settleAfterTs));
  });

  // (b) pad()-to-6 fixed arrays

  it("fixtures arg is BN[] zero-padded to the IDL's fixed 6 ([i64;6])", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const fixtures = createContestCalls(spy.calls)[0].args[1] as unknown[];
    expect(fixtures).toHaveLength(IDL_LEGS);
    expect(fixtures.every((f) => BN.isBN(f))).toBe(true);
    expect(fixtures.map((f) => (f as BNLike).toString())).toEqual([
      "20001", "20002", "20003", "20004", "0", "0",
    ]);
  });

  it("market_ids arg is a plain number[] zero-padded to 6 — NOT BN[] (borsh [u8;6] wants raw bytes)", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const marketIds = createContestCalls(spy.calls)[0].args[2] as unknown[];
    expect(marketIds).toEqual([12, 11, 16, 15, 0, 0]);
    expect(marketIds).toHaveLength(IDL_LEGS);
    expect(marketIds.every((m) => typeof m === "number")).toBe(true);
    expect(marketIds.some((m) => BN.isBN(m))).toBe(false); // a BN here under-serializes silently
  });

  it("num_legs and fee_bps are plain JS numbers (u8/u16), never BN", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const a = createContestCalls(spy.calls)[0].args;
    expect(a[3]).toBe(4); // num_legs — the real leg count, not the padded 6
    expect(typeof a[3]).toBe("number");
    expect(a[8]).toBe(0); // fee_bps
    expect(typeof a[8]).toBe("number");
  });

  it("fee_recipient is the feeRecipient pubkey (slot 8 of 9), distinct from the keeper signer", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const a = createContestCalls(spy.calls)[0].args;
    expect((a[7] as PublicKeyT).toBase58()).toBe(FEE_RECIPIENT.toBase58());
    expect((a[7] as PublicKeyT).toBase58()).not.toBe(KEEPER.toBase58());
  });

  it("entry_price and fee_bps pass through unchanged (no hard-wiring inside the driver)", async () => {
    const spy = makeProgramSpy();
    await drive(spy, CARD, { entryPriceLamports: 35_000_000, feeBps: 250 });
    const a = createContestCalls(spy.calls)[0].args;
    expect((a[4] as BNLike).toString()).toBe("35000000");
    expect(a[8]).toBe(250);
  });

  it("createContest accountsStrict = {keeper, contest PDA, systemProgram}", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const { accounts } = createContestCalls(spy.calls)[0];
    expect((accounts.keeper as PublicKeyT).toBase58()).toBe(KEEPER.toBase58());
    expect((accounts.contest as PublicKeyT).toBase58()).toBe(contestPda(CONTEST_ID).toBase58());
    expect(accounts.systemProgram).toBeDefined();
  });

  // (d) the num_legs >= 3 gate

  it("gate: fewer than 3 legs → too-few-legs, ZERO chain reads and ZERO .rpc()", async () => {
    for (const legs of [0, 2]) {
      const spy = makeProgramSpy();
      const thin: Card = { ...CARD, legs: CARD.legs.slice(0, legs) };
      const res = await drive(spy, thin);
      expect(res).toEqual({ action: "too-few-legs", legs });
      expect(spy.calls).toHaveLength(0);
      expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
      expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();
      expect(spy.program.methods.initializeMarket).not.toHaveBeenCalled();
      expect(spy.program.methods.createContest).not.toHaveBeenCalled();
    }
  });

  it("gate boundary: exactly 3 legs creates, num_legs=3, arrays padded [x,x,x,0,0,0]", async () => {
    const spy = makeProgramSpy();
    const three: Card = { ...CARD, legs: CARD.legs.slice(0, 3) };
    const res = await drive(spy, three);
    expect(res.action).toBe("created");
    const a = createContestCalls(spy.calls)[0].args;
    expect(a[3]).toBe(3);
    expect((a[1] as BNLike[]).map((f) => f.toString())).toEqual(["20001", "20002", "20003", "0", "0", "0"]);
    expect(a[2]).toEqual([12, 11, 16, 0, 0, 0]);
  });

  it("a 6-leg card needs no padding: num_legs=6, all slots real", async () => {
    const spy = makeProgramSpy();
    const six: Card = {
      ...CARD,
      legs: [
        ...CARD.legs,
        { fixtureId: 20001, marketId: 11 },
        { fixtureId: 20002, marketId: 12 },
      ],
    };
    await drive(spy, six);
    const a = createContestCalls(spy.calls)[0].args;
    expect(a[3]).toBe(6);
    expect((a[1] as BNLike[]).map((f) => f.toString())).toEqual([
      "20001", "20002", "20003", "20004", "20001", "20002",
    ]);
    expect(a[2]).toEqual([12, 11, 16, 15, 11, 12]);
  });

  it("defensively truncates past MAX_LEGS: a 7-leg card sends num_legs=6 and only 6 slots", async () => {
    const spy = makeProgramSpy();
    const seven: Card = {
      ...CARD,
      legs: [
        ...CARD.legs,
        { fixtureId: 20001, marketId: 11 },
        { fixtureId: 20002, marketId: 12 },
        { fixtureId: 20003, marketId: 15 }, // 7th — must be dropped
      ],
    };
    await drive(spy, seven);
    const a = createContestCalls(spy.calls)[0].args;
    expect(a[3]).toBe(6);
    expect((a[1] as unknown[])).toHaveLength(IDL_LEGS);
    expect((a[2] as unknown[])).toHaveLength(IDL_LEGS);
  });

  // (e) dry-run

  it("dry-run performs ZERO .rpc() calls, zero account reads, zero method builds", async () => {
    const spy = makeProgramSpy();
    const res = await drive(spy, CARD, { ...OK_OPTS, dryRun: true });
    expect(res).toEqual({ action: "dry-run" });
    expect(spy.calls).toHaveLength(0);
    expect(spy.program.account.contest.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.account.market.fetchNullable).not.toHaveBeenCalled();
    expect(spy.program.methods.initializeMarket).not.toHaveBeenCalled();
    expect(spy.program.methods.createContest).not.toHaveBeenCalled();
  });

  // idempotency

  it("existing contest → exists, zero .rpc() (same-day re-run is a no-op)", async () => {
    const spy = makeProgramSpy({ contestExists: true });
    const res = await drive(spy);
    expect(res.action).toBe("exists");
    expect(spy.calls).toHaveLength(0);
  });

  it("undecodable contest PDA (fetch throws) → exists, zero .rpc()", async () => {
    const spy = makeProgramSpy({ contestExists: "undecodable" });
    const res = await drive(spy);
    expect(res.action).toBe("exists");
    expect(spy.calls).toHaveLength(0);
  });

  // ensure-markets loop

  it("absent markets: one initializeMarket per leg, ALL before createContest", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    expect(spy.calls.map((c) => c.method)).toEqual([
      "initializeMarket", "initializeMarket", "initializeMarket", "initializeMarket", "createContest",
    ]);
  });

  it("initializeMarket wire args: BN fixture_id, plain-number market_id, settle_authority=keeper, entry_close=fixture kickoff", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    const inits = initMarketCalls(spy.calls);
    expect(inits).toHaveLength(CARD.legs.length);
    inits.forEach((c, i) => {
      const leg = CARD.legs[i];
      expect(BN.isBN(c.args[0])).toBe(true);
      expect((c.args[0] as BNLike).toString()).toBe(String(leg.fixtureId));
      expect(c.args[1]).toBe(leg.marketId);
      expect(typeof c.args[1]).toBe("number"); // u8 — a BN here under-serializes
      const initArgs = c.args[2] as { settleAuthority: PublicKeyT; entryCloseTs: BNLike; numBuckets: number };
      // settle_contest binds result_market.settle_authority == contest.settle_authority
      expect(initArgs.settleAuthority.toBase58()).toBe(KEEPER.toBase58());
      expect(initArgs.entryCloseTs.toString()).toBe(String(FIXTURES[i].kickoffTs));
      expect(initArgs.numBuckets).toBe([3, 2, 3, 2][i]); // 12→3-way, 11→2, 16→3-way, 15→2
    });
  });

  it("initializeMarket accountsStrict = {creator: keeper, market PDA, vault PDA, systemProgram}", async () => {
    const spy = makeProgramSpy();
    await drive(spy);
    initMarketCalls(spy.calls).forEach((c, i) => {
      const leg = CARD.legs[i];
      const market = marketPda(leg.fixtureId, leg.marketId);
      expect((c.accounts.creator as PublicKeyT).toBase58()).toBe(KEEPER.toBase58());
      expect((c.accounts.market as PublicKeyT).toBase58()).toBe(market.toBase58());
      expect((c.accounts.vault as PublicKeyT).toBase58()).toBe(vaultPda(market).toBase58());
      expect(c.accounts.systemProgram).toBeDefined();
    });
  });

  it("a leg whose fixture is missing from the slate falls back to entry_close = card.lockTs", async () => {
    const spy = makeProgramSpy();
    const card: Card = {
      ...CARD,
      legs: [...CARD.legs.slice(0, 3), { fixtureId: 99_999, marketId: 12 }],
    };
    await drive(spy, card);
    const last = initMarketCalls(spy.calls)[3];
    const initArgs = last.args[2] as { entryCloseTs: BNLike };
    expect(initArgs.entryCloseTs.toString()).toBe(String(CARD.lockTs));
  });

  it("markets that already exist are skipped: zero initializeMarket, createContest still fires", async () => {
    const spy = makeProgramSpy({ marketsExist: true });
    const res = await drive(spy);
    expect(res.action).toBe("created");
    expect(initMarketCalls(spy.calls)).toHaveLength(0);
    expect(createContestCalls(spy.calls)).toHaveLength(1);
  });

  it("an unknown market id throws before ANY .rpc()", async () => {
    const spy = makeProgramSpy();
    const card: Card = {
      ...CARD,
      legs: [{ fixtureId: 20001, marketId: 99 }, ...CARD.legs.slice(1)],
    };
    await expect(drive(spy, card)).rejects.toThrow(/unknown market id 99/);
    expect(spy.calls).toHaveLength(0);
  });
});
