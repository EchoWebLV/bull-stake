import {
  program, marketPda, vaultPda, positionPda, freshFunded, resultArgs, goalsArgs,
  expectError, nowSec, sleep, balance,
  BN, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

const WINDOW_SEC = 5;
const WAIT_MS = 6000;

async function setupResult(fixtureId: number) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, resultArgs({
      settleAuthority: settleAuth.publicKey,
      entryCloseTs: nowSec() + WINDOW_SEC,
    }))
    .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
    .signers([creator]).rpc();
  return { creator, settleAuth, market, vault, feeRecipient: creator.publicKey };
}

async function bet(market: any, vault: any, bettor: any, bucket: number, lamports: number) {
  const position = positionPda(market, bettor.publicKey);
  await program.methods.placeBet(bucket, new BN(lamports))
    .accountsStrict({ bettor: bettor.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([bettor]).rpc();
}

async function claim(market: any, vault: any, bettor: any) {
  const position = positionPda(market, bettor.publicKey);
  await program.methods.claim()
    .accountsStrict({ bettor: bettor.publicKey, market, vault, position, systemProgram: SystemProgram.programId })
    .signers([bettor]).rpc();
}

describe("three-way (1X2) result market", () => {
  it("creates a 3-bucket market", async () => {
    const { market } = await setupResult(7001);
    const m = await program.account.market.fetch(market);
    assert.equal(m.numBuckets, 3);
    assert.equal(m.bucketTotals.length, 3);
    assert.deepEqual(m.bucketTotals.map((b: any) => b.toNumber()), [0, 0, 0]);
  });

  it("accepts bets on bucket 2 (away) and settles a three-way pool with conservation", async () => {
    // Fund before the entry window opens.
    const home = await freshFunded();
    const draw = await freshFunded();
    const away = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setupResult(7002);

    await bet(market, vault, home, 0, 1 * LAMPORTS_PER_SOL);
    await bet(market, vault, draw, 1, 1 * LAMPORTS_PER_SOL);
    await bet(market, vault, away, 2, 2 * LAMPORTS_PER_SOL); // bucket 2 — impossible before this change
    await sleep(WAIT_MS);

    const m0 = await program.account.market.fetch(market);
    assert.deepEqual(m0.bucketTotals.map((b: any) => b.toNumber() / LAMPORTS_PER_SOL), [1, 1, 2]);
    assert.equal(m0.totalPool.toNumber(), 4 * LAMPORTS_PER_SOL);

    // Away wins (goal diff < 0 → bucket 2). settled_value records the diff.
    await program.methods.settle(2, 42, new BN(1700000000000), -1)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();

    const m = await program.account.market.fetch(market);
    assert.deepEqual(m.status, { settled: {} });
    assert.equal(m.winningBucket, 2);
    assert.equal(m.settledValue, -1);

    // Losing backers (home, draw) collect nothing; the vault is untouched.
    const vBeforeLosers = await balance(vault);
    await claim(market, vault, home);
    await claim(market, vault, draw);
    assert.equal(await balance(vault), vBeforeLosers, "losing claims pay 0 from the vault");

    // The sole away backer collects the entire pool (stake 2 of a 4 pool → 2× = 4).
    const vBeforeWinner = await balance(vault);
    await claim(market, vault, away);
    const paid = vBeforeWinner - (await balance(vault));
    assert.equal(paid, 4 * LAMPORTS_PER_SOL, "away backer sweeps the whole pool");
  });

  it("rejects a bet on a bucket >= num_buckets", async () => {
    const bettor = await freshFunded();
    const { market, vault } = await setupResult(7003);
    await expectError(bet(market, vault, bettor, 3, LAMPORTS_PER_SOL), "InvalidBucket");
  });

  it("rejects num_buckets outside {2,3} at market creation", async () => {
    const creator = await freshFunded();
    const settleAuth = await freshFunded();
    const market = marketPda(7004, 0);
    const vault = vaultPda(market);
    await expectError(
      program.methods
        .initializeMarket(new BN(7004), 0, goalsArgs({
          settleAuthority: settleAuth.publicKey, threshold: 2, entryCloseTs: nowSec() + 3600, numBuckets: 4,
        }))
        .accountsStrict({ creator: creator.publicKey, market, vault, systemProgram: SystemProgram.programId })
        .signers([creator]).rpc(),
      "InvalidBucketCount",
    );
  });
});
