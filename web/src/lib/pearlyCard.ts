/* ──────────────────────────────────────────────────────────────────────────
 * Streak — The Daily Pearly: pure view-model mapper.
 *
 * Mirrors the repo's established pattern (see lib/cardLegs.ts, lib/liveStatus.ts,
 * lib/lines.ts): pure functions of (server payload, wallet state, now) → a
 * render-ready view model. No RNG, no fabricated values, no side effects — every
 * exported function here is independently unit-tested in test/pearlyCard.test.ts.
 *
 * Pearly is the all-day 6-leg card (spec: docs/superpowers/specs/
 * 2026-07-03-streak-hackathon-live-pearly-design.md §1, §3). Distinct from the
 * hidden single-match Parlay (SweepstakeView.tsx) in one crucial way: entries
 * stay open ALL DAY while ≥3 legs remain unlocked, and each leg locks at its OWN
 * kickoff (`leg.lockTs`) rather than the whole card locking at once. Payout
 * weight = 2^(legs carried at entry time) — a full 6-leg card is ×64, a late
 * 3-leg entry is ×8. No buy-backs: once a CARRIED leg kicks off, the on-chain
 * program rejects further edits with CardLocked (contest_state.rs).
 *
 * RESILIENCE CONTRACT (per the build task): the v2 fields this mapper reads —
 * `CardLeg.lockTs`, `Card.entriesCloseTs`, `Card.aliveCount`, `Card.myCard` —
 * are all OPTIONAL on the wire until the engine restarts onto the Pearly build
 * (engine/src/routes.ts, confirmed against engine/test/routes.test.ts). Every
 * function here treats their absence as "the v1 engine is still running" and
 * degrades to a legible legacy/loading state — it NEVER throws and NEVER prints
 * a fabricated number (a missing aliveCount reads "—", never "0", since "0"
 * would misread as "everyone's card just died").
 * ──────────────────────────────────────────────────────────────────────── */

import type { Card, CardLeg, MyCard } from "./api.ts";

const SOL = "◎";
const LAMPORTS = 1_000_000_000;

// ── bucket labels (per-market-type; mirrors the convention in
//    SweepstakeView.tsx's pickLabel/pickTint, extended for the Yes/No chaos leg) ──

/** Market 17 is the day's one chaos leg ("Red Card Shown Y/N") — bucket 0 = Yes,
 *  1 = No, per engine/src/markets.ts RED_CARD_DEF. Every other 2-bucket market
 *  (goals/corners/cards O/U) reads Over/Under; every 3-bucket market reads
 *  home team / Draw / away team. */
const CHAOS_MARKET_ID = 17;

/** Label for one bucket of a leg's pick options, sensitive to the leg's market
 *  shape: 3-way Result → team names + Draw; the chaos Y/N leg → Yes/No; every
 *  other 2-way market → Over/Under. */
export function bucketLabel(leg: CardLeg, bucket: number): string {
  if (leg.buckets === 3) return bucket === 0 ? leg.home : bucket === 1 ? "Draw" : leg.away;
  if (leg.marketId === CHAOS_MARKET_ID) return bucket === 0 ? "Yes" : "No";
  return bucket === 0 ? "Over" : "Under";
}

// ── per-leg state (open / locked / live / won / lost / voided) ─────────────

export type PearlyLegState = "open" | "locked" | "live" | "won" | "lost" | "voided";

/**
 * A leg's current state, derived (never stored): `voided` overrides everything
 * (the whole card voids together — §3, no per-leg void this cycle); then a live
 * block with phase live/ht wins (the fixture is actually playing); FT resolves
 * to won/lost ONLY once `winningBucket` is known (settle can lag kickoff's FT
 * event by the keeper's settle-wave cadence — an unresolved FT reads as `live`,
 * never a silently-wrong `lost`); otherwise it's `locked` once past its own
 * `lockTs`, else `open`. Absent `lockTs` (v1 engine) is treated as still open —
 * the caller has no better signal, and false-open is safer than false-locked
 * (which would incorrectly greyed out a pickable leg).
 */
export function legState(
  leg: CardLeg,
  nowSec: number,
  pick?: number,
  cardVoided = false,
  winningBucket: number | null = null,
): PearlyLegState {
  if (cardVoided) return "voided";
  if (leg.live && (leg.live.phase === "live" || leg.live.phase === "ht")) return "live";
  if (leg.live?.phase === "ft") {
    if (winningBucket == null || pick == null) return "live"; // FT reached, settle hasn't landed yet
    return pick === winningBucket ? "won" : "lost";
  }
  const lockTs = leg.lockTs;
  if (lockTs != null && nowSec >= lockTs) return "locked";
  return "open";
}

// ── weight math (spec §3: weight = 2^(legs carried), min 3 open legs to enter) ──

/** 2^n, with n=0 → 1 (never zero — an entry always carries at least itself). */
export function weightForOpenCount(n: number): number {
  return 2 ** Math.max(0, n);
}

/** Weight preview for a NEW entry made right now: count legs whose OWN lockTs is
 *  still in the future (strictly — a leg locking exactly now is no longer
 *  pickable), capped implicitly at the leg count since every leg contributes at
 *  most one. A leg with no `lockTs` (v1 engine) counts as open — same fallback
 *  as `legState`. */
export function weightPreview(legs: CardLeg[], nowSec: number): number {
  const openCount = legs.filter((l) => l.lockTs == null || l.lockTs > nowSec).length;
  return weightForOpenCount(openCount);
}

/** The wallet's ACTUAL weight, straight from the engine's `myCard.weight`
 *  (mirrors the on-chain perfect_weight divisor) — never recomputed client-side,
 *  since only the chain (via entryTs vs each leg's lockTs at entry time) knows
 *  the true carried-leg count. `null` when there's no entry. */
export function myWeight(myCard: MyCard | null | undefined): number | null {
  return myCard ? myCard.weight : null;
}

// ── entries-open gate ────────────────────────────────────────────────────────

/**
 * True while a NEW entry is still accepted: the card must be `open` AND now
 * must be before `entriesCloseTs` (the KO that would leave only 2 legs open —
 * spec §3, "entry permitted iff ≥3 legs still open"). Falls back to the legacy
 * `card.lockTs` when `entriesCloseTs` is absent (v1 engine, which locked the
 * whole card at once). Deliberately NOT `card.lockTs` on a v2 response — v2
 * repurposes `lockTs` as just the first leg's own kickoff, so reusing it here
 * (as e.g. SweepstakeView's single-match `locked` check does) would close
 * entries hours too early.
 */
export function entriesOpen(card: Card, nowSec: number): boolean {
  if (card.status !== "open") return false;
  const closeTs = card.entriesCloseTs ?? card.lockTs;
  return nowSec < closeTs;
}

// ── countdown + money text ───────────────────────────────────────────────────

/** Coarse countdown to a future seconds timestamp: "1d 2h" / "4h 12m" / "12m" /
 *  "now" once passed. Mirrors SweepstakeView.tsx's `countdown` (kept local so
 *  this module has no import-time dependency on the Parlay component). */
export function countdownText(targetSec: number, nowSec: number): string {
  const secs = targetSec - nowSec;
  if (secs <= 0) return "now";
  const mins = Math.floor(secs / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "now";
}

/** Pot + jackpot combined, in trimmed SOL with the ◎ glyph (e.g. "◎5.2", "◎0"). */
export function potSolText(potLamports: string, jackpotLamports: string): string {
  const sol = (Number(potLamports) + Number(jackpotLamports)) / LAMPORTS;
  if (sol === 0) return `${SOL}0`;
  // Trim trailing zeros but keep it readable (mirrors lib/odds.ts fmtSol / lib/lines.ts solText).
  const text = sol >= 1 ? sol.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : sol.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return SOL + text;
}

// ── my-card state machine ───────────────────────────────────────────────────

export type MyCardState =
  | "not-entered" | "picking" | "entered-alive" | "dead"
  | "settled-won" | "settled-rollover";

/**
 * The wallet's card lifecycle state. `picking` is a UI-local state (mid-pick,
 * before the on-chain enter tx lands) that this pure function never returns on
 * its own — the component owns that transient flag; this only distinguishes the
 * server-confirmed states.
 *   - card not open (settled/rolledOver/voided) → settled-won (myCard survived,
 *     i.e. perfect) or settled-rollover (myCard dead/absent, i.e. no card of
 *     this wallet's is claimable) or not-entered (this wallet never had a card
 *     on THIS contest — nothing to show as "your result").
 *   - card open → not-entered (no myCard) / entered-alive / dead.
 */
export function myCardState(card: Card, myCard: MyCard | null | undefined, _nowSec: number): MyCardState {
  const settled = card.status === "settled" || card.status === "rolledOver" || card.status === "voided";
  if (settled) {
    if (myCard === null || myCard === undefined) return "not-entered";
    return myCard.alive ? "settled-won" : "settled-rollover";
  }
  if (!myCard) return "not-entered";
  return myCard.alive ? "entered-alive" : "dead";
}

/**
 * Cross-check: does this wallet provably hold a card on the current contest?
 * True when the nonce-0 entry fetched straight from the chain exists, or any
 * confirmed poll ever reported a myCard. The chain entry is authoritative over
 * a single engine scan (which can blip to confirmed-empty): while this is true
 * the picker — and therefore buildEnterTx — must be unreachable, because Enter
 * with an existing entry takes the on-chain EDIT branch, which reverts
 * CardLocked (6052) once a carried leg has kicked off.
 */
export function walletHoldsCard(chainEntry: unknown, lastKnownMyCard: unknown): boolean {
  return chainEntry != null || lastKnownMyCard != null;
}

// ── the full view model ──────────────────────────────────────────────────────

/** One leg as the UI needs it: display strings + interaction flags, never raw
 *  server shapes past this boundary. */
export interface PearlyLegVM {
  fixtureId: number;
  matchLabel: string;       // "Brazil v Spain" or "Brazil" when away is unknown
  marketLabel: string;      // catalog label, e.g. "Total Goals O/U 2.5"
  kickoffText: string;      // local HH:MM, or "" when unknown
  state: PearlyLegState;
  /** Picker only: can this leg still be tapped for a NEW entry? */
  pickable: boolean;
  buckets: number;
  options: { bucket: number; label: string }[];
  /** Plain bucket labels indexed by bucket number (`options[b].label`) — the
   *  snapshot-friendly shape lib/pearlyAlerts.ts reads to name the wallet's pick. */
  bucketNames?: string[];
  /** The wallet's pick on this leg, when they have an entry (undefined otherwise). */
  myPick?: number;
  /** True iff this leg is inside the wallet's CARRIED mask (activeMask[i]). */
  carried?: boolean;
  liveScoreText?: string;   // "2–1", present once the fixture has kicked off
  livePhaseText?: string;   // "62'" / "HT" / "FT"
}

export interface PearlyCardVM {
  empty: boolean;           // no card composed today (Card was null)
  /** True when the response is missing every v2 field — render the old/legacy
   *  layout rather than a broken picker (old engine at localhost until an ops
   *  restart — see the build task's resilience contract). */
  legacyEngine: boolean;
  contestId?: number;
  status?: Card["status"];
  legs: PearlyLegVM[];
  entriesOpen: boolean;
  entriesCloseText: string;      // countdown to entries close, or "" when settled/empty
  nextLockText: string;          // countdown to the NEXT open leg's own kickoff
  weightPreviewLabel: string;    // "×64" — what a NEW entry would carry right now
  myCardState: MyCardState;
  /** False when `myCardState` was computed from an UNKNOWN myCard (engine key
   *  omitted — a degraded scan or a v1 engine). The component MUST NOT treat
   *  `myCardState` as authoritative when this is false: hold the last known
   *  state (if any) or show a loading/retry affordance — never "not-entered". */
  myCardKnown: boolean;
  myWeightLabel: string | null;  // "×64" from myCard.weight, null if no entry
  aliveText: string;             // aliveCount, or "—" when unknown/degraded (never "0" fabricated)
  /** True when THIS poll's reads were degraded (routes.ts: entry scan and/or
   *  leg-market reads failed). `aliveText` is already "—" in that case; when
   *  `myCardState` reflects an entered card, its `alive`/dead claim was computed
   *  optimistically (only against leg outcomes that DID read) — the component
   *  should visually soften it (e.g. a "provisional" tag) rather than presenting
   *  it with full confidence. */
  degraded: boolean;
  potText: string;               // "◎107.1" (pot + jackpot)
  jackpotText: string;           // "◎5.2" — the rolled-over jackpot portion alone ("◎0" when none)
  potRolledText: string | null;  // "includes ◎5.2 rolled over" when jackpot > 0
  canEdit: boolean;               // edit affordance: only pre-any-carried-leg-kickoff
  canReEnter: boolean;             // ALWAYS false — no buy-backs, kept explicit for the component
  rollover: boolean;               // settled + not perfect (or contest-wide zero-perfect)
  perfectShareLamports?: string;   // settled-won only: this wallet's estimated claim, if computable
}

/** Local team/leg formatting helpers (kept file-local; mirror SweepstakeView's
 *  fmtKick but seconds→local-time only, no external deps). */
function fmtKick(tsSec: number | null | undefined): string {
  if (tsSec == null) return "";
  try {
    return new Date(tsSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function matchLabel(leg: CardLeg): string {
  return leg.away ? `${leg.home} v ${leg.away}` : leg.home;
}

function legOptions(leg: CardLeg): { bucket: number; label: string }[] {
  const n = leg.buckets === 3 ? 3 : 2;
  return Array.from({ length: n }, (_, b) => ({ bucket: b, label: bucketLabel(leg, b) }));
}

const EMPTY_VM: PearlyCardVM = {
  empty: true, legacyEngine: false, legs: [], entriesOpen: false,
  entriesCloseText: "", nextLockText: "", weightPreviewLabel: "×1",
  myCardState: "not-entered", myCardKnown: true, myWeightLabel: null, aliveText: "—", degraded: false,
  potText: `${SOL}0`, jackpotText: `${SOL}0`, potRolledText: null, canEdit: false, canReEnter: false, rollover: false,
};

/**
 * Map the engine's `/api/card` response (+ this wallet's `myCard`, if fetched)
 * into everything `PearlyView.tsx` renders.
 *
 * `myCardArg` lets a caller pass an already-resolved value (e.g. re-fetched
 * separately) that overrides `card.myCard`; pass `card?.myCard` (or omit the
 * arg by passing `undefined`) to just use whatever the card response itself
 * carries. See `PearlyCardVM.myCardKnown`'s doc comment for the full
 * three-state contract this resolves (`MyCard` object / confirmed-null /
 * unknown-key-omitted) — the short version: only trust `vm.myCardState` when
 * `vm.myCardKnown` is true.
 *
 * `winningBuckets` (optional, indexed like `card.legs`): `/api/card`'s own leg
 * DTOs never carry a per-leg winning bucket (that only lives on the engine's
 * INTERNAL settle-tracking, not the wire shape — see routes.ts's
 * `readLegWinningBuckets`). Getting a definitive won/lost per row requires the
 * SAME join `SweepstakeView.tsx` already does against `/api/contest/live`'s
 * `ParlayLeg[].winningBucket` (matched by `contestId`, indexed like `card.legs`
 * since a card IS a contest). Omit it (or pass all-null) when that fetch hasn't
 * landed yet or failed — legs at full-time then read `live` (not a fabricated
 * `lost`) until the real bucket is known, per `legState`'s own contract.
 */
export function mapPearlyCard(
  card: Card | null,
  myCardArg: MyCard | null | undefined,
  nowMs: number,
  winningBuckets?: (number | null)[],
): PearlyCardVM {
  if (!card) return EMPTY_VM;

  const nowSec = Math.floor(nowMs / 1000);
  // Three-state resolution (engine commit 3246a98 — routes.ts's /api/card doc
  // comment). `"myCard" in card` is the ONLY reliable way to tell "the engine
  // omitted the key — UNKNOWN, e.g. a degraded scan or a v1 engine" apart from
  // "the engine sent the key as an explicit null — CONFIRMED no entry": once a
  // value has been read off `card.myCard` (or passed through `myCardArg`, which
  // in practice is just `card?.myCard` forwarded — see PearlyView.tsx), a plain
  // `undefined` no longer carries that distinction on its own. `myCardArg` is
  // still honored as an override VALUE (e.g. a caller re-fetched just the entry
  // and wants to feed a fresher object in) whenever it's an actual object or an
  // explicit `null`; passing `undefined` always defers to `card`'s own key.
  const myCard = myCardArg !== undefined ? myCardArg : (card.myCard ?? null);
  const myCardKnown = "myCard" in card || myCardArg !== undefined;
  const legacyEngine = card.entriesCloseTs === undefined && card.aliveCount === undefined
    && !("myCard" in card) && card.legs.every((l) => l.lockTs === undefined);

  const cardVoided = card.status === "voided";
  const state = myCardState(card, myCard, nowSec);
  const settled = card.status === "settled" || card.status === "rolledOver" || card.status === "voided";
  const open = entriesOpen(card, nowSec);

  const legs: PearlyLegVM[] = card.legs.map((leg, i) => {
    const pick = myCard?.picks[i];
    const wb = winningBuckets?.[i] ?? null;
    const lState = legState(leg, nowSec, pick, cardVoided, wb);
    const pickable = !myCard && open && (leg.lockTs == null || leg.lockTs > nowSec);
    const options = legOptions(leg);
    return {
      fixtureId: leg.fixtureId,
      matchLabel: matchLabel(leg),
      marketLabel: leg.label || (leg.buckets === 3 ? "Result" : "O/U"),
      kickoffText: fmtKick(leg.lockTs ?? leg.kickoffTs),
      state: lState,
      pickable,
      buckets: leg.buckets,
      options,
      bucketNames: options.map((o) => o.label),
      ...(pick != null ? { myPick: pick } : {}),
      ...(myCard ? { carried: myCard.activeMask[i] === true } : {}),
      ...(leg.live ? {
        liveScoreText: `${leg.live.home}–${leg.live.away}`,
        livePhaseText: leg.live.phase === "ht" ? "HT" : leg.live.phase === "ft" ? "FT"
          : leg.live.phase === "live" ? (leg.live.minute != null ? `${leg.live.minute}'` : "live") : "",
      } : {}),
    };
  });

  const closeTs = card.entriesCloseTs ?? card.lockTs;
  const nextOpenLeg = card.legs
    .filter((l) => l.lockTs != null && l.lockTs > nowSec)
    .sort((a, b) => a.lockTs! - b.lockTs!)[0];

  // Edit affordance: only while every CARRIED leg is still open (activeMask[i]
  // true AND that leg's own lockTs hasn't passed) — otherwise the chain would
  // reject the edit with CardLocked, so the affordance must not even render.
  const canEdit = !!myCard && open && myCard.activeMask.every((active, i) => {
    if (!active) return true; // outside the card — irrelevant to lock-state
    const lockTs = card.legs[i]?.lockTs;
    return lockTs == null || lockTs > nowSec;
  });

  const jackpotNum = Number(card.jackpot);
  // Specifically "your card survived to settle but wasn't perfect" — NOT the
  // broader "settled and not won" (that would wrongly flag a wallet with no
  // entry at all as having "rolled over").
  const rollover = state === "settled-rollover";

  return {
    empty: false,
    legacyEngine,
    contestId: card.contestId,
    status: card.status,
    legs,
    entriesOpen: open,
    entriesCloseText: settled ? "" : countdownText(closeTs, nowSec),
    nextLockText: nextOpenLeg?.lockTs != null ? countdownText(nextOpenLeg.lockTs, nowSec) : "",
    weightPreviewLabel: `×${weightPreview(card.legs, nowSec)}`,
    myCardState: state,
    myCardKnown,
    myWeightLabel: myCard ? `×${myWeight(myCard)}` : null,
    // card.aliveCount is `number | null | undefined` — null (explicit "couldn't
    // compute this poll") and undefined (v1 engine, key never existed) both read
    // the same "—" to the user; only a real number is ever printed.
    aliveText: card.aliveCount == null ? "—" : String(card.aliveCount),
    degraded: card.degraded === true,
    potText: potSolText(card.pot, card.jackpot),
    jackpotText: potSolText(card.jackpot, "0"),
    potRolledText: jackpotNum > 0 ? `includes ${potSolText(card.jackpot, "0")} rolled over` : null,
    canEdit,
    canReEnter: false,
    rollover,
  };
}
