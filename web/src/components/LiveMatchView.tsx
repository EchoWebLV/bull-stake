import { useEffect, useMemo, useState } from "react";
import { snapshotFromChain, SCORING_HINT, type GameSnapshot } from "../lib/liveGame.ts";
import { useLivePool } from "../lib/useLivePool.ts";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import {
  buildJoinLivePoolTx, buildClaimLivePoolTx, buildLockPickTx,
} from "../lib/livePoolClient.ts";
import { poolIsClaimable, isWinner } from "../lib/api.ts";

/* ──────────────────────────────────────────────────────────────────────────
 * Streak — Live match game (home tab).
 *
 * The centerpiece, now backed by REAL on-chain authority: `useLivePool` polls
 * the LivePool + this wallet's seat every 2s; `snapshotFromChain` maps that into
 * the render view-model. No sim, no RNG — what you see is what the chain returns.
 *
 * A 150ms `nowMs` heartbeat drives ONLY the call countdown so it animates smoothly
 * between the 2s polls (it does not fabricate match progress).
 *
 * Phase A: taps go through base-layer `lock_pick` (player signs → a wallet popup
 * per tap). Join/claim are base-layer too. Gasless taps are Phase B.
 * ──────────────────────────────────────────────────────────────────────── */

export function LiveMatchView() {
  const { address, signAndSend } = usePrivySigner();
  const { data, entry, refresh } = useLivePool(address ?? null);

  // Heartbeat: bump nowMs 150ms so the countdown ticks between 2s polls.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 150);
    return () => clearInterval(id);
  }, []);

  const snap = useMemo(
    () => snapshotFromChain(data, entry, address ?? null, nowMs),
    [data, entry, address, nowMs],
  );

  const [busy, setBusy] = useState<string>("");
  const [flashMsg, setFlashMsg] = useState<string>("");
  const flash = (msg: string) => setFlashMsg(msg);

  const pool = data?.pool ?? null;
  const openCall = data?.openCall ?? null;

  const joinable =
    !!address && !entry && pool?.status === "open" && nowMs < pool.lockTs * 1000;
  const claimable = !!entry && !!pool && poolIsClaimable(pool);
  const canTap = !!address && !!entry && snap.call?.phase === "answer";

  async function onJoin() {
    if (!address || !pool) return;
    setBusy("join"); flash("");
    try {
      const tx = await buildJoinLivePoolTx(address, pool.poolId);
      await signAndSend(tx);
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Join failed");
    } finally {
      setBusy("");
    }
  }

  async function onTap(k: string) {
    if (!address || !pool || !openCall) return;
    if (!entry) { flash("Join the pool to make calls."); return; }
    setBusy("tap"); flash("");
    try {
      const tx = await buildLockPickTx(address, pool.poolId, openCall.seq, Number(k));
      await signAndSend(tx);
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Tap failed");
    } finally {
      setBusy("");
    }
  }

  async function onClaim() {
    if (!address || !pool) return;
    setBusy("claim"); flash("");
    try {
      const tx = await buildClaimLivePoolTx(address, pool.poolId);
      await signAndSend(tx);
      await refresh();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setBusy("");
    }
  }

  const { match, score, call, feed, standings, over } = snap;
  const claimLabel =
    pool && entry && isWinner(pool, entry) ? "Claim winnings ▸"
      : pool?.status === "voided" ? "Claim refund ▸"
        : "Close seat ▸";

  return (
    <div className="livegame">
      {over && (
        <div className="lg-over show">
          <div className="lg-over-ttl">{over.title}</div>
          <div className="lg-over-big tnum">{over.big}</div>
          <div className="lg-over-sub">{over.lines.map((l, i) => <div key={i}>{l}</div>)}</div>
          {claimable && (
            <button className="lg-over-btn" onClick={onClaim} disabled={!!busy}>
              {busy === "claim" ? "Claiming…" : claimLabel}
            </button>
          )}
        </div>
      )}

      {flashMsg && <div className="lg-toast lg-go" key={flashMsg}>{flashMsg}</div>}

      <div className="lg-top">
        {joinable && (
          <button className="lg-cbtn" onClick={onJoin} disabled={!!busy}>
            {busy === "join" ? "Joining…" : `Join · ${snap.pool.entry}`}
          </button>
        )}
        {claimable && !over && (
          <button className="lg-cbtn" onClick={onClaim} disabled={!!busy}>
            {busy === "claim" ? "Claiming…" : "Claim"}
          </button>
        )}
      </div>

      <div className="lg-pool">
        <div>
          <div className="lg-pool-l">Prize pool</div>
          <div className="lg-pot tnum">{snap.pool.pot}</div>
        </div>
        <div className="lg-pool-r">
          <div><b className="tnum">{snap.pool.count}</b> in · {snap.pool.entry} each</div>
          <div>most points <b>wins it</b></div>
          <div className="lg-rank">{snap.pool.rank}</div>
        </div>
      </div>

      <div className="lg-match">
        <div className="lg-side">
          <span className="lg-crest" style={{ background: match.home.color }}>{match.home.code}</span>
          <span className="lg-cn">{match.home.name}</span>
        </div>
        <div className="lg-mid">
          <div className="lg-sc tnum"><span>{match.scH}</span>&nbsp;–&nbsp;<span>{match.scA}</span></div>
          <div className={`lg-min${match.paused ? " paused" : ""}`}><span className="lg-blip" /><span>{match.clock}</span></div>
        </div>
        <div className="lg-side away">
          <span className="lg-cn">{match.away.name}</span>
          <span className="lg-crest" style={{ background: match.away.color }}>{match.away.code}</span>
        </div>
      </div>

      <div className="lg-stats">
        <div className="lg-st"><div className="lg-v tnum">{match.shots}</div><div className="lg-k">Shots</div></div>
        <div className="lg-st"><div className="lg-v tnum">{match.corners}</div><div className="lg-k">Corners</div></div>
        <div className="lg-st"><div className="lg-v tnum">{match.cards}</div><div className="lg-k">Cards</div></div>
        <div className="lg-st"><div className="lg-v tnum">{match.poss}</div><div className="lg-k">Poss</div></div>
      </div>

      <div className="lg-srow">
        <span className={`lg-flame${score.flameHot ? " hot" : ""}`}>🔥</span>
        <span className="lg-sbig tnum" key={score.pointsSeq}>{score.pts}</span>
        <span className="lg-slab">pts</span>
        <span className="lg-pill">🔥 <b>{score.streak}</b></span>
        <span className={`lg-pill bonus${score.bonusZero ? " zero" : ""}`}>bonus <b>+{score.bonus}</b></span>
        <span className="lg-pill">events <b>{score.callsUsed}</b></span>
      </div>
      <div className="lg-run">
        {score.hist.map((h, i) => (
          <span key={i} className={`lg-rc ${h}`}>{h === "hit" ? "✓" : h === "miss" ? "✕" : "–"}</span>
        ))}
      </div>

      <CallCard call={call} over={!!over} live={!!pool} canTap={canTap} busy={busy === "tap"} onLock={onTap} />

      <div className="lg-sec"><span>Live feed</span></div>
      <div className="lg-feed">
        {feed.map((f, i) => (
          <div key={i} className={`lg-fe${f.big ? " big" : ""}`}>
            <span className="lg-fm">{f.min ? `${f.min}'` : ""}</span><span>{f.txt}</span>
          </div>
        ))}
      </div>

      <div className="lg-sec"><span>Pool standings — by points</span><span>{snap.players} players</span></div>
      <div className="lg-lb">
        {standings.map((p) => (
          <div key={p.rank} className={`lg-lbr${p.me ? " me" : ""}${p.lead ? " lead" : ""}`}>
            <span className="lg-r">{p.rank}</span><span className="lg-n">{p.name}</span><span className="lg-s">{p.pts} pts</span>
          </div>
        ))}
      </div>

      <div className="lg-hint">{SCORING_HINT}</div>
    </div>
  );
}

/** The active call: question, countdown bar, tap options, and post-resolve verdict. */
function CallCard({ call, over, live, canTap, busy, onLock }: {
  call: GameSnapshot["call"]; over: boolean; live: boolean;
  canTap: boolean; busy: boolean; onLock: (k: string) => void;
}) {
  if (!live) {
    return <div className="lg-call idle"><div className="lg-idlemsg">No live game right now.</div></div>;
  }
  if (!call) {
    return <div className="lg-call idle"><div className="lg-idlemsg">{over ? "Full-time…" : "Waiting for the next call…"}</div></div>;
  }
  const cls = `lg-call${call.phase === "resolving" ? " resolving" : ""}${call.phase === "done" ? " done" : ""}${call.border ? " " + call.border : ""}`;
  const answering = call.phase === "answer";
  return (
    <div className={cls}>
      <div className="lg-lab"><span>{call.kind}</span><span className="lg-timer">{busy ? "signing…" : call.timerText}</span></div>
      <div className="lg-q">{call.q}</div>
      <div className="lg-bar"><div className="lg-bar-f" style={{ width: `${call.barPct}%` }} /></div>
      <div className="lg-opts">
        {call.opts.map((o) => (
          <button
            key={o.k}
            className={`lg-opt${o.state ? " " + o.state : ""}`}
            disabled={!answering || !canTap || busy}
            onClick={() => answering && canTap && !busy && onLock(o.k)}
          >
            <span className="lg-oc" style={{ background: o.c }}>{o.oc}</span>
            <span className="lg-ot">{o.t}</span>
            <span className="lg-op">{o.p} pt{o.p === 1 ? "" : "s"}</span>
          </button>
        ))}
      </div>
      {call.verdict && <div className={`lg-verdict ${call.verdict.tone}`}>{call.verdict.text}</div>}
    </div>
  );
}
