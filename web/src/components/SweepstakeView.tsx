import { useEffect, useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildEnterTx, buildClaimContestTx } from "../lib/anchorClient.ts";
import {
  getContestLive, getJackpot, getContestEntries,
  type ContestLive, type ContestEntry, type ParlayLeg,
} from "../lib/api.ts";
import { SOL, fmtSol } from "../lib/odds.ts";
import { OverUnderSelector } from "./OverUnderSelector.tsx";

const OUTCOME_CLASS = ["home", "draw", "away"] as const;

/** 3-way label: home / Draw / away. */
function resultLabel(bucket: number, home: string, away: string): string {
  return bucket === 0 ? home : bucket === 1 ? "Draw" : away;
}
/** 2-way label: Over / Under (line shown alongside in the leg row). */
function overUnderLabel(bucket: number): string {
  return bucket === 0 ? "Over" : "Under";
}

/** Pick the right per-leg labeler off the leg's bucket count. */
export function legPickLabel(leg: ParlayLeg, bucket: number, home: string, away: string): string {
  return leg.numBuckets === 2 ? overUnderLabel(bucket) : resultLabel(bucket, home, away);
}

/** CSS class for a settled pick value, off the leg's bucket count. */
function legPickClass(leg: ParlayLeg, bucket: number): string {
  if (leg.numBuckets === 2) return bucket === 0 ? "home" : "away";
  return OUTCOME_CLASS[bucket] ?? "draw";
}

function fmtKickoff(ms: number | null): string {
  if (ms == null) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      weekday: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}

/**
 * One parlay card: a single match with 4 fixed legs ([16,15,12,11]). Owns its
 * own pick/ticket/busy state so 1–3 cards on screen never share state. Picks are
 * keyed by LEG INDEX (0..3) — every leg shares the same fixtureId, so fixtureId
 * cannot key them.
 */
function ParlayCard({
  contest, entries, address, signAndSend, onChanged,
}: {
  contest: ContestLive;
  entries: ContestEntry[];
  address: string | undefined;
  signAndSend: (tx: import("@solana/web3.js").Transaction) => Promise<string>;
  onChanged: () => void;
}) {
  const [picks, setPicks] = useState<Record<number, number>>({}); // legIndex → bucket
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);
  const [openTicket, setOpenTicket] = useState<number | null>(null);

  function flash(t: string, err = false) { setMsg(t); setMsgErr(err); }

  const { contestId, legs, match } = contest;
  const { home, away } = match;
  const settled = contest.status === "settled" || contest.status === "rolledOver" || contest.status === "voided";
  const voided = contest.status === "voided";
  const allPicked = legs.every((_, i) => picks[i] != null);
  const entryPriceSol = fmtSol(Number(contest.entryPrice ?? 0));

  async function enter() {
    if (!address) { flash("Log in to enter", true); return; }
    if (!allPicked) { flash("Pick every leg", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      // Each ticket is a distinct on-chain Entry keyed by nonce. Use the next
      // free nonce so a NEW ticket is created (re-using a nonce edits in place).
      const nextNonce = entries.length ? Math.max(...entries.map((e) => e.nonce)) + 1 : 0;
      const orderedPicks = legs.map((_, i) => picks[i]); // padded to 5 inside buildEnterTx
      const tx = await buildEnterTx(address, contestId, nextNonce, orderedPicks);
      const sig = await signAndSend(tx);
      flash(`Ticket #${nextNonce} entered · ${sig.slice(0, 8)}…`);
      setPicks({}); // clear so the next ticket is a fresh pick
      onChanged();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function claim(nonce: number) {
    if (!address) return;
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimContestTx(address, contestId, nonce);
      const sig = await signAndSend(tx);
      flash(`Claimed · ${sig.slice(0, 8)}…`);
      onChanged();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  const kickoff = fmtKickoff(match.kickoffMs);

  return (
    <div className="card">
      <div className="card-title">
        {home} <span className="muted">v</span> {away}
        {kickoff && <span className="muted" style={{ fontWeight: 400, marginLeft: 8 }}>{kickoff}</span>}
      </div>

      {legs.map((leg, i) => {
        const winner = settled ? leg.winningBucket : undefined;
        return (
          <div key={i} className="contest-row">
            <div className="contest-teams">{leg.label}</div>
            {leg.numBuckets === 2 ? (
              <OverUnderSelector
                value={picks[i]}
                onPick={(b) => setPicks((p) => ({ ...p, [i]: b }))}
                line={leg.line ?? 0}
                disabled={settled}
                winningBucket={settled ? leg.winningBucket : null}
              />
            ) : (
              <div className="result3">
                {[0, 1, 2].map((b) => {
                  const sel = picks[i] === b;
                  const won = settled && winner === b;
                  return (
                    <button
                      key={b}
                      className={`r3 r3-${OUTCOME_CLASS[b]}${sel ? " sel" : ""}${won ? " won" : ""}`}
                      aria-pressed={!settled ? sel : undefined}
                      disabled={settled}
                      onClick={() => !settled && setPicks((p) => ({ ...p, [i]: b }))}
                    >
                      <span className="r3-team">{won ? "✓ " : ""}{resultLabel(b, home, away)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {!settled && (
        <button className="btn" disabled={busy || !allPicked} aria-busy={busy} onClick={enter} style={{ marginTop: 12 }}>
          {busy ? "…" : `Enter — ${entryPriceSol} ${SOL}`}
        </button>
      )}
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}

      {entries.length > 0 && (
        <div className="contest-tickets" style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <div className="card-title" style={{ fontSize: 13 }}>Your tickets ({entries.length})</div>
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
                    <span className={`ticket-status ${voided ? "refund" : e.won ? "won" : "lost"}`}>
                      {voided
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
                      {voided ? "Refund" : "Claim"}
                    </button>
                  )}
                </div>
                {open && (
                  <ul className="ticket-picks">
                    {legs.map((leg, i) => {
                      const pick = e.picks[i];
                      const cls = legPickClass(leg, pick);
                      return (
                        <li key={i}>
                          <span className="muted">{leg.label}</span>
                          <span className={`pick-val pick-${cls}`}>{legPickLabel(leg, pick, home, away)}</span>
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

export function SweepstakeView() {
  const { address, signAndSend } = usePrivySigner();
  const [live, setLive] = useState<ContestLive[]>();
  const [jackpot, setJackpot] = useState<string>("0");
  const [entries, setEntries] = useState<ContestEntry[]>([]);
  const [msg, setMsg] = useState<string>();

  async function refresh() {
    const [l, j] = await Promise.all([getContestLive(), getJackpot()]);
    setLive(l);
    setJackpot(j.pot);
    if (address && l.length) setEntries(await getContestEntries(address));
    else setEntries([]);
  }
  useEffect(() => { refresh().catch((e) => setMsg((e as Error).message)); }, [address]);

  if (!live) return <div className="card">Loading…</div>;

  return (
    <div className="sweepstake">
      <div className="card jackpot">
        <div className="jackpot-label">Jackpot</div>
        <div className="jackpot-pot">{fmtSol(Number(jackpot))}{SOL}</div>
        <div className="muted">
          {live.length ? `${live.length} live parlay${live.length === 1 ? "" : "s"}` : "Rolls forward"}
        </div>
      </div>

      {live.length === 0 ? (
        <div className="card">
          <div className="muted">No live parlays right now.</div>
        </div>
      ) : (
        live.map((c) => (
          <ParlayCard
            key={c.contestId}
            contest={c}
            entries={entries.filter((e) => e.contestId === c.contestId)}
            address={address}
            signAndSend={signAndSend}
            onChanged={() => { refresh().catch((e) => setMsg((e as Error).message)); }}
          />
        ))
      )}

      {msg && <p className="msg err" role="status" aria-live="polite">{msg}</p>}
    </div>
  );
}
