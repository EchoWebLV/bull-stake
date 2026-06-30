import {
  program, freshFunded, SystemProgram, assert, expectError, balance, connection,
} from "./helpers";
import { jackpotPda } from "./contest_helpers";

// Task 2: initialize_jackpot (replaces initialize_vault). The jackpot is a global
// singleton across the whole validator run; test files run alphabetically, so
// another suite may have created it first — assert existence, not first-creation.

describe("parlay v2 — initialize_jackpot", () => {
  it("creates the singleton jackpot PDA with a bump and only its rent floor", async () => {
    const keeper = await freshFunded();
    const jackpot = jackpotPda();
    let createdHere = false;
    try {
      await program.methods.initializeJackpot()
        .accountsStrict({ keeper: keeper.publicKey, jackpot, systemProgram: SystemProgram.programId })
        .signers([keeper]).rpc();
      createdHere = true;
    } catch (_) { /* already initialized by an earlier suite */ }

    const j = await program.account.jackpot.fetch(jackpot);
    assert.isNumber(j.bump, "bump is set");
    assert.isAbove(j.bump, 0, "bump is a real PDA bump");

    if (createdHere) {
      // A freshly created jackpot holds exactly its rent floor → empty rolling pool.
      const acctInfo = await connection.getAccountInfo(jackpot);
      const rentFloor = await connection.getMinimumBalanceForRentExemption(acctInfo!.data.length);
      assert.equal(await balance(jackpot), rentFloor, "fresh jackpot holds exactly its rent floor");
    }

    // Singleton guarantee, order-independent: a duplicate init always fails.
    const keeper2 = await freshFunded();
    await expectError(
      program.methods.initializeJackpot()
        .accountsStrict({ keeper: keeper2.publicKey, jackpot, systemProgram: SystemProgram.programId })
        .signers([keeper2]).rpc(),
      "already in use",
    );
  });
});
