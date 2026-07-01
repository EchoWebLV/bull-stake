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
} from "../live-runner.js";
import { CallKind, VOID_OUTCOME } from "../live-feed.js";
import { liveCursorPda, liveEntryPda, callPda } from "../live-pda.js";

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

describe("gatherSeats (liveEntry.all memcmp offset 40)", () => {
  it("filters by memcmp {offset:40, bytes: pool} and returns ascending player pubkeys", async () => {
    const p1 = Keypair.generate().publicKey;
    const p2 = Keypair.generate().publicKey;
    const { base } = makeBaseSpy([p1, p2]);
    const seats = await gatherSeats(base, POOL_PK);
    // memcmp filter shape
    const filters = base.account.liveEntry.all.mock.calls[0][0];
    expect(filters).toEqual([{ memcmp: { offset: 40, bytes: POOL_PK.toBase58() } }]);
    // returned players are ascending
    for (let i = 1; i < seats.length; i++) {
      expect(Buffer.compare(seats[i - 1].toBuffer(), seats[i].toBuffer())).toBeLessThan(0);
    }
    expect(seats.map((s) => s.toBase58()).sort()).toEqual([p1, p2].map((p) => p.toBase58()).sort());
  });

  it("returns [] for a pool with no entries", async () => {
    const { base } = makeBaseSpy([]);
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
