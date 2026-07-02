/* ──────────────────────────────────────────────────────────────────────────
 * Beat the Market — pure view-model mapper (same contract as liveGame.ts):
 * pure function of (server payload, wallet stakes, nowMs) → render model.
 * No RNG, no fabricated values — odds gaps render as "—".
 * ────────────────────────────────────────────────────────────────────────── */
import type { LineDto, LineDetailResponse } from "./api.ts";

const SOL = "◎";
const LAMPORTS = 1e9;
export const LINE_STAKE_PRESETS: bigint[] = [10_000_000n, 50_000_000n, 100_000_000n]; // ◎0.01/0.05/0.10

export const pctText = (milli: number | null | undefined): string =>
  milli == null ? "—" : `${(milli / 1000).toFixed(1)}%`;
export const solText = (lamports: bigint | number | string): string => {
  const n = Number(lamports) / LAMPORTS;
  return SOL + (n < 1 ? String(+n.toFixed(3)) : n.toFixed(2));
};

/** Pro-rata winnings estimate (fee is 0 for line markets).
 *  Pre-bet (pendingStake > 0): both pot and side grow by your stake.
 *  Post-bet: your recorded stake against the live totals. Floor division. */
export function estWinLamports(
  line: LineDto, bucket: 0 | 1, pendingStake: bigint, myStakes: [string, string] | null,
): bigint {
  const pot = BigInt(line.potLamports) + pendingStake;
  const side = BigInt(line.bucketTotals[bucket]) + pendingStake;
  const mine = pendingStake > 0n ? pendingStake : BigInt(myStakes?.[bucket] ?? "0");
  if (side === 0n || mine === 0n) return 0n;
  return (pot * mine) / side;
}

export interface SlateRowVM {
  fixtureId: number; title: string; favName: string;
  koLabel: string; kickoffMs: number;
  pctText: string; dirUp: boolean | null;
  potText: string; status: LineDto["status"]; clickable: boolean;
  resultText: string | null;
}

export function mapSlateRow(line: LineDto, _nowMs: number): SlateRowVM {
  const settled = line.status === "settled";
  const dirUp = line.current == null ? null : line.current.pctMilli >= line.openMilli;
  return {
    fixtureId: line.fixtureId,
    title: line.away ? `${line.home} v ${line.away}` : line.home,
    favName: line.favName,
    koLabel: new Date(line.kickoffMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    kickoffMs: line.kickoffMs,
    pctText: settled ? pctText(line.settledValueMilli) : pctText(line.current?.pctMilli),
    dirUp,
    potText: `${solText(line.potLamports)} pot`,
    status: line.status,
    clickable: true,
    resultText: settled && line.settledValueMilli != null
      ? `opened ${pctText(line.openMilli)} → closed ${pctText(line.settledValueMilli)} · ` +
        `${line.winningBucket === 0 ? "Above" : "Below"} won`
      : line.status === "voided" ? "voided — refunds open" : null,
  };
}

export interface LineOptionVM {
  bucket: 0 | 1; label: "Above" | "Below";
  sideTotalText: string;
  /** est win per preset stake, aligned with LINE_STAKE_PRESETS. */
  estWinTexts: string[];
}
export interface DetailVM {
  row: SlateRowVM;
  openText: string; currentText: string;
  deltaText: string | null; deltaUp: boolean;
  spark: { points: [number, number][]; openMilli: number };
  options: [LineOptionVM, LineOptionVM];
  presets: bigint[];
  canBet: boolean;
  myBucket: 0 | 1 | null; myStakeText: string | null;
  verdict: { tone: "win" | "lose"; text: string } | null;
  claim: { kind: "won" | "refund"; amountLamports: bigint } | null;
  houseBoostText: string;
}

export function mapLineDetail(detail: LineDetailResponse, nowMs: number): DetailVM {
  const { line, series, myStakes } = detail;
  const myAbove = BigInt(myStakes?.[0] ?? "0");
  const myBelow = BigInt(myStakes?.[1] ?? "0");
  const myBucket: 0 | 1 | null = myAbove > 0n ? 0 : myBelow > 0n ? 1 : null;
  const myStake = myBucket === 0 ? myAbove : myBucket === 1 ? myBelow : 0n;
  const open = line.status === "open";
  const cur = line.current?.pctMilli ?? null;
  const delta = cur == null ? null : cur - line.openMilli;

  let verdict: DetailVM["verdict"] = null;
  if (open && myBucket != null && cur != null && delta !== 0) {
    const ahead = (myBucket === 0) === (cur > line.openMilli);
    const side = myBucket === 0 ? "Above" : "Below";
    verdict = {
      tone: ahead ? "win" : "lose",
      text: `your ${side} is ${ahead ? "ahead ✓" : "behind ✕"} · ${pctText(cur)} vs ${pctText(line.openMilli)} open`,
    };
  }

  let claim: DetailVM["claim"] = null;
  if (line.status === "voided" && myAbove + myBelow > 0n) {
    claim = { kind: "refund", amountLamports: myAbove + myBelow };
  } else if (line.status === "settled" && line.winningBucket != null) {
    const wb = line.winningBucket as 0 | 1;
    const mine = wb === 0 ? myAbove : myBelow;
    if (mine > 0n) {
      const side = BigInt(line.bucketTotals[wb]);
      claim = { kind: "won", amountLamports: side === 0n ? 0n : (BigInt(line.potLamports) * mine) / side };
    }
  }

  const option = (bucket: 0 | 1): LineOptionVM => ({
    bucket,
    label: bucket === 0 ? "Above" : "Below",
    sideTotalText: solText(line.bucketTotals[bucket]),
    estWinTexts: LINE_STAKE_PRESETS.map((p) => solText(estWinLamports(line, bucket, p, myStakes))),
  });

  return {
    row: mapSlateRow(line, nowMs),
    openText: pctText(line.openMilli),
    currentText: pctText(cur),
    deltaText: delta == null ? null
      : `${delta >= 0 ? "▲ +" : "▼ "}${(delta / 1000).toFixed(1)} vs open`,
    deltaUp: (delta ?? 0) >= 0,
    spark: { points: series, openMilli: line.openMilli },
    options: [option(0), option(1)],
    presets: LINE_STAKE_PRESETS,
    canBet: open && myBucket == null && nowMs < line.kickoffMs,
    myBucket,
    myStakeText: myBucket == null ? null : solText(myStake),
    verdict,
    claim,
    houseBoostText: `pot includes ${solText(line.houseBoostLamports)} house boost`,
  };
}
