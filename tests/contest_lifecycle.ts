import {
  program, freshFunded, SystemProgram, assert, expectError,
  BN, nowSec,
} from "./helpers";
import { jackpotVaultPda, contestPda, fixtureArray } from "./contest_helpers";

describe("daily sweepstake — vault", () => {
  it("initializes the singleton jackpot vault once", async () => {
    // The vault is one global PDA shared across the whole validator run, and test
    // files run in alphabetical order — another suite (e.g. contest_enter) may have
    // initialized it first. So ensure it exists rather than assuming we're first.
    const keeper = await freshFunded();
    const vault = jackpotVaultPda();
    let createdHere = false;
    try {
      await program.methods.initializeVault()
        .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();
      createdHere = true;
    } catch (_) { /* already initialized by an earlier suite */ }

    // Fresh-init values are only guaranteed when THIS test created the vault
    // (reserved accumulates globally once other suites settle/void).
    if (createdHere) {
      const v = await program.account.jackpotVault.fetch(vault);
      assert.equal(v.activeContestId.toNumber(), 0);
      assert.equal(v.reserved.toNumber(), 0);
    }

    // The singleton guarantee, order-independent: a duplicate init always fails.
    const keeper2 = await freshFunded();
    await expectError(
      program.methods.initializeVault()
        .accountsStrict({ keeper: keeper2.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper2]).rpc(),
      "already in use",
    );
  });
});

describe("daily sweepstake — create_contest", () => {
  async function freshVault() {
    // The vault is a singleton; init once per validator run. Ignore "already in use".
    const keeper = await freshFunded();
    const vault = jackpotVaultPda();
    try {
      await program.methods.initializeVault()
        .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();
    } catch (_) { /* already initialized by an earlier test */ }
    return { keeper, vault };
  }

  it("creates an Open contest and marks the vault active", async () => {
    const { keeper, vault } = await freshVault();
    const contestId = 30001;
    const contest = contestPda(contestId);
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray([8001, 8002, 8003, 8004]), 4,
        new BN(20_000_000), new BN(lock), new BN(lock + 10), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { open: {} });
    assert.equal(c.numMatches, 4);
    assert.equal(c.entryPrice.toNumber(), 20_000_000);
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), contestId);

    // Teardown: void to free the singleton vault for later tests/files.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
    assert.equal((await program.account.jackpotVault.fetch(vault)).activeContestId.toNumber(), 0);
  });

  it("rejects num_matches outside 3..=5", async () => {
    const { keeper, vault } = await freshVault();
    // Vault may already be active from the previous test; use a distinct id and
    // expect the match-count check to fire before/independently — run on a clean
    // vault by voiding is out of scope here, so assert the validation error code.
    const contest = contestPda(30002);
    const lock = nowSec() + 5;
    await expectError(
      program.methods
        .createContest(
          new BN(30002), fixtureArray([8001, 8002]), 2,
          new BN(20_000_000), new BN(lock), new BN(lock + 10), keeper.publicKey, 500,
        )
        .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc(),
      "InvalidMatchCount",
    );
  });
});
