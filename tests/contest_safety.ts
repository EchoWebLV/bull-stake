import {
  program, freshFunded, SystemProgram, assert, expectError, balance, Keypair,
  BN, nowSec, sleep, LAMPORTS_PER_SOL, connection,
} from "./helpers";
import {
  jackpotPda, ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  makeSettledResultMarket, makeZeroWinnerResultMarket,
} from "./contest_helpers";

// Task 9 (NEXT subagent) expands this file. For Tasks 1–7 this is a MINIMAL v2
// update so the file compiles and passes against the v2 API: per-contest pots
// (the Contest PDA holds the entries), a singleton jackpot, per-leg market_ids.
// Conservation/cross-contest assertions are RELATIVE where the jackpot is shared.

async function contestRentFloor(contest: any): Promise<number> {
  const info = await connection.getAccountInfo(contest);
  return connection.getMinimumBalanceForRentExemption(info!.data.length);
}

describe("parlay v2 — safety", () => {
  it("rejects a foreign/wrong result-market account at settle", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const contest = contestPda(180001);
    const fixtures = [180010, 180011, 180012];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(180001), fixtureArray(fixtures), marketIdArray([12, 12, 12]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // Markets for the WRONG fixtures — the PDA-derivation check fires first.
    const wrong = [189910, 189911, 189912];
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(wrong[i], 0, keeper));
    await sleep(6500);
    await expectError(
      program.methods.settleContest(new BN(0))
        .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
        .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
        .signers([keeper]).rpc(),
      "ResultMarketMismatch",
    );
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
  });

  it("conserves funds: rake + payouts + dust == pot (per-contest)", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const contest = contestPda(180002);
    const fixtures = [180020, 180021, 180022];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(180002), fixtureArray(fixtures), marketIdArray([12, 12, 12]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // 3 perfect tickets so the split may carry a remainder (dust).
    const players = [await freshFunded(), await freshFunded(), await freshFunded()];
    for (const p of players) {
      await program.methods.enter(new BN(0), pickArray(results))
        .accountsStrict({ bettor: p.publicKey, contest, entry: entryPda(contest, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    await sleep(6500);

    const floor = await contestRentFloor(contest);
    const pot = (await balance(contest)) - floor; // 3 SOL of entries
    const jackBefore = await balance(jackpot);
    await program.methods.settleContest(new BN(3))
      .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const rake = 0.05 * 3 * LAMPORTS_PER_SOL;

    const c = await program.account.contest.fetch(contest);
    const distributable = c.distributable.toNumber();
    const share = Math.floor(distributable / 3);

    let paid = 0;
    for (const p of players) {
      const before = await balance(contest);
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, contest, entry: entryPda(contest, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
      paid += before - (await balance(contest));
    }
    // dust ended up in the jackpot (delta of the jackpot's balance net of jackpot_in/out).
    const jackDelta = (await balance(jackpot)) - jackBefore;
    assert.equal(paid, share * 3, "each winner got floor(distributable/3)");
    // Conservation: rake (out to fee) + payouts (out to winners) + jackpot delta == pot.
    assert.equal(rake + paid + jackDelta, pot, "rake + payouts + dust(to jackpot) == pot");
    assert.isBelow(jackDelta, 3, "dust < perfect_count lamports");
  });

  it("settles a contest whose result leg is a zero-stake (voided-with-bucket) market", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const contest = contestPda(180007);
    const fixtures = [180070, 180071, 180072];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(180007), fixtureArray(fixtures), marketIdArray([12, 12, 12]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const winner = await freshFunded();
    const e = entryPda(contest, winner.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray(results))
      .accountsStrict({ bettor: winner.publicKey, contest, entry: e, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    // Legs 0 & 1 settle normally; leg 2 is a ZERO-WINNER market → Voided WITH bucket.
    const markets = [
      await makeSettledResultMarket(fixtures[0], results[0], keeper),
      await makeSettledResultMarket(fixtures[1], results[1], keeper),
      await makeZeroWinnerResultMarket(fixtures[2], results[2], keeper),
    ];
    await sleep(6500);
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} }, "contest settles despite a zero-stake result leg");
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0], "winning bucket read from the voided-with-bucket market");
    const cBefore = await balance(contest);
    await program.methods.claimContest()
      .accountsStrict({ bettor: winner.publicKey, contest, entry: e, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    assert.isAbove(cBefore - (await balance(contest)), 0, "perfect ticket paid");
  });

  it("under-reported perfect_count: an extra perfect ticket reverts at the solvency cap (no over-draw)", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const contest = contestPda(180009);
    const fixtures = [180090, 180091, 180092];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(180009), fixtureArray(fixtures), marketIdArray([12, 12, 12]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const w1 = await freshFunded();
    const w2 = await freshFunded();
    for (const p of [w1, w2]) {
      await program.methods.enter(new BN(0), pickArray(results))
        .accountsStrict({ bettor: p.publicKey, contest, entry: entryPda(contest, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    await sleep(6500);
    // Under-report: declare only 1 winner though both are perfect.
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const distributable = (await program.account.contest.fetch(contest)).distributable.toNumber();

    const cBefore = await balance(contest);
    await program.methods.claimContest()
      .accountsStrict({ bettor: w1.publicKey, contest, entry: entryPda(contest, w1.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([w1]).rpc();
    assert.equal(cBefore - (await balance(contest)), distributable, "first winner sweeps the full distributable");

    await expectError(
      program.methods.claimContest()
        .accountsStrict({ bettor: w2.publicKey, contest, entry: entryPda(contest, w2.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([w2]).rpc(),
      "VaultInsolvent",
    );
  });

  it("rejects void_contest by a non-keeper before the grace period", async () => {
    const keeper = await freshFunded();
    const contest = contestPda(180008);
    const lock = nowSec() + 30;
    await program.methods
      .createContest(new BN(180008), fixtureArray([180080, 180081, 180082]), marketIdArray([12, 12, 12]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const stranger = await freshFunded();
    await expectError(
      program.methods.voidContest()
        .accountsStrict({ settleAuthority: stranger.publicKey, contest })
        .signers([stranger]).rpc(),
      "Unauthorized",
    );
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
  });

  it("per-contest isolation: draining one contest's pot leaves a concurrent contest's pot untouched", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const fixturesA = [181010, 181011, 181012];
    const fixturesB = [181020, 181021, 181022];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    // Two contests Open at once — no shared vault, no active-contest guard. Each
    // Contest PDA holds ONLY its own pot, so there is no cross-contest money path
    // at claim time (the jackpot is the only shared account, touched at settle only).
    const contestA = contestPda(181001);
    const contestB = contestPda(181002);
    for (const [id, contest, fixtures] of [[181001, contestA, fixturesA], [181002, contestB, fixturesB]] as const) {
      await program.methods
        .createContest(new BN(id), fixtureArray(fixtures), marketIdArray([12, 12, 12]), 3,
          new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
        .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();
    }
    // A: two perfect tickets; B: one perfect ticket.
    const a1 = await freshFunded();
    const a2 = await freshFunded();
    const b1 = await freshFunded();
    for (const p of [a1, a2]) {
      await program.methods.enter(new BN(0), pickArray(results))
        .accountsStrict({ bettor: p.publicKey, contest: contestA, entry: entryPda(contestA, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    await program.methods.enter(new BN(0), pickArray(results))
      .accountsStrict({ bettor: b1.publicKey, contest: contestB, entry: entryPda(contestB, b1.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([b1]).rpc();

    const marketsA = [];
    const marketsB = [];
    for (let i = 0; i < 3; i++) marketsA.push(await makeSettledResultMarket(fixturesA[i], results[i], keeper));
    for (let i = 0; i < 3; i++) marketsB.push(await makeSettledResultMarket(fixturesB[i], results[i], keeper));
    await sleep(6500);
    for (const [contest, markets, pc] of [[contestA, marketsA, 2], [contestB, marketsB, 1]] as const) {
      await program.methods.settleContest(new BN(pc))
        .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
        .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
        .signers([keeper]).rpc();
    }

    // Snapshot B's escrow BEFORE we drain A.
    const bBalanceBefore = await balance(contestB);
    const bDistributable = (await program.account.contest.fetch(contestB)).distributable.toNumber();

    // Fully drain A (both winners claim from A's own pot).
    for (const p of [a1, a2]) {
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, contest: contestA, entry: entryPda(contestA, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    assert.equal(await balance(contestA), await contestRentFloor(contestA), "A drained to its rent floor");
    // Isolation: B's escrow is byte-for-byte untouched while A is fully drained.
    assert.equal(await balance(contestB), bBalanceBefore, "B's pot is untouched by A's drainage (separate PDAs)");

    // And B's winner still sweeps B's full distributable from B's own pot.
    const bBefore = await balance(contestB);
    await program.methods.claimContest()
      .accountsStrict({ bettor: b1.publicKey, contest: contestB, entry: entryPda(contestB, b1.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([b1]).rpc();
    assert.equal(bBefore - (await balance(contestB)), bDistributable, "B's winner sweeps B's full distributable, unaffected by A");
  });
});
