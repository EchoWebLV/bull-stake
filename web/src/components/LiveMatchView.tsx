import { useEffect, useMemo, useState } from "react";
import {
  snapshotFromChain, preGameFromChain, SCORING_HINT,
  type GameSnapshot, type PreGame,
} from "../lib/liveGame.ts";
import { useLivePool } from "../lib/useLivePool.ts";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import {
  buildJoinLivePoolTx, buildClaimLivePoolTx, buildLockPickTxER,
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

/** `test` pins this view to the TEST audience (/test page): only synthetic-fixture
 *  pools are featured there, and the main Live tab never shows them. */
export function LiveMatchView({ test = false }: { test?: boolean } = {}) {
  const { address, signAndSend, signAndSendEr } = usePrivySigner();
  const { data, entry, refresh } = useLivePool(address ?? null, test);

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
      const tx = await buildLockPickTxER(address, pool.poolId, openCall.seq, Number(k));
      await signAndSendEr(tx); // ER tap — no wallet modal (embedded wallets)
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

  // Pre-game: the big countdown (upcoming fixture, or joinable pool pre-lock).
  // Recomputed on the 150ms heartbeat so the timer ticks between polls.
  const pre = useMemo(() => preGameFromChain(data, entry, nowMs), [data, entry, nowMs]);
  if (pre) {
    return (
      <div className="livegame">
        {flashMsg && <div className="lg-toast lg-go" key={flashMsg}>{flashMsg}</div>}
        <PreGameCard
          pre={pre}
          test={test}
          busy={busy === "join"}
          canJoin={joinable}
          loggedIn={!!address}
          onJoin={onJoin}
        />
        <div className="lg-hint">{SCORING_HINT}</div>
      </div>
    );
  }

  // No pool and no pre-game: a clean idle card. Without this gate the in-game
  // scaffold renders from an all-null snapshot — dashes, 0–0, ◎0 pot — which
  // reads as a broken screen, not an empty one.
  if (!pool) {
    return (
      <div className="livegame">
        <div className="lg-pre">
          <div className="lg-pre-lab">{test ? "Test match — real devnet SOL" : "Next match"}</div>
          <div className="lg-pre-teams">No game right now</div>
          <div className="lg-pre-hint">
            {test
              ? "No test match is running — one appears here the moment the keeper starts it."
              : "The next match pool opens 45 min before kick-off."}
          </div>
        </div>
      </div>
    );
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

/** Pre-game: the big countdown to kick-off, plus the join state once the pool exists.
 *  `upcoming` = fixture known, join window not open yet (no pool on-chain);
 *  `joinable` = pool created (T-45 inside), real pot + the real-money Join button. */
function PreGameCard({ pre, test, busy, canJoin, loggedIn, onJoin }: {
  pre: PreGame; test: boolean; busy: boolean; canJoin: boolean; loggedIn: boolean; onJoin: () => void;
}) {
  const hm = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="lg-pre">
      <div className="lg-pre-lab">{test ? "Test match — real devnet SOL" : "Next match"}</div>
      <div className="lg-pre-teams">
        {pre.home}
        {pre.away && <> <span className="lg-pre-vs">vs</span> {pre.away}</>}
      </div>
      <div className="lg-pre-ko">kick-off {hm(pre.kickoffMs)}</div>
      <div className="lg-pre-timer tnum">{pre.countdown}</div>
      {pre.phase === "joinable" ? (
        <>
          <div className="lg-pre-pot">
            <b className="tnum">{pre.pot}</b> pot · <b className="tnum">{pre.players}</b> in · {pre.entry} each
          </div>
          {pre.joined ? (
            <div className="lg-pre-in">You’re in — picks open at kick-off</div>
          ) : (
            <button className="lg-cbtn lg-pre-join" onClick={onJoin} disabled={!canJoin || busy}>
              {busy ? "Joining…" : `Join · ${pre.entry}`}
            </button>
          )}
          {!loggedIn && <div className="lg-pre-hint">log in to grab a seat</div>}
        </>
      ) : (
        <div className="lg-pre-hint">
          Join opens {pre.joinOpensTs ? `at ${hm(pre.joinOpensTs * 1000)}` : "45 min before kick-off"}
        </div>
      )}
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
    // Between calls: a compact, breathing state — never a dead void. The pulse
    // says "the game is live, the next call is on its way" without a countdown
    // (call pacing is keeper-side; the client can't know the exact moment).
    return (
      <div className="lg-call idle">
        {!over && <div className="lg-pulse"><span /><span /><span /></div>}
        <div className="lg-idlemsg">{over ? "Full-time…" : "Next call coming…"}</div>
      </div>
    );
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
