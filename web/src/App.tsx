import { useState } from "react";
import "./App.css";
import { LoginBar } from "./components/LoginBar.tsx";
import { BetsView } from "./components/BetsView.tsx";
import { WalletView } from "./components/WalletView.tsx";
import { BottomNav, type Tab } from "./components/BottomNav.tsx";
import { PearlyView } from "./components/PearlyView.tsx";
import { LiveMatchView } from "./components/LiveMatchView.tsx";
import { MarketLinesView } from "./components/MarketLinesView.tsx";

// hidden-not-deleted
/**
 * Markets tab — teaser only for now. The per-market parimutuel board
 * (components/MatchList.tsx) is retired from the nav while the daily card is the
 * headline product; the board files stay in the tree, just unrouted.
 */
function MarketsTeaser() {
  return (
    <div className="teaser">
      <div className="teaser-pill">Coming soon</div>
      <div className="teaser-icon">◎</div>
      <h2 className="teaser-h">Prediction markets</h2>
      <p className="teaser-pitch">
        Back single outcomes at live parimutuel odds — corners, goals, cards, results —
        each self-settling on a verifiable on-chain proof.
      </p>
      <div className="teaser-foot"><span className="seal">◆</span> Every market self-settles on a TxLINE proof.</div>
    </div>
  );
}

/** The /test page pins the Live tab to TEST matches (synthetic-fixture pools —
 *  real devnet-SOL play, scripted feed). The main app never features them. */
const IS_TEST_PAGE = window.location.pathname.startsWith("/test");

export default function App() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <div className="app">
      <LoginBar />

      {tab === "live" && <LiveMatchView test={IS_TEST_PAGE} />}
      {tab === "sweepstake" && <PearlyView />}
      {tab === "markets" && <MarketLinesView />}
      {tab === "bets" && <BetsView />}
      {tab === "wallet" && <WalletView />}

      <BottomNav tab={tab} onChange={setTab} />
    </div>
  );
}
