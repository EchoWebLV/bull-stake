/**
 * useLivePool.ts — discovers the active live fixture, then polls its on-chain
 * pool + this wallet's seat every 2s.
 *
 * Discovery uses the existing /api/matches list (no new engine route): the first
 * match whose /api/live/pool returns a non-null pool is the live-centerpiece
 * game (in practice there is one daily). Once found it's cached for the session.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import {
  getMatches, getLivePool, getLiveEntry,
  type LivePoolResponse, type LiveEntryView,
} from "./api.ts";

const POLL_MS = 2000;

export interface LivePoolState {
  loading: boolean;
  fixtureId: number | null;
  data: LivePoolResponse | null; // pool + openCall + standings + match
  entry: LiveEntryView | null;   // this wallet's seat (null if not joined)
  refresh: () => Promise<void>;
}

export function useLivePool(wallet: string | null): LivePoolState {
  const [state, setState] = useState<Omit<LivePoolState, "refresh">>({
    loading: true, fixtureId: null, data: null, entry: null,
  });
  const fixtureRef = useRef<number | null>(null);

  const discover = useCallback(async (): Promise<number | null> => {
    if (fixtureRef.current != null) return fixtureRef.current;
    const matches = await getMatches().catch(() => []);
    // live fixtures first, then the rest — a pooled live match wins.
    const ordered = [...matches].sort(
      (a, b) => (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1),
    );
    for (const m of ordered) {
      const r = await getLivePool(m.fixtureId).catch(() => ({ pool: null }) as LivePoolResponse);
      if (r.pool) { fixtureRef.current = m.fixtureId; return m.fixtureId; }
    }
    return null;
  }, []);

  const refresh = useCallback(async () => {
    const fixtureId = await discover();
    if (fixtureId == null) {
      setState({ loading: false, fixtureId: null, data: null, entry: null });
      return;
    }
    const data = await getLivePool(fixtureId).catch(() => null);
    let entry: LiveEntryView | null = null;
    if (wallet && data?.pool) {
      entry = await getLiveEntry(wallet, data.pool.poolId).catch(() => null);
    }
    setState({ loading: false, fixtureId, data, entry });
  }, [discover, wallet]);

  useEffect(() => {
    let alive = true;
    const tick = async () => { if (alive) await refresh(); };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [refresh]);

  return { ...state, refresh };
}
