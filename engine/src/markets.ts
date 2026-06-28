/**
 * Shared market template: 8 binary parimutuel markets per WC fixture.
 * All predicates are TxLINE-provable (corners / goals / cards only).
 * Period-encoded stat keys: full-game base, +1000 = 1st half.
 */
import anchorDefault from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

const BN = anchorDefault.BN;

export type Op = "add" | "subtract" | null;
export type Cmp = "greaterThan" | "lessThan" | "equalTo";

export interface MarketDef {
  marketId: number;
  label: string;
  group: "corners" | "goals" | "result" | "cards";
  line: number;
  statKey: number;
  statKey2: number | null;
  op: Op;
  comparison: Cmp;
  threshold: number;
  settleAt: "HT" | "FT";
}

export const MARKET_TEMPLATE: MarketDef[] = [
  { marketId: 0, label: "Total Corners O/U 9.5",      group: "corners", line: 9.5, statKey: 7,    statKey2: 8,    op: "add",      comparison: "greaterThan", threshold: 9, settleAt: "FT" },
  { marketId: 1, label: "Total Goals O/U 2.5",        group: "goals",   line: 2.5, statKey: 1,    statKey2: 2,    op: "add",      comparison: "greaterThan", threshold: 2, settleAt: "FT" },
  { marketId: 2, label: "Home Win",                   group: "result",  line: 0,   statKey: 1,    statKey2: 2,    op: "subtract", comparison: "greaterThan", threshold: 0, settleAt: "FT" },
  { marketId: 3, label: "Draw",                       group: "result",  line: 0,   statKey: 1,    statKey2: 2,    op: "subtract", comparison: "equalTo",     threshold: 0, settleAt: "FT" },
  { marketId: 4, label: "Away Win",                   group: "result",  line: 0,   statKey: 1,    statKey2: 2,    op: "subtract", comparison: "lessThan",    threshold: 0, settleAt: "FT" },
  { marketId: 5, label: "Total Yellow Cards O/U 3.5", group: "cards",   line: 3.5, statKey: 3,    statKey2: 4,    op: "add",      comparison: "greaterThan", threshold: 3, settleAt: "FT" },
  { marketId: 6, label: "1st-Half Corners O/U 4.5",  group: "corners", line: 4.5, statKey: 1007, statKey2: 1008, op: "add",      comparison: "greaterThan", threshold: 4, settleAt: "HT" },
  { marketId: 7, label: "1st-Half Goals O/U 0.5",    group: "goals",   line: 0.5, statKey: 1001, statKey2: 1002, op: "add",      comparison: "greaterThan", threshold: 0, settleAt: "HT" },
];

/** Map Op string to Anchor enum object (null → null). */
function toAnchorOp(op: Op): null | { add: Record<string, never> } | { subtract: Record<string, never> } {
  if (op === "add") return { add: {} };
  if (op === "subtract") return { subtract: {} };
  return null;
}

/** Map Cmp string to Anchor enum object. */
function toAnchorCmp(
  cmp: Cmp,
): { greaterThan: Record<string, never> } | { lessThan: Record<string, never> } | { equalTo: Record<string, never> } {
  if (cmp === "lessThan") return { lessThan: {} };
  if (cmp === "equalTo") return { equalTo: {} };
  return { greaterThan: {} };
}

/**
 * Convert a MarketDef to the exact args object expected by the program's
 * `initializeMarket` instruction (matches create-market.ts's `args`).
 */
export function toInitArgs(
  def: MarketDef,
  settleAuthority: PublicKey,
  entryCloseTsSec: number,
) {
  return {
    settleAuthority,
    feeRecipient: null,
    statKey: def.statKey,
    statKey2: def.statKey2,
    op: toAnchorOp(def.op),
    comparison: toAnchorCmp(def.comparison),
    threshold: def.threshold,
    entryCloseTs: new BN(entryCloseTsSec),
    feeBps: 0,
  };
}
