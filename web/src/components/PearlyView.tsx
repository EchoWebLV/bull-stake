import { useEffect, useRef, useState } from "react";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { usePrivySigner } from "../hooks/usePrivySigner.ts";
import { buildEnterTx, buildClaimContestTx } from "../lib/anchorClient.ts";
import {
  getCard, getContestEntries,
  type Card, type ContestEntry,
} from "../lib/api.ts";
import { SOL, fmtSol } from "../lib/odds.ts";
import {
  mapPearlyCard, walletHoldsCard, type PearlyCardVM, type PearlyLegVM, type PearlyLegState,
} from "../lib/pearlyCard.ts";
import { snapshotForAlerts, diffCardAlerts, type AlertSnapshot, type PearlyAlert } from "../lib/pearlyAlerts.ts";
import { buildTicketModel } from "../lib/pearlyTicket.ts";
import { shareTicketPng } from "../lib/ticketCanvas.ts";
import { notificationsSupported, notificationsEnabled, requestNotifications, pushNotifications } from "../lib/notify.ts";
import { flagUrl, teamInitials } from "../lib/flags.ts";

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

/** Per-leg status chip: ○ open / ● locked-in-play / ✓ hit / ✗ dead — from the
 *  mapper's derived PearlyLegState, never recomputed here. Monochrome marks
 *  only — the skin is hand-drawn ink, no emoji. */
function legChip(state: PearlyLegState): { icon: string; label: string; tone: string } {
  switch (state) {
    case "open": return { icon: "○", label: "open", tone: "neutral" };
    case "locked": return { icon: "●", label: "locked", tone: "neutral" };
    case "live": return { icon: "●", label: "locked · in play", tone: "warn" };
    case "final": return { icon: "◇", label: "final · settling", tone: "neutral" };
    case "won": return { icon: "✓", label: "hit", tone: "good" };
    case "lost": return { icon: "✗", label: "dead", tone: "bad" };
    case "voided": return { icon: "∅", label: "voided", tone: "neutral" };
  }
}

export function PearlyView({ onGoLive, active = true }: { onGoLive?: () => void; active?: boolean } = {}) {
  const { ready, authenticated } = usePrivy();
  const { login } = useLogin();
  const { address, signAndSend } = usePrivySigner();

  const [card, setCard] = useState<Card | null | undefined>(undefined); // undefined = loading
  const [winningBuckets, setWinningBuckets] = useState<(number | null)[]>([]);
  const [entry, setEntry] = useState<ContestEntry>(); // nonce-0 entry (claimable/payout live here)
  const [picks, setPicks] = useState<Record<number, number>>({}); // picker draft: legIndex → bucket
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [failedPolls, setFailedPolls] = useState(0); // consecutive /api/card failures (reset on any success)
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
    // The card gates the whole view (picker vs. HUD), so paint it the instant it
    // lands. Per-leg won/lost now rides ON the card itself — each leg carries its
    // own `winningBucket` (the engine's readLegWinningBuckets: Settled OR
    // voided-with-bucket, the SAME source as myCard.alive), so a leg's chip and
    // the card's alive/dead state can never disagree. This replaces the old
    // /api/contest/live join, whose contest-level winning_buckets stay null until
    // the WHOLE card settles — which left a provably-dead leg reading "in play".
    const c = await getCard(address ?? undefined).catch(() => undefined);
    if (c === undefined) {
      // Transient fetch failure — keep the last good state on screen, but COUNT
      // it: with no data at all yet, consecutive failures flip the loading card
      // to an honest "can't reach the server" (an engine that isn't running
      // otherwise reads as an infinite "Loading…" — the 07-12 stuck report).
      setFailedPolls((n) => n + 1);
      return;
    }
    setFailedPolls(0);
    setCard(c);
    if (!c) { setWinningBuckets([]); setEntry(undefined); return; }
    setWinningBuckets(c.legs.map((l) => l.winningBucket ?? null));

    // Wallet's chain entry (the picker cross-check / claim source) — fold in
    // whenever it lands; it never gates the card render.
    if (address) {
      getContestEntries(address, c.contestId)
        .then((es) => setEntry(es.find((e) => e.nonce === PEARLY_NONCE)))
        .catch(() => setEntry(undefined));
    } else {
      setEntry(undefined);
    }
  }

  useEffect(() => {
    if (!active) return; // backgrounded tab: keep last data, stop polling the slow scan
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
    tick(); // re-activating a mounted tab refreshes immediately, then resumes polling
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, confirmingEntry, active]);
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now()); // resync time-based labels the moment the tab is shown
    const t = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [active]);

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

  // The trust rules for the rendered VM (a known poll wins, else re-map with
  // the sticky last-confirmed myCard so legs/picks/carried all stay internally
  // consistent — mapPearlyCard is pure, so the second call is cheap), computed
  // BEFORE the early returns so the hooks order stays render-stable; past the
  // guards below, `effectiveVm` aliases this. snapshotForAlerts is null on
  // empty/legacy cards, and diffCardAlerts emits nothing on a null prev, so
  // reloads/remounts never replay history.
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

  if (card === undefined || !ready) {
    // Never had data: after a couple of failed polls this is a connectivity
    // problem, not a slow scan — say so instead of loading forever.
    return (
      <div className="card empty-card">
        {ready && failedPolls >= 2
          ? <>Can't reach the game server — retrying…</>
          : <>Loading today's Sweep…</>}
      </div>
    );
  }

  // ── Empty: no card composed today ─────────────────────────────────────────
  if (vm.empty) {
    return (
      <div className="card empty-card">
        No Sweep card today yet — the next card composes at 08:00 UTC. Check back soon.
      </div>
    );
  }

  // If we've never seen a known poll for this wallet at all, there's genuinely
  // nothing to show yet — a loading affordance is correct.
  if (!vm.myCardKnown && !haveKnownMyCard) {
    return <div className="card empty-card">Checking your card…</div>;
  }
  // alertVm is computed pre-early-returns with the same trust rules; past the
  // guards above it is provably non-null — one expression, no drift.
  const effectiveVm: PearlyCardVM = alertVm!;

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
  async function onShare() {
    // effectiveVm can be null pre-first-confirmed-poll; buildTicketModel also
    // returns null for any state without a held card — both mean no ticket.
    const model = effectiveVm ? buildTicketModel(effectiveVm, { nowMs, wallet: address }) : null;
    if (!model) return;
    setSharing(true);
    try {
      const how = await shareTicketPng(model);
      if (how === "clipboard") flash("Ticket copied — paste it anywhere.");
      else if (how === "download") flash("Ticket saved.");
      else if (how === "share") flash("Shared");
      // "cancelled": user closed the share sheet — stay quiet.
    } catch (e) {
      flash(`Share failed: ${(e as Error).message}`, true);
    } finally {
      setSharing(false);
    }
  }

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
        onShare={onShare} sharing={sharing}
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
        onGoLive={onGoLive} onShare={onShare} sharing={sharing}
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
  const [info, setInfo] = useState(false);
  const pickableIdx = vm.legs.reduce<number[]>((acc, l, i) => (l.pickable ? [...acc, i] : acc), []);
  const made = pickableIdx.filter((i) => picks[i] != null).length;
  const priceSol = fmtSol(card.entryPrice);
  const entriesClosed = !vm.entriesOpen;

  // Group legs by match (fixture) so a match with several markets is ONE card,
  // not N stacked boxes. Original leg index is preserved for picks/onPick.
  const groups: MatchGroupVM[] = [];
  vm.legs.forEach((leg, i) => {
    let g = groups.find((x) => x.fixtureId === leg.fixtureId);
    if (!g) {
      g = { fixtureId: leg.fixtureId, home: leg.home, away: leg.away, kickoffText: leg.kickoffText, markets: [] };
      groups.push(g);
    }
    g.markets.push({ leg, idx: i });
  });

  return (
    <div className="pearly">
      <div className="pearly-head">
        <div className="ph-title">The Daily Sweep</div>
        <button className="ph-info" aria-label="How the Daily Sweep works" onClick={() => setInfo(true)}>i</button>
      </div>
      <div className="pearly-stats">
        <div className="ps"><b>{vm.potText}</b><span>pot{vm.potRolledText ? " · rolled" : ""}</span></div>
        <div className="ps"><b>{vm.weightPreviewLabel}</b><span>multiplier</span></div>
        <div className="ps"><b>{pickableIdx.length}</b><span>open legs</span></div>
      </div>

      {entriesClosed && (
        <div className="pearly-closed-note">Entries have closed for today's card — fewer than 3 legs remain open.</div>
      )}

      {groups.map((g) => (
        <MatchGroup key={g.fixtureId} group={g} picks={picks} onPick={onPick} />
      ))}

      {info && <PearlyInfoModal vm={vm} openLegs={pickableIdx.length} onClose={() => setInfo(false)} />}

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
            : `Enter the Sweep · ${priceSol} ${SOL} · full card ${vm.weightPreviewLabel}`}
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

// One match = one card with all its markets inside (legs sharing a fixtureId).
interface MatchGroupVM {
  fixtureId: number;
  home: string;
  away: string;
  kickoffText: string;
  markets: { leg: PearlyLegVM; idx: number }[];
}

/** A team crest: real flag when we have one, else an initials blob. */
function TeamFlag({ name }: { name: string }) {
  const url = flagUrl(name);
  if (url) return <img className="pm-flag" src={url} alt="" aria-hidden="true" />;
  return <span className="pm-flag pm-flag-blob" aria-hidden="true">{teamInitials(name)}</span>;
}

/** Flag for a 3-way result option (bucket 0 = home, 2 = away); null otherwise. */
function optionFlag(leg: PearlyLegVM, bucket: number): string | null {
  if (leg.buckets !== 3) return null;
  if (bucket === 0) return flagUrl(leg.home);
  if (bucket === 2) return flagUrl(leg.away);
  return null;
}

function MatchGroup({ group, picks, onPick }: {
  group: MatchGroupVM; picks: Record<number, number>; onPick: (legIdx: number, bucket: number) => void;
}) {
  return (
    <div className="pmatch">
      {group.kickoffText && <span className="pm-ko">KO {group.kickoffText}</span>}
      <div className="pmatch-h">
        <div className="pm-team"><TeamFlag name={group.home} /><span className="pm-name">{group.home}</span></div>
        <span className="pm-vs">v</span>
        <div className="pm-team pm-away"><span className="pm-name">{group.away || "TBD"}</span><TeamFlag name={group.away} /></div>
      </div>
      {group.markets.map(({ leg, idx }) => (
        <MarketRow key={idx} leg={leg} pick={picks[idx]} onPick={(b) => onPick(idx, b)} />
      ))}
    </div>
  );
}

function MarketRow({ leg, pick, onPick }: {
  leg: PearlyLegVM; pick: number | undefined; onPick: (bucket: number) => void;
}) {
  return (
    <div className={`pmkt${leg.pickable ? "" : " pmkt-locked"}`}>
      <div className="pmkt-q">
        <span>{leg.marketLabel}</span>
        {!leg.pickable && <span className="pmkt-lock">kicked off</span>}
      </div>
      <div className="pmkt-opts">
        {leg.options.map((o) => {
          const fl = optionFlag(leg, o.bucket);
          return (
            <button
              key={o.bucket}
              className={`popt${pick === o.bucket ? " sel" : ""}`}
              disabled={!leg.pickable}
              aria-pressed={pick === o.bucket}
              onClick={() => onPick(o.bucket)}
            >
              {fl && <img className="popt-fl" src={fl} alt="" aria-hidden="true" />}
              <span>{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The rules/how-it-works, tucked behind the (i) button so the picker stays clean. */
function PearlyInfoModal({ vm, openLegs, onClose }: {
  vm: PearlyCardVM; openLegs: number; onClose: () => void;
}) {
  return (
    <div className="pl-modal" role="dialog" aria-modal="true" aria-label="How the Daily Sweep works" onClick={onClose}>
      <div className="pl-modal-card" onClick={(e) => e.stopPropagation()}>
        <button className="pl-modal-x" aria-label="Close" onClick={onClose}>✕</button>
        <div className="pl-h">Every match.<br />One perfect card.</div>
        <p className="pl-sub">Pick a leg on the matches you fancy. <b>Perfect cards split the pot</b> — bigger multiplier, bigger share.</p>
        <ul className="pl-rules">
          <li>Enter any time while at least <b>3 legs</b> are still open ({openLegs} open now). Each leg locks at its own kickoff.</li>
          <li>Every leg still open when you join <b>doubles your prize</b> — join early, carry more, win bigger.</li>
          <li><b>No buy-backs.</b> One card a day.</li>
          <li><b>Perfect or nothing:</b> no perfect card → the whole pot rolls to tomorrow.</li>
        </ul>
        <div className="pl-modal-pot">pot {vm.potText}{vm.potRolledText ? ` · ${vm.potRolledText}` : ""} · {vm.aliveText} cards in</div>
        <div className="card-foot"><span className="dia">◆</span> Settled on-chain · TxLINE proofs</div>
      </div>
    </div>
  );
}

// ── My-card HUD (entered — alive or dead-spectating; mockup 17 #hud) ───────

function MyCardHud({ card, vm, msg, msgErr, alerts, alertsOn, onToggleAlerts, onGoLive, onShare, sharing }: {
  card: Card; vm: PearlyCardVM; msg: string | undefined; msgErr: boolean;
  alerts: PearlyAlert[]; alertsOn: boolean; onToggleAlerts: () => void; onGoLive?: () => void;
  onShare: () => void; sharing: boolean;
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
              {alertsOn ? "alerts on" : "alerts off"}
            </button>
          )}
        </div>
        {/* role="log": additions are announced politely without re-reading the
            whole feed; the head (bell toggle) stays outside so its state
            changes never get announced as feed entries. */}
        <div role="log">
          {alerts.length === 0
            ? <div className="pt-row pt-empty">quiet for now — alerts land here as your legs go live</div>
            : alerts.map((a) => <div key={a.id} className={`pt-row pt-${a.kind}`}>{a.text}</div>)}
        </div>
      </div>

      {dead && (
        <div className="pearly-death">
          <div className="pd-h">{vm.degraded ? "Checking your card…" : "Card busted"}</div>
          <div className="pd-sub">
            {vm.degraded
              ? "We're re-syncing with the chain — this will confirm on the next poll."
              : "The pot rolls on. New card tomorrow 08:00 UTC."}
          </div>
          <div className="pd-note">your alerts stay on · no buy-backs · spectating the field</div>
        </div>
      )}

      {!dead && vm.entriesCloseText && (
        <div className="pearly-strip">
          <span>entries close in {vm.entriesCloseText}</span>
          {vm.nextLockText && <span>· next leg locks in {vm.nextLockText}</span>}
        </div>
      )}

      {/* Pearly → Live cross-link: while any leg still on this card is in play,
          point at the Live tab — `carried !== false` deliberately includes
          undefined (picker-view legs never set it; on the HUD it always is). */}
      {!dead && onGoLive && vm.legs.some((l) => l.carried !== false && l.state === "live") && (
        <button className="pearly-strip pearly-golive" onClick={onGoLive}>
          match window live — go play it
        </button>
      )}

      <div className="section">
        <h3>Your card: {vm.legs.filter((l) => l.carried !== false).length} legs · {vm.myWeightLabel}</h3>
        <span className="tag">{dead ? "spectating" : "riding"}</span>
      </div>
      {vm.legs.map((leg, i) => (
        <MyCardLegRow key={`${leg.fixtureId}-${i}`} leg={leg} />
      ))}

      <button className="pl-share" disabled={sharing} onClick={onShare} aria-busy={sharing}>
        {sharing ? "…" : "Share my card ↗"}
      </button>

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
  card, vm, entry, busy, onClaim, onShare, sharing, msg, msgErr,
}: {
  card: Card; vm: PearlyCardVM; entry: ContestEntry | undefined; busy: boolean;
  onClaim: () => void; onShare: () => void; sharing: boolean;
  msg: string | undefined; msgErr: boolean;
}) {
  const perfect = vm.myCardState === "settled-won";
  const rolledOver = card.status === "rolledOver";

  if (vm.myCardState === "not-entered") {
    return (
      <div className="pearly">
        <div className="pearly-rollover">
          <div className="pearly-roll-h">{rolledOver ? "Nobody survived" : "Settled"}</div>
          <div className="pearly-roll-sub">
            {rolledOver
              ? `The whole pot (${vm.potText}) rolls into tomorrow's jackpot.`
              : "Today's Sweep has settled. You sat this one out."}
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
          <div className="pw-trophy">★</div>
          <div className="pw-h">PERFECT CARD</div>
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

      <button className="pl-share" disabled={sharing} onClick={onShare} aria-busy={sharing}>
        {sharing ? "…" : perfect ? "Share the perfect card ↗" : "Share my card ↗"}
      </button>
      {msg && <p className={`msg ${msgErr ? "err" : ""}`} role="status" aria-live="polite">{msg}</p>}
      <div className="card-foot"><span className="dia">◆</span> Settled on-chain · TxLINE proofs</div>
    </div>
  );
}
