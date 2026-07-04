import {
  program, freshFunded, SystemProgram, assert, balance, expectError, BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  makeSettledResultMarket,
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
    await expectError(
      program.methods.enter(new BN(1), pickArray([0, 0, 0, 0, 0, 0]))
        .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 1), systemProgram: SystemProgram.programId })
        .signers([late]).rpc(),
      "EntryClosed",
    );
  });
});

// Part 0 (T5 amendment): the edit path is a free buy-back unless edits are
// weight-neutral — once any CARRIED leg has kicked off, the card is immutable
// (spec: no buy-backs; a dead card spectates). Staggered locks so leg 0 locks
// well before the rest: entries_close_ts is derived from the (num_legs -
// MIN_OPEN_LEGS)-th smallest lock, so it stays far out while leg 0's lock is
// used to probe the freeze independently of the entries-close gate.
describe("pearly — edit freeze", () => {
  it("accepts a weight-neutral edit before any carried leg locks; refreshes entry_ts", async () => {
    await ensureJackpot();
    const keeper = await freshFunded();
    const bettor = await freshFunded();

    const contestId = 770003;
    const contest = contestPda(contestId);
    const fixtures = [770030, 770031, 770032, 770033, 770034, 770035];
    const t0 = nowSec();
    // Leg 0 locks at +10s; legs 1..5 all lock at +20s. The +10 (not +5) keeps
    // the accepted edit below well clear of leg 0's lock even when the two
    // setup txs + fetch above it run slow (T5 review: anti-flake margin).
    // entries_close = 4th smallest (index 6-MIN_OPEN_LEGS(3)=3) = t0+20.
    const locks = [t0 + 10, t0 + 20, t0 + 20, t0 + 20, t0 + 20, t0 + 20];

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(0.1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 60),
        keeper.publicKey, 0, locks.map((l) => new BN(l)),
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    const created = await program.account.contest.fetch(contest);
    assert.equal(created.entriesCloseTs.toNumber(), locks[3], "entries close at the 4th-smallest leg lock (t0+20)");

    // Initial entry — all 6 legs open.
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: bettor.publicKey, contest, entry: entryPda(contest, bettor.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([bettor]).rpc();
    const before = await program.account.entry.fetch(entryPda(contest, bettor.publicKey, 0));

    // Edit ~2s later — still well before leg 0's lock (t0+10) and entries_close
    // (t0+20): no carried leg has kicked off, so the edit is weight-neutral.
    await sleep(2000);
    await program.methods.enter(new BN(0), pickArray([1, 1, 1, 1, 1, 1]))
      .accountsStrict({ bettor: bettor.publicKey, contest, entry: entryPda(contest, bettor.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([bettor]).rpc();
    const after = await program.account.entry.fetch(entryPda(contest, bettor.publicKey, 0));

    assert.deepEqual(after.picks, pickArray([1, 1, 1, 1, 1, 1]), "picks re-stamped");
    // Cluster-vs-cluster comparison (both timestamps read from the validator's own
    // clock), not wall-clock-vs-cluster — immune to local/cluster drift.
    assert.isAbove(after.entryTs.toNumber(), before.entryTs.toNumber(), "entry_ts refreshed by the accepted edit");
  });

  it("rejects a same-nonce edit once a carried leg has locked (CardLocked)", async () => {
    await ensureJackpot();
    const keeper = await freshFunded();
    const bettor = await freshFunded();

    const contestId = 770004;
    const contest = contestPda(contestId);
    const fixtures = [770040, 770041, 770042, 770043, 770044, 770045];
    const t0 = nowSec();
    // Leg 0 locks at +5s; legs 1..5 all lock at +20s. entries_close = t0+20.
    const locks = [t0 + 5, t0 + 20, t0 + 20, t0 + 20, t0 + 20, t0 + 20];

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(0.1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 60),
        keeper.publicKey, 0, locks.map((l) => new BN(l)),
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // Initial entry — all 6 legs open, carries leg 0.
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: bettor.publicKey, contest, entry: entryPda(contest, bettor.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([bettor]).rpc();

    // Sleep past leg 0's lock (t0+5) — still well before entries_close (t0+20),
    // so a same-nonce edit attempt now is rejected by the NEW freeze guard, not
    // the entries-close gate.
    await sleep(6000);
    await expectError(
      program.methods.enter(new BN(0), pickArray([1, 1, 1, 1, 1, 1]))
        .accountsStrict({ bettor: bettor.publicKey, contest, entry: entryPda(contest, bettor.publicKey, 0), systemProgram: SystemProgram.programId })
        .signers([bettor]).rpc(),
      "CardLocked",
    );
  });

  it("accepts an edit from a LATE entrant whose card never carried the locked leg", async () => {
    await ensureJackpot();
    const keeper = await freshFunded();
    const bettor = await freshFunded();

    const contestId = 770005;
    const contest = contestPda(contestId);
    const fixtures = [770050, 770051, 770052, 770053, 770054, 770055];
    const t0 = nowSec();
    // Leg 0 locks at +5s; legs 1..5 at +25s → entries_close = 4th smallest = t0+25.
    const locks = [t0 + 5, t0 + 25, t0 + 25, t0 + 25, t0 + 25, t0 + 25];

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(0.1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 60),
        keeper.publicKey, 0, locks.map((l) => new BN(l)),
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // Enter AFTER leg 0 locks: leg 0 is locked on the CONTEST but was never in
    // THIS card's mask (leg_lock <= entry_ts), so it must not freeze the card.
    await sleep(6000);
    await program.methods.enter(new BN(0), pickArray([0, 0, 0, 0, 0, 0]))
      .accountsStrict({ bettor: bettor.publicKey, contest, entry: entryPda(contest, bettor.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([bettor]).rpc();
    const before = await program.account.entry.fetch(entryPda(contest, bettor.publicKey, 0));
    assert.isAbove(before.entryTs.toNumber(), locks[0], "late entry stamped after leg 0 locked");

    // The freeze guard fires only for legs with entry_ts < leg_lock <= now; the
    // carried legs (1..5) don't lock until t0+25, so this edit is ACCEPTED and
    // weight-neutral (the refreshed entry_ts keeps the same 5-leg mask).
    await sleep(2000);
    await program.methods.enter(new BN(0), pickArray([1, 1, 1, 1, 1, 1]))
      .accountsStrict({ bettor: bettor.publicKey, contest, entry: entryPda(contest, bettor.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([bettor]).rpc();
    const after = await program.account.entry.fetch(entryPda(contest, bettor.publicKey, 0));

    assert.deepEqual(after.picks, pickArray([1, 1, 1, 1, 1, 1]), "picks re-stamped");
    assert.isAbove(after.entryTs.toNumber(), before.entryTs.toNumber(), "entry_ts refreshed by the accepted edit");
  });
});

// Legacy contests are unaffected by the edit freeze: every leg locks at the
// SAME lock_ts, so the entries_close_ts gate already rejects any enter (new or
// edit) at that instant — the CardLocked guard is correct but unreachable there
// (entries_close_ts == lock_ts == every leg_lock_ts[i] for i < num_legs when
// num_legs == 3, and even for wider legacy cards drawn from legLockArray, all
// locks share one value so the EntryClosed gate always fires first).

// Task 5 main task: claim_contest's masked perfect check + 2^active weighted
// share. An entry's ACTIVE legs are those still open when its picks were last
// written (entry_ts) — a late entry that missed a since-locked leg is masked
// out of that leg entirely (its pick is ignored, right or wrong) and is
// perfect off its remaining active legs alone, at reduced weight (2^active).
describe("pearly — weighted split", () => {
  it("early full card takes 64/96 of the pool, late 5-leg card takes 32/96", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const early = await freshFunded();
    const late = await freshFunded();

    const contestId = 770002;
    const contest = contestPda(contestId);
    const fixtures = [770020, 770021, 770022, 770023, 770024, 770025];
    const t0 = nowSec();
    // Leg 0 locks at +4s; the rest at +11..+15s → entries_close = 4th smallest = t0+13.
    const locks = [t0 + 4, t0 + 11, t0 + 12, t0 + 13, t0 + 14, t0 + 15];
    const results = [0, 1, 2, 0, 1, 2];

    await program.methods
      .createContest(
        new BN(contestId), fixtureArray(fixtures), marketIdArray(fixtures.map(() => 12)),
        6, new BN(1 * LAMPORTS_PER_SOL), new BN(locks[0]), new BN(locks[5] + 12),
        keeper.publicKey, 0, locks.map((l) => new BN(l)),
      )
      .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
      .signers([keeper]).rpc();

    // EARLY enters before any lock: mask = all 6, weight 64. Picks all correct.
    await program.methods.enter(new BN(0), pickArray(results))
      .accountsStrict({ bettor: early.publicKey, contest, entry: entryPda(contest, early.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([early]).rpc();

    // LATE enters after leg 0 locks (t0+4) with leg 0 WRONG — leg 0 is not in
    // their mask, so they are still perfect on their 5 active legs. Weight 32.
    await sleep(6000);
    const latePicks = [2, results[1], results[2], results[3], results[4], results[5]]; // leg0 wrong on purpose
    await program.methods.enter(new BN(0), pickArray(latePicks))
      .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([late]).rpc();

    // Settle all 6 leg markets, pass settle_after, settle with count=2 weight=96.
    const markets = [];
    for (let i = 0; i < 6; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    // Past settle_after = locks[5]+12 = t0+27. The clock here is already
    // ~t0+10..15 (late entry ~t0+6 plus six market create+settle round-trips),
    // so +22s lands ≥ t0+32 with real margin — don't trim it back.
    await sleep(22000);
    await program.methods.settleContest(new BN(2), new BN(96))
      .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
      .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
      .signers([keeper]).rpc();

    const settled = await program.account.contest.fetch(contest);
    assert.equal(settled.perfectWeight.toNumber(), 96);
    const D = settled.distributable.toNumber();
    const shareEarly = Math.floor((D * 64) / 96);
    const shareLate = Math.floor((D * 32) / 96);

    // Claims: exact shares via CONTEST balance deltas (rent-free — the Entry rent
    // refund lands on the bettor, not the contest, so this isolates the payout).
    const cBeforeEarly = await balance(contest);
    await program.methods.claimContest()
      .accountsStrict({ bettor: early.publicKey, contest, entry: entryPda(contest, early.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([early]).rpc();
    assert.equal(cBeforeEarly - (await balance(contest)), shareEarly, "early (weight 64) draws floor(D*64/96) from the contest");

    const cBeforeLate = await balance(contest);
    await program.methods.claimContest()
      .accountsStrict({ bettor: late.publicKey, contest, entry: entryPda(contest, late.publicKey, 0), systemProgram: SystemProgram.programId })
      .signers([late]).rpc();
    assert.equal(cBeforeLate - (await balance(contest)), shareLate, "late (weight 32) draws floor(D*32/96) from the contest");
  });
});
