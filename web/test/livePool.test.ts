import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { livePoolPda, liveEntryPda, callPda, u32le } from "../src/lib/pdasLive.ts";
import {
  poolIsClaimable, isWinner,
  type LivePoolResponse, type LivePoolView, type CallView, type LiveEntryView,
} from "../src/lib/api.ts";
import { connection } from "../src/lib/anchorClient.ts";
import {
  buildJoinLivePoolTx, buildClaimLivePoolTx, buildLockPickTx,
} from "../src/lib/livePoolClient.ts";
import { snapshotFromChain } from "../src/lib/liveGame.ts";

const PAYER = "So11111111111111111111111111111111111111112";
const POOL_ID = 1782924013084000; // from the Slice-2b devnet proof

// Keep the builder tests offline: withBlockhash() calls getLatestBlockhash.
vi.spyOn(connection, "getLatestBlockhash").mockResolvedValue({
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
  it("lock_pick includes the derived call + entry accounts", async () => {
    const tx = await buildLockPickTx(PAYER, POOL_ID, 0, 1);
    const pool = livePoolPda(POOL_ID);
    const metas = tx.instructions[0].keys.map((k) => k.pubkey.toBase58());
    expect(metas).toContain(callPda(pool, 0).toBase58());
    expect(metas).toContain(liveEntryPda(pool, new PublicKey(PAYER)).toBase58());
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
    pubkey: "C", pool: "P", seq: 0, kind: 0, // NextGoal
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
});
