import { program, connection, freshFunded, sleep, expectError, assert } from "./helpers";
import { createPool, joinPool, endPool, liveEntryPda, NO_PICK } from "./live_helpers";

describe("live_pool_join", () => {
  it("transfers entry_price into the pool, inits the seat, bumps player_count", async () => {
    const ctx = await createPool({ entryPrice: 1e8 });
    const before = await connection.getBalance(ctx.pool);
    const { player, entry } = await joinPool(ctx);
    const after = await connection.getBalance(ctx.pool);
    // Pool balance grows by exactly the entry price (escrow into the PDA).
    assert.equal(after - before, 1e8);

    const e = await program.account.liveEntry.fetch(entry);
    assert.isTrue(e.player.equals(player.publicKey));
    assert.isTrue(e.pool.equals(ctx.pool));
    assert.equal(e.amount.toNumber(), 1e8);
    assert.equal(e.basePts, 0);
    assert.equal(e.bonusPts, 0);
    assert.equal(e.streak, 0);
    assert.equal(e.nextScoreSeq, 0);
    assert.equal(e.picks[0], NO_PICK);
    assert.equal(e.picks[63], NO_PICK);

    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool.playerCount.toNumber(), 1);

    // A second, distinct player deposits another entry price.
    await joinPool(ctx);
    const pool2 = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool2.playerCount.toNumber(), 2);
    assert.equal((await connection.getBalance(ctx.pool)) - after, 1e8);
  });

  it("rejects a join after lock_ts (JoinClosed)", async () => {
    const ctx = await createPool({ lockInSecs: 2, settleInSecs: 30 });
    await sleep(2500);
    const late = await freshFunded();
    await expectError(joinPool(ctx, late), "JoinClosed");
  });

  it("rejects a second join by the same wallet (init, not init_if_needed)", async () => {
    const ctx = await createPool();
    const { player } = await joinPool(ctx);
    await expectError(joinPool(ctx, player), "already in use");
  });

  it("rejects a join when the pool is not Open", async () => {
    const ctx = await createPool();
    await endPool(ctx); // Open -> Ended
    const p = await freshFunded();
    await expectError(joinPool(ctx, p), "PoolNotOpen");
  });
});
