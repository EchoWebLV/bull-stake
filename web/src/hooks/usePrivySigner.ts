import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { Transaction } from "@solana/web3.js";
import { connection, erConnection } from "../lib/anchorClient.ts";
import { broadcastAndConfirm } from "../lib/broadcast.ts";
import { SOLANA_CHAIN, pickPrivyWallet } from "../lib/wallet.ts";

/** Returns a function that takes an unsigned web3.js v1 Transaction, has Privy
 *  SIGN it (no broadcast), then broadcasts + confirms over our own devnet RPC
 *  via the shared web3.js `connection`. Returns the base58 signature.
 *
 *  Privy's useSignAndSendTransaction confirms over a WebSocket subscription that
 *  can hang indefinitely against our Helius devnet RPC (the modal approves, then
 *  the promise never settles and nothing broadcasts). Splitting sign from
 *  broadcast removes that WSS dependency entirely. */
export function usePrivySigner(): {
  address: string | undefined;
  signAndSend: (tx: Transaction) => Promise<string>;
  signAndSendEr: (tx: Transaction) => Promise<string>;
} {
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const wallet = pickPrivyWallet(wallets);

  async function signAndSend(tx: Transaction): Promise<string> {
    if (!wallet) throw new Error("no Solana wallet connected");
    // Refresh the blockhash as late as possible — right before signing — so the
    // user's approval delay (not the tx-build time) is what counts against the
    // ~60-90s blockhash validity window. The tx isn't signed yet, so mutating
    // recentBlockhash here is safe, and it avoids the "Blockhash not found"
    // simulation failure when there's a gap between build and approval.
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    // Serialize unsigned: feePayer is set by the tx builder; Privy fills in the
    // signature over the freshly-stamped blockhash.
    const unsigned = new Uint8Array(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    // Pass `chain` explicitly: Privy defaults to "solana:mainnet" when omitted,
    // but the tx is devnet and signing must route through the devnet RPC slot.
    const { signedTransaction } = await signTransaction({
      transaction: unsigned,
      wallet,
      chain: SOLANA_CHAIN,
    });

    // Normalize Privy's output to raw bytes ready for sendRawTransaction. It is
    // a fully-signed legacy tx; round-tripping through Transaction.from validates
    // the signature is present before we hit the network.
    const signed = Transaction.from(signedTransaction);
    if (!signed.signature) throw new Error("wallet returned an unsigned transaction");
    const rawTx = signed.serialize();

    return broadcastAndConfirm(new Uint8Array(rawTx), connection);
  }

  /** Tap path: sign an ER tx with NO wallet modal (embedded wallets) and broadcast
   *  to the Ephemeral Rollup. `showWalletUIs:false` suppresses the per-tap modal so
   *  rapid in-play taps feel gasless; join/claim keep `signAndSend` (base + modal,
   *  a real-money confirmation). External wallets ignore the flag and still prompt. */
  async function signAndSendEr(tx: Transaction): Promise<string> {
    if (!wallet) throw new Error("no Solana wallet connected");
    tx.recentBlockhash = (await erConnection.getLatestBlockhash("confirmed")).blockhash;
    const unsigned = new Uint8Array(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    const { signedTransaction } = await signTransaction({
      transaction: unsigned,
      wallet,
      chain: SOLANA_CHAIN,
      options: { uiOptions: { showWalletUIs: false } },
    });
    const signed = Transaction.from(signedTransaction);
    if (!signed.signature) throw new Error("wallet returned an unsigned transaction");
    return broadcastAndConfirm(new Uint8Array(signed.serialize()), erConnection, { fast: true });
  }

  return { address: wallet?.address, signAndSend, signAndSendEr };
}
