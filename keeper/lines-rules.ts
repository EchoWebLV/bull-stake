// keeper/lines-rules.ts
/**
 * Beat the Market — pure open/close/resolution rules (spec §2). No I/O.
 * Every branch is unit-tested; lines.ts (the CLI) is a thin shell around these.
 */
import {
  isLineRow, favouriteSide, pctMilliFor, latestLineRowAtOrBefore,
  type OddsRow,
} from "../spike/src/odds.js";

const MIN_MS = 60_000;

export interface OpenPick { openMilli: number; favSide: 1 | 2; rowTs: number }

/** The opening line from the latest FRESH line row (Ts within freshMaxMin of
 *  now). Nothing fresh → null: the caller skips the fixture and retries. */
export function pickOpen(rows: OddsRow[], nowMs: number, freshMaxMin: number): OpenPick | null {
  const r = latestLineRowAtOrBefore(rows.filter(isLineRow), nowMs);
  if (!r || r.Ts < nowMs - freshMaxMin * MIN_MS) return null;
  const favSide = favouriteSide(r);
  return { openMilli: pctMilliFor(r, favSide), favSide, rowTs: r.Ts };
}

export type LineResolution =
  | { action: "settle"; winningBucket: 0 | 1; closeMilli: number; closeTsMs: number }
  | { action: "void"; reason: "no-rows" | "stale" | "tie" };

/** Resolve a line market at/after kick-off from the fixture's odds history.
 *  close = the favourite's milli-pct in the latest line row with Ts <= KO.
 *  Older than staleMaxMin before KO → void. Equal to open → void. */
export function resolveLine(
  rows: OddsRow[],
  opts: { kickoffMs: number; openMilli: number; favSide: 1 | 2; staleMaxMin: number },
): LineResolution {
  const r = latestLineRowAtOrBefore(rows, opts.kickoffMs);
  if (!r) return { action: "void", reason: "no-rows" };
  if (r.Ts < opts.kickoffMs - opts.staleMaxMin * MIN_MS) return { action: "void", reason: "stale" };
  const closeMilli = pctMilliFor(r, opts.favSide);
  if (closeMilli === opts.openMilli) return { action: "void", reason: "tie" };
  return {
    action: "settle",
    winningBucket: closeMilli > opts.openMilli ? 0 : 1,
    closeMilli,
    closeTsMs: r.Ts,
  };
}
