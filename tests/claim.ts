import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  expectError, nowSec, sleep, balance,
  BN, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

// Entry window for bet-then-settle tests. Bettors are funded BEFORE the market
// is initialized so airdrop latency never falls inside the window (which would
// flakily trip placeBet's EntryClosed guard). WAIT_MS sleeps past the window.
const WINDOW_SEC = 5;
const WAIT_MS = 6000;

async function setup(fixtureId: number, closeInSec = WINDOW_SEC) {
  const creator = await freshFunded();
  const settleAuth = await freshFunded();
  const market = marketPda(fixtureId, 0);
  const vault = vaultPda(market);
  await program.methods
    .initializeMarket(new BN(fixtureId), 0, goalsArgs({
      settleAuthority: settleAuth.publicKey, threshold: 2, entryCloseTs: nowSec() + closeInSec,
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

function claim(market: any, vault: any, bettor: any) {
  const position = positionPda(market, bettor.publicKey);
  return program.methods.claim()
    .accountsStrict({
      bettor: bettor.publicKey, market, vault, position,
      systemProgram: SystemProgram.programId,
    })
    .signers([bettor]).rpc();
}

describe("claim", () => {
  it("pays a winner pro-rata (principal-safe) via vault debit", async () => {
    const a = await freshFunded(); const b = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setup(5001);
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL); // OVER (winner)
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL); // UNDER (loser)
    await sleep(WAIT_MS);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();

    const vaultBefore = await balance(vault);
    await claim(market, vault, a);
    const vaultAfter = await balance(vault);

    // distributable = total(4) - fee(0) = 4; payout = stake(3) * 4 / winner_total(3) = 4 SOL
    const payout = vaultBefore - vaultAfter;
    assert.equal(payout, 4 * LAMPORTS_PER_SOL);
    assert.isAtLeast(payout, 3 * LAMPORTS_PER_SOL); // principal-safe

    // position is closed
    await expectError(program.account.position.fetch(positionPda(market, a.publicKey)), "Account does not exist");
  });

  it("lets a loser claim 0 and still closes the position (reclaims rent)", async () => {
    const a = await freshFunded(); const b = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setup(5002);
    await bet(market, vault, a, 0, 3 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(WAIT_MS);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();

    const vaultBefore = await balance(vault);
    await claim(market, vault, b); // loser
    const vaultAfter = await balance(vault);
    assert.equal(vaultBefore - vaultAfter, 0); // no payout from vault
    await expectError(program.account.position.fetch(positionPda(market, b.publicKey)), "Account does not exist");
  });

  it("refunds principal on a voided market", async () => {
    const a = await freshFunded();
    const { settleAuth, market, vault } = await setup(5003);
    await bet(market, vault, a, 0, 1 * LAMPORTS_PER_SOL);
    await bet(market, vault, a, 1, 1 * LAMPORTS_PER_SOL); // same bettor, both buckets
    await program.methods.voidMarket(1, new BN(1))
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market })
      .signers([settleAuth]).rpc();

    const vaultBefore = await balance(vault);
    const bettorBefore = await balance(a.publicKey);
    await claim(market, vault, a);
    const vaultAfter = await balance(vault);
    const bettorAfter = await balance(a.publicKey);
    assert.equal(vaultBefore - vaultAfter, 2 * LAMPORTS_PER_SOL); // full refund out of vault
    // bettor actually receives it (refund + reclaimed position rent, less tx fee)
    assert.isAtLeast(bettorAfter - bettorBefore, 2 * LAMPORTS_PER_SOL);
  });

  it("rejects a double claim", async () => {
    const a = await freshFunded(); const b = await freshFunded();
    const { settleAuth, market, vault, feeRecipient } = await setup(5004);
    await bet(market, vault, a, 0, 2 * LAMPORTS_PER_SOL);
    await bet(market, vault, b, 1, 1 * LAMPORTS_PER_SOL);
    await sleep(WAIT_MS);
    await program.methods.settle(0, 1, new BN(1), 5)
      .accountsStrict({ settleAuthority: settleAuth.publicKey, market, vault, feeRecipient })
      .signers([settleAuth]).rpc();
    await claim(market, vault, a);
    await expectError(claim(market, vault, a), "AccountNotInitialized");
  });

  it("rejects a claim before settle", async () => {
    const a = await freshFunded();
    const { market, vault } = await setup(5005, 3600);
    await bet(market, vault, a, 0, LAMPORTS_PER_SOL);
    await expectError(claim(market, vault, a), "NotClaimable");
  });
});
