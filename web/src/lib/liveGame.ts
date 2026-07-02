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
  type LivePoolResponse, type NextGameResponse, type LiveEntryView, type CallView, type CallKind,
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

// ── Pre-game countdown (the "next game" big timer) ──────────────────────────

/** ms-until → display countdown: "3d 04h" beyond a day, else "HH:MM:SS". Clamps at 0. */
export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  if (s >= 86_400) {
    const d = Math.floor(s / 86_400);
    const h = Math.floor((s % 86_400) / 3600);
    return `${d}d ${String(h).padStart(2, "0")}h`;
  }
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

/** The pre-kickoff view-model: the big timer + (once the pool exists) the join state. */
export interface PreGame {
  /** upcoming = fixture known, no pool yet (join not open); joinable = pool open, pre-lock. */
  phase: "upcoming" | "joinable";
  home: string; away: string;
  kickoffMs: number;
  /** Seconds — when the join window opens (null when the engine didn't say). */
  joinOpensTs: number | null;
  countdown: string; // formatted vs nowMs
  /** Joinable only (zero-ish for upcoming): the real pot so far. */
  pot: string; players: number; entry: string;
  joined: boolean;
}

/**
 * Map the featured game into a PRE-GAME state, or null when the existing in-play /
 * terminal / idle flow should render instead:
 *   - pool null + upcoming kickoff  → "upcoming" (big countdown, join not open yet)
 *   - pool open + now < lockTs      → "joinable" (countdown + pot + Join)
 *   - anything else                 → null (kicked off, terminal, or nothing at all)
 */
export function preGameFromChain(
  data: NextGameResponse | LivePoolResponse | null | undefined,
  entry: LiveEntryView | null,
  nowMs: number,
): PreGame | null {
  const kickoffMs = (data as NextGameResponse | null | undefined)?.kickoffMs ?? null;
  const joinOpensTs = (data as NextGameResponse | null | undefined)?.joinOpensTs ?? null;
  const pool = data?.pool ?? null;
  const m = data?.match ?? null;

  if (!pool) {
    // Countdown-only state: a known upcoming fixture with no pool yet.
    if (kickoffMs == null || !m || nowMs >= kickoffMs) return null;
    return {
      phase: "upcoming",
      home: m.home, away: m.away,
      kickoffMs, joinOpensTs,
      countdown: formatCountdown(kickoffMs - nowMs),
      pot: solStr(0), players: 0, entry: "",
      joined: false,
    };
  }

  if (pool.status === "open" && nowMs < pool.lockTs * 1000) {
    const kick = kickoffMs ?? pool.lockTs * 1000; // lock_ts == kickoff by construction
    const entryLamports = Number(pool.entryPrice);
    return {
      phase: "joinable",
      home: m?.home ?? "—", away: m?.away ?? "—",
      kickoffMs: kick, joinOpensTs,
      countdown: formatCountdown(kick - nowMs),
      pot: solStr((entryLamports * pool.playerCount) / LAMPORTS_PER_SOL),
      players: pool.playerCount,
      entry: solStr(entryLamports / LAMPORTS_PER_SOL),
      joined: !!entry,
    };
  }

  return null; // in-play / terminal → the existing snapshot flow renders
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
function callPresentation(kind: CallKind, home: string, away: string): CallPresentation {
  switch (kind) {
    case "nextGoal":
      return {
        kind: "⚡ Next goal", q: "Who scores next?",
        labels: [home, "No goal", away],
        colors: [HOME_COLOR, NEUTRAL_COLOR, AWAY_COLOR],
        codes: [code(home), "—", code(away)],
      };
    case "goalRush":
      return {
        kind: "🔥 Goal rush", q: "A goal soon?",
        labels: ["Yes", "No"], colors: [YESNO_YES_COLOR, NEUTRAL_COLOR], codes: ["✓", "✕"],
      };
    case "cornerSoon":
      return {
        kind: "⛳ Corner watch", q: "A corner soon?",
        labels: ["Yes", "No"], colors: [YESNO_YES_COLOR, NEUTRAL_COLOR], codes: ["✓", "✕"],
      };
    case "cardSoon":
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

/** How long after a call's answer window closes to keep flashing its verdict (ms).
 *  Spans the keeper's ~3s resolve buffer + a few seconds of display, then clears. */
const VERDICT_SHOW_MS = 10_000;

/** Should a just-resolved call's verdict still be shown? True from the moment its
 *  answer window closed until VERDICT_SHOW_MS later (the call only becomes
 *  `lastCall` after it resolves, so `nowMs` is already past the window end). */
function resolvedRecently(call: CallView, nowMs: number): boolean {
  const windowEndMs = (call.openedTs + call.answerSecs) * 1000;
  return nowMs >= windowEndMs && nowMs < windowEndMs + VERDICT_SHOW_MS;
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

  // ── call (the open Call, else a just-resolved one's verdict) ───────────────
  // #7: `openCall` only ever carries the OPEN call, so a resolved call's result is
  // never seen without `lastCall`. In the gap between calls (openCall null) surface
  // the just-resolved call so the player sees "✓ correct" / "✕ missed" / "void" —
  // gated on recency so a stale verdict clears to "waiting for the next call…".
  const openCall = data?.openCall ?? null;
  const lastCall = data?.lastCall ?? null;
  const callToShow = openCall ?? (lastCall && resolvedRecently(lastCall, nowMs) ? lastCall : null);
  const call = buildCall(callToShow, entry, homeName, awayName, nowMs);

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
  // ONLY a wallet that actually holds a seat gets a personal result card — a
  // logged-in non-entrant must never see an invented "you lost / 0 pts" over-card.
  let over: GameSnapshot["over"] = null;
  if (entry && poolIsClaimable(pool)) {
    const won = isWinner(pool, entry);
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
      const refund = Number(entry.amount) / LAMPORTS_PER_SOL;
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
  const isOpen = openCall.state === "open";
  const remainingMs = (openCall.openedTs + openCall.answerSecs) * 1000 - nowMs;
  // A call still OPEN on-chain but whose LOCAL countdown has expired is "resolving":
  // the tap window is CLOSED (no taps past 0s — taps are gated on the `answer` phase)
  // while we wait for the chain to post the outcome on a later 2s poll. This both
  // stops the "tappable at 0.0s" race (#6) and makes the resolving phase reachable
  // (#9) — the keeper's resolve buffer means the on-chain state lags the countdown.
  const answering = isOpen && remainingMs > 0;
  const phase: SnapCall["phase"] = answering ? "answer" : isOpen ? "resolving" : "done";

  const myPick = entry?.picks[openCall.seq] ?? null; // 0xFF already mapped → null
  const voided = openCall.outcome === "void"; // global void: a no-op, points refunded — NEVER a loss

  const opts: SnapOption[] = [];
  for (let i = 0; i < n; i++) {
    let state: SnapOption["state"] = "";
    if (myPick === i) {
      // On a void, show the pick neutrally ("sel") — never "wrong".
      state = (!resolved || voided) ? "sel" : (openCall.outcome === i ? "correct" : "wrong");
    } else if (resolved && !voided && openCall.outcome === i) {
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

  // border: only when resolved to a REAL outcome (never on a void) AND you had a pick.
  let border: SnapCall["border"] = "";
  if (resolved && !voided && myPick != null) {
    border = openCall.outcome === myPick ? "win" : "lose";
  }

  // verdict: honest read of your pick vs the outcome. A void is a state="voided"
  // call (NOT state="resolved"), so gate it on `voided` independently — otherwise
  // the void verdict is unreachable and a resolved call's win/miss shows correctly.
  let verdict: SnapCall["verdict"] = null;
  if (voided) {
    verdict = { tone: "skip", text: "void" };
  } else if (resolved && myPick != null) {
    verdict = openCall.outcome === myPick
      ? { tone: "win", text: "✓ correct" }
      : { tone: "lose", text: "✕ missed" };
  }

  const timerText = answering
    ? `${Math.max(0, remainingMs / 1000).toFixed(1)}s`
    : phase === "resolving" ? "resolving…" : "locked";
  const barPct = answering
    ? Math.max(0, Math.min(100, (remainingMs / (openCall.answerSecs * 1000)) * 100))
    : 0;

  return { kind: pres.kind, q: pres.q, phase, border, timerText, barPct, opts, verdict };
}
