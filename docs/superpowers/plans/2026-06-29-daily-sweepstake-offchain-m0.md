# Daily Sweepstake — Off-Chain M0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the off-chain layer for the daily sweepstake so a user can see the live jackpot, pick a card, enter one ticket, and claim — the M0 vertical slice on devnet — over the already-merged on-chain program.

**Architecture:** Three layers over the merged Anchor program (`By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`). (1) **Engine** gains a read-only contest reader in `chain.ts` and two `/api/contest/*` routes — no custody. (2) **Keeper** gains two scripts: `create-contest.ts` (ensure per-match result markets → `create_contest`) and `settle-contest.ts` (settle result markets → count perfect tickets off-chain → `settle_contest`), plus pure helpers in `contest.ts`. (3) **Web** re-syncs the IDL, adds contest PDAs + `enter`/`claim_contest` tx-builders, a `SweepstakeView` tab (jackpot header, 1X2 card picks, enter one ticket, claim), and the nav change. M0 uses a **fixed fixture card** for the keeper (adaptive `fetchSlate` build, multi-ticket UI, the live "still alive" board, and the void refund path are M1).

**Tech Stack:** Fastify + `@coral-xyz/anchor` + `@solana/web3.js` v1 (engine, keeper); Vite/React + Privy (`@privy-io/react-auth/solana`) + Anchor (web); Vitest for engine/keeper/web unit tests; devnet `--dry-run` for keeper orchestration; `npm run build` (`tsc --noEmit && vite build`) + preview for web.

---

## Shared context for every implementer (read first)

You are working on the `feat/streak-pivot` branch of the ProofBet/Streak monorepo. The daily-sweepstake **on-chain program is already built, audited, and merged** — your job is purely off-chain. Do NOT modify anything under `programs/`. The design spec is `docs/superpowers/specs/2026-06-29-daily-sweepstake-design.md` (§11 engine, §12 keeper, §13 web, §14 M0 scope, §15 testing).

**Program facts (verbatim from the merged source + generated IDL):**

- Program id: `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`.
- Generated IDL (up to date with contest instructions): `target/idl/proofbet.json`. Engine loads it via `process.env.PROOFBET_IDL ?? "../../target/idl/proofbet.json"`; keeper via `process.env.PROOFBET_IDL ?? "../target/idl/proofbet.json"`. The **web copy** `web/src/idl/proofbet.json` is STALE (parimutuel-only) and is re-synced in Task 5.
- IDL instruction names (Anchor JS camel-cases them): `enter(nonce, picks)`, `claimContest()`, `createContest(contestId, fixtures, numMatches, entryPrice, lockTs, settleAfterTs, feeRecipient, feeBps)`, `settleContest(perfectCount)`, `voidContest()`, `initializeVault()`, `initializeMarket(fixtureId, marketId, args)`.
- IDL account names: `Contest`, `Entry`, `JackpotVault`, `Market`, `Position`, `Vault`. Anchor JS accessors are camel-cased: `program.account.contest`, `program.account.entry`, `program.account.jackpotVault`.

**Account shapes (field order = on-chain byte order):**

```rust
// JackpotVault (singleton). INIT_SPACE = 8+8+1 = 17; account size = 8 (disc) + 17 = 25 bytes.
pub struct JackpotVault { pub active_contest_id: u64, pub reserved: u64, pub bump: u8 }

pub struct Contest {
    pub contest_id: u64, pub settle_authority: Pubkey, pub fee_recipient: Pubkey,
    pub fixtures: [i64; 5], pub num_matches: u8, pub entry_price: u64,
    pub lock_ts: i64, pub settle_after_ts: i64, pub fee_bps: u16,
    pub status: ContestStatus,            // enum: Open=0, Settled=1, RolledOver=2, Voided=3
    pub winning_buckets: [u8; 5], pub entry_count: u64, pub perfect_count: u64,
    pub pot_snapshot: u64, pub distributable: u64, pub claimed_count: u64,
    pub claimed_total: u64, pub settled_ts: i64, pub bump: u8,
}

// Entry byte offsets: disc 0..8, bettor 8..40, contest 40..72, nonce 72..80, picks 80..85, amount 85..93, bump 93.
pub struct Entry { pub bettor: Pubkey, pub contest: Pubkey, pub nonce: u64, pub picks: [u8; 5], pub amount: u64, pub bump: u8 }
```

**PDA seeds (verbatim):**
- `jackpot_vault`: `[b"jackpot_vault"]`
- `contest`: `[b"contest", contest_id.to_le_bytes()]` (contest_id is **u64** → unsigned LE)
- `entry`: `[b"entry", contest.key(), bettor.key(), nonce.to_le_bytes()]` (nonce is **u64** → unsigned LE)
- `market` (existing, for result markets): `[b"market", fixture_id.to_le_bytes(), [market_id]]` (fixture_id is **i64** → signed LE; market_id is one byte). `RESULT_MARKET_ID = 12`.

**Money/solvency invariant:** the free pot is `vault.lamports − rent_floor − reserved`. `rent_floor = getMinimumBalanceForRentExemption(25)`. Never display a negative pot — clamp to 0.

**Conventions to follow:** TypeScript ESM with `.ts`/`.js` import specifiers exactly as the surrounding files use them (engine/web import sibling modules as `"./foo.ts"`; keeper test imports compiled siblings as `"../foo.js"`). Vitest everywhere (`npm run test` = `vitest run`). lamport amounts cross the wire as **decimal strings** (mirror `MarketView.totalPool`). Run `git add` + `git commit` after each task's tests pass.

---

## File structure

**Engine (`engine/`):**
- Modify `src/chain.ts` — add contest PDA derivations, `computePot` pure helper, `readJackpotVault`, `readActiveContest`, `listEntriesForWallet`, and the `ContestView`/`JackpotVaultView`/`EntryView` types.
- Modify `src/routes.ts` — add `GET /api/contest/today` and `GET /api/contest/entries`.
- Modify `test/chain.test.ts` — PDA + `computePot` unit tests.
- Modify `test/routes.test.ts` — contest route shape tests (mock chain).

**Keeper (`keeper/`):**
- Create `contest.ts` — pure helpers `computeContestParams`, `countPerfect`.
- Create `create-contest.ts` — ensure result markets + `create_contest` (fixed card via CLI args).
- Create `settle-contest.ts` — settle result markets + count perfect + `settle_contest`.
- Create `test/contest.test.ts` — unit tests for the two pure helpers.

**Web (`web/`):**
- Replace `src/idl/proofbet.json` — re-synced from `target/idl/proofbet.json`.
- Modify `src/lib/pdas.ts` — add `deriveJackpotVaultPda`, `deriveContestPda`, `deriveEntryPda`.
- Modify `src/lib/anchorClient.ts` — add `buildEnterTx`, `buildClaimContestTx`.
- Modify `src/lib/api.ts` — add `ContestToday`/`ContestEntry` types + `getContestToday`/`getContestEntries`.
- Modify `src/components/BottomNav.tsx` + `src/App.tsx` — nav change.
- Create `src/components/SweepstakeView.tsx` — the tab.
- Modify `test/lib.test.ts` — contest PDA unit tests.

---

## Task 1: Engine — contest reader in `chain.ts`

**Files:**
- Modify: `engine/src/chain.ts`
- Test: `engine/test/chain.test.ts`

The reader mirrors the existing `readMarket` pattern (Anchor `program.account.X.fetch`, lamports as strings). The pure parts — PDA derivation and pot math — are unit-tested; the thin Anchor fetch wrappers are exercised by the route tests (Task 2, mocked) and on devnet, exactly as `readMarket` is.

- [ ] **Step 1: Write the failing test**

Append to `engine/test/chain.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  deriveJackpotVaultPda, deriveContestPda, deriveEntryPda, computePot,
} from "../src/chain.ts";

const PROG = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("contest PDAs", () => {
  it("jackpot vault PDA is deterministic", () => {
    expect(deriveJackpotVaultPda(PROG).toBase58()).toBe(deriveJackpotVaultPda(PROG).toBase58());
  });
  it("contest PDA varies by contest id", () => {
    const a = deriveContestPda(PROG, 20269);
    const b = deriveContestPda(PROG, 20270);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
  it("entry PDA varies by nonce", () => {
    const contest = deriveContestPda(PROG, 20269);
    const bettor = PublicKey.default;
    expect(deriveEntryPda(PROG, contest, bettor, 0).toBase58())
      .not.toBe(deriveEntryPda(PROG, contest, bettor, 1).toBase58());
  });
});

describe("computePot", () => {
  it("nets out rent floor and reserved", () => {
    expect(computePot(1_000_000_000n, 2_000_000n, 300_000_000n)).toBe("697_000_000".replace(/_/g, ""));
  });
  it("clamps to zero when liabilities exceed balance", () => {
    expect(computePot(1_000_000n, 2_000_000n, 0n)).toBe("0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && npm run test -- chain`
Expected: FAIL — `deriveJackpotVaultPda`/`computePot` not exported.

- [ ] **Step 3: Write the implementation**

In `engine/src/chain.ts`, add `Buffer` to imports if missing (`import { Buffer } from "node:buffer";`) and append after the existing `derivePositionPda`:

```typescript
// ── Contest reader (daily sweepstake) ──────────────────────────────────────

/** JackpotVault account size: 8 (disc) + active_contest_id(u64) + reserved(u64) + bump(u8). */
const JACKPOT_VAULT_SIZE = 8 + 8 + 8 + 1;

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function deriveJackpotVaultPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
}
export function deriveContestPda(programId: PublicKey, contestId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(contestId)], programId)[0];
}
export function deriveEntryPda(
  programId: PublicKey, contest: PublicKey, bettor: PublicKey, nonce: number | bigint,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), contest.toBuffer(), bettor.toBuffer(), u64le(nonce)], programId,
  )[0];
}

/** Free pot = vault balance − rent floor − reserved liabilities, clamped at 0. Returns lamports as a string. */
export function computePot(lamports: bigint, rentFloor: bigint, reserved: bigint): string {
  const pot = lamports - rentFloor - reserved;
  return (pot > 0n ? pot : 0n).toString();
}

const CONTEST_STATUS = ["open", "settled", "rolledOver", "voided"] as const;
function contestStatusString(s: Record<string, unknown>): (typeof CONTEST_STATUS)[number] {
  if ("settled" in s) return "settled";
  if ("rolledOver" in s) return "rolledOver";
  if ("voided" in s) return "voided";
  return "open";
}

export interface JackpotVaultView {
  activeContestId: number;
  reserved: string;
  lamports: string;
  rentFloor: string;
  pot: string;
}

export interface ContestView {
  pubkey: string;
  contestId: number;
  settleAuthority: string;
  feeRecipient: string;
  fixtures: number[];           // length numMatches
  numMatches: number;
  entryPrice: string;
  lockTs: number;
  settleAfterTs: number;
  feeBps: number;
  status: "open" | "settled" | "rolledOver" | "voided";
  winningBuckets: number[];     // length numMatches
  entryCount: number;
  perfectCount: number;
  potSnapshot: string;
  distributable: string;
  claimedCount: number;
  claimedTotal: string;
  settledTs: number;
}

export interface EntryView {
  pubkey: string;
  nonce: number;
  picks: number[];              // raw [u8; 5]
  amount: string;
}

export async function readJackpotVault(): Promise<JackpotVaultView> {
  const program = loadProgram();
  const pda = deriveJackpotVaultPda(program.programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (program.account as any).jackpotVault.fetch(pda);
  const conn = program.provider.connection;
  const lamports = BigInt(await conn.getBalance(pda));
  const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(JACKPOT_VAULT_SIZE));
  const reserved = BigInt(v.reserved.toString());
  return {
    activeContestId: Number(v.activeContestId),
    reserved: reserved.toString(),
    lamports: lamports.toString(),
    rentFloor: rentFloor.toString(),
    pot: computePot(lamports, rentFloor, reserved),
  };
}

/** The currently-live contest, or null when none is live (vault.active_contest_id == 0). */
export async function readActiveContest(): Promise<ContestView | null> {
  const program = loadProgram();
  const vPda = deriveJackpotVaultPda(program.programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (program.account as any).jackpotVault.fetch(vPda);
  const activeId = Number(v.activeContestId);
  if (activeId === 0) return null;
  const cPda = deriveContestPda(program.programId, activeId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (program.account as any).contest.fetch(cPda);
  const nm = Number(c.numMatches);
  return {
    pubkey: cPda.toBase58(),
    contestId: Number(c.contestId),
    settleAuthority: c.settleAuthority.toBase58(),
    feeRecipient: c.feeRecipient.toBase58(),
    fixtures: (c.fixtures as { toNumber(): number }[]).slice(0, nm).map((f) => f.toNumber()),
    numMatches: nm,
    entryPrice: c.entryPrice.toString(),
    lockTs: Number(c.lockTs),
    settleAfterTs: Number(c.settleAfterTs),
    feeBps: Number(c.feeBps),
    status: contestStatusString(c.status),
    winningBuckets: (c.winningBuckets as number[]).slice(0, nm).map(Number),
    entryCount: Number(c.entryCount),
    perfectCount: Number(c.perfectCount),
    potSnapshot: c.potSnapshot.toString(),
    distributable: c.distributable.toString(),
    claimedCount: Number(c.claimedCount),
    claimedTotal: c.claimedTotal.toString(),
    settledTs: Number(c.settledTs),
  };
}

/** Every Entry the wallet holds in the live contest (empty if none / no live contest). */
export async function listEntriesForWallet(wallet: string): Promise<EntryView[]> {
  const program = loadProgram();
  const vPda = deriveJackpotVaultPda(program.programId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (program.account as any).jackpotVault.fetch(vPda);
  const activeId = Number(v.activeContestId);
  if (activeId === 0) return [];
  const cPda = deriveContestPda(program.programId, activeId);
  const bettor = new PublicKey(wallet);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accts: any[] = await (program.account as any).entry.all([
    { memcmp: { offset: 8, bytes: bettor.toBase58() } },        // bettor at offset 8
    { memcmp: { offset: 8 + 32, bytes: cPda.toBase58() } },     // contest at offset 40
  ]);
  return accts
    .map((a) => ({
      pubkey: a.publicKey.toBase58(),
      nonce: Number(a.account.nonce),
      picks: (a.account.picks as number[]).map(Number),
      amount: a.account.amount.toString(),
    }))
    .sort((x, y) => x.nonce - y.nonce);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && npm run test -- chain`
Expected: PASS (all contest PDA + computePot cases).

- [ ] **Step 5: Commit**

```bash
git add engine/src/chain.ts engine/test/chain.test.ts
git commit -m "feat(engine): contest reader — PDAs, pot math, vault/contest/entry readers"
```

---

## Task 2: Engine — `/api/contest/today` and `/api/contest/entries` routes

**Files:**
- Modify: `engine/src/routes.ts`
- Test: `engine/test/routes.test.ts`

`GET /api/contest/today` composes `readActiveContest` + `readJackpotVault` and joins each card fixture with team names/kickoff from the `LiveStore`. `GET /api/contest/entries?wallet=` returns the wallet's tickets. Both mirror the existing `/api/history` lazy-import + error handling.

- [ ] **Step 1: Write the failing test**

Append to `engine/test/routes.test.ts`. Extend the existing `vi.mock("../src/chain.ts", …)` factory so the contest readers are mockable, then add the route tests. If the existing mock factory cannot be extended in place, add these mocked exports to it:

```typescript
// inside the existing vi.mock("../src/chain.ts", …) return object, add:
    readActiveContest: vi.fn(async () => ({
      pubkey: "Contest111", contestId: 20269,
      settleAuthority: "Keep1111111111111111111111111111111111111111",
      feeRecipient: "Fee11111111111111111111111111111111111111111",
      fixtures: [101, 102, 103], numMatches: 3, entryPrice: "20000000",
      lockTs: 9999999999, settleAfterTs: 9999999999, feeBps: 500, status: "open",
      winningBuckets: [0, 0, 0], entryCount: 4, perfectCount: 0,
      potSnapshot: "0", distributable: "0", claimedCount: 0, claimedTotal: "0", settledTs: 0,
    })),
    readJackpotVault: vi.fn(async () => ({
      activeContestId: 20269, reserved: "0",
      lamports: "82000000", rentFloor: "2000000", pot: "80000000",
    })),
    listEntriesForWallet: vi.fn(async () => [
      { pubkey: "Entry111", nonce: 0, picks: [0, 1, 2, 0, 0], amount: "20000000" },
    ]),
```

New test block:

```typescript
describe("GET /api/contest/today", () => {
  it("returns the live contest with pot and a named card", async () => {
    const store = makeMockStore({
      getMatches: vi.fn(() => [
        { fixtureId: 101, home: "Brazil", away: "Spain", kickoffMs: 1, status: "upcoming",
          minute: null, phase: null, scoreH: 0, scoreA: 0, corners: 0, goals: 0, yellows: 0 },
      ]),
      getFixtureMeta: vi.fn(() => new Map([[102, { home: "Japan", away: "Peru" }]])),
    });
    const app = buildServer(store);
    const res = await app.inject({ url: "/api/contest/today" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("open");
    expect(body.pot).toBe("80000000");
    expect(body.contestId).toBe(20269);
    expect(body.card).toHaveLength(3);
    expect(body.card[0]).toMatchObject({ fixtureId: 101, home: "Brazil", away: "Spain" });
    expect(body.card[1]).toMatchObject({ fixtureId: 102, home: "Japan", away: "Peru" });
    await app.close();
  });
});

describe("GET /api/contest/entries", () => {
  it("400s without wallet", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/entries" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
  it("returns the wallet's tickets", async () => {
    const app = buildServer(makeMockStore());
    const res = await app.inject({ url: "/api/contest/entries?wallet=So11111111111111111111111111111111111111112" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ nonce: 0, amount: "20000000" });
    await app.close();
  });
});
```

If the existing `makeMockStore` helper does not include `getFixtureMeta`, add `getFixtureMeta: vi.fn(() => new Map())` to its default object.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine && npm run test -- routes`
Expected: FAIL — `/api/contest/today` returns 404.

- [ ] **Step 3: Write the implementation**

In `engine/src/routes.ts`, extend the chain import on line 4 and append the two routes before the closing brace of `registerRoutes`:

```typescript
import { readMarket, readActiveContest, readJackpotVault, listEntriesForWallet } from "./chain.ts";
```

```typescript
  // ── Contest endpoints (daily sweepstake) ──────────────────────────────────

  /**
   * GET /api/contest/today
   * The live contest joined with team names/kickoffs, plus the live free pot.
   * `{ status: "paused", pot, contest: null }` when no contest is live.
   */
  app.get("/api/contest/today", async (_req, reply) => {
    let vault, contest;
    try {
      [vault, contest] = await Promise.all([readJackpotVault(), readActiveContest()]);
    } catch (e) {
      reply.code(502);
      return { error: `contest read failed: ${(e as Error).message}` };
    }
    if (!contest) return { status: "paused", pot: vault.pot, contest: null };

    const byId = new Map((store?.getMatches() ?? []).map((m) => [m.fixtureId, m]));
    const names = store?.getFixtureMeta() ?? new Map<number, { home: string; away: string }>();
    const card = contest.fixtures.map((fixtureId) => {
      const live = byId.get(fixtureId);
      const meta = names.get(fixtureId);
      return {
        fixtureId,
        home: live?.home ?? meta?.home ?? `#${fixtureId}`,
        away: live?.away ?? meta?.away ?? "",
        kickoffMs: live?.kickoffMs ?? null,
      };
    });

    return {
      status: contest.status,
      contestId: contest.contestId,
      pot: vault.pot,
      entryPrice: contest.entryPrice,
      lockTs: contest.lockTs,
      settleAfterTs: contest.settleAfterTs,
      entryCount: contest.entryCount,
      numMatches: contest.numMatches,
      perfectCount: contest.perfectCount,
      distributable: contest.distributable,
      winningBuckets: contest.winningBuckets,
      card,
    };
  });

  /**
   * GET /api/contest/entries?wallet=<base58>
   * The wallet's Entry tickets for the live contest (empty if none).
   */
  app.get("/api/contest/entries", async (req, reply) => {
    const { wallet } = req.query as Record<string, string>;
    if (!wallet) {
      reply.code(400);
      return { error: "wallet query param required" };
    }
    try {
      return await listEntriesForWallet(wallet);
    } catch (e) {
      reply.code(502);
      return { error: `entries fetch failed: ${(e as Error).message}` };
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine && npm run test -- routes`
Expected: PASS. Then `cd engine && npm run test` — whole suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/routes.ts engine/test/routes.test.ts
git commit -m "feat(engine): GET /api/contest/today + /api/contest/entries"
```

---

## Task 3: Keeper — pure helpers + `create-contest.ts`

**Files:**
- Create: `keeper/contest.ts`
- Create: `keeper/create-contest.ts`
- Test: `keeper/test/contest.test.ts`

`computeContestParams` derives `contest_id` (epoch day of first kickoff), `lock_ts` (first kickoff), `settle_after_ts` (last kickoff + buffer), and orders fixtures by kickoff. `countPerfect` (used in Task 4) counts entries whose first `numMatches` picks all equal the winning buckets. `create-contest.ts` ensures each fixture's result market (market_id 12) exists, then calls `create_contest`; `--dry-run` prints the plan without sending.

- [ ] **Step 1: Write the failing test**

Create `keeper/test/contest.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { computeContestParams, countPerfect } from "../contest.js";

const DAY = 86_400_000;

describe("computeContestParams", () => {
  it("orders fixtures by kickoff and derives lock/settle/contest id", () => {
    const r = computeContestParams([
      { fixtureId: 200, kickoffMs: 3 * DAY + 7_200_000 }, // later
      { fixtureId: 100, kickoffMs: 3 * DAY + 3_600_000 }, // earlier
    ], 3 * 3600);
    expect(r.orderedFixtures).toEqual([100, 200]);
    expect(r.numMatches).toBe(2);
    expect(r.lockTs).toBe(Math.floor((3 * DAY + 3_600_000) / 1000));
    expect(r.settleAfterTs).toBe(Math.floor((3 * DAY + 7_200_000) / 1000) + 3 * 3600);
    expect(r.contestId).toBe(3); // epoch day of the first kickoff
    expect(r.contestId).toBeGreaterThan(0);
  });
});

describe("countPerfect", () => {
  const winning = [0, 1, 2];
  it("counts only entries matching every carded match", () => {
    const entries = [
      { picks: [0, 1, 2, 0, 0] }, // perfect
      { picks: [0, 1, 2, 1, 1] }, // perfect (tail beyond numMatches ignored)
      { picks: [0, 1, 1, 0, 0] }, // wrong on match 3
      { picks: [2, 1, 2, 0, 0] }, // wrong on match 1
    ];
    expect(countPerfect(entries, winning, 3)).toBe(2);
  });
  it("returns 0 when nobody is perfect", () => {
    expect(countPerfect([{ picks: [1, 1, 1, 0, 0] }], winning, 3)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd keeper && npm run test -- contest`
Expected: FAIL — cannot resolve `../contest.js`.

- [ ] **Step 3: Write the pure helpers**

Create `keeper/contest.ts`:

```typescript
/** Pure card-shaping + perfect-counting helpers for the daily sweepstake keeper. */

export interface CardFixture {
  fixtureId: number;
  kickoffMs: number;
}

export interface ContestParams {
  contestId: number;        // epoch day of the first kickoff (non-zero, deterministic)
  numMatches: number;
  lockTs: number;           // seconds — first kickoff
  settleAfterTs: number;    // seconds — last kickoff + bufferSecs
  orderedFixtures: number[];
}

/** Derive on-chain contest params from a card. `bufferSecs` is added after the last kickoff. */
export function computeContestParams(fixtures: CardFixture[], bufferSecs = 3 * 60 * 60): ContestParams {
  if (fixtures.length === 0) throw new Error("computeContestParams: empty card");
  const sorted = [...fixtures].sort((a, b) => a.kickoffMs - b.kickoffMs);
  const firstMs = sorted[0].kickoffMs;
  const lastMs = sorted[sorted.length - 1].kickoffMs;
  return {
    contestId: Math.floor(firstMs / 86_400_000),
    numMatches: sorted.length,
    lockTs: Math.floor(firstMs / 1000),
    settleAfterTs: Math.floor(lastMs / 1000) + bufferSecs,
    orderedFixtures: sorted.map((f) => f.fixtureId),
  };
}

/** Count entries whose first `numMatches` picks all equal the winning buckets. */
export function countPerfect(
  entries: { picks: number[] }[],
  winningBuckets: number[],
  numMatches: number,
): number {
  return entries.filter((e) => {
    for (let i = 0; i < numMatches; i++) if (e.picks[i] !== winningBuckets[i]) return false;
    return true;
  }).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd keeper && npm run test -- contest`
Expected: PASS.

- [ ] **Step 5: Write the `create-contest.ts` script**

Create `keeper/create-contest.ts`. It reuses `createContext`/`authenticateCached`/`loadProofbetProgram` exactly as `settle-all.ts` does, the `MARKET_TEMPLATE` result-market def (`MARKET_TEMPLATE[2]`, market_id 12), and `toInitArgs` from `spike/src/markets.js`. Fixed card via CLI: `npx tsx create-contest.ts <fixtureId:kickoffISO> ... [--entry-price=0.02] [--dry-run]`.

```typescript
/**
 * Open a daily sweepstake contest for a FIXED card (M0; adaptive build is M1).
 *
 * Usage:
 *   npx tsx create-contest.ts 101:2026-06-30T18:00:00Z 102:2026-06-30T20:00:00Z 103:2026-06-30T21:00:00Z \
 *     [--entry-price=0.02] [--fee-bps=500] [--dry-run]
 *
 * For each carded fixture it ensures the result market (market_id 12) exists — it MUST be
 * created (and later settled) by THIS keeper, because settle_contest binds
 * result_market.settle_authority == contest.settle_authority (v3.1 oracle binding). Then it
 * calls create_contest with the keeper as settle_authority and fee_recipient.
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { toInitArgs } from "../spike/src/markets.js";
import { MARKET_TEMPLATE } from "../engine/src/markets.js";
import { loadProofbetProgram } from "./settle.js";
import { computeContestParams } from "./contest.js";

const MAX_MATCHES = 5;
const RESULT_MARKET_ID = 12;
const LAMPORTS_PER_SOL = 1_000_000_000;

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const cards: { fixtureId: number; kickoffMs: number }[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v = "true"] = a.slice(2).split("=");
      flags[k] = v;
    } else {
      const [id, iso] = a.split(":");
      cards.push({ fixtureId: Number(id), kickoffMs: Date.parse(iso) });
    }
  }
  return { flags, cards };
}

async function main() {
  const { flags, cards } = parseArgs(process.argv.slice(2));
  if (cards.length < 3 || cards.length > MAX_MATCHES) {
    throw new Error(`provide 3..${MAX_MATCHES} fixtures as <id>:<kickoffISO>`);
  }
  const dryRun = flags["dry-run"] === "true";
  const entryPrice = Math.round(Number(flags["entry-price"] ?? "0.02") * LAMPORTS_PER_SOL);
  const feeBps = Number(flags["fee-bps"] ?? "500");

  const ctx = createContext(); // synchronous (see settle.ts/settle-all.ts)
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const programId = proofbet.programId;

  const params = computeContestParams(cards);
  const kickoffById = new Map(cards.map((c) => [c.fixtureId, c.kickoffMs]));

  console.log(JSON.stringify({
    action: "create_contest", contestId: params.contestId, fixtures: params.orderedFixtures,
    numMatches: params.numMatches, lockTs: params.lockTs, settleAfterTs: params.settleAfterTs,
    entryPrice, feeBps, keeper: keeper.toBase58(), dryRun,
  }, null, 2));

  // 1. Ensure each result market (market_id 12) exists, settle_authority = keeper.
  const resultDef = MARKET_TEMPLATE.find((m) => m.marketId === RESULT_MARKET_ID)!;
  for (const fixtureId of params.orderedFixtures) {
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), i64le(fixtureId), Buffer.from([RESULT_MARKET_ID])], programId,
    )[0];
    const vault = PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
    let exists: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      exists = (await (proofbet.account as any).market.fetchNullable(market)) !== null;
    } catch { exists = true; }
    if (exists) { console.log(`result market exists: fixture ${fixtureId}`); continue; }
    if (dryRun) { console.log(`would create result market: fixture ${fixtureId}`); continue; }
    const kickoffSec = Math.floor((kickoffById.get(fixtureId) ?? 0) / 1000);
    const sig = await proofbet.methods
      .initializeMarket(new BN(fixtureId), RESULT_MARKET_ID, toInitArgs(resultDef, keeper, kickoffSec))
      .accountsStrict({ creator: keeper, market, vault, systemProgram: SystemProgram.programId })
      .rpc();
    console.log(`created result market fixture ${fixtureId}: ${sig}`);
  }

  // 2. create_contest.
  const fixturesArg = padFixtures(params.orderedFixtures);
  const contest = PublicKey.findProgramAddressSync(
    [Buffer.from("contest"), u64le(params.contestId)], programId,
  )[0];
  const jackpotVault = PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
  if (dryRun) { console.log(`would create_contest ${contest.toBase58()}`); return; }
  const sig = await proofbet.methods
    .createContest(
      new BN(params.contestId), fixturesArg, params.numMatches, new BN(entryPrice),
      new BN(params.lockTs), new BN(params.settleAfterTs), keeper, feeBps,
    )
    .accountsStrict({ keeper, vault: jackpotVault, contest, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`create_contest: ${sig}`);
  console.log(`contest pubkey: ${contest.toBase58()}`);
}

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
/** Pad fixtures to [i64; 5] with BN(0) (program ignores entries beyond num_matches). */
function padFixtures(ids: number[]): BN[] {
  const out = ids.map((id) => new BN(id));
  while (out.length < MAX_MATCHES) out.push(new BN(0));
  return out;
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("create-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Verify the script typechecks**

Run: `cd keeper && npm run typecheck`
Expected: no errors. (Live devnet `--dry-run` is exercised in the final verification, after the keeper has a funded wallet + result markets — not in CI.)

- [ ] **Step 7: Commit**

```bash
git add keeper/contest.ts keeper/create-contest.ts keeper/test/contest.test.ts
git commit -m "feat(keeper): create-contest script + pure card/perfect-count helpers"
```

---

## Task 4: Keeper — `settle-contest.ts`

**Files:**
- Create: `keeper/settle-contest.ts`

Settles the live contest: reads `vault.active_contest_id` → the `Contest`, settles each fixture's result market via the existing `settleMarketByPubkey` (reused from `settle.ts`), reads back each market's `winning_bucket`, counts perfect entries with `countPerfect`, then calls `settle_contest(perfect_count)` with the result-market accounts as `remainingAccounts`. `--dry-run` stops before any send. No new pure logic (covered by Task 3's tests); verified by typecheck + devnet dry-run.

- [ ] **Step 1: Write the script**

Create `keeper/settle-contest.ts`:

```typescript
/**
 * Settle the live daily sweepstake contest (M0).
 *
 * Usage: npx tsx settle-contest.ts [--dry-run]
 *
 * 1. Read jackpot_vault.active_contest_id → the live Contest.
 * 2. For each carded fixture, settle its result market (market_id 12) via the existing
 *    proof path (settleMarketByPubkey) — skips if already settled/voided.
 * 3. Read each result market's winning_bucket, count perfect entries off-chain.
 * 4. Call settle_contest(perfect_count) with the result-market accounts as remaining_accounts.
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { loadProofbetProgram, settleMarketByPubkey } from "./settle.js";
import { countPerfect } from "./contest.js";

const RESULT_MARKET_ID = 12;

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function u64le(n: number | bigint): Buffer { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const ctx = createContext(); // synchronous (see settle.ts/settle-all.ts)
  const auth = await authenticateCached(ctx);
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const programId = proofbet.programId;

  const jackpotVault = PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = await (proofbet.account as any).jackpotVault.fetch(jackpotVault);
  const activeId = Number(v.activeContestId);
  if (activeId === 0) { console.log("no live contest"); return; }

  const contest = PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(activeId)], programId)[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = await (proofbet.account as any).contest.fetch(contest);
  const nm = Number(c.numMatches);
  const fixtures: number[] = (c.fixtures as { toNumber(): number }[]).slice(0, nm).map((f) => f.toNumber());

  // 1. Settle each result market (idempotent — skips already settled/voided).
  const resultMarkets: PublicKey[] = [];
  for (const fixtureId of fixtures) {
    const market = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), i64le(fixtureId), Buffer.from([RESULT_MARKET_ID])], programId,
    )[0];
    resultMarkets.push(market);
    const r = await settleMarketByPubkey(ctx, auth, proofbet, market, { dryRun });
    console.log(`result market fixture ${fixtureId}: ${r.action}`);
  }

  // 2. Read winning buckets + count perfect entries.
  const winningBuckets: number[] = [];
  for (const market of resultMarkets) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m: any = await (proofbet.account as any).market.fetchNullable(market);
    winningBuckets.push(m?.winningBucket ?? -1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: any[] = await (proofbet.account as any).entry.all([
    { memcmp: { offset: 8 + 32, bytes: contest.toBase58() } }, // contest at offset 40
  ]);
  const perfectCount = winningBuckets.includes(-1)
    ? 0
    : countPerfect(entries.map((e) => ({ picks: e.account.picks as number[] })), winningBuckets, nm);

  console.log(JSON.stringify({
    action: "settle_contest", contestId: activeId, fixtures, winningBuckets,
    entries: entries.length, perfectCount, dryRun,
  }, null, 2));

  if (winningBuckets.includes(-1)) {
    console.warn("a result market has no winning bucket (abandoned match) — run void-contest instead; aborting.");
    return;
  }
  if (dryRun) { console.log("dry-run: not sending settle_contest"); return; }

  // 3. settle_contest(perfect_count) with result markets as remaining_accounts.
  const sig = await proofbet.methods
    .settleContest(new BN(perfectCount))
    .accountsStrict({
      settleAuthority: keeper,
      vault: jackpotVault,
      contest,
      feeRecipient: c.feeRecipient,
    })
    .remainingAccounts(resultMarkets.map((pubkey) => ({ pubkey, isWritable: false, isSigner: false })))
    .rpc();
  console.log(`settle_contest: ${sig}`);
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O), mirroring settle.ts/settle-all.ts.
const isMain = process.argv[1]?.endsWith("settle-contest.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd keeper && npm run typecheck`
Expected: no errors. If `settleMarketByPubkey` is not exported from `settle.ts`, add it to that file's exports (the engine map confirms it is already exported).

- [ ] **Step 3: Commit**

```bash
git add keeper/settle-contest.ts
git commit -m "feat(keeper): settle-contest script — settle result markets, count perfect, settle_contest"
```

---

## Task 5: Web — IDL re-sync + contest PDAs + tx builders

**Files:**
- Replace: `web/src/idl/proofbet.json`
- Modify: `web/src/lib/pdas.ts`
- Modify: `web/src/lib/anchorClient.ts`
- Test: `web/test/lib.test.ts`

The web IDL is stale (parimutuel-only). Re-sync it, add the three contest PDA derivations, and add `buildEnterTx`/`buildClaimContestTx` mirroring the existing `buildPlaceBetTx`/`buildClaimTx`.

- [ ] **Step 1: Re-sync the IDL**

Run (from repo root):
```bash
cp target/idl/proofbet.json web/src/idl/proofbet.json
node -e "console.log(require('./web/src/idl/proofbet.json').instructions.map(i=>i.name).join(', '))"
```
Expected output includes: `claim, claim_contest, create_contest, enter, initialize_market, initialize_vault, place_bet, settle, settle_contest, void_contest, void_market`.

- [ ] **Step 2: Write the failing test**

Append to `web/test/lib.test.ts`:

```typescript
import { deriveJackpotVaultPda, deriveContestPda, deriveEntryPda } from "../src/lib/pdas.ts";

describe("contest pdas", () => {
  it("derives vault/contest/entry and varies by id + nonce", () => {
    const vault = deriveJackpotVaultPda(P);
    const c1 = deriveContestPda(P, 20269);
    const c2 = deriveContestPda(P, 20270);
    const e0 = deriveEntryPda(P, c1, PublicKey.default, 0);
    const e1 = deriveEntryPda(P, c1, PublicKey.default, 1);
    expect(vault).toBeInstanceOf(PublicKey);
    expect(c1.toBase58()).not.toBe(c2.toBase58());
    expect(e0.toBase58()).not.toBe(e1.toBase58());
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npm run test`
Expected: FAIL — `deriveJackpotVaultPda` not exported.

- [ ] **Step 4: Add the PDA helpers**

Append to `web/src/lib/pdas.ts`:

```typescript
function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
export function deriveJackpotVaultPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], programId)[0];
}
export function deriveContestPda(programId: PublicKey, contestId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("contest"), u64le(contestId)], programId)[0];
}
export function deriveEntryPda(
  programId: PublicKey, contest: PublicKey, bettor: PublicKey, nonce: number | bigint,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entry"), contest.toBuffer(), bettor.toBuffer(), u64le(nonce)], programId,
  )[0];
}
```

- [ ] **Step 5: Add the tx builders**

In `web/src/lib/anchorClient.ts`, extend the pdas import on line 6 and append the two builders:

```typescript
import {
  deriveMarketPda, deriveVaultPda, derivePositionPda,
  deriveJackpotVaultPda, deriveContestPda, deriveEntryPda,
} from "./pdas.ts";
```

```typescript
/** Build an unsigned enter(nonce, picks) transaction. `picks` is per-match 0/1/2, padded to length 5. */
export async function buildEnterTx(
  payerAddress: string, contestId: number, nonce: number, picks: number[],
): Promise<Transaction> {
  const payer = new PublicKey(payerAddress);
  const program = readonlyProgram(payer);
  const vault = deriveJackpotVaultPda(PROGRAM_ID);
  const contest = deriveContestPda(PROGRAM_ID, contestId);
  const entry = deriveEntryPda(PROGRAM_ID, contest, payer, nonce);
  const padded = [...picks];
  while (padded.length < 5) padded.push(0);
  const tx = await program.methods
    .enter(new anchor.BN(nonce), padded.slice(0, 5))
    .accountsStrict({ bettor: payer, vault, contest, entry, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, payer);
}

/** Build an unsigned claim_contest transaction for one ticket (nonce). */
export async function buildClaimContestTx(
  payerAddress: string, contestId: number, nonce: number,
): Promise<Transaction> {
  const payer = new PublicKey(payerAddress);
  const program = readonlyProgram(payer);
  const vault = deriveJackpotVaultPda(PROGRAM_ID);
  const contest = deriveContestPda(PROGRAM_ID, contestId);
  const entry = deriveEntryPda(PROGRAM_ID, contest, payer, nonce);
  const tx = await program.methods
    .claimContest()
    .accountsStrict({ bettor: payer, vault, contest, entry, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, payer);
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `cd web && npm run test && npm run build`
Expected: PASS, no type errors (web has no standalone `typecheck` script — `npm run build` runs `tsc --noEmit && vite build`).

- [ ] **Step 7: Commit**

```bash
git add web/src/idl/proofbet.json web/src/lib/pdas.ts web/src/lib/anchorClient.ts web/test/lib.test.ts
git commit -m "feat(web): re-sync IDL + contest PDAs + enter/claim_contest tx builders"
```

---

## Task 6: Web — api client + nav change

**Files:**
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/components/BottomNav.tsx`
- Modify: `web/src/App.tsx`

Add the contest HTTP client functions/types, then change the nav: `Tab` becomes `"sweepstake" | "markets" | "bets" | "wallet"`, Sweepstake is first and default, and the existing match board is relabeled "Live" → "Markets" (tab key `live` → `markets`). Verified by `npm run build` + preview.

- [ ] **Step 1: Add the api client**

Append to `web/src/lib/api.ts`:

```typescript
// --- Daily sweepstake (contest)
export interface ContestCardMatch { fixtureId: number; home: string; away: string; kickoffMs: number | null }
export interface ContestToday {
  status: "open" | "settled" | "rolledOver" | "voided" | "paused";
  pot: string;
  contest?: null; // present only when paused
  contestId?: number;
  entryPrice?: string;
  lockTs?: number;
  settleAfterTs?: number;
  entryCount?: number;
  numMatches?: number;
  perfectCount?: number;
  distributable?: string;
  winningBuckets?: number[];
  card?: ContestCardMatch[];
}
export interface ContestEntry { pubkey: string; nonce: number; picks: number[]; amount: string }

export const getContestToday = (): Promise<ContestToday> =>
  fetch(`${ENGINE}/api/contest/today`).then(json);
export const getContestEntries = (wallet: string): Promise<ContestEntry[]> =>
  fetch(`${ENGINE}/api/contest/entries?wallet=${wallet}`).then(json);
```

- [ ] **Step 2: Change the nav (BottomNav.tsx)**

In `web/src/components/BottomNav.tsx`: change the `Tab` type, add a `sweepstake` icon, relabel `live` → "Markets", reorder. Replace the type (line 1), the `ICONS` record, the `LABELS` record (line 26), and `TABS` (line 27):

```typescript
export type Tab = "sweepstake" | "markets" | "bets" | "wallet";
```

Add a `sweepstake` entry to `ICONS` (a trophy glyph) and rename the `live` key to `markets`:

```typescript
const ICONS: Record<Tab, React.ReactNode> = {
  sweepstake: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4h10v3a5 5 0 01-10 0z" />
      <path d="M7 5H4.5v1.5A2.5 2.5 0 007 9M17 5h2.5v1.5A2.5 2.5 0 0117 9" />
      <path d="M12 12v3M9 19h6M10 19l.5-4h3l.5 4" />
    </svg>
  ),
  markets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M6.3 6.3a8 8 0 000 11.4M17.7 6.3a8 8 0 010 11.4" />
      <path d="M9.2 9.2a4 4 0 000 5.6M14.8 9.2a4 4 0 010 5.6" />
    </svg>
  ),
  bets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7.5A1.5 1.5 0 015.5 6h13A1.5 1.5 0 0120 7.5V10a2 2 0 000 4v2.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 16.5V14a2 2 0 000-4z" />
      <path d="M9.2 6.2v11.6" strokeDasharray="2 2.2" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8A2.5 2.5 0 016 5.5h11" />
      <rect x="3.5" y="7.5" width="17" height="11.5" rx="2.5" />
      <circle cx="16.5" cy="13.2" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const LABELS: Record<Tab, string> = { sweepstake: "Sweepstake", markets: "Markets", bets: "My Bets", wallet: "Wallet" };
const TABS: Tab[] = ["sweepstake", "markets", "bets", "wallet"];
```

- [ ] **Step 3: Change App.tsx**

In `web/src/App.tsx`: default the tab to `"sweepstake"`, import + render `SweepstakeView`, and rename the `live` branch to `markets`. Update the import line and the state + render block:

```typescript
import { SweepstakeView } from "./components/SweepstakeView.tsx";
```

```typescript
const [tab, setTab] = useState<Tab>("sweepstake");
```

```tsx
{tab === "sweepstake" && <SweepstakeView />}
{tab === "markets" && (
  <>
    <MatchList />
    <div className="trust">
      <span className="seal">◆</span> Every market self-settles on a verifiable proof.
    </div>
  </>
)}
{tab === "bets" && <BetsView />}
{tab === "wallet" && <WalletView />}
```

- [ ] **Step 4: Verify the build**

Run: `cd web && npm run build` (web has no standalone `typecheck`; `build` runs `tsc --noEmit && vite build`).
Expected: ONE error — `SweepstakeView` module not found (it's built in Task 7). That is expected at this step. Create the one-line placeholder export below to keep this commit compiling (Task 7 replaces it entirely):

Temporarily acceptable minimal stub to keep this commit compiling (Task 7 replaces it entirely):
```tsx
// web/src/components/SweepstakeView.tsx (placeholder — replaced in Task 7)
export function SweepstakeView() { return <div className="card">Loading…</div>; }
```

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/components/BottomNav.tsx web/src/App.tsx web/src/components/SweepstakeView.tsx
git commit -m "feat(web): contest api client + Sweepstake-first nav (Live→Markets)"
```

---

## Task 7: Web — `SweepstakeView` component (jackpot, picks, enter, claim)

**Files:**
- Replace: `web/src/components/SweepstakeView.tsx`
- Test: verified via `npm run build` + preview (web component tests run in Node with no DOM, per the project's Vitest setup — there is no component-render test harness; the spec's web acceptance is "typecheck + preview", satisfied by `tsc --noEmit` inside `npm run build`).

Build the full view: jackpot header (pot + countdown to `lock_ts` + paused badge), today's card with 1X2 pick buttons reusing the `r3` styling from `ResultSelector`, an "Enter — N ◎" button that signs `enter(nonce=0, picks)`, the wallet's existing tickets, and a claim button after settlement. M0 is **one ticket** (nonce 0); "+ Add another ticket" is M1.

- [ ] **Step 1: Write the component**

Replace `web/src/components/SweepstakeView.tsx` with:

```tsx
import { useEffect, useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildEnterTx, buildClaimContestTx } from "../lib/anchorClient.ts";
import { getContestToday, getContestEntries, type ContestToday, type ContestEntry } from "../lib/api.ts";
import { LAMPORTS, SOL, fmtSol } from "../lib/odds.ts";

const OUTCOME_CLASS = ["home", "draw", "away"] as const;
function outcomeLabel(idx: number, home: string, away: string): string {
  return idx === 0 ? home : idx === 1 ? "Draw" : away;
}

export function SweepstakeView() {
  const { address, signAndSend } = usePrivySigner();
  const [today, setToday] = useState<ContestToday>();
  const [entries, setEntries] = useState<ContestEntry[]>([]);
  const [picks, setPicks] = useState<Record<number, number>>({}); // fixtureId → bucket
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);

  function flash(t: string, err = false) { setMsg(t); setMsgErr(err); }

  async function refresh() {
    const t = await getContestToday();
    setToday(t);
    if (address && t.status !== "paused") setEntries(await getContestEntries(address));
    else setEntries([]);
  }
  useEffect(() => { refresh().catch((e) => flash((e as Error).message, true)); }, [address]);

  if (!today) return <div className="card">Loading…</div>;

  if (today.status === "paused") {
    return (
      <div className="card jackpot">
        <div className="jackpot-pot">{fmtSol(Number(today.pot))}{SOL}</div>
        <div className="muted">No card today — the pot rolls forward.</div>
      </div>
    );
  }

  const card = today.card ?? [];
  const settled = today.status === "settled" || today.status === "rolledOver" || today.status === "voided";
  const allPicked = card.every((m) => picks[m.fixtureId] != null);
  const entryPriceSol = fmtSol(Number(today.entryPrice ?? 0));

  async function enter() {
    if (!address) { flash("Log in to enter", true); return; }
    if (!allPicked) { flash("Pick every match", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      const orderedPicks = card.map((m) => picks[m.fixtureId]);
      const tx = await buildEnterTx(address, today.contestId!, 0, orderedPicks);
      const sig = await signAndSend(tx);
      flash(`Entered · ${sig.slice(0, 8)}…`);
      await refresh();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function claim(nonce: number) {
    if (!address) return;
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimContestTx(address, today.contestId!, nonce);
      const sig = await signAndSend(tx);
      flash(`Claimed · ${sig.slice(0, 8)}…`);
      await refresh();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  return (
    <div className="sweepstake">
      <div className="card jackpot">
        <div className="jackpot-label">Daily Jackpot</div>
        <div className="jackpot-pot">{fmtSol(Number(today.pot))}{SOL}</div>
        <div className="muted">
          {settled ? "Settled" : `Locks soon · ${today.entryCount ?? 0} entries`}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Today's card</div>
        {card.map((m, i) => {
          const winner = settled ? today.winningBuckets?.[i] : undefined;
          return (
            <div key={m.fixtureId} className="contest-row">
              <div className="contest-teams">{m.home} <span className="muted">v</span> {m.away}</div>
              <div className="result3">
                {[0, 1, 2].map((b) => {
                  const sel = picks[m.fixtureId] === b;
                  const won = settled && winner === b;
                  return (
                    <button
                      key={b}
                      className={`r3 r3-${OUTCOME_CLASS[b]}${sel ? " sel" : ""}${won ? " won" : ""}`}
                      aria-pressed={!settled ? sel : undefined}
                      disabled={settled}
                      onClick={() => !settled && setPicks((p) => ({ ...p, [m.fixtureId]: b }))}
                    >
                      <span className="r3-team">{won ? "✓ " : ""}{outcomeLabel(b, m.home, m.away)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {!settled && (
          <button className="btn" disabled={busy || !allPicked} aria-busy={busy} onClick={enter} style={{ marginTop: 12 }}>
            {busy ? "…" : `Enter — ${entryPriceSol} ${SOL}`}
          </button>
        )}
        {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      </div>

      {entries.length > 0 && (
        <div className="card">
          <div className="card-title">Your tickets</div>
          {entries.map((e) => (
            <div key={e.pubkey} className="contest-ticket">
              <span>Ticket #{e.nonce} · {fmtSol(Number(e.amount))}{SOL}</span>
              {settled && (
                <button className="btn-sm" disabled={busy} onClick={() => claim(e.nonce)}>
                  {today.status === "voided" ? "Refund" : "Claim"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add minimal styles**

Append to `web/src/App.css` (match the existing palette — `--green`, `.card`, `.btn` already exist):

```css
.jackpot { text-align: center; }
.jackpot-label { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted, #9AA2B1); }
.jackpot-pot { font-size: 40px; font-weight: 800; color: var(--accent, #FF6A1A); font-variant-numeric: tabular-nums; margin: 4px 0; }
.card-title { font-weight: 700; margin-bottom: 10px; }
.contest-row { padding: 10px 0; border-top: 1px solid var(--line, #1c222d); }
.contest-row:first-of-type { border-top: none; }
.contest-teams { font-size: 14px; margin-bottom: 8px; }
.contest-ticket { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; }
.btn-sm { padding: 6px 12px; border-radius: 8px; background: var(--accent, #FF6A1A); color: #07090d; border: none; font-weight: 700; cursor: pointer; }
```

- [ ] **Step 3: Verify the build**

Run: `cd web && npm run build` (runs `tsc --noEmit && vite build`).
Expected: no type errors; production build succeeds.

- [ ] **Step 4: Preview-verify**

Start the engine (`cd engine && npm run dev`) and web (`cd web && npm run dev`), then in the preview confirm: Sweepstake is the first/default tab; the jackpot pot renders; with no live contest it shows the paused card; the nav shows Sweepstake · Markets · My Bets · Wallet. (Full enter→settle→claim e2e is the M0 devnet demo, run after Task 4's keeper opens a real contest.)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SweepstakeView.tsx web/src/App.css
git commit -m "feat(web): SweepstakeView — jackpot header, 1X2 card picks, enter + claim"
```

---

## Self-Review

**1. Spec coverage (§11–§15):**
- §11 `/api/contest/today` → Task 2 ✓; `/api/contest/entries` → Task 2 ✓; `/api/contest/alive` → **M1 (out of M0 scope, §14)**, intentionally omitted. `COMPETITION_ALLOWLIST` → **already implemented** in `config.ts`/`catalog.ts:107` (verified), no task needed.
- §12 keeper open (ensure result markets + `create_contest`) → Task 3 ✓; settle (settle result markets + count perfect + `settle_contest`) → Task 4 ✓. Adaptive `fetchSlate` build → M1 (M0 uses a fixed card, §14) ✓.
- §13.1 nav change → Task 6 ✓; §13.2 `SweepstakeView` (jackpot header, card 1X2 picks, enter one ticket, claim) → Task 7 ✓. Multi-ticket UI, live "still alive" board, streak chip, share card → M1 (§14) ✓.
- §15 testing: engine contest reader + route shapes (Task 1/2) ✓; perfect-count counter + card-build (Task 3) ✓; web typecheck + preview (Task 7) ✓.

**2. Placeholder scan:** Every code step has complete code. The one deliberate temporary stub (Task 6 Step 4 `SweepstakeView` placeholder) is explicitly replaced in Task 7 and called out as temporary — not a hidden TODO.

**3. Type consistency:** `deriveJackpotVaultPda`/`deriveContestPda`/`deriveEntryPda` have identical signatures in engine `chain.ts` (Task 1) and web `pdas.ts` (Task 5). `computePot(bigint, bigint, bigint) → string` used consistently. `ContestView`/`ContestToday` field names match what the route returns (Task 2) and the client consumes (Task 6/7): `status`, `pot`, `contestId`, `entryPrice`, `entryCount`, `numMatches`, `winningBuckets`, `card[]`. `countPerfect(entries, winningBuckets, numMatches)` and `computeContestParams(fixtures, bufferSecs)` signatures match between Task 3's definition and Task 4's use. Instruction method names (`enter`, `claimContest`, `createContest`, `settleContest`, `initializeMarket`) match the verified IDL. `picks` is padded to `[u8; 5]` on both write paths (keeper `padFixtures` for fixtures; web `buildEnterTx` for picks).

**Out of scope (M1+, per §14):** `/api/contest/alive`, adaptive `fetchSlate` card-build + skip-on-thin, multi-ticket UI, live "still alive" board, `void_contest` keeper script + refund UI path, streak chip, share card, rolled-days/paused badge polish.
