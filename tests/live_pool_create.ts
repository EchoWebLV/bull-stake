import { program, freshFunded, nowSec, BN, PublicKey, SystemProgram, expectError, assert } from "./helpers";
import { createPool, livePoolPda, liveCursorPda, uniquePoolId } from "./live_helpers";
import type { Keypair } from "@solana/web3.js";

const NONE_SEQ = 4294967295; // u32::MAX

const sk = (s: any) => Object.keys(s)[0];

async function rawCreate(o: {
  poolId?: BN; fixtureId?: number; entryPrice?: number; feeBps?: number;
  numCalls?: number; lockTs?: number; settleAfterTs?: number; keeper?: Keypair;
} = {}): Promise<string> {
  const keeper = o.keeper ?? (await freshFunded());
  const fr = await freshFunded(0.001);
  const poolId = o.poolId ?? uniquePoolId();
  const pool = livePoolPda(poolId);
  const cursor = liveCursorPda(pool);
  return program.methods
    .createLivePool(
      poolId, new BN(o.fixtureId ?? 900_001), new BN(o.entryPrice ?? 1e8),
      new BN(o.lockTs ?? nowSec() + 8), new BN(o.settleAfterTs ?? nowSec() + 9),
      fr.publicKey, o.feeBps ?? 0, o.numCalls ?? 8,
    )
    .accountsStrict({ keeper: keeper.publicKey, pool, cursor, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
}

describe("live_pool_create", () => {
  it("inits LivePool (Open) + LiveCursor; keeper is settle_authority", async () => {
    const ctx = await createPool({ entryPrice: 1e8, feeBps: 250, numCalls: 20 });
    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(sk(pool.status), "open");
    assert.isTrue(pool.settleAuthority.equals(ctx.keeper.publicKey));
    assert.isTrue(pool.feeRecipient.equals(ctx.feeRecipient.publicKey));
    assert.equal(pool.entryPrice.toNumber(), 1e8);
    assert.equal(pool.feeBps, 250);
    assert.equal(pool.numCalls, 20);
    assert.equal(pool.playerCount.toNumber(), 0);
    assert.equal(pool.winningScore.toNumber(), 0);
    assert.equal(pool.winnerCount.toNumber(), 0);
    assert.equal(pool.distributable.toNumber(), 0);

    const cursor = await program.account.liveCursor.fetch(ctx.cursor);
    assert.isTrue(cursor.pool.equals(ctx.pool));
    assert.equal(cursor.nextSeq, 0);
    assert.equal(cursor.openSeq, NONE_SEQ);
    assert.equal(cursor.resolvedCount, 0);
  });

  it("rejects entry_price 0 / pool_id 0 / fixture 0", async () => {
    await expectError(rawCreate({ entryPrice: 0 }), "ZeroAmount");
    await expectError(rawCreate({ poolId: new BN(0) }), "InvalidPoolId");
    await expectError(rawCreate({ fixtureId: 0 }), "InvalidFixtureId");
  });

  it("rejects fee_bps > MAX_FEE_BPS and bad num_calls", async () => {
    await expectError(rawCreate({ feeBps: 2000 }), "FeeTooHigh");
    await expectError(rawCreate({ numCalls: 0 }), "InvalidCallCount");
    await expectError(rawCreate({ numCalls: 65 }), "InvalidCallCount");
  });

  it("rejects lock_ts >= settle_after_ts and now >= lock_ts", async () => {
    await expectError(rawCreate({ lockTs: nowSec() + 100, settleAfterTs: nowSec() + 50 }), "EntryCloseInPast");
    await expectError(rawCreate({ lockTs: nowSec() - 5 }), "EntryCloseInPast");
  });

  it("is idempotent: second create for same pool_id fails", async () => {
    const poolId = uniquePoolId();
    await rawCreate({ poolId });
    await expectError(rawCreate({ poolId }), "already in use");
  });
});
