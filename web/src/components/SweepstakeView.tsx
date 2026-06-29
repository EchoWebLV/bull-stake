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
  const [openTicket, setOpenTicket] = useState<number | null>(null); // nonce expanded to show picks

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
      // Each ticket is a distinct on-chain Entry keyed by nonce. Use the next
      // free nonce so a NEW ticket is created (re-using a nonce edits in place).
      const nextNonce = entries.length ? Math.max(...entries.map((e) => e.nonce)) + 1 : 0;
      const orderedPicks = card.map((m) => picks[m.fixtureId]);
      const tx = await buildEnterTx(address, contestId, nextNonce, orderedPicks);
      const sig = await signAndSend(tx);
      flash(`Ticket #${nextNonce} entered · ${sig.slice(0, 8)}…`);
      setPicks({}); // clear the card so the next ticket is a fresh pick
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
          <div className="card-title">Your tickets ({entries.length})</div>
          {entries.map((e) => {
            const open = openTicket === e.nonce;
            return (
              <div key={e.pubkey} className="contest-ticket-group">
                <div className="contest-ticket">
                  <button
                    className="ticket-head"
                    aria-expanded={open}
                    onClick={() => setOpenTicket(open ? null : e.nonce)}
                  >
                    <span className="ticket-caret">{open ? "▾" : "▸"}</span>
                    Ticket #{e.nonce} · {fmtSol(Number(e.amount))}{SOL}
                  </button>
                  {settled && (
                    <span className={`ticket-status ${today.status === "voided" ? "refund" : e.won ? "won" : "lost"}`}>
                      {today.status === "voided"
                        ? "Refund due"
                        : e.won
                          ? <>Won {fmtSol(Number(e.payout))}{SOL}</>
                          : "No win"}
                    </span>
                  )}
                  {/* Only winners (or void refunds) get a claim button — a loser's
                      claim is a 0-payout close that just wastes a tx fee. */}
                  {e.claimable && (
                    <button className="btn-sm" disabled={busy} onClick={() => claim(e.nonce)}>
                      {today.status === "voided" ? "Refund" : "Claim"}
                    </button>
                  )}
                </div>
                {open && (
                  <ul className="ticket-picks">
                    {card.map((m, i) => {
                      const pick = e.picks[i];
                      const cls = pick === 0 ? "home" : pick === 1 ? "draw" : "away";
                      return (
                        <li key={m.fixtureId}>
                          <span className="muted">{m.home} <span className="vs">v</span> {m.away}</span>
                          <span className={`pick-val pick-${cls}`}>{outcomeLabel(pick, m.home, m.away)}</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
