import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  process.env.PROOFBET_PROGRAM_ID ?? "By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ",
);
export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

// M0 market identity (filled in after create-market).
export const M0 = {
  fixtureId: Number(process.env.M0_FIXTURE_ID ?? 0),
  marketId: Number(process.env.M0_MARKET_ID ?? 1),
  marketPubkey: process.env.M0_MARKET_PUBKEY ?? "",
  // Display metadata for the demo card:
  home: process.env.M0_HOME ?? "Brazil",
  away: process.env.M0_AWAY ?? "Spain",
  line: 9.5,
  label: "Total Corners",
};

export const LAMPORTS_PER_SOL = 1_000_000_000;
