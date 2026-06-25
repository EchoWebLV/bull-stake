import {
  program, marketPda, vaultPda, freshFunded, goalsArgs,
  expectError, nowSec, BN, Keypair, SystemProgram, assert,
} from "./helpers";

describe("initialize_market", () => {
  const fixtureId = 1001;

  it("creates a market with the immutable predicate", async () => {
    const creator = await freshFunded();
    const settleAuth = Keypair.generate();
    const market = marketPda(fixtureId, 0);
    const vault = vaultPda(market);
    const closeTs = nowSec() + 3600;

    await program.methods
      .initializeMarket(new BN(fixtureId), 0, goalsArgs({
        settleAuthority: settleAuth.publicKey,
        threshold: 2,
        entryCloseTs: closeTs,
        feeBps: 250,
      }))
      .accountsStrict({
        creator: creator.publicKey,
        market,
        vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.fixtureId.toNumber(), fixtureId);
    assert.equal(m.marketId, 0);
    assert.equal(m.statKey, 1);
    assert.equal(m.statKey2, 2);
    assert.deepEqual(m.op, { add: {} });
    assert.deepEqual(m.comparison, { greaterThan: {} });
    assert.equal(m.threshold, 2);
    assert.equal(m.feeBps, 250);
    assert.deepEqual(m.status, { open: {} });
    assert.isNull(m.winningBucket);
    assert.equal(m.totalPool.toNumber(), 0);
    assert.equal(m.bucketTotals[0].toNumber(), 0);
    assert.equal(m.bucketTotals[1].toNumber(), 0);
    // fee_recipient defaults to creator when None
    assert.ok(m.feeRecipient.equals(creator.publicKey));
    assert.ok(m.settleAuthority.equals(settleAuth.publicKey));
  });

  it("rejects an entry_close_ts in the past", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 1);
    const vault = vaultPda(market);
    await expectError(
      program.methods
        .initializeMarket(new BN(fixtureId), 1, goalsArgs({
          settleAuthority: creator.publicKey,
          threshold: 2,
          entryCloseTs: nowSec() - 100,
        }))
        .accountsStrict({
          creator: creator.publicKey, market, vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator]).rpc(),
      "EntryCloseInPast",
    );
  });

  it("rejects fee_bps above the maximum", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 2);
    const vault = vaultPda(market);
    await expectError(
      program.methods
        .initializeMarket(new BN(fixtureId), 2, goalsArgs({
          settleAuthority: creator.publicKey,
          threshold: 2,
          entryCloseTs: nowSec() + 3600,
          feeBps: 1001,
        }))
        .accountsStrict({
          creator: creator.publicKey, market, vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator]).rpc(),
      "FeeTooHigh",
    );
  });

  it("rejects a predicate where stat_key2 is set but op is not", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 3);
    const vault = vaultPda(market);
    const args = goalsArgs({
      settleAuthority: creator.publicKey,
      threshold: 2,
      entryCloseTs: nowSec() + 3600,
    });
    (args as any).op = null; // stat_key2 = 2 but op = null
    await expectError(
      program.methods
        .initializeMarket(new BN(fixtureId), 3, args)
        .accountsStrict({
          creator: creator.publicKey, market, vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator]).rpc(),
      "PredicateMismatch",
    );
  });

  it("creates a single-stat market (stat_key2 and op both None)", async () => {
    const creator = await freshFunded();
    const market = marketPda(fixtureId, 4);
    const vault = vaultPda(market);
    const args = goalsArgs({
      settleAuthority: creator.publicKey,
      threshold: 1,
      entryCloseTs: nowSec() + 3600,
    });
    (args as any).statKey2 = null; // single-stat: both stat_key2 and op None
    (args as any).op = null;

    await program.methods
      .initializeMarket(new BN(fixtureId), 4, args)
      .accountsStrict({
        creator: creator.publicKey, market, vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator]).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.statKey, 1);
    assert.isNull(m.statKey2);
    assert.isNull(m.op);
    assert.deepEqual(m.status, { open: {} });
  });
});
