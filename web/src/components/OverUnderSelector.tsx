/**
 * Two-way Over/Under pick control (num_buckets 2): OVER (0) / UNDER (1).
 *
 * Pure presentational — no stake input. Mirrors the inline `.r3` 3-way pick
 * buttons used in the parlay card, with a parallel `.r2` style. When the leg is
 * settled the winning bucket is highlighted (`.won`) and picking is disabled.
 */
export function OverUnderSelector({
  value, onPick, line, disabled = false, winningBucket = null,
}: {
  value: number | undefined;
  onPick: (b: number) => void;
  line: number;
  disabled?: boolean;
  winningBucket?: number | null;
}) {
  const settled = winningBucket != null;
  const outcomes = [
    { bucket: 0, label: `Over ${line}`, cls: "over" as const },
    { bucket: 1, label: `Under ${line}`, cls: "under" as const },
  ];
  return (
    <div className="result3">
      {outcomes.map((o) => {
        const sel = value === o.bucket;
        const won = settled && winningBucket === o.bucket;
        return (
          <button
            key={o.bucket}
            className={`r2 r2-${o.cls}${sel ? " sel" : ""}${won ? " won" : ""}`}
            aria-pressed={!disabled ? sel : undefined}
            disabled={disabled}
            onClick={() => !disabled && onPick(o.bucket)}
          >
            <span className="r3-team">{won ? "✓ " : ""}{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
