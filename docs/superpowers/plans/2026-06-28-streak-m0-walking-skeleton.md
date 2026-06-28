# Streak M0 — Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the smallest real product — one fixture, one market (Total Corners O/U 9.5), the complete on-chain parimutuel lifecycle (bet → settle-from-proof → claim) through a real Privy-login PWA, on devnet.

**Architecture:** Reuse the existing `proofbet` Anchor program + `spike/` TxLINE proof modules + `keeper/settle.ts` **unchanged**. Add two new packages: `engine/` (Fastify, TypeScript — TxLINE-token-protected reads + a replayable match feed) and `web/` (Vite + React PWA — Privy embedded-wallet login, reads market state from `engine`, builds bet/claim txs with Anchor and signs them via Privy). Settlement for M0 is run with the existing keeper CLI; market creation is a one-off script.

**Tech Stack:** Anchor 0.32 / `@coral-xyz/anchor@0.32.1` + `@solana/web3.js@1.98.4` (write path), `@privy-io/react-auth@3.32.2` + `@solana/kit` (login/sign), Vite + `vite-plugin-pwa@1.3.0` + `vite-plugin-node-polyfills@0.28.0`, Fastify `5.9.0` + `@fastify/cors@11.2.0`, `vitest` for tests, `tsx` to run TS. Devnet RPC `https://api.devnet.solana.com`; TxLINE dev base `https://txline-dev.txodds.com`.

---

## Reference: exact on-chain interface (do not re-derive)

Program id `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`. IDL at `target/idl/proofbet.json` (has top-level `address`). Buckets: **`OVER=0`** (predicate TRUE) / **`UNDER=1`** (FALSE).

PDA seeds (all `findProgramAddressSync` against the proofbet program id):
- **Market:** `[Buffer.from("market"), i64le(fixture_id), u8(market_id)]`
- **Vault:** `[Buffer.from("vault"), marketPubkey.toBuffer()]`
- **Position:** `[Buffer.from("position"), marketPubkey.toBuffer(), bettor.toBuffer()]`

Instructions used in M0:
- `initialize_market(fixture_id: i64, market_id: u8, args: InitMarketArgs)` — accounts: `creator`(signer,mut), `market`(PDA,init), `vault`(PDA,init), `systemProgram`. `InitMarketArgs = { settle_authority: PublicKey, fee_recipient: PublicKey | null, stat_key: u32, stat_key2: u32 | null, op: {add:{}}|{subtract:{}}|null, comparison: {greaterThan:{}}|{lessThan:{}}|{equalTo:{}}, threshold: i32, entry_close_ts: i64 (unix **seconds**), fee_bps: u16 }`.
- `place_bet(bucket: u8, amount: u64)` — accounts: `bettor`(signer,mut), `market`(mut), `vault`(mut), `position`(PDA, init_if_needed, mut), `systemProgram`.
- `claim()` — accounts: `bettor`(signer,mut), `market`, `vault`(mut), `position`(mut, closed to bettor), `systemProgram`.
- `settle(...)` — run via `keeper/settle.ts`, not from the app.

The M0 market predicate (Total Corners O/U 9.5): `stat_key=7` (P1 corners), `stat_key2=8` (P2 corners), `op={add:{}}`, `comparison={greaterThan:{}}`, `threshold=9`. "Over 9.5" ⇔ `(c1+c2) > 9`.

Reusable spike exports (import from `../spike/src/<mod>.js`, ESM, like the keeper does):
- `auth.ts`: `createContext(): SpikeContext` (`{connection, wallet, provider, program, baseUrl, authBaseUrl}`), `authenticate(ctx): Promise<{jwt, apiToken}>`.
- `discover.ts`: `getScoreHistory(ctx, auth, fixtureId): Promise<ScoreEvent[]>` (each `ScoreEvent` has `.Seq`, `.Ts`, `.StatusId`, `.Stats: Record<string, number>` keyed by stat-key string), `resolvePhase(ev): {code, label}`.
- `config.ts`: `SOCCER_STAT.{P1_CORNERS:7,P2_CORNERS:8,P1_GOALS:1,P2_GOALS:2}`, `FINISHED_PHASES`, `DEVNET.apiBase`.
- `util.ts`: `env`, `loadWallet`, logging helpers.

---

## File structure (created/modified by this plan)

```
ProofBet/
├── Anchor.toml                      # MODIFY: add [programs.devnet]
├── engine/                          # NEW package (Fastify, ESM, tsx)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── .env.example
│   ├── src/
│   │   ├── server.ts                # Fastify app factory (buildServer) + listen
│   │   ├── config.ts                # M0 market/fixture constants, lamports helpers
│   │   ├── chain.ts                 # PDA derivation + read Market account → MarketView
│   │   ├── odds.ts                  # pure pool-implied-odds math
│   │   ├── feed.ts                  # replay-file match feed (corners/phase cursor)
│   │   └── routes.ts                # /health, /api/market, /api/match
│   ├── scripts/
│   │   ├── create-market.ts         # one-off: initialize_market on devnet
│   │   └── capture-replay.ts        # capture a fixture's corners progression → replay.json
│   ├── data/
│   │   └── replay.json              # captured/synthetic corners timeline for the demo
│   └── test/
│       ├── odds.test.ts
│       ├── feed.test.ts
│       └── routes.test.ts
└── web/                             # NEW package (Vite + React + TS)
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts               # react + nodePolyfills + VitePWA
    ├── index.html
    ├── .env.example
    ├── public/
    │   ├── pwa-192x192.png
    │   └── pwa-512x512.png
    └── src/
        ├── main.tsx                 # mounts <Providers><App/>
        ├── providers.tsx            # PrivyProvider config (solana-only, devnet)
        ├── idl/proofbet.json        # COPY of target/idl/proofbet.json
        ├── lib/
        │   ├── pdas.ts              # PDA derivation (mirrors engine/chain.ts)
        │   ├── odds.ts              # COPY of engine odds math (pure)
        │   ├── anchorClient.ts     # getProgram(address, privySign) + tx builders
        │   └── api.ts              # fetch /api/market, /api/match from engine
        ├── hooks/usePrivySigner.ts  # bridges Privy sign → bytes
        ├── components/
        │   ├── LoginBar.tsx
        │   ├── MarketCard.tsx
        │   ├── BetForm.tsx
        │   └── ClaimButton.tsx
        ├── App.tsx
        └── App.css                  # Streak palette (#FF6A1A / #07090d / #3DE08A)
```

---

## Phase A — Devnet deploy

### Task A1: Deploy `proofbet` to devnet and publish the IDL

**Files:**
- Modify: `Anchor.toml`
- Verify: `target/idl/proofbet.json`, `target/deploy/proofbet-keypair.json`

- [ ] **Step 1: Point the Solana CLI at devnet and check the deployer key**

Run:
```bash
solana config set --url https://api.devnet.solana.com
solana address
solana balance
```
Expected: prints your devnet address and a SOL balance.

- [ ] **Step 2: Fund the deployer (needs ~3–5 SOL for a program deploy)**

Run:
```bash
solana airdrop 2 || true
solana balance
```
Expected: balance ≥ ~3 SOL. If the faucet rate-limits, repeat or use https://faucet.solana.com for the printed address. **Do not proceed past ~3 SOL short** — the deploy will fail with "insufficient funds".

- [ ] **Step 3: Confirm the program keypair matches the declared id**

Run:
```bash
solana address -k target/deploy/proofbet-keypair.json
```
Expected: `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ` (matches `declare_id!` in `programs/proofbet/src/lib.rs`). If it differs, that's fine for devnet — note the printed id and use it everywhere the plan says `By8y6...`.

- [ ] **Step 4: Add a devnet program entry to `Anchor.toml`**

Add this block to `Anchor.toml` (next to `[programs.localnet]`):
```toml
[programs.devnet]
proofbet = "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ"
```

- [ ] **Step 5: Build and deploy to devnet**

Run:
```bash
anchor build
anchor deploy --provider.cluster devnet
```
Expected: `Deploy success`, prints the program id. The IDL is regenerated at `target/idl/proofbet.json`.

- [ ] **Step 6: Verify the program is live on devnet**

Run:
```bash
solana program show By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ --url https://api.devnet.solana.com
```
Expected: prints program account details (ProgramData, authority), not "account not found".

- [ ] **Step 7: Commit**

```bash
git add Anchor.toml target/idl/proofbet.json
git commit -m "chore: deploy proofbet to devnet + add devnet program entry"
```

---

## Phase B — Engine (Fastify)

### Task B1: Scaffold the `engine/` package + `/health`

**Files:**
- Create: `engine/package.json`, `engine/tsconfig.json`, `engine/vitest.config.ts`, `engine/.env.example`, `engine/src/server.ts`, `engine/test/routes.test.ts`

- [ ] **Step 1: Create `engine/package.json`**

```json
{
  "name": "streak-engine",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "create-market": "tsx scripts/create-market.ts",
    "capture-replay": "tsx scripts/capture-replay.ts"
  },
  "dependencies": {
    "@coral-xyz/anchor": "0.32.1",
    "@fastify/cors": "11.2.0",
    "@solana/web3.js": "1.98.4",
    "dotenv": "16.4.5",
    "fastify": "5.9.0"
  },
  "devDependencies": {
    "@types/node": "26.0.1",
    "tsx": "4.22.4",
    "typescript": "6.0.3",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 2: Create `engine/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 3: Create `engine/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Create `engine/.env.example`**

```
PORT=8787
RPC_URL=https://api.devnet.solana.com
WALLET_SECRET_KEY=/absolute/path/to/devnet-id.json
TXLINE_BASE_URL=https://txline-dev.txodds.com
SERVICE_LEVEL_ID=1
DURATION_WEEKS=4
PROOFBET_PROGRAM_ID=By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ
PROOFBET_IDL=../target/idl/proofbet.json
# M0 market identity (set after running create-market):
M0_FIXTURE_ID=
M0_MARKET_ID=1
M0_MARKET_PUBKEY=
WEB_ORIGIN=http://localhost:5173
```

- [ ] **Step 5: Install deps**

Run:
```bash
cd engine && npm install
```
Expected: `node_modules` created, no peer-dep errors that abort install.

- [ ] **Step 6: Write the failing test for the server factory + `/health`**

Create `engine/test/routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../src/server.ts";

describe("health", () => {
  it("GET /health returns ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
```

- [ ] **Step 7: Run the test, verify it fails**

Run: `cd engine && npm test`
Expected: FAIL — cannot import `buildServer` from `../src/server.ts` (file/exports missing).

- [ ] **Step 8: Implement `engine/src/server.ts`**

```ts
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: false });
  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  app.register(cors, { origin: [webOrigin] });
  app.get("/health", async () => ({ status: "ok" }));
  return app;
}

// Start only when run directly (not under test import).
const isMain = process.argv[1]?.endsWith("server.ts");
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8787);
  app.listen({ port, host: "0.0.0.0" }).then((addr) => {
    // eslint-disable-next-line no-console
    console.log(`engine listening at ${addr}`);
  });
}
```

- [ ] **Step 9: Run the test, verify it passes**

Run: `cd engine && npm test`
Expected: PASS (1 test).

- [ ] **Step 10: Commit**

```bash
git add engine/package.json engine/package-lock.json engine/tsconfig.json engine/vitest.config.ts engine/.env.example engine/src/server.ts engine/test/routes.test.ts
git commit -m "feat(engine): scaffold Fastify server with /health"
```

### Task B2: Pool-implied odds math (pure, TDD)

**Files:**
- Create: `engine/src/odds.ts`, `engine/test/odds.test.ts`

- [ ] **Step 1: Write the failing test**

Create `engine/test/odds.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { impliedOdds } from "../src/odds.ts";

describe("impliedOdds", () => {
  it("returns pot/bucket payout multiplier, fee applied", () => {
    // pools: OVER=300, UNDER=100, total=400, fee 0 bps
    // over backer share of pot = 400/300 = 1.3333...
    expect(impliedOdds([300n, 100n], 0, 0)).toBeCloseTo(1.3333, 3);
    expect(impliedOdds([300n, 100n], 1, 0)).toBeCloseTo(4.0, 3);
  });

  it("takes the fee from the LOSING pool only (matches on-chain payout)", () => {
    // 1000 bps (10%): over wins → loser=UNDER(100), fee=10 → (400-10)/300 = 1.30
    expect(impliedOdds([300n, 100n], 0, 1000)).toBeCloseTo(1.3, 3);
    // under wins → loser=OVER(300), fee=30 → (400-30)/100 = 3.70
    expect(impliedOdds([300n, 100n], 1, 1000)).toBeCloseTo(3.7, 3);
  });

  it("returns 0 for an empty bucket (no liquidity on that side)", () => {
    expect(impliedOdds([0n, 100n], 0, 0)).toBe(0);
  });

  it("returns 0 when total pool is empty", () => {
    expect(impliedOdds([0n, 0n], 0, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd engine && npx vitest run test/odds.test.ts`
Expected: FAIL — `impliedOdds` not found.

- [ ] **Step 3: Implement `engine/src/odds.ts`**

```ts
/**
 * Pool-implied odds = the payout multiplier a backer of `bucket` would get if the
 * market settled now and `bucket` won. Mirrors the on-chain payout exactly:
 *   fee_collected = loser_total * feeBps/10000   (fee taken from the LOSING pool only)
 *   payout        = (total_pool - fee_collected) / bucket_total
 * Indicative only — the realized payout is fixed at entry close.
 * Returns 0 when there is no liquidity on the bucket or no pool at all.
 */
export function impliedOdds(
  bucketTotals: [bigint, bigint],
  bucket: 0 | 1,
  feeBps: number,
): number {
  const total = bucketTotals[0] + bucketTotals[1];
  const side = bucketTotals[bucket];
  if (total === 0n || side === 0n) return 0;
  const loser = bucketTotals[bucket === 0 ? 1 : 0];
  const feeCollected = (Number(loser) * feeBps) / 10_000;
  return (Number(total) - feeCollected) / Number(side);
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `cd engine && npx vitest run test/odds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add engine/src/odds.ts engine/test/odds.test.ts
git commit -m "feat(engine): pool-implied odds math"
```

### Task B3: Chain reader — derive PDAs + read the Market account

**Files:**
- Create: `engine/src/config.ts`, `engine/src/chain.ts`

- [ ] **Step 1: Create `engine/src/config.ts`**

```ts
import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  process.env.PROOFBET_PROGRAM_ID ?? "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
);
export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

// M0 market identity (filled in after create-market).
export const M0 = {
  fixtureId: Number(process.env.M0_FIXTURE_ID ?? 0),
  marketId: Number(process.env.M0_MARKET_ID ?? 1),
  marketPubkey: process.env.M0_MARKET_PUBKEY ?? "",
  // Display metadata for the demo card:
  home: process.env.M0_HOME ?? "Brazil",
  away: process.env.M0_AWAY ?? "Spain",
  line: 9.5,
  label: "Total Corners",
};

export const LAMPORTS_PER_SOL = 1_000_000_000;
```

- [ ] **Step 2: Write the failing test for PDA derivation**

Append to `engine/test/routes.test.ts` a new describe, OR create `engine/test/chain.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "../src/chain.ts";

const PROGRAM = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("PDA derivation", () => {
  it("market PDA is deterministic for (fixtureId, marketId)", () => {
    const a = deriveMarketPda(PROGRAM, 17952170, 1);
    const b = deriveMarketPda(PROGRAM, 17952170, 1);
    expect(a.toBase58()).toBe(b.toBase58());
  });
  it("vault and position derive from the market pubkey", () => {
    const market = deriveMarketPda(PROGRAM, 17952170, 1);
    const vault = deriveVaultPda(PROGRAM, market);
    const bettor = new PublicKey("11111111111111111111111111111112");
    const pos = derivePositionPda(PROGRAM, market, bettor);
    expect(vault).toBeInstanceOf(PublicKey);
    expect(pos).toBeInstanceOf(PublicKey);
    expect(vault.toBase58()).not.toBe(pos.toBase58());
  });
});
```

- [ ] **Step 3: Run, verify it fails**

Run: `cd engine && npx vitest run test/chain.test.ts`
Expected: FAIL — `deriveMarketPda` not found.

- [ ] **Step 4: Implement `engine/src/chain.ts`**

```ts
import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { PROGRAM_ID, RPC_URL } from "./config.ts";

/** i64 little-endian as 8 bytes (matches Rust fixture_id.to_le_bytes()). */
function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}

export function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])],
    programId,
  )[0];
}

export function deriveVaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), market.toBuffer()],
    programId,
  )[0];
}

export function derivePositionPda(programId: PublicKey, market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()],
    programId,
  )[0];
}

export interface MarketView {
  pubkey: string;
  status: "open" | "settled" | "voided";
  fixtureId: number;
  marketId: number;
  bucketTotals: [string, string]; // lamports as strings (avoid BigInt JSON issues)
  totalPool: string;
  feeBps: number;
  feeCollected: string;
  winningBucket: number | null;
  entryCloseTs: number;
  settledValue: number | null;
}

function statusString(s: Record<string, unknown>): MarketView["status"] {
  if ("settled" in s) return "settled";
  if ("voided" in s) return "voided";
  return "open";
}

let cachedProgram: anchor.Program | null = null;
function loadProgram(): anchor.Program {
  if (cachedProgram) return cachedProgram;
  const idlPath = process.env.PROOFBET_IDL ?? "../target/idl/proofbet.json";
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const connection = new Connection(RPC_URL, "confirmed");
  // Read-only provider: a dummy wallet is fine, we never sign here.
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t } as anchor.Wallet,
    { commitment: "confirmed" },
  );
  cachedProgram = new anchor.Program(idl as anchor.Idl, provider);
  return cachedProgram;
}

export async function readMarket(marketPubkey: string): Promise<MarketView> {
  const program = loadProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await (program.account as any).market.fetch(new PublicKey(marketPubkey));
  return {
    pubkey: marketPubkey,
    status: statusString(m.status),
    fixtureId: Number(m.fixtureId),
    marketId: Number(m.marketId),
    bucketTotals: [m.bucketTotals[0].toString(), m.bucketTotals[1].toString()],
    totalPool: m.totalPool.toString(),
    feeBps: Number(m.feeBps),
    feeCollected: m.feeCollected.toString(),
    winningBucket: m.winningBucket === null ? null : Number(m.winningBucket),
    entryCloseTs: Number(m.entryCloseTs),
    settledValue: m.settledValue === null ? null : Number(m.settledValue),
  };
}
```

Note: the IDL field name for the program's `proofbet.json` account is `market` (lowercase) via `program.account.market` — Anchor lowercases the account struct name. The `i64le` market seed uses `Buffer.from([marketId])` for the single `u8`.

- [ ] **Step 5: Run, verify it passes**

Run: `cd engine && npx vitest run test/chain.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add engine/src/config.ts engine/src/chain.ts engine/test/chain.test.ts
git commit -m "feat(engine): PDA derivation + read Market account"
```

### Task B4: Replay match feed (corners/phase cursor)

**Files:**
- Create: `engine/src/feed.ts`, `engine/data/replay.json`, `engine/test/feed.test.ts`

- [ ] **Step 1: Create a small synthetic `engine/data/replay.json`**

(The real capture comes in Task B7; this seed file makes the feed testable now.)
```json
{
  "fixtureId": 17952170,
  "home": "Brazil",
  "away": "Spain",
  "frames": [
    { "tMs": 0,     "minute": 0,  "phase": "NS", "scoreH": 0, "scoreA": 0, "corners1": 0, "corners2": 0 },
    { "tMs": 5000,  "minute": 30, "phase": "H1", "scoreH": 1, "scoreA": 0, "corners1": 3, "corners2": 2 },
    { "tMs": 10000, "minute": 60, "phase": "H2", "scoreH": 1, "scoreA": 1, "corners1": 5, "corners2": 4 },
    { "tMs": 15000, "minute": 90, "phase": "F",  "scoreH": 1, "scoreA": 1, "corners1": 6, "corners2": 4 }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `engine/test/feed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { Feed } from "../src/feed.ts";

const replay = {
  fixtureId: 1,
  home: "A",
  away: "B",
  frames: [
    { tMs: 0, minute: 0, phase: "NS", scoreH: 0, scoreA: 0, corners1: 0, corners2: 0 },
    { tMs: 100, minute: 45, phase: "H1", scoreH: 0, scoreA: 0, corners1: 3, corners2: 1 },
    { tMs: 200, minute: 90, phase: "F", scoreH: 1, scoreA: 0, corners1: 6, corners2: 4 },
  ],
};

describe("Feed", () => {
  it("returns the first frame at t=0", () => {
    const f = new Feed(replay, () => 1000);
    f.start(1000);
    expect(f.current().totalCorners).toBe(0);
    expect(f.current().phase).toBe("NS");
  });
  it("advances by elapsed wall-clock against frame tMs", () => {
    let now = 1000;
    const f = new Feed(replay, () => now);
    f.start(1000);
    now = 1000 + 150; // past frame[1] (tMs 100), before frame[2] (tMs 200)
    expect(f.current().totalCorners).toBe(4); // 3 + 1
    expect(f.current().phase).toBe("H1");
  });
  it("clamps to the final frame", () => {
    let now = 1000;
    const f = new Feed(replay, () => now);
    f.start(1000);
    now = 1000 + 9999;
    expect(f.current().totalCorners).toBe(10); // 6 + 4
    expect(f.current().phase).toBe("F");
    expect(f.current().isFinal).toBe(true);
  });
});
```

- [ ] **Step 3: Run, verify it fails**

Run: `cd engine && npx vitest run test/feed.test.ts`
Expected: FAIL — `Feed` not found.

- [ ] **Step 4: Implement `engine/src/feed.ts`**

```ts
export interface Frame {
  tMs: number; minute: number; phase: string;
  scoreH: number; scoreA: number; corners1: number; corners2: number;
}
export interface Replay {
  fixtureId: number; home: string; away: string; frames: Frame[];
}
export interface MatchState {
  fixtureId: number; home: string; away: string;
  minute: number; phase: string; scoreH: number; scoreA: number;
  corners1: number; corners2: number; totalCorners: number; isFinal: boolean;
}

const FINAL_PHASES = new Set(["F", "FET", "FPE"]);

/** Replays a captured corners timeline against wall-clock for a deterministic demo. */
export class Feed {
  private startedAt = 0;
  constructor(private replay: Replay, private now: () => number = () => Date.now()) {}

  start(at = this.now()): void { this.startedAt = at; }

  private frameAt(elapsedMs: number): Frame {
    const { frames } = this.replay;
    let chosen = frames[0];
    for (const fr of frames) { if (fr.tMs <= elapsedMs) chosen = fr; else break; }
    return chosen;
  }

  current(): MatchState {
    const fr = this.frameAt(this.now() - this.startedAt);
    return {
      fixtureId: this.replay.fixtureId, home: this.replay.home, away: this.replay.away,
      minute: fr.minute, phase: fr.phase, scoreH: fr.scoreH, scoreA: fr.scoreA,
      corners1: fr.corners1, corners2: fr.corners2,
      totalCorners: fr.corners1 + fr.corners2, isFinal: FINAL_PHASES.has(fr.phase),
    };
  }
}
```

- [ ] **Step 5: Run, verify it passes**

Run: `cd engine && npx vitest run test/feed.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add engine/src/feed.ts engine/data/replay.json engine/test/feed.test.ts
git commit -m "feat(engine): deterministic replay match feed"
```

### Task B5: Routes `/api/market` and `/api/match`

**Files:**
- Create: `engine/src/routes.ts`
- Modify: `engine/src/server.ts`, `engine/test/routes.test.ts`

- [ ] **Step 1: Write the failing test (extend `routes.test.ts`)**

Replace `engine/test/routes.test.ts` with:
```ts
import { describe, it, expect, vi } from "vitest";
import { buildServer } from "../src/server.ts";

vi.mock("../src/chain.ts", async (orig) => {
  const real = await orig<typeof import("../src/chain.ts")>();
  return {
    ...real,
    readMarket: vi.fn(async () => ({
      pubkey: "Mkt111", status: "open", fixtureId: 1, marketId: 1,
      bucketTotals: ["300", "100"], totalPool: "400", feeBps: 0, feeCollected: "0",
      winningBucket: null, entryCloseTs: 9999999999, settledValue: null,
    })),
  };
});

describe("engine routes", () => {
  it("GET /health", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/health" });
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("GET /api/match returns a match state", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/api/match" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("totalCorners");
    expect(body).toHaveProperty("phase");
    await app.close();
  });

  it("GET /api/market returns market view + implied odds", async () => {
    const app = buildServer();
    const res = await app.inject({ url: "/api/market" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bucketTotals).toEqual(["300", "100"]);
    expect(body.impliedOdds.over).toBeCloseTo(1.3333, 3);
    expect(body.impliedOdds.under).toBeCloseTo(4.0, 3);
    await app.close();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd engine && npx vitest run test/routes.test.ts`
Expected: FAIL — `/api/match` and `/api/market` 404.

- [ ] **Step 3: Implement `engine/src/routes.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { Feed, type Replay } from "./feed.ts";
import { readMarket } from "./chain.ts";
import { impliedOdds } from "./odds.ts";
import { M0 } from "./config.ts";

function loadReplay(): Replay {
  const url = new URL("../data/replay.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Replay;
}

export function registerRoutes(app: FastifyInstance): void {
  const feed = new Feed(loadReplay());
  feed.start(); // demo clock starts when the engine boots

  app.get("/api/match", async () => feed.current());

  app.get("/api/market", async (_req, reply) => {
    if (!M0.marketPubkey) {
      reply.code(503);
      return { error: "M0_MARKET_PUBKEY not set — run create-market first" };
    }
    const m = await readMarket(M0.marketPubkey);
    const totals: [bigint, bigint] = [BigInt(m.bucketTotals[0]), BigInt(m.bucketTotals[1])];
    return {
      ...m,
      meta: { home: M0.home, away: M0.away, line: M0.line, label: M0.label },
      impliedOdds: {
        over: impliedOdds(totals, 0, m.feeBps),
        under: impliedOdds(totals, 1, m.feeBps),
      },
    };
  });
}
```

- [ ] **Step 4: Wire routes into `engine/src/server.ts`**

In `engine/src/server.ts`, add the import and call inside `buildServer` after the `/health` route:
```ts
import { registerRoutes } from "./routes.ts";
// ...inside buildServer, before `return app;`:
  registerRoutes(app);
```

- [ ] **Step 5: Run, verify it passes**

Run: `cd engine && npm test`
Expected: PASS (all engine tests: odds, feed, chain, routes).

- [ ] **Step 6: Commit**

```bash
git add engine/src/routes.ts engine/src/server.ts engine/test/routes.test.ts
git commit -m "feat(engine): /api/match and /api/market routes"
```

### Task B6: `create-market` script (initialize_market on devnet)

**Files:**
- Create: `engine/scripts/create-market.ts`

- [ ] **Step 1: Implement `engine/scripts/create-market.ts`**

```ts
/**
 * One-off: create the M0 market (Total Corners O/U 9.5) on devnet by reusing the
 * spike's SpikeContext (wallet + provider). Prints the market pubkey + the env
 * lines to paste into engine/.env. Usage:
 *   tsx scripts/create-market.ts --fixture <id> --close-mins 5
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createContext } from "../../spike/src/auth.js";
import { deriveMarketPda, deriveVaultPda } from "../src/chain.ts";
import { PROGRAM_ID } from "../src/config.ts";

const BN = anchor.BN;

function flag(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const fixtureId = Number(flag("fixture"));
  const marketId = Number(flag("market", "1"));
  const closeMins = Number(flag("close-mins", "5"));
  if (!fixtureId) throw new Error("--fixture <id> is required");

  const ctx = createContext();
  const idlPath = process.env.PROOFBET_IDL ?? "../target/idl/proofbet.json";
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, ctx.provider);

  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const entryCloseTs = Math.floor(Date.now() / 1000) + closeMins * 60;

  const args = {
    settleAuthority: ctx.wallet.publicKey,
    feeRecipient: null,
    statKey: 7,                       // P1 corners
    statKey2: 8,                      // P2 corners
    op: { add: {} },
    comparison: { greaterThan: {} },
    threshold: 9,                     // Over 9.5  ⇔  (c1+c2) > 9
    entryCloseTs: new BN(entryCloseTs),
    feeBps: 0,
  };

  const sig = await program.methods
    .initializeMarket(new BN(fixtureId), marketId, args)
    .accountsStrict({
      creator: ctx.wallet.publicKey,
      market,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("created market:", market.toBase58(), "tx:", sig);
  console.log("\nPaste into engine/.env:");
  console.log(`M0_FIXTURE_ID=${fixtureId}`);
  console.log(`M0_MARKET_ID=${marketId}`);
  console.log(`M0_MARKET_PUBKEY=${market.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run it against the demo fixture**

Run (pick a finished WC fixture id whose stats TxLINE has anchored on devnet — e.g. the spike's `EXAMPLE_STAT.fixtureId = 17952170`):
```bash
cd engine && cp .env.example .env
# edit .env: set WALLET_SECRET_KEY to your devnet keypair path
npm run create-market -- --fixture 17952170 --market 1 --close-mins 10
```
Expected: prints `created market: <pubkey> tx: <sig>` and the three `M0_*` env lines.

- [ ] **Step 3: Paste the printed `M0_FIXTURE_ID/M0_MARKET_ID/M0_MARKET_PUBKEY` into `engine/.env`**

- [ ] **Step 4: Verify `/api/market` now serves it**

Run:
```bash
cd engine && npm run dev &
sleep 2 && curl -s localhost:8787/api/market | head -c 400 ; echo
```
Expected: JSON with `status: "open"`, `bucketTotals: ["0","0"]`, `impliedOdds`, and the `meta` block. Stop the dev server afterward.

- [ ] **Step 5: Commit**

```bash
git add engine/scripts/create-market.ts
git commit -m "feat(engine): create-market script (initialize_market on devnet)"
```

### Task B7: `capture-replay` script (real corners timeline)

**Files:**
- Create: `engine/scripts/capture-replay.ts`
- Modify: `engine/data/replay.json` (overwritten by the capture)

- [ ] **Step 1: Implement `engine/scripts/capture-replay.ts`**

```ts
/**
 * Capture a fixture's corners progression from TxLINE into engine/data/replay.json
 * so the demo feed replays REAL data deterministically. Usage:
 *   tsx scripts/capture-replay.ts --fixture <id>
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { createContext, authenticate } from "../../spike/src/auth.js";
import { getScoreHistory, resolvePhase } from "../../spike/src/discover.js";
import { SOCCER_STAT } from "../../spike/src/config.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const fixtureId = Number(flag("fixture"));
  if (!fixtureId) throw new Error("--fixture <id> required");
  const ctx = createContext();
  const auth = await authenticate(ctx);
  const events = await getScoreHistory(ctx, auth, fixtureId);

  const sorted = [...events].sort((a, b) => Number(a.Seq) - Number(b.Seq));
  const t0 = Number(sorted[0]?.Ts ?? 0);
  const frames = sorted.map((ev, i) => {
    const c1 = ev.Stats?.[String(SOCCER_STAT.P1_CORNERS)] ?? 0;
    const c2 = ev.Stats?.[String(SOCCER_STAT.P2_CORNERS)] ?? 0;
    const g1 = ev.Stats?.[String(SOCCER_STAT.P1_GOALS)] ?? 0;
    const g2 = ev.Stats?.[String(SOCCER_STAT.P2_GOALS)] ?? 0;
    const realMs = Number(ev.Ts ?? t0) - t0;
    return {
      tMs: i * 4000,                 // compress to ~4s/frame for the demo
      minute: Math.min(90, Math.round(realMs / 60000)),
      phase: resolvePhase(ev).label,
      scoreH: g1, scoreA: g2, corners1: c1, corners2: c2,
    };
  });

  const replay = { fixtureId, home: flag("home") ?? "Home", away: flag("away") ?? "Away", frames };
  const out = new URL("../data/replay.json", import.meta.url);
  writeFileSync(out, JSON.stringify(replay, null, 2));
  console.log(`wrote ${frames.length} frames to engine/data/replay.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the capture for the demo fixture**

Run:
```bash
cd engine && npm run capture-replay -- --fixture 17952170 --home Brazil --away Spain
```
Expected: `wrote N frames to engine/data/replay.json`. If TxLINE returns no corners for that fixture, fall back to the synthetic seed file (the feed still works) and note it.

- [ ] **Step 3: Re-run the feed test to confirm the real file still parses**

Run: `cd engine && npx vitest run test/feed.test.ts`
Expected: PASS (test uses an inline replay, not the file — confirms no regression).

- [ ] **Step 4: Commit**

```bash
git add engine/scripts/capture-replay.ts engine/data/replay.json
git commit -m "feat(engine): capture real corners timeline for demo replay"
```

---

## Phase C — Web (Vite + React PWA)

### Task C1: Scaffold `web/` with Vite + polyfills + PWA

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/.env.example`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/App.css`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "streak-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@coral-xyz/anchor": "0.32.1",
    "@privy-io/react-auth": "3.32.2",
    "@solana/kit": "^3.0.3",
    "@solana/web3.js": "1.98.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "6.0.3",
    "vite": "^6.0.0",
    "vite-plugin-node-polyfills": "0.28.0",
    "vite-plugin-pwa": "1.3.0",
    "vitest": "2.1.8"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, global: true, process: true }, protocolImports: true }),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Streak",
        short_name: "Streak",
        description: "On-chain parimutuel for World Cup soccer",
        theme_color: "#FF6A1A",
        background_color: "#07090d",
        display: "standalone",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
```

- [ ] **Step 4: Create `web/.env.example`**

```
VITE_PRIVY_APP_ID=your-privy-app-id
VITE_RPC_URL=https://api.devnet.solana.com
VITE_ENGINE_URL=http://localhost:8787
```

- [ ] **Step 5: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#FF6A1A" />
    <title>Streak</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Create `web/src/App.css` (Streak palette)**

```css
:root { --orange:#FF6A1A; --bg:#07090d; --green:#3DE08A; --red:#FF5C72; --card:#11151c; --muted:#8a93a3; }
* { box-sizing:border-box; margin:0; }
body { background:var(--bg); color:#fff; font-family:-apple-system,BlinkMacSystemFont,sans-serif; }
.app { max-width:460px; margin:0 auto; padding:16px; min-height:100vh; }
.brand { color:var(--orange); font-weight:800; font-size:28px; letter-spacing:-1px; }
.card { background:var(--card); border-radius:16px; padding:16px; margin-top:16px; }
.row { display:flex; justify-content:space-between; align-items:center; }
.muted { color:var(--muted); font-size:13px; }
.btn { background:var(--orange); color:#000; border:0; border-radius:12px; padding:12px 16px; font-weight:700; width:100%; }
.btn.alt { background:#1c2230; color:#fff; }
.pick { flex:1; padding:14px; border-radius:12px; border:1px solid #232a36; background:#0d1118; color:#fff; }
.pick.sel { border-color:var(--orange); }
.win { color:var(--green); } .lose { color:var(--red); }
input { background:#0d1118; border:1px solid #232a36; color:#fff; border-radius:10px; padding:10px; width:100%; }
```

- [ ] **Step 7: Create a placeholder `web/src/App.tsx`**

```tsx
import "./App.css";
export default function App() {
  return (
    <div className="app">
      <div className="brand">Streak</div>
      <div className="card"><span className="muted">Loading…</span></div>
    </div>
  );
}
```

- [ ] **Step 8: Create `web/src/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
```

- [ ] **Step 9: Add placeholder icons**

Run (any 192/512 PNGs work for now; replace with branded ones later):
```bash
cd web && mkdir -p public
# create solid-orange placeholder icons if you have ImageMagick; otherwise drop two PNGs in public/
( command -v magick && magick -size 192x192 xc:'#FF6A1A' public/pwa-192x192.png && magick -size 512x512 xc:'#FF6A1A' public/pwa-512x512.png ) || echo "Add public/pwa-192x192.png and public/pwa-512x512.png manually"
```

- [ ] **Step 10: Install + verify dev server boots**

Run:
```bash
cd web && npm install && npm run build
```
Expected: `npm install` completes; `vite build` succeeds and emits `dist/` with a service worker (`sw.js`) and `manifest.webmanifest`.

- [ ] **Step 11: Commit**

```bash
git add web/package.json web/package-lock.json web/tsconfig.json web/vite.config.ts web/index.html web/.env.example web/src/main.tsx web/src/App.tsx web/src/App.css web/public
git commit -m "feat(web): scaffold Vite React PWA with polyfills + manifest"
```

### Task C2: Copy the IDL + odds/PDA libs (TDD for pure functions)

**Files:**
- Create: `web/src/idl/proofbet.json` (copy), `web/src/lib/odds.ts`, `web/src/lib/pdas.ts`, `web/test/lib.test.ts`
- Create: `web/vitest.config.ts`

- [ ] **Step 1: Copy the IDL into the web app**

Run:
```bash
cp target/idl/proofbet.json web/src/idl/proofbet.json
```

- [ ] **Step 2: Create `web/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["test/**/*.test.ts"] } });
```

- [ ] **Step 3: Write the failing test**

Create `web/test/lib.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { impliedOdds } from "../src/lib/odds.ts";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "../src/lib/pdas.ts";

const P = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");

describe("web odds", () => {
  it("matches the engine formula", () => {
    expect(impliedOdds([300n, 100n], 0, 0)).toBeCloseTo(1.3333, 3);
  });
});
describe("web pdas", () => {
  it("derives market/vault/position", () => {
    const m = deriveMarketPda(P, 17952170, 1);
    const v = deriveVaultPda(P, m);
    const pos = derivePositionPda(P, m, PublicKey.default);
    expect(m).toBeInstanceOf(PublicKey);
    expect(v.toBase58()).not.toBe(pos.toBase58());
  });
});
```

- [ ] **Step 4: Run, verify it fails**

Run: `cd web && npx vitest run test/lib.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement `web/src/lib/odds.ts`** (identical formula to the engine)

```ts
export function impliedOdds(bucketTotals: [bigint, bigint], bucket: 0 | 1, feeBps: number): number {
  const total = bucketTotals[0] + bucketTotals[1];
  const side = bucketTotals[bucket];
  if (total === 0n || side === 0n) return 0;
  const loser = bucketTotals[bucket === 0 ? 1 : 0]; // fee is taken from the LOSING pool only
  const feeCollected = (Number(loser) * feeBps) / 10_000;
  return (Number(total) - feeCollected) / Number(side);
}
```

- [ ] **Step 6: Implement `web/src/lib/pdas.ts`**

```ts
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}
export function deriveMarketPda(programId: PublicKey, fixtureId: number, marketId: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fixtureId), Buffer.from([marketId])], programId,
  )[0];
}
export function deriveVaultPda(programId: PublicKey, market: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), market.toBuffer()], programId)[0];
}
export function derivePositionPda(programId: PublicKey, market: PublicKey, bettor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), market.toBuffer(), bettor.toBuffer()], programId,
  )[0];
}
```

- [ ] **Step 7: Run, verify it passes**

Run: `cd web && npx vitest run test/lib.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add web/src/idl/proofbet.json web/src/lib/odds.ts web/src/lib/pdas.ts web/test/lib.test.ts web/vitest.config.ts
git commit -m "feat(web): IDL copy + odds/PDA libs with tests"
```

### Task C3: Privy provider + login bar

**Files:**
- Create: `web/src/providers.tsx`, `web/src/components/LoginBar.tsx`
- Modify: `web/src/main.tsx`

- [ ] **Step 1: Create a Privy app + get the app id**

Manual: at https://dashboard.privy.io create an app, enable **Email** + **Google** login and **Solana** wallets, copy the App ID into `web/.env` as `VITE_PRIVY_APP_ID` (copy `.env.example` → `.env` first).

- [ ] **Step 2: Implement `web/src/providers.tsx`**

```tsx
import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";

const RPC = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
const WSS = RPC.replace("https", "wss");

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: { walletChainType: "solana-only", theme: "dark", accentColor: "#FF6A1A" },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        solana: {
          rpcs: {
            "solana:devnet": {
              rpc: createSolanaRpc(RPC),
              rpcSubscriptions: createSolanaRpcSubscriptions(WSS),
            },
          },
        },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
```

- [ ] **Step 3: Implement `web/src/components/LoginBar.tsx`**

```tsx
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";

export function useSolanaAddress(): string | undefined {
  const { wallets } = useWallets();
  return wallets.find((w) => w.standardWallet?.name === "Privy")?.address ?? wallets[0]?.address;
}

export function LoginBar() {
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const address = useSolanaAddress();
  if (!ready) return null;
  return (
    <div className="row">
      <div className="brand">Streak</div>
      {authenticated
        ? <button className="btn alt" style={{ width: "auto" }} onClick={logout}>
            {address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "…"}
          </button>
        : <button className="btn" style={{ width: "auto" }} onClick={login}>Log in</button>}
    </div>
  );
}
```

- [ ] **Step 4: Wrap the app in `web/src/main.tsx`**

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { Providers } from "./providers.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><Providers><App /></Providers></React.StrictMode>,
);
```

- [ ] **Step 5: Manual verification — login works**

Run: `cd web && npm run dev`, open http://localhost:5173.
Expected: "Log in" button → Privy modal → Google/email login → button shows a truncated Solana address. (This is a wallet flow; verify by eye.)

- [ ] **Step 6: Run the unit tests (no regression)**

Run: `cd web && npm test`
Expected: PASS (lib tests still green).

- [ ] **Step 7: Commit**

```bash
git add web/src/providers.tsx web/src/components/LoginBar.tsx web/src/main.tsx
git commit -m "feat(web): Privy provider + login bar (Solana embedded wallet)"
```

### Task C4: Anchor client + Privy signing bridge

**Files:**
- Create: `web/src/hooks/usePrivySigner.ts`, `web/src/lib/anchorClient.ts`

- [ ] **Step 1: Implement `web/src/hooks/usePrivySigner.ts`**

```tsx
import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import type { Transaction } from "@solana/web3.js";

/** Returns a function that takes an unsigned web3.js v1 Transaction, has Privy
 *  sign + broadcast it to the configured devnet RPC, and returns the signature. */
export function usePrivySigner(): {
  address: string | undefined;
  signAndSend: (tx: Transaction) => Promise<string>;
} {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = wallets.find((w) => w.standardWallet?.name === "Privy") ?? wallets[0];

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!wallet) throw new Error("no Solana wallet connected");
    const bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const { signature } = await signAndSendTransaction({ transaction: bytes, wallet });
    return String(signature);
  }
  return { address: wallet?.address, signAndSend };
}
```

- [ ] **Step 2: Implement `web/src/lib/anchorClient.ts`**

```ts
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, SystemProgram, Transaction,
} from "@solana/web3.js";
import idl from "../idl/proofbet.json";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "./pdas.ts";

const RPC = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey((idl as { address: string }).address);
export const connection = new Connection(RPC, "confirmed");

/** Read-only program (no signer) for building instructions. */
function readonlyProgram(payer: PublicKey): anchor.Program {
  const provider = new anchor.AnchorProvider(
    connection,
    { publicKey: payer, signTransaction: async (t) => t, signAllTransactions: async (t) => t } as anchor.Wallet,
    { commitment: "confirmed" },
  );
  return new anchor.Program(idl as anchor.Idl, provider);
}

async function withBlockhash(tx: Transaction, payer: PublicKey): Promise<Transaction> {
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  return tx;
}

/** Build an unsigned place_bet transaction. amountLamports as bigint. */
export async function buildPlaceBetTx(
  payerAddress: string, fixtureId: number, marketId: number, bucket: 0 | 1, amountLamports: bigint,
): Promise<Transaction> {
  const payer = new PublicKey(payerAddress);
  const program = readonlyProgram(payer);
  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const position = derivePositionPda(PROGRAM_ID, market, payer);
  const tx = await program.methods
    .placeBet(bucket, new anchor.BN(amountLamports.toString()))
    .accountsStrict({ bettor: payer, market, vault, position, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, payer);
}

/** Build an unsigned claim transaction. */
export async function buildClaimTx(
  payerAddress: string, fixtureId: number, marketId: number,
): Promise<Transaction> {
  const payer = new PublicKey(payerAddress);
  const program = readonlyProgram(payer);
  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const position = derivePositionPda(PROGRAM_ID, market, payer);
  const tx = await program.methods
    .claim()
    .accountsStrict({ bettor: payer, market, vault, position, systemProgram: SystemProgram.programId })
    .transaction();
  return withBlockhash(tx, payer);
}
```

- [ ] **Step 3: Type-check (no test — these touch the wallet/RPC)**

Run: `cd web && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/hooks/usePrivySigner.ts web/src/lib/anchorClient.ts
git commit -m "feat(web): Anchor tx builders + Privy signing bridge"
```

### Task C5: API client + Market card + Bet form + Claim

**Files:**
- Create: `web/src/lib/api.ts`, `web/src/components/MarketCard.tsx`, `web/src/components/BetForm.tsx`, `web/src/components/ClaimButton.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Implement `web/src/lib/api.ts`**

```ts
const ENGINE = import.meta.env.VITE_ENGINE_URL ?? "http://localhost:8787";

export interface MatchState {
  fixtureId: number; home: string; away: string; minute: number; phase: string;
  scoreH: number; scoreA: number; corners1: number; corners2: number;
  totalCorners: number; isFinal: boolean;
}
export interface MarketState {
  pubkey: string; status: "open" | "settled" | "voided"; fixtureId: number; marketId: number;
  bucketTotals: [string, string]; totalPool: string; feeBps: number; winningBucket: number | null;
  entryCloseTs: number; settledValue: number | null;
  meta: { home: string; away: string; line: number; label: string };
  impliedOdds: { over: number; under: number };
}
export const getMatch = (): Promise<MatchState> => fetch(`${ENGINE}/api/match`).then((r) => r.json());
export const getMarket = (): Promise<MarketState> => fetch(`${ENGINE}/api/market`).then((r) => r.json());
```

- [ ] **Step 2: Implement `web/src/components/BetForm.tsx`**

```tsx
import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx } from "../lib/anchorClient.ts";
import type { MarketState } from "../lib/api.ts";

const LAMPORTS = 1_000_000_000;

export function BetForm({ market, onDone }: { market: MarketState; onDone: () => void }) {
  const { address, signAndSend } = usePrivySigner();
  const [bucket, setBucket] = useState<0 | 1>(0);
  const [sol, setSol] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  async function placeBet() {
    if (!address) { setMsg("log in first"); return; }
    setBusy(true); setMsg(undefined);
    try {
      const lamports = BigInt(Math.round(Number(sol) * LAMPORTS));
      const tx = await buildPlaceBetTx(address, market.fixtureId, market.marketId, bucket, lamports);
      const sig = await signAndSend(tx);
      setMsg(`bet placed: ${sig.slice(0, 8)}…`);
      onDone();
    } catch (e) { setMsg(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const closed = Date.now() / 1000 >= market.entryCloseTs || market.status !== "open";
  return (
    <div className="card">
      <div className="row" style={{ gap: 8 }}>
        <button className={`pick ${bucket === 0 ? "sel" : ""}`} onClick={() => setBucket(0)}>
          Over {market.meta.line}<br /><span className="muted">{market.impliedOdds.over.toFixed(2)}×</span>
        </button>
        <button className={`pick ${bucket === 1 ? "sel" : ""}`} onClick={() => setBucket(1)}>
          Under {market.meta.line}<br /><span className="muted">{market.impliedOdds.under.toFixed(2)}×</span>
        </button>
      </div>
      <div style={{ marginTop: 12 }}>
        <input value={sol} onChange={(e) => setSol(e.target.value)} inputMode="decimal" />
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy || closed} onClick={placeBet}>
        {closed ? "Entry closed" : busy ? "Confirming…" : `Bet ${sol} SOL`}
      </button>
      {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Implement `web/src/components/ClaimButton.tsx`**

```tsx
import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildClaimTx } from "../lib/anchorClient.ts";
import type { MarketState } from "../lib/api.ts";

export function ClaimButton({ market }: { market: MarketState }) {
  const { address, signAndSend } = usePrivySigner();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  if (market.status === "open") return null;

  async function claim() {
    if (!address) return;
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimTx(address, market.fixtureId, market.marketId);
      const sig = await signAndSend(tx);
      setMsg(`claimed: ${sig.slice(0, 8)}…`);
    } catch (e) { setMsg(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="card">
      <div className="row"><b>{market.status === "voided" ? "Refund available" : "Settled"}</b>
        {market.winningBucket !== null && <span className="win">Winner: {market.winningBucket === 0 ? "Over" : "Under"}</span>}
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={claim}>
        {busy ? "Claiming…" : "Claim payout"}
      </button>
      {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Implement `web/src/components/MarketCard.tsx`**

```tsx
import type { MarketState, MatchState } from "../lib/api.ts";

const SOL = 1_000_000_000;
export function MarketCard({ market, match }: { market: MarketState; match: MatchState }) {
  const pot = (Number(market.totalPool) / SOL).toFixed(2);
  return (
    <div className="card">
      <div className="row">
        <b>{market.meta.home} vs {market.meta.away}</b>
        <span className="muted">{match.phase} · {match.minute}'</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">{market.meta.label} O/U {market.meta.line}</span>
        <span className="brand" style={{ fontSize: 20 }}>{match.totalCorners} corners</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">Pool</span><span>{pot} SOL</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement `web/src/App.tsx`**

```tsx
import { useEffect, useState } from "react";
import "./App.css";
import { LoginBar } from "./components/LoginBar.tsx";
import { MarketCard } from "./components/MarketCard.tsx";
import { BetForm } from "./components/BetForm.tsx";
import { ClaimButton } from "./components/ClaimButton.tsx";
import { getMarket, getMatch, type MarketState, type MatchState } from "./lib/api.ts";

export default function App() {
  const [market, setMarket] = useState<MarketState>();
  const [match, setMatch] = useState<MatchState>();

  async function refresh() {
    try { setMarket(await getMarket()); setMatch(await getMatch()); } catch { /* engine warming up */ }
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);

  return (
    <div className="app">
      <LoginBar />
      {market && match ? (
        <>
          <MarketCard market={market} match={match} />
          {market.status === "open"
            ? <BetForm market={market} onDone={refresh} />
            : <ClaimButton market={market} />}
        </>
      ) : <div className="card"><span className="muted">Loading market…</span></div>}
    </div>
  );
}
```

- [ ] **Step 6: Type-check + unit tests**

Run: `cd web && npx tsc --noEmit && npm test`
Expected: no type errors; lib tests PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/api.ts web/src/components/MarketCard.tsx web/src/components/BetForm.tsx web/src/components/ClaimButton.tsx web/src/App.tsx
git commit -m "feat(web): market card + bet form + claim wired to engine + Anchor"
```

---

## Phase D — End-to-end demo + deploy

### Task D1: Local end-to-end dry run

**Files:** none (verification only)

- [ ] **Step 1: Start the engine**

Run: `cd engine && npm run dev` (ensure `.env` has the `M0_*` values from Task B6).
Expected: `engine listening at http://0.0.0.0:8787`; `curl localhost:8787/api/market` returns the open market.

- [ ] **Step 2: Start the web app**

Run (separate shell): `cd web && npm run dev`. Open http://localhost:5173.
Expected: Streak header, the market card with live-ticking corners (replay), Over/Under picks with implied odds.

- [ ] **Step 3: Bet end-to-end**

In the browser: log in with Google (Privy) → fund the embedded wallet with devnet SOL (copy the address, `solana airdrop 1 <address> --url devnet`) → pick Over → Bet 0.1 SOL → approve in the Privy modal.
Expected: "bet placed: <sig>"; pool total + implied odds update on the next refresh. Confirm on-chain: `solana confirm <sig> --url devnet`.

- [ ] **Step 4: Settle with the existing keeper, then claim**

Wait until `entry_close_ts` has passed (the create-market `--close-mins`), then run the keeper:
```bash
cd keeper && npx tsx settle.ts <M0_MARKET_PUBKEY>
```
Expected: prints `action: settle … predicateTrue … winningBucket …` then `settled: <sig>`. Refresh the web app → it now shows "Settled / Winner: Over|Under" with a **Claim payout** button. Click Claim → approve → "claimed: <sig>". Confirm SOL returned to the embedded wallet.

- [ ] **Step 5: Commit a short runbook**

Create `engine/DEMO.md` documenting steps 1–4 (exact commands), then:
```bash
git add engine/DEMO.md
git commit -m "docs: M0 end-to-end demo runbook"
```

### Task D2: Deploy to Railway

**Files:** Create `engine/railway.json` (optional), `web` static deploy config

- [ ] **Step 1: Create the Railway project + Postgres**

Manual: `railway init` (or via dashboard) → new project "streak". (Postgres is not used in M0 — provision it later when the leaderboard lands; skip for the skeleton.)

- [ ] **Step 2: Deploy the `engine` service**

Manual: add a service from the repo, root directory `engine/`, start command `npm run start`, set env vars from `engine/.env` (RPC_URL, WALLET_SECRET_KEY as a Railway secret file or base58, TXLINE_BASE_URL, SERVICE_LEVEL_ID, PROOFBET_IDL=../target/idl/proofbet.json — note the IDL must be present in the deploy; copy it into `engine/` if the monorepo root isn't included, e.g. `engine/idl/proofbet.json` and update `PROOFBET_IDL`). Set `WEB_ORIGIN` to the web service URL.
Expected: engine service healthy; `https://<engine>.railway.app/health` → `{"status":"ok"}`.

- [ ] **Step 3: Deploy the `web` service**

Manual: add a static service, root `web/`, build `npm run build`, output `dist/`. Set `VITE_PRIVY_APP_ID`, `VITE_RPC_URL`, `VITE_ENGINE_URL=https://<engine>.railway.app`. Rebuild.
Expected: the PWA loads at `https://<web>.railway.app`, installable (Lighthouse "Installable" check passes), and the full demo flow works against the deployed engine.

- [ ] **Step 4: Verify the public link works for a fresh user**

Open the deployed web URL in a clean browser profile → log in → confirm the market card + bet flow render.
Expected: works end-to-end. This URL is the judges' "working build" link.

- [ ] **Step 5: Commit any deploy config**

```bash
git add engine/railway.json web/* -A
git commit -m "chore: Railway deploy config for engine + web"
```

---

## Self-review

**Spec coverage (against `2026-06-28-streak-onchain-parimutuel-design.md` §11 Milestone 0):**
- "One fixture, one corners market, full lifecycle on devnet" → Tasks A1, B6, D1. ✅
- "Reused program + keeper" → no program changes; settlement via `keeper/settle.ts` in D1. ✅
- "Vite PWA: Privy login → market card → bet → claim → win indicator" → C1–C5 (win indicator = ClaimButton's "Winner: Over/Under"). ✅
- "Thin Fastify engine: TxLINE auth + feed relayed + reads on-chain pool" → B1–B7 (feed via replay captured through TxLINE; on-chain read in B3/B5). ✅
- "Deterministic replay" → B4/B7. ✅
- "Public Railway URL" → D2. ✅
- M0 lever "polling before SSE" → web polls every 3s (App.tsx); engine serves JSON, no SSE. ✅
- M0 lever "Phantom fallback if Privy slips" → `externalWallets.solana` is configured (C3), so Phantom works without extra code. ✅

**Placeholder scan:** No "TBD"/"handle errors"/"similar to" — every step has concrete code or exact commands. Icons (C1 step 9) explicitly allow any 192/512 PNG, not a placeholder requirement.

**Type consistency:** `impliedOdds(bucketTotals, bucket, feeBps)` identical in engine (`odds.ts`) and web (`lib/odds.ts`); PDA derivers identical signatures in `engine/src/chain.ts` and `web/src/lib/pdas.ts`; `MarketState`/`MatchState` shapes in `web/src/lib/api.ts` match the engine's `/api/market` (MarketView + meta + impliedOdds) and `/api/match` (Feed.current()) outputs; `buildPlaceBetTx`/`buildClaimTx` use `accountsStrict` matching the program's exact account names (`bettor`, `market`, `vault`, `position`, `systemProgram`). Bucket constants OVER=0/UNDER=1 consistent throughout.

**Known follow-ups (M1, out of M0 scope):** market-catalog as a cron, SSE relay (replacing poll), leaderboard/streak store on Railway Postgres, settlement triggered from the engine (vs keeper CLI), Seeker TWA APK. All deferred per spec §11 M1+.

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Note: Tasks A1, B6, B7, C3 (Privy app), D1, D2 require live credentials/network (a funded devnet keypair, a Privy app id, TxLINE access, Railway) — those steps are operator-driven and can't be fully automated by a subagent.
