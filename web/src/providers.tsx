import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions, devnet } from "@solana/kit";

const RPC = import.meta.env.VITE_RPC_URL ?? "https://api.devnet.solana.com";
const WSS = RPC.replace("https", "wss");

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google", "wallet"],
        appearance: { walletChainType: "solana-only", theme: "dark", accentColor: "#FF6A1A" },
        embeddedWallets: { solana: { createOnLogin: "users-without-wallets" } },
        solana: {
          rpcs: {
            "solana:devnet": {
              // `devnet(...)` tags the URL so @solana/kit returns the devnet-specific
              // RPC type (incl. requestAirdrop) that Privy's "solana:devnet" slot requires.
              rpc: createSolanaRpc(devnet(RPC)),
              rpcSubscriptions: createSolanaRpcSubscriptions(devnet(WSS)),
            },
          },
        },
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
