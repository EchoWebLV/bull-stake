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
  getNextGame, getLiveEntry, getUnclaimed,
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

/** `test=true` polls the TEST audience (/api/live/next?test=1 — the /test page).
 *  `active=false` keeps the last state but pauses polling (backgrounded tab). */
export function useLivePool(wallet: string | null, test = false, active = true): LivePoolState {
  const [state, setState] = useState<Omit<LivePoolState, "refresh">>({
    loading: true, data: null, entry: null,
  });
  // The latest response drives the NEXT poll's cadence (2s with a pool, 5s idle).
  const lastHadPool = useRef(false);

  const refresh = useCallback(async () => {
    const data = await getNextGame(test).catch(() => null);
    let entry: LiveEntryView | null = null;
    if (wallet && data?.pool) {
      entry = await getLiveEntry(wallet, data.pool.poolId).catch(() => null);
    }

    // UNFINISHED BUSINESS outranks the rotation (unless I'm seated in the
    // featured pool right now): /next only ever serves OPEN pools, so the
    // moment my pool settles it vanishes — taking the claim button with it.
    // Pin my newest terminal pool with a still-open entry until the claim
    // (which closes the entry) releases the pin. Server-driven: no local state.
    const playingFeatured = !!(data?.pool && entry);
    if (wallet && !playingFeatured) {
      const owed = await getUnclaimed(wallet, test).catch(() => null);
      if (owed?.pool && owed.entry) {
        lastHadPool.current = true;
        setState({
          loading: false,
          data: { ...owed, kickoffMs: owed.match?.kickoffMs ?? null, joinOpensTs: null },
          entry: owed.entry,
        });
        return;
      }
    }

    lastHadPool.current = !!data?.pool;
    setState({ loading: false, data, entry });
  }, [wallet, test]);

  useEffect(() => {
    if (!active) return; // backgrounded: hold the last state, stop polling
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      await refresh();
      if (!alive) return;
      timer = setTimeout(tick, lastHadPool.current ? POLL_POOL_MS : POLL_IDLE_MS);
    };
    tick(); // re-activating refreshes immediately, then resumes cadence
    return () => { alive = false; clearTimeout(timer); };
  }, [refresh, active]);

  return { ...state, refresh };
}
