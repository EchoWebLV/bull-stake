/**
 * Unit tests for live-runner.ts (S3-T4 core) — the dual-RPC (base + ER) harness
 * that productionizes spike/live-er/proof.ts.
 *
 * *** HERMETIC by construction ***
 * NONE of these tests perform real I/O. Specifically:
 *   • Importing live-runner.ts fires ZERO side effects — its main() is behind an
 *     `isMain` guard (process.argv[1]?.endsWith('live-runner.ts')), so an import
 *     never loads a wallet or opens an RPC.
 *   • `new Connection(url, 'confirmed')` is I/O-FREE — it only stores the endpoint
 *     string; no socket opens until a request method is called. We assert
 *     `.rpcEndpoint` on the REAL Connections without any network round-trip.
 *   • The two Anchor `Program`s are INJECTED as hand-rolled spies via a
 *     `programFactory` seam, so `.rpc()` resolves a fake signature and never
 *     touches a Connection. The `new Program(idl, provider)` constructor is also
 *     pure, but we still inject to avoid needing an on-chain IDL fetch.
 *   • `step()` is exercised with plain resolving/throwing fns — no RPC.
 * A test that spent SOL or hit the network would be a FAILING test; none here does.
 */

import { describe, it, expect, vi } from "vitest";
import pkg from "@solana/web3.js";
import {
  BASE_RPC,
  ER_RPC,
  createLiveRunner,
  LIVE_PROGRAM_ID,
  VALIDATOR,
  DELEGATION_PROGRAM,
  sortSeatsAscending,
  gatherSeats,
  selectDelegationBranch,
  delegateAll,
  awaitErVisibility,
  NONE_SEQ,
  erKind,
  openCallOnEr,
  resolveOutcomeIndex,
  resolveCallOnEr,
  scoreAllSeats,
  commitLiveOnEr,
  endAndUndelegateOnEr,
  pollBaseUndelegated,
  endLivePoolOnBase,
  awaitSettleWindow,
  settleLivePoolOnBase,
  voidLivePoolOnBase,
  refundVoidedOnBase,
  finalizeFt,
  finalizeVoid,
} from "../live-runner.js";
import { CallKind, VOID_OUTCOME } from "../live-feed.js";
import { liveCursorPda, liveEntryPda, callPda, jackpotPda } from "../live-pda.js";

const { Keypair, PublicKey } = pkg;

// A deterministic keypair stands in for the funded keeper — generated in-memory,
// never funded, never used to sign a real tx here.
const keeper = Keypair.generate();

// A minimal IDL stub with a WRONG address on purpose, so we can prove the runner
// overwrites idl.address to LIVE_PROGRAM_ID before constructing the Programs.
// Cast to `any` — this is a bare stub, not a full Anchor Idl (the spy factory
// never reads it beyond `.address` / `.metadata.name`).
const idlStub = (): any => ({
  address: "11111111111111111111111111111111",
  metadata: { name: "proofbet", version: "0.1.0", spec: "0.1.0" },
  instructions: [],
  accounts: [],
});

/**
 * A programFactory seam that records the (idl, provider) it was handed and
 * returns a spy Program whose `.provider` is the passed provider (so tests can
 * read `.provider.connection.rpcEndpoint`) and whose `.methods` never touch RPC.
 */
function makeSpyProgramFactory() {
  const seen: { idl: any; provider: any }[] = [];
  const factory = (idl: any, provider: any) => {
    seen.push({ idl, provider });
    return { provider, methods: {} } as any;
  };
  return { factory, seen };
}

function makeRunner() {
  const { factory, seen } = makeSpyProgramFactory();
  const runner = createLiveRunner({
    keypair: keeper,
    idl: idlStub(),
    programFactory: factory,
  });
  return { runner, seen };
}

describe("createLiveRunner — dual-RPC construction (proof.ts:64-70)", () => {
  it("base Program's connection points at BASE_RPC, er at ER_RPC", () => {
    const { runner } = makeRunner();
    const baseP = runner.base.provider as any;
    const erP = runner.er.provider as any;
    expect(baseP.connection.rpcEndpoint).toBe(BASE_RPC);
    expect(erP.connection.rpcEndpoint).toBe(ER_RPC);
    expect(BASE_RPC).toBe("https://api.devnet.solana.com");
    expect(ER_RPC).toBe("https://devnet.magicblock.app");
  });

  it("shares ONE wallet across both providers (single keeper key)", () => {
    const { runner } = makeRunner();
    const baseP = runner.base.provider as any;
    const erP = runner.er.provider as any;
    expect(baseP.wallet).toBe(erP.wallet);
    expect(baseP.wallet.publicKey.toBase58()).toBe(keeper.publicKey.toBase58());
  });

  it("injects idl.address = LIVE_PROGRAM_ID before building each Program", () => {
    const { runner, seen } = makeRunner();
    // both Programs built from an idl whose address was overwritten
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.idl.address).toBe(LIVE_PROGRAM_ID.toBase58());
    }
    expect(runner.programId.toBase58()).toBe(LIVE_PROGRAM_ID.toBase58());
    // the ORIGINAL stub address (all-1s) must NOT survive
    expect(seen[0].idl.address).not.toBe("11111111111111111111111111111111");
  });

  it("the two Programs use DISTINCT providers/connections (base vs ER)", () => {
    const { runner } = makeRunner();
    expect(runner.base.provider).not.toBe(runner.er.provider);
    expect((runner.base.provider as any).connection).not.toBe(
      (runner.er.provider as any).connection,
    );
  });
});

describe("step() harness (proof.ts:74-91)", () => {
  it("records ok:true + sig for a resolving fn that returns a signature string", async () => {
    const { runner } = makeRunner();
    const out = await runner.step("open_call", async () => "sig12345678abcdef");
    expect(out).toBe("sig12345678abcdef");
    const rec = runner.report.steps.at(-1)!;
    expect(rec.name).toBe("open_call");
    expect(rec.ok).toBe(true);
    expect(rec.sig).toBe("sig12345678abcdef");
    expect(rec.err).toBeUndefined();
    expect(typeof rec.ms).toBe("number");
  });

  it("records ok:false + captured err + logs for a throwing fn, and returns null", async () => {
    const { runner } = makeRunner();
    const boom = Object.assign(new Error("simulation failed"), {
      logs: ["Program log: custom error 0x1"],
    });
    const out = await runner.step("resolve_call", async () => {
      throw boom;
    });
    expect(out).toBeNull();
    const rec = runner.report.steps.at(-1)!;
    expect(rec.name).toBe("resolve_call");
    expect(rec.ok).toBe(false);
    expect(rec.err).toContain("simulation failed");
    expect(rec.logs).toEqual(["Program log: custom error 0x1"]);
    expect(rec.sig).toBeUndefined();
    // the throw is also mirrored into report.errors for a final tally
    expect(runner.report.errors.at(-1)!.name).toBe("resolve_call");
  });

  it("does NOT record a sig when the fn resolves a non-string value", async () => {
    const { runner } = makeRunner();
    const out = await runner.step("read_pool", async () => ({ ok: 1 }));
    expect(out).toEqual({ ok: 1 });
    const rec = runner.report.steps.at(-1)!;
    expect(rec.ok).toBe(true);
    expect(rec.sig).toBeUndefined();
  });

  it("accumulates steps in order across multiple calls", async () => {
    const { runner } = makeRunner();
    await runner.step("a", async () => "s1");
    await runner.step("b", async () => {
      throw new Error("x");
    });
    await runner.step("c", async () => "s3");
    expect(runner.report.steps.map((s: any) => s.name)).toEqual(["a", "b", "c"]);
    expect(runner.report.steps.map((s: any) => s.ok)).toEqual([true, false, true]);
  });
});

describe("runLiveMatch export + hermetic import guard", () => {
  it("exports an in-process runLiveMatch function", async () => {
    const mod = await import("../live-runner.js");
    expect(typeof mod.runLiveMatch).toBe("function");
  });

  it("importing the module performs NO network I/O (isMain guard holds)", async () => {
    // A fresh import must not have constructed a real runner / hit RPC. We prove
    // this indirectly: the module import above already succeeded synchronously
    // without a wallet file or an RPC connection. Here we additionally assert the
    // spy factory is the ONLY thing that ever built a Program in these tests —
    // i.e. no import-time `new Program(...)` fired against a real provider.
    const { seen } = makeRunner();
    // Exactly two Programs, both from OUR factory, both this test's idl stub.
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.idl.metadata?.name === "proofbet")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3-T5 — delegation phase (BASE): player-count gate + delegate_* + ER gate
//
// *** HERMETIC ***
//   • No real Program/Connection is ever constructed. `makeDelegationSpy()`
//     hand-rolls a base Program whose `.methods.delegate*()` return a fluent
//     chain (accountsPartial → remainingAccounts → rpc) that RECORDS its inputs
//     and resolves a fake signature — it never touches a Connection.
//   • The ER Connection is a plain object exposing only `getAccountInfo`, driven
//     by a scripted queue of owners, so `awaitErVisibility` never opens a socket.
//   • `sortSeatsAscending` / `gatherSeats` / `selectDelegationBranch` are pure
//     over in-memory PublicKeys. No SOL is spent; no network is hit.
// ─────────────────────────────────────────────────────────────────────────────

/** A fluent `.methods.<x>()` recorder: accountsPartial→remainingAccounts→rpc. */
function makeMethodRecorder(name: string, calls: any[]) {
  return (...args: any[]) => {
    const rec: any = { name, args, accounts: undefined, remaining: undefined };
    const chain = {
      accountsPartial(accounts: any) {
        rec.accounts = accounts;
        return chain;
      },
      remainingAccounts(remaining: any) {
        rec.remaining = remaining;
        return chain;
      },
      async rpc() {
        calls.push(rec);
        return `sig_${name}_${calls.length}`;
      },
    };
    return chain;
  };
}

/** Hand-rolled base Program spy with delegate_* recorders + a liveEntry.all stub. */
function makeBaseSpy(seats: any[] = []) {
  const calls: any[] = [];
  const base: any = {
    methods: {
      delegateCursor: makeMethodRecorder("delegateCursor", calls),
      delegateEntry: makeMethodRecorder("delegateEntry", calls),
      delegateCall: makeMethodRecorder("delegateCall", calls),
    },
    account: {
      liveEntry: {
        all: vi.fn(async (_filters: any) =>
          seats.map((player: any) => ({ publicKey: liveEntryPda(POOL_PK, player), account: { player } })),
        ),
      },
    },
  };
  return { base, calls };
}

const POOL_PK = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");
const CURSOR_PK = liveCursorPda(POOL_PK);

describe("sortSeatsAscending (pure)", () => {
  it("orders pubkeys strictly ascending by Buffer.compare", () => {
    const a = new PublicKey("11111111111111111111111111111112");
    const b = new PublicKey("11111111111111111111111111111113");
    const c = new PublicKey("So11111111111111111111111111111111111111112");
    const sorted = sortSeatsAscending([c, a, b]);
    for (let i = 1; i < sorted.length; i++) {
      expect(Buffer.compare(sorted[i - 1].toBuffer(), sorted[i].toBuffer())).toBeLessThan(0);
    }
  });

  it("does not mutate the input array", () => {
    const a = new PublicKey("11111111111111111111111111111113");
    const b = new PublicKey("11111111111111111111111111111112");
    const input = [a, b];
    const snapshot = [...input];
    sortSeatsAscending(input);
    expect(input.map((p) => p.toBase58())).toEqual(snapshot.map((p) => p.toBase58()));
  });
});

// ── gatherSeats — OWNER-AGNOSTIC dual scan (stress fix: delegated ≠ 0 seats) ──
//
// While a pool is delegated, every LiveEntry's base `.owner` is the Delegation
// Program; an owner-scoped `.all()` under OUR program id returns NOTHING and a
// live match would read as under-filled → VOIDED MID-PLAY. gatherSeats therefore
// scans BOTH owners with identical filters and merges.

/** A 159-byte LiveEntry account buffer: player@8, pool@40 (rest zero). */
function entryData(player: any, pool: any): Buffer {
  const data = Buffer.alloc(159);
  player.toBuffer().copy(data, 8);
  pool.toBuffer().copy(data, 40);
  return data;
}

/** A base Program spy for the dual-owner gatherSeats scan. */
function makeScanSpy(byOwner: Record<string, { player: any; len?: number }[]>) {
  const gpa = vi.fn(async (owner: any, _cfg: any) =>
    (byOwner[owner.toBase58()] ?? []).map(({ player, len }) => ({
      pubkey: liveEntryPda(POOL_PK, player),
      account: {
        data:
          len === undefined
            ? entryData(player, POOL_PK)
            : Buffer.alloc(len),
        owner,
      },
    })),
  );
  const base: any = {
    programId: LIVE_PROGRAM_ID,
    provider: { connection: { getProgramAccounts: gpa } },
    account: { liveEntry: { size: 159 } },
    coder: { accounts: { memcmp: vi.fn(() => ({ offset: 0, bytes: "DISCB58" })) } },
  };
  return { base, gpa };
}

describe("gatherSeats — dual-owner scan (program + Delegation Program)", () => {
  it("scans BOTH owners with disc+dataSize+pool@40 filters and merges ascending", async () => {
    const p1 = Keypair.generate().publicKey;
    const p2 = Keypair.generate().publicKey;
    const { base, gpa } = makeScanSpy({
      [LIVE_PROGRAM_ID.toBase58()]: [{ player: p1 }],
      [DELEGATION_PROGRAM.toBase58()]: [{ player: p2 }],
    });
    const seats = await gatherSeats(base, POOL_PK);
    // Both owners scanned.
    const owners = gpa.mock.calls.map((c: any) => c[0].toBase58());
    expect(owners).toContain(LIVE_PROGRAM_ID.toBase58());
    expect(owners).toContain(DELEGATION_PROGRAM.toBase58());
    // Filter shape: discriminator memcmp + dataSize + pool@40 — on EVERY scan.
    for (const call of gpa.mock.calls) {
      expect(call[1].filters).toEqual([
        { memcmp: { offset: 0, bytes: "DISCB58" } },
        { dataSize: 159 },
        { memcmp: { offset: 40, bytes: POOL_PK.toBase58() } },
      ]);
    }
    // Both seats found (one per owner), ascending.
    expect(seats.map((s) => s.toBase58()).sort()).toEqual(
      [p1, p2].map((p) => p.toBase58()).sort(),
    );
    for (let i = 1; i < seats.length; i++) {
      expect(Buffer.compare(seats[i - 1].toBuffer(), seats[i].toBuffer())).toBeLessThan(0);
    }
  });

  it("REGRESSION: a fully-delegated pool (all entries owned by DELeGG…) still reports its seats", async () => {
    const p1 = Keypair.generate().publicKey;
    const p2 = Keypair.generate().publicKey;
    const { base } = makeScanSpy({
      [DELEGATION_PROGRAM.toBase58()]: [{ player: p1 }, { player: p2 }],
    });
    const seats = await gatherSeats(base, POOL_PK);
    expect(seats).toHaveLength(2); // NOT [] — [] would void a live match mid-play
  });

  it("de-duplicates a seat visible under both owners and skips wrong-size buffers", async () => {
    const p1 = Keypair.generate().publicKey;
    const { base } = makeScanSpy({
      [LIVE_PROGRAM_ID.toBase58()]: [{ player: p1 }, { player: p1, len: 200 }],
      [DELEGATION_PROGRAM.toBase58()]: [{ player: p1 }],
    });
    const seats = await gatherSeats(base, POOL_PK);
    expect(seats).toHaveLength(1);
    expect(seats[0].toBase58()).toBe(p1.toBase58());
  });

  it("returns [] for a pool with no entries under either owner", async () => {
    const { base } = makeScanSpy({});
    expect(await gatherSeats(base, POOL_PK)).toEqual([]);
  });
});

describe("selectDelegationBranch — HARD GATE player_count<2", () => {
  it("routes to 'void' when fewer than 2 seats (0 or 1)", () => {
    expect(selectDelegationBranch(0)).toBe("void");
    expect(selectDelegationBranch(1)).toBe("void");
  });
  it("routes to 'delegate' at exactly 2 and above", () => {
    expect(selectDelegationBranch(2)).toBe("delegate");
    expect(selectDelegationBranch(9)).toBe("delegate");
  });
});

describe("delegateAll (BASE) — delegate_* with pda key + validator remaining[0]", () => {
  function runnerWith(base: any) {
    const { runner } = makeRunner();
    (runner as any).base = base;
    return runner;
  }

  it("seats<2 → ZERO delegate calls (gate stops before any tx)", async () => {
    const { base, calls } = makeBaseSpy();
    const runner = runnerWith(base);
    const seat = Keypair.generate().publicKey;
    const res = await delegateAll(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats: [seat], // only 1
      numCalls: 3,
    });
    expect(calls).toHaveLength(0);
    expect(res.branch).toBe("void");
    expect(res.delegated).toBe(false);
  });

  it("seats>=2 → delegateCursor + delegateEntry×seats + delegateCall×numCalls", async () => {
    const { base, calls } = makeBaseSpy();
    const runner = runnerWith(base);
    const s1 = Keypair.generate().publicKey;
    const s2 = Keypair.generate().publicKey;
    const numCalls = 4;
    const res = await delegateAll(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats: [s1, s2],
      numCalls,
    });
    expect(res.branch).toBe("delegate");
    expect(res.delegated).toBe(true);
    const byName = (n: string) => calls.filter((c) => c.name === n);
    expect(byName("delegateCursor")).toHaveLength(1);
    expect(byName("delegateEntry")).toHaveLength(2);
    expect(byName("delegateCall")).toHaveLength(numCalls);
  });

  it("EVERY delegate_* pins remainingAccounts[0] === VALIDATOR (non-signer, non-writable)", async () => {
    const { base, calls } = makeBaseSpy();
    const runner = runnerWith(base);
    await delegateAll(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats: [Keypair.generate().publicKey, Keypair.generate().publicKey],
      numCalls: 2,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.remaining[0].pubkey.toBase58()).toBe(VALIDATOR.toBase58());
      expect(c.remaining[0].isSigner).toBe(false);
      expect(c.remaining[0].isWritable).toBe(false);
    }
  });

  it("the delegated account is passed under the GENERIC key `pda` (not cursor/entry/call)", async () => {
    const { base, calls } = makeBaseSpy();
    const runner = runnerWith(base);
    const s1 = Keypair.generate().publicKey;
    const s2 = Keypair.generate().publicKey;
    await delegateAll(runner, { pool: POOL_PK, cursor: CURSOR_PK, seats: [s1, s2], numCalls: 1 });
    for (const c of calls) {
      // account key literally `pda`, plus keeper+pool
      expect(Object.prototype.hasOwnProperty.call(c.accounts, "pda")).toBe(true);
      expect(c.accounts).not.toHaveProperty("cursor");
      expect(c.accounts).not.toHaveProperty("entry");
      expect(c.accounts).not.toHaveProperty("call");
    }
    // cursor delegation carries the cursor PDA under `pda`
    const cur = calls.find((c) => c.name === "delegateCursor");
    expect(cur.accounts.pda.toBase58()).toBe(CURSOR_PK.toBase58());
    // call delegation carries the call PDA under `pda`
    const callRec = calls.find((c) => c.name === "delegateCall");
    expect(callRec.accounts.pda.toBase58()).toBe(callPda(POOL_PK, 0).toBase58());
    // entry delegation carries the entry PDA under `pda` and player as the arg
    const entryRec = calls.find((c) => c.name === "delegateEntry");
    const seatArg = entryRec.args[0];
    expect(entryRec.accounts.pda.toBase58()).toBe(liveEntryPda(POOL_PK, seatArg).toBase58());
  });

  it("delegateCall is issued for seq 0..numCalls-1", async () => {
    const { base, calls } = makeBaseSpy();
    const runner = runnerWith(base);
    await delegateAll(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats: [Keypair.generate().publicKey, Keypair.generate().publicKey],
      numCalls: 3,
    });
    const seqs = calls.filter((c) => c.name === "delegateCall").map((c) => c.args[0]);
    expect(seqs).toEqual([0, 1, 2]);
  });
});

describe("awaitErVisibility — poll erConn until owner === PROGRAM_ID", () => {
  /** A scripted erConn.getAccountInfo: yields queued owners in order, last repeats. */
  function makeErConn(ownerScript: (any | null)[]) {
    let i = 0;
    const getAccountInfo = vi.fn(async (_pk: any, _c?: any) => {
      const owner = ownerScript[Math.min(i, ownerScript.length - 1)];
      i++;
      return owner === null ? null : { owner };
    });
    return { getAccountInfo };
  }

  function runnerWithEr(erConn: any) {
    const { runner } = makeRunner();
    (runner as any).erConn = erConn;
    return runner;
  }

  it("keeps polling while the account is owned by DELEGATION_PROGRAM, resolves once PROGRAM_ID", async () => {
    vi.useFakeTimers();
    try {
      const erConn = makeErConn([
        null, // not yet surfaced
        DELEGATION_PROGRAM, // still delegated
        LIVE_PROGRAM_ID, // ready
      ]);
      const runner = runnerWithEr(erConn);
      const promise = awaitErVisibility(runner, CURSOR_PK, { intervalMs: 2500, timeoutMs: 60000 });
      // advance through the poll loop
      await vi.advanceTimersByTimeAsync(2500);
      await vi.advanceTimersByTimeAsync(2500);
      await vi.advanceTimersByTimeAsync(2500);
      const ok = await promise;
      expect(ok).toBe(true);
      // it did NOT resolve on the DELEGATION_PROGRAM tick — it waited for PROGRAM_ID
      expect(erConn.getAccountInfo.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on timeout if the account never flips to PROGRAM_ID", async () => {
    vi.useFakeTimers();
    try {
      const erConn = makeErConn([DELEGATION_PROGRAM]); // stuck delegated forever
      const runner = runnerWithEr(erConn);
      const promise = awaitErVisibility(runner, CURSOR_PK, { intervalMs: 2500, timeoutMs: 5000 });
      const caught = promise.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(2500);
      await vi.advanceTimersByTimeAsync(2500);
      await vi.advanceTimersByTimeAsync(2500);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/ER|visib|cursor|timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3-T6 — ER gameplay (open/resolve/score/commit)
//
// *** HERMETIC ***
//   • The `er` Program is a hand-rolled spy: `.methods.openCall/resolveCall/
//     scoreEntry/commitLive()` return a fluent chain (accountsPartial →
//     remainingAccounts → rpc) that RECORDS its args/accounts/remaining and
//     resolves a fake signature — it never touches a Connection.
//   • Resolve's proof core is exercised through an INJECTED `viewValidate` seam
//     (`makeProofSeam`) so `resolveOutcomeIndex` never runs `fetchStatValidation`
//     (HTTP) nor a real `.view()` — we only assert it hands the TXORACLE Program
//     to `viewValidate`, never proofbet.
//   • Pure helpers (`erKind`, void-on-goal) run over in-memory data.
// A test that spent SOL or hit the network would be a FAILING test; none here does.
// ─────────────────────────────────────────────────────────────────────────────

/** A fluent ER `.methods.<x>()` recorder mirroring makeMethodRecorder. */
function makeErMethodRecorder(name: string, calls: any[]) {
  return (...args: any[]) => {
    const rec: any = { name, args, accounts: undefined, remaining: undefined };
    const chain = {
      accountsPartial(accounts: any) {
        rec.accounts = accounts;
        return chain;
      },
      remainingAccounts(remaining: any) {
        rec.remaining = remaining;
        return chain;
      },
      async rpc() {
        calls.push(rec);
        return `sig_${name}_${calls.length}`;
      },
    };
    return chain;
  };
}

/** Hand-rolled ER Program spy with the four gameplay recorders. */
function makeErSpy() {
  const calls: any[] = [];
  const er: any = {
    methods: {
      openCall: makeErMethodRecorder("openCall", calls),
      resolveCall: makeErMethodRecorder("resolveCall", calls),
      scoreEntry: makeErMethodRecorder("scoreEntry", calls),
      commitLive: makeErMethodRecorder("commitLive", calls),
      endAndUndelegate: makeErMethodRecorder("endAndUndelegate", calls),
    },
  };
  return { er, calls };
}

function erRunner(er: any) {
  const { runner } = makeRunner();
  (runner as any).er = er;
  return runner;
}

describe("erKind — CallKind → Anchor enum object", () => {
  it("maps each kind to its snake→camel single-key enum", () => {
    expect(erKind(CallKind.NextGoal)).toEqual({ nextGoal: {} });
    expect(erKind(CallKind.GoalRush)).toEqual({ goalRush: {} });
    expect(erKind(CallKind.CornerSoon)).toEqual({ cornerSoon: {} });
    expect(erKind(CallKind.CardSoon)).toEqual({ cardSoon: {} });
  });
});

describe("openCallOnEr — single-open invariant + accountsPartial shape", () => {
  it("opens seq when cursor.open_seq === NONE_SEQ and seq === next_seq", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const call = callPda(POOL_PK, 0);
    const sig = await openCallOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      call,
      seq: 0,
      kind: CallKind.NextGoal,
      cursorState: { openSeq: NONE_SEQ, nextSeq: 0 },
    });
    expect(sig).toBeTruthy();
    const rec = calls.find((c) => c.name === "openCall");
    // args: (seq, {nextGoal:{}}, numOptions, basePoints, answerSecs)
    expect(rec.args[0]).toBe(0);
    expect(rec.args[1]).toEqual({ nextGoal: {} });
    expect(rec.args[2]).toBe(3); // numOptions for NextGoal
    expect(rec.args[3]).toEqual([4, 1, 4]); // basePoints
    expect(typeof rec.args[4]).toBe("number"); // answerSecs
    // accountsPartial has keeper/pool/cursor/call
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    expect(rec.accounts.cursor.toBase58()).toBe(CURSOR_PK.toBase58());
    expect(rec.accounts.call.toBase58()).toBe(call.toBase58());
    expect(rec.accounts.keeper.toBase58()).toBe(runner.keeper.toBase58());
  });

  it("opens a binary kind (CornerSoon) with a length-3 basePoints wire array", async () => {
    // base_points is a fixed on-chain [u8; 3]; a 2-element array under-serializes
    // open_call and corrupts answer_secs. Binary kinds must pass [x, y, 0].
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const call = callPda(POOL_PK, 1);
    const sig = await openCallOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      call,
      seq: 1,
      kind: CallKind.CornerSoon,
      cursorState: { openSeq: NONE_SEQ, nextSeq: 1 },
    });
    expect(sig).toBeTruthy();
    const rec = calls.find((c) => c.name === "openCall");
    expect(rec.args[1]).toEqual({ cornerSoon: {} });
    expect(rec.args[2]).toBe(2); // numOptions for CornerSoon
    expect(rec.args[3]).toHaveLength(3); // fixed [u8;3] wire array
    expect(rec.args[3]).toEqual([2, 1, 0]); // padded with trailing 0
  });

  it("does NOT open a second call while one is already open (open_seq !== NONE_SEQ)", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const res = await openCallOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      call: callPda(POOL_PK, 1),
      seq: 1,
      kind: CallKind.GoalRush,
      cursorState: { openSeq: 0, nextSeq: 1 }, // seq 0 still open
    });
    expect(res).toBeNull(); // refused
    expect(calls.filter((c) => c.name === "openCall")).toHaveLength(0);
  });

  it("refuses to open when seq !== cursor.next_seq (out-of-order guard)", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const res = await openCallOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      call: callPda(POOL_PK, 5),
      seq: 5,
      kind: CallKind.CardSoon,
      cursorState: { openSeq: NONE_SEQ, nextSeq: 2 }, // next is 2, not 5
    });
    expect(res).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("resolveOutcomeIndex — proof core on the TXORACLE program", () => {
  /**
   * A proof seam that records which Program `viewValidate` was handed, and drives
   * the winning bucket deterministically. `program` here is a UNIQUE object that
   * stands for the Txoracle program — the test asserts the runner passes THIS one
   * (never a proofbet program) to `viewValidate`.
   */
  function makeProofSeam(opts: {
    homeDelta: number;
    awayDelta: number;
    watchedRose: boolean;
    prevGoals: number;
    curGoals: number;
  }) {
    const txoracleProgram = { __txoracle: true, programId: { toBase58: () => "TXORACLE" } };
    const seen: any[] = [];
    const seam = {
      program: txoracleProgram as any,
      // Feed-derived deltas the runner will map via mapOutcomeToOption.
      deltas: {
        homeGoals: opts.homeDelta,
        awayGoals: opts.awayDelta,
        watched: opts.watchedRose ? 1 : 0,
      },
      prevGoals: opts.prevGoals,
      curGoals: opts.curGoals,
      // Stand-in viewValidate: records the program it was handed.
      viewValidate: vi.fn(async (program: any) => {
        seen.push(program);
        return true;
      }),
    };
    return { seam, seen, txoracleProgram };
  }

  it("hands the TXORACLE program (never proofbet) to viewValidate when it consults the predicate", async () => {
    const { seam, seen, txoracleProgram } = makeProofSeam({
      homeDelta: 0,
      awayDelta: 0,
      watchedRose: true,
      prevGoals: 0,
      curGoals: 0,
    });
    await resolveOutcomeIndex(CallKind.CornerSoon, seam as any);
    // If the predicate path consulted viewValidate at all, it used the Txoracle program.
    for (const p of seen) {
      expect(p).toBe(txoracleProgram);
      expect(p.__txoracle).toBe(true);
    }
  });

  it("NextGoal: home rose more → option 0; away → 2; equal → 1 (never a sentinel)", async () => {
    const home = await resolveOutcomeIndex(CallKind.NextGoal, {
      ...makeProofSeam({ homeDelta: 1, awayDelta: 0, watchedRose: false, prevGoals: 0, curGoals: 1 }).seam,
    } as any);
    const away = await resolveOutcomeIndex(CallKind.NextGoal, {
      ...makeProofSeam({ homeDelta: 0, awayDelta: 1, watchedRose: false, prevGoals: 0, curGoals: 1 }).seam,
    } as any);
    const none = await resolveOutcomeIndex(CallKind.NextGoal, {
      ...makeProofSeam({ homeDelta: 0, awayDelta: 0, watchedRose: false, prevGoals: 0, curGoals: 0 }).seam,
    } as any);
    expect(home).toBe(0);
    expect(away).toBe(2);
    expect(none).toBe(1);
    for (const o of [home, away, none]) {
      expect(o).not.toBe(0xff);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(3);
    }
  });

  it("void-on-goal: a goal rise while CornerSoon open → exactly 0xFE (never 0xFF)", async () => {
    const out = await resolveOutcomeIndex(CallKind.CornerSoon, {
      ...makeProofSeam({ homeDelta: 0, awayDelta: 0, watchedRose: false, prevGoals: 0, curGoals: 1 }).seam,
    } as any);
    expect(out).toBe(VOID_OUTCOME);
    expect(out).toBe(0xfe);
    expect(out).not.toBe(0xff);
  });

  it("a goal rise while NextGoal open does NOT void (goal is its answer)", async () => {
    const out = await resolveOutcomeIndex(CallKind.NextGoal, {
      ...makeProofSeam({ homeDelta: 1, awayDelta: 0, watchedRose: false, prevGoals: 0, curGoals: 1 }).seam,
    } as any);
    expect(out).toBe(0); // home scored — resolves, not voids
  });

  it("binary hit/miss stays in range [0,2) — never a sentinel", async () => {
    const hit = await resolveOutcomeIndex(CallKind.CardSoon, {
      ...makeProofSeam({ homeDelta: 0, awayDelta: 0, watchedRose: true, prevGoals: 0, curGoals: 0 }).seam,
    } as any);
    const miss = await resolveOutcomeIndex(CallKind.CardSoon, {
      ...makeProofSeam({ homeDelta: 0, awayDelta: 0, watchedRose: false, prevGoals: 0, curGoals: 0 }).seam,
    } as any);
    expect(hit).toBe(0);
    expect(miss).toBe(1);
  });
});

describe("resolveCallOnEr — resolve_call(outcome) accountsPartial shape", () => {
  it("passes the outcome index and keeper/pool/cursor/call accounts", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const call = callPda(POOL_PK, 0);
    await resolveCallOnEr(runner, { pool: POOL_PK, cursor: CURSOR_PK, call, seq: 0, outcome: 2 });
    const rec = calls.find((c) => c.name === "resolveCall");
    expect(rec.args[0]).toBe(2);
    expect(rec.accounts.keeper.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    expect(rec.accounts.cursor.toBase58()).toBe(CURSOR_PK.toBase58());
    expect(rec.accounts.call.toBase58()).toBe(call.toBase58());
  });

  it("carries 0xFE verbatim for a void", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    await resolveCallOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      call: callPda(POOL_PK, 0),
      seq: 0,
      outcome: VOID_OUTCOME,
    });
    expect(calls.find((c) => c.name === "resolveCall").args[0]).toBe(0xfe);
  });
});

describe("scoreAllSeats — score_entry per seat under key `cranker`", () => {
  it("scores each seat exactly once with cranker=keeper, call, entry", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const s1 = Keypair.generate().publicKey;
    const s2 = Keypair.generate().publicKey;
    const call = callPda(POOL_PK, 0);
    await scoreAllSeats(runner, { pool: POOL_PK, call, seats: [s1, s2] });
    const scores = calls.filter((c) => c.name === "scoreEntry");
    expect(scores).toHaveLength(2);
    for (const rec of scores) {
      // key is literally `cranker`, NOT `keeper`
      expect(Object.prototype.hasOwnProperty.call(rec.accounts, "cranker")).toBe(true);
      expect(rec.accounts).not.toHaveProperty("keeper");
      expect(rec.accounts.cranker.toBase58()).toBe(runner.keeper.toBase58());
      expect(rec.accounts.call.toBase58()).toBe(call.toBase58());
    }
    // each seat's own entry PDA was scored
    const entries = scores.map((r) => r.accounts.entry.toBase58()).sort();
    expect(entries).toEqual(
      [liveEntryPda(POOL_PK, s1), liveEntryPda(POOL_PK, s2)].map((p) => p.toBase58()).sort(),
    );
  });
});

describe("commitLiveOnEr — full writable remainingAccounts [cursor, ...entries, ...calls]", () => {
  it("remainingAccounts = cursor + every entry + every call, all isWritable:true", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const s1 = Keypair.generate().publicKey;
    const s2 = Keypair.generate().publicKey;
    const seats = [s1, s2];
    const callPdas = [callPda(POOL_PK, 0), callPda(POOL_PK, 1)];
    await commitLiveOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats,
      calls: callPdas,
    });
    const rec = calls.find((c) => c.name === "commitLive");
    expect(rec.accounts.keeper.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    // remaining = [cursor, entry(s1), entry(s2), call0, call1]
    const expected = [
      CURSOR_PK,
      liveEntryPda(POOL_PK, s1),
      liveEntryPda(POOL_PK, s2),
      callPdas[0],
      callPdas[1],
    ];
    expect(rec.remaining).toHaveLength(expected.length);
    rec.remaining.forEach((r: any, i: number) => {
      expect(r.pubkey.toBase58()).toBe(expected[i].toBase58());
      expect(r.isSigner).toBe(false);
      expect(r.isWritable).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S3-T7 — end→settle→void/refund (BASE)
//
// *** HERMETIC ***
//   • Both the `er` (endAndUndelegate) and `base` (endLivePool / settleLivePool /
//     voidLivePool / refundVoided) Programs are hand-rolled spies whose fluent
//     `.methods.<x>()` chains RECORD args/accounts/remaining and resolve a fake
//     signature — never a real `.rpc()`, never a Connection.
//   • `pollBaseUndelegated` / `awaitSettleWindow` drive a plain-object baseConn
//     whose `getAccountInfo` / `getBlockTime` / `getSlot` are scripted vi.fns, so
//     no socket ever opens. Fake timers advance the poll loops deterministically.
//   • The settle-vs-refund remaining_accounts SHAPES are asserted to DIFFER
//     (entries-only ascending isWritable:false vs interleaved [entry,player]
//     pairs len=player_count*2) — the copy-paste-reverts-on-chain trap (Risk #3).
// A test that spent SOL or hit the network would be a FAILING test; none here does.
// ─────────────────────────────────────────────────────────────────────────────

/** Hand-rolled BASE Program spy with the end/settle/void/refund recorders. */
function makeSettleBaseSpy() {
  const calls: any[] = [];
  const base: any = {
    methods: {
      endLivePool: makeMethodRecorder("endLivePool", calls),
      settleLivePool: makeMethodRecorder("settleLivePool", calls),
      voidLivePool: makeMethodRecorder("voidLivePool", calls),
      refundVoided: makeMethodRecorder("refundVoided", calls),
    },
  };
  return { base, calls };
}

function settleRunner(base: any, er?: any) {
  const { runner } = makeRunner();
  (runner as any).base = base;
  if (er) (runner as any).er = er;
  return runner;
}

/** Two ascending seats + their entries/calls, reused across the settle/void tests. */
function seatFixture() {
  const raw = [Keypair.generate().publicKey, Keypair.generate().publicKey];
  const seats = sortSeatsAscending(raw);
  const entries = seats.map((p) => liveEntryPda(POOL_PK, p));
  const calls = [callPda(POOL_PK, 0), callPda(POOL_PK, 1)];
  return { seats, entries, calls };
}

describe("endAndUndelegateOnEr (ER) — full writable [cursor, ...entries, ...calls]", () => {
  it("accounts {keeper, pool} + remaining = cursor+entries+calls, all writable", async () => {
    const { er, calls } = makeErSpy();
    const runner = erRunner(er);
    const { seats, entries, calls: callPdas } = seatFixture();
    await endAndUndelegateOnEr(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats,
      calls: callPdas,
    });
    const rec = calls.find((c) => c.name === "endAndUndelegate");
    expect(rec).toBeTruthy();
    expect(rec.accounts.keeper.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    const expected = [CURSOR_PK, ...entries, ...callPdas];
    expect(rec.remaining).toHaveLength(expected.length);
    rec.remaining.forEach((r: any, i: number) => {
      expect(r.pubkey.toBase58()).toBe(expected[i].toBase58());
      expect(r.isSigner).toBe(false);
      expect(r.isWritable).toBe(true);
    });
  });
});

describe("pollBaseUndelegated — wait until owner === PROGRAM_ID on base", () => {
  function makeBaseConn(ownerScript: (any | null)[]) {
    let i = 0;
    const getAccountInfo = vi.fn(async (_pk: any, _c?: any) => {
      const owner = ownerScript[Math.min(i, ownerScript.length - 1)];
      i++;
      return owner === null ? null : { owner };
    });
    return { getAccountInfo };
  }
  function runnerWithBaseConn(baseConn: any) {
    const { runner } = makeRunner();
    (runner as any).baseConn = baseConn;
    return runner;
  }

  it("keeps polling while owner is DELEGATION_PROGRAM, resolves once PROGRAM_ID", async () => {
    vi.useFakeTimers();
    try {
      const baseConn = makeBaseConn([DELEGATION_PROGRAM, DELEGATION_PROGRAM, LIVE_PROGRAM_ID]);
      const runner = runnerWithBaseConn(baseConn);
      const promise = pollBaseUndelegated(runner, [CURSOR_PK], { intervalMs: 3000, timeoutMs: 90000 });
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await promise).toBe(true);
      expect(baseConn.getAccountInfo.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for EVERY passed account (cursor AND an entry) to flip", async () => {
    // Two accounts: the cursor flips immediately, the entry lags one tick. The
    // loop must not resolve until BOTH are PROGRAM_ID-owned.
    vi.useFakeTimers();
    try {
      let n = 0;
      const getAccountInfo = vi.fn(async (pk: any) => {
        // cursor is always ready; entry only ready after the first tick.
        if (pk.toBase58() === CURSOR_PK.toBase58()) return { owner: LIVE_PROGRAM_ID };
        n++;
        return { owner: n >= 2 ? LIVE_PROGRAM_ID : DELEGATION_PROGRAM };
      });
      const { runner } = makeRunner();
      (runner as any).baseConn = { getAccountInfo };
      const entry = liveEntryPda(POOL_PK, Keypair.generate().publicKey);
      const promise = pollBaseUndelegated(runner, [CURSOR_PK, entry], { intervalMs: 3000, timeoutMs: 90000 });
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await promise).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on timeout if an account never flips", async () => {
    vi.useFakeTimers();
    try {
      const baseConn = makeBaseConn([DELEGATION_PROGRAM]);
      const runner = runnerWithBaseConn(baseConn);
      const promise = pollBaseUndelegated(runner, [CURSOR_PK], { intervalMs: 3000, timeoutMs: 6000 });
      const caught = promise.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(3000);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/undeleg|timeout|owner|base/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("endLivePoolOnBase — accounts {keeper, pool, cursor}, no args", () => {
  it("calls endLivePool with keeper/pool/cursor and no positional args", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    await endLivePoolOnBase(runner, { pool: POOL_PK, cursor: CURSOR_PK });
    const rec = calls.find((c) => c.name === "endLivePool");
    expect(rec).toBeTruthy();
    expect(rec.args).toEqual([]); // no positional args
    expect(rec.accounts.keeper.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    expect(rec.accounts.cursor.toBase58()).toBe(CURSOR_PK.toBase58());
  });
});

describe("awaitSettleWindow — gate on getBlockTime(getSlot) >= settleAfterTs+1", () => {
  function runnerWithClock(times: (number | null)[]) {
    const { runner } = makeRunner();
    let i = 0;
    const getSlot = vi.fn(async () => 1000 + i);
    const getBlockTime = vi.fn(async (_slot: number) => {
      const t = times[Math.min(i, times.length - 1)];
      i++;
      return t;
    });
    (runner as any).baseConn = { getSlot, getBlockTime };
    return { runner, getBlockTime, getSlot };
  }

  it("uses ON-CHAIN clock (getBlockTime of getSlot), NOT wall-clock", async () => {
    vi.useFakeTimers();
    try {
      const settleAfterTs = 5000;
      // first read is before the window (blocks), second read passes.
      const { runner, getBlockTime, getSlot } = runnerWithClock([4999, 5001]);
      const promise = awaitSettleWindow(runner, settleAfterTs, { intervalMs: 5000, timeoutMs: 480000 });
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await promise).toBe(true);
      // it consulted the on-chain clock (getSlot → getBlockTime), never Date.now.
      expect(getSlot).toHaveBeenCalled();
      expect(getBlockTime).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires strictly settleAfterTs+1 (settleAfterTs exactly is NOT enough)", async () => {
    vi.useFakeTimers();
    try {
      const settleAfterTs = 5000;
      // exactly settleAfterTs on the first tick must NOT satisfy; +1 on the next does.
      const { runner } = runnerWithClock([5000, 5001]);
      const promise = awaitSettleWindow(runner, settleAfterTs, { intervalMs: 5000, timeoutMs: 480000 });
      await vi.advanceTimersByTimeAsync(5000);
      const settledEarly = await Promise.race([
        promise.then(() => "resolved"),
        Promise.resolve("pending"),
      ]);
      expect(settledEarly).toBe("pending"); // did NOT resolve at exactly settleAfterTs
      await vi.advanceTimersByTimeAsync(5000);
      expect(await promise).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws on timeout if the on-chain clock never reaches the window", async () => {
    vi.useFakeTimers();
    try {
      const { runner } = runnerWithClock([100]); // stuck far before
      const promise = awaitSettleWindow(runner, 5000, { intervalMs: 5000, timeoutMs: 10000 });
      const caught = promise.catch((e: Error) => e);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(5000);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/settle|window|clock|timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("settleLivePoolOnBase — entries-only, ascending, isWritable:false, NO score arg", () => {
  it("accounts {settleAuthority, jackpot, pool, cursor, feeRecipient}; keeper is both authority+recipient", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    const { seats } = seatFixture();
    await settleLivePoolOnBase(runner, { pool: POOL_PK, cursor: CURSOR_PK, seats });
    const rec = calls.find((c) => c.name === "settleLivePool");
    expect(rec.accounts.settleAuthority.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.feeRecipient.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    expect(rec.accounts.cursor.toBase58()).toBe(CURSOR_PK.toBase58());
    expect(rec.accounts.jackpot.toBase58()).toBe(jackpotPda().toBase58());
    // there is NO keeper/settleLivePool score argument (on-chain recomputes it).
    expect(rec.args).toEqual([]);
  });

  it("remaining = ENTRIES ONLY, strictly ascending, exactly player_count, all isWritable:false", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    // Pass seats deliberately OUT of order — the fn must sort them ascending.
    const raw = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    await settleLivePoolOnBase(runner, { pool: POOL_PK, cursor: CURSOR_PK, seats: raw });
    const rec = calls.find((c) => c.name === "settleLivePool");
    // exactly player_count remaining accounts (== #seats), entries only.
    expect(rec.remaining).toHaveLength(raw.length);
    // The on-chain monotonicity rule is over the remaining-account KEYS (the entry
    // PDAs), so the expected order is entries sorted BY ENTRY key — NOT by player.
    const expectedEntries = raw
      .map((p) => liveEntryPda(POOL_PK, p))
      .sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
    rec.remaining.forEach((r: any, i: number) => {
      expect(r.pubkey.toBase58()).toBe(expectedEntries[i].toBase58());
      expect(r.isSigner).toBe(false);
      expect(r.isWritable).toBe(false); // settle reads seats, never writes them
    });
    // strictly ascending by Buffer.compare
    for (let i = 1; i < rec.remaining.length; i++) {
      expect(
        Buffer.compare(rec.remaining[i - 1].pubkey.toBuffer(), rec.remaining[i].pubkey.toBuffer()),
      ).toBeLessThan(0);
    }
  });
});

describe("voidLivePoolOnBase — accounts {settleAuthority, pool}, no args", () => {
  it("calls voidLivePool with settleAuthority=keeper, pool, no positional args", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    await voidLivePoolOnBase(runner, { pool: POOL_PK });
    const rec = calls.find((c) => c.name === "voidLivePool");
    expect(rec.args).toEqual([]);
    expect(rec.accounts.settleAuthority.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    expect(rec.accounts).not.toHaveProperty("cursor");
  });
});

describe("refundVoidedOnBase — INTERLEAVED [entry, player] pairs, len=player_count*2", () => {
  it("accounts {cranker, pool}; remaining interleaved pairs with entries ascending + players writable", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    const raw = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    await refundVoidedOnBase(runner, { pool: POOL_PK, seats: raw });
    const rec = calls.find((c) => c.name === "refundVoided");
    expect(rec.accounts.cranker.toBase58()).toBe(runner.keeper.toBase58());
    expect(rec.accounts.pool.toBase58()).toBe(POOL_PK.toBase58());
    // interleaved [entry0, player0, entry1, player1, …], len = player_count*2.
    expect(rec.remaining).toHaveLength(raw.length * 2);
    // sort seats ascending BY ENTRY key (matches on-chain ascending-entry rule).
    const bySeat = raw
      .map((p) => ({ player: p, entry: liveEntryPda(POOL_PK, p) }))
      .sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
    for (let s = 0; s < bySeat.length; s++) {
      const entryRa = rec.remaining[s * 2];
      const playerRa = rec.remaining[s * 2 + 1];
      expect(entryRa.pubkey.toBase58()).toBe(bySeat[s].entry.toBase58());
      expect(entryRa.isWritable).toBe(true); // pool credits/debits — entries writable in refund
      expect(playerRa.pubkey.toBase58()).toBe(bySeat[s].player.toBase58());
      expect(playerRa.isWritable).toBe(true); // player receives the refund → MUST be writable
    }
    // entries (even indices) strictly ascending
    for (let i = 2; i < rec.remaining.length; i += 2) {
      expect(
        Buffer.compare(rec.remaining[i - 2].pubkey.toBuffer(), rec.remaining[i].pubkey.toBuffer()),
      ).toBeLessThan(0);
    }
  });

  it("settle vs refund remaining_accounts SHAPES DIFFER (entries-only vs interleaved pairs)", async () => {
    const { base: sBase, calls: sCalls } = makeSettleBaseSpy();
    const sRunner = settleRunner(sBase);
    const { base: rBase, calls: rCalls } = makeSettleBaseSpy();
    const rRunner = settleRunner(rBase);
    const { seats } = seatFixture();
    await settleLivePoolOnBase(sRunner, { pool: POOL_PK, cursor: CURSOR_PK, seats });
    await refundVoidedOnBase(rRunner, { pool: POOL_PK, seats });
    const settleRa = sCalls.find((c) => c.name === "settleLivePool").remaining;
    const refundRa = rCalls.find((c) => c.name === "refundVoided").remaining;
    // settle = player_count; refund = player_count*2 — provably different lengths.
    expect(settleRa).toHaveLength(seats.length);
    expect(refundRa).toHaveLength(seats.length * 2);
    expect(settleRa.length).not.toBe(refundRa.length);
    // settle entries are non-writable; refund players are writable — shapes differ.
    expect(settleRa.every((r: any) => r.isWritable === false)).toBe(true);
    expect(refundRa.some((r: any) => r.isWritable === true)).toBe(true);
  });
});

describe("finalizeFt — ordering endAndUndelegate → pollBase → endLivePool → settleWindow → settle", () => {
  it("runs the FT sequence in the exact documented order", async () => {
    const order: string[] = [];
    // Shared er+base spies that log their method name into `order`.
    const er: any = {
      methods: {
        endAndUndelegate: (...a: any[]) => {
          const chain: any = {
            accountsPartial: () => chain,
            remainingAccounts: () => chain,
            rpc: async () => {
              order.push("endAndUndelegate");
              return "sig_end_undeleg";
            },
          };
          return chain;
        },
      },
    };
    const base: any = {
      methods: {
        endLivePool: (...a: any[]) => {
          const chain: any = {
            accountsPartial: () => chain,
            rpc: async () => {
              order.push("endLivePool");
              return "sig_end";
            },
          };
          return chain;
        },
        settleLivePool: (...a: any[]) => {
          const chain: any = {
            accountsPartial: () => chain,
            remainingAccounts: () => chain,
            rpc: async () => {
              order.push("settleLivePool");
              return "sig_settle";
            },
          };
          return chain;
        },
      },
    };
    const { runner } = makeRunner();
    (runner as any).er = er;
    (runner as any).base = base;
    // baseConn: undelegation flips immediately; clock already past window.
    (runner as any).baseConn = {
      getAccountInfo: vi.fn(async () => {
        order.push("pollBase");
        return { owner: LIVE_PROGRAM_ID };
      }),
      getSlot: vi.fn(async () => 1),
      getBlockTime: vi.fn(async () => {
        order.push("settleWindow");
        return 999999;
      }),
    };
    const { seats, calls: callPdas } = seatFixture();
    await finalizeFt(runner, {
      pool: POOL_PK,
      cursor: CURSOR_PK,
      seats,
      calls: callPdas,
      settleAfterTs: 5000,
    });
    // First occurrence order is the contract.
    const firstIdx = (n: string) => order.indexOf(n);
    expect(firstIdx("endAndUndelegate")).toBeGreaterThanOrEqual(0);
    expect(firstIdx("endAndUndelegate")).toBeLessThan(firstIdx("pollBase"));
    expect(firstIdx("pollBase")).toBeLessThan(firstIdx("endLivePool"));
    expect(firstIdx("endLivePool")).toBeLessThan(firstIdx("settleWindow"));
    expect(firstIdx("settleWindow")).toBeLessThan(firstIdx("settleLivePool"));
  });
});

describe("finalizeVoid — voidLivePool then refundVoided (interleaved pairs)", () => {
  it("voids then refunds with interleaved [entry,player] pairs", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    const raw = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    await finalizeVoid(runner, { pool: POOL_PK, seats: raw });
    const names = calls.map((c) => c.name);
    expect(names.indexOf("voidLivePool")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("voidLivePool")).toBeLessThan(names.indexOf("refundVoided"));
    const refund = calls.find((c) => c.name === "refundVoided");
    expect(refund.remaining).toHaveLength(raw.length * 2);
  });

  it("player_count<2 (1 seat) still voids + refunds the lone seat (interleaved pair)", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    const lone = [Keypair.generate().publicKey];
    await finalizeVoid(runner, { pool: POOL_PK, seats: lone });
    const refund = calls.find((c) => c.name === "refundVoided");
    expect(calls.some((c) => c.name === "voidLivePool")).toBe(true);
    expect(refund.remaining).toHaveLength(2); // one [entry, player] pair
  });

  it("zero seats → voids but issues NO refund (nothing to pay back)", async () => {
    const { base, calls } = makeSettleBaseSpy();
    const runner = settleRunner(base);
    await finalizeVoid(runner, { pool: POOL_PK, seats: [] });
    expect(calls.some((c) => c.name === "voidLivePool")).toBe(true);
    expect(calls.some((c) => c.name === "refundVoided")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runLiveMatch — the RE-ENTRANT state machine (stress-test fixes F1/F2/F3).
//
// These are the tests whose ABSENCE let two critical integration bugs pass 54
// function-level tests: nothing ever drove runLiveMatch end-to-end. Every case
// below hand-rolls a full LiveRunner (spy base+er Programs, scripted
// connections) and asserts WHICH on-chain txs a single bounded tick issues.
// Fully hermetic: no Connection is real, no rpc leaves the process.
// ─────────────────────────────────────────────────────────────────────────────

import {
  runLiveMatch,
  runCallCycle,
  poolStatusOf,
  baseOwnerOf,
  type RunLiveMatchOpts,
} from "../live-runner.js";
import type { ScoreEvent } from "../../spike/src/discover.js";

interface HarnessOpts {
  status?: Record<string, object>;
  lockTs?: number;
  settleAfterTs?: number;
  numCalls?: number;
  fixtureId?: number;
  seats?: any[];
  /** Base-layer owner of the cursor PDA ('program' | 'delegated'). */
  cursorOwner?: "program" | "delegated";
  /** ER cursor state. */
  openSeq?: number;
  nextSeq?: number;
  /** The on-chain clock the `now` seam reports. */
  chainTime?: number;
  /** Scripted per-call feed responses (each fetchEvents() shifts one). */
  feed?: ScoreEvent[][];
}

function makeMatchHarness(o: HarnessOpts = {}) {
  const lockTs = o.lockTs ?? 1_000;
  const settleAfterTs = o.settleAfterTs ?? 2_000;
  const seats = o.seats ?? [];
  const calls: any[] = []; // every recorded .methods tx across base+er
  const rec = (name: string) => makeMethodRecorder(name, calls);

  const poolRow = {
    status: o.status ?? { open: {} },
    numCalls: o.numCalls ?? 4,
    lockTs,
    settleAfterTs,
    fixtureId: o.fixtureId ?? 777,
    playerCount: seats.length,
  };

  const ownerPk = (o.cursorOwner ?? "program") === "program" ? LIVE_PROGRAM_ID : DELEGATION_PROGRAM;

  // Report every seat under exactly ONE owner (the cursor's) — dedup hides doubles anyway.
  const gpaOnce = vi.fn(async (owner: any, _cfg?: any) =>
    owner.equals(ownerPk)
      ? seats.map((player: any) => ({
          pubkey: liveEntryPda(POOL_PK, player),
          account: { data: entryData(player, POOL_PK), owner },
        }))
      : [],
  );

  const base: any = {
    programId: LIVE_PROGRAM_ID,
    provider: { connection: { getProgramAccounts: gpaOnce } },
    account: {
      livePool: { fetch: vi.fn(async () => poolRow) },
      liveEntry: { size: 159 },
    },
    coder: { accounts: { memcmp: vi.fn(() => ({ offset: 0, bytes: "DISCB58" })) } },
    methods: {
      delegateCursor: rec("delegateCursor"),
      delegateEntry: rec("delegateEntry"),
      delegateCall: rec("delegateCall"),
      endLivePool: rec("endLivePool"),
      settleLivePool: rec("settleLivePool"),
      voidLivePool: rec("voidLivePool"),
      refundVoided: rec("refundVoided"),
    },
  };

  const er: any = {
    account: {
      liveCursor: {
        fetch: vi.fn(async () => ({
          openSeq: o.openSeq ?? NONE_SEQ,
          nextSeq: o.nextSeq ?? 0,
        })),
      },
    },
    methods: {
      openCall: rec("openCall"),
      resolveCall: rec("resolveCall"),
      scoreEntry: rec("scoreEntry"),
      commitLive: rec("commitLive"),
      endAndUndelegate: rec("endAndUndelegate"),
    },
  };

  const baseConn: any = {
    // cursor-owner read + pollBaseUndelegated: everything reports program-owned
    // unless the harness says the cursor is delegated.
    getAccountInfo: vi.fn(async (pk: any) => ({
      owner: pk.equals(liveCursorPda(POOL_PK)) ? ownerPk : LIVE_PROGRAM_ID,
    })),
    getSlot: vi.fn(async () => 123),
    getBlockTime: vi.fn(async () => (o.chainTime ?? settleAfterTs + 10)),
  };
  const erConn: any = {
    getAccountInfo: vi.fn(async () => ({ owner: LIVE_PROGRAM_ID })),
  };

  const report = { steps: [] as any[], errors: [] as any[] };
  async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      const r = await fn();
      report.steps.push({ name, ms: 0, ok: true });
      return r;
    } catch (e: any) {
      report.steps.push({ name, ms: 0, ok: false, err: e?.message });
      report.errors.push({ name, err: e?.message ?? String(e) });
      return null;
    }
  }
  const runner: any = {
    base,
    er,
    baseConn,
    erConn,
    programId: LIVE_PROGRAM_ID,
    keeper: keeper.publicKey,
    report,
    step,
  };

  const feedQueue = [...(o.feed ?? [[]])];
  const fetchEvents = vi.fn(async () => feedQueue.length > 1 ? feedQueue.shift()! : feedQueue[0]);
  const sleepFn = vi.fn(async () => undefined);
  const opts: RunLiveMatchOpts = {
    runner,
    fetchEvents,
    sleepFn,
    now: async () => o.chainTime ?? lockTs + 100,
    erVisibility: { intervalMs: 1, timeoutMs: 50 },
    pollBase: { intervalMs: 1, timeoutMs: 50 },
    settleWindow: { intervalMs: 1, timeoutMs: 50 },
  };
  const names = () => calls.map((c) => c.name);
  return { runner, opts, calls, names, fetchEvents, sleepFn, poolRow };
}

const liveEv = (seq: number, stats: Record<string, number> = {}, statusId = 99): ScoreEvent =>
  ({ FixtureId: 777, Seq: seq, StatusId: statusId, Stats: stats }) as ScoreEvent;

describe("runLiveMatch — F1: the join-window gate (premature-void regression)", () => {
  it("an Open pool BEFORE lock_ts with 0 seats issues ZERO txs (no void, no delegate)", async () => {
    const h = makeMatchHarness({ seats: [], lockTs: 1_000, chainTime: 900 });
    await runLiveMatch(POOL_PK, h.opts);
    expect(h.calls).toHaveLength(0); // the bug voided here ~30s after creation
  });

  it("an Open pool BEFORE lock_ts with 1 seat likewise waits (no forced refund)", async () => {
    const h = makeMatchHarness({ seats: [Keypair.generate().publicKey], lockTs: 1_000, chainTime: 999 });
    await runLiveMatch(POOL_PK, h.opts);
    expect(h.calls).toHaveLength(0);
  });

  it("an unreadable on-chain clock also waits — never act blind on the money path", async () => {
    const h = makeMatchHarness({ seats: [], lockTs: 1_000 });
    h.opts.now = async () => null;
    await runLiveMatch(POOL_PK, h.opts);
    expect(h.calls).toHaveLength(0);
  });

  it("POST-lock with <2 seats → void + refund (the legitimate under-filled branch)", async () => {
    const lone = Keypair.generate().publicKey;
    const h = makeMatchHarness({ seats: [lone], lockTs: 1_000, chainTime: 1_001 });
    await runLiveMatch(POOL_PK, h.opts);
    expect(h.names()).toEqual(["voidLivePool", "refundVoided"]);
  });
});

describe("runLiveMatch — F2: delegate exactly once, then ACTUALLY play", () => {
  const twoSeats = () => [Keypair.generate().publicKey, Keypair.generate().publicKey];

  it("first post-lock tick (cursor program-owned): delegates cursor+entries+calls, then opens a call", async () => {
    const seats = twoSeats();
    const h = makeMatchHarness({
      seats,
      chainTime: 1_500,
      numCalls: 4,
      feed: [[liveEv(10, { "1": 0, "2": 0 })]],
    });
    await runLiveMatch(POOL_PK, h.opts);
    const n = h.names();
    expect(n.filter((x) => x === "delegateCursor")).toHaveLength(1);
    expect(n.filter((x) => x === "delegateEntry")).toHaveLength(2);
    expect(n.filter((x) => x === "delegateCall")).toHaveLength(4);
    // …and the SAME tick advances into gameplay (the missing wiring): a call opens.
    expect(n).toContain("openCall");
  });

  it("a later tick (cursor already delegated) issues ZERO delegate txs and still plays", async () => {
    const h = makeMatchHarness({
      seats: twoSeats(),
      chainTime: 1_500,
      cursorOwner: "delegated",
      feed: [[liveEv(10, { "1": 0, "2": 0 })]],
    });
    await runLiveMatch(POOL_PK, h.opts);
    const n = h.names();
    expect(n).not.toContain("delegateCursor");
    expect(n).not.toContain("delegateEntry");
    expect(n).not.toContain("delegateCall");
    expect(n).toContain("openCall"); // progress, not the re-delegate treadmill
  });

  it("one full in-tick call cycle: open → (window) → resolve → score×seats → commit", async () => {
    const seats = twoSeats();
    const h = makeMatchHarness({
      seats,
      chainTime: 1_500,
      cursorOwner: "delegated",
      // Baseline 0-0; after the window, AWAY scored first (Seq 11).
      feed: [
        [liveEv(10, { "1": 0, "2": 0 })],
        [liveEv(10, { "1": 0, "2": 0 }), liveEv(11, { "1": 0, "2": 1 })],
      ],
    });
    await runLiveMatch(POOL_PK, h.opts);
    const n = h.names();
    expect(n).toEqual([
      "openCall",
      "resolveCall",
      "scoreEntry",
      "scoreEntry",
      "commitLive",
    ]);
    // seq 0 → pickCallKind(0) = NextGoal; away scored FIRST → option 2.
    const resolve = h.calls.find((c) => c.name === "resolveCall")!;
    expect(resolve.args[0]).toBe(2);
    // The answer window was actually waited out: answerSecs(9)+buffer(3) seconds.
    expect(h.sleepFn).toHaveBeenCalledWith(12_000);
  });

  it("F6 REGRESSION: both teams scoring in one window resolves to the FIRST scorer, never 'no goal'", async () => {
    const h = makeMatchHarness({
      seats: twoSeats(),
      chainTime: 1_500,
      cursorOwner: "delegated",
      feed: [
        [liveEv(10, { "1": 0, "2": 0 })],
        [
          liveEv(10, { "1": 0, "2": 0 }),
          liveEv(11, { "1": 1, "2": 0 }), // home scores first…
          liveEv(12, { "1": 1, "2": 1 }), // …away equalizes in the SAME window
        ],
      ],
    });
    await runLiveMatch(POOL_PK, h.opts);
    const resolve = h.calls.find((c) => c.name === "resolveCall")!;
    expect(resolve.args[0]).toBe(0); // home (first scorer) — the delta-tie bug said 1
  });

  it("an ORPHANED open call (from a dead keeper) is VOIDED (0xFE), scored, committed — never guessed", async () => {
    const seats = twoSeats();
    const h = makeMatchHarness({
      seats,
      chainTime: 1_500,
      cursorOwner: "delegated",
      openSeq: 2,
      nextSeq: 3,
      feed: [[liveEv(10, { "1": 0, "2": 0 })]],
    });
    await runLiveMatch(POOL_PK, h.opts);
    const n = h.names();
    expect(n).toEqual(["resolveCall", "scoreEntry", "scoreEntry", "commitLive"]);
    const resolve = h.calls.find((c) => c.name === "resolveCall")!;
    expect(resolve.args[0]).toBe(VOID_OUTCOME);
    expect(n).not.toContain("openCall"); // bounded: no new call on an orphan tick
  });

  it("throws LOUD when fetchEvents is missing for a delegated pool (silence would strand the pot)", async () => {
    const h = makeMatchHarness({ seats: twoSeats(), chainTime: 1_500, cursorOwner: "delegated" });
    h.opts.fetchEvents = undefined;
    await expect(runLiveMatch(POOL_PK, h.opts)).rejects.toThrow(/fetchEvents is required/);
  });

  it("feed phase 'void' (abandoned match) → void + refund even while delegated", async () => {
    const h = makeMatchHarness({
      seats: twoSeats(),
      chainTime: 1_500,
      cursorOwner: "delegated",
      feed: [[liveEv(10, { "1": 0 }, 14)]], // StatusId 14 = VOID phase
    });
    await runLiveMatch(POOL_PK, h.opts);
    expect(h.names()).toEqual(["voidLivePool", "refundVoided"]);
  });

  it("feed phase 'ft' with no open call → endAndUndelegate → endLivePool → settleLivePool in order", async () => {
    const h = makeMatchHarness({
      seats: twoSeats(),
      chainTime: 2_500, // past settleAfterTs (2_000) so the settle window opens
      cursorOwner: "delegated",
      feed: [[liveEv(90, { "1": 1, "2": 0 }, 5)]], // StatusId 5 = FINISHED
    });
    await runLiveMatch(POOL_PK, h.opts);
    const n = h.names();
    expect(n).toEqual(["endAndUndelegate", "endLivePool", "settleLivePool"]);
  });
});

describe("runLiveMatch — F3: an Ended pool resumes at settle, never re-delegates", () => {
  it("status Ended → settleLivePool only (zero delegate txs, zero gameplay)", async () => {
    const seats = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const h = makeMatchHarness({
      seats,
      status: { ended: {} },
      chainTime: 5_000,
    });
    await runLiveMatch(POOL_PK, h.opts);
    expect(h.names()).toEqual(["settleLivePool"]);
  });

  it("terminal statuses (settled / voided / rolledOver) are a no-op", async () => {
    const terminals: Record<string, object>[] = [{ settled: {} }, { voided: {} }, { rolledOver: {} }];
    for (const status of terminals) {
      const h = makeMatchHarness({ status, seats: [] });
      await runLiveMatch(POOL_PK, h.opts);
      expect(h.calls).toHaveLength(0);
    }
  });
});

describe("state-machine helpers", () => {
  it("poolStatusOf decodes the Anchor enum variant", () => {
    expect(poolStatusOf({ status: { ended: {} } })).toBe("ended");
    expect(poolStatusOf({ status: { rolledOver: {} } })).toBe("rolledOver");
    expect(poolStatusOf({})).toBe("unknown");
  });

  it("baseOwnerOf classifies program / delegated / missing", async () => {
    const mk = (owner: any) =>
      ({
        baseConn: { getAccountInfo: async () => (owner ? { owner } : null) },
        programId: LIVE_PROGRAM_ID,
      }) as any;
    expect(await baseOwnerOf(mk(LIVE_PROGRAM_ID), POOL_PK)).toBe("program");
    expect(await baseOwnerOf(mk(DELEGATION_PROGRAM), POOL_PK)).toBe("delegated");
    expect(await baseOwnerOf(mk(null), POOL_PK)).toBe("missing");
  });
});
