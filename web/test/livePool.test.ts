import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { livePoolPda, liveEntryPda, callPda, u32le } from "../src/lib/pdasLive.ts";
import {
  poolIsClaimable, isWinner,
  type LivePoolResponse, type LivePoolView, type CallView, type LiveEntryView,
} from "../src/lib/api.ts";
import { connection, erConnection } from "../src/lib/anchorClient.ts";
import {
  buildJoinLivePoolTx, buildClaimLivePoolTx, buildLockPickTxER,
} from "../src/lib/livePoolClient.ts";
import { snapshotFromChain } from "../src/lib/liveGame.ts";

const PAYER = "So11111111111111111111111111111111111111112";
const POOL_ID = 1782924013084000; // from the Slice-2b devnet proof

// Keep the builder tests offline: withBlockhash() (base) and buildLockPickTxER (ER)
// both call getLatestBlockhash.
vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 1,
} as never);
vi.spyOn(erConnection, "getLatestBlockhash").mockResolvedValue({
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 1,
} as never);

describe("pdasLive", () => {
  it("u32le is 4 bytes (call seq is u32, not u64)", () => {
    expect(u32le(1).length).toBe(4);
  });
  it("derivations are deterministic and seq-sensitive", () => {
    const pool = livePoolPda(POOL_ID);
    expect(pool).toBeInstanceOf(PublicKey);
    const player = new PublicKey(PAYER);
    expect(liveEntryPda(pool, player).equals(liveEntryPda(pool, player))).toBe(true);
    expect(callPda(pool, 0).equals(callPda(pool, 0))).toBe(true);
    expect(callPda(pool, 0).equals(callPda(pool, 1))).toBe(false);
  });
});

describe("live view helpers", () => {
  it("winner iff settled and total == winningScore > 0", () => {
    const pool = { status: "settled", winningScore: 4 } as const;
    expect(isWinner(pool, { total: 4 })).toBe(true);
    expect(isWinner(pool, { total: 3 })).toBe(false);
    expect(isWinner({ status: "settled", winningScore: 0 }, { total: 0 })).toBe(false);
    expect(isWinner({ status: "live", winningScore: 4 }, { total: 4 })).toBe(false);
  });
  it("claimable only in terminal states", () => {
    expect(poolIsClaimable({ status: "settled" })).toBe(true);
    expect(poolIsClaimable({ status: "voided" })).toBe(true);
    expect(poolIsClaimable({ status: "rolledOver" })).toBe(true);
    expect(poolIsClaimable({ status: "live" })).toBe(false);
    expect(poolIsClaimable({ status: "open" })).toBe(false);
  });
});

describe("live tx builders", () => {
  it("join targets pool+entry; player is the signer feePayer", async () => {
    const tx = await buildJoinLivePoolTx(PAYER, POOL_ID);
    const player = new PublicKey(PAYER);
    expect(tx.feePayer?.equals(player)).toBe(true);
    expect(tx.instructions.length).toBe(1);
    const k0 = tx.instructions[0].keys[0];
    expect(k0.pubkey.equals(player)).toBe(true);
    expect(k0.isSigner).toBe(true);
  });
  it("claim builds one instruction with the player as feePayer", async () => {
    const tx = await buildClaimLivePoolTx(PAYER, POOL_ID);
    expect(tx.feePayer?.equals(new PublicKey(PAYER))).toBe(true);
    expect(tx.instructions.length).toBe(1);
  });
  it("lock_pick (ER) includes the derived call + entry accounts", async () => {
    const tx = await buildLockPickTxER(PAYER, POOL_ID, 0, 1);
    const pool = livePoolPda(POOL_ID);
    const metas = tx.instructions[0].keys.map((k) => k.pubkey.toBase58());
    expect(metas).toContain(callPda(pool, 0).toBase58());
    expect(metas).toContain(liveEntryPda(pool, new PublicKey(PAYER)).toBase58());
    expect(tx.feePayer?.equals(new PublicKey(PAYER))).toBe(true);
  });
});

describe("snapshotFromChain", () => {
  const ME = "MeWa11et1111111111111111111111111111111111";
  const B1 = "Bot1111111111111111111111111111111111111111";
  const B2 = "Bot2222222222222222222222222222222222222222";

  const poolView: LivePoolView = {
    pubkey: "P", poolId: 42, fixtureId: 900,
    settleAuthority: "S", feeRecipient: "F",
    entryPrice: "35000000", // 0.035 ◎ in lamports
    lockTs: 2_000_000_000, settleAfterTs: 2_000_000_100, feeBps: 0,
    status: "open", numCalls: 1, playerCount: 3,
    winningScore: 0, winnerCount: 0, distributable: "0",
    claimedCount: 0, claimedTotal: "0", settledTs: 0,
  };

  const openCall: CallView = {
    pubkey: "C", pool: "P", seq: 0, kind: "nextGoal", // engine emits a STRING kind
    state: "open", openedTs: 1000, answerSecs: 10,
    numOptions: 3, basePoints: [4, 1, 4], outcome: null,
  };

  const mkEntry = (player: string, total: number, over: Partial<LiveEntryView> = {}): LiveEntryView => ({
    pubkey: "E-" + player, player, pool: "P", amount: "35000000",
    basePts: total, bonusPts: 0, total, streak: 0, nextScoreSeq: 0,
    picks: Array(64).fill(null), ...over,
  });

  const standings: LiveEntryView[] = [
    mkEntry(B1, 7),
    mkEntry(ME, 5, { streak: 3, bonusPts: 2 }),
    mkEntry(B2, 2),
  ];

  const data: LivePoolResponse = {
    pool: poolView,
    openCall,
    standings,
    match: {
      fixtureId: 900, home: "England", away: "Brazil", kickoffMs: null,
      live: { home: 1, away: 0, minute: 63, phase: "live" },
    },
  };

  const myEntry = standings.find((s) => s.player === ME)!;

  it("maps pool pot from entryPrice × playerCount and formats it", () => {
    const snap = snapshotFromChain(data, myEntry, ME, 1_005_000);
    // 0.035 × 3 = 0.105 ◎
    expect(snap.pool.pot).toBe("◎0.105");
    expect(snap.pool.count).toBe(3);
    expect(snap.pool.entry).toBe("◎0.035");
  });

  it("reports your seat's points and rank", () => {
    const snap = snapshotFromChain(data, myEntry, ME, 1_005_000);
    expect(snap.score.pts).toBe(5);
    expect(snap.score.streak).toBe(3);
    expect(snap.score.flameHot).toBe(true);
    expect(snap.pool.rank).toBe("#2"); // B1(7) > ME(5) > B2(2)
  });

  it("orders standings by total desc and names your row 'you'", () => {
    const snap = snapshotFromChain(data, myEntry, ME, 1_005_000);
    expect(snap.standings.map((s) => s.pts)).toEqual([7, 5, 2]);
    expect(snap.standings[0].lead).toBe(true);
    const mine = snap.standings.find((s) => s.me)!;
    expect(mine.name).toBe("you");
    expect(mine.rank).toBe(2);
    // other rows are truncated pubkeys, not "you"
    expect(snap.standings[0].name).toContain("…");
  });

  it("maps a NextGoal call to 3 options with points [4,1,4] and the team labels", () => {
    const snap = snapshotFromChain(data, myEntry, ME, 1_005_000);
    expect(snap.call).not.toBeNull();
    const c = snap.call!;
    expect(c.opts.length).toBe(3);
    expect(c.opts.map((o) => o.p)).toEqual([4, 1, 4]);
    expect(c.opts.map((o) => o.t)).toEqual(["England", "No goal", "Brazil"]);
    expect(c.opts.map((o) => o.k)).toEqual(["0", "1", "2"]);
    expect(c.phase).toBe("answer");
  });

  it("an OPEN call past its local countdown is 'resolving' — no taps at 0.0s (#6/#9)", () => {
    // state still 'open' on-chain (the keeper resolves ~2s later), but now is past
    // openedTs+answerSecs (window ends at 1_010_000). The tap window is closed.
    const snap = snapshotFromChain(data, myEntry, ME, 1_012_000);
    const c = snap.call!;
    expect(c.phase).toBe("resolving"); // NOT "answer" → LiveMatchView canTap is false
    expect(c.timerText).toBe("resolving…");
    expect(c.barPct).toBe(0);
  });

  it("maps a binary kind (goalRush) to 2 Yes/No options with the right points", () => {
    const grCall: CallView = { ...openCall, kind: "goalRush", numOptions: 2, basePoints: [3, 1, 0] };
    const snap = snapshotFromChain({ ...data, openCall: grCall }, myEntry, ME, 1_005_000);
    const c = snap.call!;
    expect(c.kind).toBe("🔥 Goal rush");
    expect(c.opts.length).toBe(2);
    expect(c.opts.map((o) => o.t)).toEqual(["Yes", "No"]);
    expect(c.opts.map((o) => o.p)).toEqual([3, 1]);
  });

  it("maps the live score/clock and refuses to fabricate unavailable stats", () => {
    const snap = snapshotFromChain(data, myEntry, ME, 1_005_000);
    expect(snap.match.scH).toBe(1);
    expect(snap.match.scA).toBe(0);
    expect(snap.match.clock).toBe("63'");
    expect(snap.match.shots).toBe("—");
    expect(snap.match.poss).toBe("—");
  });

  it("returns an idle snapshot when there is no pool", () => {
    const snap = snapshotFromChain({ pool: null }, null, ME, 1_005_000);
    expect(snap.call).toBeNull();
    expect(snap.over).toBeNull();
    expect(snap.standings).toEqual([]);
    expect(snap.pool.count).toBe(0);
    expect(snap.match.home.name).toBe("—");
    expect(snap.pool.rank).toBe("#—");
  });

  it("marks your correct/wrong pick on a resolved call", () => {
    const picks: (number | null)[] = Array(64).fill(null);
    picks[0] = 0; // you picked option 0 (England)
    const resolvedCall: CallView = { ...openCall, state: "resolved", outcome: 0 };
    const resolvedData: LivePoolResponse = { ...data, openCall: resolvedCall };
    const winEntry = mkEntry(ME, 5, { picks });
    const snap = snapshotFromChain(resolvedData, winEntry, ME, 2_000_000);
    const c = snap.call!;
    expect(c.opts[0].state).toBe("correct");
    expect(c.border).toBe("win");
    expect(c.verdict).toEqual({ tone: "win", text: "✓ correct" });
    expect(c.phase).toBe("done");
  });

  it("builds a winner over-card when the pool has settled", () => {
    const settledPool: LivePoolView = {
      ...poolView, status: "settled", winningScore: 5, winnerCount: 1,
      distributable: "100000000", // 0.1 ◎
    };
    const settledData: LivePoolResponse = { ...data, pool: settledPool, openCall: null };
    const snap = snapshotFromChain(settledData, myEntry, ME, 2_100_000_000_000);
    expect(snap.over).not.toBeNull();
    expect(snap.over!.won).toBe(true);
    expect(snap.over!.big).toBe("◎0.1");
    expect(isWinner(settledPool, myEntry)).toBe(true);
  });

  it("treats a voided call as a no-op, not a loss", () => {
    const picks: (number | null)[] = Array(64).fill(null);
    picks[0] = 0; // you picked option 0
    const voidCall: CallView = { ...openCall, state: "resolved", outcome: "void" };
    const voidData: LivePoolResponse = { ...data, openCall: voidCall };
    const snap = snapshotFromChain(voidData, mkEntry(ME, 5, { picks }), ME, 2_000_000);
    const c = snap.call!;
    expect(c.opts[0].state).toBe("sel"); // neutral, NOT "wrong"
    expect(c.border).toBe("");           // no red loss border on a void
    expect(c.verdict).toEqual({ tone: "skip", text: "void" });
  });

  // #7 — per-call feedback via lastCall (openCall only ever carries the OPEN call).
  it("flashes a just-resolved call's verdict from lastCall when no call is open (#7)", () => {
    const picks: (number | null)[] = Array(64).fill(null);
    picks[0] = 0; // you picked England (option 0), the winner
    const lastCall: CallView = { ...openCall, state: "resolved", outcome: 0 };
    // openCall null (between calls); lastCall's window ended 1_010_000, now is 1_012_000.
    const snap = snapshotFromChain(
      { ...data, openCall: null, lastCall }, mkEntry(ME, 5, { picks }), ME, 1_012_000,
    );
    const c = snap.call!;
    expect(c.phase).toBe("done");
    expect(c.border).toBe("win");
    expect(c.verdict).toEqual({ tone: "win", text: "✓ correct" });
  });

  it("clears a stale lastCall verdict → 'waiting for the next call' (recency gate, #7)", () => {
    const lastCall: CallView = { ...openCall, state: "resolved", outcome: 0 };
    // well past window end (1_010_000) + VERDICT_SHOW_MS (10s) → no longer shown.
    const snap = snapshotFromChain({ ...data, openCall: null, lastCall }, myEntry, ME, 1_030_000);
    expect(snap.call).toBeNull();
  });

  it("prefers the OPEN call over a lastCall verdict when both are present (#7)", () => {
    const lastCall: CallView = { ...openCall, seq: 0, state: "resolved", outcome: 0 };
    const open2: CallView = { ...openCall, seq: 1 };
    const snap = snapshotFromChain({ ...data, openCall: open2, lastCall }, myEntry, ME, 1_005_000);
    expect(snap.call!.phase).toBe("answer"); // the live open call wins, not the verdict
  });

  it("shows a 'void' verdict for a voided lastCall (real state='voided') — the dead branch (#7)", () => {
    const picks: (number | null)[] = Array(64).fill(null);
    picks[0] = 0;
    // On-chain a void is state='voided' + outcome='void' (NOT state='resolved').
    const voidLast: CallView = { ...openCall, state: "voided", outcome: "void" };
    const snap = snapshotFromChain(
      { ...data, openCall: null, lastCall: voidLast }, mkEntry(ME, 5, { picks }), ME, 1_012_000,
    );
    const c = snap.call!;
    expect(c.verdict).toEqual({ tone: "skip", text: "void" });
    expect(c.border).toBe("");
    expect(c.opts[0].state).toBe("sel");
  });

  it("a logged-in NON-entrant sees no over-card on a settled pool (no invented result)", () => {
    const settledPool: LivePoolView = {
      ...poolView, status: "settled", winningScore: 7, winnerCount: 1, distributable: "100000000",
    };
    const snap = snapshotFromChain({ ...data, pool: settledPool, openCall: null }, null, ME, 2_100_000_000_000);
    expect(snap.over).toBeNull();
  });

  it("a voided pool refunds the seat's full stake in the over-card", () => {
    const voidedPool: LivePoolView = { ...poolView, status: "voided" };
    const snap = snapshotFromChain({ ...data, pool: voidedPool, openCall: null }, mkEntry(ME, 0), ME, 2_100_000_000_000);
    expect(snap.over).not.toBeNull();
    expect(snap.over!.won).toBe(false);
    expect(snap.over!.title).toBe("Refunded");
    expect(snap.over!.big).toBe("◎0.035"); // full entry_price back
  });

  it("a settled non-winner (has a seat) sees the full-time loss card", () => {
    const settledPool: LivePoolView = {
      ...poolView, status: "settled", winningScore: 12, winnerCount: 1, distributable: "100000000",
    };
    const snap = snapshotFromChain({ ...data, pool: settledPool, openCall: null }, mkEntry(ME, 5), ME, 2_100_000_000_000);
    expect(snap.over).not.toBeNull();
    expect(snap.over!.won).toBe(false);
    expect(snap.over!.title).toBe("Full time");
  });
});
