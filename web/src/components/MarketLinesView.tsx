import { useMemo, useState } from "react";
import { useLines } from "../hooks/useLines.ts";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildPlaceBetTx, buildClaimTx } from "../lib/anchorClient.ts";
import { LINE_CLOSE_MARKET_ID } from "../lib/lineConstants.ts";
import {
  mapSlateRow, mapLineDetail, solText, LINE_STAKE_PRESETS,
} from "../lib/lines.ts";

/* Beat the Market — the day game (spec §1/§6, mockup 14).
 * Slate of today's lines → detail: sparkline vs the opening line, Above/Below
 * with preset stakes, live ahead/behind verdict, claim on settle/void.
 * REAL-MONEY: money numbers come from /api/lines (chain-read); odds from
 * TxLINE via the engine tracker. Missing odds render as "—", never invented. */
export function MarketLinesView() {
  const { address, signAndSend } = usePrivySigner();
  const [focus, setFocus] = useState<number | null>(null);
  const [stakeIdx, setStakeIdx] = useState(0);
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState("");
  const { lines, detail, refresh } = useLines(address ?? null, focus);
  const nowMs = Date.now();

  const rows = useMemo(() => (lines ?? []).map((l) => mapSlateRow(l, nowMs)), [lines, nowMs]);
  const vm = useMemo(() => (detail ? mapLineDetail(detail, nowMs) : null), [detail, nowMs]);

  async function onBet(bucket: 0 | 1) {
    if (!address || focus == null || !vm?.canBet) return;
    setBusy("bet"); setFlash("");
    try {
      const tx = await buildPlaceBetTx(address, focus, LINE_CLOSE_MARKET_ID, bucket, LINE_STAKE_PRESETS[stakeIdx]);
      await signAndSend(tx);
      await refresh();
    } catch (e) { setFlash(e instanceof Error ? e.message : "Bet failed"); }
    finally { setBusy(""); }
  }

  async function onClaim() {
    if (!address || focus == null) return;
    setBusy("claim"); setFlash("");
    try {
      const tx = await buildClaimTx(address, focus, LINE_CLOSE_MARKET_ID);
      await signAndSend(tx);
      await refresh();
    } catch (e) { setFlash(e instanceof Error ? e.message : "Claim failed"); }
    finally { setBusy(""); }
  }

  // ── detail ──────────────────────────────────────────────────────────────
  if (focus != null && vm) {
    const spark = vm.spark;
    return (
      <div className="mlines">
        {flash && <div className="ml-flash">{flash}</div>}
        <button className="ml-back" onClick={() => setFocus(null)}>‹ Today's lines</button>

        <div className="ml-head">
          <div className="ml-title">{vm.row.title}</div>
          <div className="ml-ko">KO {vm.row.koLabel}</div>
        </div>

        <div className="ml-linecard">
          <div className="ml-lab">
            <span>Consensus line — {vm.row.favName} to win</span>
            <span className="ml-src">TxLINE StablePrice</span>
          </div>
          <div className="ml-bignum">
            <span className="ml-pct tnum">{vm.currentText}</span>
            {vm.deltaText && (
              <span className={`ml-delta tnum ${vm.deltaUp ? "up" : "down"}`}>{vm.deltaText}</span>
            )}
          </div>
          <Spark points={spark.points} openMilli={spark.openMilli} />
          <div className="ml-sparkcap"><span>open {vm.openText}</span><span>now</span></div>
        </div>

        <div className="ml-call">
          <div className="ml-q">Where does the line close at kick-off?</div>
          {vm.canBet && (
            <div className="ml-presets">
              {vm.presets.map((p, i) => (
                <button key={String(p)} className={`ml-preset${i === stakeIdx ? " sel" : ""}`}
                  onClick={() => setStakeIdx(i)}>{solText(p)}</button>
              ))}
            </div>
          )}
          <div className="ml-opts">
            {vm.options.map((o) => (
              <button key={o.bucket}
                className={`ml-opt${vm.myBucket === o.bucket ? " sel" : ""}`}
                disabled={!vm.canBet || !!busy}
                onClick={() => onBet(o.bucket)}>
                <span className={`ml-oc ${o.bucket === 0 ? "up" : "down"}`}>{o.bucket === 0 ? "▲" : "▼"}</span>
                <span className="ml-ot">{o.label}</span>
                <span className="ml-osub tnum">
                  {vm.canBet ? `win ≈ ${o.estWinTexts[stakeIdx]}` : o.sideTotalText}
                </span>
              </button>
            ))}
          </div>
          {vm.verdict && <div className={`ml-verdict ${vm.verdict.tone}`}>{vm.verdict.text}</div>}
          {vm.myBucket != null && !vm.verdict && vm.row.status === "open" && (
            <div className="ml-verdict idle">you're in — {vm.myStakeText} on {vm.myBucket === 0 ? "Above" : "Below"}</div>
          )}
          {vm.row.resultText && <div className="ml-verdict idle">{vm.row.resultText}</div>}
          {vm.claim && (
            <button className="ml-claim" onClick={onClaim} disabled={!!busy}>
              {busy === "claim" ? "Claiming…"
                : vm.claim.kind === "refund" ? `Claim refund ${solText(vm.claim.amountLamports)} ▸`
                : `Claim ${solText(vm.claim.amountLamports)} ▸`}
            </button>
          )}
        </div>

        <div className="ml-pot">
          <span>{vm.row.potText}</span>
          <span className="ml-boost">{vm.houseBoostText}</span>
        </div>
        {!address && <div className="ml-hint">log in to play</div>}
      </div>
    );
  }

  // ── slate ────────────────────────────────────────────────────────────────
  return (
    <div className="mlines">
      {flash && <div className="ml-flash">{flash}</div>}
      <div className="ml-hero">
        <div>
          <div className="ml-hero-lab">The day game</div>
          <div className="ml-hero-ttl">Beat the Market</div>
        </div>
        <div className="ml-hero-sub">call where the line<br />closes at kick-off</div>
      </div>
      {lines === null && <div className="ml-empty">loading lines…</div>}
      {lines !== null && rows.length === 0 && (
        <div className="ml-empty">No lines right now — they open as soon as the market prices a match.</div>
      )}
      {rows.map((r) => (
        <button key={r.fixtureId} className="ml-row" onClick={() => setFocus(r.fixtureId)}>
          <span className="ml-row-main">
            <span className="ml-row-title">{r.title}</span>
            <span className="ml-row-meta">
              {r.status === "open" ? `KO ${r.koLabel} · ${r.potText}` : r.resultText ?? r.status}
            </span>
          </span>
          <span className="ml-row-line">
            <span className={`ml-row-pct tnum${r.dirUp == null ? "" : r.dirUp ? " up" : " down"}`}>
              {r.pctText}{r.dirUp != null && <span className="ml-arrow">{r.dirUp ? "▲" : "▼"}</span>}
            </span>
            <span className="ml-row-fav">{r.favName} to win</span>
          </span>
        </button>
      ))}
      <div className="ml-hint">
        pick Above or Below the opening line · the right side splits the pot at kick-off ·
        odds by TxLINE StablePrice
      </div>
    </div>
  );
}

/** Honest sparkline: renders ONLY real series points + the open reference. */
function Spark({ points, openMilli }: { points: [number, number][]; openMilli: number }) {
  if (points.length < 2) return <div className="ml-spark-empty">not enough data yet</div>;
  const W = 340, H = 64;
  const vals = points.map((p) => p[1]).concat(openMilli);
  const lo = Math.min(...vals) - 500, hi = Math.max(...vals) + 500;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - 5 - ((v - lo) / (hi - lo)) * (H - 10);
  const last = points[points.length - 1][1];
  const up = last >= openMilli;
  return (
    <svg className="ml-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <line x1={0} y1={y(openMilli)} x2={W} y2={y(openMilli)}
        stroke="currentColor" strokeDasharray="4 4" opacity={0.35} />
      <polyline
        points={points.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" ")}
        fill="none" stroke={up ? "var(--ml-green, #3DE08A)" : "var(--ml-accent, #FF6A1A)"}
        strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={W} cy={y(last)} r={3.4} fill={up ? "var(--ml-green, #3DE08A)" : "var(--ml-accent, #FF6A1A)"} />
    </svg>
  );
}
