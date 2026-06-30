import {
  program, freshFunded, SystemProgram, assert, expectError, balance,
  BN, nowSec, sleep,
} from "./helpers";
import { contestPda, entryPda, fixtureArray, marketIdArray, pickArray } from "./contest_helpers";

// Task 4: enter v2 — deposits straight into the Contest PDA (no JackpotVault).

async function openContest(contestId: number, lockInSec = 6) {
  const keeper = await freshFunded();
  const contest = contestPda(contestId);
  const lock = nowSec() + lockInSec;
  await program.methods
    .createContest(
      new BN(contestId), fixtureArray([9001, 9002, 9003, 9004]), marketIdArray([12, 12, 12, 12]), 4,
      new BN(20_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500,
    )
    .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  return { keeper, contest };
}

describe("parlay v2 — enter", () => {
  it("escrows one ticket into the Contest PDA and edits picks without re-charging", async () => {
    const { contest } = await openContest(140001);
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);

    const cBefore = await balance(contest);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: player.publicKey, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(contest) - cBefore, 20_000_000, "one ticket escrowed into the contest");
    let c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 1);

    const eInit = await program.account.entry.fetch(entry0);
    assert.equal(eInit.amount.toNumber(), 20_000_000, "entry.amount = entry_price at init");
    assert.equal(eInit.nonce.toNumber(), 0, "entry.nonce set");
    assert.ok(eInit.bettor.equals(player.publicKey), "entry.bettor set");
    assert.ok(eInit.contest.equals(contest), "entry.contest set");
    assert.deepEqual(eInit.picks, [0, 1, 2, 0, 0], "entry.picks set with tail zero");

    // Edit the SAME nonce before lock — no second charge, no entry_count change.
    const cAfterFirst = await balance(contest);
    await program.methods.enter(new BN(0), pickArray([2, 2, 2, 2]))
      .accountsStrict({ bettor: player.publicKey, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(contest), cAfterFirst, "edit does not re-charge");
    c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 1, "edit does not increment entry_count");
    const e = await program.account.entry.fetch(entry0);
    assert.deepEqual(e.picks, [2, 2, 2, 2, 0]);
  });

  it("a second nonce is a second ticket and a second charge", async () => {
    const { contest } = await openContest(140002);
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    const entry1 = entryPda(contest, player.publicKey, 1);
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0]))
      .accountsStrict({ bettor: player.publicKey, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    const cMid = await balance(contest);
    await program.methods.enter(new BN(1), pickArray([1, 1, 1, 1]))
      .accountsStrict({ bettor: player.publicKey, contest, entry: entry1, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(contest) - cMid, 20_000_000, "second ticket charged into the contest");
    const c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 2);
  });

  it("rejects entry after lock and rejects an out-of-range pick", async () => {
    const { contest } = await openContest(140003, 4);
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    await expectError(
      program.methods.enter(new BN(0), pickArray([3, 0, 0, 0]))
        .accountsStrict({ bettor: player.publicKey, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "InvalidPick",
    );
    await sleep(4500); // pass lock_ts
    await expectError(
      program.methods.enter(new BN(0), pickArray([0, 0, 0, 0]))
        .accountsStrict({ bettor: player.publicKey, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "EntryClosed",
    );
  });

  it("rejects a non-zero pick in the tail beyond num_legs", async () => {
    const { contest } = await openContest(140004);
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    // num_legs == 4, so index 4 must be 0.
    await expectError(
      program.methods.enter(new BN(0), [0, 0, 0, 0, 1])
        .accountsStrict({ bettor: player.publicKey, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "InvalidPick",
    );
  });
});
