import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import type { Transaction } from "@solana/web3.js";

/** Returns a function that takes an unsigned web3.js v1 Transaction, has Privy
 *  sign + broadcast it to the configured devnet RPC, and returns the signature. */
export function usePrivySigner(): {
  address: string | undefined;
  signAndSend: (tx: Transaction) => Promise<string>;
} {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = wallets.find((w) => w.standardWallet?.name === "Privy") ?? wallets[0];

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!wallet) throw new Error("no Solana wallet connected");
    const bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const { signature } = await signAndSendTransaction({ transaction: bytes, wallet });
    return String(signature);
  }
  return { address: wallet?.address, signAndSend };
}
