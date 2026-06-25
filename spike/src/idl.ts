/**
 * Local Anchor IDL for the devnet `txoracle` program.
 *
 * The IDL is NOT published on-chain (confirmed from programs/devnet.md), so we
 * cannot use `Program.at(...)` — we ship the IDL here and load it with
 * `new Program(idl, provider)`. Reproduced verbatim from the devnet IDL docs.
 *
 * Anchor 0.30 (IDL spec 0.1.0): struct fields are snake_case in the IDL and the
 * TS client camelCases them — so we build JS arg objects with camelCase keys
 * (fixtureId, eventsSubTreeRoot, isRightSibling, ...), matching the docs example.
 *
 * `validateStat`'s discriminator is taken verbatim from the docs. `subscribe`'s
 * is computed from sha256("global:subscribe")[..8] (standard Anchor derivation).
 */

import { createHash } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import { TXORACLE_PROGRAM_ID } from "./config.js";

/** Anchor global-instruction discriminator: sha256("global:<snake_name>")[..8]. */
export function ixDiscriminator(snakeName: string): number[] {
  return Array.from(
    createHash("sha256").update(`global:${snakeName}`).digest().subarray(0, 8),
  );
}

/** Verbatim from programs/devnet.md (sanity-checked against the computed value). */
const VALIDATE_STAT_DISCRIMINATOR = [107, 197, 232, 90, 191, 136, 105, 185];

// Self-check: warn (don't fail) if the docs' discriminator disagrees with the
// standard derivation — tells us the naming convention differs if it ever does.
const computedValidateStat = ixDiscriminator("validate_stat");
if (computedValidateStat.join(",") !== VALIDATE_STAT_DISCRIMINATOR.join(",")) {
  console.warn(
    `[idl] validate_stat discriminator mismatch: computed [${computedValidateStat}] ` +
      `vs docs [${VALIDATE_STAT_DISCRIMINATOR}] — using the docs value.`,
  );
}

export const TXORACLE_IDL = {
  address: TXORACLE_PROGRAM_ID.toBase58(),
  metadata: {
    name: "txoracle",
    version: "1.5.2",
    spec: "0.1.0",
    description: "TxODDS TxLINE Data system",
  },
  instructions: [
    {
      name: "validate_stat",
      discriminator: VALIDATE_STAT_DISCRIMINATOR,
      accounts: [{ name: "daily_scores_merkle_roots", writable: false, signer: false }],
      args: [
        { name: "ts", type: "i64" },
        { name: "fixture_summary", type: { defined: { name: "ScoresBatchSummary" } } },
        { name: "fixture_proof", type: { vec: { defined: { name: "ProofNode" } } } },
        { name: "main_tree_proof", type: { vec: { defined: { name: "ProofNode" } } } },
        { name: "predicate", type: { defined: { name: "TraderPredicate" } } },
        { name: "stat_a", type: { defined: { name: "StatTerm" } } },
        { name: "stat_b", type: { option: { defined: { name: "StatTerm" } } } },
        { name: "op", type: { option: { defined: { name: "BinaryExpression" } } } },
      ],
      returns: "bool",
    },
    {
      name: "subscribe",
      discriminator: ixDiscriminator("subscribe"),
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "pricing_matrix" },
        { name: "token_mint" },
        { name: "user_token_account", writable: true },
        { name: "token_treasury_vault", writable: true },
        { name: "token_treasury_pda" },
        { name: "token_program" },
        { name: "system_program" },
        { name: "associated_token_program" },
      ],
      args: [
        { name: "service_level_id", type: "u16" },
        { name: "weeks", type: "u8" },
      ],
    },
  ],
  accounts: [],
  types: [
    {
      name: "ScoresBatchSummary",
      type: {
        kind: "struct",
        fields: [
          { name: "fixture_id", type: "i64" },
          { name: "update_stats", type: { defined: { name: "ScoresUpdateStats" } } },
          { name: "events_sub_tree_root", type: { array: ["u8", 32] } },
        ],
      },
    },
    {
      name: "ScoresUpdateStats",
      type: {
        kind: "struct",
        fields: [
          { name: "update_count", type: "i32" },
          { name: "min_timestamp", type: "i64" },
          { name: "max_timestamp", type: "i64" },
        ],
      },
    },
    {
      name: "ProofNode",
      type: {
        kind: "struct",
        fields: [
          { name: "hash", type: { array: ["u8", 32] } },
          { name: "is_right_sibling", type: "bool" },
        ],
      },
    },
    {
      name: "StatTerm",
      type: {
        kind: "struct",
        fields: [
          { name: "stat_to_prove", type: { defined: { name: "ScoreStat" } } },
          { name: "event_stat_root", type: { array: ["u8", 32] } },
          { name: "stat_proof", type: { vec: { defined: { name: "ProofNode" } } } },
        ],
      },
    },
    {
      name: "ScoreStat",
      type: {
        kind: "struct",
        fields: [
          { name: "key", type: "u32" },
          { name: "value", type: "i32" },
          { name: "period", type: "i32" },
        ],
      },
    },
    {
      name: "TraderPredicate",
      type: {
        kind: "struct",
        fields: [
          { name: "threshold", type: "i32" },
          { name: "comparison", type: { defined: { name: "Comparison" } } },
        ],
      },
    },
    {
      name: "BinaryExpression",
      type: { kind: "enum", variants: [{ name: "Add" }, { name: "Subtract" }] },
    },
    {
      name: "Comparison",
      type: {
        kind: "enum",
        variants: [{ name: "GreaterThan" }, { name: "LessThan" }, { name: "EqualTo" }],
      },
    },
  ],
} as const;

/** Build a typed-loose Program from the local IDL. */
export function buildProgram(provider: anchor.AnchorProvider): anchor.Program {
  return new anchor.Program(TXORACLE_IDL as unknown as anchor.Idl, provider);
}
