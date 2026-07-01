import {
  program, connection, freshFunded, nowSec, sleep, BN, PublicKey, SystemProgram, LAMPORTS_PER_SOL,
} from "./helpers";
import type { Keypair } from "@solana/web3.js";
import { jackpotPda, ensureJackpot } from "./contest_helpers";

/* ──────────────────────────────────────────────────────────────────────────
 * Test harness for the LIVE match game (SLICE 1, base layer).
 * PDA derivations + granular instruction wrappers + a scenario runner + a TS
 * scoring oracle (mirrors the on-chain fold) used to assert fidelity.
 * ──────────────────────────────────────────────────────────────────────── */

export const VOID_OUTCOME = 0xfe;
export const NO_PICK = 0xff;
export const MAX_CALLS = 64;

export const KIND = {
  nextGoal: { nextGoal: {} },
  goalRush: { goalRush: {} },
  cornerSoon: { cornerSoon: {} },
  cardSoon: { cardSoon: {} },
} as const;

let COUNTER = 0;
/** Unique u64 pool_id per call (Date.now ms × 1000 + counter) so PDAs never
 *  collide across tests sharing one validator. */
export function uniquePoolId(): BN {
  return new BN(Date.now()).mul(new BN(1000)).add(new BN(COUNTER++));
}

export function livePoolPda(poolId: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livepool"), poolId.toArrayLike(Buffer, "le", 8)],
    program.programId,
  )[0];
}
export function liveCursorPda(pool: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("livecursor"), pool.toBuffer()],
    program.programId,
  )[0];
}
export function callPda(pool: PublicKey, seq: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("call"), pool.toBuffer(), new BN(seq).toArrayLike(Buffer, "le", 4)],
    program.programId,
  )[0];
}
export function liveEntryPda(pool: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liveentry"), pool.toBuffer(), player.toBuffer()],
    program.programId,
  )[0];
}

export interface PoolCtx {
  keeper: Keypair;
  feeRecipient: Keypair;
  poolId: BN;
  pool: PublicKey;
  cursor: PublicKey;
  entryPrice: number;
  lockTs: number;
  settleAfterTs: number;
  numCalls: number;
}

export async function createPool(opts: {
  keeper?: Keypair;
  entryPrice?: number;
  feeBps?: number;
  numCalls?: number;
  lockInSecs?: number;
  settleInSecs?: number;
  fixtureId?: number;
} = {}): Promise<PoolCtx> {
  const keeper = opts.keeper ?? (await freshFunded());
  const feeRecipient = await freshFunded(0.001); // just needs to exist for the credit
  const poolId = uniquePoolId();
  const fixtureId = opts.fixtureId ?? 900_000 + (COUNTER % 1000);
  const entryPrice = opts.entryPrice ?? 0.1 * LAMPORTS_PER_SOL;
  const feeBps = opts.feeBps ?? 0;
  const numCalls = opts.numCalls ?? 16;
  // Invariant: now < lock_ts < settle_after_ts. Clamp the lock window below the
  // settle time so a short settleInSecs never inverts them (EntryCloseInPast).
  const settleInSecs = opts.settleInSecs ?? 12;
  const lockInSecs = Math.min(opts.lockInSecs ?? 9, settleInSecs - 1);
  const lockTs = nowSec() + lockInSecs;
  const settleAfterTs = nowSec() + settleInSecs;
  const pool = livePoolPda(poolId);
  const cursor = liveCursorPda(pool);
  await program.methods
    .createLivePool(poolId, new BN(fixtureId), new BN(entryPrice), new BN(lockTs), new BN(settleAfterTs), feeRecipient.publicKey, feeBps, numCalls)
    .accountsStrict({ keeper: keeper.publicKey, pool, cursor, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  const ctx: PoolCtx = { keeper, feeRecipient, poolId, pool, cursor, entryPrice, lockTs, settleAfterTs, numCalls };
  // Pre-create every call PDA on the base layer (CallState::Empty) so open_call only
  // MUTATES it (Empty→Open) — the ER model forbids creating accounts inside the
  // rollup, so all calls must exist and be delegatable before kickoff. Mirrors the
  // real keeper flow: create → prealloc ×N → (delegate) → open/lock/resolve.
  // Fire them CONCURRENTLY so N preallocs cost ~1 round-trip, not N — otherwise a
  // large numCalls burns the join window and later joins would hit JoinClosed.
  await Promise.all(Array.from({ length: numCalls }, (_, s) => preallocCall(ctx, s)));
  return ctx;
}

export async function joinPool(ctx: PoolCtx, player?: Keypair): Promise<{ player: Keypair; entry: PublicKey }> {
  const p = player ?? (await freshFunded());
  const entry = liveEntryPda(ctx.pool, p.publicKey);
  await program.methods
    .joinLivePool()
    .accountsStrict({ player: p.publicKey, pool: ctx.pool, entry, systemProgram: SystemProgram.programId })
    .signers([p]).rpc();
  return { player: p, entry };
}

export async function preallocCall(ctx: PoolCtx, seq: number): Promise<void> {
  await program.methods
    .preallocCall(seq)
    .accountsStrict({ keeper: ctx.keeper.publicKey, pool: ctx.pool, call: callPda(ctx.pool, seq), systemProgram: SystemProgram.programId })
    .signers([ctx.keeper]).rpc();
}

export async function openCall(ctx: PoolCtx, seq: number, spec: {
  kind?: any; numOptions?: number; basePoints?: number[]; answerSecs?: number;
} = {}): Promise<void> {
  await program.methods
    .openCall(seq, spec.kind ?? KIND.nextGoal, spec.numOptions ?? 3, spec.basePoints ?? [4, 1, 4], spec.answerSecs ?? 120)
    .accountsStrict({ keeper: ctx.keeper.publicKey, pool: ctx.pool, cursor: ctx.cursor, call: callPda(ctx.pool, seq) })
    .signers([ctx.keeper]).rpc();
}

export async function lockPick(ctx: PoolCtx, player: Keypair, seq: number, option: number): Promise<void> {
  await program.methods
    .lockPick(option)
    .accountsStrict({ player: player.publicKey, call: callPda(ctx.pool, seq), entry: liveEntryPda(ctx.pool, player.publicKey) })
    .signers([player]).rpc();
}

export async function resolveCall(ctx: PoolCtx, seq: number, outcome: number): Promise<void> {
  await program.methods
    .resolveCall(outcome)
    .accountsStrict({ keeper: ctx.keeper.publicKey, pool: ctx.pool, cursor: ctx.cursor, call: callPda(ctx.pool, seq) })
    .signers([ctx.keeper]).rpc();
}

export async function scoreEntry(ctx: PoolCtx, player: PublicKey, seq: number): Promise<void> {
  await program.methods
    .scoreEntry()
    .accountsStrict({ cranker: ctx.keeper.publicKey, call: callPda(ctx.pool, seq), entry: liveEntryPda(ctx.pool, player) })
    .signers([ctx.keeper]).rpc();
}

export async function endPool(ctx: PoolCtx): Promise<void> {
  await program.methods
    .endLivePool()
    .accountsStrict({ keeper: ctx.keeper.publicKey, pool: ctx.pool, cursor: ctx.cursor })
    .signers([ctx.keeper]).rpc();
}

export async function settlePool(ctx: PoolCtx, entries: PublicKey[], opts: { sort?: boolean } = {}): Promise<void> {
  const jackpot = await ensureJackpot();
  // The program requires strictly-ascending (hence unique) entry keys.
  const ordered = opts.sort === false ? entries : [...entries].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  await program.methods
    .settleLivePool()
    .accountsStrict({ settleAuthority: ctx.keeper.publicKey, jackpot, pool: ctx.pool, cursor: ctx.cursor, feeRecipient: ctx.feeRecipient.publicKey })
    .remainingAccounts(ordered.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })))
    .signers([ctx.keeper]).rpc();
}

export async function claimPool(ctx: PoolCtx, player: Keypair): Promise<void> {
  await program.methods
    .claimLivePool()
    .accountsStrict({ player: player.publicKey, pool: ctx.pool, entry: liveEntryPda(ctx.pool, player.publicKey), systemProgram: SystemProgram.programId })
    .signers([player]).rpc();
}

/** Permissionless all-seats refund of a Voided pool. `seats` = every (entry, wallet);
 *  entries are sorted ascending and interleaved [entry, player] as the program expects.
 *  `cranker` defaults to the keeper but ANY signer works (permissionless). */
export async function refundVoided(
  ctx: PoolCtx,
  seats: { entry: PublicKey; playerWallet: PublicKey }[],
  cranker?: Keypair,
): Promise<void> {
  const c = cranker ?? ctx.keeper;
  const ordered = [...seats].sort((a, b) => Buffer.compare(a.entry.toBuffer(), b.entry.toBuffer()));
  const remaining = ordered.flatMap(({ entry, playerWallet }) => [
    { pubkey: entry, isSigner: false, isWritable: false },
    { pubkey: playerWallet, isSigner: false, isWritable: true },
  ]);
  await program.methods
    .refundVoided()
    .accountsStrict({ cranker: c.publicKey, pool: ctx.pool })
    .remainingAccounts(remaining)
    .signers([c]).rpc();
}

/** Wait until the ON-CHAIN clock passes settle_after_ts. The validator's
 *  Clock.unix_timestamp lags wall-clock under load, so a wall-clock sleep isn't
 *  enough — poll getBlockTime (which tracks the same slot clock the program reads). */
export async function waitForSettle(ctx: PoolCtx): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const t = await connection.getBlockTime(await connection.getSlot());
    if (t !== null && t >= ctx.settleAfterTs + 1) return;
    await sleep(1000);
  }
}

// ── Scenario spec ──────────────────────────────────────────────────────────
export interface CallSpec {
  kind?: any;
  numOptions?: number;
  basePoints?: number[]; // per-option base (length 3; unused tail 0)
  answerSecs?: number;
  outcome: number;       // resolved option, or VOID_OUTCOME
  /** picks[i] = the option player i locks, or null for no pick. */
  picks: (number | null)[];
}

/**
 * Full match: create pool → join N players → for each call open/lock/resolve/
 * score-all → end. Does NOT settle (tests decide). Returns handles.
 */
export async function runMatch(numPlayers: number, calls: CallSpec[], opts: {
  feeBps?: number; entryPrice?: number; numCalls?: number; lockInSecs?: number; settleInSecs?: number;
} = {}): Promise<{ ctx: PoolCtx; players: Keypair[]; entries: PublicKey[] }> {
  const ctx = await createPool({
    feeBps: opts.feeBps, entryPrice: opts.entryPrice,
    numCalls: opts.numCalls ?? Math.max(calls.length, 1),
    lockInSecs: opts.lockInSecs, settleInSecs: opts.settleInSecs,
  });
  const players: Keypair[] = [];
  const entries: PublicKey[] = [];
  for (let i = 0; i < numPlayers; i++) {
    const { player, entry } = await joinPool(ctx);
    players.push(player); entries.push(entry);
  }
  for (let seq = 0; seq < calls.length; seq++) {
    const c = calls[seq];
    await openCall(ctx, seq, { kind: c.kind, numOptions: c.numOptions, basePoints: c.basePoints, answerSecs: c.answerSecs });
    for (let i = 0; i < numPlayers; i++) {
      const opt = c.picks[i];
      if (opt !== null && opt !== undefined) await lockPick(ctx, players[i], seq, opt);
    }
    await resolveCall(ctx, seq, c.outcome);
    for (let i = 0; i < numPlayers; i++) await scoreEntry(ctx, players[i].publicKey, seq);
  }
  await endPool(ctx);
  return { ctx, players, entries };
}

// ── TS scoring oracle — mirrors the on-chain fold (score_entry) exactly ──────
export interface Score { base: number; bonus: number; streak: number; total: number }

export function gradePlayer(calls: CallSpec[], playerIndex: number): Score {
  let base = 0, bonus = 0, streak = 0;
  for (const c of calls) {
    if (c.outcome === VOID_OUTCOME) continue; // global void: no-op
    const pick = c.picks[playerIndex];
    if (pick !== null && pick !== undefined && pick === c.outcome) {
      base += (c.basePoints ?? [4, 1, 4])[c.outcome];
      streak += 1;
      if (streak >= 3) bonus += streak - 2;
    } else {
      streak = 0; bonus = 0;
    }
  }
  return { base, bonus, streak, total: base + bonus };
}

export { LAMPORTS_PER_SOL, jackpotPda };
