/**
 * Market catalog — fetch the upcoming World Cup slate and ensure each fixture
 * has its full set of on-chain markets (8 per fixture, idempotent).
 *
 * Key exports:
 *   inSlateWindow(startMs, nowMs, hoursAhead)  — pure predicate (unit-testable)
 *   fetchSlate(ctx, auth, opts)               — WC fixtures kicking off soon
 *   ensureMarkets(program, fixture, settleAuthority) — create missing markets
 */

import * as anchor from "@coral-xyz/anchor";
import anchorDefault from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Auth, SpikeContext } from "../../spike/src/auth.js";
import type { Fixture } from "../../spike/src/discover.js";
import { getFixtures } from "../../spike/src/discover.js";
import { MARKET_TEMPLATE, toInitArgs } from "./markets.ts";
import { deriveMarketPda, deriveVaultPda } from "./chain.ts";
import { COMPETITION_ALLOWLIST, PROGRAM_ID } from "./config.ts";

const BN = anchorDefault.BN;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SlateFixture {
  fixtureId: number;
  home: string;
  away: string;
  kickoffMs: number;
  competitionId: number;
}

export interface EnsureResult {
  created: number;
  existing: number;
}

// ── Pure helpers (unit-testable, no I/O) ─────────────────────────────────────

/**
 * Returns true when a fixture starting at `startMs` is inside the slate window:
 *   - kickoff is at most `hoursBehind` hours in the past (0 = upcoming-only)
 *   - kickoff is within `hoursAhead` hours in the future
 *
 * `hoursBehind > 0` keeps in-play and recently-finished matches in the slate so
 * the live board still shows a match you bet on after it kicks off (and a fresh
 * engine boot re-loads matches already under way). Market *creation* uses the
 * default (upcoming-only) — you can't open a bettable market after kickoff.
 */
export function inSlateWindow(
  startMs: number,
  nowMs: number,
  hoursAhead: number,
  hoursBehind = 0,
): boolean {
  return (
    startMs > nowMs - hoursBehind * 3_600_000 &&
    startMs <= nowMs + hoursAhead * 3_600_000
  );
}

// ── Network / chain functions ─────────────────────────────────────────────────

/**
 * Fetch the upcoming slate from TxLINE.
 *
 * Strategy: pull three consecutive epochDays (yesterday + today + tomorrow) to
 * get fixtures that straddle midnight UTC. Filter to the configured
 * COMPETITION_ALLOWLIST (default: World Cup only) and `inSlateWindow`
 * (now, now + hoursAhead hours).
 */
export async function fetchSlate(
  ctx: SpikeContext,
  auth: Auth,
  opts: { hoursAhead?: number; hoursBehind?: number } = {},
): Promise<SlateFixture[]> {
  const hoursAhead = opts.hoursAhead ?? 36;
  const hoursBehind = opts.hoursBehind ?? 0;
  const nowMs = Date.now();
  const todayEpochDay = Math.floor(nowMs / DAY_MS);

  // Fetch yesterday + today + tomorrow in parallel. Yesterday covers in-play /
  // recently-finished matches that kicked off late on the previous UTC day when
  // hoursBehind > 0; it's harmlessly filtered out when hoursBehind === 0.
  const [yesterday, today, tomorrow] = await Promise.all([
    getFixtures(ctx, auth, { startEpochDay: todayEpochDay - 1 }),
    getFixtures(ctx, auth, { startEpochDay: todayEpochDay }),
    getFixtures(ctx, auth, { startEpochDay: todayEpochDay + 1 }),
  ]);

  // Deduplicate by FixtureId (the pages may overlap).
  const seen = new Set<number>();
  const all: Fixture[] = [];
  for (const f of [...yesterday, ...today, ...tomorrow]) {
    if (!seen.has(f.FixtureId)) {
      seen.add(f.FixtureId);
      all.push(f);
    }
  }

  // Filter: allow-listed competitions + inside the slate window.
  return all
    .filter(
      (f) =>
        COMPETITION_ALLOWLIST.includes(f.Competition) &&
        inSlateWindow(f.StartTime, nowMs, hoursAhead, hoursBehind),
    )
    .map((f) => ({
      fixtureId: f.FixtureId,
      home: f.Participant1,
      away: f.Participant2,
      kickoffMs: f.StartTime,
      competitionId: f.CompetitionId,
    }));
}

/**
 * For a single fixture, derive each of the 8 market PDAs, check whether the
 * account already exists on-chain, and create any missing ones.
 *
 * The instruction signature mirrors create-market.ts exactly:
 *   initializeMarket(fixtureId: BN, marketId: number, args: {...})
 *     .accountsStrict({ creator, market, vault, systemProgram })
 */
export async function ensureMarkets(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: anchor.Program<any>,
  fixture: SlateFixture,
  settleAuthority: PublicKey,
): Promise<EnsureResult> {
  const creator = (program.provider as anchor.AnchorProvider).wallet.publicKey;
  const kickoffSec = Math.floor(fixture.kickoffMs / 1000);
  let created = 0;
  let existing = 0;

  for (const def of MARKET_TEMPLATE) {
    const market = deriveMarketPda(PROGRAM_ID, fixture.fixtureId, def.marketId);
    const vault = deriveVaultPda(PROGRAM_ID, market);

    // Treat the PDA as occupied if it already holds an account — including a
    // legacy pre-upgrade market whose old layout the current IDL can't decode
    // (fetchNullable throws ERR_OUT_OF_RANGE rather than returning it). Either
    // way the address is taken, so skip it.
    let occupied: boolean;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      occupied = (await (program.account as any).market.fetchNullable(market)) !== null;
    } catch {
      occupied = true;
    }
    if (occupied) {
      existing++;
      continue;
    }

    const args = toInitArgs(def, settleAuthority, kickoffSec);
    await program.methods
      .initializeMarket(new BN(fixture.fixtureId), def.marketId, args)
      .accountsStrict({
        creator,
        market,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    created++;
  }

  return { created, existing };
}
