import { useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx } from "../lib/anchorClient.ts";
import type { LiveMarket } from "../lib/api.ts";
import { LAMPORTS, SOL, fmtMult, fmtSol, projectedPayout, buttonMultiplier } from "../lib/odds.ts";

/**
 * Three-way 1X2 result control over a single shared-pool market (num_buckets 3):
 * HOME (0) / DRAW (1) / AWAY (2). Because the three outcomes share one pool,
 * staking any one moves all three multipliers — a true parimutuel 1X2.
 */
export function ResultSelector({
  fixtureId, home, away, market,
}: { fixtureId: number; home: string; away: string; market: LiveMarket }) {
  const { address, signAndSend } = usePrivySigner();
  const [sol, setSol] = useState("0.1");
  const [bucket, setBucket] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);

  const outcomes = [
    { bucket: 0, team: home, cls: "home" as const },
    { bucket: 1, team: "Draw", cls: "draw" as const },
    { bucket: 2, team: away, cls: "away" as const },
  ];

  const stakeNum = Number(sol);
  const stakeLamports = Number.isFinite(stakeNum) && stakeNum > 0 ? Math.round(stakeNum * LAMPORTS) : 0;

  const settled = market.status === "settled";
  const voided = market.status === "voided";
  const open = market.status === "open";
  const winnerBucket = settled ? market.winningBucket : null;
  const winnerTeam = winnerBucket == null ? null : outcomes[winnerBucket]?.team;

  const projected = bucket != null
    ? projectedPayout(market.bucketTotals.map(Number), bucket, stakeLamports)
    : 0;
  const selTeam = bucket != null ? outcomes[bucket]?.team : null;

  function flash(t: string, err = false) { setMsg(t); setMsgErr(err); }

  async function placeBet() {
    if (!address) { flash("Log in to place a bet", true); return; }
    if (bucket == null) { flash("Pick an outcome", true); return; }
    if (stakeLamports <= 0) { flash("Enter a valid amount", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildPlaceBetTx(address, fixtureId, market.marketId, bucket, BigInt(stakeLamports));
      const sig = await signAndSend(tx);
      flash(`Bet placed · ${sig.slice(0, 8)}…`);
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  return (
    <div className="market">
      <div className="result3">
        {outcomes.map((o) => {
          const won = settled && winnerBucket === o.bucket;
          const lost = settled && !won;
          const selected = bucket === o.bucket;
          const mult = buttonMultiplier(market.bucketTotals, o.bucket, stakeLamports, market.odds[o.bucket] ?? 0);
          return (
            <button
              key={o.cls}
              className={`r3 r3-${o.cls}${selected ? " sel" : ""}${won ? " won" : ""}${lost ? " lost" : ""}`}
              aria-pressed={open ? selected : undefined}
              disabled={!open}
              onClick={() => open && setBucket(o.bucket)}
            >
              <span className="r3-team">{won ? "✓ " : ""}{o.team}</span>
              <span className="r3-mult">{settled ? (won ? "Winner" : "—") : fmtMult(mult)}</span>
            </button>
          );
        })}
      </div>

      {open && (
        <>
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
          {bucket != null && stakeLamports > 0 && (
            <div className="payout-hint">
              <span>{fmtSol(stakeLamports)}{SOL} on {selTeam}</span>
              <span>→ <b>~{fmtSol(projected)}{SOL}</b> if it wins</span>
            </div>
          )}
        </>
      )}

      {!open && (
        <div className="result-settled muted">
          {winnerTeam ? (
            <>Settled · winner <b style={{ color: "var(--green)" }}>{winnerTeam}</b> — claim in My Bets</>
          ) : voided ? (
            <>Match voided — refund in My Bets</>
          ) : (
            <>Settling…</>
          )}
        </div>
      )}

      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
    </div>
  );
}
