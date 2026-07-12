import { useState } from "react";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { useWallets } from "@privy-io/react-auth/solana";
import { pickPrivyWallet } from "../lib/wallet.ts";

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
        <div className="brand">
          Bull Sta<span className="accent">ke</span>
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
