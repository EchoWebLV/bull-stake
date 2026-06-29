import {
  program, freshFunded, SystemProgram, assert, expectError, balance,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import { jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray } from "./contest_helpers";

async function openContest(contestId: number, lockInSec = 6) {
  const keeper = await freshFunded();
  const vault = jackpotVaultPda();
  try {
    await program.methods.initializeVault()
      .accountsStrict({ keeper: keeper.publicKey, vault, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
  } catch (_) { /* singleton */ }
  const contest = contestPda(contestId);
  const lock = nowSec() + lockInSec;
  await program.methods
    .createContest(
      new BN(contestId), fixtureArray([9001, 9002, 9003, 9004]), 4,
      new BN(20_000_000), new BN(lock), new BN(lock + 30), keeper.publicKey, 500,
    )
    .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  return { keeper, vault, contest };
}

describe("daily sweepstake — enter", () => {
  let live: any = null;
  afterEach(async () => {
    if (!live) return;
    try {
      await program.methods.voidContest()
        .accountsStrict({ settleAuthority: live.keeper.publicKey, vault: live.vault, contest: live.contest })
        .signers([live.keeper]).rpc();
    } catch (_) { /* already terminal */ }
    live = null;
  });

  it("escrows one ticket and edits picks without re-charging", async () => {
    live = await openContest(40001);
    const { vault, contest } = live;
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);

    const vBefore = await balance(vault);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(vault) - vBefore, 20_000_000, "one ticket escrowed");
    let c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 1);

    // The new Entry must record all identity/amount fields (amount drives the void
    // refund in claim_contest, so assert it explicitly).
    const eInit = await program.account.entry.fetch(entry0);
    assert.equal(eInit.amount.toNumber(), 20_000_000, "entry.amount = entry_price at init");
    assert.equal(eInit.nonce.toNumber(), 0, "entry.nonce set");
    assert.ok(eInit.bettor.equals(player.publicKey), "entry.bettor set");
    assert.ok(eInit.contest.equals(contest), "entry.contest set");
    assert.deepEqual(eInit.picks, [0, 1, 2, 0, 0], "entry.picks set with tail zero");

    // Edit the SAME nonce before lock — no second charge, no entry_count change.
    const vAfterFirst = await balance(vault);
    await program.methods.enter(new BN(0), pickArray([2, 2, 2, 2]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(vault), vAfterFirst, "edit does not re-charge");
    c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 1, "edit does not increment entry_count");
    const e = await program.account.entry.fetch(entry0);
    assert.deepEqual(e.picks, [2, 2, 2, 2, 0]);
  });

  it("a second nonce is a second ticket and a second charge", async () => {
    live = await openContest(40002);
    const { vault, contest } = live;
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    const entry1 = entryPda(contest, player.publicKey, 1);
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    const vMid = await balance(vault);
    await program.methods.enter(new BN(1), pickArray([1, 1, 1, 1]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry1, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();
    assert.equal(await balance(vault) - vMid, 20_000_000, "second ticket charged");
    const c = await program.account.contest.fetch(contest);
    assert.equal(c.entryCount.toNumber(), 2);
  });

  it("rejects entry after lock and rejects an out-of-range pick", async () => {
    live = await openContest(40003, 4);
    const { vault, contest } = live;
    const player = await freshFunded();
    const entry0 = entryPda(contest, player.publicKey, 0);
    await expectError(
      program.methods.enter(new BN(0), pickArray([3, 0, 0, 0]))
        .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "InvalidPick",
    );
    await sleep(4500); // pass lock_ts
    await expectError(
      program.methods.enter(new BN(0), pickArray([0, 0, 0, 0]))
        .accountsStrict({ bettor: player.publicKey, vault, contest, entry: entry0, systemProgram: SystemProgram.programId })
        .signers([player]).rpc(),
      "EntryClosed",
    );
  });
});
