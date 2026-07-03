import {
  program, freshFunded, SystemProgram, assert, expectError,
  BN, nowSec,
} from "./helpers";
import { contestPda, fixtureArray, marketIdArray } from "./contest_helpers";

// Task 3: create_contest v2 — concurrent (no JackpotVault, no one-live guard),
// per-contest pot held by the Contest PDA, per-leg market_ids.

describe("parlay v2 — create_contest", () => {
  it("creates an Open parlay with per-leg market_ids and fixtures", async () => {
    const keeper = await freshFunded();
    const contestId = 130001;
    const contest = contestPda(contestId);
    const F = 130010;
    const lock = nowSec() + 30;
    await program.methods
      .createContest(
        new BN(contestId),
        fixtureArray([F, F, F, F]),
        marketIdArray([16, 15, 12, 11]),
        4,
        new BN(20_000_000),
        new BN(lock),
        new BN(lock + 30),
        keeper.publicKey,
        500,
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { open: {} });
    assert.equal(c.numLegs, 4);
    assert.equal(c.entryPrice.toNumber(), 20_000_000);
    assert.deepEqual(c.marketIds, [16, 15, 12, 11, 0, 0], "per-leg market_ids stored with tail zero");
    assert.deepEqual(c.fixtures.map((x: any) => x.toNumber()), [F, F, F, F, 0, 0]);
    assert.ok(c.settleAuthority.equals(keeper.publicKey));
    assert.equal(c.distributable.toNumber(), 0);
  });

  it("allows a SECOND concurrent contest while the first is still Open", async () => {
    const keeper = await freshFunded();
    const lock = nowSec() + 30;
    // First contest, left Open.
    const id1 = 130002;
    const c1 = contestPda(id1);
    await program.methods
      .createContest(new BN(id1), fixtureArray([1300201, 1300202, 1300203]), marketIdArray([12, 12, 12]), 3,
        new BN(10_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest: c1, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    // Second contest with a DIFFERENT id succeeds while the first is Open (no ContestStillLive).
    const id2 = 130003;
    const c2 = contestPda(id2);
    await program.methods
      .createContest(new BN(id2), fixtureArray([1300301, 1300302, 1300303]), marketIdArray([12, 12, 12]), 3,
        new BN(10_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500)
      .accountsStrict({ keeper: keeper.publicKey, contest: c2, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    assert.deepEqual((await program.account.contest.fetch(c1)).status, { open: {} }, "first stays Open");
    assert.deepEqual((await program.account.contest.fetch(c2)).status, { open: {} }, "second also Open — concurrent");
  });

  it("rejects num_legs outside 3..=6", async () => {
    const keeper = await freshFunded();
    const contest = contestPda(130004);
    const lock = nowSec() + 30;
    await expectError(
      program.methods
        .createContest(new BN(130004), fixtureArray([1, 2]), marketIdArray([12, 12]), 2,
          new BN(20_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500)
        .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "InvalidMatchCount",
    );
  });

  it("rejects entry_price 0", async () => {
    const keeper = await freshFunded();
    const contest = contestPda(130005);
    const lock = nowSec() + 30;
    await expectError(
      program.methods
        .createContest(new BN(130005), fixtureArray([1, 2, 3]), marketIdArray([12, 12, 12]), 3,
          new BN(0), new BN(lock), new BN(lock + 30), keeper.publicKey, 500)
        .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "ZeroAmount",
    );
  });

  it("rejects lock_ts >= settle_after_ts", async () => {
    const keeper = await freshFunded();
    const contest = contestPda(130006);
    const lock = nowSec() + 30;
    await expectError(
      program.methods
        .createContest(new BN(130006), fixtureArray([1, 2, 3]), marketIdArray([12, 12, 12]), 3,
          new BN(20_000_000), new BN(lock), new BN(lock), keeper.publicKey, 500) // settle == lock
        .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "EntryCloseInPast",
    );
  });

  it("rejects a zero fixture within num_legs", async () => {
    const keeper = await freshFunded();
    const contest = contestPda(130007);
    const lock = nowSec() + 30;
    await expectError(
      program.methods
        .createContest(new BN(130007), fixtureArray([1, 0, 3]), marketIdArray([12, 12, 12]), 3,
          new BN(20_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500)
        .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "InvalidFixtureId",
    );
  });

  it("rejects a zero market_id within num_legs", async () => {
    const keeper = await freshFunded();
    const contest = contestPda(130008);
    const lock = nowSec() + 30;
    await expectError(
      program.methods
        .createContest(new BN(130008), fixtureArray([1, 2, 3]), marketIdArray([12, 0, 12]), 3,
          new BN(20_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500)
        .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "InvalidMarketId",
    );
  });
});
