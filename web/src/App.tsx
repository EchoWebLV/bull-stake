import { useState } from "react";
import "./App.css";
import { LoginBar } from "./components/LoginBar.tsx";
import { MatchList } from "./components/MatchList.tsx";
import { BetsView } from "./components/BetsView.tsx";
import { WalletView } from "./components/WalletView.tsx";
import { BottomNav, type Tab } from "./components/BottomNav.tsx";

export default function App() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <div className="app">
      <LoginBar />

      {tab === "live" && (
        <>
          <MatchList />
          <div className="trust">
            <span className="seal">◆</span> Every market self-settles on a verifiable proof.
          </div>
        </>
      )}
      {tab === "bets" && <BetsView />}
      {tab === "wallet" && <WalletView />}

      <BottomNav tab={tab} onChange={setTab} />
    </div>
  );
}
