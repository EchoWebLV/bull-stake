import { useState, type ReactNode } from "react";
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
  // Lazy keep-alive. A tab mounts on first visit and then STAYS mounted (hidden
  // via display:none when inactive) so its loaded data + poll loops survive tab
  // switches — no reload flash, and the slow on-chain /api/card scan (~4.5s) is
  // paid once, not every time you re-open Pearly. Views take `active` and only
  // poll while they're the visible tab, so backgrounded panes stay quiet and
  // don't pile requests on the engine (which would slow the active tab).
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set<Tab>(["live"]));

  function go(t: Tab) {
    setTab(t);
    setSeen((s) => (s.has(t) ? s : new Set(s).add(t)));
  }

  function pane(t: Tab, node: ReactNode) {
    if (!seen.has(t)) return null; // not visited yet — don't mount / fetch
    return (
      <div className="pane" style={{ display: t === tab ? undefined : "none" }}>
        {node}
      </div>
    );
  }

  return (
    <div className="app">
      <LoginBar />

      {pane("live", <LiveMatchView test={IS_TEST_PAGE} active={tab === "live"} onGoPearly={() => go("sweepstake")} />)}
      {pane("sweepstake", <PearlyView active={tab === "sweepstake"} test={IS_TEST_PAGE} onGoLive={() => go("live")} />)}
      {pane("markets", <MarketLinesView />)}
      {pane("bets", <BetsView active={tab === "bets"} />)}
      {pane("wallet", <WalletView active={tab === "wallet"} />)}

      <BottomNav tab={tab} onChange={go} />
    </div>
  );
}
