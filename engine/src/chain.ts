import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { PROGRAM_ID, RPC_URL, ER_RPC } from "./config.ts";
import { marketById, LINE_CLOSE_MARKET_ID } from "./markets.ts";

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
  numBuckets: number;
  bucketTotals: string[]; // length numBuckets; lamports as strings (avoid BigInt JSON issues)
  totalPool: string;
  feeBps: number;
  feeCollected: string;
  winningBucket: number | null;
  entryCloseTs: number;
  settledValue: number; // on-chain i32 (not an Option); only meaningful when status === "settled"
}

function statusString(s: Record<string, unknown>): MarketView["status"] {
  if ("settled" in s) return "settled";
  if ("voided" in s) return "voided";
  return "open";
}

let cachedProgram: anchor.Program | null = null;
function loadProgram(): anchor.Program {
  if (cachedProgram) return cachedProgram;
  const idlPath = process.env.PROOFBET_IDL ?? "../../target/idl/proofbet.json";
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

/** Shared read-only Anchor program (cached). Used by history event parsing. */
export function getProgram(): anchor.Program {
  return loadProgram();
}

// ── Contest reader (single-match parlay) ────────────────────────────────────

/** Jackpot account size: 8 (disc) + bump(u8). */
const JACKPOT_SIZE = 8 + 1;

/**
 * Fallback for the on-chain Contest account size (8 disc + INIT_SPACE). Real
 * Anchor exposes `program.account.contest.size`; this constant keeps real code
 * from ever passing `undefined` to getMinimumBalanceForRentExemption and matches
 * the v2 IDL layout (MAX_LEGS = 6): 8 disc + 8 (contest_id) + 32 (settle_authority)
 * + 32 (fee_recipient) + 48 (fixtures [i64;6]) + 6 (market_ids [u8;6]) + 1 (num_legs)
 * + 8 (entry_price) + 8 (lock_ts) + 8 (settle_after_ts) + 2 (fee_bps) + 1 (status)
 * + 6 (winning_buckets [u8;6]) + 8 (entry_count) + 8 (perfect_count)
 * + 8 (distributable) + 8 (claimed_count) + 8 (claimed_total) + 8 (settled_ts)
 * + 1 (bump) = 217.
 *
 * This grew from the 5-leg v1 layout (207 bytes); the +10 (fixtures +8, market_ids
 * +1, winning_buckets +1) is what makes the dataSize discovery filter exclude the
 * orphaned 5-leg contests — only true 6-leg v2 cards pass.
 */
const CONTEST_SIZE = 217;

function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** 4-byte unsigned little-endian — the Call seq is a u32 (matches live-pda.ts). */
function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * `LiveCursor.open_seq` sentinel for "no call currently open for taps"
 * (live_state.rs: `pub const NONE_SEQ: u32 = u32::MAX`). When the cursor reports
 * this, `readOpenCall` returns null WITHOUT falling back to a base scan — the
 * cursor is authoritative that nothing is open.
 */
const NONE_SEQ = 0xffff_ffff;

/**
 * Cached read-only connection to the MagicBlock Ephemeral Rollup. Delegated
 * Call / LiveCursor / LiveEntry PDAs carry their LIVE mid-match state here; the
 * base copy is frozen at the last commit (see ER_RPC docs). Lazily built so unit
 * tests that never touch a live pool don't open a socket.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cachedEr: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function erConn(): any {
  if (!cachedEr) cachedEr = new Connection(ER_RPC, "confirmed");
  return cachedEr;
}

/**
 * ER-read micro-cache with STALE-SERVE and SINGLE-FLIGHT. The MagicBlock devnet
 * RPC rate-limits under our 2s poll fan-out (multiple tabs × cursor+call+entry
 * reads per poll), and a failed ER read used to silently fall back to the FROZEN
 * base copy — which never shows an open call, so the tap card blanked to
 * "waiting for the next call…" for whole matches (live test-match finding).
 *   - fresh (< TTL): serve from cache, zero RPC.
 *   - concurrent identical reads share ONE in-flight request.
 *   - ER error: serve the last ER value up to ER_STALE_MAX_MS old — a slightly
 *     stale open call is correct for seconds; the frozen base copy is wrong for
 *     the whole match. Older than that → rethrow (caller falls to base).
 */
const ER_CACHE_TTL_MS = 1_500; // one 2s web poll
const ER_STALE_MAX_MS = 12_000; // ≈ one answer window
const erCache = new Map<string, { data: Buffer | null; at: number }>();
const erInflight = new Map<string, Promise<Buffer | null>>();

/** TEST SEAM: reset the ER read cache (unit tests share module state). */
export function __clearErReadCache(): void {
  erCache.clear();
  erInflight.clear();
}

async function erAccountData(pda: PublicKey): Promise<Buffer | null> {
  const key = pda.toBase58();
  const hit = erCache.get(key);
  if (hit && Date.now() - hit.at < ER_CACHE_TTL_MS) return hit.data;

  let flight = erInflight.get(key);
  if (!flight) {
    const started: Promise<Buffer | null> = erConn()
      .getAccountInfo(pda)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((info: any) => {
        const data: Buffer | null = info?.data ?? null;
        erCache.set(key, { data, at: Date.now() });
        return data;
      })
      .finally(() => erInflight.delete(key));
    flight = started;
    erInflight.set(key, started);
  }
  try {
    return await flight;
  } catch (e) {
    const stale = erCache.get(key);
    if (stale && Date.now() - stale.at < ER_STALE_MAX_MS) return stale.data;
    throw e;
  }
}

/**
 * Read a delegated account's raw bytes ER-FIRST (via the cached/stale-serving
 * `erAccountData`), base as fallback. The ER holds the live copy while the pool
 * is delegated; before delegation and after undelegate the account lives on base
 * and the ER returns null (→ base). An ER failure WITH no recent stale value is
 * swallowed (→ base) so a dead rollup never blanks a readable account.
 * `expectSize` guards against a short/again-delegating ER row: only a correctly-
 * sized ER buffer wins; otherwise base. Returns null when NEITHER has it (a
 * genuine base RPC error propagates so the route can 502).
 */
async function readDelegatedInfo(
  pda: PublicKey,
  expectSize: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  baseConn: any,
): Promise<{ data: Buffer } | null> {
  try {
    const data = await erAccountData(pda);
    if (data && data.length === expectSize) return { data };
  } catch {
    // ER unreachable with no stale value → fall through to base.
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseInfo: any = await baseConn.getAccountInfo(pda);
  return baseInfo?.data ? baseInfo : null;
}

export function deriveJackpotPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot")], programId)[0];
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

const CONTEST_STATUS = ["open", "settled", "rolledOver", "voided"] as const;
function contestStatusString(s: Record<string, unknown>): (typeof CONTEST_STATUS)[number] {
  if ("settled" in s) return "settled";
  if ("rolledOver" in s) return "rolledOver";
  if ("voided" in s) return "voided";
  return "open";
}

export interface JackpotView {
  lamports: string;
  rentFloor: string;
  pot: string;
}

/** One parlay leg: the on-chain (fixture, market) pair joined to its catalog metadata. */
export interface LegView {
  marketId: number;
  label: string;                // from markets.ts catalog (or "" if unknown id)
  group: string;                // corners | goals | result | cards (or "" if unknown)
  numBuckets: number;           // catalog bucket count (0 if unknown id)
  fixtureId: number;            // fixtures[i] for this leg
  winningBucket: number | null; // winning_buckets[i] when settled, else null
}

export interface ContestView {
  pubkey: string;
  contestId: number;
  settleAuthority: string;
  feeRecipient: string;
  fixtures: number[];           // length numLegs
  marketIds: number[];          // length numLegs
  numLegs: number;
  legs: LegView[];              // length numLegs; per-leg catalog join + winning bucket
  entryPrice: string;
  lockTs: number;
  legLockTs: number[];          // per-leg entry locks (unix sec), tail zeros trimmed to numLegs
  entriesCloseTs: number;       // no entries after this
  settleAfterTs: number;
  feeBps: number;
  status: "open" | "settled" | "rolledOver" | "voided";
  winningBuckets: number[];     // length numLegs
  entryCount: number;
  perfectCount: number;
  perfectWeight: string;        // u64 as string (settled contests) — Σ 2^(active legs)
  pot: string;                  // this contest's own escrow (balance − Contest rent floor)
  distributable: string;
  claimedCount: number;
  claimedTotal: string;
  settledTs: number;
}

export interface EntryView {
  pubkey: string;
  contestId: number;            // which contest this entry belongs to
  nonce: number;
  picks: number[];              // raw [u8; MAX_LEGS]
  amount: string;
  won: boolean;                 // all carded picks match the winning buckets (settled contests only)
  claimable: boolean;          // a claim_contest now would transfer lamports (winner share or void refund)
  payout: string;              // lamports paid if claimed now ("0" if none) — mirrors claim_contest.rs
}

/** An Entry account as-decoded, contest-scoped only (no wallet filter, no settled-state scoring). */
export interface RawEntryView {
  pubkey: string;
  bettor: string;
  nonce: number;
  picks: number[];   // raw [u8; MAX_LEGS]
  amount: string;
  entryTs: number;   // unix seconds of the LAST picks write (init or edit)
}

/** The settled-state fields entryOutcome needs (a subset of ContestView). */
type ContestOutcomeCtx = Pick<
  ContestView,
  "status" | "numLegs" | "winningBuckets" | "perfectCount" | "distributable" | "claimedCount" | "claimedTotal"
>;

/**
 * Pure mirror of `claim_contest.rs`: given a ticket's picks + stake and the
 * contest's settled state, decide whether the ticket won, whether claiming NOW
 * actually pays out, and the exact lamport payout. Kept free of I/O so it can be
 * unit-tested directly against the on-chain handler's math.
 *
 *   - Voided   → every ticket refunds its own stake (claim_contest.rs:46-49).
 *   - Settled  → perfect ticket (all carded picks == winning buckets) earns
 *                floor(distributable / perfect_count), bounded by the on-chain
 *                solvency caps (claimed_count < perfect_count AND
 *                claimed_total + share <= distributable). Non-perfect pays 0.
 *   - Open / RolledOver → nothing payable (close-only on-chain).
 */
export function entryOutcome(
  picks: number[],
  amount: bigint,
  c: ContestOutcomeCtx,
): { won: boolean; claimable: boolean; payout: bigint } {
  if (c.status === "voided") {
    return { won: false, claimable: amount > 0n, payout: amount };
  }
  if (c.status !== "settled") {
    return { won: false, claimable: false, payout: 0n };
  }
  // Perfect = all carded picks equal the winning buckets. Tail picks beyond
  // numLegs are ignored, matching the on-chain loop `for i in 0..num_legs`.
  for (let i = 0; i < c.numLegs; i++) {
    if (picks[i] !== c.winningBuckets[i]) return { won: false, claimable: false, payout: 0n };
  }
  // Perfect ticket. perfect_count is >0 in a settled contest (==0 ⇒ RolledOver),
  // but guard defensively to mirror the on-chain PerfectCountZero check.
  if (c.perfectCount <= 0) return { won: true, claimable: false, payout: 0n };
  const distributable = BigInt(c.distributable);
  const share = distributable / BigInt(c.perfectCount); // floor div; dust stays in the vault
  const capOk =
    c.claimedCount < c.perfectCount &&
    BigInt(c.claimedTotal) + share <= distributable;
  const claimable = capOk && share > 0n;
  // payout = what a claim NOW would actually transfer. On-chain the solvency caps
  // revert a blocked claim (no lamports move), so a won-but-unclaimable ticket
  // (e.g. perfect_count under-reported, pool exhausted) reports 0 — not its share.
  return { won: true, claimable, payout: claimable ? share : 0n };
}

/**
 * Jackpot pot accounting. The Jackpot PDA (`[b"jackpot"]`) holds its own escrow;
 * pot = balance − rent floor (clamped at 0). Pre-launch the account is absent,
 * so we return a pot "0" sentinel rather than throwing — but a genuine RPC error
 * still propagates so the route can 502.
 */
export async function readJackpot(): Promise<JackpotView> {
  const program = loadProgram();
  const pda = deriveJackpotPda(program.programId);
  // fetchNullable → null when the account is absent (pre-launch), but still
  // throws on a genuine RPC error — so the route 502s only on real failures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct: any = await (program.account as any).jackpot.fetchNullable(pda);
  if (!acct) return { lamports: "0", rentFloor: "0", pot: "0" }; // pre-launch sentinel
  const conn = program.provider.connection;
  const lamports = BigInt(await conn.getBalance(pda));
  const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(JACKPOT_SIZE));
  const pot = lamports > rentFloor ? lamports - rentFloor : 0n;
  return { lamports: lamports.toString(), rentFloor: rentFloor.toString(), pot: pot.toString() };
}

/** Read a contest's own escrow: pot = balance(contestPda) − Contest rent floor (clamped at 0). */
async function readContestPot(program: anchor.Program, contestPda: PublicKey): Promise<bigint> {
  const conn = program.provider.connection;
  const lamports = BigInt(await conn.getBalance(contestPda));
  // Real Anchor exposes `.size`; the fallback const keeps real code from ever
  // passing `undefined` (the test mock ignores the argument anyway).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size = (program.account as any).contest.size ?? CONTEST_SIZE;
  const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(size));
  return lamports > rentFloor ? lamports - rentFloor : 0n;
}

/**
 * Map a fetched/decoded Contest account → ContestView. Shared by readLiveContests
 * and the entries path so both surface identical per-leg legs + pot accounting.
 * `legs` joins each on-chain (fixture, market) pair to the markets.ts catalog for
 * label/group/numBuckets; winningBucket = winning_buckets[i] when settled else null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toContestView(pubkey: PublicKey, c: any, pot: bigint): ContestView {
  const numLegs = Number(c.numLegs);
  const fixtures = (c.fixtures as { toNumber(): number }[]).slice(0, numLegs).map((f) => f.toNumber());
  const marketIds = (c.marketIds as number[]).slice(0, numLegs).map(Number);
  const winningBuckets = (c.winningBuckets as number[]).slice(0, numLegs).map(Number);
  const status = contestStatusString(c.status);
  const settled = status === "settled";
  const legs: LegView[] = marketIds.map((marketId, i) => {
    const def = marketById(marketId);
    return {
      marketId,
      label: def?.label ?? "",
      group: def?.group ?? "",
      numBuckets: def?.numBuckets ?? 0,
      fixtureId: fixtures[i],
      winningBucket: settled ? winningBuckets[i] : null,
    };
  });
  return {
    pubkey: pubkey.toBase58(),
    contestId: Number(c.contestId),
    settleAuthority: c.settleAuthority.toBase58(),
    feeRecipient: c.feeRecipient.toBase58(),
    fixtures,
    marketIds,
    numLegs,
    legs,
    entryPrice: c.entryPrice.toString(),
    lockTs: Number(c.lockTs),
    legLockTs: (c.legLockTs as { toNumber(): number }[]).slice(0, numLegs).map((b) => b.toNumber()),
    entriesCloseTs: Number(c.entriesCloseTs),
    settleAfterTs: Number(c.settleAfterTs),
    feeBps: Number(c.feeBps),
    status,
    winningBuckets,
    entryCount: Number(c.entryCount),
    perfectCount: Number(c.perfectCount),
    perfectWeight: String(c.perfectWeight),
    pot: pot.toString(),
    distributable: c.distributable.toString(),
    claimedCount: Number(c.claimedCount),
    claimedTotal: c.claimedTotal.toString(),
    settledTs: Number(c.settledTs),
  };
}

/**
 * Discover every live contest with per-account decode tolerance.
 *
 * We deliberately do NOT use `program.account.contest.all()`: it fetches then
 * decodes every account internally and rejects the ENTIRE call if any single one
 * fails to decode. A stale v1 contest shares the 8-byte "Contest" discriminator
 * but has a different byte layout, so `.all()` would throw and hide every good v2
 * contest. Instead we fetch raw accounts via getProgramAccounts (filtered by the
 * v2 Contest discriminator at offset 0) and decode each one in its own try/catch,
 * skipping undecodable (stale v1) accounts. A total RPC failure → [] (no live
 * contests) rather than a throw.
 */
export async function readLiveContests(): Promise<ContestView[]> {
  const program = loadProgram();
  const conn = program.provider.connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = (program as any).coder.accounts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contestSize: number = (program.account as any).contest.size ?? CONTEST_SIZE;

  let raw: { pubkey: PublicKey; account: { data: Buffer } }[];
  try {
    // Resolve the v2 Contest discriminator filter (lowercase IDL name) INSIDE the
    // try: an IDL-rename miss makes coder.memcmp throw synchronously, so keeping it
    // here degrades to [] (graceful) rather than bubbling out of readLiveContests.
    const disc = coder.memcmp("contest"); // { offset: 0, bytes: <base58> }
    // Filter by the discriminator AND the exact v2 account size. Orphaned older
    // contests share the "Contest" discriminator but are a different size (the prior
    // 5-leg layout is 207 bytes vs the current 6-leg 217) and — critically — their
    // bytes borsh-DECODE into the current struct as GARBAGE rather than throwing, so a
    // try/catch around decode does NOT skip them (an orphaned contest would otherwise
    // surface as a junk card). The dataSize filter excludes any wrong-sized account at
    // the RPC level, so ONLY current 6-leg cards pass.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (await (conn as any).getProgramAccounts(program.programId, {
      filters: [{ memcmp: { offset: disc.offset, bytes: disc.bytes } }, { dataSize: contestSize }],
    })) as { pubkey: PublicKey; account: { data: Buffer } }[];
  } catch {
    return []; // total RPC failure / discriminator miss → no live contests (route degrades gracefully)
  }

  const out: ContestView[] = [];
  for (const item of raw) {
    if (item.account.data.length !== contestSize) continue; // defensive: skip wrong-size (stale v1) accounts even if the RPC ignored the dataSize filter
    let decoded: unknown;
    try {
      decoded = coder.decode("contest", item.account.data); // throws on stale v1 layout
    } catch {
      continue; // skip undecodable account, keep the rest
    }
    const pot = await readContestPot(program, item.pubkey);
    out.push(toContestView(item.pubkey, decoded, pot));
  }
  return out;
}

// ── Live-match readers (Slice 4) ────────────────────────────────────────────

/**
 * Discover every LivePool with per-account decode tolerance — the live-match
 * mirror of readLiveContests. We deliberately do NOT use
 * `program.account.livePool.all()`: it decodes every account internally and
 * rejects the ENTIRE call if any single one fails to decode. Instead we scan raw
 * accounts via getProgramAccounts (filtered by the LivePool discriminator at
 * offset 0 AND the exact account size) and decode each in its own try/catch.
 *
 * Size is read at RUNTIME (`program.account.livePool.size`) — never hardcoded.
 * LivePool is NEVER delegated (it escrows the pot on the base layer), so a
 * single owner-scoped scan under our program id always finds every pool — the
 * delegated-owner caveat below does not apply here.
 * A total RPC failure (or an IDL-name miss that makes coder.memcmp throw) → []
 * so the route degrades gracefully rather than throwing.
 */
export async function readLivePools(): Promise<unknown[]> {
  const program = loadProgram();
  const conn = program.provider.connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = (program as any).coder.accounts;
  // Runtime size (8 disc + INIT_SPACE); LivePool is base-layer, size 176.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size: number = (program.account as any).livePool.size;

  let raw: { pubkey: PublicKey; account: { data: Buffer } }[];
  try {
    // camelCase account name — PascalCase ('LivePool') would throw. Resolved
    // INSIDE the try so an IDL-name miss degrades to [] rather than bubbling out.
    const disc = coder.memcmp("livePool"); // { offset: 0, bytes: <base58> }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (await (conn as any).getProgramAccounts(program.programId, {
      filters: [{ memcmp: { offset: disc.offset, bytes: disc.bytes } }, { dataSize: size }],
    })) as { pubkey: PublicKey; account: { data: Buffer } }[];
  } catch {
    return []; // total RPC failure / discriminator miss → no live pools
  }

  const out: unknown[] = [];
  for (const item of raw) {
    if (item.account.data.length !== size) continue; // defensive: skip wrong-size accounts
    let decoded: unknown;
    try {
      decoded = coder.decode("livePool", item.account.data);
    } catch {
      continue; // skip undecodable account, keep the rest
    }
    out.push({ pubkey: item.pubkey, account: decoded });
  }
  return out;
}

/**
 * The MagicBlock Delegation Program. While a pool is live its Call / LiveCursor /
 * LiveEntry PDAs are delegated to the Ephemeral Rollup: their base-layer `.owner`
 * flips to THIS program (data stays fully readable — runtime probe, Fork A).
 * `getProgramAccounts` scans by OWNER, so an our-program-only scan goes blind for
 * exactly the duration of the match — the game's centerpiece. Delegation-aware
 * readers scan BOTH owners and merge.
 */
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/**
 * getProgramAccounts under BOTH possible owners (our program + the Delegation
 * Program) with identical filters, merged and de-duplicated by pubkey. Used for
 * every delegated-account scan (Call, LiveEntry); LivePool never needs it.
 * Throws on RPC failure — each caller decides whether to []-degrade or 502.
 */
async function scanBothOwners(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any,
  programId: PublicKey,
  filters: unknown[],
): Promise<{ pubkey: PublicKey; account: { data: Buffer } }[]> {
  const byKey = new Map<string, { pubkey: PublicKey; account: { data: Buffer } }>();
  for (const owner of [programId, DELEGATION_PROGRAM]) {
    const raw = (await conn.getProgramAccounts(owner, { filters })) as {
      pubkey: PublicKey;
      account: { data: Buffer };
    }[];
    for (const item of raw) byKey.set(item.pubkey.toBase58(), item);
  }
  return [...byKey.values()];
}

/**
 * Scan Call accounts (size-filtered), optionally scoped to a single pool. Adds a
 * `{offset:8, bytes:pool}` memcmp when `pool` is given (Call.pool at offset 8,
 * verified against live_state.rs). camelCase 'call' account name; runtime size
 * (`program.account.call.size`, 62).
 *
 * DELEGATION-AWARE (stress-test F5): during a live match every Call's base-layer
 * owner is the Delegation Program, so this scans BOTH owners and merges —
 * otherwise the open call vanishes from the API mid-match. Same per-account
 * decode tolerance and graceful-[] on total RPC/IDL failure as readLivePools.
 */
export async function readCall(pool?: string): Promise<unknown[]> {
  const program = loadProgram();
  const conn = program.provider.connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = (program as any).coder.accounts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size: number = (program.account as any).call.size;

  let raw: { pubkey: PublicKey; account: { data: Buffer } }[];
  try {
    const disc = coder.memcmp("call"); // { offset: 0, bytes: <base58> }
    const filters: { memcmp?: { offset: number; bytes: string }; dataSize?: number }[] = [
      { memcmp: { offset: disc.offset, bytes: disc.bytes } },
      { dataSize: size },
    ];
    // Scope to one pool: Call.pool is at offset 8.
    if (pool !== undefined) filters.push({ memcmp: { offset: 8, bytes: pool } });
    raw = await scanBothOwners(conn, program.programId, filters);
  } catch {
    return []; // total RPC failure / discriminator miss → no calls
  }

  const out: unknown[] = [];
  for (const item of raw) {
    if (item.account.data.length !== size) continue; // defensive: skip wrong-size accounts
    let decoded: unknown;
    try {
      decoded = coder.decode("call", item.account.data);
    } catch {
      continue; // skip undecodable account, keep the rest
    }
    out.push({ pubkey: item.pubkey, account: decoded });
  }
  return out;
}

// ── Live-match PDA derivers ──────────────────────────────────────────────────

/** livepool PDA: [b"livepool", u64le(pool_id)]. */
export function deriveLivePoolPda(programId: PublicKey, poolId: number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("livepool"), u64le(poolId)], programId)[0];
}
/** livecursor PDA: [b"livecursor", pool.key]. */
export function deriveLiveCursorPda(programId: PublicKey, pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("livecursor"), pool.toBuffer()], programId)[0];
}
/** call PDA: [b"call", pool.key, u32le(seq)] — seq is a u32 (4 bytes). */
export function deriveCallPda(programId: PublicKey, pool: PublicKey, seq: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("call"), pool.toBuffer(), u32le(seq)], programId,
  )[0];
}
/** liveentry PDA: [b"liveentry", pool.key, player.key]. */
export function deriveLiveEntryPda(programId: PublicKey, pool: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liveentry"), pool.toBuffer(), player.toBuffer()], programId,
  )[0];
}

// ── Live-match View mappers (Slice 4 S4-T2) ──────────────────────────────────

/** PoolStatus{Open0,Live1,Ended2,Settled3,RolledOver4,Voided5} → label via the variant idiom. */
const POOL_STATUS = ["open", "live", "ended", "settled", "rolledOver", "voided"] as const;
function poolStatusString(s: Record<string, unknown>): (typeof POOL_STATUS)[number] {
  for (const k of POOL_STATUS) if (k in s) return k;
  return "open";
}

/** CallKind{NextGoal0,GoalRush1,CornerSoon2,CardSoon3} → label via the variant idiom. */
const CALL_KIND = ["nextGoal", "goalRush", "cornerSoon", "cardSoon"] as const;
function callKindString(s: Record<string, unknown>): (typeof CALL_KIND)[number] {
  for (const k of CALL_KIND) if (k in s) return k;
  return "nextGoal";
}

/** CallState{Empty0,Open1,Resolved2,Voided3} → label via the variant idiom. */
const CALL_STATE = ["empty", "open", "resolved", "voided"] as const;
function callStateString(s: Record<string, unknown>): (typeof CALL_STATE)[number] {
  for (const k of CALL_STATE) if (k in s) return k;
  return "empty";
}

const NO_PICK = 0xff;
const VOID_OUTCOME = 0xfe;
const OUTCOME_UNSET = 0xff;

export interface LivePoolView {
  pubkey: string;
  poolId: number;
  fixtureId: number;
  settleAuthority: string;
  feeRecipient: string;
  entryPrice: string;
  lockTs: number;
  settleAfterTs: number;
  feeBps: number;
  status: (typeof POOL_STATUS)[number];
  numCalls: number;
  playerCount: number;
  winningScore: number;
  winnerCount: number;
  distributable: string;
  claimedCount: number;
  claimedTotal: string;
  settledTs: number;
}

export interface CallView {
  pubkey: string;
  pool: string;
  seq: number;
  kind: (typeof CALL_KIND)[number];
  state: (typeof CALL_STATE)[number];
  openedTs: number;
  answerSecs: number;
  numOptions: number;
  basePoints: number[];
  /** 0xFF (unset) → null, 0xFE (void) → "void", else the winning option index. */
  outcome: number | "void" | null;
}

export interface LiveEntryView {
  pubkey: string;
  player: string;
  pool: string;
  amount: string;
  basePts: number;
  bonusPts: number;
  /** No stored total on-chain: base_pts + bonus_pts. */
  total: number;
  streak: number;
  nextScoreSeq: number;
  /** [u8;64]; 0xFF (NO_PICK) → null. */
  picks: (number | null)[];
}

export interface LiveCursorView {
  pubkey: string;
  pool: string;
  nextSeq: number;
  openSeq: number;
  resolvedCount: number;
}

/** Map a decoded LivePool → LivePoolView. Lamport BNs → strings; enums via variant idiom. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toLivePoolView(pubkey: PublicKey, p: any): LivePoolView {
  return {
    pubkey: pubkey.toBase58(),
    poolId: Number(p.poolId),
    fixtureId: Number(p.fixtureId),
    settleAuthority: p.settleAuthority.toBase58(),
    feeRecipient: p.feeRecipient.toBase58(),
    entryPrice: p.entryPrice.toString(),
    lockTs: Number(p.lockTs),
    settleAfterTs: Number(p.settleAfterTs),
    feeBps: Number(p.feeBps),
    status: poolStatusString(p.status),
    numCalls: Number(p.numCalls),
    playerCount: Number(p.playerCount),
    winningScore: Number(p.winningScore),
    winnerCount: Number(p.winnerCount),
    distributable: p.distributable.toString(),
    claimedCount: Number(p.claimedCount),
    claimedTotal: p.claimedTotal.toString(),
    settledTs: Number(p.settledTs),
  };
}

/** Map a decoded Call → CallView. outcome sentinels resolved (0xFF→null, 0xFE→"void"). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toCallView(pubkey: PublicKey, c: any): CallView {
  const outcomeRaw = Number(c.outcome);
  const outcome: number | "void" | null =
    outcomeRaw === OUTCOME_UNSET ? null : outcomeRaw === VOID_OUTCOME ? "void" : outcomeRaw;
  return {
    pubkey: pubkey.toBase58(),
    pool: c.pool.toBase58(),
    seq: Number(c.seq),
    kind: callKindString(c.kind),
    state: callStateString(c.state),
    openedTs: Number(c.openedTs),
    answerSecs: Number(c.answerSecs),
    numOptions: Number(c.numOptions),
    basePoints: (c.basePoints as number[]).map(Number),
    outcome,
  };
}

/** Map a decoded LiveEntry → LiveEntryView. amount→string; total=base+bonus; picks 0xFF→null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toLiveEntryView(pubkey: PublicKey, e: any): LiveEntryView {
  const basePts = Number(e.basePts);
  const bonusPts = Number(e.bonusPts);
  return {
    pubkey: pubkey.toBase58(),
    player: e.player.toBase58(),
    pool: e.pool.toBase58(),
    amount: e.amount.toString(),
    basePts,
    bonusPts,
    total: basePts + bonusPts,
    streak: Number(e.streak),
    nextScoreSeq: Number(e.nextScoreSeq),
    picks: (e.picks as number[]).map((v) => (Number(v) === NO_PICK ? null : Number(v))),
  };
}

/** Map a decoded LiveCursor → LiveCursorView. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toLiveCursorView(pubkey: PublicKey, c: any): LiveCursorView {
  return {
    pubkey: pubkey.toBase58(),
    pool: c.pool.toBase58(),
    nextSeq: Number(c.nextSeq),
    openSeq: Number(c.openSeq),
    resolvedCount: Number(c.resolvedCount),
  };
}

// ── Live-match scoped reads (Slice 4 S4-T2) ──────────────────────────────────

/**
 * Fetch a pool's LiveCursor (size 53) OWNER-AGNOSTICALLY: derive the livecursor
 * PDA, `getAccountInfo` it directly, and decode the raw bytes. While the pool is
 * live the cursor's base-layer owner is the Delegation Program — an owner-checked
 * fetch path would blank the cursor for the whole match (stress-test F5); a
 * direct read + decode works in every phase. Returns null on any miss/RPC/decode
 * error (reads degrade gracefully — never throw). camelCase `liveCursor` key.
 */
export async function readLiveCursor(pool: string): Promise<LiveCursorView | null> {
  const program = loadProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size: number = (program.account as any).liveCursor.size;
  try {
    const cursorPda = deriveLiveCursorPda(program.programId, new PublicKey(pool));
    // ER-FIRST: mid-match the cursor's live open_seq lives on the rollup; the base
    // copy is frozen at the last commit. Pre-lock / post-undelegate it reads base.
    const info = await readDelegatedInfo(cursorPda, size, program.provider.connection);
    if (!info?.data) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (program as any).coder.accounts.decode("liveCursor", info.data);
    return toLiveCursorView(cursorPda, c);
  } catch {
    return null;
  }
}

/**
 * Read one wallet's LiveEntry for a given pool (at most one per player per pool).
 * The entry PDA is FULLY derivable from (pool, player) — [b"liveentry", pool,
 * player] — so this reads it directly via `getAccountInfo` + decode: one RPC
 * call, and OWNER-AGNOSTIC (a delegated entry — owner flipped to the Delegation
 * Program mid-match — still reads; an owner-scoped `.all()` scan returned null
 * for a playing, scoring seat — stress-test F5). Returns null on miss/decode
 * failure. camelCase `liveEntry` key.
 */
export async function readLiveEntry(wallet: string, poolId: number | bigint): Promise<LiveEntryView | null> {
  const program = loadProgram();
  const player = new PublicKey(wallet);
  const pool = deriveLivePoolPda(program.programId, poolId);
  const entryPda = deriveLiveEntryPda(program.programId, pool, player);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size: number = (program.account as any).liveEntry.size;
  // ER-FIRST: a joined seat's LIVE points (base_pts/bonus_pts ticking up as the
  // keeper scores each call) are on the rollup; base is frozen. An ER hiccup
  // falls to base, but a BASE RPC failure PROPAGATES (the route 502s) — swallowing
  // it would tell a joined, playing seat "no ticket". Missing/garbage → null.
  const info = await readDelegatedInfo(entryPda, size, program.provider.connection);
  if (!info?.data) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = (program as any).coder.accounts.decode("liveEntry", info.data);
    return toLiveEntryView(entryPda, e);
  } catch {
    return null; // wrong-layout / foreign account at the PDA → no entry
  }
}

/**
 * Read every LivePool (decoded + mapped), scoped to a single fixture. Reuses
 * `readLivePools` (size-filtered scan, per-account decode tolerance) then maps
 * each survivor through `toLivePoolView` and filters to `fixtureId`.
 *
 * Streak runs one pool per fixture, but the chain may briefly hold more than one
 * (e.g. a rolled-over pool alongside a fresh one). We pick the highest poolId so
 * a rerun's newer pool wins — deterministic, and poolId == fixtureId in practice.
 * Returns null when no pool exists for the fixture (route serves `{ pool: null }`).
 */
export async function readLivePoolByFixture(fixtureId: number): Promise<LivePoolView | null> {
  const views = (await readLivePoolViews()).filter((v) => v.fixtureId === fixtureId);
  if (views.length === 0) return null;
  // Highest poolId wins (newest pool for a reused fixture); deterministic tie-break.
  return views.sort((a, b) => b.poolId - a.poolId)[0];
}

/**
 * Every LivePool as a mapped view (the raw `readLivePools` scan → `toLivePoolView`).
 * The /api/live/next picker works over this whole set; scoped readers filter it.
 */
export async function readLivePoolViews(): Promise<LivePoolView[]> {
  const raw = await readLivePools();
  return (raw as { pubkey: PublicKey; account: unknown }[]).map((r) =>
    toLivePoolView(r.pubkey, r.account),
  );
}

/**
 * The currently-open Call for a pool (state === "open"), or null.
 *
 * ER-FIRST via the cursor (the fix that makes the live game playable): a call is
 * opened → tapped → resolved entirely on the rollup, and the keeper only commits
 * to base AFTER it resolves — so an OPEN call never appears on base and the old
 * base scan returned null for the whole answer window. We instead read the cursor
 * (ER-first) for the authoritative `open_seq`, derive that one Call PDA, and read
 * it ER-first. NONE_SEQ means nothing is open (return null, no scan). When the
 * cursor can't be read at all (ER + base both blank — e.g. pre-lock), we fall
 * back to the dual-owner base scan so a committed open call is still found.
 */
export async function readOpenCall(pool: string): Promise<CallView | null> {
  const program = loadProgram();
  const cursor = await readLiveCursor(pool);
  if (cursor) {
    if (cursor.openSeq === NONE_SEQ) return null; // authoritative: nothing open
    const callPda = deriveCallPda(program.programId, new PublicKey(pool), cursor.openSeq);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const size: number = (program.account as any).call.size;
    try {
      const info = await readDelegatedInfo(callPda, size, program.provider.connection);
      if (info?.data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c = (program as any).coder.accounts.decode("call", info.data);
        const view = toCallView(callPda, c);
        if (view.state === "open") return view;
      }
    } catch {
      // decode / read hiccup on the derived call — the cursor said a call is open
      // but we couldn't read it this tick. Return null (not a base scan: base never
      // holds the open call during live play); the next 2s poll retries.
    }
    return null;
  }
  // Cursor unavailable (ER + base both blank — e.g. pre-lock) → dual-owner base scan.
  const raw = await readCall(pool);
  const open = (raw as { pubkey: PublicKey; account: unknown }[])
    .map((r) => toCallView(r.pubkey, r.account))
    .find((c) => c.state === "open");
  return open ?? null;
}

/**
 * The most-recently-resolved (or voided) Call for a pool, or null. Calls resolve
 * strictly in seq order and the cursor's `resolved_count` counts them, so the last
 * one is at seq `resolved_count - 1`. The web uses this to flash a just-tapped
 * call's verdict ("✓ correct" / "✕ missed" / "void") in the gap between calls —
 * `readOpenCall` only ever returns the OPEN call, so without this the per-call
 * result is never shown. Read ER-first (base fallback), same as the open call.
 * Returns null when nothing has resolved yet, or on any read/decode hiccup.
 */
export async function readLastResolvedCall(pool: string): Promise<CallView | null> {
  const program = loadProgram();
  const cursor = await readLiveCursor(pool);
  if (!cursor || cursor.resolvedCount <= 0) return null;
  const seq = cursor.resolvedCount - 1;
  const callPda = deriveCallPda(program.programId, new PublicKey(pool), seq);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size: number = (program.account as any).call.size;
  try {
    const info = await readDelegatedInfo(callPda, size, program.provider.connection);
    if (!info?.data) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (program as any).coder.accounts.decode("call", info.data);
    const view = toCallView(callPda, c);
    return view.state === "resolved" || view.state === "voided" ? view : null;
  } catch {
    return null; // read/decode hiccup → no last-call this tick
  }
}

/**
 * Every LiveEntry for a pool, mapped + sorted by `total` (base_pts + bonus_pts)
 * descending — the standings leaderboard.
 *
 * DELEGATION-AWARE (stress-test F5): mid-match every entry's base-layer owner is
 * the Delegation Program, so an owner-scoped `.all()` returned [] EXACTLY while
 * players were live and scoring — blanking the leaderboard, the game's
 * centerpiece. This scans BOTH owners (disc + runtime size + pool@40, verified
 * against live_state.rs), merges, and decodes each survivor tolerantly. Returns
 * [] on no entries; a total RPC failure propagates so the route can 502.
 */
export async function readPoolStandings(poolId: number | bigint): Promise<LiveEntryView[]> {
  const program = loadProgram();
  const pool = deriveLivePoolPda(program.programId, poolId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const coder = (program as any).coder.accounts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const size: number = (program.account as any).liveEntry.size;
  const disc = coder.memcmp("liveEntry");
  const filters = [
    { memcmp: { offset: disc.offset, bytes: disc.bytes } },
    { dataSize: size },
    { memcmp: { offset: 40, bytes: pool.toBase58() } }, // LiveEntry.pool@40
  ];
  const raw = await scanBothOwners(program.provider.connection, program.programId, filters);

  // The base scan gives the ROSTER (every seat's pubkey — stable, and visible even
  // mid-match via the Delegation-Program-owned copy). But base points are frozen at
  // the last commit, so overlay each seat's LIVE bytes from the ER by pubkey: one
  // getMultipleAccountsInfo, correctly-sized ER rows win, everything else keeps the
  // base bytes. An ER hiccup → base points (pre-live behavior). camelCase decode key.
  let erInfos: (({ data: Buffer } | null)[]) = [];
  if (raw.length > 0) {
    try {
      erInfos = (await erConn().getMultipleAccountsInfo(raw.map((r) => r.pubkey))) ?? [];
    } catch {
      erInfos = []; // ER unreachable → fall back to base bytes for every seat.
    }
  }

  const views: LiveEntryView[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    const erData = erInfos[i]?.data;
    const data = erData && erData.length === size ? erData : item.account.data;
    if (data.length !== size) continue;
    try {
      views.push(toLiveEntryView(item.pubkey, coder.decode("liveEntry", data)));
    } catch {
      continue; // skip an undecodable entry, keep the leaderboard
    }
  }
  return views.sort((x, y) => y.total - x.total); // leaderboard: highest total first
}

/** Fetch + map a single contest by id (scoped path). Returns null if it can't be read/decoded. */
async function readContestById(program: anchor.Program, contestId: number): Promise<ContestView | null> {
  const cPda = deriveContestPda(program.programId, contestId);
  let c: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c = await (program.account as any).contest.fetch(cPda);
  } catch {
    return null;
  }
  const pot = await readContestPot(program, cPda);
  return toContestView(cPda, c, pot);
}

/**
 * Low-level Entry scan for one contest, optionally scoped to a single bettor —
 * the ONE place the Entry memcmp layout lives (bettor @ 8 = after the 8-byte
 * discriminator; contest @ 40 = 8 + 32-byte bettor). Both the wallet-scoped
 * enrichment path (`entriesForContest`) and the whole-card alive-tracking path
 * (`listRawEntriesForContest`) wrap this.
 */
async function scanContestEntries(
  program: anchor.Program, contestPda: PublicKey, bettor?: PublicKey,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const filters: { memcmp: { offset: number; bytes: string } }[] = [];
  if (bettor) filters.push({ memcmp: { offset: 8, bytes: bettor.toBase58() } }); // bettor at offset 8
  filters.push({ memcmp: { offset: 8 + 32, bytes: contestPda.toBase58() } });    // contest at offset 40
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (program.account as any).entry.all(filters);
}

/** Enrich a contest's Entry accounts for one wallet, scored against that contest's settled state. */
async function entriesForContest(
  program: anchor.Program, contest: ContestView, bettor: PublicKey,
): Promise<EntryView[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accts: any[] = await scanContestEntries(program, new PublicKey(contest.pubkey), bettor);
  return accts.map((a) => {
    const picks = (a.account.picks as number[]).map(Number);
    const amount = BigInt(a.account.amount.toString());
    const o = entryOutcome(picks, amount, contest);
    return {
      pubkey: a.publicKey.toBase58(),
      contestId: contest.contestId,
      nonce: Number(a.account.nonce),
      picks,
      amount: amount.toString(),
      won: o.won,
      claimable: o.claimable,
      payout: o.payout.toString(),
    };
  });
}

/**
 * Every Entry the wallet holds, enriched with won/claimable/payout from the
 * owning contest's settled state so the UI can show winners and gate the Claim
 * button without re-deriving the on-chain payout math.
 *
 * - `contestId` given → scope to that single contest (direct fetch, no scan).
 * - otherwise          → iterate all live contests and aggregate, tagging each
 *                        EntryView with its contestId.
 */
export async function listEntriesForWallet(wallet: string, contestId?: number): Promise<EntryView[]> {
  const program = loadProgram();
  const bettor = new PublicKey(wallet);

  if (contestId !== undefined) {
    const contest = await readContestById(program, contestId);
    if (!contest) return [];
    const entries = await entriesForContest(program, contest, bettor);
    return entries.sort((x, y) => x.nonce - y.nonce);
  }

  const contests = await readLiveContests();
  const all: EntryView[] = [];
  for (const contest of contests) {
    all.push(...(await entriesForContest(program, contest, bettor)));
  }
  // Stable order: by contest, then ticket nonce within a contest.
  return all.sort((x, y) => (x.contestId - y.contestId) || (x.nonce - y.nonce));
}

/**
 * Every Entry account for a single contest, UNSCOPED by wallet — the mid-day
 * "how many cards are still alive" read (`/api/card`'s `aliveCount`). Wraps the
 * shared `scanContestEntries` (single memcmp definition) without the bettor
 * filter and without settled-state scoring (entryOutcome only applies
 * post-settle; alive-tracking runs mid-day against each leg's OWN market, not
 * the contest's bulk winning_buckets).
 */
export async function listRawEntriesForContest(contestPubkey: string): Promise<RawEntryView[]> {
  const program = loadProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accts: any[] = await scanContestEntries(program, new PublicKey(contestPubkey));
  return accts.map((a) => ({
    pubkey: a.publicKey.toBase58(),
    bettor: a.account.bettor.toBase58(),
    nonce: Number(a.account.nonce),
    picks: (a.account.picks as number[]).map(Number),
    amount: a.account.amount.toString(),
    entryTs: Number(a.account.entryTs),
  }));
}

export async function readMarket(marketPubkey: string): Promise<MarketView> {
  const program = loadProgram();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = await (program.account as any).market.fetch(new PublicKey(marketPubkey));
  const numBuckets = Number(m.numBuckets);
  return {
    pubkey: marketPubkey,
    status: statusString(m.status),
    fixtureId: Number(m.fixtureId),
    marketId: Number(m.marketId),
    numBuckets,
    // on-chain array is fixed-size 3; expose only the active buckets.
    bucketTotals: (m.bucketTotals as any[]).slice(0, numBuckets).map((b) => b.toString()),
    totalPool: m.totalPool.toString(),
    feeBps: Number(m.feeBps),
    feeCollected: m.feeCollected.toString(),
    winningBucket: m.winningBucket === null ? null : Number(m.winningBucket),
    entryCloseTs: Number(m.entryCloseTs),
    // on-chain i32 (not an Option) — only meaningful when status === "settled" (0 otherwise)
    settledValue: Number(m.settledValue),
  };
}

// ── Beat the Market: line-market reader (market_id 90) ──────────────────────

export interface LineMarketView {
  pubkey: string;
  fixtureId: number;
  status: "open" | "settled" | "voided";
  /** Favourite side the line tracks: 1 = home/Participant1, 2 = away. */
  favSide: 1 | 2;
  /** Opening line, milli-percent (stat threshold field). */
  openMilli: number;
  /** Kick-off (= entry_close_ts), unix SECONDS. */
  entryCloseTs: number;
  bucketTotals: [string, string]; // [Above, Below] lamports
  totalPool: string;
  winningBucket: number | null;
  /** Closing line, milli-percent; meaningful only when settled. */
  settledValueMilli: number;
  settledTs: number;
}

/**
 * Every LINE_CLOSE (market_id 90) market on the program. Discriminator+size
 * filtered getProgramAccounts, decoded via the Anchor coder, then filtered by
 * market_id — same defensive shape as readLiveContests: any RPC/coder failure
 * returns [] rather than throwing into a route.
 */
export async function readLineMarkets(): Promise<LineMarketView[]> {
  try {
    const program = loadProgram();
    const conn = program.provider.connection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const coder = (program.coder as any).accounts;
    const disc = coder.memcmp("market");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const size: number | undefined = (program.account as any).market?.size;
    const filters: object[] = [{ memcmp: { offset: disc.offset ?? 0, bytes: disc.bytes } }];
    if (size) filters.push({ dataSize: size });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = await (conn as any).getProgramAccounts(program.programId, { filters });
    const out: LineMarketView[] = [];
    for (const item of raw) {
      // Defensive: skip wrong-size (orphaned old-layout) accounts even if the RPC
      // ignored the dataSize filter — stale layouts can borsh-decode into the
      // current struct as GARBAGE rather than throwing, so try/catch alone
      // does not skip them (same idiom as readLiveContests).
      if (size && item.account.data.length !== size) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let m: any;
      try { m = coder.decode("market", item.account.data); } catch { continue; }
      if ((m.marketId as number) !== LINE_CLOSE_MARKET_ID) continue;
      out.push({
        pubkey: item.pubkey.toBase58(),
        fixtureId: Number(m.fixtureId),
        status: statusString(m.status),
        favSide: (m.statKey as number) === 2 ? 2 : 1,
        openMilli: m.threshold as number,
        entryCloseTs: Number(m.entryCloseTs),
        bucketTotals: [m.bucketTotals[0].toString(), m.bucketTotals[1].toString()],
        totalPool: m.totalPool.toString(),
        winningBucket: m.winningBucket == null ? null : Number(m.winningBucket),
        settledValueMilli: m.settledValue as number,
        settledTs: Number(m.settledTs),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** This wallet's stakes on a fixture's line market: [Above, Below] lamports,
 *  or null when no position exists. */
export async function readLinePosition(
  fixtureId: number, wallet: string,
): Promise<[string, string] | null> {
  try {
    const program = loadProgram();
    const market = deriveMarketPda(program.programId, fixtureId, LINE_CLOSE_MARKET_ID);
    const position = derivePositionPda(program.programId, market, new PublicKey(wallet));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = await (program.account as any).position.fetchNullable(position);
    if (p === null) return null;
    return [p.amounts[0].toString(), p.amounts[1].toString()];
  } catch {
    return null;
  }
}
