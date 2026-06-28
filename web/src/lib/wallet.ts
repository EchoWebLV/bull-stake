import type { useWallets } from "@privy-io/react-auth/solana";

/** The connected-wallet type returned by Privy's `useWallets()` (Solana). */
export type PrivyWallet = ReturnType<typeof useWallets>["wallets"][number];

/** The Solana chain every tx is built for and broadcast to. Privy's
 *  signAndSendTransaction defaults to "solana:mainnet" when chain is omitted,
 *  but providers.tsx only registers the "solana:devnet" RPC slot — so the chain
 *  must be passed explicitly on every send. */
export const SOLANA_CHAIN = "solana:devnet" as const;

/** Pick the embedded Privy wallet, falling back to the first connected wallet. */
export function pickPrivyWallet(wallets: PrivyWallet[]): PrivyWallet | undefined {
  return wallets.find((w) => w.standardWallet?.name === "Privy") ?? wallets[0];
}
