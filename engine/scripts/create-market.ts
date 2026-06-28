/**
 * One-off: create the M0 market (Total Corners O/U 9.5) on devnet by reusing the
 * spike's SpikeContext (wallet + provider). Prints the market pubkey + the env
 * lines to paste into engine/.env. Usage:
 *   tsx scripts/create-market.ts --fixture <id> --close-mins 5
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import anchorDefault from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { createContext } from "../../spike/src/auth.js";
import { deriveMarketPda, deriveVaultPda } from "../src/chain.ts";
import { PROGRAM_ID } from "../src/config.ts";

const BN = anchorDefault.BN;

function flag(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const fixtureId = Number(flag("fixture"));
  const marketId = Number(flag("market", "1"));
  const closeMins = Number(flag("close-mins", "5"));
  if (!fixtureId) throw new Error("--fixture <id> is required");

  const ctx = createContext();
  const idlPath = process.env.PROOFBET_IDL ?? "../../target/idl/proofbet.json";
  const idl = JSON.parse(readFileSync(new URL(idlPath, import.meta.url), "utf8"));
  const program = new anchor.Program(idl as anchor.Idl, ctx.provider);

  const market = deriveMarketPda(PROGRAM_ID, fixtureId, marketId);
  const vault = deriveVaultPda(PROGRAM_ID, market);
  const entryCloseTs = Math.floor(Date.now() / 1000) + closeMins * 60;

  const args = {
    settleAuthority: ctx.wallet.publicKey,
    feeRecipient: null,
    statKey: 7,                       // P1 corners
    statKey2: 8,                      // P2 corners
    op: { add: {} },
    comparison: { greaterThan: {} },
    threshold: 9,                     // Over 9.5  ⇔  (c1+c2) > 9
    entryCloseTs: new BN(entryCloseTs),
    feeBps: 0,
  };

  const sig = await program.methods
    .initializeMarket(new BN(fixtureId), marketId, args)
    .accountsStrict({
      creator: ctx.wallet.publicKey,
      market,
      vault,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("created market:", market.toBase58(), "tx:", sig);
  console.log("\nPaste into engine/.env:");
  console.log(`M0_FIXTURE_ID=${fixtureId}`);
  console.log(`M0_MARKET_ID=${marketId}`);
  console.log(`M0_MARKET_PUBKEY=${market.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
