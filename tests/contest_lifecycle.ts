import {
  program, freshFunded, SystemProgram, assert, expectError,
} from "./helpers";
import { jackpotVaultPda } from "./contest_helpers";

describe("daily sweepstake — vault", () => {
  it("initializes the singleton jackpot vault once", async () => {
    const keeper = await freshFunded();
    const vault = jackpotVaultPda();
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), 0);
    assert.equal(v.reserved.toNumber(), 0);

    // Second init must fail — the singleton already exists.
    const keeper2 = await freshFunded();
    await expectError(
      program.methods.initializeVault()
        .accountsStrict({ keeper: keeper2.publicKey, vault, systemProgram: SystemProgram.programId })
        .signers([keeper2]).rpc(),
      "already in use",
    );
  });
});
