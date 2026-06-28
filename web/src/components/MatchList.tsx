import { useEffect, useState } from "react";
import { getMatches, type LiveMatch } from "../lib/api.ts";
import { MatchRow } from "./MatchRow.tsx";

const SECTIONS: { status: LiveMatch["status"]; label: string; tag?: string }[] = [
  { status: "live", label: "Live now", tag: "● settling on proof" },
  { status: "upcoming", label: "Upcoming" },
  { status: "ft", label: "Recently finished" },
];

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
    return <div className="card empty-card">{err ? "Engine warming up…" : "Loading matches…"}</div>;
  }
  if (matches.length === 0) {
    return <div className="card empty-card">No World Cup matches scheduled right now.</div>;
  }

  return (
    <>
      {SECTIONS.map(({ status, label, tag }) => {
        const inSection = matches
          .filter((m) => m.status === status)
          .sort((a, b) => a.kickoffMs - b.kickoffMs);
        if (inSection.length === 0) return null;
        return (
          <div key={status}>
            <div className="section">
              <h3>{label}</h3>
              {tag && <span className="tag" style={status === "live" ? { color: "var(--red)" } : undefined}>{tag}</span>}
            </div>
            {inSection.map((m) => <MatchRow key={m.fixtureId} match={m} />)}
          </div>
        );
      })}
    </>
  );
}
