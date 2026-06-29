import {
  program, freshFunded, SystemProgram, assert, balance,
  BN, nowSec, LAMPORTS_PER_SOL,
} from "./helpers";
import { jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray } from "./contest_helpers";

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

describe("daily sweepstake — void_contest", () => {
  it("voids an abandoned card and refunds each ticket its stake", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 70001;
    const contest = contestPda(contestId);
    const lock = nowSec() + 4;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray([70010, 70011, 70012]), 3,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();

    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { voided: {} });
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), 0);

    // Refund: claim_contest on a Voided contest returns entry.amount (+ rent).
    const before = await balance(player.publicKey);
    await program.methods.claimContest()
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    const gained = (await balance(player.publicKey)) - before;
    assert.isAtLeast(gained, 1 * LAMPORTS_PER_SOL, "stake refunded");
  });
});
