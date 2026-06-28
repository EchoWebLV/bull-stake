import type { MarketState, MatchState } from "../lib/api.ts";

const SOL = 1_000_000_000;
export function MarketCard({ market, match }: { market: MarketState; match: MatchState }) {
  const pot = (Number(market.totalPool) / SOL).toFixed(2);
  return (
    <div className="card">
      <div className="row">
        <b>{market.meta.home} vs {market.meta.away}</b>
        <span className="muted">{match.phase} · {match.minute}'</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">{market.meta.label} O/U {market.meta.line}</span>
        <span className="brand" style={{ fontSize: 20 }}>{match.totalCorners} corners</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">Pool</span><span>{pot} SOL</span>
      </div>
    </div>
  );
}
