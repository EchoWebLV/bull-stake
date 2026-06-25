/**
 * Phase 2 — find a live/finished World Cup fixture and pick a settle-able stat.
 *
 * IMPORTANT (confirmed against the live devnet API): score-event objects are
 * PascalCase (`FixtureId`, `Seq`, `GameState`, `StatusId`, `Stats`, `Score`) —
 * NOT the camelCase the OpenAPI spec described. Per-stat values live in a `Stats`
 * map keyed by the period-encoded stat key as a STRING (e.g. {"7":3,"8":2}).
 * Phase is read from `StatusId` (numeric, present on the snapshot endpoint);
 * `GameState` is a free-form string and the Fixture row has no phase at all.
 */

import type { Auth, SpikeContext } from "./auth.js";
import {
  FINISHED_PHASES,
  PERIOD,
  PHASE_NAME,
  SOCCER_STAT,
  VOID_PHASES,
  isVoid,
  statKey,
} from "./config.js";
import { txline, detail, info, warn } from "./util.js";

const NAME_TO_PHASE: Record<string, number> = Object.fromEntries(
  Object.entries(PHASE_NAME).map(([code, name]) => [name, Number(code)]),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface Fixture {
  FixtureId: number;
  Competition: string;
  CompetitionId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number; // unix (ms)
}

/** A score-update object (only the fields we use are typed). PascalCase on the wire. */
export interface ScoreEvent {
  FixtureId: number;
  Seq: number;
  GameState?: string;
  StatusId?: number | string | Record<string, unknown>;
  Action?: string;
  Ts?: number;
  Confirmed?: boolean;
  /** statKey (string) -> cumulative value at this event. */
  Stats?: Record<string, number>;
  [k: string]: unknown;
}

export interface StatPick {
  fixtureId: number;
  seq: number;
  statKey: number;
  statKey2?: number;
  phaseCode: number | null;
  phaseLabel: string;
  final: boolean;
  /** Value hints read straight from the event's Stats map (not authoritative). */
  hints: Record<string, number | undefined>;
}

const auth = (a: Auth) => ({ jwt: a.jwt, apiToken: a.apiToken });
const isConnNoise = (a?: string) => !!a && /disconnect|connect|reconnect/i.test(a);

/** Resolve a phase code from whatever the feed provides (StatusId, else GameState). */
export function resolvePhase(ev: ScoreEvent): { code: number | null; label: string } {
  const s = ev.StatusId;
  if (typeof s === "number") return { code: s, label: PHASE_NAME[s] ?? String(s) };
  if (typeof s === "string") {
    if (s in NAME_TO_PHASE) return { code: NAME_TO_PHASE[s], label: s };
    const n = Number(s);
    if (!Number.isNaN(n)) return { code: n, label: PHASE_NAME[n] ?? s };
  }
  if (s && typeof s === "object") {
    const key = Object.keys(s)[0]; // tagged-union form { F: {} }
    if (key) {
      if (key in NAME_TO_PHASE) return { code: NAME_TO_PHASE[key], label: key };
      const n = Number(key);
      if (!Number.isNaN(n)) return { code: n, label: PHASE_NAME[n] ?? key };
    }
  }
  return { code: null, label: ev.GameState ?? "unknown" };
}

/** GET the latest fixtures snapshot, optionally from `startEpochDay`. */
export async function getFixtures(
  ctx: SpikeContext,
  a: Auth,
  opts: { startEpochDay?: number; competitionId?: number } = {},
): Promise<Fixture[]> {
  const res = await txline<Fixture[]>("/api/fixtures/snapshot", {
    baseUrl: ctx.baseUrl,
    ...auth(a),
    query: { startEpochDay: opts.startEpochDay, competitionId: opts.competitionId },
  });
  return Array.isArray(res) ? res : [];
}

/** Full sequence of score updates for a fixture (start time 2 weeks–6h ago). */
export async function getScoreHistory(ctx: SpikeContext, a: Auth, fixtureId: number): Promise<ScoreEvent[]> {
  for (const path of [`/api/scores/historical/${fixtureId}`, `/api/scores/snapshot/${fixtureId}`]) {
    try {
      const res = await txline<ScoreEvent[]>(path, { baseUrl: ctx.baseUrl, ...auth(a) });
      if (Array.isArray(res) && res.length) return res;
    } catch (e) {
      detail(`${path} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return [];
}

/**
 * Rank fixtures so the most-likely-rooted soccer match comes first:
 * prior-day completed matches (24h–14d ago) > in-play (2h–24h) > everything else.
 */
export function rankFixtures(fixtures: Fixture[]): Fixture[] {
  const now = Date.now();
  const bucket = (f: Fixture): number => {
    const e = now - f.StartTime;
    if (e >= DAY_MS && e <= 14 * DAY_MS) return 0; // completed, prior UTC day → likely rooted
    if (e >= 2 * HOUR_MS && e < DAY_MS) return 1; // recently played / in-play today
    return 2; // future, or >14d
  };
  return [...fixtures].sort((x, y) => {
    const bx = bucket(x);
    const by = bucket(y);
    if (bx !== by) return bx - by;
    return now - x.StartTime - (now - y.StartTime); // within bucket: most recent first
  });
}

/** From a fixture's events, pick the best stat to validate. */
export function pickStat(
  events: ScoreEvent[],
  opts: { statKey?: number; statKey2?: number } = {},
): StatPick | null {
  if (!events.length) return null;
  const withPhase = events.map((ev) => ({ ev, ...resolvePhase(ev) }));

  // Drop pure connection-noise events; prefer finished, else non-void.
  const real = withPhase.filter((e) => !isConnNoise(e.ev.Action));
  const usable = real.length ? real : withPhase;
  const finished = usable.filter((e) => e.code !== null && FINISHED_PHASES.has(e.code));
  const nonVoid = usable.filter((e) => e.code === null || !VOID_PHASES.has(e.code));
  const pool = finished.length ? finished : nonVoid.length ? nonVoid : usable;

  // Highest Seq carries the most-complete cumulative Stats.
  const chosen = pool.reduce((best, e) => (e.ev.Seq > best.ev.Seq ? e : best), pool[0]);

  const sk = opts.statKey ?? statKey(SOCCER_STAT.P1_CORNERS, PERIOD.FULL_GAME);
  const sk2 = opts.statKey2 ?? statKey(SOCCER_STAT.P2_CORNERS, PERIOD.FULL_GAME);
  const stats = chosen.ev.Stats ?? {};

  return {
    fixtureId: chosen.ev.FixtureId,
    seq: chosen.ev.Seq,
    statKey: sk,
    statKey2: sk2,
    phaseCode: chosen.code,
    phaseLabel: chosen.label,
    final: chosen.code !== null && FINISHED_PHASES.has(chosen.code),
    hints: {
      p1Corners: stats[String(sk)],
      p2Corners: stats[String(sk2)],
      p1Goals: stats[String(SOCCER_STAT.P1_GOALS)],
      p2Goals: stats[String(SOCCER_STAT.P2_GOALS)],
    },
  };
}

/** Walk ranked fixtures until one yields a usable stat pick. */
export async function discoverStat(ctx: SpikeContext, a: Auth, limit = 12): Promise<StatPick | null> {
  const startEpochDay = Math.floor(Date.now() / DAY_MS) - 14;
  const fixtures = await getFixtures(ctx, a, { startEpochDay });
  info(`fixtures snapshot returned ${fixtures.length} fixtures`);
  if (!fixtures.length) return null;

  const ranked = rankFixtures(fixtures).slice(0, limit);
  for (const f of ranked) {
    const events = await getScoreHistory(ctx, a, f.FixtureId);
    if (!events.length) continue;
    const pick = pickStat(events);
    if (!pick || !Number.isFinite(pick.seq)) continue;
    if (pick.phaseCode !== null && isVoid(pick.phaseCode)) {
      warn(`fixture ${f.FixtureId} (${f.Competition}) is void (${pick.phaseLabel}) — skipping`);
      continue;
    }
    info(
      `picked fixture ${f.FixtureId}: ${f.Participant1} vs ${f.Participant2} (${f.Competition}) ` +
        `phase=${pick.phaseLabel} seq=${pick.seq} corners≈${pick.hints.p1Corners}-${pick.hints.p2Corners} ` +
        `${pick.final ? "[FINAL]" : "[not final]"}`,
    );
    return pick;
  }
  return null;
}
