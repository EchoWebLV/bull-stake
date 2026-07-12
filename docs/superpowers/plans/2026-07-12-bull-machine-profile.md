# Bull Machine → Profile PFP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A logged-in Bull Stake user opens Profile (Wallet tab), spins the hand-drawn 3×3 Bull Machine on devnet (one Privy approval, then gasless ER spins), a provably-fair unique bull NFT mints into their Privy wallet, and they set it as their profile picture (shown in Profile + LoginBar chip).

**Architecture:** Port the devnet-proven SOL bulls ER bridge (`~/Documents/GitHub/SOL bulls/demo/er-chain.src.js`) into `web/src/lib/bullMachine.ts` as a small client class — Privy supplies only `signAndSend` for the ONE open-session transaction; spins are session-key-signed straight to the MagicBlock ER node (router-discovered); cash-out is cranked by the session key and mints to the player. Bull images are composed client-side on a canvas from trait layers (`manifest.json` + `layers/`). A tiny localStorage profile store propagates the PFP.

**Tech Stack:** React 18 + Vite (Buffer polyfilled via vite-plugin-node-polyfills), `@coral-xyz/anchor` 0.32.1, `@solana/web3.js` 1.98.4, Privy (`usePrivySigner`), vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-bull-machine-profile-design.md`

---

## Preconditions & deviations (authoritative)

- **P1 — Run AFTER the current working tree is committed** (TxODDS WS1). Do not mix this feature's commits with the pending rename/perf work. Capture windows (Jul 14/15 19:00 UTC) take absolute precedence over this plan on any conflict.
- **D1 — Live-HUD avatar is deferred to the WS3 mascot-slot work.** This plan ships the PFP in Profile + LoginBar chip and exposes `usePfp()`; WS3's avatar slots consume it (`pfp ?? mascot`). LiveMatchView is not touched here.
- **D2 — Session keys and PFP state live in localStorage** exactly like the proven demo (devnet-acceptable; custody caveat documented in the spec).
- **D3 — RPC endpoints:** L1 = the shared Helius `connection` from `web/src/lib/anchorClient.ts` (NOT the public devnet RPC the demo fought 429s on). ER = per-session node discovered via `https://devnet-router.magicblock.app` (do NOT reuse `erConnection` — that is the live game's fixed endpoint; bull sessions may be assigned a different node).

## File structure

- Create: `web/src/idl/bull_machine.er.json` (copy from SOL bulls)
- Create: `web/public/bull/manifest.json`, `web/public/bull/layers/*.png`, `web/public/bull/tiles/*.png` (copy)
- Create: `web/src/lib/bullArt.ts` — manifest types + trait→layer paths + canvas compositor
- Create: `web/test/bullArt.test.ts`
- Create: `web/src/lib/bullMachine.ts` — layout decode, PDAs, cost math, ER discovery, client class
- Create: `web/test/bullMachine.test.ts`
- Create: `web/src/lib/profile.ts` — PFP store + `usePfp` hook
- Create: `web/test/profile.test.ts`
- Create: `web/src/components/BullMachine.tsx` — hand-drawn 3×3 overlay
- Modify: `web/src/components/WalletView.tsx` — Profile header section + machine entry
- Modify: `web/src/components/LoginBar.tsx` — chip shows PFP thumb when set
- Modify: `web/src/App.css` — `.bullm-*` styles

---

### Task 1: Assets + IDL copy

**Files:**
- Create: `web/src/idl/bull_machine.er.json`
- Create: `web/public/bull/` (manifest + layers + tiles)

- [ ] **Step 1: Copy the IDL and art assets**

```bash
cd /Users/yordanlasonov/Documents/GitHub/ProofBet
cp "/Users/yordanlasonov/Documents/GitHub/SOL bulls/demo/bull_machine.er.json" web/src/idl/bull_machine.er.json
mkdir -p web/public/bull
cp "/Users/yordanlasonov/Documents/GitHub/SOL bulls/demo/textures/manifest.json" web/public/bull/
cp -R "/Users/yordanlasonov/Documents/GitHub/SOL bulls/demo/textures/layers" web/public/bull/layers
cp -R "/Users/yordanlasonov/Documents/GitHub/SOL bulls/demo/textures/tiles" web/public/bull/tiles
```

- [ ] **Step 2: Verify the copy**

Run: `node -e "const i=require('./web/src/idl/bull_machine.er.json');console.log(i.address)" && ls web/public/bull/layers | wc -l && ls web/public/bull/tiles | wc -l`
Expected: `CHRm6pgBYXHSW1xWYT8YKNfKXhM1LorGm2yMKxLdQy6i`, then two non-zero counts (~181 each).

- [ ] **Step 3: Commit**

```bash
git add web/src/idl/bull_machine.er.json web/public/bull
git commit -m "feat(web): vendor bull_machine ER IDL + trait art (manifest/layers/tiles)"
```

---

### Task 2: bullArt — manifest mapping + compositor

**Files:**
- Create: `web/src/lib/bullArt.ts`
- Test: `web/test/bullArt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/test/bullArt.test.ts
import { describe, expect, it } from "vitest";
import { traitLayerPaths, traitTilePath, type BullManifest } from "../src/lib/bullArt.ts";

const MANIFEST: BullManifest = [
  { name: "Background", traits: [
    { name: "Blue", weight: 1, tile: "tiles/c0_t0.png", layer: "layers/c0_t0.png" },
    { name: "Brown", weight: 1, tile: "tiles/c0_t1.png", layer: "layers/c0_t1.png" },
  ]},
  { name: "Body", traits: [
    { name: "Tan", weight: 1, tile: "tiles/c1_t0.png", layer: "layers/c1_t0.png" },
  ]},
];

describe("traitLayerPaths", () => {
  it("maps trait indices to layer paths in category order", () => {
    expect(traitLayerPaths(MANIFEST, [1, 0])).toEqual([
      "/bull/layers/c0_t1.png",
      "/bull/layers/c1_t0.png",
    ]);
  });
  it("ignores trailing indices beyond the manifest categories (on-chain traits are padded to 9)", () => {
    expect(traitLayerPaths(MANIFEST, [1, 0, 0, 0, 0, 0, 0, 0, 0])).toHaveLength(2);
  });
  it("throws on an out-of-range trait index", () => {
    expect(() => traitLayerPaths(MANIFEST, [9, 0])).toThrow(/out of range/);
  });
});

describe("traitTilePath", () => {
  it("maps (category, trait) to the tile path", () => {
    expect(traitTilePath(MANIFEST, 0, 1)).toBe("/bull/tiles/c0_t1.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/bullArt.test.ts`
Expected: FAIL — cannot resolve `../src/lib/bullArt.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/lib/bullArt.ts
/* Bull art pipeline — mirrors the SOL bulls demo: on-chain trait indices (9 bytes,
 * padded) map positionally onto manifest categories; the bull image is the
 * category layers stacked in order on a canvas. Assets live in /bull (vendored). */

export type BullTrait = { name: string; weight: number; tile: string; layer: string };
export type BullCategory = { name: string; traits: BullTrait[] };
export type BullManifest = BullCategory[];

const BASE = "/bull/";

let _manifest: BullManifest | null = null;
export async function loadManifest(): Promise<BullManifest> {
  if (_manifest) return _manifest;
  const res = await fetch(`${BASE}manifest.json`);
  if (!res.ok) throw new Error(`manifest load failed: ${res.status}`);
  _manifest = (await res.json()) as BullManifest;
  return _manifest;
}

/** Trait indices → ordered layer asset paths. Extra indices beyond the manifest
 *  (on-chain pads to 9) are ignored; an out-of-range index is a real error. */
export function traitLayerPaths(manifest: BullManifest, traits: number[]): string[] {
  return manifest.map((cat, ci) => {
    const ti = traits[ci];
    const t = cat.traits[ti];
    if (t === undefined) throw new Error(`trait index out of range: category ${ci} (${cat.name}) index ${ti}`);
    return BASE + t.layer;
  });
}

export function traitTilePath(manifest: BullManifest, category: number, trait: number): string {
  const t = manifest[category]?.traits[trait];
  if (!t) throw new Error(`trait index out of range: category ${category} index ${trait}`);
  return BASE + t.tile;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${src}`));
    img.src = src;
  });
}

/** Compose the bull onto a square canvas and return a PNG data URL.
 *  Browser-only (canvas); callers cache the result. */
export async function composeBull(traits: number[], size = 512): Promise<string> {
  const manifest = await loadManifest();
  const layers = await Promise.all(traitLayerPaths(manifest, traits).map(loadImg));
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  for (const img of layers) ctx.drawImage(img, 0, 0, size, size);
  return c.toDataURL("image/png");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run test/bullArt.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/bullArt.ts web/test/bullArt.test.ts
git commit -m "feat(web): bullArt — trait→layer mapping + canvas bull compositor"
```

---

### Task 3: bullMachine — constants, PDAs, session layout, cost math

**Files:**
- Create: `web/src/lib/bullMachine.ts`
- Test: `web/test/bullMachine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/bullMachine.test.ts`
Expected: FAIL — cannot resolve `../src/lib/bullMachine.ts`.

- [ ] **Step 3: Write the module (part 1 — pure layer)**

```ts
// web/src/lib/bullMachine.ts
/* Bull Machine client — port of the devnet-proven SOL bulls ER bridge
 * (demo/er-chain.src.js, VERDICT GREEN). One Privy-signed tx opens+delegates a
 * session; spins are session-key-signed straight to the MagicBlock ER node;
 * cash-out is cranked by the session key and mints bulls to the player.
 * L1 = shared Helius `connection`; the ER node is discovered per-delegation
 * via the MagicBlock router (NOT the live game's fixed `erConnection`). */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "../idl/bull_machine.er.json";
import { connection } from "./anchorClient.ts";

export const BULL_PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const ROUTER = "https://devnet-router.magicblock.app";
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

// Extra L1 top-up so the session key can crank settle_mint per bull; leftovers
// sweep back to the player at cash-out. Mirrors the bridge constants.
const CRANK_LAMPORTS_PER_SPIN = 10_000_000;
const CRANK_LAMPORTS_BASE = 5_000_000;
const SESSION_KEY_TOPUP = 20_000_000;
const RENT_FEES_MARGIN = 15_000_000;

// Frozen Session layout (SOL bulls litesvm layout.rs).
const SES_CREDITS_TOTAL = 72, SES_CREDITS_USED = 73, SES_SETTLED = 74;
const SES_SPINS = 75, SPIN_STRIDE = 50, SES_EXPIRES_AT = 583, SES_LEN = 592;
export const STATUS = { EMPTY: 0, PENDING: 1, ROLLED: 2, SETTLED: 3 } as const;

const seed = (...parts: Buffer[]) => PublicKey.findProgramAddressSync(parts, BULL_PROGRAM_ID)[0];
export const configPda = () => seed(Buffer.from("config"));
export const sessionPda = (player: PublicKey) => seed(Buffer.from("session"), player.toBuffer());
export const claimPda = (traits: number[]) => seed(Buffer.from("claim"), Buffer.from(traits));
export const identityPda = () => seed(Buffer.from("identity"));
export const authorityPda = () => seed(Buffer.from("authority"));

type IdlShape = { instructions: { name: string; discriminator: number[] }[] };
const spinDisc = Uint8Array.from(
  (idl as unknown as IdlShape).instructions.find((i) => i.name === "spin")!.discriminator,
);

export type SpinSlot = { status: number; traits: number[]; randomness: number[] };
export type SessionData = {
  creditsTotal: number; creditsUsed: number; settled: number;
  spins: SpinSlot[]; expiresAt: number;
};

export function decodeSession(d: Uint8Array): SessionData {
  const base = (i: number) => SES_SPINS + i * SPIN_STRIDE;
  const spins = Array.from({ length: 10 }, (_, i) => ({
    status: d[base(i)],
    traits: Array.from(d.subarray(base(i) + 1, base(i) + 10)),
    randomness: Array.from(d.subarray(base(i) + 18, base(i) + 50)),
  }));
  return {
    creditsTotal: d[SES_CREDITS_TOTAL], creditsUsed: d[SES_CREDITS_USED], settled: d[SES_SETTLED],
    spins,
    expiresAt: Number(new DataView(d.buffer, d.byteOffset + SES_EXPIRES_AT, 8).getBigInt64(0, true)),
  };
}

/** Full devnet-SOL cost of opening an n-spin session (bridge preflight math). */
export function openCostLamports(nSpins: number, spinPrice: bigint): number {
  return Number(spinPrice) * nSpins + SESSION_KEY_TOPUP
    + CRANK_LAMPORTS_BASE + nSpins * CRANK_LAMPORTS_PER_SPIN + RENT_FEES_MARGIN;
}

export type SessionView = {
  creditsTotal: number; creditsUsed: number; creditsLeft: number; settled: number;
  rolledUnsettled: number; expired: boolean; closeable: boolean; active: boolean;
  spins: SpinSlot[];
};

/** Pure UI summary of a decoded session (testable without RPC). */
export function deriveSessionView(
  s: SessionData,
  ctx: { delegated: boolean; sessionKeyHeld: boolean; now: number },
): SessionView {
  const rolled = s.spins.filter((sp) => sp.status === STATUS.ROLLED).length;
  return {
    creditsTotal: s.creditsTotal, creditsUsed: s.creditsUsed, settled: s.settled,
    creditsLeft: s.creditsTotal - s.creditsUsed,
    rolledUnsettled: rolled,
    expired: ctx.now > s.expiresAt,
    spins: s.spins,
    closeable: !ctx.delegated && s.spins.every((sp) => sp.status === STATUS.EMPTY || sp.status === STATUS.SETTLED),
    active: ctx.delegated && ctx.sessionKeyHeld && s.creditsTotal - s.creditsUsed > 0 && ctx.now <= s.expiresAt,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run test/bullMachine.test.ts`
Expected: PASS (4 test groups).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/bullMachine.ts web/test/bullMachine.test.ts
git commit -m "feat(web): bullMachine pure layer — frozen session layout, PDAs, open-cost math"
```

---

### Task 4: bullMachine — client class (open / spin / reveal / cash-out)

**Files:**
- Modify: `web/src/lib/bullMachine.ts` (append)

- [ ] **Step 1: Append the chain-bound client (port of the proven recipes)**

```ts
// ── appended to web/src/lib/bullMachine.ts ──────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skStoreKey = (player: PublicKey) => `bullstake:sk:${BULL_PROGRAM_ID.toBase58()}:${player.toBase58()}`;

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
  let wait = 1_200;
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = /429|Too many requests|rate.?limit|Failed to fetch|load failed/i.test(String((e as Error)?.message ?? e));
      if (!transient || i >= attempts) throw e;
      await sleep(wait); wait *= 2;
    }
  }
}

async function confirmSig(c: Connection, sig: string, label: string, timeoutMs = 40_000): Promise<void> {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    let st = null;
    try { st = (await c.getSignatureStatus(sig)).value; } catch { /* transient — keep polling */ }
    if (st) {
      if (st.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
    }
    await sleep(300);
  }
  throw new Error(`${label}: not confirmed in ${timeoutMs / 1000}s`);
}

/** Signed entirely by local keypairs (session key / asset). */
async function sendLocal(c: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
  return withRetry(async () => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    let sig: string;
    try {
      sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    } catch (e) {
      const logs = (e as { logs?: string[] })?.logs;
      throw new Error(`${label}: ${(e as Error).message}${logs ? " — " + logs.slice(-3).join(" | ") : ""}`);
    }
    await confirmSig(c, sig, label);
    return sig;
  }, label);
}

export type MintResult = { slot: number; dna: string; traits?: number[]; asset: string | null };
export type CashOutStep = "finalize" | "undelegate" | "discard" | "mint" | "sweep" | "done";
export type MachineState =
  | { exists: false; delegated: false; sessionKeyHeld: boolean }
  | ({ exists: true; delegated: boolean; sessionKeyHeld: boolean } & SessionView);

/** One instance per connected player. `signAndSend` is usePrivySigner().signAndSend
 *  — it stamps a fresh blockhash, signs via Privy, broadcasts on the Helius
 *  connection, and confirms. It is used EXACTLY twice: openSession, closeSession. */
export class BullMachineClient {
  private player: PublicKey;
  private signAndSend: (tx: Transaction) => Promise<string>;
  private program: anchor.Program;
  private sessionKey: Keypair | null;
  private er: Connection | null = null;
  private cfg: { treasury: PublicKey; collection: PublicKey; spinPrice: bigint } | null = null;

  constructor(playerAddress: string, signAndSend: (tx: Transaction) => Promise<string>) {
    this.player = new PublicKey(playerAddress);
    this.signAndSend = signAndSend;
    const dummy = {
      publicKey: this.player,
      signTransaction: async (t: Transaction) => t,
      signAllTransactions: async (t: Transaction[]) => t,
    } as anchor.Wallet;
    this.program = new anchor.Program(
      idl as anchor.Idl,
      new anchor.AnchorProvider(connection, dummy, { commitment: "confirmed" }),
    );
    const raw = localStorage.getItem(skStoreKey(this.player));
    this.sessionKey = raw ? Keypair.fromSecretKey(Buffer.from(raw, "base64")) : null;
  }

  sessionKeyHeld(): boolean { return !!this.sessionKey; }

  private storeSessionKey(kp: Keypair): void {
    localStorage.setItem(skStoreKey(this.player), Buffer.from(kp.secretKey).toString("base64"));
  }
  private dropSessionKey(): void {
    localStorage.removeItem(skStoreKey(this.player));
    this.sessionKey = null;
  }

  async config(): Promise<{ treasury: PublicKey; collection: PublicKey; spinPrice: bigint }> {
    if (!this.cfg) {
      const c = await (this.program.account as Record<string, { fetch: (pda: PublicKey) => Promise<Record<string, unknown>> }>)
        .config.fetch(configPda());
      this.cfg = {
        treasury: c.treasury as PublicKey,
        collection: c.collection as PublicKey,
        spinPrice: BigInt((c.spinPrice as anchor.BN).toString()),
      };
    }
    return this.cfg;
  }

  private async rawSession(c: Connection): Promise<{ owner: PublicKey; data: SessionData } | null> {
    const acc = await c.getAccountInfo(sessionPda(this.player), "confirmed").catch(() => null);
    if (!acc || acc.data.length < SES_LEN) return null;
    return { owner: acc.owner, data: decodeSession(acc.data) };
  }

  /** Discover this session's ER node via the MagicBlock router (retries — the
   *  router can lag a moment behind a fresh delegation). */
  private async ensureEr(): Promise<Connection> {
    if (this.er) return this.er;
    const session = sessionPda(this.player).toBase58();
    for (let tries = 0; tries < 20; tries++) {
      const resp = await fetch(`${ROUTER}/getDelegationStatus`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [session] }),
      });
      const fqdn = (await resp.json())?.result?.fqdn as string | undefined;
      if (fqdn) { this.er = new Connection(fqdn, "confirmed"); return this.er; }
      await sleep(500);
    }
    throw new Error("MagicBlock router reports no ER delegation for this session");
  }

  /** Combined view the UI drives from (L1 for existence/delegation; ER when live). */
  async fetchState(): Promise<MachineState> {
    const l1 = await this.rawSession(connection);
    if (!l1) return { exists: false, delegated: false, sessionKeyHeld: this.sessionKeyHeld() };
    const delegated = l1.owner.equals(DELEGATION_PROGRAM);
    let live = l1.data;
    if (delegated) {
      try { live = (await this.rawSession(await this.ensureEr()))?.data ?? l1.data; }
      catch { /* router/ER unreachable — the L1 snapshot is still meaningful */ }
    }
    const view = deriveSessionView(live, {
      delegated, sessionKeyHeld: this.sessionKeyHeld(), now: Math.floor(Date.now() / 1000),
    });
    return { exists: true, delegated, sessionKeyHeld: this.sessionKeyHeld(), ...view };
  }

  /** THE one Privy approval: (close spent session +) create + fund + delegate. */
  async openSession(nSpins: number): Promise<string> {
    if (!Number.isInteger(nSpins) || nSpins < 1 || nSpins > 10) throw new Error("session size must be 1–10 spins");
    const cfg = await this.config();
    const need = openCostLamports(nSpins, cfg.spinPrice);
    const bal = await withRetry(() => connection.getBalance(this.player, "confirmed"), "balance check");
    if (bal < need) {
      const fmt = (l: number) => (l / 1e9).toFixed(2);
      throw new Error(`need ~${fmt(need)} devnet SOL for ${nSpins} spin${nSpins > 1 ? "s" : ""}, wallet has ${fmt(bal)} — fund via a devnet faucet`);
    }
    const st = await this.fetchState();
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
    if (st.exists) {
      if (!st.closeable) throw new Error("a live session already exists — finish or cash it out first");
      ixs.push(await this.program.methods.closeSession().accounts({
        closer: this.player, config: configPda(),
        session: sessionPda(this.player), player: this.player,
      }).instruction());
    }
    const sk = Keypair.generate();
    this.storeSessionKey(sk); // persist BEFORE funds move — reload-safe recovery
    const session = sessionPda(this.player);
    const [bufferSession] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), session.toBuffer()], BULL_PROGRAM_ID);
    const [delRec] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), session.toBuffer()], DELEGATION_PROGRAM);
    const [delMeta] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), session.toBuffer()], DELEGATION_PROGRAM);
    ixs.push(
      await this.program.methods.createSession(nSpins, sk.publicKey).accounts({
        player: this.player, config: configPda(), session,
        sessionKey: sk.publicKey, systemProgram: SystemProgram.programId,
      }).instruction(),
      SystemProgram.transfer({
        fromPubkey: this.player, toPubkey: sk.publicKey,
        lamports: CRANK_LAMPORTS_BASE + nSpins * CRANK_LAMPORTS_PER_SPIN,
      }),
      await this.program.methods.delegateSession().accountsPartial({
        player: this.player, bufferSession, delegationRecordSession: delRec,
        delegationMetadataSession: delMeta, session,
        ownerProgram: BULL_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM,
        systemProgram: SystemProgram.programId,
      }).instruction(),
    );
    const tx = new Transaction().add(...ixs);
    tx.feePayer = this.player; // usePrivySigner stamps the fresh blockhash
    const sig = await this.signAndSend(tx);
    this.sessionKey = sk;
    this.er = null; // fresh delegation → rediscover the ER node
    await this.ensureEr();
    return sig;
  }

  /** Gasless spin — session-key-signed, direct to the ER node. Returns the slot index. */
  async spin(): Promise<number> {
    if (!this.sessionKey) throw new Error("no session key held — open a session first");
    const er = await this.ensureEr();
    const before = await this.rawSession(er);
    const ix = new TransactionInstruction({
      programId: BULL_PROGRAM_ID,
      keys: [ // frozen DoSpin order, devnet-proven
        { pubkey: this.sessionKey.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda(), isSigner: false, isWritable: false },
        { pubkey: sessionPda(this.player), isSigner: false, isWritable: true },
        { pubkey: EPHEMERAL_QUEUE, isSigner: false, isWritable: true },
        { pubkey: identityPda(), isSigner: false, isWritable: false },
        { pubkey: VRF_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(spinDisc),
    });
    await sendLocal(er, [ix], [this.sessionKey], "spin (ER)");
    const after = await this.rawSession(er);
    if (!after) throw new Error("session unreadable on the ER after spin");
    const i = after.data.spins.findIndex((sp, k) =>
      sp.status !== STATUS.EMPTY && (before?.data.spins[k]?.status ?? STATUS.EMPTY) === STATUS.EMPTY);
    if (i < 0) throw new Error("could not identify the new spin slot");
    return i;
  }

  /** ER VRF typically resolves in well under a second. Returns the 9 trait indices. */
  async pollRolled(i: number, { intervalMs = 250, budgetMs = 60_000 } = {}): Promise<number[]> {
    const er = await this.ensureEr();
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const s = await this.rawSession(er);
      const sp = s?.data.spins[i];
      if (sp?.status === STATUS.ROLLED) return sp.traits.slice(0, 9);
      if (Date.now() > deadline) throw new Error("VRF timed out in the ER — the spin is still pending");
      await sleep(intervalMs);
    }
  }

  /** Clear a stuck PENDING slot (permissionless; session key pays the ER fee). */
  async cancelSpin(i: number): Promise<void> {
    if (!this.sessionKey) throw new Error("no session key held");
    const er = await this.ensureEr();
    const ix = await this.program.methods.cancelSpin(i).accounts({
      session: sessionPda(this.player), player: this.player,
    }).instruction();
    await sendLocal(er, [ix], [this.sessionKey], "cancel spin (ER)");
  }

  /** Cash-out: finalize (ER) → undelegate → mint every ROLLED bull (L1) → sweep.
   *  Zero player signatures; idempotent per slot (only ROLLED slots mint). */
  async cashOut(onStep: (stage: CashOutStep, info?: { slot?: number; done?: number; mints?: MintResult[] }) => void = () => {}): Promise<MintResult[]> {
    if (!this.sessionKey) throw new Error("no session key held — cannot crank the cash-out");
    const session = sessionPda(this.player);
    const st = await this.fetchState();

    if (st.exists && st.delegated) {
      onStep("finalize");
      const er = await this.ensureEr();
      const finalizeIx = await this.program.methods.finalize()
        .accounts({ payer: this.sessionKey.publicKey, session }).instruction();
      await sendLocal(er, [finalizeIx], [this.sessionKey], "finalize (ER)");

      onStep("undelegate");
      const t = Date.now();
      for (;;) {
        const acc = await connection.getAccountInfo(session, "confirmed").catch(() => null);
        if (acc?.owner.equals(BULL_PROGRAM_ID)) break;
        if (Date.now() - t > 60_000) throw new Error("session did not undelegate back to L1 in 60s — your bulls are safe; retry cash-out");
        await sleep(500);
      }
    }

    const cfg = await this.config();
    const s = await this.rawSession(connection);
    if (!s) throw new Error("session unreadable on L1 after undelegation");
    const mints: MintResult[] = [];
    for (let i = 0; i < 10; i++) {
      if (s.data.spins[i].status !== STATUS.ROLLED) continue;
      const traits = s.data.spins[i].traits;
      const claim = claimPda(traits);
      const claimAcc = await withRetry(() => connection.getAccountInfo(claim, "confirmed"), "claim check");
      if (claimAcc && claimAcc.owner.equals(BULL_PROGRAM_ID)) { // duplicate combo (cosmically rare) → discard
        onStep("discard", { slot: i });
        const ix = await this.program.methods.discardSpin(i)
          .accounts({ session, player: this.player, claim }).instruction();
        await sendLocal(connection, [ix], [this.sessionKey], `discard spin ${i}`);
        mints.push({ slot: i, dna: traits.join("-"), asset: null });
        continue;
      }
      onStep("mint", { slot: i, done: mints.length });
      const asset = Keypair.generate();
      const ix = await this.program.methods.settleMint(i).accountsStrict({
        payer: this.sessionKey.publicKey, config: configPda(), session,
        player: this.player, treasury: cfg.treasury, claim,
        asset: asset.publicKey, collection: cfg.collection, collectionAuthority: authorityPda(),
        systemProgram: SystemProgram.programId, mplCoreProgram: MPL_CORE,
      }).instruction();
      await sendLocal(connection, [ix], [this.sessionKey, asset], `mint bull (slot ${i})`);
      mints.push({ slot: i, dna: traits.join("-"), traits: [...traits], asset: asset.publicKey.toBase58() });
    }

    onStep("sweep"); // best-effort: a failed sweep must never fail the cash-out
    try {
      const bal = await withRetry(() => connection.getBalance(this.sessionKey!.publicKey, "confirmed"), "sweep balance");
      if (bal > 1_000_000) {
        const ix = SystemProgram.transfer({
          fromPubkey: this.sessionKey!.publicKey, toPubkey: this.player, lamports: bal - 5_000,
        });
        await sendLocal(connection, [ix], [this.sessionKey!], "sweep session key");
      }
      this.dropSessionKey(); // spent — a new session mints a fresh one
    } catch { /* leftovers stay on the session key; retried next run */ }
    onStep("done", { mints });
    return mints;
  }

  /** Player reclaims session rent + unused-credit lamports (the one closing signature). */
  async closeSession(): Promise<string> {
    const ix = await this.program.methods.closeSession().accounts({
      closer: this.player, config: configPda(),
      session: sessionPda(this.player), player: this.player,
    }).instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = this.player;
    const sig = await this.signAndSend(tx);
    this.dropSessionKey();
    return sig;
  }
}

export const bullExplorerUrl = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
```

- [ ] **Step 2: Typecheck + full web suite (no new unit tests — chain-bound code; the pure layer is already covered)**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: typecheck clean; all suites pass (existing + bullArt + bullMachine).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/bullMachine.ts
git commit -m "feat(web): BullMachineClient — one-approval open, ER spins, crank cash-out to Privy wallet"
```

---

### Task 5: profile store + usePfp hook

**Files:**
- Create: `web/src/lib/profile.ts`
- Test: `web/test/profile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/test/profile.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPfp, setPfp, clearPfp, subscribePfp } from "../src/lib/profile.ts";

beforeEach(() => localStorage.clear());

describe("profile pfp store", () => {
  it("returns null when unset", () => {
    expect(getPfp("addr1")).toBeNull();
  });
  it("stores and returns the bull per wallet", () => {
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(getPfp("addr1")?.asset).toBe("As5et");
    expect(getPfp("addr2")).toBeNull();
  });
  it("clears", () => {
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    clearPfp("addr1");
    expect(getPfp("addr1")).toBeNull();
  });
  it("notifies subscribers on set/clear", () => {
    const cb = vi.fn();
    const off = subscribePfp(cb);
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    clearPfp("addr1");
    off();
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run test/profile.test.ts`
Expected: FAIL — cannot resolve `../src/lib/profile.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// web/src/lib/profile.ts
/* Profile picture store — which minted bull this wallet shows as its PFP.
 * localStorage per wallet (devnet demo custody model, same as session keys);
 * subscribers make the LoginBar chip / views react in-tab. */
import { useEffect, useState } from "react";

export type Pfp = { asset: string; traits: number[]; setAt?: number };

const key = (address: string) => `bullstake:pfp:${address}`;
const subs = new Set<() => void>();
const notify = () => { for (const cb of subs) cb(); };

export function getPfp(address: string): Pfp | null {
  const raw = localStorage.getItem(key(address));
  if (!raw) return null;
  try { return JSON.parse(raw) as Pfp; } catch { return null; }
}

export function setPfp(address: string, pfp: Pfp): void {
  localStorage.setItem(key(address), JSON.stringify({ ...pfp, setAt: pfp.setAt ?? Date.now() }));
  notify();
}

export function clearPfp(address: string): void {
  localStorage.removeItem(key(address));
  notify();
}

export function subscribePfp(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The wallet's current PFP (reactive). null = fall back to the mascot. */
export function usePfp(address: string | undefined): Pfp | null {
  const [pfp, set] = useState<Pfp | null>(() => (address ? getPfp(address) : null));
  useEffect(() => {
    set(address ? getPfp(address) : null);
    return subscribePfp(() => set(address ? getPfp(address) : null));
  }, [address]);
  return pfp;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run test/profile.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/profile.ts web/test/profile.test.ts
git commit -m "feat(web): profile store — per-wallet bull PFP with subscribe hook"
```

---

### Task 6: BullMachine overlay component (hand-drawn 3×3)

**Files:**
- Create: `web/src/components/BullMachine.tsx`
- Modify: `web/src/App.css` (append `.bullm-*` styles)

- [ ] **Step 1: Write the component**

```tsx
// web/src/components/BullMachine.tsx
/* The Bull Machine — hand-drawn 3×3 mint machine (devnet). One Privy approval
 * opens an n-spin session; the lever is the one action; VRF lands in the ER in
 * under a second; cash-out mints every rolled bull to the player's wallet.
 * Ported UX law from the SOL bulls demo: the lever is the ONE action. */
import { useEffect, useMemo, useRef, useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import {
  BullMachineClient, type MachineState, type MintResult, bullExplorerUrl,
} from "../lib/bullMachine.ts";
import { composeBull, loadManifest, traitTilePath, type BullManifest } from "../lib/bullArt.ts";
import { setPfp } from "../lib/profile.ts";

type Phase =
  | { k: "idle" }
  | { k: "opening" }
  | { k: "ready"; creditsLeft: number }
  | { k: "spinning" }
  | { k: "rolled"; traits: number[]; img: string; creditsLeft: number }
  | { k: "cashing"; note: string }
  | { k: "done"; mints: MintResult[]; imgs: Record<string, string> }
  | { k: "error"; msg: string; retry?: () => void };

const GRID_CATS = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // 3×3 = first 9 manifest categories

export function BullMachine({ onClose }: { onClose: () => void }) {
  const { address, signAndSend } = usePrivySigner();
  const client = useMemo(
    () => (address ? new BullMachineClient(address, signAndSend) : null),
    // usePrivySigner returns fresh closures each render; the client only needs one
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address],
  );
  const [manifest, setManifest] = useState<BullManifest | null>(null);
  const [state, setState] = useState<MachineState | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [price, setPrice] = useState<bigint | null>(null);
  const [nSpins, setNSpins] = useState(1);
  const [reel, setReel] = useState<number[]>([0, 3, 6, 1, 4, 7, 2, 5, 8]); // tile indices while spinning
  const spinAnim = useRef<number | null>(null);

  useEffect(() => { loadManifest().then(setManifest).catch(() => setManifest(null)); }, []);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    Promise.all([client.fetchState(), client.config()])
      .then(([st, cfg]) => { if (!alive) return; setState(st); setPrice(cfg.spinPrice);
        if (st.exists && st.delegated && st.sessionKeyHeld && "creditsLeft" in st && st.creditsLeft > 0) setPhase({ k: "ready", creditsLeft: st.creditsLeft });
      })
      .catch((e) => alive && setPhase({ k: "error", msg: (e as Error).message }));
    return () => { alive = false; };
  }, [client]);

  // tile shuffle while spinning — pure theater; the chain result lands the reveal
  useEffect(() => {
    if (phase.k !== "spinning" || !manifest) return;
    const id = window.setInterval(() =>
      setReel((r) => r.map((_, i) => Math.floor(Math.random() * manifest[GRID_CATS[i]].traits.length))), 90);
    spinAnim.current = id;
    return () => window.clearInterval(id);
  }, [phase.k, manifest]);

  if (!address) return null;

  const fmtSol = (l: number | bigint) => (Number(l) / 1e9).toFixed(3);
  const openCost = price == null ? null : fmtSol(Number(price) * nSpins + 40_000_000 + nSpins * 10_000_000);

  async function open() {
    if (!client) return;
    setPhase({ k: "opening" });
    try {
      await client.openSession(nSpins);
      const st = await client.fetchState();
      setState(st);
      setPhase({ k: "ready", creditsLeft: "creditsLeft" in st ? st.creditsLeft : nSpins });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message, retry: open });
    }
  }

  async function pullLever() {
    if (!client) return;
    setPhase({ k: "spinning" });
    try {
      const slot = await client.spin();
      const traits = await client.pollRolled(slot);
      const img = await composeBull(traits, 512);
      const st = await client.fetchState();
      setState(st);
      setPhase({ k: "rolled", traits, img, creditsLeft: "creditsLeft" in st ? st.creditsLeft : 0 });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message, retry: pullLever });
    }
  }

  async function cashOut() {
    if (!client) return;
    setPhase({ k: "cashing", note: "finalizing…" });
    try {
      const mints = await client.cashOut((stage, info) => {
        const notes: Record<string, string> = {
          finalize: "sealing your spins in the rollup…",
          undelegate: "bringing your session home…",
          discard: "cosmic duplicate — discarding…",
          mint: `minting bull ${((info?.done ?? 0) + 1)}…`,
          sweep: "sweeping leftovers back to you…",
        };
        if (stage !== "done") setPhase({ k: "cashing", note: notes[stage] ?? stage });
      });
      const imgs: Record<string, string> = {};
      for (const m of mints) if (m.asset && m.traits) imgs[m.asset] = await composeBull(m.traits, 512);
      setPhase({ k: "done", mints, imgs });
      setState(await client.fetchState());
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message, retry: cashOut });
    }
  }

  function useAsPfp(m: MintResult) {
    if (!m.asset || !m.traits || !address) return;
    setPfp(address, { asset: m.asset, traits: m.traits });
    onClose();
  }

  const rolledWaiting = state && "rolledUnsettled" in state ? state.rolledUnsettled : 0;

  return (
    <div className="bullm-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bullm" role="dialog" aria-label="Bull Machine">
        <div className="bullm-head">
          <div className="bullm-title">The Bull Machine</div>
          <span className="tag">devnet · provably fair</span>
          <button className="bullm-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* 3×3 of real trait tiles */}
        <div className={`bullm-grid ${phase.k === "spinning" ? "spinning" : ""}`}>
          {manifest && GRID_CATS.map((cat, i) => {
            const t = phase.k === "rolled" ? phase.traits[cat] : reel[i];
            const path = manifest[cat] && manifest[cat].traits[t] ? traitTilePath(manifest, cat, t) : null;
            return <div key={i} className="bullm-cell">{path && <img src={path} alt="" />}</div>;
          })}
        </div>

        {phase.k === "idle" && (
          <div className="bullm-panel">
            <div className="bullm-copy">One approval opens your session. Spins are instant after that — every bull is unique, minted to <b>your</b> wallet.</div>
            <div className="bullm-nrow">
              {[1, 3, 5].map((n) => (
                <button key={n} className={`bullm-n ${nSpins === n ? "on" : ""}`} onClick={() => setNSpins(n)}>{n} spin{n > 1 ? "s" : ""}</button>
              ))}
            </div>
            <button className="btn bullm-cta" onClick={open}>
              Open session{openCost ? ` · ~◎${openCost}` : ""}
            </button>
            <div className="bullm-fine">crank change is swept back to you at cash-out</div>
          </div>
        )}

        {phase.k === "opening" && <div className="bullm-panel"><div className="bullm-copy">Opening your session — one wallet approval…</div></div>}

        {phase.k === "ready" && (
          <div className="bullm-panel">
            <button className="bullm-lever" onClick={pullLever}>PULL</button>
            <div className="bullm-fine">{phase.creditsLeft} spin{phase.creditsLeft === 1 ? "" : "s"} left · no popups, straight to the rollup</div>
            {rolledWaiting > 0 && <button className="btn bullm-cta" onClick={cashOut}>Cash out · mint {rolledWaiting} bull{rolledWaiting > 1 ? "s" : ""}</button>}
          </div>
        )}

        {phase.k === "spinning" && <div className="bullm-panel"><div className="bullm-copy">Rolling in the rollup…</div></div>}

        {phase.k === "rolled" && (
          <div className="bullm-panel">
            <img className="bullm-reveal" src={phase.img} alt="Your rolled bull" />
            <div className="bullm-copy">That's yours — locked to this roll. It mints at cash-out.</div>
            {phase.creditsLeft > 0
              ? <button className="bullm-lever" onClick={pullLever}>PULL AGAIN</button>
              : null}
            <button className="btn bullm-cta" onClick={cashOut}>Cash out · mint</button>
          </div>
        )}

        {phase.k === "cashing" && <div className="bullm-panel"><div className="bullm-copy">{phase.note}</div></div>}

        {phase.k === "done" && (
          <div className="bullm-panel">
            <div className="bullm-copy"><b>Minted.</b> Pick your profile picture:</div>
            <div className="bullm-mints">
              {phase.mints.filter((m) => m.asset).map((m) => (
                <div key={m.asset} className="bullm-mint">
                  {m.asset && phase.imgs[m.asset] && <img src={phase.imgs[m.asset]} alt={`Bull ${m.dna}`} />}
                  <button className="btn" onClick={() => useAsPfp(m)}>Use as profile picture</button>
                  <a href={bullExplorerUrl(m.asset!)} target="_blank" rel="noreferrer" className="bullm-fine">view on explorer ↗</a>
                </div>
              ))}
              {phase.mints.every((m) => !m.asset) && <div className="bullm-copy">Cosmic duplicate — that exact bull already exists. Spin again!</div>}
            </div>
          </div>
        )}

        {phase.k === "error" && (
          <div className="bullm-panel">
            <div className="bullm-copy bullm-err">{phase.msg}</div>
            {phase.retry && <button className="btn bullm-cta" onClick={phase.retry}>Try again</button>}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append the styles**

```css
/* ── Bull Machine overlay (hand-drawn) ─────────────────────────────── */
.bullm-backdrop{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:18px}
.bullm{width:100%;max-width:380px;max-height:92vh;overflow-y:auto;background:var(--bg,#17131b);border:3px solid currentColor;border-radius:18px;padding:14px;box-shadow:6px 6px 0 #000}
.bullm-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.bullm-title{font-size:20px;font-weight:800;flex:1}
.bullm-x{margin-left:auto;background:none;border:2px solid currentColor;border-radius:9px;color:inherit;padding:3px 9px;cursor:pointer}
.bullm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px}
.bullm-cell{aspect-ratio:1;border:2.5px solid currentColor;border-radius:12px;overflow:hidden;background:rgba(255,255,255,.04)}
.bullm-cell img{width:100%;height:100%;object-fit:cover;display:block}
.bullm-grid.spinning .bullm-cell img{filter:blur(1px)}
.bullm-panel{display:flex;flex-direction:column;gap:10px;align-items:center;text-align:center}
.bullm-copy{font-size:13.5px;line-height:1.45;opacity:.92}
.bullm-err{color:#e2564d}
.bullm-nrow{display:flex;gap:8px}
.bullm-n{border:2.5px solid currentColor;border-radius:11px;background:none;color:inherit;font-weight:800;padding:7px 13px;cursor:pointer}
.bullm-n.on{background:#f5e33d;color:#17130f}
.bullm-cta{width:100%}
.bullm-lever{width:110px;height:110px;border-radius:50%;border:3px solid currentColor;background:#e59be0;color:#17130f;font-size:19px;font-weight:900;cursor:pointer;box-shadow:4px 4px 0 #000}
.bullm-lever:active{transform:translate(2px,2px);box-shadow:1px 1px 0 #000}
.bullm-reveal{width:200px;border:3px solid currentColor;border-radius:14px;box-shadow:4px 4px 0 #000}
.bullm-mints{display:flex;flex-direction:column;gap:12px;width:100%}
.bullm-mint{display:flex;flex-direction:column;gap:7px;align-items:center}
.bullm-mint img{width:160px;border:3px solid currentColor;border-radius:12px}
.bullm-fine{font-size:11px;opacity:.6}
```

- [ ] **Step 3: Typecheck + suite**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean + all pass.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/BullMachine.tsx web/src/App.css
git commit -m "feat(web): BullMachine overlay — hand-drawn 3×3, lever, reveal, cash-out mint flow"
```

---

### Task 7: Profile section in WalletView + LoginBar chip PFP

**Files:**
- Modify: `web/src/components/WalletView.tsx`
- Modify: `web/src/components/LoginBar.tsx`

- [ ] **Step 1: WalletView — add the Profile block above the wallet card**

In `web/src/components/WalletView.tsx`: add imports, PFP state, and the profile section. The component keeps its existing balance card untouched below.

```tsx
// new imports at the top
import { Mascot } from "./Mascot.tsx";
import { usePfp } from "../lib/profile.ts";
import { composeBull } from "../lib/bullArt.ts";
import { BullMachine } from "./BullMachine.tsx";
```

Inside the component (after `const [copied, setCopied] = useState(false);`):

```tsx
  const pfp = usePfp(address ?? undefined);
  const [pfpImg, setPfpImg] = useState<string | null>(null);
  const [machineOpen, setMachineOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!pfp) { setPfpImg(null); return; }
    composeBull(pfp.traits, 256).then((url) => { if (alive) setPfpImg(url); }).catch(() => {});
    return () => { alive = false; };
  }, [pfp?.asset]);
```

Replace the logged-in branch's header block:

```tsx
      <div className="section"><h3>Wallet</h3>
        <span className="tag">devnet</span>
      </div>
```

with:

```tsx
      <div className="section"><h3>Profile</h3>
        <span className="tag">devnet</span>
      </div>

      <div className="profile-card">
        {pfpImg
          ? <img className="profile-pfp" src={pfpImg} alt="Your bull" />
          : <Mascot seed={address} size={72} title="Your mascot (spin for a bull!)" />}
        <div className="profile-meta">
          <div className="profile-name">{pfp ? "Bull holder" : "No bull yet"}</div>
          <button className="btn" onClick={() => setMachineOpen(true)}>
            {pfp ? "Spin again 🎰" : "Spin for your Bull 🎰"}
          </button>
        </div>
      </div>

      {machineOpen && <BullMachine onClose={() => setMachineOpen(false)} />}
```

And append the styles to `web/src/App.css`:

```css
.profile-card{display:flex;gap:14px;align-items:center;border:3px solid currentColor;border-radius:16px;padding:13px;margin-bottom:14px}
.profile-pfp{width:72px;height:72px;border-radius:50%;border:3px solid currentColor;object-fit:cover}
.profile-meta{display:flex;flex-direction:column;gap:8px}
.profile-name{font-weight:800}
```

- [ ] **Step 2: LoginBar — chip shows the bull thumb when set**

In `web/src/components/LoginBar.tsx`, inside the authenticated branch's wallet chip button, render a small PFP before the address text:

```tsx
// new imports
import { usePfp } from "../lib/profile.ts";
import { composeBull } from "../lib/bullArt.ts";
```

```tsx
  const pfp = usePfp(address ?? undefined);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!pfp) { setThumb(null); return; }
    composeBull(pfp.traits, 64).then((u) => { if (alive) setThumb(u); }).catch(() => {});
    return () => { alive = false; };
  }, [pfp?.asset]);
```

In the chip button JSX, before the address text:

```tsx
              {thumb && <img src={thumb} alt="" style={{ width: 20, height: 20, borderRadius: "50%", marginRight: 6, verticalAlign: "-4px" }} />}
```

- [ ] **Step 3: Typecheck + suite + manual browser check**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: clean + pass.
Then preview (launch config `web`, port 5180): log in → Wallet tab shows Profile block with mascot fallback + "Spin for your Bull".

- [ ] **Step 4: Commit**

```bash
git add web/src/components/WalletView.tsx web/src/components/LoginBar.tsx web/src/App.css
git commit -m "feat(web): Profile section — bull PFP with mascot fallback, machine entry, chip thumb"
```

---

### Task 8: Devnet e2e + evidence

**Files:** none (manual verification; evidence into the plan's execution log)

- [ ] **Step 1: Full run on devnet from the preview** — log in with the user's Privy wallet (needs ~0.1+ devnet SOL for 1 spin; exact preflight shown in-app): Open session (ONE Privy approval) → PULL → reveal appears (VRF sub-second; reels land on real traits) → Cash out → narrated steps → "Use as profile picture".
- [ ] **Step 2: Verify the mint** — explorer link shows the mpl-core asset owned by the Privy wallet, in collection `ABUQdk1dZ5PciD9p96UP9sMeEA71qkggtJPB5UbZ16Eq`'s successor from the ER config (read the collection from the in-app config, not this doc).
- [ ] **Step 3: Verify persistence** — reload the app: Profile + LoginBar chip still show the bull (localStorage). Log a screenshot + tx/asset links into this plan's execution log for the MagicBlock submission.
- [ ] **Step 4: Full suites once more** — `cd web && npx tsc --noEmit && npm test` (all green), then commit any evidence-log edits:

```bash
git add docs/superpowers/plans/2026-07-12-bull-machine-profile.md
git commit -m "docs(plan): bull machine profile — devnet e2e evidence"
```

---

## Self-review notes

- **Spec coverage:** assets/IDL (T1), bullArt (T2), bridge port pure+client (T3–4), profile store (T5), machine UI (T6), Profile/WalletView + LoginBar chip (T7), manual devnet e2e (T8). Live-HUD = deferred per D1. Traits-recovery stretch = out of scope per spec.
- **Types:** `BullMachineClient(playerAddress, signAndSend)`; `usePfp(address)` → `Pfp | null`; `composeBull(traits, size)` → dataURL — names consistent across T4–T7.
- **Collection note (T8 Step 2):** the ER program's config account is the source of truth for the live collection address; the Phase-A address in older docs may differ.
