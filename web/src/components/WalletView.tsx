import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { usePrivy } from "@privy-io/react-auth";
import { connection } from "../lib/anchorClient.ts";
import { useSolanaAddress } from "./LoginBar.tsx";
import { Mascot } from "./Mascot.tsx";
import { usePfp } from "../lib/profile.ts";
import { composeBull } from "../lib/bullArt.ts";
import { BullMachine } from "./BullMachine.tsx";

const LAMPORTS = 1_000_000_000;

export function WalletView({ active = true }: { active?: boolean } = {}) {
  const { logout } = usePrivy();
  const address = useSolanaAddress();
  const [balance, setBalance] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const pfp = usePfp(address ?? undefined);
  const [pfpImg, setPfpImg] = useState<string | null>(null);
  const [machineOpen, setMachineOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!pfp) { setPfpImg(null); return; }
    composeBull(pfp.traits, 256).then((url) => { if (alive) setPfpImg(url); }).catch(() => {});
    return () => { alive = false; };
    // recompose only when the chosen bull changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pfp?.asset]);

  useEffect(() => {
    if (!address || !active) return; // paused while backgrounded; refreshes on return
    let alive = true;
    const load = () =>
      connection.getBalance(new PublicKey(address))
        .then((b) => { if (alive) setBalance(b); })
        .catch(() => {});
    load();
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [address, active]);

  async function copyAddr() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  if (!address) {
    return (
      <>
        <div className="section"><h3>Wallet</h3></div>
        <div className="card empty-card">Log in to view your wallet.</div>
      </>
    );
  }

  const sol = balance == null ? "—" : (balance / LAMPORTS).toFixed(3);

  return (
    <>
      <div className="section"><h3>Profile</h3>
        <span className="tag">devnet</span>
      </div>

      <div className="profile-card">
        {pfpImg
          ? <img className="profile-pfp" src={pfpImg} alt="Your bull" />
          : <Mascot seed={address} size={72} title="Your mascot (spin for a bull!)" />}
        <div className="profile-meta">
          <div className="profile-name">{pfp ? "Bull holder" : "No bull yet"}</div>
          <button className="btn" onClick={() => setMachineOpen(true)}>
            {pfp ? "Spin again 🎰" : "Spin for your Bull 🎰"}
          </button>
        </div>
      </div>

      {machineOpen && <BullMachine onClose={() => setMachineOpen(false)} />}

      <div className="wallet-card">
        <div className="wallet-k">Balance</div>
        <div className="wallet-balance">{sol}<span className="unit"> SOL</span></div>
        <button className="wallet-addr" onClick={copyAddr} title={`Copy ${address}`}>
          {copied ? "copied!" : `${address.slice(0, 8)}…${address.slice(-8)} ⧉`}
        </button>
        <div className="wallet-actions">
          <a
            className="btn"
            href={`https://explorer.solana.com/address/${address}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
            style={{ textAlign: "center", textDecoration: "none" }}
          >
            View on explorer ↗
          </a>
          <button className="btn ghost" onClick={logout}>Log out</button>
        </div>
      </div>

      <div className="trust" style={{ marginTop: 18 }}>
        <span className="seal" style={{ color: "var(--green)" }}>◆</span>
        Email login · no seed phrase. Devnet balance — fund via a devnet faucet.
      </div>
    </>
  );
}
