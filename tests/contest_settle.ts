import {
  program, freshFunded, SystemProgram, assert, balance, Keypair, expectError,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray,
  makeSettledResultMarket, makeZeroWinnerResultMarket,
} from "./contest_helpers";

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

describe("daily sweepstake — settle_contest", () => {
  it("reads winning buckets from bound result markets and rakes new entries only", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const feeRecip = Keypair.generate(); // separate from the signer → clean rake measurement
    const contestId = 50001;
    const contest = contestPda(contestId);
    const fixtures = [50010, 50011, 50012, 50013];
    const lock = nowSec() + 5;

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 4,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), feeRecip.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // One perfect ticket: picks == eventual results [0,1,2,0].
    const winner = await freshFunded();
    const e0 = entryPda(contest, winner.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e0, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();

    // Settle the four per-match result markets to [0,1,2,0]. The oracle MUST be
    // the contest's own keeper: settle_contest binds market.settle_authority ==
    // contest.settle_authority, so an unrelated authority would be rejected (see
    // the "rejects a result market settled by a non-keeper authority" test below).
    const results = [0, 1, 2, 0];
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));

    const reservedBefore = (await program.account.jackpotVault.fetch(vault)).reserved;
    await sleep(6500); // pass settle_after_ts
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: feeRecip.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} });
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0]);
    assert.equal(c.perfectCount.toNumber(), 1);
    // rake = 5% of new entries (1 ticket * 1 SOL) = 0.05 SOL → paid to the separate
    // fee recipient (not the tx signer), so its whole balance == rake exactly.
    assert.equal(await balance(feeRecip.publicKey), 0.05 * LAMPORTS_PER_SOL, "rake = 5% of the 1 SOL of new entries");
    assert.equal(c.distributable.toNumber(), 0.95 * LAMPORTS_PER_SOL);
    // The reserve fence: settle must fence share*perfect_count (= distributable for
    // a single winner) as a cross-contest liability. Delta (not absolute) keeps this
    // robust to reserved accumulating across suites on the singleton vault.
    const reservedAfter = (await program.account.jackpotVault.fetch(vault)).reserved;
    assert.equal(
      reservedAfter.sub(reservedBefore).toNumber(),
      0.95 * LAMPORTS_PER_SOL,
      "settle reserves share*perfect_count",
    );
  });

  it("perfect_count == 0 rolls over and leaves the (post-rake) pot in the vault", async () => {
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 50002;
    const contest = contestPda(contestId);
    const fixtures = [50020, 50021, 50022, 50023];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 4,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const loser = await freshFunded();
    const e0 = entryPda(contest, loser.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([2, 2, 2, 2]))
      .accountsStrict({ bettor: loser.publicKey, vault, contest, entry: e0, systemProgram: SystemProgram.programId })
      .signers([loser]).rpc();
    const results = [0, 1, 2, 0];
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    const reservedBefore = (await program.account.jackpotVault.fetch(vault)).reserved;
    await sleep(6500);
    await program.methods.settleContest(new BN(0))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { rolledOver: {} });
    const v = await program.account.jackpotVault.fetch(vault);
    assert.equal(v.activeContestId.toNumber(), 0, "vault freed for the next contest");
    // The post-rake remainder (0.95 SOL) stays escrowed → rolls forward.
    assert.isAtLeast(await balance(vault), 0.95 * LAMPORTS_PER_SOL);
    // A rollover owes no one, so the reserve fence is untouched.
    assert.equal(v.reserved.sub(reservedBefore).toNumber(), 0, "rollover reserves nothing");
  });

  it("rejects a result market settled by a non-keeper authority (oracle-binding)", async () => {
    // The attack: an attacker front-runs the keeper, squats the deterministic
    // result-market PDA, and settles it to favor their own ticket. settle_contest
    // must reject any leg whose settle_authority != the contest's keeper.
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 50003;
    const contest = contestPda(contestId);
    const fixtures = [50030, 50031, 50032, 50033];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 4,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const player = await freshFunded();
    const e0 = entryPda(contest, player.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: player.publicKey, vault, contest, entry: e0, systemProgram: SystemProgram.programId })
      .signers([player]).rpc();

    // Attacker (not the keeper) creates+settles all four result markets.
    const attacker = await freshFunded();
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], [0, 1, 2, 0][i], attacker));

    await sleep(6500);
    await expectError(
      program.methods.settleContest(new BN(1))
        .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
        .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
        .signers([keeper]).rpc(),
      "ResultMarketMismatch",
    );
    // Clean up: keeper voids the squatted contest so the singleton vault is freed.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest })
      .signers([keeper]).rpc();
  });

  it("settles a leg whose winning bucket drew zero stake (Voided-with-bucket result)", async () => {
    // A real result on a match where nobody staked the winning side: settle.rs
    // voids that market but RECORDS winning_bucket. settle_contest must still read
    // it (audit fix B) and settle the contest, not brick it.
    const vault = await ensureVault();
    const keeper = await freshFunded();
    const contestId = 50004;
    const contest = contestPda(contestId);
    const fixtures = [50040, 50041, 50042, 50043];
    const lock = nowSec() + 5;
    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), 4,
        new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
      )
      .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();
    const winner = await freshFunded();
    const e0 = entryPda(contest, winner.publicKey, 0);
    await program.methods.enter(new BN(0), pickArray([0, 1, 2, 0]))
      .accountsStrict({ bettor: winner.publicKey, vault, contest, entry: e0, systemProgram: SystemProgram.programId })
      .signers([winner]).rpc();

    const markets = [];
    // Leg 0 is a zero-winner-void market (winning bucket 0 had no stake); the rest settle normally.
    markets.push(await makeZeroWinnerResultMarket(fixtures[0], 0, keeper));
    for (let i = 1; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], [0, 1, 2, 0][i], keeper));

    await sleep(6500);
    await program.methods.settleContest(new BN(1))
      .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} });
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0], "zero-stake leg's recorded bucket is read");
  });
});
