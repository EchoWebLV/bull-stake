/**
 * Operator/testing tool: place a parimutuel bet from the operator wallet.
 * Usage:
 *   tsx scripts/place-bet.ts --fixture <id> --market <id> --bucket <0|1> --sol <amount>
 * bucket 0 = OVER (predicate true), 1 = UNDER (predicate false).
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import anchorDefault from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createContext } from "../../spike/src/auth.js";
import { deriveMarketPda, deriveVaultPda, derivePositionPda } from "../src/chain.ts";
import { PROGRAM_ID } from "../src/config.ts";

const BN = anchorDefault.BN;
const flag = (n: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

async function main() {
  const fixtureId = Number(flag("fixture"));
  const marketId = Number(flag("market", "1"));
  const bucket = Number(flag("bucket", "0"));
  const sol = Number(flag("sol", "0.1"));
  if (!fixtureId) throw new Error("--fixture <id> required");
  if (bucket !== 0 && bucket !== 1) throw new Error("--bucket must be 0 (over) or 1 (under)");

  const ctx = createContext();
  const idlPath = process.env.PROOFBET_IDL ?? "../../target/idl/proofbet.json";
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, ctx.provider);

  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const position = derivePositionPda(PROGRAM_ID, market, ctx.wallet.publicKey);
  const lamports = new BN(Math.round(sol * 1e9));

  const sig = await program.methods
    .placeBet(bucket, lamports)
    .accountsStrict({
      bettor: ctx.wallet.publicKey,
      market,
      vault,
      position,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(JSON.stringify({
    action: "place_bet", market: market.toBase58(),
    bettor: ctx.wallet.publicKey.toBase58(),
    bucket: bucket === 0 ? "OVER" : "UNDER", sol, sig,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
