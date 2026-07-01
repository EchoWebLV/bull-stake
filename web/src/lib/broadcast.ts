/**
 * broadcast.ts — send an already-signed legacy tx over HTTP and confirm by
 * polling getSignatureStatuses (no WebSocket dependency). Extracted from
 * usePrivySigner so the confirm logic is unit-testable with a mock connection.
 *
 * Two profiles:
 *   - BASE money txs (join / claim): hold out for the 'confirmed' commitment,
 *     poll every 2s, up to 90s (a devnet blockhash lives ~60-90s; we re-broadcast
 *     each poll so a dropped tx still lands while its blockhash is valid).
 *   - ER taps (`fast`): the MagicBlock Ephemeral Rollup is a single sequencer —
 *     once a signature STATUS appears (error-free), the ER has executed the tx,
 *     regardless of whether it populates `confirmationStatus` (devnet.magicblock
 *     .app is NOT guaranteed to report 'processed'/'confirmed' like a full RPC).
 *     So fast mode accepts ANY present, error-free status, polls fast, and times
 *     out quickly: a tap that hasn't landed within the ~12s answer window is
 *     stale, and hanging the UI (busy) for 90s would disable tapping for the rest
 *     of the match — the original bug this guards against.
 */

/** The minimal connection surface confirm needs — lets tests pass a mock. */
export interface BroadcastConn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendRawTransaction(raw: Uint8Array, opts?: any): Promise<string>;
  getSignatureStatuses(
    signatures: string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opts?: any,
  ): Promise<{ value: (SignatureStatusLike | null)[] }>;
}

/** The subset of web3.js SignatureStatus we read. */
export interface SignatureStatusLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  err: any;
  confirmationStatus?: string | null;
}

export interface BroadcastOpts {
  /** ER-tap profile: accept any present error-free status; fast poll + short timeout. */
  fast?: boolean;
  /** Confirm ceiling (ms). Default: fast → 12_000, base → 90_000. */
  timeoutMs?: number;
  /** Poll + re-broadcast interval (ms). Default: fast → 400, base → 2_000. */
  pollMs?: number;
  /** Injectable sleep (tests pass an instant / fake-timer sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for deterministic timeout tests. Default: Date.now. */
  now?: () => number;
}

const DEFAULT_SLEEP = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True once the status means the tx is safely landed for this profile. */
function landed(status: SignatureStatusLike, fast: boolean): boolean {
  // fast (ER): a present, error-free status is enough — the sequencer has it.
  if (fast) return true;
  // base: wait for the cluster to reach 'confirmed' (or better).
  return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized";
}

/**
 * Broadcast + confirm. Resolves with the base58 signature once landed for the
 * profile; throws on an on-chain error (`status.err`) or if it never lands within
 * `timeoutMs`. Re-broadcasts each poll (idempotent — same signature) so a dropped
 * tx still lands while its blockhash is valid.
 */
export async function broadcastAndConfirm(
  rawTx: Uint8Array,
  conn: BroadcastConn,
  opts: BroadcastOpts = {},
): Promise<string> {
  const fast = opts.fast ?? false;
  const timeoutMs = opts.timeoutMs ?? (fast ? 12_000 : 90_000);
  const pollMs = opts.pollMs ?? (fast ? 400 : 2_000);
  const sleep = opts.sleep ?? DEFAULT_SLEEP;
  const now = opts.now ?? Date.now;

  // First send: base runs server-side preflight so encoding/PDA errors throw here;
  // ER skips it (preflight against the rollup is unproven — the tx is built
  // deterministically, and a real on-chain failure still surfaces via status.err).
  const signature = await conn.sendRawTransaction(rawTx, {
    skipPreflight: fast,
    preflightCommitment: "confirmed",
    maxRetries: 5,
  });

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const { value } = await conn.getSignatureStatuses([signature], {
      searchTransactionHistory: false,
    });
    const status = value[0];
    if (status) {
      if (status.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (landed(status, fast)) return signature;
    }
    await sleep(pollMs);
    // Re-broadcast while waiting: cheap, idempotent (same signature), keeps the tx
    // in leaders' mempools if the first send dropped. Ignore duplicate errors.
    try {
      await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 5 });
    } catch {
      /* duplicate / already-processed — the status poll above is the source of truth */
    }
  }
  throw new Error(fast ? "tap not confirmed within timeout" : "transaction not confirmed within timeout");
}
