import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx, buildClaimTx } from "../lib/anchorClient.ts";
import type { LiveMarket } from "../lib/api.ts";

const LAMPORTS = 1_000_000_000;
const odds = (n: number) => (n > 0 ? `${n.toFixed(2)}×` : "—");

export function MarketRow({ fixtureId, market }: { fixtureId: number; market: LiveMarket }) {
  const { address, signAndSend } = usePrivySigner();
  const [bucket, setBucket] = useState<0 | 1>(0);
  const [sol, setSol] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  async function placeBet() {
    if (!address) { setMsg("log in first"); return; }
    const n = Number(sol);
    if (!(Number.isFinite(n) && n > 0)) { setMsg("enter a valid amount"); return; }
    setBusy(true); setMsg(undefined);
    try {
      const lamports = BigInt(Math.round(n * LAMPORTS));
      const tx = await buildPlaceBetTx(address, fixtureId, market.marketId, bucket, lamports);
      const sig = await signAndSend(tx);
      setMsg(`bet placed: ${sig.slice(0, 8)}…`);
    } catch (e) { setMsg(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  async function claim() {
    if (!address) { setMsg("log in first"); return; }
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimTx(address, fixtureId, market.marketId);
      const sig = await signAndSend(tx);
      setMsg(`claimed: ${sig.slice(0, 8)}…`);
    } catch (e) { setMsg(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }

  const settled = market.status === "settled";
  const voided = market.status === "voided";
  const open = market.status === "open";

  return (
    <div className="card" style={{ marginTop: 8, padding: 12 }}>
      <div className="row">
        <b style={{ fontSize: 14 }}>{market.label}</b>
        {market.settleAt === "HT" && <span className="muted">1H</span>}
      </div>

      {open && (
        <>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className={`pick ${bucket === 0 ? "sel" : ""}`} onClick={() => setBucket(0)}>
              Over<br /><span className="muted">{odds(market.impliedOdds.over)}</span>
            </button>
            <button className={`pick ${bucket === 1 ? "sel" : ""}`} onClick={() => setBucket(1)}>
              Under<br /><span className="muted">{odds(market.impliedOdds.under)}</span>
            </button>
          </div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <input
              value={sol}
              onChange={(e) => setSol(e.target.value)}
              inputMode="decimal"
              style={{ flex: 1 }}
            />
            <button className="btn" style={{ width: "auto" }} disabled={busy} onClick={placeBet}>
              {busy ? "…" : "Bet"}
            </button>
          </div>
        </>
      )}

      {settled && (
        <div style={{ marginTop: 8 }}>
          <div className="win" style={{ marginBottom: 8 }}>
            Winner: {market.winningBucket === 0 ? "Over" : "Under"}
          </div>
          <button className="btn" style={{ width: "auto" }} disabled={busy} onClick={claim}>
            {busy ? "…" : "Claim"}
          </button>
        </div>
      )}

      {voided && (
        <div style={{ marginTop: 8 }}>
          <div className="muted" style={{ marginBottom: 8 }}>Refund</div>
          <button className="btn" style={{ width: "auto" }} disabled={busy} onClick={claim}>
            {busy ? "…" : "Claim"}
          </button>
        </div>
      )}

      {market.status === "none" && (
        <button className="btn alt" style={{ marginTop: 8, width: "auto" }} disabled>
          not open yet
        </button>
      )}

      {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
