import { useEffect, useState } from "react";
import { getMarkets, type LiveMatch, type LiveMarket } from "../lib/api.ts";
import { MarketRow } from "./MarketRow.tsx";

const GROUP_ORDER: LiveMarket["group"][] = ["result", "goals", "corners", "cards"];
const GROUP_LABEL: Record<LiveMarket["group"], string> = {
  result: "Match Result", goals: "Goals", corners: "Corners", cards: "Cards",
};

/** 3-letter team code from a name, e.g. "South Africa" → "SOU". */
function teamCode(name: string): string {
  const clean = name.replace(/[^a-zA-Z ]/g, "").trim();
  const words = clean.split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1].slice(0, 2)).toUpperCase();
  return clean.slice(0, 3).toUpperCase();
}

/** Deterministic crest gradient from a team name. */
function crestStyle(name: string): React.CSSProperties {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const h2 = (h + 38) % 360;
  return { background: `conic-gradient(from 130deg, hsl(${h} 60% 45%) 0 55%, hsl(${h2} 70% 55%) 55% 100%)` };
}

function kickoffLabel(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function Crest({ name }: { name: string }) {
  return (
    <div className="team">
      <div className="crest" style={crestStyle(name)}>{teamCode(name)}</div>
      <span className="code">{teamCode(name)}</span>
    </div>
  );
}

function StatusBadge({ match }: { match: LiveMatch }) {
  if (match.status === "live") {
    return (
      <span className="status-live">
        <span className="blip" /> {match.minute != null ? `${match.minute}'` : "LIVE"}
      </span>
    );
  }
  if (match.status === "ft") return <span className="status-ft">FT</span>;
  return <span className="status-time">{kickoffLabel(match.kickoffMs)}</span>;
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
  const panelId = `markets-${match.fixtureId}`;
  const toggle = () => setOpen((o) => !o);

  return (
    <div className={`match${match.status === "live" ? " live" : ""}`}>
      <div
        className="match-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${match.home} versus ${match.away} — ${open ? "hide" : "show"} betting markets`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        }}
      >
        <div className="match-top">
          <span className="comp-pill"><span className="trophy">♛</span> World Cup</span>
          <StatusBadge match={match} />
        </div>

        <div className="teams">
          <Crest name={match.home} />
          <div className="score">
            {showScore ? (
              <>
                <div className="nums">
                  <span>{match.scoreH}</span>
                  <span className="sep">–</span>
                  <span>{match.scoreA}</span>
                </div>
                <span className="phase">
                  {match.status === "ft" ? "Full time" : match.phase || "Live"}
                </span>
              </>
            ) : (
              <>
                <div className="kick">{kickoffLabel(match.kickoffMs)}</div>
                <span className="phase">Kick-off</span>
              </>
            )}
          </div>
          <Crest name={match.away} />
        </div>

        {showScore && (
          <div className="statstrip">
            <div className="cell"><div className="v">{match.goals}</div><div className="k">Goals</div></div>
            <div className="cell"><div className="v">{match.corners}</div><div className="k">Corners</div></div>
            <div className="cell"><div className="v">{match.yellows}</div><div className="k">Cards</div></div>
          </div>
        )}

        {!open && (
          <div className="expand-hint">
            {match.home} vs {match.away} · tap to see markets ▾
          </div>
        )}
      </div>

      {open && (
        <div className="markets" id={panelId}>
          {!markets && <div className="muted" style={{ padding: "6px 2px" }}>Loading markets…</div>}
          {markets && GROUP_ORDER.map((group) => {
            const inGroup = markets.filter((m) => m.group === group);
            if (inGroup.length === 0) return null;
            return (
              <div key={group}>
                <div className="group-label">{GROUP_LABEL[group]}</div>
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
