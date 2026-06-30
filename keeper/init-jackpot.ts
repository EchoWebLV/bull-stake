/**
 * One-time genesis: initialize the singleton rolling Jackpot PDA (v2).
 *
 * Usage: npx tsx init-jackpot.ts
 *
 * Idempotent — if the jackpot already exists it prints its state and exits without
 * sending. Solana-only (no TxLINE). The keeper wallet (createContext) pays rent +
 * is the payer; the jackpot is a program-derived singleton (`[b"jackpot"]`) that
 * holds nothing but a bump, so no authority is stored on it.
 *
 * Supersedes the v1 init-vault.ts — the v2 program has no initialize_vault
 * instruction; the rolling jackpot replaces the old JackpotVault.
 */
import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createContext } from "../spike/src/auth.js";
import { loadProofbetProgram } from "./settle.js";

// ── Inline PDA helper (do NOT import engine/src/chain.ts — it uses ".ts"
//    extensions, which break this package's NodeNext typecheck). Mirrors the
//    inline-derive convention already used in settle-all.ts / settle-contest.ts. ──
function deriveJackpotPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("jackpot")], programId)[0];
}

async function main() {
  const ctx = createContext();
  const proofbet = loadProofbetProgram(ctx.provider);
  const keeper = ctx.wallet.publicKey;
  const jackpotPda = deriveJackpotPda(proofbet.programId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing: any = await (proofbet.account as any).jackpot.fetchNullable(jackpotPda);
  if (existing) {
    console.log(JSON.stringify({
      action: "init_jackpot", status: "already-initialized",
      jackpot: jackpotPda.toBase58(), bump: Number(existing.bump),
    }, null, 2));
    return;
  }

  const sig = await proofbet.methods
    .initializeJackpot()
    .accountsStrict({ keeper, jackpot: jackpotPda, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(JSON.stringify({
    action: "init_jackpot", status: "created", jackpot: jackpotPda.toBase58(), sig,
  }, null, 2));
}

// Only run when invoked directly — guard against import-time execution firing
// main() (wallet load + devnet I/O).
const isMain = process.argv[1]?.endsWith("init-jackpot.ts");
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
