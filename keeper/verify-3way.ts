/**
 * Devnet e2e for the three-way (1X2) shared-pool market.
 *
 * Proves the thing a separate-pools design CANNOT do: staking one outcome moves
 * ALL three odds, because they share a single parimutuel pool. Then attempts a
 * real settle (goal-diff proof) + claim.
 *
 *   tsx verify-3way.ts [--fixture <id>] [--market <id>]
 */
import { config } from "dotenv";
config();
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { impliedOddsN } from "../engine/src/odds.js";
import { loadProofbetProgram, settleMarketByPubkey } from "./settle.js";

const BN = anchorDefault.BN;
const SOL = 1_000_000_000;
const flag = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function marketPda(pid: PublicKey, fid: number, mid: number) {
  return PublicKey.findProgramAddressSync([Buffer.from("market"), i64le(fid), Buffer.from([mid])], pid)[0];
}
function vaultPda(pid: PublicKey, m: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
}
function positionPda(pid: PublicKey, m: PublicKey, b: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), b.toBuffer()], pid)[0];
}

async function main() {
  const fixtureId = Number(flag("fixture", "18167317"));
  const marketId = Number(flag("market", "60"));

  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const program = loadProofbetProgram(ctx.provider);
  const pid = program.programId;
  const me = ctx.wallet.publicKey;

  const market = marketPda(pid, fixtureId, marketId);
  const vault = vaultPda(pid, market);
  const position = positionPda(pid, market, me);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = program.account as any;

  // Skip if this market PDA is already taken (rerun with a different --market).
  if ((await acct.market.fetchNullable(market)) !== null) {
    console.log(`market ${marketId} on fixture ${fixtureId} already exists (${market.toBase58()}). Use --market <n>.`);
    process.exit(1);
  }

  const WINDOW_SEC = 70;
  const entryCloseTs = Math.floor(Date.now() / 1000) + WINDOW_SEC;
  console.log(`\n── Creating 3-way Match Result market (fixture ${fixtureId}, market ${marketId}) ──`);
  await program.methods.initializeMarket(new BN(fixtureId), marketId, {
    settleAuthority: me, feeRecipient: null,
    statKey: 1, statKey2: 2, op: { subtract: {} },          // home − away goals
    comparison: { greaterThan: {} }, threshold: 0,
    entryCloseTs: new BN(entryCloseTs), feeBps: 0, numBuckets: 3,
  }).accountsStrict({ creator: me, market, vault, systemProgram: SystemProgram.programId }).rpc();
  console.log("market:", market.toBase58());

  const LABEL = ["HOME", "DRAW", "AWAY"];
  async function showOdds(tag: string) {
    const m = await acct.market.fetch(market);
    const totals: bigint[] = m.bucketTotals.slice(0, m.numBuckets).map((b: any) => BigInt(b.toString()));
    const pool = Number(m.totalPool) / SOL;
    const line = totals.map((t, i) => `${LABEL[i]} ${(Number(t) / SOL).toFixed(2)}◎ @ ${impliedOddsN(totals, i, 0).toFixed(2)}×`).join("   ");
    console.log(`  ${tag.padEnd(22)} pool ${pool.toFixed(2)}◎ |  ${line}`);
  }

  async function bet(bucket: number, sol: number) {
    await program.methods.placeBet(bucket, new BN(Math.round(sol * SOL)))
      .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
  }

  console.log(`\n── Betting into the shared pool (watch ALL odds move) ──`);
  await showOdds("empty");
  await bet(0, 0.4); await bet(1, 0.3); await bet(2, 0.2);
  await showOdds("after 0.4/0.3/0.2");
  console.log(`  → now add 0.6 more on HOME and watch DRAW + AWAY odds climb:`);
  await bet(0, 0.6);
  await showOdds("after +0.6 on HOME");

  console.log(`\n── Waiting for entry close, then settling from the goal-diff proof ──`);
  const waitMs = (entryCloseTs - Math.floor(Date.now() / 1000) + 4) * 1000;
  if (waitMs > 0) await sleep(waitMs);
  try {
    const res = await settleMarketByPubkey(ctx, auth, program, market, { dryRun: false });
    console.log("settle result:", JSON.stringify(res));
    const m = await acct.market.fetch(market);
    if (m.status.settled) {
      const wb = m.winningBucket as number;
      console.log(`SETTLED → winner = ${LABEL[wb]} (bucket ${wb}), settled_value (goal diff) = ${m.settledValue}`);
      console.log(`\n── Claiming (operator backed all 3 → sweeps the pool) ──`);
      const before = await ctx.connection.getBalance(me);
      await program.methods.claim()
        .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
      const after = await ctx.connection.getBalance(me);
      console.log(`claimed. wallet Δ ≈ ${((after - before) / SOL).toFixed(4)}◎ (net of tx fee)`);
    } else {
      console.log(`market status after settle attempt: ${JSON.stringify(m.status)} (fixture may not be final on TxLINE yet)`);
    }
  } catch (e) {
    console.log("settle/claim skipped:", (e as Error).message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
