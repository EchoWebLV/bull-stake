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
  if (!ready) return null;
  return (
    <div className="row">
      <div className="brand">Streak</div>
      {authenticated
        ? <button className="btn alt" style={{ width: "auto" }} onClick={logout}>
            {address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "…"}
          </button>
        : <button className="btn" style={{ width: "auto" }} onClick={() => login()}>Log in</button>}
    </div>
  );
}
