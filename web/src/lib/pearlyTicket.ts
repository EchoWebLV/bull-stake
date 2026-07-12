/* ──────────────────────────────────────────────────────────────────────────
 * Share-ticket model — PURE (node-testable). Everything the canvas renderer
 * (lib/ticketCanvas.ts) draws, derived from the existing PearlyCardVM. No DOM,
 * no Date.now() — callers thread `nowMs` in, same idiom as pearlyCard.ts.
 *
 * Copy rules (spec 2026-07-12, "multiplier framing"): user-facing strings say
 * ×N / "if perfect" — never the internal accounting vocabulary. The test file
 * asserts the banned words never appear in a built model.
 * ────────────────────────────────────────────────────────────────────────── */
import type { PearlyCardVM } from "./pearlyCard.ts";
import { CHAOS_MARKET_ID } from "./pearlyCard.ts";
import { mascotColorFor, type MascotColor } from "../components/Mascot.tsx";

export type TicketTone = "riding" | "busted" | "perfect" | "rolled";
export interface TicketRow { market: string; pick: string; chaos: boolean; carried: boolean }
export interface TicketModel {
  brand: string; subtitle: string; matchLine: string;
  tone: TicketTone; toneLine: string;
  rows: TicketRow[];
  multiplierLabel: string; moneyLine: string; footer: string;
  mascotColor: MascotColor; fileName: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** UTC date label ("Jul 14 2026") — UTC on purpose: deterministic in tests and
 *  matches the card's own UTC day boundary (cards compose at 08:00 UTC). */
function utcDateLabel(nowMs: number): string {
  const d = new Date(nowMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

const TONE_LINE: Record<TicketTone, (mult: string) => string> = {
  riding: (m) => `RIDING · ${m} IF PERFECT`,
  busted: () => "BUSTED — THE POT ROLLS ON",
  perfect: (m) => `PERFECT CARD ✓ · ${m} SHARE`,
  rolled: () => "NOBODY SWEPT IT — POT ROLLED",
};

/**
 * Build the ticket for the wallet's HELD card, or null when there's nothing
 * shareable: no card today, wallet not entered, mid-pick, or a myCard whose
 * picks/multiplier haven't resolved. Rows keep ALL picked legs (a dead card
 * still shows what you called) with `carried` distinguishing late-entry legs
 * the card never rode — the renderer fades those instead of hiding them.
 */
export function buildTicketModel(
  vm: PearlyCardVM,
  opts: { nowMs: number; wallet?: string | null },
): TicketModel | null {
  if (vm.empty || vm.contestId == null) return null;
  const tone: TicketTone | null =
    vm.myCardState === "entered-alive" ? "riding"
    : vm.myCardState === "dead" ? "busted"
    : vm.myCardState === "settled-won" ? "perfect"
    : vm.myCardState === "settled-rollover" ? "rolled"
    : null;
  if (!tone) return null;
  const mult = vm.myWeightLabel;
  if (!mult) return null;

  const rows: TicketRow[] = vm.legs
    .filter((l) => l.myPick != null)
    .map((l) => ({
      market: l.marketLabel,
      pick: l.options.find((o) => o.bucket === l.myPick)?.label ?? "—",
      chaos: l.marketId === CHAOS_MARKET_ID,
      carried: l.carried !== false,
    }));
  if (rows.length === 0) return null;

  const matches = [...new Set(vm.legs.map((l) => l.matchLabel))];
  return {
    brand: "BULL STAKE",
    subtitle: `THE DAILY SWEEP · CARD #${vm.contestId} · ${utcDateLabel(opts.nowMs)}`,
    matchLine: matches.length === 1 ? matches[0] : `${matches.length} matches · ${rows.length} legs`,
    tone,
    toneLine: TONE_LINE[tone](mult),
    rows,
    multiplierLabel: mult,
    moneyLine: `POT ${vm.potText} · JACKPOT ${vm.jackpotText} & ROLLING`,
    footer: "settles itself on-chain · TxLINE proofs",
    mascotColor: mascotColorFor(opts.wallet),
    fileName: `bull-stake-card-${vm.contestId}.png`,
  };
}

export type SharePath = "share" | "clipboard" | "download";
/** Best available delivery for the rendered PNG — native share sheet when the
 *  platform can share files (mobile), else clipboard (desktop), else download. */
export function pickSharePath(caps: { canShareFiles: boolean; hasClipboardItem: boolean }): SharePath {
  if (caps.canShareFiles) return "share";
  if (caps.hasClipboardItem) return "clipboard";
  return "download";
}
