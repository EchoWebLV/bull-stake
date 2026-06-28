import { useEffect, useState } from "react";
import { getMatches, type LiveMatch } from "../lib/api.ts";
import { MatchRow } from "./MatchRow.tsx";

const RANK: Record<LiveMatch["status"], number> = { live: 0, upcoming: 1, ft: 2 };

export function MatchList() {
  const [matches, setMatches] = useState<LiveMatch[]>();
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getMatches()
        .then((m) => { if (alive) { setMatches(m); setErr(false); } })
        .catch(() => { if (alive) setErr(true); });
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!matches) {
    return <div className="card"><span className="muted">{err ? "Engine warming up…" : "Loading matches…"}</span></div>;
  }
  if (matches.length === 0) {
    return <div className="card"><span className="muted">No matches yet.</span></div>;
  }

  const sorted = [...matches].sort(
    (a, b) => RANK[a.status] - RANK[b.status] || a.kickoffMs - b.kickoffMs,
  );

  return (
    <>
      {sorted.map((m) => <MatchRow key={m.fixtureId} match={m} />)}
    </>
  );
}
