const ENGINE = import.meta.env.VITE_ENGINE_URL ?? "http://localhost:8787";

export interface MatchState {
  fixtureId: number; home: string; away: string; minute: number; phase: string;
  scoreH: number; scoreA: number; corners1: number; corners2: number;
  totalCorners: number; isFinal: boolean;
}
export interface MarketState {
  pubkey: string; status: "open" | "settled" | "voided"; fixtureId: number; marketId: number;
  bucketTotals: [string, string]; totalPool: string; feeBps: number; winningBucket: number | null;
  entryCloseTs: number; settledValue: number | null;
  meta: { home: string; away: string; line: number; label: string };
  impliedOdds: { over: number; under: number };
}
const json = async (r: Response) => { if (!r.ok) throw new Error(`engine ${r.status}`); return r.json(); };
export const getMatch = (): Promise<MatchState> => fetch(`${ENGINE}/api/match`).then(json);
export const getMarket = (): Promise<MarketState> => fetch(`${ENGINE}/api/market`).then(json);
