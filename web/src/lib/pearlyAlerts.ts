/**
 * Pearly notifications v1 (spec §1): derive card alerts by DIFFING two
 * consecutive /api/card poll snapshots. Pure — no DOM, no fetch, node-env
 * tested. The component owns dedupe (Set of stable ids) and rendering; the
 * browser Notification side lives in notify.ts. A null prev (first poll,
 * tab remount) emits nothing so reloads never replay history.
 */
import type { PearlyCardVM, PearlyLegState } from "./pearlyCard.ts";

export type PearlyAlertKind = "leg-live" | "leg-hit" | "leg-died" | "one-away" | "settled" | "seeded";

export interface PearlyAlert {
  /** Deterministic (no timestamp) — same event → same id, for cross-remount dedupe. */
  id: string;
  kind: PearlyAlertKind;
  text: string;
}

interface LegSnap {
  key: string;          // fixtureId:marketLabel — stable within a contest
  matchLabel: string;
  marketLabel: string;
  pickText: string;     // "" when no pick (not entered)
  state: PearlyLegState;
  carried: boolean;
}

export interface AlertSnapshot {
  contestId: number;
  status: NonNullable<PearlyCardVM["status"]>;
  myCardState: PearlyCardVM["myCardState"];
  jackpotText: string;
  legs: LegSnap[];
}

export function snapshotForAlerts(vm: PearlyCardVM): AlertSnapshot | null {
  if (vm.empty || vm.legacyEngine || vm.contestId == null || !vm.status) return null;
  return {
    contestId: vm.contestId,
    status: vm.status,
    myCardState: vm.myCardState,
    jackpotText: vm.jackpotText ?? "",
    legs: vm.legs.map((l) => ({
      key: `${l.fixtureId}:${l.marketLabel}`,
      matchLabel: l.matchLabel,
      marketLabel: l.marketLabel,
      // legOptions guarantees options[b].bucket === b, so index straight in.
      pickText: l.myPick != null ? (l.options[l.myPick]?.label ?? "") : "",
      state: l.state,
      carried: l.carried === true,
    })),
  };
}

const TERMINAL: ReadonlySet<NonNullable<PearlyCardVM["status"]>> = new Set(["settled", "rolledOver", "voided"]);

export function diffCardAlerts(prev: AlertSnapshot | null, next: AlertSnapshot): PearlyAlert[] {
  if (!prev) return [];
  const out: PearlyAlert[] = [];

  // New contest: one seeded alert, nothing else (leg keys all changed anyway).
  if (prev.contestId !== next.contestId) {
    out.push({
      id: `${next.contestId}:seeded`,
      kind: "seeded",
      text: `Fresh card is live — jackpot in at ${next.jackpotText || "◎0"}`,
    });
    return out;
  }

  // Per-leg transitions — carried legs only (an uncarried leg can't touch this card).
  const prevByKey = new Map(prev.legs.map((l) => [l.key, l]));
  for (const leg of next.legs) {
    const was = prevByKey.get(leg.key);
    if (!was || !leg.carried || leg.state === was.state) continue;
    const pick = leg.pickText ? ` — ${leg.marketLabel}: ${leg.pickText}` : "";
    if (leg.state === "live") {
      // Kickoffs only: a won/lost→live flap (e.g. the winningBuckets join degrading
      // mid-poll) must not re-announce a match that already kicked off long ago.
      if (was.state === "open" || was.state === "locked") {
        out.push({ id: `${next.contestId}:leg-live:${leg.key}`, kind: "leg-live", text: `${leg.matchLabel} kicked off${pick} riding` });
      }
    } else if (leg.state === "won") {
      out.push({ id: `${next.contestId}:leg-hit:${leg.key}`, kind: "leg-hit", text: `✓ ${leg.matchLabel}${pick} HIT` });
    } else if (leg.state === "lost") {
      out.push({ id: `${next.contestId}:leg-died:${leg.key}`, kind: "leg-died", text: `✗ ${leg.matchLabel}${pick} missed · card busted` });
    }
  }

  // One away from perfect: every carried leg but one has landed, card still alive.
  const carried = next.legs.filter((l) => l.carried);
  const won = carried.filter((l) => l.state === "won").length;
  const prevCarried = prev.legs.filter((l) => l.carried);
  const prevWon = prevCarried.filter((l) => l.state === "won").length;
  if (
    next.myCardState === "entered-alive" && carried.length >= 2 &&
    won === carried.length - 1 && prevWon < won
  ) {
    out.push({ id: `${next.contestId}:one-away`, kind: "one-away", text: `One leg from a perfect card — hang on` });
  }

  // Contest settled while we watched. Branch on the card's terminal STATUS first
  // (rolledOver / voided / settled are contest-wide facts), and only then on
  // whether THIS wallet holds a claim: a dead watcher on a `settled` card must
  // never read rollover copy (perfect cards hit — the pot pays out), and a
  // voided card refunds (mirrors PearlyView's ∅ voided chip + the claim
  // surfaces' refund language) — it neither rolls nor pays.
  if (!TERMINAL.has(prev.status) && TERMINAL.has(next.status)) {
    const text = next.status === "rolledOver"
      ? `No perfect cards today — the pot rolls into tomorrow's jackpot`
      : next.status === "voided"
        ? `∅ Card voided — entries are refundable`
        : next.myCardState === "settled-won"
          ? `Perfect card! Your share is claimable`
          : `Settled — perfect cards took today's pot`;
    out.push({ id: `${next.contestId}:settled`, kind: "settled", text });
  }

  return out;
}
