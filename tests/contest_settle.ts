import {
  program, freshFunded, SystemProgram, assert, balance, Keypair, expectError,
  BN, nowSec, sleep, LAMPORTS_PER_SOL, connection,
} from "./helpers";
import {
  jackpotPda, ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  makeSettledResultMarket, makeAbandonedMarket, legLockArray,
} from "./contest_helpers";

// Task 5: settle_contest v2 — per-leg market_id resolution + the jackpot mechanic
// (rollover sweeps the post-rake pot INTO the jackpot; a winner scoops the whole
// rolling pool and leaves only floor-division dust behind).

async function contestRentFloor(contest: any): Promise<number> {
  const info = await connection.getAccountInfo(contest);
  return connection.getMinimumBalanceForRentExemption(info!.data.length);
}
async function jackpotPool(jackpot: any): Promise<number> {
  const info = await connection.getAccountInfo(jackpot);
  const floor = await connection.getMinimumBalanceForRentExemption(info!.data.length);
  return (await balance(jackpot)) - floor;
}

async function open(opts: {
  contestId: number; keeper: Keypair; fixtures: number[]; marketIds: number[];
  feeRecipient: PublicKeyLike; price?: number; feeBps?: number;
}) {
  const contest = contestPda(opts.contestId);
  const lock = nowSec() + 5;
  await program.methods
    .createContest(
      new BN(opts.contestId), fixtureArray(opts.fixtures), marketIdArray(opts.marketIds), opts.fixtures.length,
      new BN(opts.price ?? 1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6),
      (opts.feeRecipient as any), opts.feeBps ?? 500, legLockArray(lock, opts.fixtures.length),
    )
    .accountsStrict({ keeper: opts.keeper.publicKey, contest, systemProgram: SystemProgram.programId })
    .signers([opts.keeper]).rpc();
  return contest;
}
type PublicKeyLike = any;

async function enter(contest: any, player: Keypair, nonce: number, picks: number[]) {
  await program.methods.enter(new BN(nonce), pickArray(picks))
    .accountsStrict({ bettor: player.publicKey, contest, entry: entryPda(contest, player.publicKey, nonce), systemProgram: SystemProgram.programId })
    .signers([player]).rpc();
}

async function settle(opts: {
  keeper: Keypair; jackpot: any; contest: any; feeRecipient: any; markets: any[]; perfectCount: number;
}) {
  await program.methods.settleContest(new BN(opts.perfectCount))
    .accountsStrict({ settleAuthority: opts.keeper.publicKey, jackpot: opts.jackpot, contest: opts.contest, feeRecipient: opts.feeRecipient })
    .remainingAccounts(opts.markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
    .signers([opts.keeper]).rpc();
}

describe("parlay v2 — settle_contest", () => {
  it("(a) winners: two perfect tickets, jackpot starts empty → distributable = pot - rake", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const feeRecip = Keypair.generate();
    const fixtures = [150010, 150011, 150012, 150013];
    const contest = await open({ contestId: 150001, keeper, fixtures, marketIds: [12, 12, 12, 12], feeRecipient: feeRecip.publicKey });

    const results = [0, 1, 2, 0];
    const w1 = await freshFunded();
    const w2 = await freshFunded();
    await enter(contest, w1, 0, results);
    await enter(contest, w2, 0, results);

    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));

    const poolBefore = await jackpotPool(jackpot);
    await sleep(6500);
    await settle({ keeper, jackpot, contest, feeRecipient: feeRecip.publicKey, markets, perfectCount: 2 });

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} });
    assert.deepEqual(c.winningBuckets, [0, 1, 2, 0, 0, 0]);
    assert.equal(c.perfectCount.toNumber(), 2);
    // rake = 5% of 2 SOL = 0.1 SOL → to the separate fee recipient.
    assert.equal(await balance(feeRecip.publicKey), 0.1 * LAMPORTS_PER_SOL, "rake = 5% of 2 SOL of entries");
    // pot - rake = 1.9 SOL; jackpot started empty so distributable == 1.9 SOL, share == 0.95.
    assert.equal(c.distributable.toNumber(), 1.9 * LAMPORTS_PER_SOL);
    assert.equal(c.distributable.toNumber() / c.perfectCount.toNumber(), 0.95 * LAMPORTS_PER_SOL, "share = distributable/2");
    // jackpot was empty and stays empty (no dust because 1.9e9 is divisible by 2).
    assert.equal(await jackpotPool(jackpot), poolBefore, "empty jackpot unchanged");
    // The Contest PDA holds floor + distributable.
    const floor = await contestRentFloor(contest);
    assert.equal(await balance(contest), floor + c.distributable.toNumber(), "contest holds floor + distributable");
  });

  it("(b) rollover: zero perfect → post-rake pot moves INTO the jackpot", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const fixtures = [150020, 150021, 150022, 150023];
    const contest = await open({ contestId: 150002, keeper, fixtures, marketIds: [12, 12, 12, 12], feeRecipient: keeper.publicKey });
    const loser = await freshFunded();
    await enter(contest, loser, 0, [2, 2, 2, 2]);
    const results = [0, 1, 2, 0];
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));

    const poolBefore = await jackpotPool(jackpot);
    await sleep(6500);
    await settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets, perfectCount: 0 });

    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { rolledOver: {} });
    assert.equal(c.distributable.toNumber(), 0);
    // pot - rake = 0.95 SOL rolled INTO the jackpot.
    assert.equal((await jackpotPool(jackpot)) - poolBefore, 0.95 * LAMPORTS_PER_SOL, "post-rake pot rolled into jackpot");
    // Contest PDA swept to exactly its rent floor.
    const floor = await contestRentFloor(contest);
    assert.equal(await balance(contest), floor, "contest pot fully swept");
  });

  it("(c) jackpot scoop: a 1-winner contest drains the rolling pool + its own pot", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    // Seed the jackpot via a rollover (contest with 0 winners).
    const fA = [150030, 150031, 150032, 150033];
    const cA = await open({ contestId: 150003, keeper, fixtures: fA, marketIds: [12, 12, 12, 12], feeRecipient: keeper.publicKey });
    const loser = await freshFunded();
    await enter(cA, loser, 0, [2, 2, 2, 2]);
    const resA = [0, 1, 2, 0];
    const mA = [];
    for (let i = 0; i < 4; i++) mA.push(await makeSettledResultMarket(fA[i], resA[i], keeper));
    await sleep(6500);
    await settle({ keeper, jackpot, contest: cA, feeRecipient: keeper.publicKey, markets: mA, perfectCount: 0 });
    const poolAfterRoll = await jackpotPool(jackpot);
    assert.isAtLeast(poolAfterRoll, 0.95 * LAMPORTS_PER_SOL, "rollover seeded the jackpot");

    // Contest B: one perfect ticket scoops its own pot + the whole jackpot pool.
    const fB = [150034, 150035, 150036, 150037];
    const cB = await open({ contestId: 150004, keeper, fixtures: fB, marketIds: [12, 12, 12, 12], feeRecipient: keeper.publicKey });
    const winner = await freshFunded();
    const resB = [0, 1, 2, 0];
    await enter(cB, winner, 0, resB);
    const mB = [];
    for (let i = 0; i < 4; i++) mB.push(await makeSettledResultMarket(fB[i], resB[i], keeper));
    const poolBeforeB = await jackpotPool(jackpot);
    await sleep(6500);
    await settle({ keeper, jackpot, contest: cB, feeRecipient: keeper.publicKey, markets: mB, perfectCount: 1 });

    const c = await program.account.contest.fetch(cB);
    // distributable == its_pot(post-rake) + jackpot_pool (perfect_count 1 → no dust).
    const ownPotNet = 0.95 * LAMPORTS_PER_SOL; // 1 SOL entry, 5% rake
    assert.equal(c.distributable.toNumber(), ownPotNet + poolBeforeB, "distributable = own net pot + scooped jackpot pool");
    assert.equal(await jackpotPool(jackpot), 0, "jackpot drained to dust (0 here, evenly divisible)");
  });

  it("(d) dust: distributable not divisible by perfect_count → remainder stays in the jackpot", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const fixtures = [150040, 150041, 150042];
    // 3 perfect tickets at 1 SOL, 0 fee → pot = 3 SOL, jpool from prior tests is
    // whatever it is. To force dust we add 1 lamport of jackpot via... instead use
    // an odd raw: 3 entries, fee 0 → pot_net = 3e9. raw = 3e9 + jpool. We make
    // perfect_count = 3 and assert dust = raw % 3 stays in the jackpot.
    const contest = await open({ contestId: 150005, keeper, fixtures, marketIds: [12, 12, 12], feeRecipient: keeper.publicKey, feeBps: 0 });
    const results = [0, 1, 2];
    const players = [await freshFunded(), await freshFunded(), await freshFunded()];
    for (const p of players) await enter(contest, p, 0, results);
    const markets = [];
    for (let i = 0; i < 3; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));

    const poolBefore = await jackpotPool(jackpot);
    const potNet = 3 * LAMPORTS_PER_SOL; // fee 0
    const raw = potNet + poolBefore;
    const share = Math.floor(raw / 3);
    const payable = share * 3;
    const expectedDust = raw - payable;
    await sleep(6500);
    await settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets, perfectCount: 3 });

    const c = await program.account.contest.fetch(contest);
    assert.equal(c.distributable.toNumber(), payable, "distributable == share*perfect_count (divisible)");
    assert.equal(c.distributable.toNumber() % 3, 0, "distributable exactly divisible by perfect_count");
    assert.equal(await jackpotPool(jackpot), expectedDust, "the floor-division dust stays in the jackpot");
  });

  it("(e) leg-by-market_id: legs [16,15,12,11] read their own markets; a 2-way leg reads bucket 0/1", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const F = 150050; // SAME fixture across legs, distinguished by market_id
    const marketIds = [16, 15, 12, 11];
    const contest = await open({ contestId: 150006, keeper, fixtures: [F, F, F, F], marketIds, feeRecipient: keeper.publicKey });
    // Leg buckets: 16→3way bucket 2, 15→2way bucket 1, 12→3way bucket 0, 11→2way bucket 0.
    const buckets = [2, 1, 0, 0];
    const numBuckets = [3, 2, 3, 2];
    const winner = await freshFunded();
    await enter(contest, winner, 0, buckets);
    const markets = [];
    for (let i = 0; i < 4; i++) {
      markets.push(await makeSettledResultMarket(F, buckets[i], keeper, marketIds[i], numBuckets[i]));
    }
    await sleep(6500);
    await settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets, perfectCount: 1 });
    const c = await program.account.contest.fetch(contest);
    assert.deepEqual(c.status, { settled: {} });
    assert.deepEqual(c.winningBuckets, [2, 1, 0, 0, 0, 0], "each leg's bucket read from its own (fixture, market_id) market");
  });

  it("(f) oracle binding: a leg market settled by a non-keeper authority → ResultMarketMismatch", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const fixtures = [150060, 150061, 150062, 150063];
    const contest = await open({ contestId: 150007, keeper, fixtures, marketIds: [12, 12, 12, 12], feeRecipient: keeper.publicKey });
    const player = await freshFunded();
    const results = [0, 1, 2, 0];
    await enter(contest, player, 0, results);
    const attacker = await freshFunded();
    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], attacker));
    await sleep(6500);
    await expectError(
      settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets, perfectCount: 1 }),
      "ResultMarketMismatch",
    );
    // Teardown so the Entry/Contest don't linger uncleaned.
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
  });

  it("(g) errors: too early, wrong remaining count, abandoned (no bucket)", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const fixtures = [150070, 150071, 150072, 150073];
    const contest = await open({ contestId: 150008, keeper, fixtures, marketIds: [12, 12, 12, 12], feeRecipient: keeper.publicKey });
    const player = await freshFunded();
    const results = [0, 1, 2, 0];
    await enter(contest, player, 0, results);

    // Too early — before settle_after_ts. settle_contest checks the settle window
    // BEFORE it reads any result market, so this fires with no markets passed —
    // and crucially we assert it BEFORE the slow market creation below, whose
    // per-market entry-close sleeps would otherwise elapse the settle window and
    // let the call through.
    await expectError(
      settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets: [], perfectCount: 1 }),
      "SettleTooEarly",
    );

    const markets = [];
    for (let i = 0; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    await sleep(6500);
    // Wrong remaining-account count (3 instead of 4).
    await expectError(
      settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets: markets.slice(0, 3), perfectCount: 1 }),
      "ResultMarketMismatch",
    );
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
  });

  it("(g2) abandoned leg (voided market with no winning bucket) → ResultMarketNotSettled", async () => {
    const jackpot = await ensureJackpot();
    const keeper = await freshFunded();
    const fixtures = [150080, 150081, 150082, 150083];
    const contest = await open({ contestId: 150009, keeper, fixtures, marketIds: [12, 12, 12, 12], feeRecipient: keeper.publicKey });
    const player = await freshFunded();
    const results = [0, 1, 2, 0];
    await enter(contest, player, 0, results);
    const markets = [];
    // Leg 0 is genuinely ABANDONED (void_market → no bucket); the rest settle.
    markets.push(await makeAbandonedMarket(fixtures[0], keeper));
    for (let i = 1; i < 4; i++) markets.push(await makeSettledResultMarket(fixtures[i], results[i], keeper));
    await sleep(6500);
    await expectError(
      settle({ keeper, jackpot, contest, feeRecipient: keeper.publicKey, markets, perfectCount: 1 }),
      "ResultMarketNotSettled",
    );
    await program.methods.voidContest()
      .accountsStrict({ settleAuthority: keeper.publicKey, contest })
      .signers([keeper]).rpc();
  });
});
