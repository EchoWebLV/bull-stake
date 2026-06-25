import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, balance, BN, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

async function setup(fixtureId: number) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, goalsArgs({
      settleAuthority: settleAuth.publicKey, threshold: 2, entryCloseTs: nowSec() + 3600,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { settleAuth, market, vault };
}

async function bet(market: any, vault: any, bettor: any, bucket: number, lamports: number) {
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(bucket, new BN(lamports))
    .accountsStrict({
      bettor: bettor.publicKey, market, vault, position,
      systemProgram: SystemProgram.programId,
    })
    .signers([bettor]).rpc();
}

describe("void_market", () => {
  it("voids an open market and records proof-binding (no time gate)", async () => {
    const a = await freshFunded();
    const { settleAuth, market, vault } = await setup(4001);
    await bet(market, vault, a, 0, 1 * LAMPORTS_PER_SOL);

    await program.methods
      .voidMarket(15, new BN(1700000000000))
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { voided: {} });
    assert.equal(m.settledSeq, 15);
    assert.equal(m.settledTs.toString(), "1700000000000");
    // void moves no funds: no winner, no fee, pool still escrowed in the vault
    assert.isNull(m.winningBucket);
    assert.equal(m.feeCollected.toNumber(), 0);
    assert.equal(m.totalPool.toNumber(), 1 * LAMPORTS_PER_SOL);
    assert.isAtLeast(await balance(vault), 1 * LAMPORTS_PER_SOL);
  });

  it("rejects void by a non-authority", async () => {
    const { market } = await setup(4002);
    const imposter = await freshFunded();
    await expectError(
      program.methods.voidMarket(1, new BN(1))
        .accountsStrict({ settleAuthority: imposter.publicKey, market })
        .signers([imposter]).rpc(),
      "Unauthorized",
    );
  });

  it("rejects voiding a market that is not open", async () => {
    const { settleAuth, market } = await setup(4003);
    await program.methods.voidMarket(1, new BN(1))
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
      .signers([settleAuth]).rpc();
    // second void should fail — already Voided
    await expectError(
      program.methods.voidMarket(2, new BN(2))
        .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
        .signers([settleAuth]).rpc(),
      "MarketNotOpen",
    );
  });
});
