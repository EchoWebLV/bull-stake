/** Polls /api/lines (slate) and, when a fixture is focused, /api/lines/:id
 *  with this wallet — 8s cadence (odds tick ~45s server-side; money moves on
 *  every bet, and refresh() gives an instant re-read after your own tx). */
import { useCallback, useEffect, useState } from "react";
import {
  getLines, getLineDetail,
  type LineDto, type LineDetailResponse,
} from "../lib/api.ts";

const POLL_MS = 8000;

export function useLines(wallet: string | null, focusFixtureId: number | null) {
  const [lines, setLines] = useState<LineDto[] | null>(null);
  const [detail, setDetail] = useState<LineDetailResponse | null>(null);

  const refresh = useCallback(async () => {
    const slate = await getLines().catch(() => null);
    if (slate) setLines(slate.lines);
    if (focusFixtureId != null) {
      const d = await getLineDetail(focusFixtureId, wallet).catch(() => null);
      setDetail(d);
    } else {
      setDetail(null);
    }
  }, [wallet, focusFixtureId]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      await refresh();
      if (!alive) return;
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [refresh]);

  return { lines, detail, refresh };
}
