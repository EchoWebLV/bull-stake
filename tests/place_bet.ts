import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, sleep, balance,
  BN, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

async function initMarket(fixtureId: number, marketId: number, closeTs: number) {
  const creator = await freshFunded();
  const market = marketPda(fixtureId, marketId);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), marketId, goalsArgs({
      settleAuthority: creator.publicKey, threshold: 2, entryCloseTs: closeTs,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { creator, market, vault };
}

describe("place_bet", () => {
  it("accepts bets and accumulates totals + escrows lamports", async () => {
    const { market, vault } = await initMarket(2001, 0, nowSec() + 3600);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    const vaultBefore = await balance(vault);

    const amount = new BN(LAMPORTS_PER_SOL); // 1 SOL on OVER
    await program.methods
      .placeBet(0, amount)
      .accountsStrict({
        bettor: bettor.publicKey, market, vault, position,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettor]).rpc();

    // second bet on UNDER from same bettor (init_if_needed reuses the position)
    await program.methods
      .placeBet(1, new BN(LAMPORTS_PER_SOL / 2))
      .accountsStrict({
        bettor: bettor.publicKey, market, vault, position,
        systemProgram: SystemProgram.programId,
      })
      .signers([bettor]).rpc();

    const m = await program.account.market.fetch(market);
    assert.equal(m.bucketTotals[0].toNumber(), LAMPORTS_PER_SOL);
    assert.equal(m.bucketTotals[1].toNumber(), LAMPORTS_PER_SOL / 2);
    assert.equal(m.totalPool.toNumber(), LAMPORTS_PER_SOL * 1.5);

    const p = await program.account.position.fetch(position);
    assert.ok(p.bettor.equals(bettor.publicKey));
    assert.equal(p.amounts[0].toNumber(), LAMPORTS_PER_SOL);
    assert.equal(p.amounts[1].toNumber(), LAMPORTS_PER_SOL / 2);

    const vaultAfter = await balance(vault);
    assert.equal(vaultAfter - vaultBefore, LAMPORTS_PER_SOL * 1.5);
  });

  it("rejects amount = 0", async () => {
    const { market, vault } = await initMarket(2002, 0, nowSec() + 3600);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    await expectError(
      program.methods.placeBet(0, new BN(0))
        .accountsStrict({
          bettor: bettor.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([bettor]).rpc(),
      "ZeroAmount",
    );
  });

  it("rejects an invalid bucket", async () => {
    const { market, vault } = await initMarket(2003, 0, nowSec() + 3600);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    await expectError(
      program.methods.placeBet(2, new BN(LAMPORTS_PER_SOL))
        .accountsStrict({
          bettor: bettor.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([bettor]).rpc(),
      "InvalidBucket",
    );
  });

  it("rejects bets at/after entry_close_ts", async () => {
    const { market, vault } = await initMarket(2004, 0, nowSec() + 2);
    const bettor = await freshFunded();
    const position = positionPda(market, bettor.publicKey);
    await sleep(3500);
    await expectError(
      program.methods.placeBet(0, new BN(LAMPORTS_PER_SOL))
        .accountsStrict({
          bettor: bettor.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([bettor]).rpc(),
      "EntryClosed",
    );
  });
});
