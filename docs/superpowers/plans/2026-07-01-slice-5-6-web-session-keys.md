# Slice 5 + 6 — Web ↔ On-Chain Live Pool, with Gasless Session-Key Taps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ UPDATE (2026-07-02) — Phase B superseded; DID NOT use session keys.** Phase A shipped as written. A tap-path correction found taps must go to the ER regardless of signer (the keeper delegates each LiveEntry → a base `lock_pick` reverts), so the ER plumbing was needed either way. The user then chose **Privy `showWalletUIs:false` no-modal ER taps** — NO redeploy, NO program change, NO session-key crate. Shipped as `anchorClient.erConnection` + `livePoolClient.buildLockPickTxER` + `usePrivySigner.signAndSendEr` (per-call `showWalletUIs:false`, confirmed a per-call field in Privy 3.32.2). Tasks **B0–B6 below (session keys / redeploy / gum-sdk) are the NOT-taken path**, retained for reference. Remaining: a live-pool + logged-in E2E smoke test of a real gasless tap.

**Goal:** Turn the web Live tab from a client-side `Math.random()` simulation into a real-money view of the on-chain `LivePool`: real join (base), real standings/score/open-call (engine poll), real settle-aware claim (base) — then make taps gasless via MagicBlock session keys.

**Architecture:** Two phases. **Phase A** wires the web to the *currently-deployed* program (program id `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`) with **no redeploy** — join/claim on base, taps via the existing `lock_pick` (player-signed popup), and a poll-driven UI that reconciles to on-chain truth every ~2s. **Phase B** adds `#[session_auth_or]` to `lock_pick` (proven to *build* on our exact toolchain by the `spike/session-keys` crate), redeploys devnet in place (GATED), and swaps the tap signer to an ephemeral session key so taps are popup-free. Phase B leads with a devnet ER runtime check because the build spike did not prove base-minted-token validation inside the ER.

**Tech Stack:** React 19 + Vite + TypeScript (`web/`), `@coral-xyz/anchor 0.32.1`, `@solana/web3.js 1.98.4`, `@privy-io/react-auth 3.32.2`; engine Fastify routes (`engine/`); Anchor program `anchor-lang 0.32.1` + `ephemeral-rollups-sdk 0.14.4` + (Phase B) `session-keys 3.1.1`; client `@magicblock-labs/gum-sdk 3.0.10`.

---

## Load-Bearing Context (read before starting)

**RPCs.** Base `https://api.devnet.solana.com`; ER (MagicRouter) `https://devnet-router.magicblock.app`. Join/claim/settle/session-mint go to **base**; `lock_pick` (delegated `entry`/`call`) goes to the **router**.

**Custody invariant (never violate).** `LivePool` (the pot) is never delegated — money instructions (`join`, `claim`) always use the real wallet on base. Session keys sign only `lock_pick`, never touch custody.

**PDA seeds** (canonical source `keeper/live-pda.ts`; the web mirrors it):
- `livepool  = [b"livepool",  u64le(pool_id)]`
- `livecursor= [b"livecursor", pool]`
- `call      = [b"call", pool, u32le(seq)]`  ← seq is **u32 (4 bytes)**, not u64
- `liveentry = [b"liveentry", pool, player]`
- `jackpot   = [b"jackpot"]`

**Player-facing on-chain calls** (from the IDL, exact account order):
- `join_live_pool()` — accounts: `player`(signer,mut), `pool`(mut), `entry`(mut, `init`), `system_program`. No args. Transfers `entry_price` into the pool; opens the seat. Reverts if `status != Open` or `now >= lock_ts`.
- `lock_pick(option: u8)` — accounts: `player`(signer), `call`, `entry`(mut). Writes `entry.picks[call.seq] = option`. Reverts on closed window / resolved call / out-of-range option.
- `claim_live_pool()` — accounts: `player`(signer,mut), `pool`(mut), `entry`(mut, `close=player`), `system_program`. No args. Pays winner share / void refund / else close-only; deletes the seat.

`settle_live_pool` / `void_live_pool` / `refund_voided` are keeper/permissionless — **not** web builders.

**Anchor CJS idiom (NodeNext ESM):** `import anchorDefault from "@coral-xyz/anchor"; const { BN } = anchorDefault;`. Named/namespace imports break.

**Engine live routes** (already shipped, Slice 4):
- `GET /api/live/pool?fixtureId=N` → `{ pool: LivePoolView|null, openCall: CallView|null, standings: LiveEntryView[], match: {...} }`. No pool → `{ pool: null }` (200).
- `GET /api/live/pool/:id/standings` → `LiveEntryView[]` (`:id` = poolId).
- `GET /api/live/entry?wallet=&poolId=` → `{ entry: LiveEntryView|null }`.

**View shapes** (mirror engine `engine/src/chain.ts`): statuses `POOL_STATUS=["open","live","ended","settled","rolledOver","voided"]`, `CALL_STATE=["empty","open","resolved","voided"]`; `NO_PICK=0xff`, `VOID_OUTCOME=0xfe`. `LiveEntry` on devnet is **159 bytes** (has `picks:[u8;64]`), not the spec's 100.

**Live-fixture discovery.** The web finds the active fixture via existing `getMatches()` — pick the match whose `getLivePool(fixtureId)` returns a non-null pool (in practice there is one daily live-centerpiece match). No new engine endpoint needed; if iteration proves noisy, a `/api/live/current` follow-up is trivial (out of scope here).

---

## File Structure

**Phase A**
- Create `web/src/lib/pdasLive.ts` — web mirror of `keeper/live-pda.ts` (web3.js `PublicKey` derivations + LE encoders). One responsibility: pure PDA math.
- Replace `web/src/idl/proofbet.json` — copy `target/idl/proofbet.json` (11 → 30 instructions). No hand-edits.
- Modify `web/src/lib/api.ts` — add `LivePoolView`/`CallView`/`LiveEntryView`/`LivePoolResponse` types + `getLivePool`/`getPoolStandings`/`getLiveEntry`.
- Create `web/src/lib/livePoolClient.ts` — base-layer tx builders `buildJoinLivePoolTx`, `buildClaimLivePoolTx`, and `buildLockPickTx` (player-signed, base — swapped to ER/session in Phase B). Mirrors `web/src/lib/anchorClient.ts`'s `readonlyProgram`/`withBlockhash` pattern.
- Create `web/src/lib/useLivePool.ts` — a React hook: given the active fixtureId + wallet, polls `getLivePool`/`getLiveEntry` every 2s, exposes `{ pool, openCall, standings, entry, match, refresh }`.
- Modify `web/src/components/LiveMatchView.tsx` + `web/src/lib/liveGame.ts` — replace sim authority with poll authority: real pool/score/standings/open-call; rAF only animates the open-call countdown; wallet-gated Join; settle-aware Claim.
- Create `web/test/livePool.test.ts` — builder-shape + PDA-parity + view-mapping tests.

**Phase B**
- Create `spike/session-keys-runtime/` (throwaway) — devnet ER runtime check that a base-minted session token validates inside an ER `lock_pick`.
- Modify `programs/proofbet/src/instructions/live/lock_pick.rs` — `#[session_auth_or]` + `#[derive(Session)]` + `session_token` field; `signer` replaces the `player` Signer.
- Modify `programs/proofbet/Cargo.toml` — add `session-keys 3.1.1`; commit the `cargo update anchor-lang@1.1.2 --precise 0.32.1` lockfile pin.
- Modify `tests/live_pool_safety.ts` (or new `tests/live_session.ts`) — session-signed tap + player-fallback + wrong-authority rejection.
- Create `web/src/lib/sessionKeys.ts` — mint the session token at join (`@magicblock-labs/gum-sdk`), hold the ephemeral keypair in memory.
- Modify `web/src/lib/livePoolClient.ts` — `buildLockPickTx` → ER shape (session_token account, ephemeral signer, router connection).
- Modify `web/src/components/LiveMatchView.tsx` — `lock()` seam → gasless ER tap.

---

# PHASE A — Web money rails (NO redeploy)

### Task A1: Refresh the web IDL

**Files:**
- Replace: `web/src/idl/proofbet.json` (from `target/idl/proofbet.json`)

- [ ] **Step 1: Copy the fresh IDL**

```bash
cp target/idl/proofbet.json web/src/idl/proofbet.json
```

- [ ] **Step 2: Verify it carries all 30 instructions incl. the live set**

```bash
node -e 'const i=require("./web/src/idl/proofbet.json"); const n=i.instructions.map(x=>x.name); console.log(n.length, ["join_live_pool","lock_pick","claim_live_pool"].every(x=>n.includes(x)));'
```
Expected: `30 true`

- [ ] **Step 3: Typecheck the web (IDL is a drop-in — same anchor 0.32.1 format)**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors from the IDL swap.

- [ ] **Step 4: Commit**

```bash
git add web/src/idl/proofbet.json
git commit -m "feat(web): refresh IDL to 30-instruction live set (Slice 5 A1)"
```

---

### Task A2: Web PDA module (`pdasLive.ts`)

**Files:**
- Create: `web/src/lib/pdasLive.ts`
- Test: `web/test/livePool.test.ts` (created here; extended later)

- [ ] **Step 1: Write the failing test**

```ts
// web/test/livePool.test.ts
import { describe, it, expect } from "vitest";
import pkg from "@solana/web3.js";
import { livePoolPda, liveEntryPda, callPda, u32le } from "../src/lib/pdasLive.ts";
const { PublicKey } = pkg;

describe("pdasLive", () => {
  it("callPda encodes seq as u32 (4 bytes)", () => {
    expect(u32le(1).length).toBe(4);
  });
  it("derivations match the canonical program id", () => {
    const pool = livePoolPda(1782924013084000n);
    expect(pool).toBeInstanceOf(PublicKey);
    const entry = liveEntryPda(pool, new PublicKey("11111111111111111111111111111111"));
    const call = callPda(pool, 0);
    // deterministic: same inputs → same PDA
    expect(liveEntryPda(pool, new PublicKey("11111111111111111111111111111111")).equals(entry)).toBe(true);
    expect(callPda(pool, 0).equals(call)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `cd web && npx vitest run test/livePool.test.ts`
Expected: FAIL — `pdasLive.ts` not found.

- [ ] **Step 3: Implement `pdasLive.ts`** (port of `keeper/live-pda.ts`, accepting `bigint`/BN pool ids)

```ts
// web/src/lib/pdasLive.ts
/** Web mirror of keeper/live-pda.ts — pure PDA + LE encoders for the live program.
 *  Zero I/O: every export is an in-memory writer or findProgramAddressSync. */
import anchorDefault from "@coral-xyz/anchor";
import pkg from "@solana/web3.js";
const { PublicKey } = pkg;
const { BN } = anchorDefault;

export const LIVE_PROGRAM_ID = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

/** 4-byte unsigned LE — call seq is u32, NOT u64. */
export function u32le(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
/** 8-byte unsigned LE. Accepts number | bigint | BN-like. */
export function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n.toString())); return b;
}

type PK = InstanceType<typeof PublicKey>;

export function livePoolPda(poolId: number | bigint): PK {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livepool"), u64le(poolId)], LIVE_PROGRAM_ID)[0];
}
export function liveCursorPda(pool: PK): PK {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livecursor"), pool.toBuffer()], LIVE_PROGRAM_ID)[0];
}
export function callPda(pool: PK, seq: number): PK {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("call"), pool.toBuffer(), u32le(seq)], LIVE_PROGRAM_ID)[0];
}
export function liveEntryPda(pool: PK, player: PK): PK {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liveentry"), pool.toBuffer(), player.toBuffer()], LIVE_PROGRAM_ID)[0];
}
export function jackpotPda(): PK {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot")], LIVE_PROGRAM_ID)[0];
}
// Keep BN importable for callers that pass anchor BN pool ids.
export { BN };
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `cd web && npx vitest run test/livePool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/pdasLive.ts web/test/livePool.test.ts
git commit -m "feat(web): live PDA module mirroring keeper/live-pda.ts (Slice 5 A2)"
```

---

### Task A3: Live engine-client types + fetchers (`api.ts`)

**Files:**
- Modify: `web/src/lib/api.ts` (append; mirror `engine/src/chain.ts` shapes)
- Test: `web/test/livePool.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { poolIsClaimable, isWinner } from "../src/lib/api.ts";
describe("live view helpers", () => {
  it("winner iff pool settled and total == winningScore > 0", () => {
    const pool = { status: "settled", winningScore: 4, winnerCount: 1 } as any;
    expect(isWinner(pool, { total: 4 } as any)).toBe(true);
    expect(isWinner(pool, { total: 3 } as any)).toBe(false);
    expect(isWinner({ ...pool, winningScore: 0 }, { total: 0 } as any)).toBe(false);
  });
  it("claimable in any terminal state", () => {
    expect(poolIsClaimable({ status: "settled" } as any)).toBe(true);
    expect(poolIsClaimable({ status: "voided" } as any)).toBe(true);
    expect(poolIsClaimable({ status: "live" } as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, watch it fail** — `cd web && npx vitest run test/livePool.test.ts` → FAIL (exports missing).

- [ ] **Step 3: Append the types, fetchers, and helpers to `web/src/lib/api.ts`**

```ts
// --- Live-match pool (Slice 5) --------------------------------------------
export type PoolStatus = "open" | "live" | "ended" | "settled" | "rolledOver" | "voided";
export type CallState = "empty" | "open" | "resolved" | "voided";

export interface LivePoolView {
  pubkey: string; poolId: number; fixtureId: number;
  settleAuthority: string; feeRecipient: string; entryPrice: string;
  lockTs: number; settleAfterTs: number; feeBps: number;
  status: PoolStatus; numCalls: number; playerCount: number;
  winningScore: number; winnerCount: number; distributable: string;
  claimedCount: number; claimedTotal: string; settledTs: number;
}
export interface CallView {
  pubkey: string; pool: string; seq: number; kind: number;
  state: CallState; openedTs: number; answerSecs: number;
  numOptions: number; basePoints: number[]; outcome: number | "void" | null;
}
export interface LiveEntryView {
  pubkey: string; player: string; pool: string; amount: string;
  basePts: number; bonusPts: number; total: number; streak: number;
  nextScoreSeq: number; picks: (number | null)[];
}
export interface LivePoolResponse {
  pool: LivePoolView | null;
  openCall?: CallView | null;
  standings?: LiveEntryView[];
  match?: {
    fixtureId: number; home: string; away: string; kickoffMs: number | null;
    live?: { home: number; away: number; minute: number | null; phase: "pre" | "live" | "ht" | "ft" };
  };
}

export const getLivePool = (fixtureId: number): Promise<LivePoolResponse> =>
  fetch(`${ENGINE}/api/live/pool?fixtureId=${fixtureId}`).then(json);
export const getPoolStandings = (poolId: number): Promise<LiveEntryView[]> =>
  fetch(`${ENGINE}/api/live/pool/${poolId}/standings`).then(json);
export const getLiveEntry = (wallet: string, poolId: number): Promise<LiveEntryView | null> =>
  fetch(`${ENGINE}/api/live/entry?wallet=${wallet}&poolId=${poolId}`)
    .then(json).then((r: { entry: LiveEntryView | null }) => r.entry);

/** Any terminal state accepts a claim (winner share / void refund / close-only). */
export const poolIsClaimable = (p: Pick<LivePoolView, "status">): boolean =>
  p.status === "settled" || p.status === "rolledOver" || p.status === "voided";
/** This seat won iff the pool settled with a positive winning score it matches. */
export const isWinner = (
  p: Pick<LivePoolView, "status" | "winningScore">, e: Pick<LiveEntryView, "total">,
): boolean => p.status === "settled" && p.winningScore > 0 && e.total === p.winningScore;
```

- [ ] **Step 4: Run, watch it pass** — `cd web && npx vitest run test/livePool.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/test/livePool.test.ts
git commit -m "feat(web): live pool engine-client types + fetchers + helpers (Slice 5 A3)"
```

---

### Task A4: Base-layer tx builders (`livePoolClient.ts`)

**Files:**
- Create: `web/src/lib/livePoolClient.ts`
- Test: `web/test/livePool.test.ts`

Mirror `web/src/lib/anchorClient.ts`: reuse its exported `connection`, `readonlyProgram(payer)`, and `withBlockhash(tx, payer)`. (If those aren't exported, export them from `anchorClient.ts` in this task.)

- [ ] **Step 1: Write the failing test** (append)

```ts
import pkg2 from "@solana/web3.js";
import { buildJoinLivePoolTx, buildClaimLivePoolTx } from "../src/lib/livePoolClient.ts";
const { PublicKey: PK2 } = pkg2;
const PAYER = new PK2("So11111111111111111111111111111111111111112");

describe("live tx builders", () => {
  it("join tx targets the pool + derived entry, feePayer = player", async () => {
    const tx = await buildJoinLivePoolTx(PAYER.toBase58(), 1782924013084000);
    expect(tx.feePayer?.equals(PAYER)).toBe(true);
    expect(tx.instructions.length).toBe(1);
    // player is the first (signer) account
    expect(tx.instructions[0].keys[0].pubkey.equals(PAYER)).toBe(true);
    expect(tx.instructions[0].keys[0].isSigner).toBe(true);
  });
  it("claim tx builds against the same pool + entry", async () => {
    const tx = await buildClaimLivePoolTx(PAYER.toBase58(), 1782924013084000);
    expect(tx.instructions.length).toBe(1);
    expect(tx.feePayer?.equals(PAYER)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, watch it fail** — FAIL (builders missing).

- [ ] **Step 3: Implement `livePoolClient.ts`**

```ts
// web/src/lib/livePoolClient.ts
/** Delegate-aware tx builders for the live pool.
 *  join/claim → BASE layer (real wallet, never delegated).
 *  lock_pick  → BASE here in Phase A (player-signed popup); Phase B swaps it to
 *  an ER/router tx signed by an ephemeral session key. */
import pkg from "@solana/web3.js";
import { readonlyProgram, withBlockhash } from "./anchorClient.ts";
import { livePoolPda, liveEntryPda, callPda } from "./pdasLive.ts";

const { PublicKey, SystemProgram } = pkg;
type Tx = InstanceType<typeof import("@solana/web3.js").Transaction>;

export async function buildJoinLivePoolTx(playerAddress: string, poolId: number): Promise<Tx> {
  const player = new PublicKey(playerAddress);
  const pool = livePoolPda(poolId);
  const entry = liveEntryPda(pool, player);
  const program = readonlyProgram(player);
  const tx: Tx = await program.methods
    .joinLivePool()
    .accountsStrict({ player, pool, entry, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, player);
}

export async function buildClaimLivePoolTx(playerAddress: string, poolId: number): Promise<Tx> {
  const player = new PublicKey(playerAddress);
  const pool = livePoolPda(poolId);
  const entry = liveEntryPda(pool, player);
  const program = readonlyProgram(player);
  const tx: Tx = await program.methods
    .claimLivePool()
    .accountsStrict({ player, pool, entry, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, player);
}

/** Phase A: base-layer, player-signed tap (popup per tap). `seq` picks the call PDA. */
export async function buildLockPickTx(
  playerAddress: string, poolId: number, seq: number, option: number,
): Promise<Tx> {
  const player = new PublicKey(playerAddress);
  const pool = livePoolPda(poolId);
  const entry = liveEntryPda(pool, player);
  const call = callPda(pool, seq);
  const program = readonlyProgram(player);
  const tx: Tx = await program.methods
    .lockPick(option)
    .accountsStrict({ player, call, entry })
    .transaction();
  return withBlockhash(tx, player);
}
```

- [ ] **Step 4: If needed, export `readonlyProgram`/`withBlockhash`/`connection` from `anchorClient.ts`** (they already exist per the file; add `export` if internal). Re-run typecheck.

- [ ] **Step 5: Run, watch it pass** — PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/livePoolClient.ts web/test/livePool.test.ts web/src/lib/anchorClient.ts
git commit -m "feat(web): base-layer live tx builders join/claim/lock_pick (Slice 5 A4)"
```

---

### Task A5: Poll hook (`useLivePool.ts`)

**Files:**
- Create: `web/src/lib/useLivePool.ts`

Discovery + polling in one hook. No test (thin I/O glue; covered by the browser verify in A7).

- [ ] **Step 1: Implement the hook**

```ts
// web/src/lib/useLivePool.ts
import { useEffect, useRef, useState, useCallback } from "react";
import { getMatches, getLivePool, getLiveEntry,
  type LivePoolResponse, type LiveEntryView } from "./api.ts";

const POLL_MS = 2000;

export interface LivePoolState {
  loading: boolean;
  fixtureId: number | null;
  data: LivePoolResponse | null;   // pool + openCall + standings + match
  entry: LiveEntryView | null;     // this wallet's seat (null if not joined)
  refresh: () => Promise<void>;
}

/** Discovers the active live fixture (first `getMatches()` entry that has a pool),
 *  then polls its pool + this wallet's entry every 2s. */
export function useLivePool(wallet: string | null): LivePoolState {
  const [state, setState] = useState<Omit<LivePoolState, "refresh">>({
    loading: true, fixtureId: null, data: null, entry: null,
  });
  const fixtureRef = useRef<number | null>(null);

  const discover = useCallback(async (): Promise<number | null> => {
    if (fixtureRef.current != null) return fixtureRef.current;
    const matches = await getMatches().catch(() => []);
    const ordered = [...matches].sort((a, b) =>
      (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1));
    for (const m of ordered) {
      const r = await getLivePool(m.fixtureId).catch(() => ({ pool: null }));
      if (r.pool) { fixtureRef.current = m.fixtureId; return m.fixtureId; }
    }
    return null;
  }, []);

  const refresh = useCallback(async () => {
    const fixtureId = await discover();
    if (fixtureId == null) { setState({ loading: false, fixtureId: null, data: null, entry: null }); return; }
    const data = await getLivePool(fixtureId).catch(() => null);
    let entry: LiveEntryView | null = null;
    if (wallet && data?.pool) entry = await getLiveEntry(wallet, data.pool.poolId).catch(() => null);
    setState({ loading: false, fixtureId, data, entry });
  }, [discover, wallet]);

  useEffect(() => {
    let alive = true;
    const tick = async () => { if (alive) await refresh(); };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [refresh]);

  return { ...state, refresh };
}
```

- [ ] **Step 2: Typecheck** — `cd web && npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/useLivePool.ts
git commit -m "feat(web): useLivePool discovery + 2s poll hook (Slice 5 A5)"
```

---

### Task A6: Rewire `LiveMatchView` + `liveGame` to on-chain authority

**Files:**
- Modify: `web/src/components/LiveMatchView.tsx`
- Modify: `web/src/lib/liveGame.ts`

**Design (real-money honest model).** The sim no longer invents calls or scores. Authority flips to the poll:
- **Pool hero** ← `data.pool` (`playerCount` in, `entryPrice` each, `pot` = `distributable` pre-settle or `entryPrice*playerCount`).
- **Match board / stats** ← `data.match.live` (score, minute, phase); no `Math.random`.
- **Open call** ← `data.openCall` (a `CallView`). The countdown bar animates via rAF from `openedTs + answerSecs` vs `Date.now()`; when `state !== "open"` show idle. Tapping calls `buildLockPickTx(wallet, poolId, openCall.seq, optionIndex)` → `signAndSend`.
- **Your score/streak** ← `entry` (`total`, `streak`, `basePts`, `bonusPts`, `picks`).
- **Standings** ← `data.standings` sorted by `total` desc; "you" row is the entry whose `player === wallet`.
- **Join** — when `!entry` and `pool.status === "open"` and `now < lockTs`: a Join button (`buildJoinLivePoolTx` → `signAndSend`, then `refresh`).
- **Claim** — when `poolIsClaimable(pool)` and `entry` exists: a Claim button (`buildClaimLivePoolTx` → `signAndSend`, then `refresh`). Label winner/refund via `isWinner`.

`liveGame.ts` is repurposed as a **pure view-model mapper** (no timers, no RNG): a function `snapshotFromChain(data, entry, wallet, nowMs): GameSnapshot` that maps the poll payload into the existing `GameSnapshot` shape the JSX already renders. Keep the `GameSnapshot`/`SnapCall`/`SnapStanding` interfaces; delete the RNG `advanceMinute`/`spawnCall`/`grade`/`tickBots` internals (dead once authority is on-chain). This preserves the JSX in `LiveMatchView` with minimal churn.

Call-kind mapping (`CallView.kind: u8` → label + options): reuse the on-chain `kind`/`basePoints`/`numOptions`. Kinds (from the program `KIND`): `nextGoal`, `goalRush`, `cornerSoon`, `cardSoon`. Map `kind` → `{ label, optionLabels }`; option point values come from `basePoints[]`.

- [ ] **Step 1: Add `snapshotFromChain` to `liveGame.ts`** — pure mapper from `LivePoolResponse` + `LiveEntryView | null` + `wallet` + `nowMs` → `GameSnapshot`. Countdown fields derive from `openCall.openedTs`/`answerSecs`. When `pool == null`, return an "idle / no live game" snapshot. (Keep the `GameSnapshot` interface and `solStr`/`SCORING_HINT` exports.)

- [ ] **Step 2: Rewrite `LiveMatchView`** — replace the `new LiveGame()` + rAF-drives-sim block with:
  - `const { data, entry, fixtureId, refresh } = useLivePool(address)` (address from `usePrivySigner()`).
  - `const [snap, setSnap] = useState(() => snapshotFromChain(data, entry, address, Date.now()))`.
  - A light rAF/interval that re-derives `snap = snapshotFromChain(data, entry, address, Date.now())` at ~10fps **only to animate the open-call countdown** (data itself refreshes on the 2s poll).
  - `onLock={(optIndex) => tap(optIndex)}` where `tap` builds+sends `buildLockPickTx` then `refresh()`.
  - Join/Claim buttons per the design above, using `signAndSend` from `usePrivySigner()`.
  - Keep all existing class names / JSX structure.

- [ ] **Step 3: Typecheck** — `cd web && npx tsc --noEmit` → clean.

- [ ] **Step 4: Unit-test the mapper** (append to `web/test/livePool.test.ts`): feed a synthetic `LivePoolResponse` (open call, 3 standings, your entry) into `snapshotFromChain` and assert pot string, your pts, standings order, and open-call option count/points. Run vitest → PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/LiveMatchView.tsx web/src/lib/liveGame.ts web/test/livePool.test.ts
git commit -m "feat(web): LiveMatchView reads on-chain pool — join/taps/standings/claim (Slice 5 A6)"
```

---

### Task A7: End-to-end browser verify (Phase A)

**Files:** none (verification)

- [ ] **Step 1:** Ensure engine + web dev servers run (`.claude/launch.json`; use the preview tools, not Bash).
- [ ] **Step 2:** Load the Live tab. Confirm via `preview_snapshot`: real pot/entry from a devnet pool, real standings, a real open call (or an honest "no live game" idle state if no pool is currently open on devnet).
- [ ] **Step 3:** With a funded Privy devnet wallet, click **Join** → confirm the popup, then `preview_network` shows the `join_live_pool` tx and the seat appears in standings after refresh.
- [ ] **Step 4:** Tap an option during an open call → `lock_pick` tx (popup — Phase A); after keeper resolve, your score reconciles on the next poll.
- [ ] **Step 5:** After the match settles, **Claim** pays out (winner) or refunds (void) — `preview_network` shows `claim_live_pool`.
- [ ] **Step 6:** Screenshot the working live view for the user.

**Phase A is a shippable real-money on-chain live game — taps just pop a wallet modal.** Stop and report before Phase B.

---

# PHASE B — Gasless taps (session keys) — GATED on devnet redeploy

> Do not start Phase B until Phase A is green and the user has approved the **devnet redeploy** (real SOL from the upgrade-authority wallet).

### Task B0: Devnet ER runtime check for session tokens (spike-before-depend)

**Why:** the `spike/session-keys` crate proved `#[session_auth_or]` *compiles* on our toolchain, **not** that a base-minted `SessionToken` validates inside an ER (the `entry`/`call` are delegated; the token is a base account). Prove this at runtime before building UI on it.

**Files:** Create `spike/session-keys-runtime/` (throwaway TS, like `spike/live-er/`).

- [ ] **Step 1:** Stand up a minimal `#[ephemeral]` program (reuse `spike/session-keys/src/lib.rs`'s `lock_pick` shape) with the session gate; deploy to devnet; delegate its `entry`.
- [ ] **Step 2:** Mint a `SessionToken` on base via `@magicblock-labs/gum-sdk` (`SessionTokenManager.createSession`, authority = the seat's player wallet, signer = a fresh ephemeral keypair).
- [ ] **Step 3:** Build the ER `lock_pick` tx (session_token account + ephemeral signer), send via MagicRouter. **Assert the pick lands and no wallet popup / player signature was needed.**
- [ ] **Step 4:** Record a `proof-report.json` (green/red). **If RED** (token not ER-readable), STOP Phase B and switch to the **Privy fallback** (Task B-ALT) — no program change, no redeploy.

### Task B-ALT (only if B0 is RED): Privy `showWalletUIs:false` no-modal taps

**Files:** Modify `web/src/hooks/usePrivySigner.ts` (+ a tap-specific signer).

- [ ] Add a `signAndSendNoModal(tx)` path that passes `uiOptions: { showWalletUIs: false }` to Privy's `useSignTransaction` for embedded wallets. Wire `LiveMatchView`'s tap to it. Result: no-modal taps for embedded wallets (external wallets still prompt). No redeploy. Then skip B1–B6.

### Task B1: Add `#[session_auth_or]` to `lock_pick`

**Files:**
- Modify: `programs/proofbet/src/instructions/live/lock_pick.rs`
- Modify: `programs/proofbet/Cargo.toml` (+ commit `Cargo.lock` pin)

- [ ] **Step 1:** Add the dep to `programs/proofbet/Cargo.toml`:

```toml
session-keys = { version = "3.1.1", features = ["no-entrypoint"] }
```

- [ ] **Step 2:** Apply the mandatory lockfile pin (or the build splits anchor-lang and fails):

```bash
cd programs/proofbet && cargo update anchor-lang@1.1.2 --precise 0.32.1
```
(Commit the resulting `Cargo.lock`.)

- [ ] **Step 3:** Rewrite `lock_pick.rs` accounts + gate (pattern proven green in `spike/session-keys/src/lib.rs`). The `player` Signer becomes `signer` (ephemeral OR player); `entry` seeds bind to `entry.player` (stored field) so the seed no longer forces the player to sign; `has_one` is replaced by the `session_auth_or` gate:

```rust
use anchor_lang::prelude::*;
use session_keys::{session_auth_or, Session, SessionError, SessionToken};

use crate::errors::ProofBetError;
use crate::live_state::*;

#[derive(Accounts, Session)]
pub struct LockPick<'info> {
    /// The tap signer: the ephemeral session key (session path) OR the player (fallback).
    pub signer: Signer<'info>,

    #[session(
        signer = signer,                    // ephemeral key authorized to sign
        authority = entry.player.key()      // human wallet that owns the seat
    )]
    pub session_token: Option<Account<'info, SessionToken>>,

    #[account(
        seeds = [b"call", call.pool.as_ref(), call.seq.to_le_bytes().as_ref()],
        bump = call.bump,
    )]
    pub call: Account<'info, Call>,

    #[account(
        mut,
        seeds = [b"liveentry", call.pool.as_ref(), entry.player.as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, LiveEntry>,
}

#[session_auth_or(
    ctx.accounts.entry.player == ctx.accounts.signer.key(),
    ProofBetError::Unauthorized
)]
pub fn handler(ctx: Context<LockPick>, option: u8) -> Result<()> {
    let call = &ctx.accounts.call;
    require!(call.state == CallState::Open, ProofBetError::CallNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now <= call.opened_ts.saturating_add(call.answer_secs as i64),
        ProofBetError::AnswerWindowClosed);
    require!(option < call.num_options, ProofBetError::InvalidOption);
    let seq = call.seq as usize;
    require!(seq < MAX_CALLS, ProofBetError::CallLimitReached);
    ctx.accounts.entry.picks[seq] = option;
    Ok(())
}
```

Note: `call.seq` is `u32`; keep `call.seq.to_le_bytes()` (matches the `u32le` seed). Confirm `#[program]` mod is `#[ephemeral]` and the handler wiring compiles.

- [ ] **Step 4: Build** — `~/.avm/bin/anchor build` (anchor 0.32.1). Expected: clean `.so`, IDL regenerates with `lock_pick` gaining `signer` + optional `session_token`.

- [ ] **Step 5: Commit** — `git add programs/proofbet/src/instructions/live/lock_pick.rs programs/proofbet/Cargo.toml programs/proofbet/Cargo.lock && git commit -m "feat(program): session-key gate on lock_pick (Slice 6 B1)"`

### Task B2: Anchor test — session-signed tap, fallback, rejection

**Files:** Create `tests/live_session.ts` (+ helpers in `tests/live_helpers.ts`).

- [ ] Mint a session token (gum, base), tap with the ephemeral key → assert `entry.picks[seq]` set, **player never signed**.
- [ ] Tap with the real player (session_token = None) → still works (fallback auth expr).
- [ ] Tap with a wrong-authority ephemeral key → `Unauthorized`/`InvalidToken`.
- [ ] Run: `anchor test` (localnet). Expected: all green. Commit.

### Task B3: **[GATE]** Devnet in-place redeploy + IDL re-refresh

- [ ] **Pause for explicit user go-ahead** (real SOL).
- [ ] `solana program deploy target/deploy/proofbet.so --program-id By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ --upgrade-authority ~/.config/solana/lazer-probe.json --url devnet` (avm anchor toolchain; keypair funded ~8 SOL).
- [ ] `cp target/idl/proofbet.json web/src/idl/proofbet.json` (now with the new `lock_pick` shape). Typecheck web. Commit.

### Task B4: Session-key client (`sessionKeys.ts`)

**Files:** Create `web/src/lib/sessionKeys.ts`; add dep `@magicblock-labs/gum-sdk` (`cd web && npm i @magicblock-labs/gum-sdk`).

- [ ] Mint on join: `new SessionTokenManager(wallet, connection)` → `.program.methods.createSession(topUp, validUntil, lamports).accounts({ sessionToken, sessionSigner, authority, targetProgram: LIVE_PROGRAM_ID }).signers([ephemeralKeypair]).rpc()` (one wallet signature at join). Hold the ephemeral `Keypair` + `sessionToken` PDA in memory for the match. Expose `getSession()` / `hasValidSession()`.

### Task B5: ER tap builder (session-signed)

**Files:** Modify `web/src/lib/livePoolClient.ts`.

- [ ] Add `buildLockPickTxER(session, poolId, seq, option)`: accounts `{ signer: ephemeral.publicKey, sessionToken: session.tokenPda, call, entry }`, `feePayer = ephemeral`, blockhash from the **router** connection (`new Connection("https://devnet-router.magicblock.app")`), signed by the ephemeral keypair, sent to the router. No wallet popup.
- [ ] Unit-test the ER builder shape (signer = ephemeral, session_token present). Commit.

### Task B6: Wire gasless taps + browser verify

**Files:** Modify `web/src/components/LiveMatchView.tsx`.

- [ ] On Join: mint the session (B4) alongside `join_live_pool`. On tap: if `hasValidSession()` → `buildLockPickTxER` (gasless); else fall back to base `buildLockPickTx` (popup).
- [ ] Browser verify on devnet: join once (one modal to mint session), then tap multiple open calls with **no modal**; `preview_network` shows router txs signed by the ephemeral key; standings reconcile on poll.
- [ ] Screenshot the gasless flow for the user. Commit.

---

## Self-Review (run before executing)

- **Spec coverage:** Slice 5 (web wiring: join/taps/standings/score/settle/claim + `livePoolClient` + engine poll) → Tasks A1–A7. Slice 6 (`#[session_auth_or]` + gum session mint) → Tasks B1–B6. Both covered.
- **Custody invariant:** join/claim always base + real wallet (A4); session key only signs `lock_pick` (B5). Held.
- **Type consistency:** `LivePoolView`/`CallView`/`LiveEntryView` mirror `engine/src/chain.ts`; `buildLockPickTx(playerAddress, poolId, seq, option)` signature identical in A4 and referenced in A6; `snapshotFromChain(data, entry, wallet, nowMs)` used consistently in A6.
- **Redeploy gate:** isolated to B3, explicit pause. Phase A ships with zero redeploy.
- **Residual risk flagged:** base-minted session token × ER runtime (B0 gates it; B-ALT is the Privy fallback).
- **Discovery:** `getMatches()` → first fixture with a pool (A5); no new engine route required.
