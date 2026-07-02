/**
 * useLivePool.ts — polls the engine's featured game (/api/live/next) + this
 * wallet's seat.
 *
 * The engine picks WHICH game to feature every poll (in-play → joinable → next
 * upcoming fixture), so there is no client-side discovery and no pinned fixture
 * (the old getMatches() scan cached the first pooled fixture for the whole
 * session — finding #5). Poll cadence: 2s when a pool is featured (join counts,
 * points move), 5s when idle (pure countdown / nothing scheduled).
 */
import { useEffect, useRef, useState, useCallback } from "react";
import {
  getNextGame, getLiveEntry,
  type NextGameResponse, type LiveEntryView,
} from "./api.ts";

const POLL_POOL_MS = 2000;
const POLL_IDLE_MS = 5000;

export interface LivePoolState {
  loading: boolean;
  data: NextGameResponse | null; // pool + openCall + lastCall + standings + match + kickoff
  entry: LiveEntryView | null;   // this wallet's seat (null if not joined)
  refresh: () => Promise<void>;
}

export function useLivePool(wallet: string | null): LivePoolState {
  const [state, setState] = useState<Omit<LivePoolState, "refresh">>({
    loading: true, data: null, entry: null,
  });
  // The latest response drives the NEXT poll's cadence (2s with a pool, 5s idle).
  const lastHadPool = useRef(false);

  const refresh = useCallback(async () => {
    const data = await getNextGame().catch(() => null);
    let entry: LiveEntryView | null = null;
    if (wallet && data?.pool) {
      entry = await getLiveEntry(wallet, data.pool.poolId).catch(() => null);
    }
    lastHadPool.current = !!data?.pool;
    setState({ loading: false, data, entry });
  }, [wallet]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      await refresh();
      if (!alive) return;
      timer = setTimeout(tick, lastHadPool.current ? POLL_POOL_MS : POLL_IDLE_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [refresh]);

  return { ...state, refresh };
}
