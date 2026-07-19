import { useEffect, useState } from "react";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildEnterTx, buildClaimContestTx } from "../lib/anchorClient.ts";
import {
  getCard, getContestLive, getContestEntries,
  type Card, type CardLeg, type ContestEntry, type ContestLive,
} from "../lib/api.ts";
import { SOL, fmtSol } from "../lib/odds.ts";
import { legLiveStatus, fmtLiveScore, fmtLivePhase } from "../lib/liveStatus.ts";
import { legRowLabel, legSummary } from "../lib/cardLegs.ts";

/* ──────────────────────────────────────────────────────────────────────────
 * Streak — ONE daily 6-leg perfect-parlay card.
 *
 * The engine serves a single card (`GET /api/card`). It is pick'em: choose one
 * option per leg; ALL legs must hit to win; perfect cards SPLIT the pot. No
 * per-leg odds are shown — it's all-or-nothing.
 *
 * card.legs arrive in ENGINE order (Result legs, then O/U legs) and the
 * on-chain `picks[]` / `winningBuckets[]` arrays are indexed by that same leg
 * index. We render legs GROUPED by fixture (a match's Result + O/U together)
 * but always carry each leg's ORIGINAL index so picks land at the right
 * on-chain slot. Picks are therefore keyed by leg index, never by fixtureId
 * (every leg of a single-match parlay shares one fixtureId).
 * ──────────────────────────────────────────────────────────────────────── */

type CardStatus = "empty" | "blank" | "filled" | "live" | "after";

/** A leg paired with its original engine index (the on-chain picks[] slot). */
interface IndexedLeg { leg: CardLeg; idx: number }
/** One match: all its legs grouped, in first-seen order. */
interface MatchGroup {
  fixtureId: number; home: string; away: string; kickoffTs: number | null;
  legs: IndexedLeg[];
}

/** Group card.legs by fixtureId (Result + O/U of the same match together),
 *  preserving each leg's ORIGINAL engine index (the on-chain picks[] slot), then
 *  order the groups by kickoff time (ascending) so matches read chronologically.
 *  Sorting groups never renumbers picks — each leg keeps its stored `idx`. */
function groupLegs(legs: CardLeg[]): MatchGroup[] {
  const order: number[] = [];
  const map = new Map<number, MatchGroup>();
  legs.forEach((leg, idx) => {
    let g = map.get(leg.fixtureId);
    if (!g) {
      g = { fixtureId: leg.fixtureId, home: leg.home, away: leg.away, kickoffTs: leg.kickoffTs, legs: [] };
      map.set(leg.fixtureId, g);
      order.push(leg.fixtureId);
    }
    g.legs.push({ leg, idx });
  });
  const groups = order.map((id) => map.get(id)!);
  // Chronological: earliest kickoff first; unknown kickoff (null) sorts last.
  // Stable within equal/unknown times via first-seen order (the `order` index).
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => {
      const ka = a.g.kickoffTs, kb = b.g.kickoffTs;
      if (ka == null && kb == null) return a.i - b.i;
      if (ka == null) return 1;
      if (kb == null) return -1;
      return ka - kb || a.i - b.i;
    })
    .map(({ g }) => g);
}

/** 3-way label (home / Draw / away) or 2-way (Over / Under) off the leg shape. */
function pickLabel(leg: CardLeg, bucket: number): string {
  if (leg.buckets === 2) return bucket === 0 ? "Over" : "Under";
  return bucket === 0 ? leg.home : bucket === 1 ? "Draw" : leg.away;
}
/** CSS tint class for a settled/locked pick value. */
function pickTint(leg: CardLeg, bucket: number): "home" | "away" | "draw" {
  if (leg.buckets === 2) return bucket === 0 ? "home" : "away";
  return bucket === 0 ? "home" : bucket === 1 ? "draw" : "away";
}

/** Short kickoff clock, e.g. "19:00" (seconds → local HH:MM). "" if unknown. */
function fmtKick(tsSec: number | null): string {
  if (tsSec == null) return "";
  try {
    return new Date(tsSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

/** Coarse countdown to a future seconds timestamp: "4h 12m" / "12m" / "soon". */
function countdown(tsSec: number, nowMs: number): string {
  const ms = tsSec * 1000 - nowMs;
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "soon";
}

/** Pot-hero footer cycle line. Open cards advertise the lock time + 24h cadence;
 *  a locked card drops the (now-blank) "locks …" clause entirely. */
function potCycle(card: Card, locked: boolean): string {
  if (locked) return "locked · settles when the last match ends";
  const at = fmtKick(card.lockTs);
  const lock = at ? `locks ${at}` : "locks soon";
  return `${lock} · settles when the last match ends · fresh card every 24h`;
}

/** Pot hero (orange). Headline = pot + jackpot (what's actually up for grabs);
 *  a seeded jackpot surfaces even with few entries. */
function PotHero({ card, locked = false }: { card: Card; locked?: boolean }) {
  const jackpot = Number(card.jackpot);
  const upForGrabs = Number(card.pot) + jackpot; // lamports; total prize on the line
  return (
    <div className="pot-hero">
      <div className="pot-lab">Tonight's pot</div>
      <div className="pot-big tnum">{fmtSol(upForGrabs)}{SOL}</div>
      <div className="pot-sub">Pick all 6 right across today's matches to split it.</div>
      {jackpot > 0 && (
        <div className="pot-jackpot">includes {fmtSol(card.jackpot)}{SOL} rolled over</div>
      )}
      <div className="pot-cyc">{potCycle(card, locked)}</div>
    </div>
  );
}

/** Brief "settled on-chain" trust line, mirrors the mockups' footer. */
function CardFoot() {
  return <div className="card-foot"><span className="dia">◆</span> Settled on-chain · TxLINE proofs</div>;
}

// ── State 2: BLANK card (option buttons grouped by match) ──────────────────
function BlankCard({
  card, groups, address, signAndSend, onEntered,
}: {
  card: Card; groups: MatchGroup[];
  address: string | undefined;
  signAndSend: (tx: import("@solana/web3.js").Transaction) => Promise<string>;
  onEntered: () => void;
}) {
  const { login } = useLogin();
  const [picks, setPicks] = useState<Record<number, number>>({}); // legIndex → bucket
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);
  function flash(t: string, err = false) { setMsg(t); setMsgErr(err); }

  const total = card.legs.length;
  const made = card.legs.reduce((n, _l, i) => n + (picks[i] != null ? 1 : 0), 0);
  const allPicked = made === total && total > 0;
  const priceSol = fmtSol(card.entryPrice);

  async function lockIn() {
    if (!address) { login(); return; }
    if (!allPicked) { flash("Pick every leg", true); return; }
    setBusy(true); setMsg(undefined);
    try {
      // Fresh ticket: existing entries determine the next free nonce so a NEW
      // Entry PDA is created (re-using a nonce edits in place).
      const existing = await getContestEntries(address, card.contestId);
      const nonce = existing.length ? Math.max(...existing.map((e) => e.nonce)) + 1 : 0;
      const ordered = card.legs.map((_l, i) => picks[i]); // padded to MAX_LEGS in builder
      const tx = await buildEnterTx(address, card.contestId, nonce, ordered);
      const sig = await signAndSend(tx);
      flash(`Locked in · ${sig.slice(0, 8)}…`);
      onEntered();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="daystrip">
        <span className="l"><span className="dot" /> Today's card</span>
        <span className="r">locks in {countdown(card.lockTs, Date.now())}</span>
      </div>

      <PotHero card={card} />

      <div className="section">
        <h3>Make your picks</h3>
        <span className="tag tnum">{made} / {total}</span>
      </div>
      <div className="leg-summary">{legSummary(card.legs)}</div>

      <div className="card">
        <div className="prog"><div className="prog-f" style={{ width: `${total ? (made / total) * 100 : 0}%` }} /></div>
        <div className="prog-cap">Tap one option in each row · all {total} must land to win.</div>

        {groups.map((g) => (
          <div key={g.fixtureId} className="mg">
            <div className="mg-head">
              <span className="mg-team"><span className="mg-kx" />{g.home} <span className="muted">v</span> {g.away}</span>
              <span className="mg-ko">{fmtKick(g.kickoffTs)}</span>
            </div>

            {g.legs.map(({ leg, idx }) => (
              <OptionRow
                key={idx}
                label={legRowLabel(leg)}
                leg={leg}
                value={picks[idx]}
                onPick={(b) => setPicks((p) => ({ ...p, [idx]: b }))}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="hint">One pick per row · all {total} must land to win · {priceSol} {SOL} to enter</div>

      <button
        className={`cta${allPicked ? "" : " cta-off"}`}
        disabled={busy || (!!address && !allPicked)}
        aria-busy={busy}
        onClick={lockIn}
      >
        {busy ? "…" : !address ? "Log in to play" : allPicked ? `Lock in · ${priceSol} ${SOL}` : `Pick all ${total} to lock in`}
      </button>
      <div className="cta-sub">Everyone starts fresh today — no streak, no catch-up. Just tonight.</div>
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      <CardFoot />
    </>
  );
}

/** One market = a label + a row of option buttons (3-way result or 2-way O/U). */
function OptionRow({
  label, leg, value, onPick,
}: { label: string; leg: CardLeg; value: number | undefined; onPick: (b: number) => void }) {
  const buckets = leg.buckets === 2 ? [0, 1] : [0, 1, 2];
  return (
    <div className="mk">
      <div className="mk-lab">{label}</div>
      <div className="opts">
        {buckets.map((b) => {
          const sel = value === b;
          return (
            <button
              key={b}
              className={`opt opt-${pickTint(leg, b)}${sel ? " sel" : ""}`}
              aria-pressed={sel}
              onClick={() => onPick(b)}
            >
              {pickLabel(leg, b)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── State 3 + 4: FILLED (locked-in, pre-kick) / LIVE (matches playing) ──────
function PicksCard({
  card, groups, entry, contestLive, mode,
}: {
  card: Card; groups: MatchGroup[]; entry: ContestEntry;
  contestLive: ContestLive | undefined; mode: "filled" | "live";
}) {
  const live = mode === "live";
  return (
    <>
      <div className="daystrip">
        <span className="l">
          {live ? <span className="livepill"><span className="b" /> LIVE</span> : <><span className="dot" /> You're in</>}
        </span>
        <span className="r">
          {live ? "locked — awaiting full-time" : `locks in ${countdown(card.lockTs, Date.now())}`}
        </span>
      </div>

      <PotHero card={card} locked={live} />

      <div className="section">
        <h3>Your card</h3>
        <span className="tag">{live ? "card locked" : `you're in · ${card.legs.length} / ${card.legs.length}`}</span>
      </div>
      <div className="leg-summary">{legSummary(card.legs)}</div>

      <div className="card">
        {groups.map((g) => (
          <div key={g.fixtureId} className="mg">
            <div className="mg-head">
              <span className="mg-team"><span className="mg-kx" />{g.home} <span className="muted">v</span> {g.away}</span>
              <span className="mg-ko">{fmtKick(g.kickoffTs)}</span>
            </div>
            <div className="mg-picks">
              {g.legs.map(({ leg, idx }) => {
                const pick = entry.picks[idx];
                const wb = contestLive?.legs[idx]?.winningBucket ?? null;
                const settledLeg = wb != null;
                const hit = settledLeg && wb === pick;
                const rowLabel = legRowLabel(leg);
                // Live drama: on-chain settlement is authoritative; else fall back
                // to the in-play `live` block (score → on-track/trailing/at-risk).
                const ls = !settledLeg && live && leg.live ? legLiveStatus(leg.buckets, pick, leg.live) : null;
                const tone = settledLeg ? (hit ? "good" : "bad") : ls?.tone ?? "neutral";
                const statusText = settledLeg
                  ? (hit ? "✓ hit" : "missed")
                  : ls
                    ? (ls.final ? (ls.tone === "good" ? "✓ hit" : "missed") : ls.label)
                    : live ? "awaiting FT" : "locked";
                return (
                  <div key={idx} className="pr">
                    <span className="pr-lab">{rowLabel}</span>
                    <span className="pr-right">
                      <span className={`pr-pick pick-${pickTint(leg, pick)}`}>
                        {pickLabel(leg, pick)}
                      </span>
                      {leg.live && (leg.live.phase !== "pre") && (
                        <span className={`pr-live tone-${tone}`}>
                          <b className="tnum">{fmtLiveScore(leg.live)}</b>
                          <span className="pr-min">{fmtLivePhase(leg.live)}</span>
                        </span>
                      )}
                      <span className={`pr-status tone-${tone}`}>{statusText}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="locked-note">Card locked · no more changes</div>
      <CardFoot />
    </>
  );
}

// ── State 5: AFTER (settled) — perfect → claim; else "so close" ────────────
function AfterCard({
  card, groups, entry, contestLive, address, signAndSend, onClaimed,
}: {
  card: Card; groups: MatchGroup[]; entry: ContestEntry; contestLive: ContestLive | undefined;
  address: string; // the logged-in wallet = the entry owner / claim signer
  signAndSend: (tx: import("@solana/web3.js").Transaction) => Promise<string>;
  onClaimed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);

  const perfect = entry.won;
  const total = card.legs.length;
  const hits = card.legs.reduce((n, _l, i) => {
    const wb = contestLive?.legs[i]?.winningBucket ?? null;
    return n + (wb != null && wb === entry.picks[i] ? 1 : 0);
  }, 0);

  async function doClaim() {
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimContestTx(address, card.contestId, entry.nonce);
      const sig = await signAndSend(tx);
      setMsg(`Claimed · ${sig.slice(0, 8)}…`); setMsgErr(false);
      onClaimed();
    } catch (e) { setMsg((e as Error).message); setMsgErr(true); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="daystrip">
        <span className="l">Tonight's result · final</span>
        <span className="r">{perfect ? "you won" : "settled"}</span>
      </div>

      {perfect ? (
        <div className="win-hero">
          <div className="win-trophy">★</div>
          <div className="win-perfect">PERFECT CARD · {hits} / {total}</div>
          <div className="win-won">You won</div>
          <div className="win-amt tnum">{fmtSol(entry.payout)}{SOL}</div>
          <div className="win-split">
            split {contestLive?.perfectCount ?? "—"} way{(contestLive?.perfectCount ?? 0) === 1 ? "" : "s"} · pot was {fmtSol(card.pot)}{SOL}
          </div>
        </div>
      ) : (
        <div className="close-hero">
          <div className="close-emoji">—</div>
          <div className="close-title">So close</div>
          <div className="close-sub tnum">{hits} / {total} hit</div>
          <div className="close-note">A perfect card splits the pot. New card drops tomorrow.</div>
        </div>
      )}

      <div className="section">
        <h3>Your card · settled</h3>
        <span className="tag tnum">{hits} / {total} hit</span>
      </div>
      <div className="leg-summary">{legSummary(card.legs)}</div>

      <div className="card">
        {groups.map((g) => (
          <div key={g.fixtureId} className="mg">
            <div className="mg-head">
              <span className="mg-team"><span className="mg-kx" />{g.home} <span className="muted">v</span> {g.away}</span>
              <span className="mg-ko">{fmtKick(g.kickoffTs)}</span>
            </div>
            <div className="mg-picks">
              {g.legs.map(({ leg, idx }) => {
                const pick = entry.picks[idx];
                const wb = contestLive?.legs[idx]?.winningBucket ?? null;
                const hit = wb != null && wb === pick;
                const rowLabel = legRowLabel(leg);
                const finalScore = leg.live && leg.live.phase === "ft" ? fmtLiveScore(leg.live) : null;
                return (
                  <div key={idx} className="pr">
                    <span className="pr-lt">
                      <span className={`pr-ic ${hit ? "hit" : "miss"}`}>{hit ? "✓" : "✕"}</span>
                      {rowLabel} · <b>{pickLabel(leg, pick)}</b>
                    </span>
                    <span className="pr-right">
                      {finalScore && <span className="pr-live tone-neutral"><b className="tnum">{finalScore}</b><span className="pr-min">FT</span></span>}
                      <span className={`pr-rt ${hit ? "hit" : "miss"}`}>{hit ? "hit" : "missed"}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {entry.claimable ? (
        <>
          <button className="cta cta-win" disabled={busy} aria-busy={busy} onClick={doClaim}>
            {busy ? "…" : `Claim ${fmtSol(entry.payout)}${SOL} →`}
          </button>
        </>
      ) : (
        <div className="cta-sub" style={{ marginTop: 14 }}>
          {perfect ? "Payout claimed." : "New card drops tomorrow — come back."}
        </div>
      )}
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      <CardFoot />
    </>
  );
}

export function SweepstakeView() {
  const { ready, authenticated } = usePrivy();
  const { address, signAndSend } = usePrivySigner();

  const [card, setCard] = useState<Card | null | undefined>(undefined); // undefined = loading
  const [contestLive, setContestLive] = useState<ContestLive>();
  const [entry, setEntry] = useState<ContestEntry>();
  const [msg, setMsg] = useState<string>();
  const [nowMs, setNowMs] = useState(Date.now());

  async function refresh() {
    const c = await getCard();
    setCard(c);
    if (!c) { setContestLive(undefined); setEntry(undefined); return; }
    // ContestLive carries per-leg winningBucket (settled) + perfectCount for the
    // AFTER state; /api/card omits them. Join by contestId (best-effort).
    try {
      const lives = await getContestLive();
      setContestLive(lives.find((l) => l.contestId === c.contestId));
    } catch { setContestLive(undefined); }
    // The user's ticket for THIS card. With multiple tickets, surface the one
    // that matters: a claimable winner first, then any won ticket, else the
    // newest nonce (the latest picks for a still-open/live card).
    if (address) {
      const es = await getContestEntries(address, c.contestId);
      const pick =
        es.find((e) => e.claimable) ??
        es.find((e) => e.won) ??
        (es.length ? es.reduce((a, b) => (b.nonce > a.nonce ? b : a)) : undefined);
      setEntry(pick);
    } else {
      setEntry(undefined);
    }
  }

  useEffect(() => { refresh().catch((e) => setMsg((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [address]);
  // Tick the clock so the lock countdown + state transitions stay live.
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 30_000); return () => clearInterval(t); }, []);

  if (card === undefined || !ready) return <div className="card empty-card">Loading today's card…</div>;

  // State 1: no card today.
  if (card === null) {
    return (
      <div className="card empty-card">
        <div style={{ fontSize: 28, marginBottom: 8 }}>🌙</div>
        No card today — a fresh 6-leg card drops every 24h. Check back soon.
      </div>
    );
  }

  const groups = groupLegs(card.legs);
  const settled = card.status === "settled" || card.status === "rolledOver" || card.status === "voided";
  const locked = nowMs >= card.lockTs * 1000;

  // Resolve the state machine.
  let status: CardStatus;
  if (settled) status = "after";
  else if (locked) status = "live";
  else if (entry && authenticated) status = "filled";
  else status = "blank";

  return (
    <div className="sweepstake">
      {status === "blank" && (
        <BlankCard
          card={card} groups={groups} address={address} signAndSend={signAndSend}
          onEntered={() => { refresh().catch((e) => setMsg((e as Error).message)); }}
        />
      )}
      {status === "filled" && entry && (
        <PicksCard card={card} groups={groups} entry={entry} contestLive={contestLive} mode="filled" />
      )}
      {status === "live" && (
        entry
          ? <PicksCard card={card} groups={groups} entry={entry} contestLive={contestLive} mode="live" />
          : <LiveNoEntry card={card} groups={groups} />
      )}
      {status === "after" && (
        entry && address
          ? <AfterCard
              card={card} groups={groups} entry={entry} contestLive={contestLive}
              address={address} signAndSend={signAndSend}
              onClaimed={() => { refresh().catch((e) => setMsg((e as Error).message)); }}
            />
          : <AfterNoEntry card={card} groups={groups} contestLive={contestLive} />
      )}

      {msg && <p className="msg err" role="status" aria-live="polite">{msg}</p>}
    </div>
  );
}

/** LIVE but the viewer didn't enter (or is logged out): read-only leg list.
 *  Every leg is its own row (the card is a 6-leg parlay — never collapse a match
 *  to one line). Live scores are shown to everyone; per-leg PICK status is not
 *  (no entry) — each row just carries the match's neutral live phase. */
function LiveNoEntry({ card, groups }: { card: Card; groups: MatchGroup[] }) {
  return (
    <>
      <div className="daystrip">
        <span className="l"><span className="livepill"><span className="b" /> LIVE</span></span>
        <span className="r">today's card is locked</span>
      </div>
      <PotHero card={card} locked />
      <div className="section"><h3>Today's card</h3><span className="tag">locked</span></div>
      <div className="leg-summary">{legSummary(card.legs)}</div>
      <div className="card">
        {groups.map((g) => {
          // Both legs of a fixture share one score; take the first live block.
          const live = g.legs.find((l) => l.leg.live)?.leg.live;
          const playing = live && live.phase !== "pre";
          return (
            <div key={g.fixtureId} className="mg">
              <div className="mg-head">
                <span className="mg-team"><span className="mg-kx" />{g.home} <span className="muted">v</span> {g.away}</span>
                {playing
                  ? <span className="mg-score tnum">{fmtLiveScore(live!)} <span className="pr-min">{fmtLivePhase(live!)}</span></span>
                  : <span className="mg-ko">{fmtKick(g.kickoffTs)}</span>}
              </div>
              <div className="mg-picks">
                {g.legs.map(({ leg, idx }) => {
                  const phaseWord = live?.phase === "ft" ? "full-time" : playing ? "in play" : "awaiting kickoff";
                  return (
                    <div key={idx} className="pr">
                      <span className="pr-lab">{legRowLabel(leg)}</span>
                      <span className="pr-status tone-neutral">{phaseWord}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="locked-note">🔒 Entries closed · settles when the last match ends</div>
      <CardFoot />
    </>
  );
}

/** SETTLED but the viewer didn't enter: show what the winning card was. */
function AfterNoEntry({
  card, groups, contestLive,
}: { card: Card; groups: MatchGroup[]; contestLive: ContestLive | undefined }) {
  return (
    <>
      <div className="daystrip">
        <span className="l">Tonight's result · final</span>
        <span className="r">settled</span>
      </div>
      <div className="section"><h3>Winning card</h3><span className="tag">settled on-chain</span></div>
      <div className="leg-summary">{legSummary(card.legs)}</div>
      <div className="card">
        {groups.map((g) => {
          const live = g.legs.find((l) => l.leg.live)?.leg.live;
          const finalScore = live && live.phase === "ft" ? fmtLiveScore(live) : null;
          return (
            <div key={g.fixtureId} className="mg">
              <div className="mg-head">
                <span className="mg-team"><span className="mg-kx" />{g.home} <span className="muted">v</span> {g.away}</span>
                {finalScore
                  ? <span className="mg-score tnum">{finalScore} <span className="pr-min">FT</span></span>
                  : <span className="mg-ko">{fmtKick(g.kickoffTs)}</span>}
              </div>
              <div className="mg-picks">
                {g.legs.map(({ leg, idx }) => {
                  const wb = contestLive?.legs[idx]?.winningBucket ?? null;
                  return (
                    <div key={idx} className="pr">
                      <span className="pr-lab">{legRowLabel(leg)}</span>
                      <span className={`pr-pick pick-${wb != null ? pickTint(leg, wb) : "draw"}`}>
                        {wb != null ? pickLabel(leg, wb) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="cta-sub" style={{ marginTop: 14 }}>You sat this one out. New card drops tomorrow.</div>
      <CardFoot />
    </>
  );
}
