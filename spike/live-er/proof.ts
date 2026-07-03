/**
 * Slice 2b — devnet ER runtime proof (throwaway spike).
 *
 * Proves the full MagicBlock Ephemeral Rollups cycle end-to-end on real devnet:
 *   base: create → prealloc → join×2 → delegate(cursor, entry×2, call)
 *   ER:   open_call → lock_pick×2 → resolve_call → score_entry×2 → commit → end_and_undelegate
 *   base: end_live_pool → settle_live_pool → claim
 *
 * Also runs the FINDING [2] probe: reads a delegated LiveEntry on the BASE RPC at
 * three checkpoints to answer "is a delegated account's data readable on base?" —
 * which forks the keeper-death refund fix.
 *
 * Run from repo root:
 *   ./keeper/node_modules/.bin/tsx spike/live-er/proof.ts
 * (resolves @coral-xyz/anchor + @solana/web3.js from repo-root node_modules)
 */
import anchorDefault from "@coral-xyz/anchor";
import type { Idl as IdlType } from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Transaction,
} from "@solana/web3.js";

const { BN, Program, AnchorProvider, Wallet } = anchorDefault;
type Idl = IdlType;
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

// ── constants (all runtime-verified 2026-07-01) ────────────────────────────
const BASE_RPC = "https://api.devnet.solana.com";
const ER_RPC = "https://devnet.magicblock.app";
const PROGRAM_ID = new PublicKey("By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"); // = devnet.magicblock.app identity
const NONE_SEQ = 0xffffffff;

const REPO = process.cwd();
const idl = JSON.parse(readFileSync(`${REPO}/target/idl/proofbet.json`, "utf8"));
idl.address = PROGRAM_ID.toBase58();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log(...a);
const short = (pk: PublicKey | string) => { const s = pk.toString(); return s.slice(0, 4) + ".." + s.slice(-4); };

// ── keypairs ────────────────────────────────────────────────────────────────
function loadKp(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const keeper = loadKp(`${homedir()}/.config/solana/lazer-probe.json`); // funded authority; keeper + settle_authority
const playerA = Keypair.generate();
const playerB = Keypair.generate();

// ── PDA derivations (mirror tests/live_helpers.ts) ──────────────────────────
const livePoolPda = (poolId: any) =>
  PublicKey.findProgramAddressSync([Buffer.from("livepool"), poolId.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
const liveCursorPda = (pool: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("livecursor"), pool.toBuffer()], PROGRAM_ID)[0];
const callPda = (pool: PublicKey, seq: number) =>
  PublicKey.findProgramAddressSync([Buffer.from("call"), pool.toBuffer(), new BN(seq).toArrayLike(Buffer, "le", 4)], PROGRAM_ID)[0];
const liveEntryPda = (pool: PublicKey, player: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("liveentry"), pool.toBuffer(), player.toBuffer()], PROGRAM_ID)[0];
const jackpotPda = () => PublicKey.findProgramAddressSync([Buffer.from("jackpot")], PROGRAM_ID)[0];

// ── providers / programs (one per layer) ────────────────────────────────────
const baseConn = new Connection(BASE_RPC, "confirmed");
const erConn = new Connection(ER_RPC, "confirmed");
const wallet = new Wallet(keeper);
const baseProvider = new AnchorProvider(baseConn, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
const erProvider = new AnchorProvider(erConn, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
const base = new Program(idl as Idl, baseProvider);
const er = new Program(idl as Idl, erProvider);

// ── report accumulator ──────────────────────────────────────────────────────
const report: any = { steps: [], probe: {}, errors: [] };
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    log(`  ✅ ${name} (${ms}ms)` + (typeof r === "string" ? ` sig=${(r as string).slice(0, 8)}…` : ""));
    report.steps.push({ name, ms, ok: true, sig: typeof r === "string" ? r : undefined });
    return r;
  } catch (e: any) {
    const ms = Date.now() - t0;
    const msg = e?.message || String(e);
    log(`  ❌ ${name} (${ms}ms): ${msg}`);
    if (e?.logs) log("     logs:", JSON.stringify(e.logs).slice(0, 1200));
    report.steps.push({ name, ms, ok: false, err: msg, logs: e?.logs });
    report.errors.push({ name, err: msg });
    return null;
  }
}

// Read a LiveEntry on the BASE RPC and decode owner/data — the Finding [2] probe.
async function probeEntry(label: string, entry: PublicKey, layer: Connection = baseConn) {
  const info = await layer.getAccountInfo(entry, "confirmed");
  let decoded: any = null;
  if (info && info.data.length > 0) {
    try {
      const acc = base.coder.accounts.decode("LiveEntry", info.data);
      decoded = { player: acc.player.toBase58(), amount: acc.amount.toString(), picks0: acc.picks?.[0], basePts: acc.basePts, bonusPts: acc.bonusPts, nextScoreSeq: acc.nextScoreSeq };
    } catch (e: any) { decoded = { decodeError: e?.message }; }
  }
  const snap = {
    present: !!info,
    owner: info ? info.owner.toBase58() : null,
    ownerIs: info ? (info.owner.equals(PROGRAM_ID) ? "OUR_PROGRAM" : info.owner.equals(DELEGATION_PROGRAM) ? "DELEGATION_PROGRAM" : "OTHER") : null,
    dataLen: info ? info.data.length : 0,
    lamports: info ? info.lamports : 0,
    decoded,
  };
  report.probe[label] = snap;
  log(`  🔎 probe[${label}] on ${layer === baseConn ? "BASE" : "ER"}: present=${snap.present} owner=${snap.ownerIs} dataLen=${snap.dataLen} decoded=${JSON.stringify(decoded)}`);
  return snap;
}

async function fund(to: PublicKey, sol: number) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
  const sig = await baseProvider.sendAndConfirm(tx, []);
  return sig;
}

// poll BASE until predicate(accountInfo) or timeout
async function pollBase(pk: PublicKey, pred: (i: any) => boolean, label: string, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const info = await baseConn.getAccountInfo(pk, "confirmed");
    if (pred(info)) { log(`  ⏱  ${label} satisfied after ${Date.now() - t0}ms`); return info; }
    await sleep(3000);
  }
  throw new Error(`pollBase timeout: ${label}`);
}

async function main() {
  log("═══ Slice 2b devnet ER runtime proof ═══");
  log(`keeper=${short(keeper.publicKey)} A=${short(playerA.publicKey)} B=${short(playerB.publicKey)}`);
  const kbal = await baseConn.getBalance(keeper.publicKey);
  log(`keeper base balance: ${(kbal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // params
  const poolId = new BN(Date.now()).mul(new BN(1000)); // unique
  const fixtureId = new BN(900001);
  const entryPrice = new BN(0.02 * LAMPORTS_PER_SOL);
  const feeBps = 0;
  const numCalls = 1;
  const now = Math.floor(Date.now() / 1000);
  const lockTs = new BN(now + 90);           // joins close in 90s
  const settleAfterTs = new BN(now + 420);   // settle allowed in 7min (room for ER + undelegate)
  const pool = livePoolPda(poolId);
  const cursor = liveCursorPda(pool);
  const call0 = callPda(pool, 0);
  const entryA = liveEntryPda(pool, playerA.publicKey);
  const entryB = liveEntryPda(pool, playerB.publicKey);
  log(`pool=${short(pool)} cursor=${short(cursor)} call0=${short(call0)}`);
  report.meta = { poolId: poolId.toString(), pool: pool.toBase58(), entryA: entryA.toBase58(), entryB: entryB.toBase58(), erRpc: ER_RPC };

  // ── fund players ──
  log("\n── funding players ──");
  await step("fund A 0.1", () => fund(playerA.publicKey, 0.1));
  await step("fund B 0.1", () => fund(playerB.publicKey, 0.1));

  // ── BASE: create + prealloc + join×2 ──
  log("\n── BASE setup ──");
  await step("create_live_pool", () =>
    base.methods.createLivePool(poolId, fixtureId, entryPrice, lockTs, settleAfterTs, keeper.publicKey, feeBps, numCalls)
      .accountsPartial({ keeper: keeper.publicKey, pool, cursor, systemProgram: SystemProgram.programId }).rpc());
  await step("prealloc_call(0)", () =>
    base.methods.preallocCall(0).accountsPartial({ keeper: keeper.publicKey, pool, call: call0, systemProgram: SystemProgram.programId }).rpc());
  await step("join A", () =>
    base.methods.joinLivePool().accountsPartial({ player: playerA.publicKey, pool, entry: entryA, systemProgram: SystemProgram.programId }).signers([playerA]).rpc());
  await step("join B", () =>
    base.methods.joinLivePool().accountsPartial({ player: playerB.publicKey, pool, entry: entryB, systemProgram: SystemProgram.programId }).signers([playerB]).rpc());

  // PROBE 1 — baseline (entry undelegated, our-program-owned)
  log("\n── PROBE checkpoint 1 (baseline) ──");
  await probeEntry("1_baseline_base", entryA);

  // ── BASE: delegate the ER set ──
  log("\n── delegate (base) ──");
  const delOpts = (pda: PublicKey) => ({ keeper: keeper.publicKey, pool, pda });
  const validatorRemaining = [{ pubkey: VALIDATOR, isSigner: false, isWritable: false }];
  await step("delegate_cursor", () =>
    base.methods.delegateCursor().accountsPartial(delOpts(cursor)).remainingAccounts(validatorRemaining).rpc());
  await step("delegate_entry A", () =>
    base.methods.delegateEntry(playerA.publicKey).accountsPartial(delOpts(entryA)).remainingAccounts(validatorRemaining).rpc());
  await step("delegate_entry B", () =>
    base.methods.delegateEntry(playerB.publicKey).accountsPartial(delOpts(entryB)).remainingAccounts(validatorRemaining).rpc());
  await step("delegate_call(0)", () =>
    base.methods.delegateCall(0).accountsPartial(delOpts(call0)).remainingAccounts(validatorRemaining).rpc());

  // PROBE 2 — post-delegate (THE finding [2] question)
  log("\n── PROBE checkpoint 2 (post-delegate) ──");
  await probeEntry("2_postdelegate_base", entryA, baseConn);
  await probeEntry("2_postdelegate_er", entryA, erConn);

  // wait for the ER to pick up the delegated accounts
  log("\n── wait for ER to see delegated cursor ──");
  await step("er sees cursor", async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      const i = await erConn.getAccountInfo(cursor, "confirmed");
      if (i && i.owner.equals(PROGRAM_ID)) return "ready";
      await sleep(2500);
    }
    throw new Error("ER never surfaced delegated cursor");
  });

  // ── ER: open / lock / resolve / score ──
  log("\n── ER gameplay ──");
  await step("open_call(0)", () =>
    er.methods.openCall(0, { nextGoal: {} }, 3, [4, 1, 4], 120)
      .accountsPartial({ keeper: keeper.publicKey, pool, cursor, call: call0 }).rpc());
  await step("lock_pick A=0", () =>
    er.methods.lockPick(0).accountsPartial({ player: playerA.publicKey, call: call0, entry: entryA }).signers([playerA]).rpc());
  await step("lock_pick B=1", () =>
    er.methods.lockPick(1).accountsPartial({ player: playerB.publicKey, call: call0, entry: entryB }).signers([playerB]).rpc());
  await step("resolve_call(0)=0", () =>
    er.methods.resolveCall(0).accountsPartial({ keeper: keeper.publicKey, pool, cursor, call: call0 }).rpc());
  await step("score_entry A", () =>
    er.methods.scoreEntry().accountsPartial({ cranker: keeper.publicKey, call: call0, entry: entryA }).rpc());
  await step("score_entry B", () =>
    er.methods.scoreEntry().accountsPartial({ cranker: keeper.publicKey, call: call0, entry: entryB }).rpc());

  // ── ER: commit (mid-match checkpoint, no undelegate) ──
  log("\n── commit_live (ER→base checkpoint) ──");
  const commitRemaining = [cursor, entryA, entryB, call0].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
  await step("commit_live", () =>
    er.methods.commitLive().accountsPartial({ keeper: keeper.publicKey, pool }).remainingAccounts(commitRemaining).rpc());

  // PROBE 3 — after commit: does BASE reflect the committed ER state?
  log("\n── PROBE checkpoint 3 (post-commit) ──");
  await sleep(6000); // commit is async
  await probeEntry("3_postcommit_base", entryA, baseConn);

  // ── ER: end_and_undelegate (final commit + ownership return) ──
  log("\n── end_and_undelegate ──");
  await step("end_and_undelegate", () =>
    er.methods.endAndUndelegate().accountsPartial({ keeper: keeper.publicKey, pool }).remainingAccounts(commitRemaining).rpc());

  // wait until ALL delegated accounts return to our-program ownership on base
  log("\n── wait for undelegation (base ownership restored) ──");
  await step("cursor undelegated", () => pollBase(cursor, (i) => !!i && i.owner.equals(PROGRAM_ID), "cursor→OUR_PROGRAM"));
  await step("entryA undelegated", () => pollBase(entryA, (i) => !!i && i.owner.equals(PROGRAM_ID), "entryA→OUR_PROGRAM"));
  await step("entryB undelegated", () => pollBase(entryB, (i) => !!i && i.owner.equals(PROGRAM_ID), "entryB→OUR_PROGRAM"));

  // PROBE 4 — post-undelegate: final base state
  await probeEntry("4_postundelegate_base", entryA);

  // ── BASE: end + settle + claim ──
  log("\n── BASE settle ──");
  await step("end_live_pool", () =>
    base.methods.endLivePool().accountsPartial({ keeper: keeper.publicKey, pool, cursor }).rpc());

  // wait for the on-chain clock to pass settle_after_ts
  log("── waiting for settle_after_ts ──");
  await step("wait settle window", async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 480_000) {
      const bt = await baseConn.getBlockTime(await baseConn.getSlot());
      if (bt !== null && bt >= settleAfterTs.toNumber() + 1) return "ready";
      await sleep(5000);
    }
    throw new Error("settle window never reached");
  });

  const entriesSorted = [entryA, entryB].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  await step("settle_live_pool", () =>
    base.methods.settleLivePool()
      .accountsPartial({ settleAuthority: keeper.publicKey, jackpot: jackpotPda(), pool, cursor, feeRecipient: keeper.publicKey })
      .remainingAccounts(entriesSorted.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))).rpc());

  // read pool to see winner
  await step("read settled pool", async () => {
    const p: any = await base.account.livePool.fetch(pool);
    log(`     winning_score=${p.winningScore} winner_count=${p.winnerCount} distributable=${p.distributable?.toString?.()} status=${JSON.stringify(p.status)}`);
    report.settled = { winningScore: p.winningScore, winnerCount: p.winnerCount, distributable: p.distributable?.toString?.() };
    return "ok";
  });

  // winner (A) claims
  await step("claim A (winner)", () =>
    base.methods.claimLivePool().accountsPartial({ player: playerA.publicKey, pool, entry: entryA, systemProgram: SystemProgram.programId }).signers([playerA]).rpc());
  await step("claim B (loser closes)", () =>
    base.methods.claimLivePool().accountsPartial({ player: playerB.publicKey, pool, entry: entryB, systemProgram: SystemProgram.programId }).signers([playerB]).rpc());

  report.ok = report.errors.length === 0;
  log("\n═══ DONE ═══ errors:", report.errors.length);
}

main()
  .catch((e) => { report.fatal = e?.message || String(e); log("FATAL:", report.fatal); if (e?.logs) log(e.logs); })
  .finally(() => {
    writeFileSync(`${REPO}/spike/live-er/proof-report.json`, JSON.stringify(report, null, 2));
    log("\nreport → spike/live-er/proof-report.json");
    log("\n─── FINDING [2] verdict inputs ───");
    log("probe 1 (baseline):     ", JSON.stringify(report.probe["1_baseline_base"]));
    log("probe 2 (post-deleg BASE):", JSON.stringify(report.probe["2_postdelegate_base"]));
    log("probe 2 (post-deleg ER):  ", JSON.stringify(report.probe["2_postdelegate_er"]));
    log("probe 3 (post-commit BASE):", JSON.stringify(report.probe["3_postcommit_base"]));
    log("probe 4 (post-undeleg BASE):", JSON.stringify(report.probe["4_postundelegate_base"]));
  });
