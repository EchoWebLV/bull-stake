import {
  program, freshFunded, SystemProgram, assert, balance, Keypair,
  BN, nowSec, sleep, LAMPORTS_PER_SOL, connection,
} from "./helpers";
import {
  ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  makeSettledResultMarket,
} from "./contest_helpers";

// Task 8: jackpot rollover integration — two contests created OVERLAPPING (both
// Open before either settles) to prove concurrency on the shared jackpot PDA.
// A has no winner → its post-rake pot rolls INTO the jackpot; concurrent B has one
// winner → it scoops the whole rolling pool on top of its own net pot, leaving the
// jackpot drained (no dust, since perfect_count = 1 divides evenly). Lamport flow is
// asserted with RELATIVE deltas so a non-empty starting pool (from earlier suites
// sharing the singleton jackpot) does not affect the result.

async function rentFloor(acct: any): Promise<number> {
  const info = await connection.getAccountInfo(acct);
  return connection.getMinimumBalanceForRentExemption(info!.data.length);
}
async function jackpotPool(jackpot: any): Promise<number> {
  return (await balance(jackpot)) - (await rentFloor(jackpot));
}
async function createContest(id: number, keeper: Keypair, fixtures: number[], feeRecipient: any) {
  const contest = contestPda(id);
  const lock = nowSec() + 5;
  await program.methods
    .createContest(
      new BN(id), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)), fixtures.length,
      new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), feeRecipient, 500,
    )
    .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  return contest;
}
async function enter(contest: any, player: Keypair, nonce: number, picks: number[]) {
  await program.methods.enter(new BN(nonce), pickArray(picks))
    .accountsStrict({ bettor: player.publicKey, contest, entry: entryPda(contest, player.publicKey, nonce), systemProgram: SystemProgram.programId })
    .signers([player]).rpc();
}
async function settle(keeper: Keypair, jackpot: any, contest: any, feeRecipient: any, markets: any[], perfectCount: number) {
  await program.methods.settleContest(new BN(perfectCount))
    .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient })
    .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
    .signers([keeper]).rpc();
}

describe("parlay v2 — jackpot rollover (concurrent)", () => {
  it("A (no winner) rolls into the jackpot; concurrent B (1 winner) scoops the pool + its own pot; jackpot ends drained", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const feeA = Keypair.generate();
    const feeB = Keypair.generate();

    const fixturesA = [200010, 200011, 200012];
    const fixturesB = [200020, 200021, 200022];
    const resultsA = [0, 1, 2];
    const resultsB = [2, 0, 1];

    // ── create BOTH contests while both are Open (overlapping → proves concurrency) ──
    const contestA = await createContest(200001, keeper, fixturesA, feeA.publicKey);
    const contestB = await createContest(200002, keeper, fixturesB, feeB.publicKey);
    assert.deepEqual((await program.account.contest.fetch(contestA)).status, { open: {} }, "A Open");
    assert.deepEqual((await program.account.contest.fetch(contestB)).status, { open: {} }, "B Open while A is also Open");

    // A gets a (non-winning) ticket; settle with perfect_count = 0 forces rollover.
    const loserA = await freshFunded();
    await enter(contestA, loserA, 0, [1, 1, 1]);
    // B gets one perfect ticket.
    const winnerB = await freshFunded();
    await enter(contestB, winnerB, 0, resultsB);

    // Result markets for both fixtures (A reads its legs even on a rollover).
    const marketsA = [];
    for (let i = 0; i < 3; i++) marketsA.push(await makeSettledResultMarket(fixturesA[i], resultsA[i], keeper));
    const marketsB = [];
    for (let i = 0; i < 3; i++) marketsB.push(await makeSettledResultMarket(fixturesB[i], resultsB[i], keeper));
    await sleep(6500);

    const rake = 0.05 * LAMPORTS_PER_SOL;          // 5% of 1 SOL of entries (each contest)
    const net = 1 * LAMPORTS_PER_SOL - rake;        // 0.95 SOL net pot per contest

    // ── settle A first: ROLLOVER → A's net pot moves INTO the jackpot ──
    const poolBeforeA = await jackpotPool(jackpot);
    const feeABefore = await balance(feeA.publicKey);
    await settle(keeper, jackpot, contestA, feeA.publicKey, marketsA, 0);
    const a = await program.account.contest.fetch(contestA);
    assert.deepEqual(a.status, { rolledOver: {} }, "A rolled over");
    assert.equal(a.distributable.toNumber(), 0, "A distributable == 0");
    assert.equal((await balance(feeA.publicKey)) - feeABefore, rake, "A rake → feeA");
    assert.equal((await jackpotPool(jackpot)) - poolBeforeA, net, "A net pot rolled INTO the jackpot");
    assert.equal(await balance(contestA), await rentFloor(contestA), "A contest swept to its rent floor");

    // ── settle B (still Open): winner scoops the WHOLE rolling pool + B's net pot ──
    const poolBeforeB = await jackpotPool(jackpot); // == poolBeforeA + net
    const feeBBefore = await balance(feeB.publicKey);
    await settle(keeper, jackpot, contestB, feeB.publicKey, marketsB, 1);
    const b = await program.account.contest.fetch(contestB);
    assert.deepEqual(b.status, { settled: {} }, "B settled");
    assert.equal((await balance(feeB.publicKey)) - feeBBefore, rake, "B rake → feeB");
    assert.equal(b.distributable.toNumber(), net + poolBeforeB, "B distributable == own net pot + scooped jackpot pool");
    assert.equal(await jackpotPool(jackpot), 0, "jackpot drained to 0 (perfect_count=1 → no dust)");
    assert.equal(
      await balance(contestB),
      (await rentFloor(contestB)) + b.distributable.toNumber(),
      "B holds floor + distributable",
    );

    // ── the sole winner claims B's full share; B ends at its rent floor ──
    const wBefore = await balance(winnerB.publicKey);
    await program.methods.claimContest()
      .accountsStrict({ bettor: winnerB.publicKey, contest: contestB, entry: entryPda(contestB, winnerB.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([winnerB]).rpc();
    assert.equal(await balance(contestB), await rentFloor(contestB), "B swept to rent floor after the sole winner claims");
    assert.isAbove((await balance(winnerB.publicKey)) - wBefore, 0, "winner received the payout (net of tx fee)");

    // loser A reclaims rent (payout 0 on a RolledOver contest) and closes the entry.
    const lBefore = await balance(contestA);
    await program.methods.claimContest()
      .accountsStrict({ bettor: loserA.publicKey, contest: contestA, entry: entryPda(contestA, loserA.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([loserA]).rpc();
    assert.equal(await balance(contestA), lBefore, "RolledOver claim moves no lamports out of the contest");
  });
});
