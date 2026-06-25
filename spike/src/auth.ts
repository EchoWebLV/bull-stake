/**
 * Phase 1 — auth & free-tier access.
 *
 * Flow (quickstart / worldcup):
 *   1. POST /auth/guest/start            -> guest JWT
 *   2. program.methods.subscribe(...)    -> on-chain free-tier subscription (txSig)
 *   3. sign `${txSig}:${leagues}:${jwt}` -> POST /api/token/activate -> API token
 * Subsequent data calls send BOTH Authorization: Bearer <jwt> and X-Api-Token.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import {
  DEFAULT_DURATION_WEEKS,
  FREE_SERVICE_LEVEL_DEVNET,
  SEED,
  STANDARD_TIER_LEAGUES,
  SUBSCRIPTION_TOKEN_MINT,
} from "./config.js";
import { buildProgram } from "./idl.js";
import { env, envOpt, loadWallet, txline, detail, ok, info } from "./util.js";

export interface Auth {
  jwt: string;
  apiToken: string;
}

export interface SpikeContext {
  connection: Connection;
  wallet: Keypair;
  provider: anchor.AnchorProvider;
  program: anchor.Program;
  /** Base host for data endpoints (fixtures, scores, stat-validation). */
  baseUrl: string;
  /** Base host for auth (guest/start, token/activate). Defaults to baseUrl. */
  authBaseUrl: string;
}

/** Build connection + wallet + Anchor provider/program from env. */
export function createContext(): SpikeContext {
  const connection = new Connection(env("RPC_URL", "https://api.devnet.solana.com"), "confirmed");
  const wallet = loadWallet(env("WALLET_SECRET_KEY"));
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {
    commitment: "confirmed",
  });
  const program = buildProgram(provider);
  const baseUrl = env("TXLINE_BASE_URL");
  // Auth may live on a different host (docs mention oracle/oracle-dev); default
  // to the data host unless TXLINE_AUTH_BASE_URL is set.
  const authBaseUrl = envOpt("TXLINE_AUTH_BASE_URL") ?? baseUrl;
  return { connection, wallet, provider, program, baseUrl, authBaseUrl };
}

/** Step 1 — guest session JWT. */
export async function guestStart(ctx: SpikeContext): Promise<string> {
  const res = await txline<{ token?: string } | string>("/auth/guest/start", {
    method: "POST",
    baseUrl: ctx.authBaseUrl,
  });
  const jwt = typeof res === "string" ? res : res.token;
  if (!jwt) throw new Error(`No token in /auth/guest/start response: ${JSON.stringify(res)}`);
  detail(`guest JWT acquired (${jwt.slice(0, 12)}…)`);
  return jwt;
}

/**
 * Step 2 — on-chain free-tier subscription. Devnet free tier is Level 1; the
 * smart contract registers the subscription and charges 0 TxL for free tiers.
 * We create the user's Token-2022 ATA idempotently first (it must exist).
 */
export async function subscribeFreeTier(
  ctx: SpikeContext,
  opts: { serviceLevelId?: number; weeks?: number } = {},
): Promise<string> {
  const serviceLevelId =
    opts.serviceLevelId ?? Number(envOpt("SERVICE_LEVEL_ID") ?? FREE_SERVICE_LEVEL_DEVNET);
  const weeks = opts.weeks ?? Number(envOpt("DURATION_WEEKS") ?? DEFAULT_DURATION_WEEKS);
  const programId = ctx.program.programId;
  const user = ctx.wallet.publicKey;

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.PRICING_MATRIX)],
    programId,
  );
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEED.TOKEN_TREASURY)],
    programId,
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    SUBSCRIPTION_TOKEN_MINT,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const userTokenAccount = getAssociatedTokenAddressSync(
    SUBSCRIPTION_TOKEN_MINT,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const createUserAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    user,
    userTokenAccount,
    user,
    SUBSCRIPTION_TOKEN_MINT,
    TOKEN_2022_PROGRAM_ID,
  );

  info(`subscribing: serviceLevelId=${serviceLevelId} weeks=${weeks} (devnet free tier)`);
  const txSig = await ctx.program.methods
    .subscribe(serviceLevelId, weeks)
    .accounts({
      user,
      pricingMatrix: pricingMatrixPda,
      tokenMint: SUBSCRIPTION_TOKEN_MINT,
      userTokenAccount,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([createUserAtaIx])
    .rpc();

  ok(`subscribed on-chain: ${txSig}`);
  return txSig;
}

/** Step 3 — sign the message binding and activate the API token. */
export async function activate(
  ctx: SpikeContext,
  args: { jwt: string; txSig: string; leagues?: number[] },
): Promise<string> {
  const leagues = args.leagues ?? STANDARD_TIER_LEAGUES;
  const messageString = `${args.txSig}:${leagues.join(",")}:${args.jwt}`;
  const message = new TextEncoder().encode(messageString);
  const signatureBytes = nacl.sign.detached(message, ctx.wallet.secretKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  const res = await txline<{ token?: string } | string>("/api/token/activate", {
    method: "POST",
    baseUrl: ctx.authBaseUrl,
    jwt: args.jwt,
    body: { txSig: args.txSig, walletSignature, leagues },
  });
  const apiToken = typeof res === "string" ? res : res.token ?? "";
  if (!apiToken) throw new Error(`No API token in activate response: ${JSON.stringify(res)}`);
  ok(`API token activated (${apiToken.slice(0, 16)}…)`);
  return apiToken;
}

/** Run the full Phase-1 flow and return both credentials. */
export async function authenticate(ctx: SpikeContext): Promise<Auth> {
  const jwt = await guestStart(ctx);
  const txSig = await subscribeFreeTier(ctx);
  const apiToken = await activate(ctx, { jwt, txSig });
  return { jwt, apiToken };
}
