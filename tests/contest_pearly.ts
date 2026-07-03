import {
  program, freshFunded, SystemProgram, assert, balance, BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  legLockArray, makeSettledResultMarket,
} from "./contest_helpers";

// The Pearly's core on-chain mechanic: per-leg locks + entry_ts. An entry placed
// AFTER a leg has locked is still accepted (until entries_close_ts) and its
// active mask/weight shrinks accordingly (asserted end-to-end in Task 5's test).
describe("pearly — rolling entry", () => {
  it("accepts an entry after the first leg locks but before entries_close_ts; rejects after", async () => {
    await ensureJackpot();
    const keeper = await freshFunded();
    const early = await freshFunded();
    const late = await freshFunded();

    const contestId = 770001;
    const contest = contestPda(contestId);
    const fixtures = [770010, 770011, 770012, 770013, 770014, 770015];
    const t0 = nowSec();
    // Staggered kickoffs: legs lock at +4, +6, +8, +10, +12, +14s.
    // entries_close = 4th smallest (6 - MIN_OPEN_LEGS(3) = index 3) = t0+10.
    const locks = [t0 + 4, t0 + 6, t0 + 8, t0 + 10, t0 + 12, t0 + 14];
    const legLocks = locks.map((l) => new BN(l)); // exactly MAX_LEGS wide

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(0.1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 60),
        keeper.publicKey, 0, legLocks,
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const created = await program.account.contest.fetch(contest);
    assert.equal(created.entriesCloseTs.toNumber(), locks[3], "entries close at the 4th-smallest leg lock");

    // Early entry (all 6 legs open).
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: early.publicKey, contest, entry: entryPda(contest, early.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([early]).rpc();
    const e1 = await program.account.entry.fetch(entryPda(contest, early.publicKey, 0));
    assert.isAtLeast(e1.entryTs.toNumber(), t0, "entry_ts stamped");

    // Late entry: after leg 0 locks (t0+4) but before entries_close (t0+10).
    await sleep(5000);
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([late]).rpc();
    const e2 = await program.account.entry.fetch(entryPda(contest, late.publicKey, 0));
    assert.isAbove(e2.entryTs.toNumber(), locks[0], "late entry stamped after leg 0 locked");

    // After entries_close_ts every enter is rejected.
    await sleep(6000); // now > t0+11 > entries_close (t0+10)
    let rejected = false;
    try {
      await program.methods.enter(new BN(1), pickArray([0, 0, 0, 0, 0, 0]))
        .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 1), systemProgram: SystemProgram.programId })
        .signers([late]).rpc();
    } catch { rejected = true; }
    assert.isTrue(rejected, "enter after entries_close_ts rejected");
  });
});
