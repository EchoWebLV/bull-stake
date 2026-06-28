import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildClaimTx } from "../lib/anchorClient.ts";
import type { MarketState } from "../lib/api.ts";

export function ClaimButton({ market }: { market: MarketState }) {
  const { address, signAndSend } = usePrivySigner();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  if (market.status === "open") return null;

  async function claim() {
    if (!address) return;
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimTx(address, market.fixtureId, market.marketId);
      const sig = await signAndSend(tx);
      setMsg(`claimed: ${sig.slice(0, 8)}…`);
    } catch (e) { setMsg(`error: ${(e as Error).message}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="card">
      <div className="row"><b>{market.status === "voided" ? "Refund available" : "Settled"}</b>
        {market.winningBucket !== null && <span className="win">Winner: {market.winningBucket === 0 ? "Over" : "Under"}</span>}
      </div>
      <button className="btn" style={{ marginTop: 12 }} disabled={busy} onClick={claim}>
        {busy ? "Claiming…" : "Claim payout"}
      </button>
      {msg && <p className="muted" style={{ marginTop: 8 }}>{msg}</p>}
    </div>
  );
}
