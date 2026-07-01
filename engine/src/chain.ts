import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { PROGRAM_ID, RPC_URL } from "./config.ts";
import { marketById } from "./markets.ts";

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
  settleAfterTs: number;
  feeBps: number;
  status: "open" | "settled" | "rolledOver" | "voided";
  winningBuckets: number[];     // length numLegs
  entryCount: number;
  perfectCount: number;
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
    settleAfterTs: Number(c.settleAfterTs),
    feeBps: Number(c.feeBps),
    status,
    winningBuckets,
    entryCount: Number(c.entryCount),
    perfectCount: Number(c.perfectCount),
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
 * Delegated accounts have a flipped `.owner`, but their data stays readable and
 * the dataSize filter still finds them, so we do NOT depend on program-ownership.
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
 * Scan Call accounts (size-filtered), optionally scoped to a single pool. Clones
 * readLivePools; adds a `{offset:8, bytes:pool}` memcmp when `pool` is given
 * (Call.pool lives at offset 8, verified against live_state.rs). camelCase 'call'
 * account name; runtime size (`program.account.call.size`, 62). Same per-account
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw = (await (conn as any).getProgramAccounts(program.programId, { filters })) as {
      pubkey: PublicKey;
      account: { data: Buffer };
    }[];
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

/** Enrich a contest's Entry accounts for one wallet, scored against that contest's settled state. */
async function entriesForContest(
  program: anchor.Program, contest: ContestView, bettor: PublicKey,
): Promise<EntryView[]> {
  const cPda = new PublicKey(contest.pubkey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accts: any[] = await (program.account as any).entry.all([
    { memcmp: { offset: 8, bytes: bettor.toBase58() } },        // bettor at offset 8
    { memcmp: { offset: 8 + 32, bytes: cPda.toBase58() } },     // contest at offset 40
  ]);
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
