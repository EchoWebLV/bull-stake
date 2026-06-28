import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx } from "../lib/anchorClient.ts";
import type { MarketState } from "../lib/api.ts";

const LAMPORTS = 1_000_000_000;

export function BetForm({ market, onDone }: { market: MarketState; onDone: () => void }) {
  const { address, signAndSend } = usePrivySigner();
  const [bucket, setBucket] = useState<0 | 1>(0);
  const [sol, setSol] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  async function placeBet() {
    if (!address) { setMsg("log in first"); return; }
    const n = Number(sol);
    if (!Number.isFinite(n) || n <= 0) { setMsg("enter a valid amount"); return; }
    setBusy(true); setMsg(undefined);
    try {
      const lamports = BigInt(Math.round(n * LAMPORTS));
      const tx = await buildPlaceBetTx(address, market.fixtureId, market.marketId, bucket, lamports);
      const sig = await signAndSend(tx);
      setMsg(`bet placed: ${sig.slice(0, 8)}…`);
      onDone();
    } catch (e) { setMsg(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const closed = Date.now() / 1000 >= market.entryCloseTs || market.status !== "open";
  return (
    <div className="card">
      <div className="row" style={{ gap: 8 }}>
        <button className={`pick ${bucket === 0 ? "sel" : ""}`} onClick={() => setBucket(0)}>
          Over {market.meta.line}<br /><span className="muted">{market.impliedOdds.over.toFixed(2)}×</span>
        </button>
        <button className={`pick ${bucket === 1 ? "sel" : ""}`} onClick={() => setBucket(1)}>
          Under {market.meta.line}<br /><span className="muted">{market.impliedOdds.under.toFixed(2)}×</span>
        </button>
      </div>
      <div style={{ marginTop: 12 }}>
        <input value={sol} onChange={(e) => setSol(e.target.value)} inputMode="decimal" />
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy || closed} onClick={placeBet}>
        {closed ? "Entry closed" : busy ? "Confirming…" : `Bet ${sol} SOL`}
      </button>
      {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
