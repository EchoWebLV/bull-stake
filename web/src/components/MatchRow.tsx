import { useEffect, useState } from "react";
import { getMarkets, type LiveMatch, type LiveMarket } from "../lib/api.ts";
import { MarketRow } from "./MarketRow.tsx";

const GROUP_ORDER: LiveMarket["group"][] = ["result", "goals", "corners", "cards"];
const GROUP_LABEL: Record<LiveMarket["group"], string> = {
  result: "Result", goals: "Goals", corners: "Corners", cards: "Cards",
};

function kickoffLabel(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function StatusChip({ match }: { match: LiveMatch }) {
  if (match.status === "live") {
    return (
      <span className="lose" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)" }} />
        LIVE
      </span>
    );
  }
  if (match.status === "ft") return <span className="muted">FT</span>;
  return <span className="muted">{kickoffLabel(match.kickoffMs)}</span>;
}

export function MatchRow({ match }: { match: LiveMatch }) {
  const [open, setOpen] = useState(false);
  const [markets, setMarkets] = useState<LiveMarket[]>();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => getMarkets(match.fixtureId).then((m) => { if (alive) setMarkets(m); }).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [open, match.fixtureId]);

  const showScore = match.status === "live" || match.status === "ft";

  return (
    <div className="card">
      <div className="row" onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <b>{match.home} vs {match.away}</b>
        <StatusChip match={match} />
      </div>

      {showScore && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="brand" style={{ fontSize: 18 }}>{match.scoreH} – {match.scoreA}</span>
          <span className="muted">
            {match.minute != null ? `${match.minute}'` : match.phase ?? ""} · ⚽{match.goals} ⛳{match.corners} 🟨{match.yellows}
          </span>
        </div>
      )}

      {open && (
        <div style={{ marginTop: 12 }}>
          {!markets && <span className="muted">Loading markets…</span>}
          {markets && GROUP_ORDER.map((group) => {
            const inGroup = markets.filter((m) => m.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group} style={{ marginTop: 8 }}>
                <div className="muted" style={{ textTransform: "uppercase", letterSpacing: 1, fontSize: 11 }}>
                  {GROUP_LABEL[group]}
                </div>
                {inGroup.map((m) => (
                  <MarketRow key={m.marketId} fixtureId={match.fixtureId} market={m} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
