// web/src/lib/bullMachine.ts
/* Bull Machine client — port of the devnet-proven SOL bulls ER bridge
 * (demo/er-chain.src.js, VERDICT GREEN). One Privy-signed tx opens+delegates a
 * session; spins are session-key-signed straight to the MagicBlock ER node;
 * cash-out is cranked by the session key and mints bulls to the player.
 * L1 = shared Helius `connection`; the ER node is discovered per-delegation
 * via the MagicBlock router (NOT the live game's fixed `erConnection`). */
import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import idl from "../idl/bull_machine.er.json";
import { connection } from "./anchorClient.ts";

export const BULL_PROGRAM_ID = new PublicKey((idl as { address: string }).address);
const ROUTER = "https://devnet-router.magicblock.app";
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SLOT_HASHES = new PublicKey("SysvarS1otHashes111111111111111111111111111");
const EPHEMERAL_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

// Extra L1 top-up so the session key can crank settle_mint per bull; leftovers
// sweep back to the player at cash-out. Mirrors the bridge constants.
const CRANK_LAMPORTS_PER_SPIN = 10_000_000;
const CRANK_LAMPORTS_BASE = 5_000_000;
const SESSION_KEY_TOPUP = 20_000_000;
const RENT_FEES_MARGIN = 15_000_000;

// Frozen Session layout (SOL bulls litesvm layout.rs).
const SES_CREDITS_TOTAL = 72, SES_CREDITS_USED = 73, SES_SETTLED = 74;
const SES_SPINS = 75, SPIN_STRIDE = 50, SES_EXPIRES_AT = 583, SES_LEN = 592;
export const STATUS = { EMPTY: 0, PENDING: 1, ROLLED: 2, SETTLED: 3 } as const;

const seed = (...parts: Buffer[]) => PublicKey.findProgramAddressSync(parts, BULL_PROGRAM_ID)[0];
export const configPda = () => seed(Buffer.from("config"));
export const sessionPda = (player: PublicKey) => seed(Buffer.from("session"), player.toBuffer());
export const claimPda = (traits: number[]) => seed(Buffer.from("claim"), Buffer.from(traits));
export const identityPda = () => seed(Buffer.from("identity"));
export const authorityPda = () => seed(Buffer.from("authority"));

type IdlShape = { instructions: { name: string; discriminator: number[] }[] };
const spinDisc = Uint8Array.from(
  (idl as unknown as IdlShape).instructions.find((i) => i.name === "spin")!.discriminator,
);

export type SpinSlot = { status: number; traits: number[]; randomness: number[] };
export type SessionData = {
  creditsTotal: number; creditsUsed: number; settled: number;
  spins: SpinSlot[]; expiresAt: number;
};

export function decodeSession(d: Uint8Array): SessionData {
  const base = (i: number) => SES_SPINS + i * SPIN_STRIDE;
  const spins = Array.from({ length: 10 }, (_, i) => ({
    status: d[base(i)],
    traits: Array.from(d.subarray(base(i) + 1, base(i) + 10)),
    randomness: Array.from(d.subarray(base(i) + 18, base(i) + 50)),
  }));
  return {
    creditsTotal: d[SES_CREDITS_TOTAL], creditsUsed: d[SES_CREDITS_USED], settled: d[SES_SETTLED],
    spins,
    expiresAt: Number(new DataView(d.buffer, d.byteOffset + SES_EXPIRES_AT, 8).getBigInt64(0, true)),
  };
}

/** Full devnet-SOL cost of opening an n-spin session (bridge preflight math). */
export function openCostLamports(nSpins: number, spinPrice: bigint): number {
  return Number(spinPrice) * nSpins + SESSION_KEY_TOPUP
    + CRANK_LAMPORTS_BASE + nSpins * CRANK_LAMPORTS_PER_SPIN + RENT_FEES_MARGIN;
}

export type SessionView = {
  creditsTotal: number; creditsUsed: number; creditsLeft: number; settled: number;
  rolledUnsettled: number; expired: boolean; closeable: boolean; active: boolean;
  spins: SpinSlot[];
};

/** Pure UI summary of a decoded session (testable without RPC). */
export function deriveSessionView(
  s: SessionData,
  ctx: { delegated: boolean; sessionKeyHeld: boolean; now: number },
): SessionView {
  const rolled = s.spins.filter((sp) => sp.status === STATUS.ROLLED).length;
  return {
    creditsTotal: s.creditsTotal, creditsUsed: s.creditsUsed, settled: s.settled,
    creditsLeft: s.creditsTotal - s.creditsUsed,
    rolledUnsettled: rolled,
    expired: ctx.now > s.expiresAt,
    spins: s.spins,
    closeable: !ctx.delegated && s.spins.every((sp) => sp.status === STATUS.EMPTY || sp.status === STATUS.SETTLED),
    active: ctx.delegated && ctx.sessionKeyHeld && s.creditsTotal - s.creditsUsed > 0 && ctx.now <= s.expiresAt,
  };
}

// ── chain-bound client (open / spin / reveal / cash-out) ────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const skStoreKey = (player: PublicKey) => `bullstake:sk:${BULL_PROGRAM_ID.toBase58()}:${player.toBase58()}`;

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 4): Promise<T> {
  let wait = 1_200;
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = /429|Too many requests|rate.?limit|Failed to fetch|load failed/i.test(String((e as Error)?.message ?? e));
      if (!transient || i >= attempts) throw e;
      await sleep(wait); wait *= 2;
    }
  }
}

async function confirmSig(c: Connection, sig: string, label: string, timeoutMs = 40_000): Promise<void> {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    let st = null;
    try { st = (await c.getSignatureStatus(sig)).value; } catch { /* transient — keep polling */ }
    if (st) {
      if (st.err) throw new Error(`${label} failed on-chain: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
    }
    await sleep(300);
  }
  throw new Error(`${label}: not confirmed in ${timeoutMs / 1000}s`);
}

/** Signed entirely by local keypairs (session key / asset). */
async function sendLocal(c: Connection, ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
  return withRetry(async () => {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    let sig: string;
    try {
      sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    } catch (e) {
      const logs = (e as { logs?: string[] })?.logs;
      throw new Error(`${label}: ${(e as Error).message}${logs ? " — " + logs.slice(-3).join(" | ") : ""}`);
    }
    await confirmSig(c, sig, label);
    return sig;
  }, label);
}

export type MintResult = { slot: number; dna: string; traits?: number[]; asset: string | null };
export type CashOutStep = "finalize" | "undelegate" | "discard" | "mint" | "sweep" | "done";
export type MachineState =
  | { exists: false; delegated: false; sessionKeyHeld: boolean }
  | ({ exists: true; delegated: boolean; sessionKeyHeld: boolean } & SessionView);

/** One instance per connected player. `signAndSend` is usePrivySigner().signAndSend
 *  — it stamps a fresh blockhash, signs via Privy, broadcasts on the Helius
 *  connection, and confirms. It is used EXACTLY twice: openSession, closeSession. */
export class BullMachineClient {
  private player: PublicKey;
  private signAndSend: (tx: Transaction) => Promise<string>;
  private program: anchor.Program;
  private sessionKey: Keypair | null;
  private er: Connection | null = null;
  private cfg: { treasury: PublicKey; collection: PublicKey; spinPrice: bigint } | null = null;

  constructor(playerAddress: string, signAndSend: (tx: Transaction) => Promise<string>) {
    this.player = new PublicKey(playerAddress);
    this.signAndSend = signAndSend;
    const dummy = {
      publicKey: this.player,
      signTransaction: async (t: Transaction) => t,
      signAllTransactions: async (t: Transaction[]) => t,
    } as anchor.Wallet;
    this.program = new anchor.Program(
      idl as anchor.Idl,
      new anchor.AnchorProvider(connection, dummy, { commitment: "confirmed" }),
    );
    const raw = localStorage.getItem(skStoreKey(this.player));
    this.sessionKey = raw ? Keypair.fromSecretKey(Buffer.from(raw, "base64")) : null;
  }

  sessionKeyHeld(): boolean { return !!this.sessionKey; }

  private storeSessionKey(kp: Keypair): void {
    localStorage.setItem(skStoreKey(this.player), Buffer.from(kp.secretKey).toString("base64"));
  }
  private dropSessionKey(): void {
    localStorage.removeItem(skStoreKey(this.player));
    this.sessionKey = null;
  }

  async config(): Promise<{ treasury: PublicKey; collection: PublicKey; spinPrice: bigint }> {
    if (!this.cfg) {
      const c = await (this.program.account as Record<string, { fetch: (pda: PublicKey) => Promise<Record<string, unknown>> }>)
        .config.fetch(configPda());
      this.cfg = {
        treasury: c.treasury as PublicKey,
        collection: c.collection as PublicKey,
        spinPrice: BigInt((c.spinPrice as anchor.BN).toString()),
      };
    }
    return this.cfg;
  }

  private async rawSession(c: Connection): Promise<{ owner: PublicKey; data: SessionData } | null> {
    const acc = await c.getAccountInfo(sessionPda(this.player), "confirmed").catch(() => null);
    if (!acc || acc.data.length < SES_LEN) return null;
    return { owner: acc.owner, data: decodeSession(acc.data) };
  }

  /** Discover this session's ER node via the MagicBlock router (retries — the
   *  router can lag a moment behind a fresh delegation). */
  private async ensureEr(): Promise<Connection> {
    if (this.er) return this.er;
    const session = sessionPda(this.player).toBase58();
    for (let tries = 0; tries < 20; tries++) {
      const resp = await fetch(`${ROUTER}/getDelegationStatus`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [session] }),
      });
      const fqdn = (await resp.json())?.result?.fqdn as string | undefined;
      if (fqdn) { this.er = new Connection(fqdn, "confirmed"); return this.er; }
      await sleep(500);
    }
    throw new Error("MagicBlock router reports no ER delegation for this session");
  }

  /** Combined view the UI drives from (L1 for existence/delegation; ER when live). */
  async fetchState(): Promise<MachineState> {
    const l1 = await this.rawSession(connection);
    if (!l1) return { exists: false, delegated: false, sessionKeyHeld: this.sessionKeyHeld() };
    const delegated = l1.owner.equals(DELEGATION_PROGRAM);
    let live = l1.data;
    if (delegated) {
      try { live = (await this.rawSession(await this.ensureEr()))?.data ?? l1.data; }
      catch { /* router/ER unreachable — the L1 snapshot is still meaningful */ }
    }
    const view = deriveSessionView(live, {
      delegated, sessionKeyHeld: this.sessionKeyHeld(), now: Math.floor(Date.now() / 1000),
    });
    return { exists: true, delegated, sessionKeyHeld: this.sessionKeyHeld(), ...view };
  }

  /** THE one Privy approval: (close spent session +) create + fund + delegate. */
  async openSession(nSpins: number): Promise<string> {
    if (!Number.isInteger(nSpins) || nSpins < 1 || nSpins > 10) throw new Error("session size must be 1–10 spins");
    const cfg = await this.config();
    const need = openCostLamports(nSpins, cfg.spinPrice);
    const bal = await withRetry(() => connection.getBalance(this.player, "confirmed"), "balance check");
    if (bal < need) {
      const fmt = (l: number) => (l / 1e9).toFixed(2);
      throw new Error(`need ~${fmt(need)} devnet SOL for ${nSpins} spin${nSpins > 1 ? "s" : ""}, wallet has ${fmt(bal)} — fund via a devnet faucet`);
    }
    const st = await this.fetchState();
    const ixs: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
    if (st.exists) {
      if (!st.closeable) throw new Error("a live session already exists — finish or cash it out first");
      ixs.push(await this.program.methods.closeSession().accounts({
        closer: this.player, config: configPda(),
        session: sessionPda(this.player), player: this.player,
      }).instruction());
    }
    const sk = Keypair.generate();
    this.storeSessionKey(sk); // persist BEFORE funds move — reload-safe recovery
    const session = sessionPda(this.player);
    const [bufferSession] = PublicKey.findProgramAddressSync([Buffer.from("buffer"), session.toBuffer()], BULL_PROGRAM_ID);
    const [delRec] = PublicKey.findProgramAddressSync([Buffer.from("delegation"), session.toBuffer()], DELEGATION_PROGRAM);
    const [delMeta] = PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), session.toBuffer()], DELEGATION_PROGRAM);
    ixs.push(
      await this.program.methods.createSession(nSpins, sk.publicKey).accounts({
        player: this.player, config: configPda(), session,
        sessionKey: sk.publicKey, systemProgram: SystemProgram.programId,
      }).instruction(),
      SystemProgram.transfer({
        fromPubkey: this.player, toPubkey: sk.publicKey,
        lamports: CRANK_LAMPORTS_BASE + nSpins * CRANK_LAMPORTS_PER_SPIN,
      }),
      await this.program.methods.delegateSession().accountsPartial({
        player: this.player, bufferSession, delegationRecordSession: delRec,
        delegationMetadataSession: delMeta, session,
        ownerProgram: BULL_PROGRAM_ID, delegationProgram: DELEGATION_PROGRAM,
        systemProgram: SystemProgram.programId,
      }).instruction(),
    );
    const tx = new Transaction().add(...ixs);
    tx.feePayer = this.player; // usePrivySigner stamps the fresh blockhash
    const sig = await this.signAndSend(tx);
    this.sessionKey = sk;
    this.er = null; // fresh delegation → rediscover the ER node
    await this.ensureEr();
    return sig;
  }

  /** Gasless spin — session-key-signed, direct to the ER node. Returns the slot index. */
  async spin(): Promise<number> {
    if (!this.sessionKey) throw new Error("no session key held — open a session first");
    const er = await this.ensureEr();
    const before = await this.rawSession(er);
    const ix = new TransactionInstruction({
      programId: BULL_PROGRAM_ID,
      keys: [ // frozen DoSpin order, devnet-proven
        { pubkey: this.sessionKey.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda(), isSigner: false, isWritable: false },
        { pubkey: sessionPda(this.player), isSigner: false, isWritable: true },
        { pubkey: EPHEMERAL_QUEUE, isSigner: false, isWritable: true },
        { pubkey: identityPda(), isSigner: false, isWritable: false },
        { pubkey: VRF_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SLOT_HASHES, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(spinDisc),
    });
    await sendLocal(er, [ix], [this.sessionKey], "spin (ER)");
    const after = await this.rawSession(er);
    if (!after) throw new Error("session unreadable on the ER after spin");
    const i = after.data.spins.findIndex((sp, k) =>
      sp.status !== STATUS.EMPTY && (before?.data.spins[k]?.status ?? STATUS.EMPTY) === STATUS.EMPTY);
    if (i < 0) throw new Error("could not identify the new spin slot");
    return i;
  }

  /** ER VRF typically resolves in well under a second. Returns the 9 trait indices. */
  async pollRolled(i: number, { intervalMs = 250, budgetMs = 60_000 } = {}): Promise<number[]> {
    const er = await this.ensureEr();
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const s = await this.rawSession(er);
      const sp = s?.data.spins[i];
      if (sp?.status === STATUS.ROLLED) return sp.traits.slice(0, 9);
      if (Date.now() > deadline) throw new Error("VRF timed out in the ER — the spin is still pending");
      await sleep(intervalMs);
    }
  }

  /** Clear a stuck PENDING slot (permissionless; session key pays the ER fee). */
  async cancelSpin(i: number): Promise<void> {
    if (!this.sessionKey) throw new Error("no session key held");
    const er = await this.ensureEr();
    const ix = await this.program.methods.cancelSpin(i).accounts({
      session: sessionPda(this.player), player: this.player,
    }).instruction();
    await sendLocal(er, [ix], [this.sessionKey], "cancel spin (ER)");
  }

  /** Cash-out: finalize (ER) → undelegate → mint every ROLLED bull (L1) → sweep.
   *  Zero player signatures; idempotent per slot (only ROLLED slots mint). */
  async cashOut(onStep: (stage: CashOutStep, info?: { slot?: number; done?: number; mints?: MintResult[] }) => void = () => {}): Promise<MintResult[]> {
    if (!this.sessionKey) throw new Error("no session key held — cannot crank the cash-out");
    const session = sessionPda(this.player);
    const st = await this.fetchState();

    if (st.exists && st.delegated) {
      onStep("finalize");
      const er = await this.ensureEr();
      const finalizeIx = await this.program.methods.finalize()
        .accounts({ payer: this.sessionKey.publicKey, session }).instruction();
      await sendLocal(er, [finalizeIx], [this.sessionKey], "finalize (ER)");

      onStep("undelegate");
      const t = Date.now();
      for (;;) {
        const acc = await connection.getAccountInfo(session, "confirmed").catch(() => null);
        if (acc?.owner.equals(BULL_PROGRAM_ID)) break;
        if (Date.now() - t > 60_000) throw new Error("session did not undelegate back to L1 in 60s — your bulls are safe; retry cash-out");
        await sleep(500);
      }
    }

    const cfg = await this.config();
    const s = await this.rawSession(connection);
    if (!s) throw new Error("session unreadable on L1 after undelegation");
    const mints: MintResult[] = [];
    for (let i = 0; i < 10; i++) {
      if (s.data.spins[i].status !== STATUS.ROLLED) continue;
      const traits = s.data.spins[i].traits;
      const claim = claimPda(traits);
      const claimAcc = await withRetry(() => connection.getAccountInfo(claim, "confirmed"), "claim check");
      if (claimAcc && claimAcc.owner.equals(BULL_PROGRAM_ID)) { // duplicate combo (cosmically rare) → discard
        onStep("discard", { slot: i });
        const ix = await this.program.methods.discardSpin(i)
          .accounts({ session, player: this.player, claim }).instruction();
        await sendLocal(connection, [ix], [this.sessionKey], `discard spin ${i}`);
        mints.push({ slot: i, dna: traits.join("-"), asset: null });
        continue;
      }
      onStep("mint", { slot: i, done: mints.length });
      const asset = Keypair.generate();
      const ix = await this.program.methods.settleMint(i).accountsStrict({
        payer: this.sessionKey.publicKey, config: configPda(), session,
        player: this.player, treasury: cfg.treasury, claim,
        asset: asset.publicKey, collection: cfg.collection, collectionAuthority: authorityPda(),
        systemProgram: SystemProgram.programId, mplCoreProgram: MPL_CORE,
      }).instruction();
      await sendLocal(connection, [ix], [this.sessionKey, asset], `mint bull (slot ${i})`);
      mints.push({ slot: i, dna: traits.join("-"), traits: [...traits], asset: asset.publicKey.toBase58() });
    }

    onStep("sweep"); // best-effort: a failed sweep must never fail the cash-out
    try {
      const bal = await withRetry(() => connection.getBalance(this.sessionKey!.publicKey, "confirmed"), "sweep balance");
      if (bal > 1_000_000) {
        const ix = SystemProgram.transfer({
          fromPubkey: this.sessionKey!.publicKey, toPubkey: this.player, lamports: bal - 5_000,
        });
        await sendLocal(connection, [ix], [this.sessionKey!], "sweep session key");
      }
      this.dropSessionKey(); // spent — a new session mints a fresh one
    } catch { /* leftovers stay on the session key; retried next run */ }
    onStep("done", { mints });
    return mints;
  }

  /** Player reclaims session rent + unused-credit lamports (the one closing signature). */
  async closeSession(): Promise<string> {
    const ix = await this.program.methods.closeSession().accounts({
      closer: this.player, config: configPda(),
      session: sessionPda(this.player), player: this.player,
    }).instruction();
    const tx = new Transaction().add(ix);
    tx.feePayer = this.player;
    const sig = await this.signAndSend(tx);
    this.dropSessionKey();
    return sig;
  }
}

export const bullExplorerUrl = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
