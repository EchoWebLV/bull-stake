# Pearly Cross-links + Notifications v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec §1's retention layer — an in-app alert ticker + browser `Notification` API for card events (leg live / hit / died / one-from-perfect / settled / seeded), plus the two cross-link surfaces (Pearly strip inside `LiveMatchView`, "go play it ⚡" pointer inside the Pearly HUD).

**Architecture:** All event logic is PURE and lives in `web/src/lib/` (node-env vitest, repo convention): a snapshot differ derives alerts from consecutive `/api/card` polls; components only render state and call thin DOM wrappers. Tabs are conditionally mounted (App.tsx:43-44), so LiveMatchView fetches the card itself on a slow poll, and tab switches flow through callbacks passed from App.

**Tech Stack:** React 18 + Vite, vitest (node env — NO component/DOM tests), existing `.pearly-*` CSS pattern in `App.css`. Real-money framing; UI copy uses multiplier framing (banned: "weight", "2^", "mask", "active legs", "perfect_weight").

**Spec:** `docs/superpowers/specs/2026-07-03-streak-hackathon-live-pearly-design.md` §1 (lines 19-20), §54, §56. Roar layer, SSE, and service-worker Web Push are OUT (deferred).

---

### Task 1: `pearlyAlerts.ts` — snapshot + differ (pure)

**Files:**
- Create: `web/src/lib/pearlyAlerts.ts`
- Test: `web/test/pearlyAlerts.test.ts`

The differ compares two consecutive poll snapshots and emits alerts ONLY on transitions — a `null` prev (first poll / tab remount) emits nothing, so reloading never spams. Alert ids are deterministic (no timestamps) so the component can dedupe with a `Set` across remounts.

- [x] **Step 1: Write the failing tests**

```typescript
// web/test/pearlyAlerts.test.ts
import { describe, it, expect } from "vitest";
import { snapshotForAlerts, diffCardAlerts, type AlertSnapshot } from "../src/lib/pearlyAlerts.ts";
import type { PearlyCardVM, PearlyLegVM } from "../src/lib/pearlyCard.ts";

const legVM = (over: Partial<PearlyLegVM> = {}): PearlyLegVM => ({
  fixtureId: 100, matchLabel: "Brazil v Spain", marketLabel: "Match Result",
  kickoffText: "", state: "open", pickable: true, buckets: 3,
  options: [{ bucket: 0, label: "Brazil" }, { bucket: 1, label: "Draw" }, { bucket: 2, label: "Spain" }],
  myPick: 0, carried: true,
  ...over,
});

// Minimal VM stub — only the fields snapshotForAlerts reads.
const vm = (legs: PearlyLegVM[], over: Partial<PearlyCardVM> = {}): PearlyCardVM => ({
  empty: false, legacyEngine: false, contestId: 7, status: "open", legs,
  entriesOpen: true, entriesCloseText: "", nextLockText: "", weightPreviewLabel: "×64",
  myCardState: "entered-alive", myCardKnown: true, myWeightLabel: "×64",
  aliveText: "1", degraded: false, potText: "◎0.05", jackpotText: "◎0.07",
  canEdit: false,
  ...over,
} as PearlyCardVM);

const snap = (legs: PearlyLegVM[], over: Partial<PearlyCardVM> = {}): AlertSnapshot =>
  snapshotForAlerts(vm(legs, over))!;

describe("snapshotForAlerts", () => {
  it("is null for an empty/legacy card (nothing to alert on)", () => {
    expect(snapshotForAlerts(vm([], { empty: true, contestId: undefined }))).toBeNull();
  });
  it("captures contestId, status, myCardState and per-leg state for carried legs", () => {
    const s = snap([legVM(), legVM({ fixtureId: 200, carried: false })]);
    expect(s.contestId).toBe(7);
    expect(s.legs).toHaveLength(2);
    expect(s.legs[0].carried).toBe(true);
    expect(s.legs[1].carried).toBe(false);
  });
});

describe("diffCardAlerts", () => {
  it("emits nothing on the first snapshot (prev null) — no reload spam", () => {
    expect(diffCardAlerts(null, snap([legVM()]))).toEqual([]);
  });

  it("emits nothing when nothing changed", () => {
    const s = snap([legVM()]);
    expect(diffCardAlerts(s, s)).toEqual([]);
  });

  it("leg open → live ⇒ leg-live with the pick riding", () => {
    const a = diffCardAlerts(snap([legVM({ state: "open" })]), snap([legVM({ state: "live" })]));
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("leg-live");
    expect(a[0].id).toBe("7:leg-live:100:Match Result");
    expect(a[0].text).toContain("Brazil v Spain");
    expect(a[0].text).toContain("Brazil"); // the pick label rides along
  });

  it("leg live → won ⇒ leg-hit", () => {
    const a = diffCardAlerts(snap([legVM({ state: "live" })]), snap([legVM({ state: "won" })]));
    expect(a[0].kind).toBe("leg-hit");
  });

  it("carried leg live → lost ⇒ leg-died (card busted)", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "live" })]),
      snap([legVM({ state: "lost" })], { myCardState: "dead" }),
    );
    expect(a[0].kind).toBe("leg-died");
    expect(a[0].text.toLowerCase()).toContain("busted");
  });

  it("a NOT-carried leg's transitions never alert (outcome can't touch this card)", () => {
    const a = diffCardAlerts(
      snap([legVM({ carried: false, state: "live" })]),
      snap([legVM({ carried: false, state: "lost" })]),
    );
    expect(a).toEqual([]);
  });

  it("all-but-one carried leg won while alive ⇒ one-away (once — id is stable)", () => {
    const prev = snap([legVM({ state: "won" }), legVM({ fixtureId: 101, state: "live" }), legVM({ fixtureId: 102, state: "live" })]);
    const next = snap([legVM({ state: "won" }), legVM({ fixtureId: 101, state: "won" }), legVM({ fixtureId: 102, state: "live" })]);
    const a = diffCardAlerts(prev, next);
    expect(a.map((x) => x.kind)).toContain("one-away");
    expect(a.find((x) => x.kind === "one-away")!.id).toBe("7:one-away");
  });

  it("status open → rolledOver ⇒ settled alert with rollover copy", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "won" })]),
      snap([legVM({ state: "won" })], { status: "rolledOver", myCardState: "settled-rollover" }),
    );
    expect(a[0].kind).toBe("settled");
    expect(a[0].text).toContain("roll");
  });

  it("status open → settled with a surviving card ⇒ settled alert with claim copy", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "won" })]),
      snap([legVM({ state: "won" })], { status: "settled", myCardState: "settled-won" }),
    );
    expect(a[0].kind).toBe("settled");
    expect(a[0].text.toLowerCase()).toContain("claim");
  });

  it("contest change ⇒ single seeded alert carrying the jackpot, nothing else", () => {
    const a = diffCardAlerts(
      snap([legVM({ state: "won" })], { status: "rolledOver" }),
      snap([legVM({ state: "open" })], { contestId: 8 } as Partial<PearlyCardVM>),
    );
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe("seeded");
    expect(a[0].id).toBe("8:seeded");
    expect(a[0].text).toContain("◎0.07");
  });
});
```

- [x] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run test/pearlyAlerts.test.ts`
Expected: FAIL — `snapshotForAlerts is not a function` (module doesn't exist).

- [x] **Step 3: Implement `web/src/lib/pearlyAlerts.ts`**

```typescript
/**
 * Pearly notifications v1 (spec §1): derive card alerts by DIFFING two
 * consecutive /api/card poll snapshots. Pure — no DOM, no fetch, node-env
 * tested. The component owns dedupe (Set of stable ids) and rendering; the
 * browser Notification side lives in notify.ts. A null prev (first poll,
 * tab remount) emits nothing so reloads never replay history.
 */
import type { PearlyCardVM, PearlyLegState } from "./pearlyCard.ts";

export type PearlyAlertKind = "leg-live" | "leg-hit" | "leg-died" | "one-away" | "settled" | "seeded";

export interface PearlyAlert {
  /** Deterministic (no timestamp) — same event → same id, for cross-remount dedupe. */
  id: string;
  kind: PearlyAlertKind;
  text: string;
}

interface LegSnap {
  key: string;          // fixtureId:marketLabel — stable within a contest
  matchLabel: string;
  marketLabel: string;
  pickText: string;     // "" when no pick (not entered)
  state: PearlyLegState;
  carried: boolean;
}

export interface AlertSnapshot {
  contestId: number;
  status: NonNullable<PearlyCardVM["status"]>;
  myCardState: PearlyCardVM["myCardState"];
  jackpotText: string;
  legs: LegSnap[];
}

export function snapshotForAlerts(vm: PearlyCardVM): AlertSnapshot | null {
  if (vm.empty || vm.legacyEngine || vm.contestId == null || !vm.status) return null;
  return {
    contestId: vm.contestId,
    status: vm.status,
    myCardState: vm.myCardState,
    jackpotText: vm.jackpotText ?? "",
    legs: vm.legs.map((l) => ({
      key: `${l.fixtureId}:${l.marketLabel}`,
      matchLabel: l.matchLabel,
      marketLabel: l.marketLabel,
      // legOptions guarantees options[b].bucket === b, so index straight in.
      pickText: l.myPick != null ? (l.options[l.myPick]?.label ?? "") : "",
      state: l.state,
      carried: l.carried === true,
    })),
  };
}

const TERMINAL: ReadonlySet<NonNullable<PearlyCardVM["status"]>> = new Set(["settled", "rolledOver", "voided"]);

export function diffCardAlerts(prev: AlertSnapshot | null, next: AlertSnapshot): PearlyAlert[] {
  if (!prev) return [];
  const out: PearlyAlert[] = [];

  // New contest: one seeded alert, nothing else (leg keys all changed anyway).
  if (prev.contestId !== next.contestId) {
    out.push({
      id: `${next.contestId}:seeded`,
      kind: "seeded",
      text: `🌱 Fresh card is live — jackpot in at ${next.jackpotText || "◎0"}`,
    });
    return out;
  }

  // Per-leg transitions — carried legs only (an uncarried leg can't touch this card).
  const prevByKey = new Map(prev.legs.map((l) => [l.key, l]));
  for (const leg of next.legs) {
    const was = prevByKey.get(leg.key);
    if (!was || !leg.carried || leg.state === was.state) continue;
    const pick = leg.pickText ? ` — ${leg.marketLabel}: ${leg.pickText}` : "";
    if (leg.state === "live") {
      // Kickoffs only: a won/lost→live flap (e.g. the winningBuckets join degrading
      // mid-poll) must not re-announce a match that already kicked off long ago.
      if (was.state === "open" || was.state === "locked") {
        out.push({ id: `${next.contestId}:leg-live:${leg.key}`, kind: "leg-live", text: `⚽ ${leg.matchLabel} kicked off${pick} riding` });
      }
    } else if (leg.state === "won") {
      out.push({ id: `${next.contestId}:leg-hit:${leg.key}`, kind: "leg-hit", text: `✅ ${leg.matchLabel}${pick} HIT` });
    } else if (leg.state === "lost") {
      out.push({ id: `${next.contestId}:leg-died:${leg.key}`, kind: "leg-died", text: `💀 ${leg.matchLabel}${pick} missed · card busted` });
    }
  }

  // One away from perfect: every carried leg but one has landed, card still alive.
  const carried = next.legs.filter((l) => l.carried);
  const won = carried.filter((l) => l.state === "won").length;
  const prevCarried = prev.legs.filter((l) => l.carried);
  const prevWon = prevCarried.filter((l) => l.state === "won").length;
  if (
    next.myCardState === "entered-alive" && carried.length >= 2 &&
    won === carried.length - 1 && prevWon < won
  ) {
    out.push({ id: `${next.contestId}:one-away`, kind: "one-away", text: `🔥 One leg from a perfect card — hang on` });
  }

  // Contest settled while we watched. Branch on the card's terminal STATUS first
  // (rolledOver / voided / settled are contest-wide facts), and only then on
  // whether THIS wallet holds a claim: a dead watcher on a `settled` card must
  // never read rollover copy (perfect cards hit — the pot pays out), and a
  // voided card refunds (mirrors PearlyView's ∅ voided chip + the claim
  // surfaces' refund language) — it neither rolls nor pays.
  if (!TERMINAL.has(prev.status) && TERMINAL.has(next.status)) {
    const text = next.status === "rolledOver"
      ? `🌊 No perfect cards today — the pot rolls into tomorrow's jackpot`
      : next.status === "voided"
        ? `∅ Card voided — entries are refundable`
        : next.myCardState === "settled-won"
          ? `🏆 Perfect card! Your share is claimable`
          : `🏁 Settled — perfect cards took today's pot`;
    out.push({ id: `${next.contestId}:settled`, kind: "settled", text });
  }

  return out;
}
```

NOTE: no new VM fields — the differ names the wallet's pick by reading the EXISTING `PearlyLegVM.options` (`options[myPick]?.label`; `legOptions` in `pearlyCard.ts` guarantees `options[b].bucket === b`). Do not add a parallel `bucketNames` array: one representation only.

- [x] **Step 4: Run to verify pass, then the full web suite**

Run: `cd web && npx vitest run`
Expected: all pass (138 existing + new).

- [x] **Step 5: Commit**

```bash
git add web/src/lib/pearlyAlerts.ts web/src/lib/pearlyCard.ts web/test/pearlyAlerts.test.ts
git commit -m "feat(web): pearlyAlerts — pure poll-diff alert derivation (leg live/hit/died, one-away, settled, seeded)"
```

---

### Task 2: `notify.ts` — thin browser Notification wrapper

**Files:**
- Create: `web/src/lib/notify.ts`

DOM-API wrapper only — deliberately no unit tests (node-env vitest can't see `Notification`/`document`; ALL decision logic stayed in Task 1).

- [x] **Step 1: Implement**

```typescript
/**
 * Browser Notification shim for Pearly alerts (spec §1: works while the PWA
 * is open; service-worker Web Push is deferred). Fire-and-forget: native
 * notifications only when the tab is HIDDEN — the in-app ticker covers the
 * visible case. All decision logic lives in pearlyAlerts.ts (tested); this
 * file is a thin, untested DOM adapter by design.
 */
import type { PearlyAlert } from "./pearlyAlerts.ts";

export const notificationsSupported = (): boolean =>
  typeof window !== "undefined" && "Notification" in window;

export const notificationsEnabled = (): boolean =>
  notificationsSupported() && Notification.permission === "granted";

/** Ask once, from a user gesture (the 🔔 button). Resolves to the new state. */
export async function requestNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

/** Fire native notifications for fresh alerts — hidden tab only. */
export function pushNotifications(alerts: PearlyAlert[]): void {
  if (!notificationsEnabled() || document.visibilityState !== "hidden") return;
  for (const a of alerts) {
    try { new Notification("Streak · Daily Pearly", { body: a.text, tag: a.id }); } catch { /* best-effort */ }
  }
}
```

- [x] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: clean.

- [x] **Step 3: Commit**

```bash
git add web/src/lib/notify.ts
git commit -m "feat(web): notify — browser Notification adapter for pearly alerts (hidden-tab only)"
```

---

### Task 3: Alert state + ticker in PearlyView

**Files:**
- Modify: `web/src/components/PearlyView.tsx` (state near line 54-77; effect after the sticky-myCard effect ~line 149; ticker + 🔔 inside `MyCardHud` ~line 363)
- Modify: `web/src/App.css` (append `.pearly-ticker` styles after the existing `.pearly-strip` block)

- [x] **Step 1: Wire alert state into the component**

In `PearlyView()` add state + refs next to the existing sticky-myCard state:

```tsx
const [alerts, setAlerts] = useState<PearlyAlert[]>([]);          // newest first, capped
const [alertsOn, setAlertsOn] = useState<boolean>(notificationsEnabled());
const prevSnapRef = useRef<AlertSnapshot | null>(null);
const seenAlertIdsRef = useRef<Set<string>>(new Set());
```

(imports: `useRef` from react; `snapshotForAlerts, diffCardAlerts, type AlertSnapshot, type PearlyAlert` from `../lib/pearlyAlerts.ts`; `notificationsSupported, notificationsEnabled, requestNotifications, pushNotifications` from `../lib/notify.ts`.)

After the `effectiveVm` derivation (line ~175), derive + commit alerts in an effect keyed on a stable serialization — effects must not fire on unrelated renders:

```tsx
const alertSnap = snapshotForAlerts(effectiveVm);
const alertSnapKey = JSON.stringify(alertSnap);
useEffect(() => {
  if (!alertSnap) return;
  const fresh = diffCardAlerts(prevSnapRef.current, alertSnap)
    .filter((a) => !seenAlertIdsRef.current.has(a.id));
  prevSnapRef.current = alertSnap;
  if (!fresh.length) return;
  for (const a of fresh) seenAlertIdsRef.current.add(a.id);
  setAlerts((cur) => [...fresh, ...cur].slice(0, 12));
  pushNotifications(fresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [alertSnapKey]);
```

CAREFUL: `effectiveVm` is only defined after the early returns (loading/empty) — place the snapshot + effect ABOVE those returns is impossible (needs effectiveVm), so instead hoist: compute `alertSnap` from `vm.myCardKnown ? vm : (haveKnownMyCard ? mapPearlyCard(card!, lastKnownMyCard, nowMs, winningBuckets) : null)` BEFORE the early returns, i.e. right after the sticky-commit effect (~line 149), so hooks order is stable across renders. `snapshotForAlerts` returns null for empty/legacy — safe on every render.

- [x] **Step 2: onToggleAlerts handler + pass-through to the HUD**

```tsx
async function onToggleAlerts() {
  const ok = await requestNotifications();
  setAlertsOn(ok);
  if (!ok && notificationsSupported()) flash("Notifications are blocked for this site in your browser settings.", true);
}
```

Pass to the HUD render (line ~224): `<MyCardHud card={card!} vm={effectiveVm} msg={msg} msgErr={msgErr} alerts={alerts} alertsOn={alertsOn} onToggleAlerts={onToggleAlerts} />`.

- [x] **Step 3: Render the ticker + 🔔 in MyCardHud**

Extend the signature: `function MyCardHud({ card, vm, msg, msgErr, alerts, alertsOn, onToggleAlerts }: { ...; alerts: PearlyAlert[]; alertsOn: boolean; onToggleAlerts: () => void })`.

Insert between the `pl-gpills` row and the death card:

```tsx
<div className="pearly-ticker">
  <div className="pt-head">
    <span className="pt-title">card alerts</span>
    {notificationsSupported() && (
      <button className="pt-bell" onClick={onToggleAlerts} aria-pressed={alertsOn}>
        {alertsOn ? "🔔 on" : "🔕 off"}
      </button>
    )}
  </div>
  {alerts.length === 0
    ? <div className="pt-row pt-empty">quiet for now — alerts land here as your legs go live</div>
    : alerts.map((a) => <div key={a.id} className={`pt-row pt-${a.kind}`}>{a.text}</div>)}
</div>
```

- [x] **Step 4: CSS (App.css, after the `.pearly-strip` rules)**

```css
/* Pearly alert ticker (spec §1 notifications v1) */
.pearly-ticker { margin: 10px 0; border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; background: var(--bg2); }
.pt-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.pt-title { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--txt3); }
.pt-bell { font-size: 11px; background: none; border: 1px solid var(--line); border-radius: 8px; padding: 2px 8px; color: var(--txt2); cursor: pointer; }
.pt-row { font-size: 12.5px; padding: 3px 0; border-top: 1px dashed var(--line); }
.pt-row:first-of-type { border-top: 0; }
.pt-empty { color: var(--txt3); font-style: italic; }
```

(Use the file's existing CSS variable names — check the `.pearly-strip` block and reuse whatever `--line/--txt3/--bg2` equivalents it actually uses.)

- [x] **Step 5: Verify**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: clean + all pass. Then browser-check the HUD (needs an entered card — after 08:00 UTC compose): ticker renders, 🔔 requests permission.

- [x] **Step 6: Commit**

```bash
git add web/src/components/PearlyView.tsx web/src/App.css
git commit -m "feat(web): pearly HUD alert ticker + browser notifications toggle"
```

---

### Task 4: Pearly → Live pointer ("match window live — go play it ⚡")

**Files:**
- Modify: `web/src/App.tsx:44` (pass the callback)
- Modify: `web/src/components/PearlyView.tsx` (accept prop; render pointer in `MyCardHud`)

- [x] **Step 1: Thread the callback**

App.tsx: `{tab === "sweepstake" && <PearlyView onGoLive={() => setTab("live")} />}`

PearlyView: `export function PearlyView({ onGoLive }: { onGoLive?: () => void } = {})`, pass down to `MyCardHud` as `onGoLive`.

- [x] **Step 2: Render the pointer**

In `MyCardHud`, directly under the entries-close `.pearly-strip` block:

```tsx
{!dead && onGoLive && vm.legs.some((l) => l.carried !== false && l.state === "live") && (
  <button className="pearly-strip pearly-golive" onClick={onGoLive}>
    ⚡ match window live — go play it
  </button>
)}
```

CSS (App.css, same block as Task 3):

```css
.pearly-golive { width: 100%; cursor: pointer; text-align: center; font-weight: 600; }
```

- [x] **Step 3: Verify + commit**

Run: `cd web && npx tsc --noEmit && npx vitest run` — clean/green. Browser: with a live carried leg the strip shows and switches tabs.

```bash
git add web/src/App.tsx web/src/components/PearlyView.tsx web/src/App.css
git commit -m "feat(web): pearly → live cross-link pointer during live match windows"
```

---

### Task 5: Live → Pearly strip ("your card rides this match")

**Files:**
- Create: `web/src/lib/pearlyStrip.ts`
- Test: `web/test/pearlyStrip.test.ts`
- Modify: `web/src/components/LiveMatchView.tsx` (fetch + strip render)
- Modify: `web/src/App.tsx:43` (pass `onGoPearly`)

- [x] **Step 1: Write the failing tests**

```typescript
// web/test/pearlyStrip.test.ts
import { describe, it, expect } from "vitest";
import { stripForFixture } from "../src/lib/pearlyStrip.ts";
import type { Card } from "../src/lib/api.ts";

const NOW = 1_800_000_000;
const baseLeg = {
  fixtureId: 500, home: "Brazil", away: "Spain", kickoffTs: null,
  marketId: 12, label: "Match Result", group: "result", buckets: 3, lockTs: NOW - 10,
};
const card = (over: Partial<Card> = {}): Card => ({
  contestId: 9, status: "open", lockTs: NOW - 10, settleAfterTs: NOW + 9999,
  entryPrice: "50000000", pot: "0", jackpot: "0",
  legs: [baseLeg, { ...baseLeg, marketId: 11, label: "Total Goals O/U 2.5", group: "goals", line: 2.5, buckets: 2 }],
  myCard: { picks: [0, 0, 0, 0, 0, 0], entryTs: NOW - 100, activeMask: [true, true, true, true, true, true], weight: 64, alive: true },
  ...over,
});

describe("stripForFixture", () => {
  it("null when the wallet has no live card", () => {
    expect(stripForFixture(card({ myCard: null }), 500, 0)).toBeNull();
  });
  it("null when the card is dead (spectating — no ride copy)", () => {
    const c = card();
    c.myCard!.alive = false;
    expect(stripForFixture(c, 500, 0)).toBeNull();
  });
  it("null when no carried leg is on this fixture", () => {
    expect(stripForFixture(card(), 999, 0)).toBeNull();
  });
  it("names the pick for a result leg on this fixture", () => {
    const s = stripForFixture(card(), 500, 0);
    expect(s).not.toBeNull();
    expect(s!.text).toContain("your card rides this match");
    expect(s!.text).toContain("Brazil");
  });
  it("O/U leg with Over pick one goal short says 'needs one more goal'", () => {
    // picks[1] = 0 = Over on the 2.5 line; 2 goals so far → needs one more.
    const s = stripForFixture(card(), 500, 2);
    expect(s!.text).toContain("needs one more goal");
  });
  it("O/U Over already cleared says nothing extra (no stale 'needs')", () => {
    const s = stripForFixture(card(), 500, 3);
    expect(s!.text).not.toContain("needs");
  });
});
```

- [x] **Step 2: Run to verify fail**

Run: `cd web && npx vitest run test/pearlyStrip.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement `web/src/lib/pearlyStrip.ts`**

```typescript
/**
 * Live-tab cross-link (spec §1): the slim "🃏 your card rides this match"
 * strip inside LiveMatchView. Pure derivation from the raw /api/card DTO —
 * LiveMatchView doesn't build a PearlyCardVM, so this works off Card directly.
 * Returns null whenever there's nothing to say (no card, dead card, no carried
 * leg on the given fixture).
 */
import type { Card } from "./api.ts";
import { bucketLabel } from "./pearlyCard.ts";

export function stripForFixture(
  card: Card | null,
  fixtureId: number,
  liveGoalsTotal: number,
): { text: string } | null {
  if (!card || !card.myCard || !card.myCard.alive) return null;
  if (card.status !== "open") return null;
  const rides: string[] = [];
  for (let i = 0; i < card.legs.length; i++) {
    const leg = card.legs[i];
    if (leg.fixtureId !== fixtureId) continue;
    if (card.myCard.activeMask[i] !== true) continue; // this card never carried the leg
    const pick = card.myCard.picks[i];
    let part = `${leg.label}: ${bucketLabel(leg, pick)}`;
    // Spec's example copy — O/U Over still short of the line gets the dynamic nudge.
    if (leg.marketId === 11 && pick === 0 && typeof leg.line === "number") {
      const short = leg.line - liveGoalsTotal;
      if (short > 0 && short < 1) part += " — needs one more goal";
    }
    rides.push(part);
  }
  if (!rides.length) return null;
  return { text: `🃏 your card rides this match — ${rides.join(" · ")}` };
}
```

- [x] **Step 4: Run to verify pass**

Run: `cd web && npx vitest run test/pearlyStrip.test.ts` — PASS, then full suite.

- [x] **Step 5: Fetch + render in LiveMatchView**

App.tsx: `{tab === "live" && <LiveMatchView test={IS_TEST_PAGE} onGoPearly={() => setTab("sweepstake")} />}`

LiveMatchView signature: `export function LiveMatchView({ test = false, onGoPearly }: { test?: boolean; onGoPearly?: () => void } = {})`.

Inside the component (near the other hooks, ~line 34): a slow, independent card poll — the tabs are conditionally mounted so no state can be shared with PearlyView:

```tsx
const [pearlyCard, setPearlyCard] = useState<Card | null>(null);
useEffect(() => {
  if (!address) { setPearlyCard(null); return; }
  let alive = true;
  const tick = () => getCard(address).then((c) => { if (alive) setPearlyCard(c); }).catch(() => {});
  tick();
  const t = setInterval(tick, 60_000);
  return () => { alive = false; clearInterval(t); };
}, [address]);
```

(imports: `getCard, type Card` from `../lib/api.ts`; `stripForFixture` from `../lib/pearlyStrip.ts`. `address` already exists in the component — it powers `useLivePool`.)

Render the strip inside the in-play layout, directly under the scoreboard block (`lg-side away` closing div, ~line 199) — and also in the pre-game branch under the countdown (~line 260), both guarded identically:

```tsx
{(() => {
  const m = data?.match;
  const s = m ? stripForFixture(pearlyCard, m.fixtureId, (m.live?.home ?? 0) + (m.live?.away ?? 0)) : null;
  return s ? (
    <button className="pearly-strip pearly-golive lg-pearly" onClick={onGoPearly}>{s.text}</button>
  ) : null;
})()}
```

CSS: `.lg-pearly { margin-top: 8px; }` (App.css, same block).

- [x] **Step 6: Verify + commit**

Run: `cd web && npx tsc --noEmit && npx vitest run` — clean/green. Browser: on the Live tab with a card riding the shown match, the strip appears and clicking it lands on the Pearly tab.

```bash
git add web/src/lib/pearlyStrip.ts web/test/pearlyStrip.test.ts web/src/components/LiveMatchView.tsx web/src/App.tsx web/src/App.css
git commit -m "feat(web): live → pearly cross-link strip (your card rides this match)"
```

---

### Task 6: End-to-end sanity on the running stack

**Files:** none (verification only)

- [x] **Step 1: Full web gate**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; every test green.

- [x] **Step 2: Browser pass over both tabs**

With today's card live (post-08:00 UTC compose) and the dev wallet entered: Pearly HUD shows the ticker (empty state first); flip a leg live in the day's schedule → `leg-live` alert lands on the next poll; 🔔 toggle requests permission; Live tab shows the rides-strip when the featured match is on the card; both strips switch tabs.

- [x] **Step 3: Update HANDOFF.md open-tasks (#4 → done) and memory**

One-line status flip in `HANDOFF.md`; note in auto-memory that Plan C shipped.

---

## Self-review notes

- Spec coverage: §1 line 19 (six alert kinds — leg live/hit/died/one-away/settled/seeded: Task 1; ticker: Task 3; Notification API: Tasks 2-3) ✓; §1 line 20 (LiveMatchView strip: Task 5; Pearly live pointer: Task 4) ✓; §56 CSS-porting convention (Tasks 3-5 extend App.css in the pearly pattern) ✓. SSE/Web Push/roar explicitly out.
- Types: Task 1's differ reads the pick label off the EXISTING `PearlyLegVM.options[myPick]` (no `bucketNames` dual representation); `stripForFixture` (Task 5) deliberately reads the raw `Card` DTO instead, so it has no dependency on the VM's leg shape.
- Banned copy words: alert/strip texts use "card", "legs", "multiplier" framing only — no "weight"/"mask"/"active legs".

---

## Execution log (2026-07-04)

All six tasks done on `feat/streak-pivot`. Final gate: web suite **165 passing** (8 files), `npx tsc --noEmit` clean.

| Task | Commit(s) | One-liner |
|---|---|---|
| 1 | `6ef3de6`, `0f2d5a5` | `pearlyAlerts.ts` pure poll-diff differ (leg live/hit/died, one-away, settled, seeded) + review fixes: status-aware settled copy, kickoff-only leg-live, seam tests |
| 2 | `ecfb570` | `notify.ts` — thin browser Notification adapter, hidden-tab only, untested-by-design DOM shim |
| 3 | `56bdc59` | HUD alert ticker + 🔔 notifications toggle in `PearlyView` (`.pearly-ticker` CSS block) |
| 4 | `51e2d56` | Pearly → Live pointer ("match window live — go play it ⚡") threaded through App.tsx |
| 5 | `b944fc1` | Live → Pearly strip: `pearlyStrip.ts` (pure, raw-DTO) + render in `LiveMatchView` on a slow 60s card poll |
| 6 | `0939cba` | Review riders: degraded-poll guard in `stripForFixture` (degraded `alive` is optimistic — never claim a ride) + tests pinning the status / carried-mask / degraded gates; full gate + browser smoke |

Browser smoke (Task 6 Step 2, scoped): own Vite preview on :5173 against the shared devnet engine (:8787), **unauthenticated** (no wallet login in the harness) — Pearly tab renders contest 777020638's full 6-leg picker, Live tab renders the pre-game countdown (Canada v Morocco), tab switching works both ways, zero console errors/warnings; ticker and rides-strip correctly absent without an entered card. The entered-wallet ticker/strip behaviors are pinned by the unit suites instead (pearlyAlerts 16, pearlyStrip 9).

Accepted deferrals (review-noted as v1-acceptable; both are what the plan specified):
- The 🔔 bell is an **enable-only** affordance — it requests/reflects browser permission but can't switch native notifications back off (browser permission model; the in-app ticker is always on).
- The dismissed-permission-prompt path reuses the "blocked in your browser settings" flash copy, though a plain dismissal isn't technically "blocked".

Fold-forward: hoist a `carriedLegs` local in `MyCardHud` (the `l.carried !== false` filter is repeated) next time that component is touched.
