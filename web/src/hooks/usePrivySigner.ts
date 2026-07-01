import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { Connection, Transaction } from "@solana/web3.js";
import { connection, erConnection } from "../lib/anchorClient.ts";
import { SOLANA_CHAIN, pickPrivyWallet } from "../lib/wallet.ts";

/** How long to keep polling for confirmation before giving up (ms). A devnet
 *  blockhash is valid for ~150 slots (~60-90s); we poll a bit past that so we
 *  don't report failure while the tx could still land. */
const CONFIRM_TIMEOUT_MS = 90_000;
/** Delay between status polls + re-broadcasts (ms). */
const POLL_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Broadcast an already-signed legacy tx over HTTP and confirm by polling
 *  getSignatureStatuses — no WebSocket dependency. Re-broadcasts on each poll
 *  so a dropped tx still lands while its blockhash is valid. Returns the
 *  base58 signature once it reaches the 'confirmed' commitment. */
async function broadcastAndConfirm(
  rawTx: Uint8Array,
  conn: Connection = connection,
  fast = false,
): Promise<string> {
  // sendRawTransaction returns the base58 signature; skipPreflight:false runs a
  // server-side simulation first so encoding/PDA errors surface as a throw here
  // instead of a silent drop.
  const signature = await conn.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });

  // ER taps land in the ER's own state fast — "processed" is enough for the keeper
  // to read the pick. Base money txs hold out for "confirmed".
  const done = (level: string | null | undefined): boolean =>
    fast
      ? level === "processed" || level === "confirmed" || level === "finalized"
      : level === "confirmed" || level === "finalized";

  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (done(status.confirmationStatus)) return signature;
    }
    await sleep(POLL_INTERVAL_MS);
    // Re-broadcast while waiting: cheap, idempotent (same signature), and keeps
    // the tx in leaders' mempools if the first send was dropped. Ignore the
    // "already processed" / duplicate errors that a re-send can raise.
    try {
      await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });
    } catch {
      /* duplicate / already-processed — status poll above is the source of truth */
    }
  }
  throw new Error("transaction not confirmed within timeout");
}

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

    return broadcastAndConfirm(new Uint8Array(rawTx));
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
    return broadcastAndConfirm(new Uint8Array(signed.serialize()), erConnection, true);
  }

  return { address: wallet?.address, signAndSend, signAndSendEr };
}
