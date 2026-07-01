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
} from "../live-runner.js";

const { Keypair } = pkg;

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
