import { useSignAndSendTransaction, useWallets } from "@privy-io/react-auth/solana";
import { utils } from "@coral-xyz/anchor";
import type { Transaction } from "@solana/web3.js";
import { SOLANA_CHAIN, pickPrivyWallet } from "../lib/wallet.ts";

/** Returns a function that takes an unsigned web3.js v1 Transaction, has Privy
 *  sign + broadcast it to the configured devnet RPC, and returns the signature. */
export function usePrivySigner(): {
  address: string | undefined;
  signAndSend: (tx: Transaction) => Promise<string>;
} {
  const { wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const wallet = pickPrivyWallet(wallets);

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!wallet) throw new Error("no Solana wallet connected");
    const bytes = new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    // Pass `chain` explicitly: Privy defaults to "solana:mainnet" when omitted,
    // but the tx (devnet blockhash + program id) must be broadcast to devnet.
    const { signature } = await signAndSendTransaction({ transaction: bytes, wallet, chain: SOLANA_CHAIN });
    return typeof signature === "string"
      ? signature
      : utils.bytes.bs58.encode(Uint8Array.from(signature as Uint8Array));
  }
  return { address: wallet?.address, signAndSend };
}
