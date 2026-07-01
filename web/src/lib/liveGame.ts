/* ──────────────────────────────────────────────────────────────────────────
 * Streak — Live match view-model mapper.
 *
 * REAL-MONEY: the on-chain LivePool is the sole authority. This module is a PURE
 * function layer — it maps a `LivePoolResponse` (fetched every 2s by useLivePool)
 * + this wallet's `LiveEntryView` into the immutable `GameSnapshot` the React view
 * renders. No RNG, no timing, no fabricated match events: where the chain/engine
 * gives us nothing (per-call history, shots/corners, team colors) we show "—" or
 * an honest empty — never an invented value.
 *
 * The old `Math.random()` `LiveGame` sim class is gone; `snapshotFromChain` is its
 * replacement and the seam the view reconciles to.
 * ──────────────────────────────────────────────────────────────────────── */

import {
  poolIsClaimable, isWinner,
  type LivePoolResponse, type LiveEntryView, type CallView,
} from "./api.ts";

export interface Team { code: string; name: string; color: string; }

/** A tap option on a call. `p` = base points for picking it correctly. */
export interface CallOption { k: string; t: string; c: string; oc: string; p: number; }

// ── View-model (what the React layer renders) ──────────────────────────────
export interface SnapOption extends CallOption { state: "" | "sel" | "correct" | "wrong"; }
export interface SnapCall {
  kind: string; q: string;
  phase: "answer" | "resolving" | "done";
  border: "" | "win" | "lose";
  timerText: string; barPct: number;
  opts: SnapOption[];
  verdict: { tone: "win" | "lose" | "skip"; text: string } | null;
}
export interface SnapStanding { rank: number; name: string; me: boolean; pts: number; lead: boolean; }
export interface FeedItem { min: number | ""; txt: string; big: boolean; }
export interface GameSnapshot {
  running: boolean;
  speed: number;
  pool: { pot: string; count: number; entry: string; rank: string };
  match: {
    home: Team; away: Team;
    scH: number; scA: number;
    clock: string; paused: boolean;
    shots: string; corners: string; cards: string; poss: string;
  };
  score: {
    pts: number; streak: number; bonus: number; callsUsed: number;
    flameHot: boolean; bonusZero: boolean;
    hist: ("hit" | "miss" | "skip")[];
    pointsSeq: number;
  };
  call: SnapCall | null;
  feed: FeedItem[];
  players: number;
  standings: SnapStanding[];
  over: null | { won: boolean; title: string; big: string; lines: string[] };
  toast: { text: string; seq: number };
}

// ── Constants ───────────────────────────────────────────────────────────────
export const ENTRY = 0.035, FIELD = 24;
export const POT = +(ENTRY * FIELD).toFixed(2); // 0.84 (cosmetic default only)

const LAMPORTS_PER_SOL = 1e9;
const HOME_COLOR = "#0b6bcb";
const AWAY_COLOR = "#c62b2b";
const NEUTRAL_COLOR = "#2b3340";
const YESNO_YES_COLOR = "#2f7d4f";

const SOL = "◎";
/** SOL float → "◎0.84" / "◎0.035" (trims trailing zeros under 1). */
export function solStr(n: number): string {
  return SOL + (n < 1 ? String(+n.toFixed(3)) : n.toFixed(2));
}

export const SCORING_HINT =
  "scorer 4 · goal 3 · booking 3 · corner 2 · nothing 1 · 3-in-a-row stacks +1/+2/+3… · " +
  "miss keeps base, loses the bonus · most points wins the pot (ties split)";

// ── CallKind → presentation (ordinals fixed by the on-chain u8) ─────────────
interface CallPresentation {
  kind: string; q: string;
  labels: string[]; colors: string[]; codes: string[];
}
/** Map a Call's kind + the match team names to the option labels/colors/codes.
 *  `basePoints` (per option) come from the CallView; `numOptions` slices it. */
function callPresentation(kind: number, home: string, away: string): CallPresentation {
  switch (kind) {
    case 0: // NextGoal
      return {
        kind: "⚡ Next goal", q: "Who scores next?",
        labels: [home, "No goal", away],
        colors: [HOME_COLOR, NEUTRAL_COLOR, AWAY_COLOR],
        codes: [code(home), "—", code(away)],
      };
    case 1: // GoalRush
      return {
        kind: "🔥 Goal rush", q: "A goal soon?",
        labels: ["Yes", "No"], colors: [YESNO_YES_COLOR, NEUTRAL_COLOR], codes: ["✓", "✕"],
      };
    case 2: // CornerSoon
      return {
        kind: "⛳ Corner watch", q: "A corner soon?",
        labels: ["Yes", "No"], colors: [YESNO_YES_COLOR, NEUTRAL_COLOR], codes: ["✓", "✕"],
      };
    case 3: // CardSoon
      return {
        kind: "🟨 Booking watch", q: "A booking soon?",
        labels: ["Yes", "No"], colors: [YESNO_YES_COLOR, NEUTRAL_COLOR], codes: ["✓", "✕"],
      };
    default:
      return {
        kind: "Call", q: "Make your call",
        labels: ["Yes", "No"], colors: [YESNO_YES_COLOR, NEUTRAL_COLOR], codes: ["✓", "✕"],
      };
  }
}

/** 3-letter uppercased team code, or "—" when the name is a placeholder. */
function code(name: string): string {
  if (!name || name === "—") return "—";
  return name.slice(0, 3).toUpperCase();
}

// ── Idle snapshot (no live pool right now) ──────────────────────────────────
function idleSnapshot(): GameSnapshot {
  const dash: Team = { code: "—", name: "—", color: NEUTRAL_COLOR };
  return {
    running: true,
    speed: 1,
    pool: { pot: solStr(0), count: 0, entry: solStr(0), rank: "#—" },
    match: {
      home: dash, away: { ...dash },
      scH: 0, scA: 0, clock: "—", paused: true,
      shots: "—", corners: "—", cards: "—", poss: "—",
    },
    score: {
      pts: 0, streak: 0, bonus: 0, callsUsed: 0,
      flameHot: false, bonusZero: true, hist: [], pointsSeq: 0,
    },
    call: null,
    feed: [],
    players: 0,
    standings: [],
    over: null,
    toast: { text: "", seq: 0 },
  };
}

// ── The mapper ───────────────────────────────────────────────────────────────
/**
 * Map the polled on-chain pool (+ this wallet's seat) into the render view-model.
 * Pure: same inputs → same output. `nowMs` only affects the call countdown so it
 * can animate between 2s polls.
 */
export function snapshotFromChain(
  data: LivePoolResponse | null | undefined,
  entry: LiveEntryView | null,
  wallet: string | null,
  nowMs: number,
): GameSnapshot {
  const pool = data?.pool ?? null;
  if (!pool) return idleSnapshot();

  const entryLamports = Number(pool.entryPrice);
  const settledDistributable = Number(pool.distributable);
  const potLamports =
    pool.status === "settled" && settledDistributable > 0
      ? settledDistributable
      : entryLamports * pool.playerCount;

  // Standings sorted by total desc (stable) — the single source for rank/board.
  const rawStandings = [...(data?.standings ?? [])].sort((a, b) => b.total - a.total);
  const myIdx = wallet ? rawStandings.findIndex((s) => s.player === wallet) : -1;
  const topTotal = rawStandings.length > 0 ? rawStandings[0].total : 0;

  const rank = myIdx >= 0 ? "#" + (myIdx + 1) : "#—";

  // ── match ────────────────────────────────────────────────────────────────
  const m = data?.match;
  const homeName = m?.home ?? "—";
  const awayName = m?.away ?? "—";
  const home: Team = { code: code(homeName), name: homeName, color: HOME_COLOR };
  const away: Team = { code: code(awayName), name: awayName, color: AWAY_COLOR };
  const live = m?.live;
  const clock =
    live?.phase === "ft" ? "FT"
      : live?.phase === "ht" ? "HT"
        : live?.minute != null ? `${live.minute}'` : "—";

  // ── score (this wallet's seat) ─────────────────────────────────────────────
  const pts = entry?.total ?? 0;
  const streak = entry?.streak ?? 0;
  const bonus = entry?.bonusPts ?? 0;
  const callsUsed = entry ? entry.picks.filter((p) => p != null).length : 0;

  // ── call (the open on-chain Call, if any) ──────────────────────────────────
  const call = buildCall(data?.openCall ?? null, entry, homeName, awayName, nowMs);

  // ── standings (top 6, always include your row) ────────────────────────────
  let show = rawStandings.slice(0, 6);
  if (myIdx >= 6) show = [...rawStandings.slice(0, 5), rawStandings[myIdx]];
  const standings: SnapStanding[] = show.map((s) => {
    const idx = rawStandings.indexOf(s);
    const me = s.player === wallet;
    return {
      rank: idx + 1,
      name: me ? "you" : s.player.slice(0, 4) + "…" + s.player.slice(-4),
      me,
      pts: s.total,
      lead: idx === 0 && s.total > 0,
    };
  });

  // ── over (terminal states only) ────────────────────────────────────────────
  let over: GameSnapshot["over"] = null;
  if (poolIsClaimable(pool)) {
    const won = entry ? isWinner(pool, entry) : false;
    if (won) {
      const share = pool.winnerCount > 0
        ? settledDistributable / pool.winnerCount / LAMPORTS_PER_SOL
        : 0;
      over = {
        won: true,
        title: "You won! 🏆",
        big: solStr(share),
        lines: [
          `Top score — ${pts} pts.`,
          `Payout from a ${solStr(entryLamports / LAMPORTS_PER_SOL)} entry.`,
        ],
      };
    } else if (pool.status === "voided") {
      const refund = Number(entry?.amount ?? 0) / LAMPORTS_PER_SOL;
      over = {
        won: false,
        title: "Refunded",
        big: solStr(refund),
        lines: ["Match voided — your entry was refunded."],
      };
    } else {
      over = {
        won: false,
        title: "Full time",
        big: `${pts} pts`,
        lines: [
          `Winning score was ${pool.winningScore} pts.`,
          "Better luck next match.",
        ],
      };
    }
  }

  return {
    running: !!live,
    speed: 1,
    pool: {
      pot: solStr(potLamports / LAMPORTS_PER_SOL),
      count: pool.playerCount,
      entry: solStr(entryLamports / LAMPORTS_PER_SOL),
      rank,
    },
    match: {
      home, away,
      scH: live?.home ?? 0, scA: live?.away ?? 0,
      clock, paused: !live,
      // NOT available from /api/live/pool — do not fabricate.
      shots: "—", corners: "—", cards: "—", poss: "—",
    },
    score: {
      pts, streak, bonus, callsUsed,
      flameHot: streak >= 3, bonusZero: bonus <= 0,
      hist: [], // per-call hit/miss history isn't cheaply available; empty is honest.
      pointsSeq: pts, // stable key: bumps when your total changes.
    },
    call,
    feed: [], // no on-chain event feed in Phase A.
    players: data?.standings?.length ?? 0,
    standings,
    over,
    toast: { text: "", seq: 0 }, // no toasts in Phase A.
  };
}

/** Map an open/resolved on-chain Call into the SnapCall render shape. */
function buildCall(
  openCall: CallView | null,
  entry: LiveEntryView | null,
  home: string,
  away: string,
  nowMs: number,
): SnapCall | null {
  if (!openCall) return null;
  const pres = callPresentation(openCall.kind, home, away);
  const n = Math.max(0, Math.min(openCall.numOptions, pres.labels.length));
  const resolved = openCall.state === "resolved";
  const answering = openCall.state === "open";
  const phase: SnapCall["phase"] = answering ? "answer" : "done";

  const myPick = entry?.picks[openCall.seq] ?? null; // 0xFF already mapped → null

  const opts: SnapOption[] = [];
  for (let i = 0; i < n; i++) {
    let state: SnapOption["state"] = "";
    if (myPick === i) {
      state = resolved ? (openCall.outcome === i ? "correct" : "wrong") : "sel";
    } else if (resolved && openCall.outcome === i) {
      state = "correct";
    }
    opts.push({
      k: String(i),
      t: pres.labels[i],
      c: pres.colors[i],
      oc: pres.codes[i],
      p: openCall.basePoints[i] ?? 0,
      state,
    });
  }

  // border: only when resolved AND you had a pick.
  let border: SnapCall["border"] = "";
  if (resolved && myPick != null) {
    border = openCall.outcome === myPick ? "win" : "lose";
  }

  // verdict: honest read of your pick vs the outcome.
  let verdict: SnapCall["verdict"] = null;
  if (resolved) {
    if (openCall.outcome === "void") {
      verdict = { tone: "skip", text: "void" };
    } else if (myPick != null) {
      verdict = openCall.outcome === myPick
        ? { tone: "win", text: "✓ correct" }
        : { tone: "lose", text: "✕ missed" };
    }
  }

  const remainingMs = (openCall.openedTs + openCall.answerSecs) * 1000 - nowMs;
  const timerText = answering ? `${Math.max(0, remainingMs / 1000).toFixed(1)}s` : "locked";
  const barPct = answering
    ? Math.max(0, Math.min(100, (remainingMs / (openCall.answerSecs * 1000)) * 100))
    : 0;

  return { kind: pres.kind, q: pres.q, phase, border, timerText, barPct, opts, verdict };
}
