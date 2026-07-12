/* Dev-only harness for the share ticket: renders a fixture TicketModel for
 * each tone and exercises the REAL share routing. Open /ticket-dev.html on the
 * Vite dev server (port 5180). Not imported by the app; not in the prod build
 * graph (vite only bundles index.html's imports). */
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
