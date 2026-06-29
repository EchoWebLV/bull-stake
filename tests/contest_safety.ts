import {
  program, freshFunded, SystemProgram, assert, expectError, balance,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray,
  makeSettledResultMarket, makeZeroWinnerResultMarket,
} from "./contest_helpers";

// NOTE: the JackpotVault is a GLOBAL singleton across the whole validator run, so
// `reserved` and the free pot accumulate across suites and across the tests in this
// file (e.g. the rollover test below intentionally leaves a carried pot). Every
// assertion here is therefore RELATIVE (before/after deltas) or an algebraic
// identity — never a hardcoded absolute vault/reserved value. Result markets are
// settled by the contest KEEPER (the v3.1 oracle binding requires
// result_market.settle_authority == contest.settle_authority).

async function ensureVault() {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  return vault;
}

describe("daily sweepstake — safety", () => {
  it("rejects a foreign/wrong result-market account at settle", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 80001;
    const contest = contestPda(contestId);
    const fixtures = [80010, 80011, 80012];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // Build markets for the WRONG fixtures (not on the card) — the PDA-derivation
    // check fires before anything else → ResultMarketMismatch.
    const wrong = [99910, 99911, 99912];
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(wrong[i], 0, keeper));
    await sleep(6500);
    await expectError(
      program.methods.settleContest(new BN(0))
        .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
        .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
        .signers([keeper]).rpc(),
      "ResultMarketMismatch",
    );
    // Clean up: void so the singleton vault frees for later runs.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
  });

  it("conserves funds: payout + rake + dust == pot_snapshot", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 80002;
    const contest = contestPda(contestId);
    const fixtures = [80020, 80021, 80022];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // 3 perfect tickets so the split may carry a remainder (dust).
    const players = [await freshFunded(), await freshFunded(), await freshFunded()];
    for (const p of players) {
      const e = entryPda(contest, p.publicKey, 0);
      await program.methods.enter(new BN(0), pickArray(results))
        .accountsStrict({ bettor: p.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    await sleep(6500);

    const vBeforeSettle = await balance(vault);
    await program.methods.settleContest(new BN(3))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const rake = vBeforeSettle - (await balance(vault)); // vault loses exactly the rake at settle

    const c = await program.account.contest.fetch(contest);
    const potSnapshot = c.potSnapshot.toNumber();
    const distributable = c.distributable.toNumber();
    const share = Math.floor(distributable / 3);

    let paid = 0;
    for (const p of players) {
      const before = await balance(vault);
      const e = entryPda(contest, p.publicKey, 0);
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
      paid += before - (await balance(vault));
    }
    const dust = distributable - paid;
    assert.equal(paid, share * 3, "each winner got floor(distributable/3)");
    assert.equal(rake + paid + dust, potSnapshot, "rake + payouts + dust == pot_snapshot");
    assert.isBelow(dust, 3, "dust < perfect_count lamports");
  });

  it("rollover continuity: next contest's pot carries the prior remainder", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();

    // Contest A: one losing ticket → rollover.
    const idA = 80003;
    const contestA = contestPda(idA);
    const fA = [80030, 80031, 80032];
    let lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idA), fixtureArray(fA), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: contestA, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const loser = await freshFunded();
    const eA = entryPda(contestA, loser.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([1, 1, 1]))
      .accountsStrict({ bettor: loser.publicKey, vault, contest: contestA, entry: eA, systemProgram: SystemProgram.programId })
      .signers([loser]).rpc();
    const mA = [];
    for (let i = 0; i < 3; i++) mA.push(await makeSettledResultMarket(fA[i], [0, 1, 2][i], keeper));
    await sleep(6500);
    await program.methods.settleContest(new BN(0))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: contestA, feeRecipient: keeper.publicKey })
      .remainingAccounts(mA.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const carried = await balance(vault); // includes the post-rake remainder of A
    // Contest B opens; create_contest moves no lamports, so the vault balance is unchanged.
    const idB = 80004;
    const contestB = contestPda(idB);
    lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idB), fixtureArray([80040, 80041, 80042]), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: contestB, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    assert.equal(await balance(vault), carried, "B starts from A's carried pot (rollover-for-free)");
    // Tidy up.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: contestB })
      .signers([keeper]).rpc();
  });

  it("cross-contest solvency: a prior contest's straggler is still paid after the next contest settles", async () => {
    // THE audit regression. Without the `reserved` fence, contest B's pot_snapshot
    // would double-count A's unclaimed winner share and A's straggler would revert
    // forever. All assertions are RELATIVE to a captured baseline because the vault
    // is a global singleton (prior suites + the rollover test above leave residue).
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const reservedBase = (await program.account.jackpotVault.fetch(vault)).reserved.toNumber();

    // Contest A: two perfect tickets (perfect_count = 2). Only ONE claims now.
    const idA = 80005;
    const cA = contestPda(idA);
    const fA = [80050, 80051, 80052];
    const resA = [0, 1, 2];
    let lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idA), fixtureArray(fA), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: cA, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const a1 = await freshFunded();
    const a2 = await freshFunded();
    for (const p of [a1, a2]) {
      await program.methods.enter(new BN(0), pickArray(resA))
        .accountsStrict({ bettor: p.publicKey, vault, contest: cA, entry: entryPda(cA, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const mA = [];
    for (let i = 0; i < 3; i++) mA.push(await makeSettledResultMarket(fA[i], resA[i], keeper));
    await sleep(6500);
    await program.methods.settleContest(new BN(2))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: cA, feeRecipient: keeper.publicKey })
      .remainingAccounts(mA.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const shareA = Math.floor((await program.account.contest.fetch(cA)).distributable.toNumber() / 2);

    // a1 claims; a2 is the STRAGGLER (does not claim yet). reserved holds a2's share.
    const a1VBefore = await balance(vault);
    await program.methods.claimContest()
      .accountsStrict({ bettor: a1.publicKey, vault, contest: cA, entry: entryPda(cA, a1.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([a1]).rpc();
    assert.equal(a1VBefore - (await balance(vault)), shareA, "a1 paid its share from the vault");
    assert.equal(
      (await program.account.jackpotVault.fetch(vault)).reserved.toNumber() - reservedBase,
      shareA,
      "a2's share stays fenced in reserved",
    );

    // Contest B opens (active_contest_id == 0 after A settled), 2 perfect tickets, settles.
    const idB = 80006;
    const cB = contestPda(idB);
    const fB = [80060, 80061, 80062];
    const resB = [2, 0, 1];
    lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(idB), fixtureArray(fB), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest: cB, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const b1 = await freshFunded();
    const b2 = await freshFunded();
    for (const p of [b1, b2]) {
      await program.methods.enter(new BN(0), pickArray(resB))
        .accountsStrict({ bettor: p.publicKey, vault, contest: cB, entry: entryPda(cB, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }
    const mB = [];
    for (let i = 0; i < 3; i++) mB.push(await makeSettledResultMarket(fB[i], resB[i], keeper));
    await sleep(6500);
    await program.methods.settleContest(new BN(2))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest: cB, feeRecipient: keeper.publicKey })
      .remainingAccounts(mB.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    // B's winners both claim (drains B's own distributable).
    for (const p of [b1, b2]) {
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, vault, contest: cB, entry: entryPda(cB, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }

    // THE REGRESSION: A's straggler a2 claims LAST and MUST be paid its full share —
    // the reserved fence kept those lamports untouchable by B.
    const a2VBefore = await balance(vault);
    await program.methods.claimContest()
      .accountsStrict({ bettor: a2.publicKey, vault, contest: cA, entry: entryPda(cA, a2.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([a2]).rpc();
    assert.equal(a2VBefore - (await balance(vault)), shareA, "straggler a2 paid its full share — no cross-contest insolvency");
    assert.equal(
      (await program.account.jackpotVault.fetch(vault)).reserved.toNumber(),
      reservedBase,
      "all of A's and B's liabilities released back to baseline",
    );
  });

  it("settles a contest whose result leg is a zero-stake (voided-with-bucket) market", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 80007;
    const contest = contestPda(contestId);
    const fixtures = [80070, 80071, 80072];
    const results = [0, 1, 2];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(contestId), fixtureArray(fixtures), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const winner = await freshFunded();
    const e = entryPda(contest, winner.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray(results))
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    // Legs 0 & 1 settle normally; leg 2 is a ZERO-WINNER market → Voided WITH bucket.
    const markets = [
      await makeSettledResultMarket(fixtures[0], results[0], keeper),
      await makeSettledResultMarket(fixtures[1], results[1], keeper),
      await makeZeroWinnerResultMarket(fixtures[2], results[2], keeper),
    ];
    await sleep(6500);
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} }, "contest settles despite a zero-stake result leg");
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0], "winning bucket read from the voided-with-bucket market");
    const vBefore = await balance(vault);
    await program.methods.claimContest()
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();
    assert.isAbove(vBefore - (await balance(vault)), 0, "perfect ticket paid");
  });

  it("rejects void_contest by a non-keeper before the grace period (deny path of the permissionless backstop)", async () => {
    // The ALLOW-after-grace path (now > settle_after_ts + VOID_GRACE, 3 days) can't be
    // wall-clock tested on a local validator; it is reviewed in void_contest.rs. Here we
    // assert the deny path: a stranger cannot void early.
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 80008;
    const contest = contestPda(contestId);
    const lock = nowSec() + 5;
    await program.methods
      .createContest(new BN(contestId), fixtureArray([80080, 80081, 80082]), 3, new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const stranger = await freshFunded();
    await expectError(
      program.methods.voidContest()
        .accountsStrict({ settleAuthority: stranger.publicKey, vault, contest })
        .signers([stranger]).rpc(),
      "Unauthorized",
    );
    // Keeper can still void any time (teardown).
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
  });
});
