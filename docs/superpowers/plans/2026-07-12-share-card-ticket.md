# Share-Your-Card Ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Share my card" button on the Sweep tab that renders the wallet's held card as a PNG ticket (brand, mascot, picks, multiplier, jackpot) and shares it via Web Share → clipboard → download fallback.

**Architecture:** Pure ticket **model** built from the existing `PearlyCardVM` (node-testable, zero DOM), a thin **canvas renderer** + share orchestrator (DOM-only, verified in a dev harness page), and a small **wiring** change in `PearlyView` (button in `MyCardHud` + `SettledCard`). Mirrors the repo's mapper-pattern: pure functions tested, components thin.

**Tech Stack:** React 18 + Vite, vitest (node env — NO DOM in unit tests), Canvas 2D, Web Share API L2 / Async Clipboard. Visual reference: `mockups/26-semifinal-one-match-card.html` (share ticket modal). Spec: `docs/superpowers/specs/2026-07-12-hackathon-submission-run-design.md` (WS3 share-your-card item).

**Copy rules (hard):** multiplier framing only — the words "weight", "2^", "mask", "active legs", "perfect_weight" must not appear in UI strings. Brand is "Bull Stake"; the game is "The Daily Sweep".

**Commit discipline (this branch, this week):** the working tree already carries ~1,150 lines of in-flight skin work in `PearlyView.tsx`, `pearlyCard.ts`, `App.css`. Commit ONLY the new standalone files (`pearlyTicket.ts`, its test, `ticketCanvas.ts`, harness) — edits to already-dirty shared files stay uncommitted alongside the in-flight work (the submission-run WS1 batch commit sweeps them). Never `git add -A`.

**Verification reality:** no fixtures exist on Jul 12–13, so the live app has NO card today and the HUD is unreachable end-to-end. Unit tests + the dev harness page carry verification now; the real-HUD e2e happens on the Jul 14 card during the semifinal rehearsal.

---

## File Structure

- Create `web/src/lib/pearlyTicket.ts` — `buildTicketModel`, `pickSharePath`, types (pure).
- Create `web/test/pearlyTicket.test.ts` — unit tests for both.
- Modify `web/src/lib/pearlyCard.ts` — add `marketId` to `PearlyLegVM`; export `CHAOS_MARKET_ID`.
- Modify `web/test/pearlyCard.test.ts` — one assertion for `marketId` passthrough.
- Modify `web/src/components/Mascot.tsx` — export `MASCOT_PATH` + `MASCOT_COLORS` for canvas reuse.
- Create `web/src/lib/ticketCanvas.ts` — `renderTicketPng`, `shareTicketPng` (DOM-only, no unit tests).
- Create `web/ticket-dev.html` + `web/src/ticketDev.ts` — dev-only harness page (Vite dev serves root HTML; not part of the prod build).
- Modify `web/src/components/PearlyView.tsx` — `onShare` handler + button in `MyCardHud` and `SettledCard`.
- Modify `web/src/App.css` — `.pl-share` button.

---

### Task 1: `marketId` on the leg view-model

**Files:**
- Modify: `web/src/lib/pearlyCard.ts` (interface `PearlyLegVM` ~line 202, mapper ~line 344, `CHAOS_MARKET_ID` ~line 40)
- Test: `web/test/pearlyCard.test.ts`

- [ ] **Step 1: Write the failing test** — in the existing `describe("mapPearlyCard", ...)` block add:

```ts
it("exposes each leg's marketId on the VM (ticket + chaos badge consumers)", () => {
  const c = card({ legs: [leg({ marketId: 12 }), leg({ marketId: 17, buckets: 2 })] });
  const vm = mapPearlyCard(c, null, NOW_MS);
  expect(vm.legs.map((l) => l.marketId)).toEqual([12, 17]);
});
```

- [ ] **Step 2: Run it — expect FAIL** — `cd web && npx vitest run test/pearlyCard.test.ts` → type error / undefined `marketId`.

- [ ] **Step 3: Implement** — in `pearlyCard.ts`: change `const CHAOS_MARKET_ID = 17;` to `export const CHAOS_MARKET_ID = 17;`. In `PearlyLegVM` add after `fixtureId`:

```ts
  marketId: number;         // catalog market id (17 = the day's chaos leg)
```

In `mapPearlyCard`'s legs map, add `marketId: leg.marketId,` right after `fixtureId: leg.fixtureId,`.

- [ ] **Step 4: Run web suite — expect PASS** — `cd web && npm test` (166 → 167 passing).

- [ ] **Step 5: Commit** — SKIPPED (shared dirty file; per commit discipline above, stays in the working tree).

---

### Task 2: Pure ticket model + share-path chooser

**Files:**
- Create: `web/src/lib/pearlyTicket.ts`
- Test: `web/test/pearlyTicket.test.ts`

- [ ] **Step 1: Write the failing tests** — new file `web/test/pearlyTicket.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTicketModel, pickSharePath, type TicketModel } from "../src/lib/pearlyTicket.ts";
import { mapPearlyCard } from "../src/lib/pearlyCard.ts";
import type { Card, CardLeg, MyCard } from "../src/lib/api.ts";

const NOW = 1_800_000_000;
const NOW_MS = NOW * 1000; // 2027-01-15 UTC — fixed for determinism

function leg(over: Partial<CardLeg> = {}): CardLeg {
  return {
    fixtureId: 1, home: "France", away: "Spain", kickoffTs: null,
    marketId: 12, label: "Match Result", group: "result", buckets: 3,
    lockTs: NOW + 3600,
    ...over,
  };
}
function myCard(over: Partial<MyCard> = {}): MyCard {
  return { picks: [0, 1], weight: 4, activeMask: [true, true], alive: true, ...over } as MyCard;
}
function card(over: Partial<Card> = {}): Card {
  return {
    contestId: 777, status: "open", lockTs: NOW + 3600, settleAfterTs: NOW + 999999,
    entryPrice: "50000000", pot: "1900000000", jackpot: "70000000",
    legs: [leg(), leg({ marketId: 17, label: "Red Card Shown", buckets: 2 })],
    myCard: myCard(),
    ...over,
  };
}
const vmOf = (c: Card) => mapPearlyCard(c, c.myCard, NOW_MS);

describe("buildTicketModel", () => {
  it("returns null when the wallet holds no card", () => {
    expect(buildTicketModel(mapPearlyCard(card({ myCard: null }), null, NOW_MS), { nowMs: NOW_MS })).toBeNull();
    expect(buildTicketModel(mapPearlyCard(null, null, NOW_MS), { nowMs: NOW_MS })).toBeNull();
  });

  it("builds one row per leg with the picked option's label and the chaos flag", () => {
    const m = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toMatchObject({ market: "Match Result", pick: "France", chaos: false });
    expect(m.rows[1]).toMatchObject({ market: "Red Card Shown", pick: "No", chaos: true });
  });

  it("carries brand, multiplier, contest file name, and jackpot money lines", () => {
    const m = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    expect(m.brand).toBe("BULL STAKE");
    expect(m.multiplierLabel).toBe("×4");
    expect(m.fileName).toBe("bull-stake-card-777.png");
    expect(m.moneyLine).toContain("◎1.97");   // pot+jackpot via potText
    expect(m.moneyLine.toUpperCase()).toContain("JACKPOT");
    expect(m.subtitle).toContain("#777");
  });

  it("sets the tone per card state: riding / busted / perfect / rolled", () => {
    expect((buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel).tone).toBe("riding");
    const dead = card({ myCard: myCard({ alive: false }) });
    expect((buildTicketModel(vmOf(dead), { nowMs: NOW_MS }) as TicketModel).tone).toBe("busted");
    const won = card({ status: "settled", myCard: myCard() });
    expect((buildTicketModel(vmOf(won), { nowMs: NOW_MS }) as TicketModel).tone).toBe("perfect");
    const rolled = card({ status: "rolledOver", myCard: myCard({ alive: false }) });
    expect((buildTicketModel(vmOf(rolled), { nowMs: NOW_MS }) as TicketModel).tone).toBe("rolled");
  });

  it("single-match card reads the match name; multi-match reads the count", () => {
    const one = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    expect(one.matchLine).toBe("France v Spain");
    const multi = card({
      legs: [leg(), leg({ fixtureId: 2, home: "Norway", away: "England" })],
      myCard: myCard(),
    });
    expect((buildTicketModel(vmOf(multi), { nowMs: NOW_MS }) as TicketModel).matchLine).toBe("2 matches · 2 legs");
  });

  it("derives the mascot color deterministically from the wallet seed", () => {
    const a = buildTicketModel(vmOf(card()), { nowMs: NOW_MS, wallet: "walletA" }) as TicketModel;
    const b = buildTicketModel(vmOf(card()), { nowMs: NOW_MS, wallet: "walletA" }) as TicketModel;
    expect(a.mascotColor).toBe(b.mascotColor);
  });

  it("never emits banned jargon in any string", () => {
    const m = buildTicketModel(vmOf(card()), { nowMs: NOW_MS }) as TicketModel;
    const all = JSON.stringify(m).toLowerCase();
    for (const banned of ["weight", "2^", "mask", "active legs"]) expect(all).not.toContain(banned);
  });
});

describe("pickSharePath", () => {
  it("prefers native file share, then clipboard, then download", () => {
    expect(pickSharePath({ canShareFiles: true, hasClipboardItem: true })).toBe("share");
    expect(pickSharePath({ canShareFiles: false, hasClipboardItem: true })).toBe("clipboard");
    expect(pickSharePath({ canShareFiles: false, hasClipboardItem: false })).toBe("download");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** — `cd web && npx vitest run test/pearlyTicket.test.ts` → module not found.

- [ ] **Step 3: Implement** — new file `web/src/lib/pearlyTicket.ts`:

```ts
/* Share-ticket model — PURE (node-testable). Everything the canvas renderer
 * draws, derived from the existing PearlyCardVM. No DOM, no Date.now(). */
import type { PearlyCardVM } from "./pearlyCard.ts";
import { CHAOS_MARKET_ID } from "./pearlyCard.ts";
import { mascotColorFor, type MascotColor } from "../components/Mascot.tsx";

export type TicketTone = "riding" | "busted" | "perfect" | "rolled";
export interface TicketRow { market: string; pick: string; chaos: boolean; carried: boolean }
export interface TicketModel {
  brand: string; subtitle: string; matchLine: string;
  tone: TicketTone; toneLine: string;
  rows: TicketRow[];
  multiplierLabel: string; moneyLine: string; footer: string;
  mascotColor: MascotColor; fileName: string;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function utcDateLabel(nowMs: number): string {
  const d = new Date(nowMs);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

const TONE_LINE: Record<TicketTone, (mult: string) => string> = {
  riding:  (m) => `RIDING · ${m} IF PERFECT`,
  busted:  ()  => "BUSTED — THE POT ROLLS ON",
  perfect: (m) => `PERFECT CARD ✓ · ${m} SHARE`,
  rolled:  ()  => "NOBODY SWEPT IT — POT ROLLED",
};

export function buildTicketModel(
  vm: PearlyCardVM,
  opts: { nowMs: number; wallet?: string | null },
): TicketModel | null {
  if (vm.empty || vm.contestId == null) return null;
  const tone: TicketTone | null =
    vm.myCardState === "entered-alive" ? "riding"
    : vm.myCardState === "dead" ? "busted"
    : vm.myCardState === "settled-won" ? "perfect"
    : vm.myCardState === "settled-rollover" ? "rolled"
    : null;
  if (!tone) return null;
  const mult = vm.myWeightLabel;
  if (!mult) return null;

  const rows: TicketRow[] = vm.legs
    .filter((l) => l.myPick != null)
    .map((l) => ({
      market: l.marketLabel,
      pick: l.options.find((o) => o.bucket === l.myPick)?.label ?? "—",
      chaos: l.marketId === CHAOS_MARKET_ID,
      carried: l.carried !== false,
    }));
  if (rows.length === 0) return null;

  const matches = [...new Set(vm.legs.map((l) => l.matchLabel))];
  return {
    brand: "BULL STAKE",
    subtitle: `THE DAILY SWEEP · CARD #${vm.contestId} · ${utcDateLabel(opts.nowMs)}`,
    matchLine: matches.length === 1 ? matches[0] : `${matches.length} matches · ${rows.length} legs`,
    tone,
    toneLine: TONE_LINE[tone](mult),
    rows,
    multiplierLabel: mult,
    moneyLine: `POT ${vm.potText} · JACKPOT ${vm.jackpotText} & ROLLING`,
    footer: "settles itself on-chain · TxLINE proofs",
    mascotColor: mascotColorFor(opts.wallet),
    fileName: `bull-stake-card-${vm.contestId}.png`,
  };
}

export type SharePath = "share" | "clipboard" | "download";
export function pickSharePath(caps: { canShareFiles: boolean; hasClipboardItem: boolean }): SharePath {
  if (caps.canShareFiles) return "share";
  if (caps.hasClipboardItem) return "clipboard";
  return "download";
}
```

- [ ] **Step 4: Run — expect PASS** — `cd web && npm test` (all files green).

- [ ] **Step 5: Commit** — `git add web/src/lib/pearlyTicket.ts web/test/pearlyTicket.test.ts && git commit -m "feat(web): pearlyTicket — pure share-ticket model + share-path chooser"`

---

### Task 3: Mascot path/color exports for canvas

**Files:**
- Modify: `web/src/components/Mascot.tsx`

- [ ] **Step 1: Export the silhouette path + colors.** Change `const MASCOT_COLORS = {` to `export const MASCOT_COLORS = {`, and above the `Mascot` component add:

```ts
/** Silhouette path (48×48 viewBox) — shared with the canvas ticket renderer
 *  (Path2D). Swap for PNG art in both places when the real files land. */
export const MASCOT_PATH =
  "M13 46 C9 42 10 33 11 29 C11 22 13 16 19 14 C18 10 20 8 23 9 C25 10 25 13 24 16 C31 15 38 18 41 24 L45 28 C46 30 43 32 40 31 L33 31 C31 34 32 40 34 46 Z";
```

…and make the component's `<path d=...>` use `MASCOT_PATH` (replace the inline string).

- [ ] **Step 2: Typecheck + suite** — `cd web && npx tsc --noEmit && npm test` → green. (Mascot is untracked-new; no commit yet — it ships with the skin batch.)

---

### Task 4: Canvas renderer + share orchestrator

**Files:**
- Create: `web/src/lib/ticketCanvas.ts` (DOM-only; NOT unit-tested — vitest env is node; verified via Task 5 harness)

- [ ] **Step 1: Implement** — new file `web/src/lib/ticketCanvas.ts`:

```ts
/* Canvas ticket renderer + share plumbing. DOM-only (document/canvas/navigator)
 * — keep ALL decisions in pearlyTicket.ts (pure); this file just draws + routes.
 * Verified via /ticket-dev.html (vitest env is node — no canvas here). */
import { MASCOT_PATH, MASCOT_COLORS } from "../components/Mascot.tsx";
import { pickSharePath, type SharePath, type TicketModel } from "./pearlyTicket.ts";

const W = 1080, H = 1350;                       // 4:5 portrait — social-friendly
const INK = "#17130f", CREAM = "#f0e7d4", PINK = "#b0006d", BG = "#17131b";
const DISP = '"Permanent Marker", "Marker Felt", "Comic Sans MS", cursive';
const BODY = '"Patrick Hand", "Chalkboard SE", "Comic Sans MS", cursive';

async function ensureFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load(`700 80px ${DISP}`),
      document.fonts.load(`400 44px ${BODY}`),
    ]);
  } catch { /* draw with fallbacks */ }
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

  // match + tone line, dashed rules
  y += 74;
  ctx.strokeStyle = "rgba(23,19,15,.4)"; ctx.lineWidth = 4; ctx.setLineDash([14, 12]);
  ctx.beginPath(); ctx.moveTo(L, y - 46); ctx.lineTo(R, y - 46); ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `700 56px ${DISP}`; ctx.fillStyle = INK;
  ctx.fillText(model.matchLine, L, y + 8);
  ctx.font = `400 34px ${BODY}`; ctx.textAlign = "right";
  ctx.fillStyle = model.tone === "busted" ? "#a3322a" : model.tone === "perfect" ? "#1d7c44" : PINK;
  ctx.fillText(model.toneLine, R, y + 4); ctx.textAlign = "left"; ctx.fillStyle = INK;
  y += 44;
  ctx.setLineDash([14, 12]); ctx.strokeStyle = "rgba(23,19,15,.4)";
  ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(R, y); ctx.stroke(); ctx.setLineDash([]);

  // pick rows
  y += 76;
  const rowGap = Math.min(84, Math.floor(620 / Math.max(1, model.rows.length)));
  for (const row of model.rows) {
    ctx.font = `400 42px ${BODY}`; ctx.globalAlpha = row.carried ? 1 : 0.45;
    ctx.fillText(`${row.chaos ? "🃏 " : ""}${row.market}`, L, y);
    ctx.textAlign = "right"; ctx.font = `700 44px ${DISP}`;
    ctx.fillText(row.carried ? `${row.pick} ✓` : row.pick, R, y);
    ctx.textAlign = "left"; ctx.globalAlpha = 1;
    y += rowGap;
  }

  // bottom block: big multiplier + money line + footer
  const by = H - M - 150;
  ctx.setLineDash([14, 12]); ctx.strokeStyle = "rgba(23,19,15,.4)";
  ctx.beginPath(); ctx.moveTo(L, by - 84); ctx.lineTo(R, by - 84); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = `700 130px ${DISP}`; ctx.fillStyle = PINK;
  ctx.fillText(model.multiplierLabel, L, by + 26);
  ctx.textAlign = "right"; ctx.fillStyle = INK;
  ctx.font = `700 36px ${BODY}`; ctx.fillText(model.moneyLine, R, by - 14);
  ctx.globalAlpha = 0.72; ctx.font = `400 32px ${BODY}`;
  ctx.fillText(model.footer + " 🔒", R, by + 34);
  ctx.globalAlpha = 1; ctx.textAlign = "left";

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
  );
}

/** Render + route via the best available path. Returns the path used, or
 *  "cancelled" when the user dismissed the native share sheet. */
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
      await navigator.share({ files: [file], title: "Bull Stake", text: "My Sweep card 🐂" });
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
```

- [ ] **Step 2: Typecheck** — `cd web && npx tsc --noEmit` → clean.

- [ ] **Step 3: Commit** — `git add web/src/lib/ticketCanvas.ts && git commit -m "feat(web): ticketCanvas — canvas ticket renderer + share/clipboard/download routing"`

---

### Task 5: Dev harness page + browser verification

**Files:**
- Create: `web/ticket-dev.html`
- Create: `web/src/ticketDev.ts`

- [ ] **Step 1: Harness page** — `web/ticket-dev.html` (Vite dev serves it at `/ticket-dev.html`; it is NOT in the prod build graph):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ticket-dev — Bull Stake share ticket harness</title>
    <style>
      @font-face{font-family:'Permanent Marker';src:url('/fonts/permanent-marker.woff2') format('woff2');font-display:swap}
      @font-face{font-family:'Patrick Hand';src:url('/fonts/patrick-hand.woff2') format('woff2');font-display:swap}
      body{background:#17131b;color:#f0e7d4;font-family:system-ui;display:flex;flex-direction:column;align-items:center;gap:14px;padding:18px}
      img{max-width:420px;border-radius:10px}
      .row{display:flex;gap:10px}
      button{padding:10px 16px;font-weight:700;border-radius:10px;border:2px solid #f0e7d4;background:#241e2b;color:#f0e7d4;cursor:pointer}
      #status{font-size:13px;opacity:.8}
    </style>
  </head>
  <body>
    <h3>share-ticket dev harness (all four tones)</h3>
    <div class="row">
      <button data-tone="riding">riding</button><button data-tone="busted">busted</button>
      <button data-tone="perfect">perfect</button><button data-tone="rolled">rolled</button>
    </div>
    <div class="row"><button id="share">shareTicketPng() → real routing</button></div>
    <div id="status"></div>
    <div id="out"></div>
    <script type="module" src="/src/ticketDev.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Harness driver** — `web/src/ticketDev.ts`:

```ts
/* Dev-only harness for the share ticket: renders a fixture TicketModel for each
 * tone and exercises the REAL share routing. Open /ticket-dev.html on the Vite
 * dev server. Not imported by the app. */
import type { TicketModel, TicketTone } from "./lib/pearlyTicket.ts";
import { renderTicketPng, shareTicketPng } from "./lib/ticketCanvas.ts";

const TONES: Record<TicketTone, string> = {
  riding: "RIDING · ×64 IF PERFECT", busted: "BUSTED — THE POT ROLLS ON",
  perfect: "PERFECT CARD ✓ · ×64 SHARE", rolled: "NOBODY SWEPT IT — POT ROLLED",
};

function fixture(tone: TicketTone): TicketModel {
  return {
    brand: "BULL STAKE",
    subtitle: "THE DAILY SWEEP · CARD #777020637 · JUL 14 2026",
    matchLine: "France v Spain",
    tone, toneLine: TONES[tone],
    rows: [
      { market: "Match Result", pick: "France", chaos: false, carried: true },
      { market: "Total Goals O/U 2.5", pick: "Over", chaos: false, carried: true },
      { market: "Total Corners O/U 9.5", pick: "Under", chaos: false, carried: true },
      { market: "Yellow Cards O/U 3.5", pick: "Over", chaos: false, carried: true },
      { market: "1st-Half Result", pick: "Draw", chaos: false, carried: true },
      { market: "Red Card Shown", pick: "No", chaos: true, carried: true },
    ],
    multiplierLabel: "×64",
    moneyLine: "POT ◎1.9 · JACKPOT ◎0.07 & ROLLING",
    footer: "settles itself on-chain · TxLINE proofs",
    mascotColor: tone === "busted" ? "pink" : tone === "perfect" ? "green" : "tan",
    fileName: "bull-stake-card-777020637.png",
  };
}

const out = document.getElementById("out")!;
const status = document.getElementById("status")!;
let current: TicketModel = fixture("riding");

async function show(tone: TicketTone) {
  current = fixture(tone);
  const blob = await renderTicketPng(current);
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  out.replaceChildren(img);
  status.textContent = `rendered ${tone} · ${Math.round(blob.size / 1024)} KB png`;
}

document.querySelectorAll<HTMLButtonElement>("button[data-tone]").forEach((b) =>
  b.addEventListener("click", () => void show(b.dataset.tone as TicketTone)));
document.getElementById("share")!.addEventListener("click", async () => {
  try { status.textContent = `path used: ${await shareTicketPng(current)}`; }
  catch (e) { status.textContent = `share failed: ${(e as Error).message}`; }
});
void show("riding");
```

- [ ] **Step 3: Browser-verify** — start the `web` dev server (launch.json name `web`, port 5180), open `http://localhost:5180/ticket-dev.html`; confirm: ticket renders with marker fonts (not fallback serif), all four tones draw, `share` button routes (desktop Chrome → clipboard path expected) and reports the path used. Screenshot for the user.

- [ ] **Step 4: Commit** — `git add web/ticket-dev.html web/src/ticketDev.ts && git commit -m "feat(web): ticket-dev harness — renders all ticket tones + exercises real share routing"`

---

### Task 6: Wire the button into the Sweep tab

**Files:**
- Modify: `web/src/components/PearlyView.tsx` (parent handler ~line 257; `MyCardHud` props/JSX ~484–560; `SettledCard` props/JSX ~591+)
- Modify: `web/src/App.css` (one `.pl-share` block, near the other `.pl-*` rules)

- [ ] **Step 1: Parent handler** — in `PearlyView` (after `onToggleAlerts`), add:

```ts
const [sharing, setSharing] = useState(false);
async function onShare() {
  const model = buildTicketModel(effectiveVm, { nowMs, wallet: address });
  if (!model) return;
  setSharing(true);
  try {
    const how = await shareTicketPng(model);
    if (how === "clipboard") flash("Ticket copied — paste it anywhere.");
    else if (how === "download") flash("Ticket saved.");
    else if (how === "share") flash("Shared 🐂");
    // "cancelled": user closed the sheet — say nothing.
  } catch (e) {
    flash(`Share failed: ${(e as Error).message}`, true);
  } finally { setSharing(false); }
}
```

…with imports `import { buildTicketModel } from "../lib/pearlyTicket.ts";` and `import { shareTicketPng } from "../lib/ticketCanvas.ts";`. NOTE: `effectiveVm` can be null (degraded pre-first-known state) — the early `if (!model) return;` covers it, but guard the call: `const model = effectiveVm ? buildTicketModel(effectiveVm, …) : null;`.

- [ ] **Step 2: Button in `MyCardHud`** — add props `onShare: () => void; sharing: boolean` (both call sites), and render after the legs list (right before the `vm.canEdit` hint):

```tsx
<button className="pl-share" disabled={sharing} onClick={onShare} aria-busy={sharing}>
  {sharing ? "…" : "Share my card ↗"}
</button>
```

- [ ] **Step 3: Button in `SettledCard`** — same props; render after its result block (same JSX as Step 2). A perfect card is the highest-value share; the rolled state shares the "pot rolled" story.

- [ ] **Step 4: `.pl-share` style** — in `App.css` near the `.pl-hint` rule:

```css
.pl-share{
  display:block; width:100%; margin-top:10px; padding:12px 14px;
  font-family:inherit; font-weight:800; font-size:15px; cursor:pointer;
  color:var(--ink); background:#e59be0;               /* ticket pink */
  border:3px solid var(--ink); border-radius:14px; box-shadow:var(--sh);
}
.pl-share:active{ transform:translate(1px,1px); box-shadow:1px 1px 0 var(--ink); }
.pl-share:disabled{ opacity:.55; cursor:default; }
```

- [ ] **Step 5: Typecheck + full suite** — `cd web && npx tsc --noEmit && npm test` → green (target: 167+ web tests + new pearlyTicket file).

- [ ] **Step 6: Dev-server smoke** — app compiles and the Sweep tab renders its current (empty-day) state with no console errors. The HUD button itself is e2e-verified on the Jul 14 card (no card exists today — see "Verification reality").

- [ ] **Step 7: Commit** — shared dirty files (`PearlyView.tsx`, `App.css`) stay uncommitted per the discipline note; plan doc checkboxes updated instead.

---

## Self-Review

- **Spec coverage:** mascot ✓ (stamp, seed-colored), picks ✓ (rows with carried/chaos), multiplier ✓ (×N big + tone line), jackpot ✓ (moneyLine), Web Share / clipboard / download ✓ (`shareTicketPng`), web-only ✓ (no engine/keeper/program changes). Button reachable from every held-card state (HUD alive/dead + settled perfect/rolled).
- **Placeholders:** none — every step carries real code/commands.
- **Type consistency:** `TicketModel`/`TicketRow`/`TicketTone`/`SharePath` defined once in `pearlyTicket.ts`, imported by `ticketCanvas.ts`/`ticketDev.ts`; `marketId` added in Task 1 before Task 2 consumes it; `MASCOT_PATH`/`MASCOT_COLORS` exported in Task 3 before Task 4 imports them.
