import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx, buildClaimTx } from "../lib/anchorClient.ts";
import type { LiveMarket } from "../lib/api.ts";
import { LAMPORTS, SOL, fmtMultEst, fmtSol, projectedPayout, displayMultiplier } from "../lib/odds.ts";
import { OddsNote } from "./OddsNote.tsx";

/** "Total Corners O/U 9.5" → "Total Corners"; result markets keep their label. */
function cleanTitle(label: string): string {
  return label.replace(/\s*O\/U\s*[\d.]+\s*$/i, "").trim();
}

export function MarketRow({ fixtureId, market }: { fixtureId: number; market: LiveMarket }) {
  const { address, signAndSend } = usePrivySigner();
  const [bucket, setBucket] = useState<0 | 1>(0);
  const [sol, setSol] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);

  const isResult = market.group === "result";
  const overLabel = isResult ? "Yes" : "Over";
  const underLabel = isResult ? "No" : "Under";

  const overStake = Number(market.bucketTotals[0]);
  const underStake = Number(market.bucketTotals[1]);
  const poolTotal = overStake + underStake;
  const overPct = poolTotal > 0 ? Math.round((overStake / poolTotal) * 100) : 0;
  const underPct = poolTotal > 0 ? 100 - overPct : 0;

  const stakeNum = Number(sol);
  const stakeLamports = Number.isFinite(stakeNum) && stakeNum > 0 ? Math.round(stakeNum * LAMPORTS) : 0;
  const projected = projectedPayout([overStake, underStake], bucket, stakeLamports);

  // Only the picked side reacts to the stake; the other holds at the live-market
  // price (staking a side dilutes only that side — see lib/odds.ts).
  const overMult = displayMultiplier(market.bucketTotals, 0, bucket, stakeLamports, market.odds[0] ?? 0);
  const underMult = displayMultiplier(market.bucketTotals, 1, bucket, stakeLamports, market.odds[1] ?? 0);

  function flash(text: string, err = false) { setMsg(text); setMsgErr(err); }

  async function placeBet() {
    if (!address) { flash("Log in to place a bet", true); return; }
    if (stakeLamports <= 0) { flash("Enter a valid amount", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildPlaceBetTx(address, fixtureId, market.marketId, bucket, BigInt(stakeLamports));
      const sig = await signAndSend(tx);
      flash(`Bet placed · ${sig.slice(0, 8)}…`);
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function claim() {
    if (!address) { flash("Log in to claim", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimTx(address, fixtureId, market.marketId);
      const sig = await signAndSend(tx);
      flash(`Claimed · ${sig.slice(0, 8)}…`);
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  const settled = market.status === "settled";
  const voided = market.status === "voided";
  const open = market.status === "open";
  const winnerLabel = market.winningBucket === 0 ? overLabel : underLabel;

  return (
    <div className="market">
      <div className="market-head">
        <span className="market-title">{cleanTitle(market.label)}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {market.settleAt === "HT" && <span className="ht-tag">1H</span>}
          {!isResult && (
            <span className="line-pill">O/U <b>{market.line}</b></span>
          )}
        </span>
      </div>

      {/* Pool-split bar — always shows where the money sits */}
      <div className="oubar">
        <div className="oubar-track">
          {poolTotal > 0 ? (
            <>
              <div className="oubar-over" style={{ width: `${overPct}%` }} />
              <div className="oubar-under" style={{ width: `${underPct}%` }} />
            </>
          ) : (
            <div className="oubar-empty">no bets yet — be first</div>
          )}
        </div>
        {poolTotal > 0 && (
          <div className="oubar-legend">
            <span className="o">{overLabel} {overPct}%</span>
            <span className="pool">{fmtSol(poolTotal)}{SOL} pool</span>
            <span className="u">{underPct}% {underLabel}</span>
          </div>
        )}
      </div>

      {open && (
        <>
          <div className="picks">
            <button
              className={`pick ${bucket === 0 ? "sel" : ""}`}
              aria-pressed={bucket === 0}
              onClick={() => setBucket(0)}
            >
              <span className="side">{overLabel}</span>
              <span className={`mult ${overMult > 0 ? "" : "empty"}`}>{fmtMultEst(overMult)}</span>
            </button>
            <button
              className={`pick ${bucket === 1 ? "sel" : ""}`}
              aria-pressed={bucket === 1}
              onClick={() => setBucket(1)}
            >
              <span className="side">{underLabel}</span>
              <span className={`mult ${underMult > 0 ? "" : "empty"}`}>{fmtMultEst(underMult)}</span>
            </button>
          </div>

          <OddsNote />

          <div className="stakerow">
            <input
              value={sol}
              onChange={(e) => setSol(e.target.value)}
              inputMode="decimal"
              aria-label="Stake in SOL"
            />
            <button
              className="btn"
              disabled={busy}
              aria-busy={busy}
              aria-label={busy ? "Placing bet" : "Bet"}
              onClick={placeBet}
            >
              {busy ? "…" : "Bet"}
            </button>
          </div>

          {stakeLamports > 0 && (
            <div className="payout-hint">
              <span>
                {fmtSol(stakeLamports)}{SOL} on {bucket === 0 ? overLabel : underLabel}
              </span>
              <span>→ <b>~{fmtSol(projected)}{SOL}</b> if it wins</span>
            </div>
          )}
        </>
      )}

      {settled && (
        <>
          <div className="settled-banner">
            <span className="label">◆ Winner: {winnerLabel}</span>
          </div>
          <div className="claim-line">
            <button
              className="btn"
              disabled={busy}
              aria-busy={busy}
              aria-label={busy ? "Claiming payout" : "Claim payout"}
              onClick={claim}
            >
              {busy ? "…" : "Claim payout"}
            </button>
          </div>
        </>
      )}

      {voided && (
        <>
          <div className="void-banner">
            <span className="label">Market voided — full refund</span>
          </div>
          <div className="claim-line">
            <button
              className="btn alt"
              disabled={busy}
              aria-busy={busy}
              aria-label={busy ? "Claiming refund" : "Claim refund"}
              onClick={claim}
            >
              {busy ? "…" : "Claim refund"}
            </button>
          </div>
        </>
      )}

      {market.status === "none" && (
        <button className="btn ghost" style={{ marginTop: 11 }} disabled>
          opens at kick-off
        </button>
      )}

      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
    </div>
  );
}
