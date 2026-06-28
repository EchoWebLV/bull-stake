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
      <span className="kicker">
        <span className="dot" /> World Cup companion
      </span>
      <div className="row">
        <div className="brand">
          Strea<span className="accent">k</span>
        </div>
        {authenticated ? (
          <div className="row" style={{ gap: 8 }}>
            {address && (
              <button
                className="btn alt wallet-chip"
                style={{ width: "auto" }}
                onClick={copyAddr}
                title={`Copy ${address}`}
              >
                {copied ? "copied!" : `${address.slice(0, 4)}…${address.slice(-4)} ⧉`}
              </button>
            )}
            <button className="btn alt" style={{ width: "auto" }} onClick={logout}>
              Log out
            </button>
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
