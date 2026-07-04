import { useEffect, useRef, useState } from "react";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildEnterTx, buildClaimContestTx } from "../lib/anchorClient.ts";
import {
  getCard, getContestLive, getContestEntries,
  type Card, type ContestEntry,
} from "../lib/api.ts";
import { SOL, fmtSol } from "../lib/odds.ts";
import {
  mapPearlyCard, walletHoldsCard, type PearlyCardVM, type PearlyLegVM, type PearlyLegState,
} from "../lib/pearlyCard.ts";
import { snapshotForAlerts, diffCardAlerts, type AlertSnapshot, type PearlyAlert } from "../lib/pearlyAlerts.ts";
import { notificationsSupported, notificationsEnabled, requestNotifications, pushNotifications } from "../lib/notify.ts";

/* ──────────────────────────────────────────────────────────────────────────
 * Streak — 🃏 The Daily Pearly (spec: docs/superpowers/specs/
 * 2026-07-03-streak-hackathon-live-pearly-design.md §1/§3/§7; blueprint:
 * mockups/17-pearly.html). The all-day 6-leg card: enter ◎0.05 any time while
 * ≥3 legs are still open; your card = the legs open at entry; weight =
 * 2^(legs carried). ONE card per wallet (nonce 0, always) — no buy-backs; once
 * a carried leg kicks off the chain rejects edits with CardLocked.
 *
 * All rendering logic lives in lib/pearlyCard.ts's pure `mapPearlyCard` — this
 * component is thin: fetch, map, render the VM, wire the two on-chain calls
 * (enter / claimContest) it already reuses verbatim from anchorClient.ts (the
 * same builders SweepstakeView.tsx uses for the hidden single-match Parlay).
 * ──────────────────────────────────────────────────────────────────────── */

const POLL_MS = 5000;
// Faster cadence used only right after an enter tx confirms, while waiting for
// the engine's ~4s success-only alive-tracking cache to pick up the new entry.
const CONFIRM_POLL_MS = 1500;
const PEARLY_NONCE = 0; // spec §1: web/engine always use nonce 0 — one card per wallet, ever.

/** Per-leg status chip: ⏳ open / 🔒 locked-in-play / ✓ hit / ✗ dead — from the
 *  mapper's derived PearlyLegState, never recomputed here. */
function legChip(state: PearlyLegState): { icon: string; label: string; tone: string } {
  switch (state) {
    case "open": return { icon: "⏳", label: "open", tone: "neutral" };
    case "locked": return { icon: "🔒", label: "locked", tone: "neutral" };
    case "live": return { icon: "🔒", label: "locked · in play", tone: "warn" };
    case "won": return { icon: "✓", label: "hit", tone: "good" };
    case "lost": return { icon: "✗", label: "dead", tone: "bad" };
    case "voided": return { icon: "∅", label: "voided", tone: "neutral" };
  }
}

export function PearlyView() {
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin();
  const { address, signAndSend } = usePrivySigner();

  const [card, setCard] = useState<Card | null | undefined>(undefined); // undefined = loading
  const [winningBuckets, setWinningBuckets] = useState<(number | null)[]>([]);
  const [entry, setEntry] = useState<ContestEntry>(); // nonce-0 entry (claimable/payout live here)
  const [picks, setPicks] = useState<Record<number, number>>({}); // picker draft: legIndex → bucket
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [msgErr, setMsgErr] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());
  // True right after an enter tx confirms, until myCard actually reflects it.
  // The engine's alive-tracking scan is cached success-only for ~4s (engine
  // commit 3246a98) — an immediate post-enter poll can still read the OLD
  // (pre-entry) scan, which would otherwise flash the picker again for a few
  // seconds right after a successful entry.
  const [confirmingEntry, setConfirmingEntry] = useState(false);
  // Sticky my-card snapshot: engine commit 3246a98's `myCard` is three-state —
  // when a poll comes back UNKNOWN (vm.myCardKnown false — a degraded scan, or
  // right after switching wallets before the first fetch resolves), we must
  // NOT collapse to "not-entered" (that would show a false empty/picker state,
  // AND strip the "your pick"/carried annotations from every leg row, for an
  // actually-entered player mid-blip). Hold the RAW last-confirmed myCard value
  // (not just its derived state string) so re-mapping with it reproduces the
  // full HUD — legs included — consistently, not just the top-level pills.
  // `haveKnownMyCard` is tracked SEPARATELY from the value itself: `null` is
  // itself a legitimate confirmed value ("confirmed no entry"), so "have we
  // EVER seen a known poll" can't be inferred from `lastKnownMyCard === null`.
  const [lastKnownMyCard, setLastKnownMyCard] = useState<Card["myCard"]>(null);
  const [haveKnownMyCard, setHaveKnownMyCard] = useState(false);
  // Alert ticker (spec §1 notifications v1): newest-first, capped. The diff
  // bookkeeping lives in refs, not state — prev snapshot + seen-ids drive no
  // rendering of their own, and the seen-set keeps StrictMode double-invokes
  // and effect re-runs from ever re-announcing the same event.
  const [alerts, setAlerts] = useState<PearlyAlert[]>([]);
  const [alertsOn, setAlertsOn] = useState<boolean>(notificationsEnabled());
  const prevSnapRef = useRef<AlertSnapshot | null>(null);
  const seenAlertIdsRef = useRef<Set<string>>(new Set());

  function flash(t: string, err = false) { setMsg(t); setMsgErr(err); }

  async function refresh() {
    const c = await getCard(address ?? undefined).catch(() => undefined);
    if (c === undefined) return; // transient fetch failure — keep the last good state on screen
    setCard(c);
    if (!c) { setWinningBuckets([]); setEntry(undefined); return; }

    // Per-leg winning buckets: /api/card's own leg DTOs don't carry one (see
    // pearlyCard.ts's mapPearlyCard doc comment) — join against
    // /api/contest/live by contestId, same as SweepstakeView.tsx. Best-effort:
    // a hiccup here just means legs read "live" instead of hit/dead until the
    // next poll, never a crash.
    try {
      const lives = await getContestLive();
      const live = lives.find((l) => l.contestId === c.contestId);
      setWinningBuckets(live ? live.legs.map((l) => l.winningBucket) : []);
    } catch { setWinningBuckets([]); }

    if (address) {
      try {
        const es = await getContestEntries(address, c.contestId);
        setEntry(es.find((e) => e.nonce === PEARLY_NONCE));
      } catch { setEntry(undefined); }
    } else {
      setEntry(undefined);
    }
  }

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!alive) return;
      await refresh();
      if (!alive) return;
      // Right after entering, the engine's ~4s success-only alive-tracking cache
      // can still be serving the pre-entry scan — poll faster (CONFIRM_POLL_MS)
      // until myCard actually reflects the new entry (cleared in the effect
      // below), instead of sitting on the slower steady-state cadence.
      timer = setTimeout(tick, confirmingEntry ? CONFIRM_POLL_MS : POLL_MS);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, confirmingEntry]);
  useEffect(() => { const t = setInterval(() => setNowMs(Date.now()), 15_000); return () => clearInterval(t); }, []);

  const vm = mapPearlyCard(card ?? null, card?.myCard, nowMs, winningBuckets);

  // Clear "confirming" once a KNOWN poll actually shows an entry (any state
  // other than not-entered) — an unknown/degraded poll must NOT clear it
  // (that would prematurely flip back to showing the picker mid-confirmation).
  useEffect(() => {
    if (confirmingEntry && vm.myCardKnown && vm.myCardState !== "not-entered") setConfirmingEntry(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmingEntry, vm.myCardKnown, vm.myCardState]);

  // Commit the sticky my-card snapshot as a side effect (not during render —
  // React forbids setState-in-render outside the "derive initial state" idiom)
  // whenever a poll actually confirms one. This is what makes an UNKNOWN poll
  // (vm.myCardKnown false) fall back to the last confirmed state below rather
  // than flashing "not entered".
  useEffect(() => {
    if (vm.myCardKnown) {
      setLastKnownMyCard(card?.myCard ?? null);
      setHaveKnownMyCard(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.myCardKnown, card?.myCard]);

  // Alert snapshot: same trust rules as effectiveVm below (a known poll wins,
  // else re-map with the sticky last-confirmed myCard) but computed BEFORE the
  // early returns so the hooks order stays render-stable. snapshotForAlerts is
  // null on empty/legacy cards, and diffCardAlerts emits nothing on a null
  // prev, so reloads/remounts never replay history.
  const alertVm = card
    ? (vm.myCardKnown ? vm : (haveKnownMyCard ? mapPearlyCard(card, lastKnownMyCard, nowMs, winningBuckets) : null))
    : null;
  const alertSnap = alertVm ? snapshotForAlerts(alertVm) : null;
  const alertSnapKey = JSON.stringify(alertSnap);
  useEffect(() => {
    if (!alertSnap) return;
    const fresh = diffCardAlerts(prevSnapRef.current, alertSnap)
      .filter((a) => !seenAlertIdsRef.current.has(a.id));
    prevSnapRef.current = alertSnap;
    if (!fresh.length) return;
    for (const a of fresh) seenAlertIdsRef.current.add(a.id);
    setAlerts((cur) => [...fresh, ...cur].slice(0, 12));
    pushNotifications(fresh); // internally gated: permission granted AND tab hidden
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertSnapKey]);

  if (card === undefined || !ready) return <div className="card empty-card">Loading today's Pearly…</div>;

  // ── Empty: no card composed today ─────────────────────────────────────────
  if (vm.empty) {
    return (
      <div className="card empty-card">
        <div style={{ fontSize: 28, marginBottom: 8 }}>🃏</div>
        No Pearly card today yet — the next card composes at 08:00 UTC. Check back soon.
      </div>
    );
  }

  // Effective VM for rendering: trust this poll when its myCard is known;
  // otherwise RE-MAP the current card with the sticky last-confirmed myCard
  // value swapped in, so legs/picks/carried/weight all stay internally
  // consistent (not just the top-level pills) — mapPearlyCard is pure, so
  // calling it twice with different myCard inputs is cheap and safe. If we've
  // never seen a known poll for this wallet at all, there's genuinely nothing
  // to show yet — a loading affordance is correct.
  if (!vm.myCardKnown && !haveKnownMyCard) {
    return <div className="card empty-card">Checking your card…</div>;
  }
  const effectiveVm: PearlyCardVM = vm.myCardKnown
    ? vm
    : mapPearlyCard(card!, lastKnownMyCard, nowMs, winningBuckets);

  async function onPick(legIdx: number, bucket: number) {
    setPicks((p) => ({ ...p, [legIdx]: bucket }));
  }

  async function onEnter() {
    if (!address) { login(); return; }
    if (!card) return;
    // Belt-and-suspenders vs. a myCard scan blip: a wallet that provably holds
    // a ticket (chain entry, or any confirmed poll) must never send enter —
    // that's the on-chain EDIT branch, which reverts CardLocked (6052) once a
    // carried leg has kicked off.
    if (walletHoldsCard(entry, lastKnownMyCard)) {
      flash("You already hold a card on this contest — hang tight while it syncs.", true);
      return;
    }
    setBusy(true); setMsg(undefined);
    try {
      // Every leg needs a pick — locked/already-past legs are outside this
      // entry's mask anyway (the chain only scores ACTIVE legs), so default
      // them to bucket 0 per the build task's instruction.
      const ordered = card.legs.map((_l, i) => picks[i] ?? 0);
      const tx = await buildEnterTx(address, card.contestId, PEARLY_NONCE, ordered);
      const sig = await signAndSend(tx);
      flash(`Card locked in on-chain · ${sig.slice(0, 8)}…`);
      setPicks({});
      setConfirmingEntry(true); // switches the poll loop to the faster cadence until myCard flips
      await refresh();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  async function onClaim() {
    if (!address || !card) return;
    setBusy(true); setMsg(undefined);
    try {
      const tx = await buildClaimContestTx(address, card.contestId, PEARLY_NONCE);
      const sig = await signAndSend(tx);
      flash(`Claimed · ${sig.slice(0, 8)}…`);
      await refresh();
    } catch (e) { flash((e as Error).message, true); }
    finally { setBusy(false); }
  }

  // 🔔 toggle: requestNotifications resolves immediately (no prompt) when the
  // permission is already granted/denied, so the await stays gesture-safe.
  async function onToggleAlerts() {
    const ok = await requestNotifications();
    setAlertsOn(ok);
    if (!ok && notificationsSupported()) flash("Notifications are blocked for this site in your browser settings.", true);
  }

  // ── Settled: perfect (claim) or rollover ────────────────────────────────
  if (effectiveVm.status === "settled" || effectiveVm.status === "rolledOver" || effectiveVm.status === "voided") {
    return (
      <SettledCard
        card={card!} vm={effectiveVm} entry={entry} busy={busy} onClaim={onClaim}
        msg={msg} msgErr={msgErr}
      />
    );
  }

  // ── Entered: my-card HUD (alive or dead-spectating) ─────────────────────
  if (effectiveVm.myCardState === "entered-alive" || effectiveVm.myCardState === "dead") {
    return (
      <MyCardHud
        card={card!} vm={effectiveVm} msg={msg} msgErr={msgErr}
        alerts={alerts} alertsOn={alertsOn} onToggleAlerts={onToggleAlerts}
      />
    );
  }

  // ── Entered per the chain (or just entered), engine hasn't caught up ─────
  // Takes priority over the picker fallback below. Two ways in: a just-placed
  // entry (engine's ~4s alive-scan cache still serves the pre-entry scan), or
  // the chain-entry cross-check — the nonce-0 entry fetch says this wallet
  // holds a ticket even though the myCard poll came back confirmed-empty (the
  // blip behind the 07-03 CardLocked incident). Either way the picker must not
  // render for a wallet that provably holds a card.
  if ((confirmingEntry || walletHoldsCard(entry, lastKnownMyCard)) && effectiveVm.myCardState === "not-entered") {
    return (
      <div className="card empty-card">
        {confirmingEntry ? "Confirming your card on-chain…" : "You hold a card on this contest — syncing it…"}
        {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      </div>
    );
  }

  // ── Not entered, entries open: the picker ───────────────────────────────
  return (
    <PickerCard
      card={card!} vm={effectiveVm} picks={picks} address={address} authenticated={authenticated}
      busy={busy} onPick={onPick} onEnter={onEnter} onLogin={login}
      msg={msg} msgErr={msgErr}
    />
  );
}

// ── Picker (no entry yet, entries still open — mockup 17 #picker) ──────────

function PickerCard({
  card, vm, picks, address, authenticated, busy, onPick, onEnter, onLogin, msg, msgErr,
}: {
  card: Card; vm: PearlyCardVM; picks: Record<number, number>;
  address: string | undefined; authenticated: boolean; busy: boolean;
  onPick: (legIdx: number, bucket: number) => void; onEnter: () => void; onLogin: () => void;
  msg: string | undefined; msgErr: boolean;
}) {
  // Index-aligned with card.legs / vm.legs throughout (the mapper preserves
  // 1:1 order — see mapPearlyCard's doc comment) — track "made" only against
  // PICKABLE indices, since a locked leg is disabled and can never receive a
  // pick, so it must never count toward (or block) the "all picked" gate.
  const pickableIdx = vm.legs.reduce<number[]>((acc, l, i) => (l.pickable ? [...acc, i] : acc), []);
  const made = pickableIdx.filter((i) => picks[i] != null).length;
  const priceSol = fmtSol(card.entryPrice);
  const entriesClosed = !vm.entriesOpen;

  return (
    <div className="pearly">
      <div className="pearly-lobby">
        <div className="pl-tag">The Daily Pearly</div>
        <div className="pl-h">Every match.<br />One perfect card.</div>
        <div className="pl-sub">Pick all six legs. Perfect cards split the pot — <b className="pl-gold">bigger multiplier, bigger share</b>.</div>
        <div className="pl-weightrow">
          <span className="pl-schip pl-now">enter now · {pickableIdx.length} legs · <b>{vm.weightPreviewLabel}</b></span>
          <span className="pl-schip">🚫 <b>no buy-backs</b> · one card a day</span>
        </div>
        <div className="pl-explainer">Every leg still open doubles your prize. Join early, carry more legs, win bigger.</div>
        <div className="pl-fine">
          entries open all day (min 3 open legs) — each leg locks at its own kickoff<br />
          <b className="pl-acc">perfect or nothing:</b> no perfect card → the whole pot rolls to tomorrow<br />
          🏆 pot {vm.potText}{vm.potRolledText ? ` · ${vm.potRolledText}` : ""} · {vm.aliveText} cards in
        </div>
      </div>

      {entriesClosed && (
        <div className="pearly-closed-note">Entries have closed for today's card — fewer than 3 legs remain open.</div>
      )}

      {vm.legs.map((leg, i) => (
        <PickerLegRow
          key={`${leg.fixtureId}-${i}`}
          leg={leg} legIdx={i} pick={picks[i]}
          onPick={(bucket) => onPick(i, bucket)}
        />
      ))}

      <div className="pearly-enterbar">
        <button
          className="cta"
          disabled={busy || entriesClosed || (!!address && (made < pickableIdx.length || pickableIdx.length === 0))}
          aria-busy={busy}
          onClick={onEnter}
        >
          {busy ? "…"
            : !address ? "Log in to play"
            : entriesClosed ? "Entries closed"
            : made < pickableIdx.length ? `Pick all ${pickableIdx.length} legs to enter (${made}/${pickableIdx.length})`
            : `Enter the Pearly · ${priceSol} ${SOL} · full card ${vm.weightPreviewLabel}`}
        </button>
      </div>
      {!authenticated && !address && (
        <div className="pl-hint">Log in with a devnet wallet to play — real ◎SOL, no demo mode.</div>
      )}
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      <div className="card-foot"><span className="dia">◆</span> Settled on-chain · TxLINE proofs</div>
    </div>
  );
}

function PickerLegRow({
  leg, legIdx, pick, onPick,
}: { leg: PearlyLegVM; legIdx: number; pick: number | undefined; onPick: (bucket: number) => void }) {
  const chip = legChip(leg.state);
  return (
    <div className={`pleg${leg.pickable ? "" : " pleg-locked"}`}>
      <div className="pleg-h1">
        <span className="pleg-m">{leg.matchLabel}</span>
        <span className="pleg-ko">{leg.kickoffText ? `KO ${leg.kickoffText}` : ""}</span>
        <span className={`pleg-st tone-${chip.tone}`}>leg {legIdx + 1}{leg.pickable ? "" : " · already kicked off — not on your card"}</span>
      </div>
      <div className="pleg-q">{leg.marketLabel}</div>
      <div className="pleg-opts">
        {leg.options.map((o) => (
          <button
            key={o.bucket}
            className={`plopt${pick === o.bucket ? " sel" : ""}`}
            disabled={!leg.pickable}
            aria-pressed={pick === o.bucket}
            onClick={() => onPick(o.bucket)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── My-card HUD (entered — alive or dead-spectating; mockup 17 #hud) ───────

function MyCardHud({ card, vm, msg, msgErr, alerts, alertsOn, onToggleAlerts }: {
  card: Card; vm: PearlyCardVM; msg: string | undefined; msgErr: boolean;
  alerts: PearlyAlert[]; alertsOn: boolean; onToggleAlerts: () => void;
}) {
  const dead = vm.myCardState === "dead";
  return (
    <div className="pearly">
      {vm.degraded && (
        <div className="pearly-provisional">⏳ reconnecting to the chain — alive/dead status below is provisional</div>
      )}
      <div className="pl-gpills">
        <div className="pl-pill pl-alive"><div className="pl-v">{vm.aliveText}</div><div className="pl-k">cards still perfect</div></div>
        <div className="pl-pill pl-pot"><div className="pl-v">{vm.potText}</div><div className="pl-k">the pot</div></div>
        <div className="pl-pill pl-wt"><div className="pl-v">{vm.myWeightLabel}</div><div className="pl-k">your multiplier</div></div>
      </div>

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

      {dead && (
        <div className="pearly-death">
          <div className="pd-h">{vm.degraded ? "⚠️ Checking your card…" : "Card busted"}</div>
          <div className="pd-sub">
            {vm.degraded
              ? "We're re-syncing with the chain — this will confirm on the next poll."
              : "The pot rolls on. New card tomorrow 08:00 UTC."}
          </div>
          <div className="pd-note">🔔 your alerts stay on · no buy-backs · spectating the field</div>
        </div>
      )}

      {!dead && vm.entriesCloseText && (
        <div className="pearly-strip">
          <span>entries close in {vm.entriesCloseText}</span>
          {vm.nextLockText && <span>· next leg locks in {vm.nextLockText}</span>}
        </div>
      )}

      <div className="section">
        <h3>Your card: {vm.legs.filter((l) => l.carried !== false).length} legs · {vm.myWeightLabel}</h3>
        <span className="tag">{dead ? "spectating" : "riding"}</span>
      </div>
      {vm.legs.map((leg, i) => (
        <MyCardLegRow key={`${leg.fixtureId}-${i}`} leg={leg} />
      ))}

      {vm.canEdit && (
        <div className="pl-hint">You can still edit your card — no carried leg has kicked off yet.</div>
      )}
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      <div className="card-foot"><span className="dia">◆</span> Settled on-chain · TxLINE proofs</div>
    </div>
  );
}

function MyCardLegRow({ leg }: { leg: PearlyLegVM }) {
  const chip = legChip(leg.state);
  const outOfCard = leg.carried === false;
  return (
    <div className={`pleg pleg-mine tone-${chip.tone}${outOfCard ? " pleg-notcarried" : ""}`}>
      <div className="pleg-h1">
        <span className="pleg-m">{leg.matchLabel}</span>
        {leg.liveScoreText && <span className="pleg-score tnum">{leg.liveScoreText} <span className="pleg-min">{leg.livePhaseText}</span></span>}
        <span className={`pleg-chip tone-${chip.tone}`}>{chip.icon} {outOfCard ? "not in card" : chip.label}</span>
      </div>
      <div className="pleg-q">{leg.marketLabel}</div>
      {leg.myPick != null && (
        <div className="pleg-mypick">your pick: <b>{bucketLabelSafe(leg, leg.myPick)}</b></div>
      )}
    </div>
  );
}

/** The VM's own `options[].label` is already the mapper's `bucketLabel(...)`
 *  output (see pearlyCard.ts's `legOptions`) — read it back here instead of
 *  re-deriving from the raw CardLeg shape a second time. */
function bucketLabelSafe(leg: PearlyLegVM, bucket: number): string {
  return leg.options.find((o) => o.bucket === bucket)?.label ?? "—";
}

// ── Settled: perfect (claim) or rollover (mockup 17 #over) ─────────────────

function SettledCard({
  card, vm, entry, busy, onClaim, msg, msgErr,
}: {
  card: Card; vm: PearlyCardVM; entry: ContestEntry | undefined; busy: boolean;
  onClaim: () => void; msg: string | undefined; msgErr: boolean;
}) {
  const perfect = vm.myCardState === "settled-won";
  const rolledOver = card.status === "rolledOver";

  if (vm.myCardState === "not-entered") {
    return (
      <div className="pearly">
        <div className="pearly-rollover">
          <div className="pearly-roll-h">{rolledOver ? "🌙 Nobody survived" : "Settled"}</div>
          <div className="pearly-roll-sub">
            {rolledOver
              ? `The whole pot (${vm.potText}) rolls into tomorrow's jackpot.`
              : "Today's Pearly has settled. You sat this one out."}
          </div>
        </div>
        <div className="pl-hint">Next card composes at 08:00 UTC.</div>
      </div>
    );
  }

  return (
    <div className="pearly">
      {perfect ? (
        <div className="pearly-win">
          <div className="pw-trophy">🏆</div>
          <div className="pw-h">PERFECT CARD 🃏</div>
          {entry && (
            <div className="pw-amt tnum">{fmtSol(entry.payout)}{SOL}</div>
          )}
          <div className="pw-sub">you take {vm.myWeightLabel} of the pot</div>
        </div>
      ) : (
        <div className="pearly-rollover">
          <div className="pearly-roll-h">Card busted</div>
          <div className="pearly-roll-sub">The pot rolls on. New card tomorrow 08:00 UTC.</div>
        </div>
      )}

      <div className="section"><h3>Your card · settled</h3></div>
      {vm.legs.map((leg, i) => (
        <MyCardLegRow key={`${leg.fixtureId}-${i}`} leg={leg} />
      ))}

      {entry?.claimable ? (
        <button className="cta cta-win" disabled={busy} aria-busy={busy} onClick={onClaim}>
          {busy ? "…" : `Claim ${fmtSol(entry.payout)}${SOL} →`}
        </button>
      ) : perfect ? (
        <div className="cta-sub" style={{ marginTop: 14 }}>Payout claimed.</div>
      ) : null}
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      <div className="card-foot"><span className="dia">◆</span> Settled on-chain · TxLINE proofs</div>
    </div>
  );
}
