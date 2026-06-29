import { useEffect, useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildEnterTx, buildClaimContestTx } from "../lib/anchorClient.ts";
import { getContestToday, getContestEntries, type ContestToday, type ContestEntry } from "../lib/api.ts";
import { SOL, fmtSol } from "../lib/odds.ts";

const OUTCOME_CLASS = ["home", "draw", "away"] as const;
function outcomeLabel(idx: number, home: string, away: string): string {
  return idx === 0 ? home : idx === 1 ? "Draw" : away;
}

export function SweepstakeView() {
  const { address, signAndSend } = usePrivySigner();
  const [today, setToday] = useState<ContestToday>();
  const [entries, setEntries] = useState<ContestEntry[]>([]);
  const [picks, setPicks] = useState<Record<number, number>>({}); // fixtureId → bucket
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);

  function flash(t: string, err = false) { setMsg(t); setMsgErr(err); }

  async function refresh() {
    const t = await getContestToday();
    setToday(t);
    if (address && t.status !== "paused") setEntries(await getContestEntries(address));
    else setEntries([]);
  }
  useEffect(() => { refresh().catch((e) => flash((e as Error).message, true)); }, [address]);

  if (!today) return <div className="card">Loading…</div>;

  if (today.status === "paused") {
    return (
      <div className="card jackpot">
        <div className="jackpot-pot">{fmtSol(Number(today.pot))}{SOL}</div>
        <div className="muted">No card today — the pot rolls forward.</div>
      </div>
    );
  }

  const card = today.card ?? [];
  const contestId = today.contestId;
  const settled = today.status === "settled" || today.status === "rolledOver" || today.status === "voided";
  const allPicked = card.every((m) => picks[m.fixtureId] != null);
  const entryPriceSol = fmtSol(Number(today.entryPrice ?? 0));

  async function enter() {
    if (!address) { flash("Log in to enter", true); return; }
    if (!allPicked) { flash("Pick every match", true); return; }
    if (contestId == null) { flash("No active contest", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      const orderedPicks = card.map((m) => picks[m.fixtureId]);
      const tx = await buildEnterTx(address, contestId, 0, orderedPicks);
      const sig = await signAndSend(tx);
      flash(`Entered · ${sig.slice(0, 8)}…`);
      await refresh();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function claim(nonce: number) {
    if (!address) return;
    if (contestId == null) { flash("No active contest", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimContestTx(address, contestId, nonce);
      const sig = await signAndSend(tx);
      flash(`Claimed · ${sig.slice(0, 8)}…`);
      await refresh();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  return (
    <div className="sweepstake">
      <div className="card jackpot">
        <div className="jackpot-label">Daily Jackpot</div>
        <div className="jackpot-pot">{fmtSol(Number(today.pot))}{SOL}</div>
        <div className="muted">
          {settled ? "Settled" : `Locks soon · ${today.entryCount ?? 0} entries`}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Today's card</div>
        {card.map((m, i) => {
          const winner = settled ? today.winningBuckets?.[i] : undefined;
          return (
            <div key={m.fixtureId} className="contest-row">
              <div className="contest-teams">{m.home} <span className="muted">v</span> {m.away}</div>
              <div className="result3">
                {[0, 1, 2].map((b) => {
                  const sel = picks[m.fixtureId] === b;
                  const won = settled && winner === b;
                  return (
                    <button
                      key={b}
                      className={`r3 r3-${OUTCOME_CLASS[b]}${sel ? " sel" : ""}${won ? " won" : ""}`}
                      aria-pressed={!settled ? sel : undefined}
                      disabled={settled}
                      onClick={() => !settled && setPicks((p) => ({ ...p, [m.fixtureId]: b }))}
                    >
                      <span className="r3-team">{won ? "✓ " : ""}{outcomeLabel(b, m.home, m.away)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        {!settled && (
          <button className="btn" disabled={busy || !allPicked} aria-busy={busy} onClick={enter} style={{ marginTop: 12 }}>
            {busy ? "…" : `Enter — ${entryPriceSol} ${SOL}`}
          </button>
        )}
        {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      </div>

      {entries.length > 0 && (
        <div className="card">
          <div className="card-title">Your tickets</div>
          {entries.map((e) => (
            <div key={e.pubkey} className="contest-ticket">
              <span>Ticket #{e.nonce} · {fmtSol(Number(e.amount))}{SOL}</span>
              {settled && (
                <button className="btn-sm" disabled={busy} onClick={() => claim(e.nonce)}>
                  {today.status === "voided" ? "Refund" : "Claim"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
