import { useCallback, useEffect, useState } from "react";
import { getHistory, type HistoryEntry, type HistoryStatus } from "../lib/api.ts";
import { useSolanaAddress } from "./LoginBar.tsx";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildClaimTx } from "../lib/anchorClient.ts";
import { SOL, fmtSol } from "../lib/odds.ts";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const STATUS_META: Record<HistoryStatus, { label: string; cls: string; claim?: boolean }> = {
  pending: { label: "Pending", cls: "amber" },
  won: { label: "Won", cls: "green" },
  lost: { label: "Lost", cls: "dim" },
  refunded: { label: "Refunded", cls: "blue" },
  "claimable-won": { label: "Won · claim", cls: "green", claim: true },
  "claimable-refund": { label: "Refund · claim", cls: "blue", claim: true },
  legacy: { label: "Legacy", cls: "dim" },
};

function Receipt({ entry, onClaimed }: { entry: HistoryEntry; onClaimed: () => void }) {
  const { address, signAndSend } = usePrivySigner();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const meta = STATUS_META[entry.status];
  const won = entry.status === "won" || entry.status === "claimable-won";
  const match = entry.away ? `${entry.home} v ${entry.away}` : entry.home;
  const proofSig = entry.claimSig ?? entry.betSig;

  async function claim() {
    if (!address) return;
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimTx(address, entry.fixtureId, entry.marketId);
      const sig = await signAndSend(tx);
      setMsg(`claimed · ${sig.slice(0, 8)}…`);
      setTimeout(onClaimed, 1500);
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="receipt">
      <div className="receipt-main">
        <div className="receipt-info">
          <div className="receipt-title">
            {entry.label} · <span className="receipt-side">{entry.side}</span>
          </div>
          <div className="receipt-sub">
            <span>{match}</span>
            <a className="proof-chip" href={explorer(proofSig)} target="_blank" rel="noreferrer">
              <span className="seal">◆</span> {proofSig.slice(0, 4)}…{proofSig.slice(-4)} ↗
            </a>
          </div>
        </div>
        <div className="receipt-right">
          <span className={`status-pill ${meta.cls}`}>{meta.label}</span>
          <span className={`receipt-amt ${won ? "win" : entry.status === "lost" ? "lose" : ""}`}>
            {won ? `+${fmtSol(entry.payoutLamports)}${SOL}`
              : entry.status === "lost" ? `−${fmtSol(entry.stakeLamports)}${SOL}`
              : `${fmtSol(entry.stakeLamports)}${SOL}`}
          </span>
        </div>
      </div>
      {meta.claim && (
        <button className="btn" style={{ marginTop: 10 }} disabled={busy} onClick={claim}>
          {busy ? "…" : entry.status === "claimable-won"
            ? `Claim ${fmtSol(entry.payoutLamports)}${SOL}` : `Claim refund`}
        </button>
      )}
      {msg && <p className="msg" role="status" aria-live="polite">{msg}</p>}
    </div>
  );
}

export function BetsView() {
  const address = useSolanaAddress();
  const [entries, setEntries] = useState<HistoryEntry[]>();
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    if (!address) return;
    getHistory(address)
      .then((h) => { setEntries(h); setErr(false); })
      .catch(() => setErr(true));
  }, [address]);

  useEffect(() => {
    if (!address) return;
    setEntries(undefined);
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [address, load]);

  if (!address) {
    return (
      <>
        <div className="section"><h3>My Bets</h3></div>
        <div className="card empty-card">Log in to see your bets and wins.</div>
      </>
    );
  }

  if (!entries) {
    return (
      <>
        <div className="section"><h3>My Bets</h3></div>
        <div className="card empty-card">{err ? "Engine warming up…" : "Loading your history…"}</div>
      </>
    );
  }

  if (entries.length === 0) {
    return (
      <>
        <div className="section"><h3>My Bets</h3></div>
        <div className="card empty-card">No bets yet. Head to Live and back a market.</div>
      </>
    );
  }

  // Summary
  const staked = entries.reduce((s, e) => s + Number(e.stakeLamports), 0);
  const won = entries
    .filter((e) => e.status === "won" || e.status === "claimable-won")
    .reduce((s, e) => s + Number(e.payoutLamports), 0);
  const settled = entries.filter((e) => e.status !== "pending" && e.status !== "legacy");
  const wins = entries.filter((e) => e.status === "won" || e.status === "claimable-won").length;

  return (
    <>
      <div className="section"><h3>My Bets</h3>
        <span className="tag"><span className="seal" style={{ color: "var(--green)" }}>◆</span> verified on-chain</span>
      </div>

      <div className="bets-summary">
        <div className="stat">
          <div className="k">Staked</div>
          <div className="v">{fmtSol(staked)}{SOL}</div>
        </div>
        <div className="stat green">
          <div className="k">Won</div>
          <div className="v">{fmtSol(won)}{SOL}</div>
        </div>
        <div className="stat">
          <div className="k">Record</div>
          <div className="v">{wins}/{settled.length || 0}</div>
        </div>
      </div>

      <div style={{ marginTop: 6 }}>
        {entries.map((e) => (
          <Receipt key={`${e.market}-${e.betSig}`} entry={e} onClaimed={load} />
        ))}
      </div>
    </>
  );
}
