import {
  program, freshFunded, SystemProgram, assert, balance, Keypair, expectError,
  BN, nowSec, LAMPORTS_PER_SOL, connection,
} from "./helpers";
import { contestPda, entryPda, fixtureArray, marketIdArray, pickArray, legLockArray } from "./contest_helpers";

// Task 7: void_contest v2 — status transition only; refunds flow through
// claim_contest's Voided branch, paid from the Contest PDA.

async function contestRentFloor(contest: any): Promise<number> {
  const info = await connection.getAccountInfo(contest);
  return connection.getMinimumBalanceForRentExemption(info!.data.length);
}

async function openWith(opts: { contestId: number; keeper: Keypair; lockInSec?: number }) {
  const contest = contestPda(opts.contestId);
  const lock = nowSec() + (opts.lockInSec ?? 4);
  await program.methods
    .createContest(
      new BN(opts.contestId), fixtureArray([70010, 70011, 70012]), marketIdArray([12, 12, 12]), 3,
      new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), opts.keeper.publicKey, 500, legLockArray(lock, 3),
    )
    .accountsStrict({ keeper: opts.keeper.publicKey, contest, systemProgram: SystemProgram.programId })
    .signers([opts.keeper]).rpc();
  return contest;
}

describe("parlay v2 — void_contest", () => {
  it("(a) keeper voids an Open contest; (c) each ticket refunds its full stake; contest ends at rent floor", async () => {
    const keeper = await freshFunded();
    const contest = await openWith({ contestId: 170001, keeper });

    const p1 = await freshFunded();
    const p2 = await freshFunded();
    for (const p of [p1, p2]) {
      await program.methods.enter(new BN(0), pickArray([0, 1, 2]))
        .accountsStrict({ bettor: p.publicKey, contest, entry: entryPda(contest, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
    }

    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
    assert.deepEqual((await program.account.contest.fetch(contest)).status, { voided: {} });

    // Each ticket claims a full entry.amount refund from the Contest PDA.
    for (const p of [p1, p2]) {
      const before = await balance(p.publicKey);
      await program.methods.claimContest()
        .accountsStrict({ bettor: p.publicKey, contest, entry: entryPda(contest, p.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([p]).rpc();
      const gained = (await balance(p.publicKey)) - before;
      assert.isAtLeast(gained, 1 * LAMPORTS_PER_SOL, "full stake refunded (+ entry rent)");
    }
    // Conservation: after both refunds the Contest PDA is back at exactly its floor.
    const floor = await contestRentFloor(contest);
    assert.equal(await balance(contest), floor, "contest pot fully refunded → back at rent floor");
  });

  it("(b) rejects a non-keeper void before the grace period (deny path of the permissionless backstop)", async () => {
    // The ALLOW-after-grace path (now > settle_after_ts + 3 days) can't be wall-clock
    // tested on a local validator; it is reviewed in void_contest.rs. Here we assert
    // the deny path: a stranger cannot void early.
    const keeper = await freshFunded();
    const contest = await openWith({ contestId: 170002, keeper, lockInSec: 30 });
    const stranger = await freshFunded();
    await expectError(
      program.methods.voidContest()
        .accountsStrict({ settleAuthority: stranger.publicKey, contest })
        .signers([stranger]).rpc(),
      "Unauthorized",
    );
    // Keeper can still void any time (teardown).
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
  });
});
