/**
 * One-line framing under a market's odds buttons: explains that the displayed
 * multipliers are live parimutuel estimates — they shift as bets enter the pool
 * (including your own stake as you type) and only finalize when the market
 * settles. Keeps the stake-aware buttons honest without reading as a fixed quote.
 */
export function OddsNote() {
  return (
    <p className="odds-note">
      Live estimate — odds shift as bets join the pool and lock in at settlement.
    </p>
  );
}
