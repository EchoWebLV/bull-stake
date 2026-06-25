import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, sleep, balance, airdrop,
  BN, Keypair, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

// Entry window (seconds) for tests that bet then settle. Must comfortably
// exceed the time to place the in-window bets; bettors are funded BEFORE
// `setup` so no airdrop latency falls inside the window. WAIT_MS sleeps past it.
const WINDOW_SEC = 5;
const WAIT_MS = 6000;

async function setup(fixtureId: number, opts: {
  feeBps?: number; feeRecipient?: Keypair | null; closeInSec?: number;
} = {}) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  const closeTs = nowSec() + (opts.closeInSec ?? WINDOW_SEC);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, goalsArgs({
      settleAuthority: settleAuth.publicKey,
      threshold: 2,
      entryCloseTs: closeTs,
      feeBps: opts.feeBps ?? 0,
      feeRecipient: opts.feeRecipient ? opts.feeRecipient.publicKey : null,
    }))
    .accountsStrict({
      creator: creator.publicKey, market, vault,
      systemProgram: SystemProgram.programId,
    })
    .signers([creator]).rpc();
  return { creator, settleAuth, market, vault, feeRecipient: creator.publicKey };
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

describe("settle", () => {
  it("settles to the winning bucket and records proof-binding", async () => {
    const a = await freshFunded(); const b = await freshFunded(); // fund before the window opens
    const { settleAuth, market, vault, feeRecipient } = await setup(3001);
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(WAIT_MS);

    await program.methods
      .settle(0, 951, new BN(1700000000000), 5)
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault, feeRecipient,
      })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { settled: {} });
    assert.equal(m.winningBucket, 0);
    assert.equal(m.settledSeq, 951);
    assert.equal(m.settledTs.toString(), "1700000000000");
    assert.equal(m.settledValue, 5);
    assert.equal(m.feeCollected.toNumber(), 0);
  });

  it("skims fee from the losing pool to fee_recipient", async () => {
    const feeKp = Keypair.generate();
    await airdrop(feeKp.publicKey, 1);
    const a = await freshFunded(); const b = await freshFunded();
    const { settleAuth, market, vault } = await setup(3002, { feeBps: 100, feeRecipient: feeKp });
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL); // winner pool
    await bet(market, vault, b, 1, 2 * LAMPORTS_PER_SOL); // loser pool
    await sleep(WAIT_MS);

    const feeBefore = await balance(feeKp.publicKey);
    const vaultBefore = await balance(vault);
    await program.methods
      .settle(0, 10, new BN(123), 4)
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault,
        feeRecipient: feeKp.publicKey,
      })
      .signers([settleAuth]).rpc();
    const feeAfter = await balance(feeKp.publicKey);
    const vaultAfter = await balance(vault);

    const expectedFee = Math.floor((2 * LAMPORTS_PER_SOL * 100) / 10000); // 1% of loser pool
    assert.equal(feeAfter - feeBefore, expectedFee, "recipient gained exactly the fee");
    // Conservation: the fee came OUT of the vault, not minted from nothing.
    assert.equal(vaultBefore - vaultAfter, expectedFee, "vault decreased by exactly the fee");
    const m = await program.account.market.fetch(market);
    assert.equal(m.feeCollected.toNumber(), expectedFee);
  });

  it("voids when the winning bucket has no stake", async () => {
    const a = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setup(3003);
    await bet(market, vault, a, 1, 2 * LAMPORTS_PER_SOL); // only UNDER has stake
    await sleep(WAIT_MS);

    await program.methods
      .settle(0, 5, new BN(1), 1) // declare OVER the winner — but OVER has 0 stake
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault, feeRecipient,
      })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { voided: {} });
    assert.isNull(m.winningBucket);
    // proof-binding must be recorded on the void path too
    assert.equal(m.settledSeq, 5);
    assert.equal(m.settledTs.toString(), "1");
    assert.equal(m.settledValue, 1);
    assert.equal(m.feeCollected.toNumber(), 0);
  });

  it("rejects re-settling an already-settled market", async () => {
    const a = await freshFunded(); const b = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setup(3006);
    await bet(market, vault, a, 0, 2 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(WAIT_MS);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();
    // second settle must be rejected — market is no longer Open
    await expectError(
      program.methods.settle(1, 2, new BN(2), 6)
        .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
        .signers([settleAuth]).rpc(),
      "MarketNotOpen",
    );
  });

  it("rejects settle by a non-authority", async () => {
    const a = await freshFunded();
    const { market, vault, feeRecipient } = await setup(3004);
    await bet(market, vault, a, 0, LAMPORTS_PER_SOL);
    await sleep(WAIT_MS);
    const imposter = await freshFunded();
    await expectError(
      program.methods.settle(0, 1, new BN(1), 1)
        .accountsStrict({
          settleAuthority: imposter.publicKey, market, vault, feeRecipient,
        })
        .signers([imposter]).rpc(),
      "Unauthorized",
    );
  });

  it("rejects settle before entry close", async () => {
    const a = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setup(3005, { closeInSec: 3600 });
    await bet(market, vault, a, 0, LAMPORTS_PER_SOL);
    await expectError(
      program.methods.settle(0, 1, new BN(1), 1)
        .accountsStrict({
          settleAuthority: settleAuth.publicKey, market, vault, feeRecipient,
        })
        .signers([settleAuth]).rpc(),
      "EntryNotClosed",
    );
  });
});
