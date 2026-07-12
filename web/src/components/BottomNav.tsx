export type Tab = "live" | "sweepstake" | "markets" | "bets" | "wallet";

const ICONS: Record<Tab, React.ReactNode> = {
  live: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M10.4 9l4.3 3-4.3 3z" fill="currentColor" stroke="none" />
    </svg>
  ),
  sweepstake: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4h10v3a5 5 0 01-10 0z" />
      <path d="M7 5H4.5v1.5A2.5 2.5 0 007 9M17 5h2.5v1.5A2.5 2.5 0 0117 9" />
      <path d="M12 12v3M9 19h6M10 19l.5-4h3l.5 4" />
    </svg>
  ),
  markets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
      <path d="M6.3 6.3a8 8 0 000 11.4M17.7 6.3a8 8 0 010 11.4" />
      <path d="M9.2 9.2a4 4 0 000 5.6M14.8 9.2a4 4 0 010 5.6" />
    </svg>
  ),
  bets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7.5A1.5 1.5 0 015.5 6h13A1.5 1.5 0 0120 7.5V10a2 2 0 000 4v2.5a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 16.5V14a2 2 0 000-4z" />
      <path d="M9.2 6.2v11.6" strokeDasharray="2 2.2" />
    </svg>
  ),
  wallet: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8A2.5 2.5 0 016 5.5h11" />
      <rect x="3.5" y="7.5" width="17" height="11.5" rx="2.5" />
      <circle cx="16.5" cy="13.2" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  ),
};

const LABELS: Record<Tab, string> = { live: "Live", sweepstake: "Sweep", markets: "Market", bets: "My Bets", wallet: "Wallet" };
// The `sweepstake` slot (formerly the hidden single-match Parlay) is reborn as
// The Daily Pearly (spec §1/§7) — App.tsx now renders PearlyView.tsx there.
// SweepstakeView.tsx itself stays in the tree hidden-not-deleted (unrouted; the
// old daily-card create cron is paused, DAILY_CARD_CREATE=0) per repo convention.
// `markets` (Beat-the-Market day game) is hidden-not-deleted: pulled from the nav
// but still routed in App.tsx and reachable if re-added here.
const TABS: Tab[] = ["live", "sweepstake", "bets", "wallet"];

export function BottomNav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="bottomnav" aria-label="Primary">
      {TABS.map((t) => (
        <button
          key={t}
          className={`navitem ${tab === t ? "active" : ""}`}
          aria-current={tab === t ? "page" : undefined}
          onClick={() => onChange(t)}
        >
          <span className="navicon">{ICONS[t]}</span>
          <span className="navlabel">{LABELS[t]}</span>
        </button>
      ))}
    </nav>
  );
}
