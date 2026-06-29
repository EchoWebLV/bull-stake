/**
 * One-time genesis: initialize the singleton JackpotVault PDA for the daily sweepstake.
 *
 * Usage: npx tsx init-vault.ts
 *
 * Idempotent — if the vault already exists it prints its state and exits without sending.
 * Solana-only (no TxLINE). The keeper wallet (createContext) pays rent + becomes the payer;
 * the vault is a program-derived singleton, so no authority is stored on it.
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createContext } from "../spike/src/auth.js";
import { loadProofbetProgram } from "./settle.js";

async function main() {
  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const vault = PublicKey.findProgramAddressSync([Buffer.from("jackpot_vault")], proofbet.programId)[0];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing: any = await (proofbet.account as any).jackpotVault.fetchNullable(vault);
  if (existing) {
    console.log(JSON.stringify({
      action: "init_vault", status: "already-initialized", vault: vault.toBase58(),
      activeContestId: Number(existing.activeContestId), reserved: existing.reserved.toString(),
    }, null, 2));
    return;
  }

  const sig = await proofbet.methods
    .initializeVault()
    .accountsStrict({ keeper, vault, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(JSON.stringify({ action: "init_vault", status: "created", vault: vault.toBase58(), sig }, null, 2));
}

// Only run when invoked directly — guard against import-time execution firing main().
const isMain = process.argv[1]?.endsWith("init-vault.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
