/**
 * Offline self-check — no wallet, no network calls, no credentials.
 * Confirms the local IDL loads into Anchor, both instructions resolve, the
 * binary normaliser handles every encoding, and validateStat serialises through
 * the Borsh coder. Run before the real spike: `npm run selfcheck`.
 */

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { buildProgram, ixDiscriminator } from "./idl.js";
import { buildBaseArgs, dailyScoresPda, toBytes32, type ScoresStatValidation } from "./validate.js";
import { ok, fail, info, section } from "./util.js";

let failures = 0;
const check = (label: string, cond: boolean, extra = "") => {
  if (cond) ok(`${label}${extra ? ` — ${extra}` : ""}`);
  else {
    fail(`${label}${extra ? ` — ${extra}` : ""}`);
    failures++;
  }
};

section("Offline self-check (no network calls made)");

// 1. IDL loads (no RPC traffic from construction).
const provider = new anchor.AnchorProvider(
  new Connection("https://api.devnet.solana.com", "confirmed"),
  new anchor.Wallet(Keypair.generate()),
  {},
);
const program = buildProgram(provider);
const methods = program.methods as unknown as Record<string, unknown>;
check("IDL loads, program id", program.programId.toBase58().length > 0, program.programId.toBase58());
check("validateStat method present", typeof methods.validateStat === "function");
check("subscribe method present", typeof methods.subscribe === "function");
check("subscribe discriminator computed", ixDiscriminator("subscribe").length === 8);

// 2. toBytes32 across encodings.
const arr = Array.from({ length: 32 }, (_, i) => i);
const hex = Buffer.from(arr).toString("hex");
const b64 = Buffer.from(arr).toString("base64");
check("toBytes32(array)", toBytes32(arr).length === 32);
check("toBytes32(hex)", toBytes32(hex).length === 32);
check("toBytes32(base64)", toBytes32(b64).length === 32);
check("toBytes32 round-trips", JSON.stringify(toBytes32(b64)) === JSON.stringify(arr));

// 3. PDA derivation.
check("dailyScoresPda derives", dailyScoresPda(program.programId, 1_750_000_000_000).toBase58().length > 0);

// 4. Full single-stat serialisation through the Borsh coder.
const node = { hash: b64, isRightSibling: false };
const v: ScoresStatValidation = {
  ts: 1,
  statToProve: { key: 7, value: 4, period: 0 },
  eventStatRoot: b64,
  summary: {
    fixtureId: 17952170,
    updateStats: { updateCount: 1, minTimestamp: 1_750_000_000_000, maxTimestamp: 1_750_000_000_000 },
    eventStatsSubTreeRoot: b64,
  },
  statProof: [node],
  subTreeProof: [node],
  mainTreeProof: [node],
};
const base = buildBaseArgs(v, program.programId, null);
const ix = await (program.methods as any)
  .validateStat(base.ts, base.fixtureSummary, base.fixtureProof, base.mainTreeProof,
    { threshold: 3, comparison: { greaterThan: {} } }, base.statA, null, null)
  .accounts({ dailyScoresMerkleRoots: base.pda })
  .instruction();
check("validateStat serialises (single-stat)", ix.data.length > 0, `${ix.data.length} bytes`);

// 5. Two-stat serialisation (combined corners, op add).
const v2: ScoresStatValidation = {
  ...v,
  statToProve2: { key: 8, value: 3, period: 0 },
  statProof2: [node],
};
const base2 = buildBaseArgs(v2, program.programId, "add");
check("two-stat lhs = a + b", base2.lhs === 7, `lhs=${base2.lhs}`);
const ix2 = await (program.methods as any)
  .validateStat(base2.ts, base2.fixtureSummary, base2.fixtureProof, base2.mainTreeProof,
    { threshold: 6, comparison: { greaterThan: {} } }, base2.statA, base2.statB, { add: {} })
  .accounts({ dailyScoresMerkleRoots: base2.pda })
  .instruction();
check("validateStat serialises (two-stat)", ix2.data.length > ix.data.length, `${ix2.data.length} bytes`);

info("");
if (failures === 0) ok("ALL SELF-CHECKS PASSED");
else fail(`${failures} self-check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
