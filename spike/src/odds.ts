// spike/src/odds.ts
/**
 * TxLINE StablePrice odds client + pure line helpers (Beat the Market).
 *
 * Endpoints (probe-verified on devnet 2026-07-02):
 *   GET /api/odds/snapshot/{fixtureId} — latest row per (SuperOddsType, MarketPeriod, MarketParameters)
 *   GET /api/odds/updates/{fixtureId}  — full history (thousands of rows)
 *
 * THE line = the favourite's implied win probability from the full-game 1X2
 * consensus row: SuperOddsType 1X2_PARTICIPANT_RESULT, MarketPeriod null,
 * InRunning false, BookmakerId 10021 (TXLineStablePriceDemargined).
 * `Pct` is de-margined (["part1","draw","part2"], sums to ~100).
 */
import { txline } from "./util.js";
import type { Auth, SpikeContext } from "./auth.js";

export interface OddsRow {
  FixtureId: number;
  MessageId: string;
  Ts: number; // ms epoch
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState: string | null;
  InRunning: boolean;
  MarketParameters: string | null;
  MarketPeriod: string | null;
  PriceNames: string[];
  Prices: number[]; // milli-odds (1838 = 1.838)
  Pct?: string[];   // implied probabilities as strings
}

export const STABLEPRICE_BOOKMAKER_ID = 10021;

const auth = (a: Auth) => ({ jwt: a.jwt, apiToken: a.apiToken });

export async function fetchOddsSnapshot(
  ctx: SpikeContext, a: Auth, fixtureId: number,
): Promise<OddsRow[]> {
  const res = await txline<OddsRow[]>(`/api/odds/snapshot/${fixtureId}`, {
    baseUrl: ctx.baseUrl, ...auth(a),
  });
  return Array.isArray(res) ? res : [];
}

export async function fetchOddsUpdates(
  ctx: SpikeContext, a: Auth, fixtureId: number,
): Promise<OddsRow[]> {
  const res = await txline<OddsRow[]>(`/api/odds/updates/${fixtureId}`, {
    baseUrl: ctx.baseUrl, ...auth(a),
  });
  return Array.isArray(res) ? res : [];
}

/** Full-game, pre-match, StablePrice 1X2 with a 3-slot Pct — the ONLY row kind
 *  the line game reads. Everything else (halves, in-running, O/U) is ignored. */
export function isLineRow(r: OddsRow): boolean {
  return (
    r.SuperOddsType === "1X2_PARTICIPANT_RESULT" &&
    r.MarketPeriod == null &&
    r.InRunning === false &&
    r.BookmakerId === STABLEPRICE_BOOKMAKER_ID &&
    Array.isArray(r.Pct) && r.Pct.length === 3
  );
}

/** Favourite side from a line row: 1 = part1 (home), 2 = part2 (away). Tie → 1. */
export function favouriteSide(r: OddsRow): 1 | 2 {
  const p1 = parseFloat(r.Pct![0]);
  const p2 = parseFloat(r.Pct![2]);
  return p2 > p1 ? 2 : 1;
}

/** The given side's implied probability in milli-percent (54.407% → 54407). */
export function pctMilliFor(r: OddsRow, side: 1 | 2): number {
  return Math.round(parseFloat(r.Pct![side === 1 ? 0 : 2]) * 1000);
}

/** Latest line row with Ts <= cutoffMs, or null. */
export function latestLineRowAtOrBefore(rows: OddsRow[], cutoffMs: number): OddsRow | null {
  let best: OddsRow | null = null;
  for (const r of rows) {
    if (!isLineRow(r) || r.Ts > cutoffMs) continue;
    if (!best || r.Ts > best.Ts) best = r;
  }
  return best;
}
