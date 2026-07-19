/* ──────────────────────────────────────────────────────────────────────────
 * Canvas ticket renderer + share plumbing. DOM-only (document/canvas/
 * navigator) — ALL decisions live in pearlyTicket.ts (pure, unit-tested);
 * this file just draws the model and routes the PNG. It has no unit tests on
 * purpose (vitest env is node, no canvas): verified via /ticket-dev.html on
 * the Vite dev server, and e2e from the Sweep HUD once a card is live.
 *
 * Visual language mirrors mockups/26-semifinal-one-match-card.html's ticket:
 * cream stub on dark, hard ink offset-shadow, punch holes.
 * ────────────────────────────────────────────────────────────────────────── */
import { MASCOT_PATH, MASCOT_COLORS } from "../components/Mascot.tsx";
import { pickSharePath, type SharePath, type TicketModel } from "./pearlyTicket.ts";

const W = 1080, H = 1350;                       // 4:5 portrait — social-friendly
const INK = "#17130f", CREAM = "#f0e7d4", PINK = "#b0006d", BG = "#17131b";
const DISP = '"Archivo", system-ui, sans-serif';
const BODY = '"Inter", system-ui, sans-serif';

/** Ask for the app's @font-face faces (App.css / the harness page declare
 *  them) so canvas text doesn't rasterize with fallbacks; never fatal. */
async function ensureFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`700 80px ${DISP}`),
      document.fonts.load(`400 44px ${BODY}`),
    ]);
  } catch { /* draw with the fallback stack */ }
}

/** Largest font size in [minPx, startPx] at which `text` fits `avail` px for
 *  the given font template (`px` is interpolated). Returns the chosen size. */
function fitPx(
  ctx: CanvasRenderingContext2D, text: string, avail: number,
  startPx: number, minPx: number, font: (px: number) => string,
): number {
  let px = startPx;
  for (; px > minPx; px--) {
    ctx.font = font(px);
    if (ctx.measureText(text).width <= avail) break;
  }
  return px;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderTicketPng(model: TicketModel): Promise<Blob> {
  await ensureFonts();
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  // dark backdrop + cream ticket with hard offset shadow + punch holes
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
  const M = 70;
  ctx.fillStyle = "#000"; rr(ctx, M + 12, M + 12, W - 2 * M, H - 2 * M, 34); ctx.fill();
  ctx.fillStyle = CREAM; rr(ctx, M, M, W - 2 * M, H - 2 * M, 34); ctx.fill();
  ctx.strokeStyle = INK; ctx.lineWidth = 7; rr(ctx, M, M, W - 2 * M, H - 2 * M, 34); ctx.stroke();
  for (const px of [M, W - M]) {                 // ticket punch holes
    ctx.beginPath(); ctx.arc(px, H / 2, 26, 0, Math.PI * 2);
    ctx.fillStyle = BG; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = 6; ctx.stroke();
  }

  const L = M + 64, R = W - M - 64;              // text gutters
  let y = M + 150;

  // brand row: mascot stamp + wordmark
  ctx.save();
  ctx.translate(L, y - 78); ctx.scale(2.1, 2.1);
  ctx.beginPath(); ctx.arc(24, 24, 26, 0, Math.PI * 2);
  ctx.fillStyle = "#f4ecd8"; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.stroke();
  const p = new Path2D(MASCOT_PATH);
  ctx.fillStyle = MASCOT_COLORS[model.mascotColor]; ctx.strokeStyle = INK; ctx.lineWidth = 2.5;
  ctx.fill(p); ctx.stroke(p);
  ctx.restore();
  ctx.fillStyle = INK; ctx.font = `700 88px ${DISP}`; ctx.textBaseline = "alphabetic";
  ctx.fillText(model.brand, L + 130, y);
  y += 58;
  ctx.font = `400 34px ${BODY}`; ctx.globalAlpha = 0.72;
  ctx.fillText(model.subtitle, L, y); ctx.globalAlpha = 1;

  // match + tone line between dashed rules
  y += 74;
  ctx.strokeStyle = "rgba(23,19,15,.4)"; ctx.lineWidth = 4; ctx.setLineDash([14, 12]);
  ctx.beginPath(); ctx.moveTo(L, y - 46); ctx.lineTo(R, y - 46); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 56px ${DISP}`; ctx.fillStyle = INK;
  ctx.fillText(model.matchLine, L, y + 8);
  const toneSpace = R - (L + ctx.measureText(model.matchLine).width + 36);
  ctx.textAlign = "right";
  ctx.fillStyle = model.tone === "busted" ? "#a3322a" : model.tone === "perfect" ? "#1d7c44" : PINK;
  ctx.font = `400 ${fitPx(ctx, model.toneLine, toneSpace, 34, 20, (px) => `400 ${px}px ${BODY}`)}px ${BODY}`;
  ctx.fillText(model.toneLine, R, y + 4); ctx.textAlign = "left"; ctx.fillStyle = INK;
  y += 44;
  ctx.setLineDash([14, 12]); ctx.strokeStyle = "rgba(23,19,15,.4)";
  ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); ctx.setLineDash([]);

  // pick rows — market left, pick right; uncarried legs fade (still shown)
  y += 76;
  const rowGap = Math.min(84, Math.floor(620 / Math.max(1, model.rows.length)));
  for (const row of model.rows) {
    ctx.font = `400 42px ${BODY}`; ctx.globalAlpha = row.carried ? 1 : 0.45;
    ctx.fillText(`${row.chaos ? "chaos · " : ""}${row.market}`, L, y);
    ctx.textAlign = "right"; ctx.font = `700 44px ${DISP}`;
    ctx.fillText(row.carried ? `${row.pick} ✓` : row.pick, R, y);
    ctx.textAlign = "left"; ctx.globalAlpha = 1;
    y += rowGap;
  }

  // bottom block: big multiplier left, money + footer right. The right block
  // shrinks to fit the space the multiplier leaves (×64 vs ×256 vary a lot),
  // so the two can never collide.
  const by = H - M - 150;
  ctx.setLineDash([14, 12]); ctx.strokeStyle = "rgba(23,19,15,.4)";
  ctx.beginPath(); ctx.moveTo(L, by - 84); ctx.lineTo(R, by - 84); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = `700 130px ${DISP}`; ctx.fillStyle = PINK;
  ctx.fillText(model.multiplierLabel, L, by + 26);
  const rightSpace = R - (L + ctx.measureText(model.multiplierLabel).width + 44);
  ctx.textAlign = "right"; ctx.fillStyle = INK;
  ctx.font = `700 ${fitPx(ctx, model.moneyLine, rightSpace, 36, 22, (px) => `700 ${px}px ${BODY}`)}px ${BODY}`;
  ctx.fillText(model.moneyLine, R, by - 14);
  ctx.globalAlpha = 0.72;
  const footText = model.footer;
  ctx.font = `400 ${fitPx(ctx, footText, rightSpace, 32, 20, (px) => `400 ${px}px ${BODY}`)}px ${BODY}`;
  ctx.fillText(footText, R, by + 34);
  ctx.globalAlpha = 1; ctx.textAlign = "left";

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

/** Render + deliver via the best available path. Returns the path used, or
 *  "cancelled" when the user dismissed the native share sheet — callers show
 *  feedback for real deliveries and stay quiet on cancel. */
export async function shareTicketPng(model: TicketModel): Promise<SharePath | "cancelled"> {
  const blob = await renderTicketPng(model);
  const file = new File([blob], model.fileName, { type: "image/png" });
  const caps = {
    canShareFiles: typeof navigator.share === "function"
      && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] }),
    hasClipboardItem: typeof ClipboardItem === "function" && !!navigator.clipboard?.write,
  };
  const path = pickSharePath(caps);
  if (path === "share") {
    try {
      await navigator.share({ files: [file], title: "BullStake", text: "My Sweep card" });
      return "share";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelled";
      throw e;
    }
  }
  if (path === "clipboard") {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return "clipboard";
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = model.fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "download";
}
