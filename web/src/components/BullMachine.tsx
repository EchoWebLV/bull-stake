// web/src/components/BullMachine.tsx
/* The Bull Machine — hand-drawn 3×3 mint machine (devnet). One Privy approval
 * opens an n-spin session; the lever is the one action; VRF lands in the ER in
 * under a second; cash-out mints every rolled bull to the player's wallet.
 * Ported UX law from the SOL bulls demo: the lever is the ONE action. */
import { useEffect, useMemo, useState } from "react";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import {
  BullMachineClient, openCostLamports, type MachineState, type MintResult, bullExplorerUrl,
} from "../lib/bullMachine.ts";
import { composeBull, loadManifest, traitTilePath, type BullManifest } from "../lib/bullArt.ts";
import { setPfp } from "../lib/profile.ts";

type Phase =
  | { k: "idle" }
  | { k: "opening" }
  | { k: "ready"; creditsLeft: number }
  | { k: "spinning" }
  | { k: "rolled"; traits: number[]; img: string; creditsLeft: number }
  | { k: "cashing"; note: string }
  | { k: "done"; mints: MintResult[]; imgs: Record<string, string> }
  | { k: "error"; msg: string; retry?: () => void; isCashOutRetry?: boolean };

const GRID_CATS = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // 3×3 = first 9 manifest categories

export function BullMachine({ onClose }: { onClose: () => void }) {
  const { address, signAndSend } = usePrivySigner();
  const client = useMemo(
    () => (address ? new BullMachineClient(address, signAndSend) : null),
    // usePrivySigner returns fresh closures each render; the client only needs one
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address],
  );
  const [manifest, setManifest] = useState<BullManifest | null>(null);
  const [state, setState] = useState<MachineState | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [price, setPrice] = useState<bigint | null>(null);
  const [nSpins, setNSpins] = useState(1);
  const [reel, setReel] = useState<number[]>([0, 3, 6, 1, 4, 7, 2, 5, 8]); // tile indices while spinning

  useEffect(() => { loadManifest().then(setManifest).catch(() => setManifest(null)); }, []);
  useEffect(() => {
    if (!client) return;
    let alive = true;
    const load = () => {
      Promise.all([client.fetchState(), client.config()])
        .then(([st, cfg]) => {
          if (!alive) return;
          setState(st); setPrice(cfg.spinPrice);
          // Resume gate — a held key with anything actionable re-enters `ready`:
          // spins left (delegated), OR rolled bulls awaiting cash-out (even
          // undelegated / out of credits — the states `open` would refuse).
          // Functional update so a slow load never stomps an in-flight phase.
          setPhase((p) => {
            if (p.k !== "idle" && p.k !== "error") return p;
            if (st.exists && st.sessionKeyHeld && ((st.delegated && st.creditsLeft > 0) || st.rolledUnsettled > 0)) {
              return { k: "ready", creditsLeft: st.delegated ? st.creditsLeft : 0 };
            }
            return { k: "idle" };
          });
        })
        .catch((e) => {
          if (!alive) return;
          setPhase((p) => (p.k === "idle" || p.k === "error"
            ? { k: "error", msg: (e as Error).message, retry: load } : p));
        });
    };
    load();
    return () => { alive = false; };
  }, [client]);

  // tile shuffle while spinning — pure theater; the chain result lands the reveal
  useEffect(() => {
    if (phase.k !== "spinning" || !manifest) return;
    const id = window.setInterval(() =>
      setReel((r) => r.map((_, i) => Math.floor(Math.random() * manifest[GRID_CATS[i]].traits.length))), 90);
    return () => window.clearInterval(id);
  }, [phase.k, manifest]);

  if (!address) return null;

  const fmtSol = (l: number | bigint) => (Number(l) / 1e9).toFixed(3);
  const openCost = price == null ? null : fmtSol(openCostLamports(nSpins, price));

  async function open() {
    if (!client) return;
    setPhase({ k: "opening" });
    try {
      await client.openSession(nSpins);
      const st = await client.fetchState();
      setState(st);
      setPhase({ k: "ready", creditsLeft: st.exists ? st.creditsLeft : nSpins });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message, retry: open });
    }
  }

  async function pullLever() {
    if (!client) return;
    setPhase({ k: "spinning" });
    let slot: number;
    try {
      slot = await client.spin();
    } catch (e) {
      // spin() itself failed — no credit is stranded, a fresh pull is safe
      setPhase({ k: "error", msg: (e as Error).message, retry: pullLever });
      return;
    }
    await finishSpin(slot);
  }

  /** Tail of a spin whose credit is already spent — retrying this NEVER re-spins. */
  async function finishSpin(slot: number) {
    if (!client) return;
    setPhase({ k: "spinning" });
    try {
      const traits = await client.pollRolled(slot);
      // State BEFORE compose: if composeBull throws, `state` already reflects
      // the rolled slot, so the error panel's cash-out gate sees it.
      const st = await client.fetchState();
      setState(st);
      const img = await composeBull(traits, 512);
      setPhase({ k: "rolled", traits, img, creditsLeft: st.exists ? st.creditsLeft : 0 });
    } catch (e) {
      setPhase({ k: "error", msg: (e as Error).message, retry: () => finishSpin(slot) });
    }
  }

  async function cashOut() {
    if (!client) return;
    setPhase({ k: "cashing", note: "finalizing…" });
    try {
      const mints = await client.cashOut((stage, info) => {
        const notes: Record<string, string> = {
          finalize: "sealing your spins in the rollup…",
          undelegate: "bringing your session home…",
          discard: "cosmic duplicate — discarding…",
          mint: `minting bull ${((info?.done ?? 0) + 1)}…`,
          sweep: "sweeping leftovers back to you…",
        };
        if (stage !== "done") setPhase({ k: "cashing", note: notes[stage] ?? stage });
      });
      const imgs: Record<string, string> = {};
      for (const m of mints) {
        if (!m.asset || !m.traits) continue;
        // Per-bull isolation: the bulls are minted — one failed compose skips
        // that preview only, never the PFP offer or the other bulls.
        try { imgs[m.asset] = await composeBull(m.traits, 512); } catch { /* image-less card */ }
      }
      setPhase({ k: "done", mints, imgs });
      setState(await client.fetchState());
    } catch (e) {
      // isCashOutRetry: "Try again" IS the cash-out — don't render a duplicate button
      setPhase({ k: "error", msg: (e as Error).message, retry: cashOut, isCashOutRetry: true });
    }
  }

  function applyPfp(m: MintResult) {
    if (!m.asset || !m.traits || !address) return;
    setPfp(address, { asset: m.asset, traits: m.traits });
    onClose();
  }

  const rolledWaiting = state?.exists ? state.rolledUnsettled : 0;
  const canCashOut = state?.exists ? state.sessionKeyHeld && state.rolledUnsettled > 0 : false;
  // Mid-action the backdrop must not dismiss (the ✕ always works)
  const busy = phase.k === "opening" || phase.k === "spinning" || phase.k === "cashing";

  return (
    <div className="bullm-backdrop" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="bullm" role="dialog" aria-label="Bull Machine">
        <div className="bullm-head">
          <div className="bullm-title">The Bull Machine</div>
          <span className="tag">devnet · provably fair</span>
          <button className="bullm-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* 3×3 of real trait tiles */}
        <div className={`bullm-grid ${phase.k === "spinning" ? "spinning" : ""}`}>
          {manifest && GRID_CATS.map((cat, i) => {
            const t = phase.k === "rolled" ? phase.traits[cat] : reel[i];
            const path = manifest[cat] && manifest[cat].traits[t] ? traitTilePath(manifest, cat, t) : null;
            return <div key={i} className="bullm-cell">{path && <img src={path} alt="" />}</div>;
          })}
        </div>

        {phase.k === "idle" && (
          <div className="bullm-panel">
            <div className="bullm-copy">One approval opens your session. Spins are instant after that — every bull is unique, minted to <b>your</b> wallet.</div>
            <div className="bullm-nrow">
              {[1, 3, 5].map((n) => (
                <button key={n} className={`bullm-n ${nSpins === n ? "on" : ""}`} onClick={() => setNSpins(n)}>{n} spin{n > 1 ? "s" : ""}</button>
              ))}
            </div>
            <button className="btn bullm-cta" onClick={open}>
              Open session{openCost ? ` · ~◎${openCost}` : ""}
            </button>
            <div className="bullm-fine">crank change is swept back to you at cash-out</div>
          </div>
        )}

        {phase.k === "opening" && <div className="bullm-panel"><div className="bullm-copy">Opening your session — one wallet approval…</div></div>}

        {phase.k === "ready" && (
          <div className="bullm-panel">
            {phase.creditsLeft > 0 && <button className="bullm-lever" onClick={pullLever}>PULL</button>}
            <div className="bullm-fine">{phase.creditsLeft} spin{phase.creditsLeft === 1 ? "" : "s"} left · no popups, straight to the rollup</div>
            {rolledWaiting > 0 && <button className="btn bullm-cta" onClick={cashOut}>Cash out · mint {rolledWaiting} bull{rolledWaiting > 1 ? "s" : ""}</button>}
          </div>
        )}

        {phase.k === "spinning" && <div className="bullm-panel"><div className="bullm-copy">Rolling in the rollup…</div></div>}

        {phase.k === "rolled" && (
          <div className="bullm-panel">
            <img className="bullm-reveal" src={phase.img} alt="Your rolled bull" />
            <div className="bullm-copy">That's yours — locked to this roll. It mints at cash-out.</div>
            {phase.creditsLeft > 0
              ? <button className="bullm-lever" onClick={pullLever}>PULL AGAIN</button>
              : null}
            <button className="btn bullm-cta" onClick={cashOut}>Cash out · mint</button>
          </div>
        )}

        {phase.k === "cashing" && <div className="bullm-panel"><div className="bullm-copy">{phase.note}</div></div>}

        {phase.k === "done" && (
          <div className="bullm-panel">
            <div className="bullm-copy"><b>Minted.</b> Pick your profile picture:</div>
            <div className="bullm-mints">
              {phase.mints.filter((m) => m.asset).map((m) => (
                <div key={m.asset} className="bullm-mint">
                  {m.asset && phase.imgs[m.asset] && <img src={phase.imgs[m.asset]} alt={`Bull ${m.dna}`} />}
                  <button className="btn" onClick={() => applyPfp(m)}>Use as profile picture</button>
                  <a href={bullExplorerUrl(m.asset!)} target="_blank" rel="noreferrer" className="bullm-fine">view on explorer ↗</a>
                </div>
              ))}
              {phase.mints.every((m) => !m.asset) && <div className="bullm-copy">Cosmic duplicate — that exact bull already exists. Spin again!</div>}
            </div>
          </div>
        )}

        {phase.k === "error" && (
          <div className="bullm-panel">
            <div className="bullm-copy bullm-err">{phase.msg}</div>
            {phase.retry && <button className="btn bullm-cta" onClick={phase.retry}>Try again</button>}
            {canCashOut && !phase.isCashOutRetry && <button className="btn bullm-cta" onClick={cashOut}>Cash out anyway</button>}
          </div>
        )}
      </div>
    </div>
  );
}
