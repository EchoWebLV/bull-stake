import {
  program, freshFunded, SystemProgram, assert, balance, Keypair, expectError,
  BN, nowSec, sleep, LAMPORTS_PER_SOL, connection,
} from "./helpers";
import {
  jackpotPda, ensureJackpot, contestPda, entryPda, fixtureArray, marketIdArray, pickArray,
  makeSettledResultMarket, legLockArray,
} from "./contest_helpers";

// Task 6: claim_contest v2 — pays win shares / void refunds from the Contest PDA.

async function contestRentFloor(contest: any): Promise<number> {
  const info = await connection.getAccountInfo(contest);
  return connection.getMinimumBalanceForRentExemption(info!.data.length);
}

// Open + enter + settle a contest from `results`, perfectCount split. Result markets
// settled by the KEEPER (oracle binding requires market.settle_authority == keeper).
async function runContest(opts: {
  contestId: number; fixtures: number[]; results: number[];
  entries: { player: Keypair; nonce: number; picks: number[] }[]; perfectCount: number; weight?: number;
}) {
  const jackpot = await ensureJackpot();
  const keeper = await freshFunded();
  const contest = contestPda(opts.contestId);
  const lock = nowSec() + 5;
  await program.methods
    .createContest(
      new BN(opts.contestId), fixtureArray(opts.fixtures), marketIdArray(opts.fixtures.map(() => 12)), opts.fixtures.length,
      new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500, legLockArray(lock, opts.fixtures.length),
    )
    .accountsStrict({ keeper: keeper.publicKey, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  for (const en of opts.entries) {
    await program.methods.enter(new BN(en.nonce), pickArray(en.picks))
      .accountsStrict({ bettor: en.player.publicKey, contest, entry: entryPda(contest, en.player.publicKey, en.nonce), systemProgram: SystemProgram.programId })
      .signers([en.player]).rpc();
  }
  const markets = [];
  for (let i = 0; i < opts.fixtures.length; i++) {
    markets.push(await makeSettledResultMarket(opts.fixtures[i], opts.results[i], keeper));
  }
  await sleep(6500);
  const weight = opts.weight ?? 0;
  await program.methods.settleContest(new BN(opts.perfectCount), new BN(weight))
    .accountsStrict({ settleAuthority: keeper.publicKey, jackpot, contest, feeRecipient: keeper.publicKey })
    .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
    .signers([keeper]).rpc();
  return { jackpot, contest };
}

async function claim(contest: any, player: Keypair, nonce: number) {
  await program.methods.claimContest()
    .accountsStrict({ bettor: player.publicKey, contest, entry: entryPda(contest, player.publicKey, nonce), systemProgram: SystemProgram.programId })
    .signers([player]).rpc();
}

describe("parlay v2 — claim_contest", () => {
  it("(a) perfect winner claims its share; contest drops by share; entry closed; (d) double-claim fails", async () => {
    const winner = await freshFunded();
    const loser = await freshFunded();
    const fixtures = [160010, 160011, 160012];
    const results = [0, 1, 2];
    const { contest } = await runContest({
      // 3-leg contest, 1 perfect ticket → weight = 1 * 2^3 = 8.
      contestId: 160001, fixtures, results, perfectCount: 1, weight: 8,
      entries: [
        { player: winner, nonce: 0, picks: [0, 1, 2] },
        { player: loser, nonce: 0, picks: [1, 1, 1] },
      ],
    });
    const c = await program.account.contest.fetch(contest);
    const distributable = c.distributable.toNumber(); // 0.95 * 2 SOL, perfect_count 1 → winner sweeps all

    const cBeforeWin = await balance(contest);
    await claim(contest, winner, 0);
    assert.equal(cBeforeWin - (await balance(contest)), distributable, "winner sweeps the full distributable");
    const cc = await program.account.contest.fetch(contest);
    assert.equal(cc.claimedCount.toNumber(), 1, "claimed_count advanced");
    assert.equal(cc.claimedTotal.toNumber(), distributable, "claimed_total advanced");

    // (d) double-claim: the Entry is closed → AccountNotInitialized.
    await expectError(claim(contest, winner, 0), "AccountNotInitialized");

    // (c) loser claim → payout 0, entry closed (reclaims rent), no contest balance move.
    const cBeforeLose = await balance(contest);
    await claim(contest, loser, 0);
    assert.equal(await balance(contest), cBeforeLose, "loser draws nothing from the contest");
    const loserEntry = await connection.getAccountInfo(entryPda(contest, loser.publicKey, 0));
    assert.isNull(loserEntry, "loser entry closed (rent reclaimed)");
  });

  it("(b) two winners split; after both claim the contest holds exactly its rent floor", async () => {
    const a = await freshFunded();
    const b = await freshFunded();
    const fixtures = [160020, 160021, 160022];
    const results = [2, 0, 1];
    const { contest } = await runContest({
      // 3-leg contest, 2 perfect tickets → weight = 2 * 2^3 = 16.
      contestId: 160002, fixtures, results, perfectCount: 2, weight: 16,
      entries: [
        { player: a, nonce: 0, picks: [2, 0, 1] },
        { player: b, nonce: 0, picks: [2, 0, 1] },
      ],
    });
    await claim(contest, a, 0);
    await claim(contest, b, 0);
    // Two equal-weight winners split distributable exactly IN THIS CASE (even by
    // construction), so the contest lands back at its rent floor. In general,
    // weighted claims floor per-share and the residue stays in the PDA.
    const floor = await contestRentFloor(contest);
    assert.equal(await balance(contest), floor, "contest holds exactly its rent floor after all winners claim");
  });

  it("(e) cap: a phantom extra winner beyond perfect_count → VaultInsolvent", async () => {
    // Keeper under-reports perfect_count = 1 though TWO tickets are perfect. The
    // first sweeps the full distributable; the second perfect ticket MUST revert at
    // the cap (claimed_count < perfect_count), never over-drawing the contest pot.
    const w1 = await freshFunded();
    const w2 = await freshFunded();
    const fixtures = [160030, 160031, 160032];
    const results = [0, 1, 2];
    const { contest } = await runContest({
      // 3-leg contest, 1 (declared) perfect ticket → weight = 1 * 2^3 = 8.
      contestId: 160003, fixtures, results, perfectCount: 1, weight: 8,
      entries: [
        { player: w1, nonce: 0, picks: [0, 1, 2] },
        { player: w2, nonce: 0, picks: [0, 1, 2] },
      ],
    });
    const distributable = (await program.account.contest.fetch(contest)).distributable.toNumber();
    const cBefore = await balance(contest);
    await claim(contest, w1, 0);
    assert.equal(cBefore - (await balance(contest)), distributable, "first winner sweeps the full distributable");
    await expectError(claim(contest, w2, 0), "VaultInsolvent");
  });
});
