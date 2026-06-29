import {
  program, freshFunded, SystemProgram, assert, balance, expectError,
  BN, nowSec, sleep, LAMPORTS_PER_SOL,
} from "./helpers";
import {
  jackpotVaultPda, contestPda, entryPda, fixtureArray, pickArray, makeSettledResultMarket,
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

// Open a contest, enter the given tickets, settle to `results` with `perfectCount`.
// The result markets are settled by the KEEPER (oracle binding requires
// result_market.settle_authority == contest.settle_authority).
async function runContest(opts: {
  contestId: number;
  fixtures: number[];
  results: number[];
  entries: { player: any; nonce: number; picks: number[] }[];
  perfectCount: number;
}) {
  const vault = await ensureVault();
  const keeper = await freshFunded();
  const contest = contestPda(opts.contestId);
  const lock = nowSec() + 5;
  await program.methods
    .createContest(
      new BN(opts.contestId), fixtureArray(opts.fixtures), opts.fixtures.length,
      new BN(1 * LAMPORTS_PER_SOL), new BN(lock), new BN(lock + 6), keeper.publicKey, 500,
    )
    .accountsStrict({ keeper: keeper.publicKey, vault, contest, systemProgram: SystemProgram.programId })
    .signers([keeper]).rpc();
  for (const en of opts.entries) {
    const entry = entryPda(contest, en.player.publicKey, en.nonce);
    await program.methods.enter(new BN(en.nonce), pickArray(en.picks))
      .accountsStrict({ bettor: en.player.publicKey, vault, contest, entry, systemProgram: SystemProgram.programId })
      .signers([en.player]).rpc();
  }
  const markets = [];
  for (let i = 0; i < opts.fixtures.length; i++) {
    markets.push(await makeSettledResultMarket(opts.fixtures[i], opts.results[i], keeper));
  }
  await sleep(6500);
  await program.methods.settleContest(new BN(opts.perfectCount))
    .accountsStrict({ settleAuthority: keeper.publicKey, vault, contest, feeRecipient: keeper.publicKey })
    .remainingAccounts(markets.map((m) => ({ pubkey: m, isWritable: false, isSigner: false })))
    .signers([keeper]).rpc();
  return { vault, contest };
}

async function claim(vault: any, contest: any, player: any, nonce: number) {
  const entry = entryPda(contest, player.publicKey, nonce);
  await program.methods.claimContest()
    .accountsStrict({ bettor: player.publicKey, vault, contest, entry, systemProgram: SystemProgram.programId })
    .signers([player]).rpc();
}

describe("daily sweepstake — claim_contest", () => {
  it("pays the perfect ticket its share and blocks a double-claim", async () => {
    const winner = await freshFunded();
    const loser = await freshFunded();
    const fixtures = [60010, 60011, 60012];
    const results = [0, 1, 2];
    const { vault, contest } = await runContest({
      contestId: 60001, fixtures, results, perfectCount: 1,
      entries: [
        { player: winner, nonce: 0, picks: [0, 1, 2] },
        { player: loser, nonce: 0, picks: [1, 1, 1] },
      ],
    });

    const c = await program.account.contest.fetch(contest);
    const distributable = c.distributable.toNumber(); // 0.95 * 2 SOL (2 entries, perfect_count 1)

    const vBeforeWin = await balance(vault);
    await claim(vault, contest, winner, 0);
    assert.equal(vBeforeWin - (await balance(vault)), distributable, "winner sweeps the full distributable (perfect_count = 1)");

    await expectError(claim(vault, contest, winner, 0), "AccountNotInitialized");

    const vBeforeLose = await balance(vault);
    await claim(vault, contest, loser, 0);
    assert.equal(await balance(vault), vBeforeLose, "loser draws nothing from the vault");
  });

  it("two perfect tickets split the pot; vault stays above its rent floor", async () => {
    const a = await freshFunded();
    const b = await freshFunded();
    const fixtures = [60020, 60021, 60022];
    const results = [2, 0, 1];
    const { vault, contest } = await runContest({
      contestId: 60002, fixtures, results, perfectCount: 2,
      entries: [
        { player: a, nonce: 0, picks: [2, 0, 1] },
        { player: b, nonce: 0, picks: [2, 0, 1] },
      ],
    });
    await claim(vault, contest, a, 0);
    await claim(vault, contest, b, 0);
    const v = await program.account.jackpotVault.fetch(vault); // throws if GC'd
    assert.ok(v);
    assert.isAbove(await balance(vault), 0);
  });
});
