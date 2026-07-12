/* ──────────────────────────────────────────────────────────────────────────
 * Mascot — the player's identity profile-picture avatar (a colour-trait
 * creature). Colour is derived deterministically from a seed (wallet address)
 * so a given player always shows the same mascot.
 *
 * PLACEHOLDER ART: renders a stylised silhouette for now. When the real
 * hand-drawn PNGs land in web/public/mascot/ (mascot-tan.png, …), swap the
 * inline <svg> for  <img src={`/mascot/mascot-${color}.png`} …/>  — the props
 * and call-sites stay the same. See the `streak-mascot-pfp` memory.
 * ──────────────────────────────────────────────────────────────────────── */

export const MASCOT_COLORS = {
  tan: "#cbb986",
  green: "#54d98c",
  pink: "#e59be0",
  gray: "#9a9aa2",
} as const;

export type MascotColor = keyof typeof MASCOT_COLORS;
const ORDER: MascotColor[] = ["tan", "green", "pink", "gray"];

/** Stable colour pick from a seed (e.g. wallet address). Falls back to tan. */
export function mascotColorFor(seed?: string | null): MascotColor {
  if (!seed) return "tan";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ORDER[h % ORDER.length];
}

/** Silhouette path (48×48 viewBox) — shared with the canvas ticket renderer
 *  (lib/ticketCanvas.ts, Path2D). Swap for PNG art in both places when the
 *  real files land in web/public/mascot/. */
export const MASCOT_PATH =
  "M13 46 C9 42 10 33 11 29 C11 22 13 16 19 14 C18 10 20 8 23 9 C25 10 25 13 24 16 C31 15 38 18 41 24 L45 28 C46 30 43 32 40 31 L33 31 C31 34 32 40 34 46 Z";

export function Mascot({
  seed,
  color,
  size = 34,
  title,
}: {
  seed?: string | null;
  color?: MascotColor;
  size?: number;
  title?: string;
}) {
  const c = color ?? mascotColorFor(seed);
  const fill = MASCOT_COLORS[c];
  const ink = "#17130f";
  return (
    <span
      title={title}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2.5px solid " + ink,
        background: "#f4ecd8",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flex: "none",
        boxShadow: "2px 2px 0 " + ink,
      }}
    >
      <svg
        width={size * 0.86}
        height={size * 0.86}
        viewBox="0 0 48 48"
        style={{ display: "block", marginTop: size * 0.12 }}
        aria-hidden="true"
      >
        <path
          d={MASCOT_PATH}
          fill={fill}
          stroke={ink}
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
