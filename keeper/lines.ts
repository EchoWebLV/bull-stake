// keeper/lines.ts
/**
 * Beat the Market keeper — one idempotent pass over the line markets (spec §4).
 *
 *   ENSURE  fixtures kicking off in (now+minLead, now+horizon] with a fresh
 *           full-game 1X2 StablePrice row → initialize_market(id 90) with
 *           threshold = opening line, stat_key = favourite side. PDA exists → skip.
 *   SEED    open line markets with BOTH bucket totals exactly 0 → place_bet
 *           LINES_SEED_SOL on each side (both-zero guard prevents double-seeding;
 *           a crash between the two placeBets leaves a one-sided seed, which
 *           fails safe — bounded loss or zero-winner auto-void — and is
 *           detected+logged for manual top-up).
 *   SETTLE  open line markets past KO+buffer → close from /api/odds/updates
 *           (full history — snapshot may be overwritten by in-running rows),
 *           then settle(winning, 0, closeTs, closeMilli) or void_market.
 *   SWEEP   after a terminal state, claim the keeper's own position (recovers
 *           the seed's winning share / void refund).
 *
 *   npx tsx lines.ts [--dry-run] [--fixture <id>]
 *
 * Env (spec §9): LINES_HORIZON_H(24) LINES_MIN_LEAD_MIN(30) LINES_OPEN_FRESH_MIN(60)
 *                LINES_STALE_MAX_MIN(30) LINES_SEED_SOL(0.05) LINES_SETTLE_BUFFER_MIN(2)
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { authenticateCached } from "../spike/src/auth-cache.js";
import { getFixtures, type Fixture } from "../spike/src/discover.js";
import { fetchOddsSnapshot, fetchOddsUpdates } from "../spike/src/odds.js";
import { lineInitArgs, LINE_CLOSE_MARKET_ID } from "../engine/src/markets.js";
import { pickOpen, resolveLine } from "./lines-rules.js";
import { loadProofbetProgram } from "./settle.js";

const BN = anchorDefault.BN;
const SOL = 1_000_000_000;
const MIN_MS = 60_000;

const envNum = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const HORIZON_MS = envNum("LINES_HORIZON_H", 24) * 3_600_000;
const MIN_LEAD_MS = envNum("LINES_MIN_LEAD_MIN", 30) * MIN_MS;
const OPEN_FRESH_MIN = envNum("LINES_OPEN_FRESH_MIN", 60);
const STALE_MAX_MIN = envNum("LINES_STALE_MAX_MIN", 30);
const SEED_LAMPORTS = Math.round(envNum("LINES_SEED_SOL", 0.05) * SOL);
const SETTLE_BUFFER_MS = envNum("LINES_SETTLE_BUFFER_MIN", 2) * MIN_MS;
/** How far back a kicked-off fixture stays in the SETTLE/SWEEP candidate set. */
const SETTLE_LOOKBACK_MS = 36 * 3_600_000;

function i64le(n: number): Buffer { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; }
function marketPda(pid: PublicKey, fid: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("market"), i64le(fid), Buffer.from([LINE_CLOSE_MARKET_ID])], pid)[0];
}
function vaultPda(pid: PublicKey, m: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), m.toBuffer()], pid)[0];
}
function positionPda(pid: PublicKey, m: PublicKey, b: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer(), b.toBuffer()], pid)[0];
}

const flagIdx = (n: string) => process.argv.indexOf(`--${n}`);
const DRY = flagIdx("dry-run") >= 0;
const ONLY_FIXTURE = flagIdx("fixture") >= 0 ? Number(process.argv[flagIdx("fixture") + 1]) : null;

async function main() {
  const ctx = createContext();
  const auth = await authenticateCached(ctx);
  const program = loadProofbetProgram(ctx.provider);
  const pid = program.programId;
  const me = ctx.wallet.publicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = program.account as any;
  const now = Date.now();

  // The fixtures snapshot defaults to today-onward, so a finished match drops
  // out at the UTC day boundary — leaving its still-open line market invisible
  // to SETTLE/SWEEP forever. Fetch from the epoch day that covers the full
  // settle lookback instead (e2e finding, 2026-07-03).
  const fixtures = (await getFixtures(ctx, auth, {
    startEpochDay: Math.floor((now - SETTLE_LOOKBACK_MS) / 86_400_000),
  })).filter((f) => (ONLY_FIXTURE == null ? true : f.FixtureId === ONLY_FIXTURE));

  // ── ENSURE ──────────────────────────────────────────────────────────────────
  const upcoming = fixtures.filter(
    (f) => f.StartTime > now + MIN_LEAD_MS && f.StartTime <= now + HORIZON_MS,
  );
  console.log(`# ensure: ${upcoming.length} fixture(s) in window`);
  for (const f of upcoming) {
    try {
      const market = marketPda(pid, f.FixtureId);
      if ((await acct.market.fetchNullable(market)) !== null) {
        console.log(`  = ${label(f)} — market exists`); continue;
      }
      const snap = await fetchOddsSnapshot(ctx, auth, f.FixtureId);
      const open = pickOpen(snap, now, OPEN_FRESH_MIN);
      if (!open) { console.log(`  · ${label(f)} — no fresh 1X2 line, skipping`); continue; }
      const favName = open.favSide === 1 ? f.Participant1 : f.Participant2;
      console.log(`  + ${label(f)} — open ${fmt(open.openMilli)} on ${favName}${DRY ? " (dry-run)" : ""}`);
      if (DRY) continue;
      await program.methods
        .initializeMarket(new BN(f.FixtureId), LINE_CLOSE_MARKET_ID,
          lineInitArgs(open.openMilli, open.favSide, me, Math.floor(f.StartTime / 1000)))
        .accountsStrict({ creator: me, market, vault: vaultPda(pid, market), systemProgram: SystemProgram.programId })
        .rpc();
    } catch (e) {
      console.log(`  ! ${label(f)} — ensure failed (retry next tick): ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // ── SEED / SETTLE / SWEEP over every candidate fixture ──────────────────────
  const candidates = fixtures.filter(
    (f) => f.StartTime > now - SETTLE_LOOKBACK_MS && f.StartTime <= now + HORIZON_MS,
  );
  for (const f of candidates) {
    try {
      const market = marketPda(pid, f.FixtureId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m: any = await acct.market.fetchNullable(market);
      if (m === null) continue;
      const vault = vaultPda(pid, market);
      const position = positionPda(pid, market, me);
      const open = m.status.open !== undefined;
      const totals: bigint[] = m.bucketTotals.slice(0, 2).map((b: any) => BigInt(b.toString()));

      // SEED — both totals exactly zero, still open, before KO.
      if (open && totals[0] === 0n && totals[1] === 0n && now < f.StartTime) {
        const bal = await ctx.connection.getBalance(me);
        if (bal < SEED_LAMPORTS * 2 + 0.01 * SOL) {
          console.log(`  ! ${label(f)} — keeper balance ${(bal / SOL).toFixed(3)}◎ too low to seed, SKIPPING`);
        } else {
          console.log(`  ⬒ ${label(f)} — seeding ${(SEED_LAMPORTS / SOL)}◎ per side${DRY ? " (dry-run)" : ""}`);
          if (!DRY) {
            await program.methods.placeBet(0, new BN(SEED_LAMPORTS))
              .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
            await program.methods.placeBet(1, new BN(SEED_LAMPORTS))
              .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
          }
        }
      } else if (open && (totals[0] === 0n) !== (totals[1] === 0n) && now < f.StartTime) {
        console.log(`  ! ${label(f)} — ONE-SIDED seed detected (bucket ${totals[0] === 0n ? 1 : 0} only) — crash recovery needed, top up manually`);
      }

      // SETTLE — still open, past KO + buffer.
      if (open && now >= f.StartTime + SETTLE_BUFFER_MS) {
        const updates = await fetchOddsUpdates(ctx, auth, f.FixtureId);
        const res = resolveLine(updates, {
          kickoffMs: f.StartTime,
          openMilli: m.threshold as number,
          favSide: (m.statKey as number) === 2 ? 2 : 1,
          staleMaxMin: STALE_MAX_MIN,
        });
        if (res.action === "settle") {
          console.log(`  ✓ ${label(f)} — close ${fmt(res.closeMilli)} vs open ${fmt(m.threshold)} → ` +
            `${res.winningBucket === 0 ? "ABOVE" : "BELOW"} wins${DRY ? " (dry-run)" : ""}`);
          if (!DRY) {
            await program.methods
              .settle(res.winningBucket, 0, new BN(Math.floor(res.closeTsMs / 1000)), res.closeMilli)
              .accountsStrict({ settleAuthority: me, market, vault, feeRecipient: m.feeRecipient }).rpc();
          }
        } else {
          console.log(`  ∅ ${label(f)} — VOID (${res.reason})${DRY ? " (dry-run)" : ""}`);
          if (!DRY) {
            await program.methods.voidMarket(0, new BN(Math.floor(now / 1000)))
              .accountsStrict({ settleAuthority: me, market }).rpc();
          }
        }
      }

      // SWEEP — terminal market, keeper still holds a position → claim seed share.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fresh: any = DRY ? m : await acct.market.fetch(market);
      const terminal = fresh.status.settled !== undefined || fresh.status.voided !== undefined;
      if (terminal && (await acct.position.fetchNullable(position)) !== null) {
        console.log(`  $ ${label(f)} — claiming keeper seed share${DRY ? " (dry-run)" : ""}`);
        if (!DRY) {
          try {
            await program.methods.claim()
              .accountsStrict({ bettor: me, market, vault, position, systemProgram: SystemProgram.programId }).rpc();
          } catch (e) {
            console.log(`    claim failed (retry next pass): ${(e as Error).message.split("\n")[0]}`);
          }
        }
      }
    } catch (e) {
      console.log(`  ! ${label(f)} — pass failed (retry next tick): ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

const label = (f: Fixture) =>
  `${f.FixtureId} ${f.Participant1} v ${f.Participant2} (KO ${new Date(f.StartTime).toISOString().slice(5, 16)}Z)`;
const fmt = (milli: number) => `${(milli / 1000).toFixed(1)}%`;

const isMain = process.argv[1]?.endsWith("lines.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
