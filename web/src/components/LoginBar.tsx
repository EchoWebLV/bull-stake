import { useEffect, useState } from "react";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { pickPrivyWallet } from "../lib/wallet.ts";
import { usePfp } from "../lib/profile.ts";
import { composeBull } from "../lib/bullArt.ts";

export function useSolanaAddress(): string | undefined {
  const { wallets } = useWallets();
  return pickPrivyWallet(wallets)?.address;
}

export function LoginBar() {
  const { ready, authenticated, logout } = usePrivy();
  const { login } = useLogin();
  const address = useSolanaAddress();
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const pfp = usePfp(address ?? undefined);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!pfp) { setThumb(null); return; }
    composeBull(pfp.traits, 64).then((u) => { if (alive) setThumb(u); }).catch(() => {});
    return () => { alive = false; };
    // recompose only when the chosen bull changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pfp?.asset]);
  if (!ready) return null;

  async function copyAddr() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — address is still visible to select manually */
    }
  }

  return (
    <header className="header">
      <div className="row">
        <div className="brand-wrap">
          <img src="/bullstake.png" className="brand-logo" alt="" aria-hidden="true" />
          <div className="brand">
            BullSta<span className="accent">ke</span>
          </div>
        </div>
        {authenticated ? (
          <div className="wallet-wrap">
            <button
              className="btn alt wallet-chip"
              style={{ width: "auto" }}
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              {thumb && <img src={thumb} alt="" style={{ width: 20, height: 20, borderRadius: "50%", marginRight: 6, verticalAlign: "-4px" }} />}
              {address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "Wallet"}
              <span className="wallet-caret" aria-hidden="true">▾</span>
            </button>
            {menuOpen && (
              <>
                <div className="wallet-backdrop" onClick={() => setMenuOpen(false)} />
                <div className="wallet-menu" role="menu">
                  {address && (
                    <button role="menuitem" onClick={copyAddr}>
                      {copied ? "Copied!" : "Copy address ⧉"}
                    </button>
                  )}
                  <button role="menuitem" onClick={() => { setMenuOpen(false); logout(); }}>
                    Log out
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <button className="btn" style={{ width: "auto" }} onClick={() => login()}>
            Log in
          </button>
        )}
      </div>
    </header>
  );
}
