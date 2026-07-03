import {
  program, freshFunded, SystemProgram, assert, balance, Keypair,
  BN, nowSec, sleep, LAMPORTS_PER_SOL, connection,
} from "./helpers";
import {
  ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  makeSettledResultMarket, MAX_LEGS, legLockArray,
} from "./contest_helpers";

// Phase 1: lift the per-card leg cap 5 → 6 so the daily card holds exactly 6 legs.
// This exercises the FULL 6-leg lifecycle through the N-leg-generic instructions
// (create_contest → enter → settle each leg market → settle_contest → claim_contest)
// to prove nothing was hardcoded to 5 anywhere on the hot path.

async function contestRentFloor(contest: any): Promise<number> {
  const info = await connection.getAccountInfo(contest);
  return connection.getMinimumBalanceForRentExemption(info!.data.length);
}

describe("parlay v2 — 6-leg lifecycle (cap raised to 6)", () => {
  it("create(num_legs=6) → perfect + imperfect enter → settle 6 markets → claim: perfect sweeps, imperfect gets nothing", async () => {
    assert.equal(MAX_LEGS, 6, "test fixture tracks the program's MAX_LEGS");

    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const winner = await freshFunded();
    const loser = await freshFunded();

    const contestId = 160601;
    const contest = contestPda(contestId);

    // Six distinct fixtures, each a 1X2 result market (market_id 12). The perfect
    // ticket nails all six buckets; the imperfect ticket misses exactly one leg.
    const fixtures = [160610, 160611, 160612, 160613, 160614, 160615];
    const results = [0, 1, 2, 0, 1, 2];
    const perfectPicks = [0, 1, 2, 0, 1, 2];
    const imperfectPicks = [0, 1, 2, 0, 1, 0]; // leg 5 wrong (picked 0, result 2)
    assert.equal(fixtures.length, 6);

    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId),
        fixtureArray(fixtures),
        marketIdArray(fixtures.map(() => 12)),
        6,
        new BN(1 * LAMPORTS_PER_SOL),
        new BN(lock),
        new BN(lock + 6),
        keeper.publicKey,
        500,
        legLockArray(lock, 6),
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const created = await program.account.contest.fetch(contest);
    assert.equal(created.numLegs, 6, "contest carries 6 legs");
    assert.deepEqual(
      created.fixtures.map((x: any) => x.toNumber()),
      fixtures,
      "all 6 fixtures stored (no tail zero — array is exactly MAX_LEGS wide)",
    );

    // Enter a PERFECT ticket and an IMPERFECT ticket (each one paid entry).
    await program.methods.enter(new BN(0), pickArray(perfectPicks))
      .accountsStrict({ bettor: winner.publicKey, contest, entry: entryPda(contest, winner.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    await program.methods.enter(new BN(0), pickArray(imperfectPicks))
      .accountsStrict({ bettor: loser.publicKey, contest, entry: entryPda(contest, loser.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([loser]).rpc();
    assert.equal((await program.account.contest.fetch(contest)).entryCount.toNumber(), 2, "two tickets escrowed");

    // Settle all SIX leg result markets to their winning buckets (keeper is the oracle).
    const markets = [];
    for (let i = 0; i < 6; i++) {
      markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    }

    await sleep(6500); // pass settle_after_ts
    // perfect_count = 1 (only the winner is perfect) → winner sweeps the whole distributable.
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const settled = await program.account.contest.fetch(contest);
    assert.deepEqual(settled.status, { settled: {} }, "6-leg contest settles");
    assert.deepEqual(settled.winningBuckets, [0, 1, 2, 0, 1, 2], "all 6 winning buckets recorded leg-for-leg");
    const distributable = settled.distributable.toNumber(); // 0.95 * 2 SOL, perfect_count 1

    // PERFECT ticket claims — sweeps the full distributable out of the Contest PDA.
    const cBeforeWin = await balance(contest);
    await program.methods.claimContest()
      .accountsStrict({ bettor: winner.publicKey, contest, entry: entryPda(contest, winner.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    assert.equal(cBeforeWin - (await balance(contest)), distributable, "perfect ticket receives the full split");
    const afterWin = await program.account.contest.fetch(contest);
    assert.equal(afterWin.claimedCount.toNumber(), 1, "claimed_count advanced");
    assert.equal(afterWin.claimedTotal.toNumber(), distributable, "claimed_total advanced");

    // IMPERFECT ticket claims — pays nothing; the Contest balance does not move.
    const cBeforeLose = await balance(contest);
    await program.methods.claimContest()
      .accountsStrict({ bettor: loser.publicKey, contest, entry: entryPda(contest, loser.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([loser]).rpc();
    assert.equal(await balance(contest), cBeforeLose, "imperfect ticket draws nothing from the contest");
    const loserEntry = await connection.getAccountInfo(entryPda(contest, loser.publicKey, 0));
    assert.isNull(loserEntry, "imperfect entry closed (rent reclaimed), no payout");

    // After the lone winner claims, the Contest PDA is back at exactly its rent floor.
    const floor = await contestRentFloor(contest);
    assert.equal(await balance(contest), floor, "contest holds exactly its rent floor once the winner has claimed");
  });
});
