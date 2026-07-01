import { program, connection, freshFunded, expectError, assert } from "./helpers";
import {
  runMatch, createPool, joinPool, openCall, lockPick, resolveCall, scoreEntry, endPool,
  settlePool, claimPool, waitForSettle, liveEntryPda, type CallSpec,
} from "./live_helpers";

const sk = (s: any) => Object.keys(s)[0];

describe("live_pool_settle", () => {
  it("recomputes winning_score = max(total) on-chain; single winner takes the pot", async () => {
    // p0 hits (4 pts), p1 & p2 miss.
    const calls: CallSpec[] = [{ outcome: 0, picks: [0, 1, 2] }];
    const { ctx, players, entries } = await runMatch(3, calls, {});
    await waitForSettle(ctx);
    await settlePool(ctx, entries);

    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(sk(pool.status), "settled");
    assert.equal(pool.winningScore.toNumber(), 4);
    assert.equal(pool.winnerCount.toNumber(), 1);
    assert.isAbove(pool.distributable.toNumber(), 0);
    const share = pool.distributable.toNumber(); // single winner

    // Winner claim: gets the share (delta > share once rent refund is added).
    const before = await connection.getBalance(players[0].publicKey);
    await claimPool(ctx, players[0]);
    const after = await connection.getBalance(players[0].publicKey);
    assert.isAbove(after - before, share);
    const pool2 = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool2.claimedCount.toNumber(), 1);
    assert.equal(pool2.claimedTotal.toNumber(), share);

    // Non-winner claim pays 0 (just the rent refund, far below the share).
    const lb = await connection.getBalance(players[1].publicKey);
    await claimPool(ctx, players[1]);
    const la = await connection.getBalance(players[1].publicKey);
    assert.isBelow(la - lb, share);
    const pool3 = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool3.claimedCount.toNumber(), 1); // unchanged

    // Double-claim by the winner fails (entry account closed).
    let threw = false;
    try { await claimPool(ctx, players[0]); } catch { threw = true; }
    assert.isTrue(threw, "double claim must fail");
  });

  it("splits evenly on an N-way tie at the max", async () => {
    const calls: CallSpec[] = [{ outcome: 0, picks: [0, 0, 2] }]; // p0 & p1 tie at 4
    const { ctx, players, entries } = await runMatch(3, calls, {});
    await waitForSettle(ctx);
    await settlePool(ctx, entries);

    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool.winningScore.toNumber(), 4);
    assert.equal(pool.winnerCount.toNumber(), 2);
    const share = pool.distributable.toNumber() / 2;

    await claimPool(ctx, players[0]);
    await claimPool(ctx, players[1]);
    const pool2 = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool2.claimedCount.toNumber(), 2);
    assert.equal(pool2.claimedTotal.toNumber(), share * 2);
  });

  it("nobody scores → RolledOver, pot swept to the jackpot, no winner", async () => {
    const calls: CallSpec[] = [{ outcome: 0, picks: [1, 1, 1] }]; // all miss → all 0
    const { ctx, players, entries } = await runMatch(3, calls, {});
    await waitForSettle(ctx);
    await settlePool(ctx, entries);

    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(sk(pool.status), "rolledOver");
    assert.equal(pool.winningScore.toNumber(), 0);
    assert.equal(pool.winnerCount.toNumber(), 0);
    assert.equal(pool.distributable.toNumber(), 0);
    await claimPool(ctx, players[0]); // pays 0, just closes
  });

  it("takes rake = player_count*entry_price*fee_bps/10000 to fee_recipient", async () => {
    const calls: CallSpec[] = [{ outcome: 0, picks: [0, 1, 2] }];
    const { ctx, entries } = await runMatch(3, calls, { feeBps: 500, entryPrice: 1e8 });
    await waitForSettle(ctx);
    const before = await connection.getBalance(ctx.feeRecipient.publicKey);
    await settlePool(ctx, entries);
    const after = await connection.getBalance(ctx.feeRecipient.publicKey);
    assert.equal(after - before, (3 * 1e8 * 500) / 10000); // 0.015 SOL, exact (not a signer)
  });

  it("SECURITY: rejects settle if not every seat is passed (coverage)", async () => {
    const calls: CallSpec[] = [{ outcome: 0, picks: [0, 1, 2] }];
    const { ctx, entries } = await runMatch(3, calls, {});
    await waitForSettle(ctx);
    await expectError(settlePool(ctx, entries.slice(0, 2)), "ScoreMismatch"); // 2 of 3
  });

  it("SECURITY: rejects a foreign (non-program-owned) account among the seats", async () => {
    const calls: CallSpec[] = [{ outcome: 0, picks: [0, 1, 2] }];
    const { ctx, entries } = await runMatch(3, calls, {});
    await waitForSettle(ctx);
    const fake = (await freshFunded()).publicKey; // system-owned
    await expectError(settlePool(ctx, [entries[0], entries[1], fake]), "ScoreMismatch");
  });

  it("SECURITY: a keeper can't win by padding a duplicate seat and omitting the top scorer", async () => {
    // p2 is the top scorer. Keeper tries [e0, e0, e1] (duplicate e0, omit e2) to
    // reach count 3 → strictly-ascending guard rejects the duplicate.
    const calls: CallSpec[] = [{ outcome: 0, picks: [1, 1, 0] }]; // only p2 scores
    const { ctx, entries } = await runMatch(3, calls, {});
    await waitForSettle(ctx);
    await expectError(settlePool(ctx, [entries[0], entries[0], entries[1]], { sort: false }), "ScoreMismatch");
  });

  it("SECURITY: rejects settle when a seat isn't scored through all resolved calls", async () => {
    const ctx = await createPool({ numCalls: 2 });
    const { player: p0 } = await joinPool(ctx);
    const { player: p1 } = await joinPool(ctx);
    await openCall(ctx, 0);
    await lockPick(ctx, p0, 0, 0);
    await lockPick(ctx, p1, 0, 0);
    await resolveCall(ctx, 0, 0);
    await scoreEntry(ctx, p0.publicKey, 0); // p1 deliberately NOT scored
    await endPool(ctx);
    await waitForSettle(ctx);
    await expectError(
      settlePool(ctx, [liveEntryPda(ctx.pool, p0.publicKey), liveEntryPda(ctx.pool, p1.publicKey)]),
      "NotAllScored",
    );
  });

  it("rejects settle before settle_after_ts / when not Ended / when < 2 players / twice", async () => {
    // too early
    const early = await runMatch(2, [{ outcome: 0, picks: [0, 1] }], { settleInSecs: 90 });
    await expectError(settlePool(early.ctx, early.entries), "SettleTooEarly");

    // not ended (status-gated: PoolNotEnded fires before the settle-time check)
    const ctxNE = await createPool({});
    const a = await joinPool(ctxNE);
    const b = await joinPool(ctxNE);
    await expectError(settlePool(ctxNE, [a.entry, b.entry]), "PoolNotEnded");

    // < 2 players
    const ctx1 = await createPool({});
    const solo = await joinPool(ctx1);
    await endPool(ctx1);
    await waitForSettle(ctx1);
    await expectError(settlePool(ctx1, [solo.entry]), "NotEnoughPlayers");

    // double settle
    const two = await runMatch(2, [{ outcome: 0, picks: [0, 1] }], {});
    await waitForSettle(two.ctx);
    await settlePool(two.ctx, two.entries);
    await expectError(settlePool(two.ctx, two.entries), "PoolNotEnded");
  });
});
