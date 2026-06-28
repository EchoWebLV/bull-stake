import { useEffect, useState } from "react";
import "./App.css";
import { LoginBar } from "./components/LoginBar.tsx";
import { MarketCard } from "./components/MarketCard.tsx";
import { BetForm } from "./components/BetForm.tsx";
import { ClaimButton } from "./components/ClaimButton.tsx";
import { getMarket, getMatch, type MarketState, type MatchState } from "./lib/api.ts";

export default function App() {
  const [market, setMarket] = useState<MarketState>();
  const [match, setMatch] = useState<MatchState>();

  async function refresh() {
    try {
      const [m, mt] = await Promise.all([getMarket(), getMatch()]);
      setMarket(m); setMatch(mt);
    } catch { /* engine warming up */ }
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);

  return (
    <div className="app">
      <LoginBar />
      {market && match ? (
        <>
          <MarketCard market={market} match={match} />
          {market.status === "open"
            ? <BetForm market={market} onDone={refresh} />
            : <ClaimButton market={market} />}
        </>
      ) : <div className="card"><span className="muted">Loading market…</span></div>}
    </div>
  );
}
