/**
 * Shared market template: 6 parimutuel markets per WC fixture — five binary
 * (over/under) plus one three-way 1X2 result market (home/draw/away in a single
 * shared pool, num_buckets = 3). All predicates are TxLINE-provable (corners /
 * goals / cards only). Period-encoded stat keys: full-game base, +1000 = 1st half.
 *
 * The 3-way result market reuses the goal-difference predicate (op subtract,
 * stat 1 − stat 2 = home − away). The keeper maps that diff's sign to the
 * winning bucket: HOME (0) when > 0, DRAW (1) when == 0, AWAY (2) when < 0.
 */
import anchorDefault from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";

const BN = anchorDefault.BN;

export type Op = "add" | "subtract" | null;
export type Cmp = "greaterThan" | "lessThan" | "equalTo";

/** Result-market bucket meaning (num_buckets = 3). */
export const RESULT_BUCKETS = ["home", "draw", "away"] as const;

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
  /** 2 = binary over/under, 3 = three-way home/draw/away. */
  numBuckets: number;
}

// Market ids start at 10 (the "v2 / three-way" namespace). The earlier binary
// build used ids 0–7; the on-chain layout changed incompatibly with num_buckets,
// and Solana account layouts are fixed, so legacy markets on already-seeded
// fixtures can't be migrated in place. Using a fresh id range lets the catalog
// create clean N-bucket markets alongside (and ignoring) the orphaned old ones.
export const MARKET_TEMPLATE: MarketDef[] = [
  { marketId: 10, label: "Total Corners O/U 9.5",      group: "corners", line: 9.5, statKey: 7,    statKey2: 8,    op: "add",      comparison: "greaterThan", threshold: 9, settleAt: "FT", numBuckets: 2 },
  { marketId: 11, label: "Total Goals O/U 2.5",        group: "goals",   line: 2.5, statKey: 1,    statKey2: 2,    op: "add",      comparison: "greaterThan", threshold: 2, settleAt: "FT", numBuckets: 2 },
  { marketId: 12, label: "Match Result",               group: "result",  line: 0,   statKey: 1,    statKey2: 2,    op: "subtract", comparison: "greaterThan", threshold: 0, settleAt: "FT", numBuckets: 3 },
  { marketId: 13, label: "Total Yellow Cards O/U 3.5", group: "cards",   line: 3.5, statKey: 3,    statKey2: 4,    op: "add",      comparison: "greaterThan", threshold: 3, settleAt: "FT", numBuckets: 2 },
  { marketId: 14, label: "1st-Half Corners O/U 4.5",  group: "corners", line: 4.5, statKey: 1007, statKey2: 1008, op: "add",      comparison: "greaterThan", threshold: 4, settleAt: "HT", numBuckets: 2 },
  { marketId: 15, label: "1st-Half Goals O/U 0.5",    group: "goals",   line: 0.5, statKey: 1001, statKey2: 1002, op: "add",      comparison: "greaterThan", threshold: 0, settleAt: "HT", numBuckets: 2 },
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
    numBuckets: def.numBuckets,
  };
}
