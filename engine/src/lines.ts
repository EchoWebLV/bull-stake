/**
 * Beat the Market — engine-side odds tracker (spec §5).
 *
 * Owns ONLY odds data (series + latest point + fixture names). Money numbers
 * (pot, totals, status) are read fresh from the chain by the routes. Injectable
 * fetchers make it fully unit-testable; production wiring (start()) polls
 * TxLINE every LINES_POLL_SECS and refreshes the tracked set from
 * readLineMarkets every 60s.
 */
import {
  isLineRow, pctMilliFor,
  fetchOddsSnapshot, fetchOddsUpdates, latestLineRowAtOrBefore, type OddsRow,
} from "../../spike/src/odds.js";
import type { Auth, SpikeContext } from "../../spike/src/auth.js";

const POLL_MS = Math.max(5, Number(process.env.LINES_POLL_SECS ?? "45")) * 1000;
const DOWNSAMPLE_MS = 60_000;
const RING_CAP = 720; // ≤ 12h at 1/min

/** ≤1 point per bucket of `stepMs`; the final point always survives. */
export function downsample(points: [number, number][], stepMs: number): [number, number][] {
  const out: [number, number][] = [];
  let bucket = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [ts] = points[i];
    const b = Math.floor(ts / stepMs);
    if (b > bucket) { out.push(points[i]); bucket = b; }
    else if (i === points.length - 1) out[out.length - 1] = points[i];
  }
  return out;
}

interface Fetchers {
  fetchSnapshot: (fixtureId: number) => Promise<OddsRow[]>;
  fetchUpdates: (fixtureId: number) => Promise<OddsRow[]>;
}
interface Tracked {
  favSide: 1 | 2;
  seeded: boolean;
  series: [number, number][]; // [tsMs, pctMilli], ascending
}

export class LinesStore {
  private fx: Fetchers;
  private map = new Map<number, Tracked>();
  private names = new Map<number, { home: string; away: string }>();

  constructor(fx?: Partial<Fetchers>) {
    // Production fetchers are bound in start(); tests inject fakes here.
    this.fx = {
      fetchSnapshot: fx?.fetchSnapshot ?? (async () => []),
      fetchUpdates: fx?.fetchUpdates ?? (async () => []),
    };
  }

  /** Begin tracking a fixture's line; seeds history from updates ONCE. */
  async track(fixtureId: number, favSide: 1 | 2): Promise<void> {
    let t = this.map.get(fixtureId);
    if (!t) { t = { favSide, seeded: false, series: [] }; this.map.set(fixtureId, t); }
    if (t.seeded) return;
    t.seeded = true;
    try {
      const rows = (await this.fx.fetchUpdates(fixtureId)).filter(isLineRow);
      rows.sort((a, b) => a.Ts - b.Ts);
      const pts: [number, number][] = rows.map((r) => [r.Ts, pctMilliFor(r, t!.favSide)]);
      t.series = downsample(pts, DOWNSAMPLE_MS).slice(-RING_CAP);
    } catch { /* history is a nice-to-have; the snapshot poll still runs */ }
  }

  untrack(fixtureId: number): void { this.map.delete(fixtureId); }
  tracked(): number[] { return [...this.map.keys()]; }

  /** One snapshot poll over every tracked fixture; appends changed points. */
  async poll(): Promise<void> {
    for (const [fixtureId, t] of this.map) {
      try {
        const row = latestLineRowAtOrBefore(
          (await this.fx.fetchSnapshot(fixtureId)).filter(isLineRow), Number.MAX_SAFE_INTEGER);
        if (!row) continue;
        const pt: [number, number] = [row.Ts, pctMilliFor(row, t.favSide)];
        const last = t.series[t.series.length - 1];
        if (!last || last[0] !== pt[0] || last[1] !== pt[1]) {
          t.series.push(pt);
          if (t.series.length > RING_CAP) t.series.shift();
        }
      } catch { /* transient upstream failure: keep last-known series */ }
    }
  }

  current(fixtureId: number): { pctMilli: number; ts: number } | null {
    const t = this.map.get(fixtureId);
    const last = t?.series[t.series.length - 1];
    return last ? { pctMilli: last[1], ts: last[0] } : null;
  }
  series(fixtureId: number): [number, number][] { return this.map.get(fixtureId)?.series ?? []; }

  setNames(rows: { fixtureId: number; home: string; away: string }[]): void {
    for (const r of rows) this.names.set(r.fixtureId, { home: r.home, away: r.away });
  }
  name(fixtureId: number): { home: string; away: string } | null {
    return this.names.get(fixtureId) ?? null;
  }

  /** Production loop: bind real fetchers, then (a) refresh tracked set + names
   *  from the chain + fixtures every 60s, (b) poll snapshots every POLL_MS. */
  start(ctx: SpikeContext, auth: Auth): void {
    this.fx = {
      fetchSnapshot: (id) => fetchOddsSnapshot(ctx, auth, id),
      fetchUpdates: (id) => fetchOddsUpdates(ctx, auth, id),
    };
    const refresh = async () => {
      try {
        const { readLineMarkets } = await import("./chain.ts");
        const { getFixtures } = await import("../../spike/src/discover.js");
        const markets = await readLineMarkets();
        const nowSec = Math.floor(Date.now() / 1000);
        for (const m of markets) {
          if (m.status === "open" || m.entryCloseTs > nowSec - 36 * 3600) {
            await this.track(m.fixtureId, m.favSide);
          }
          if (m.status !== "open") this.untrackLater(m.fixtureId, m.entryCloseTs, nowSec);
        }
        const fixtures = await getFixtures(ctx, auth);
        this.setNames(fixtures.map((f) => ({
          fixtureId: f.FixtureId, home: f.Participant1, away: f.Participant2,
        })));
      } catch (e) {
        console.warn("lines refresh failed:", (e as Error).message);
      }
    };
    void refresh();
    setInterval(refresh, 60_000);
    setInterval(() => void this.poll(), POLL_MS);
  }

  /** Drop terminal fixtures once they age out (keeps results visible ~36h). */
  private untrackLater(fixtureId: number, entryCloseTs: number, nowSec: number): void {
    if (entryCloseTs < nowSec - 36 * 3600) this.untrack(fixtureId);
  }
}
