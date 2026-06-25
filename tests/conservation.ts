import {
  program, marketPda, vaultPda, positionPda, freshFunded, goalsArgs,
  nowSec, sleep, balance, airdrop,
  BN, Keypair, SystemProgram, LAMPORTS_PER_SOL, assert,
} from "./helpers";

// Bettors are funded BEFORE init so airdrop latency stays out of the entry
// window (which would flakily trip placeBet's EntryClosed guard).
const WINDOW_SEC = 5;
const WAIT_MS = 6000;

describe("conservation invariant", () => {
  it("Σpayout + fee + dust == total_pool, dust < winner_count, winners principal-safe", async () => {
    const fixtureId = 6001;
    const creator = await freshFunded();
    const settleAuth = await freshFunded();
    const feeKp = Keypair.generate();
    await airdrop(feeKp.publicKey, 1);

    // Amounts chosen so the pro-rata division leaves dust (1 lamport here).
    const stakes = [
      { kp: await freshFunded(), bucket: 0, lamports: 1_000_000_000n }, // OVER winner
      { kp: await freshFunded(), bucket: 0, lamports: 300_000_000n },   // OVER winner
      { kp: await freshFunded(), bucket: 1, lamports: 2_000_000_000n }, // UNDER loser
    ];

    const market = marketPda(fixtureId, 0);
    const vault = vaultPda(market);
    const feeBps = 100; // 1% of the losing pool

    await program.methods
      .initializeMarket(new BN(fixtureId), 0, goalsArgs({
        settleAuthority: settleAuth.publicKey,
        threshold: 2,
        entryCloseTs: nowSec() + WINDOW_SEC,
        feeBps,
        feeRecipient: feeKp.publicKey,
      }))
      .accountsStrict({
        creator: creator.publicKey, market, vault,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator]).rpc();

    // rent floor = vault balance right after init (before any bets)
    const rentFloor = BigInt(await balance(vault));

    for (const s of stakes) {
      const position = positionPda(market, s.kp.publicKey);
      await program.methods.placeBet(s.bucket, new BN(s.lamports.toString()))
        .accountsStrict({
          bettor: s.kp.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([s.kp]).rpc();
    }

    const totalPool = stakes.reduce((acc, s) => acc + s.lamports, 0n);
    const winners = stakes.filter((s) => s.bucket === 0);
    const winnerTotal = winners.reduce((acc, s) => acc + s.lamports, 0n);
    const loserTotal = totalPool - winnerTotal;
    const fee = (loserTotal * BigInt(feeBps)) / 10_000n;
    const distributable = totalPool - fee;

    await sleep(WAIT_MS);
    const feeBefore = BigInt(await balance(feeKp.publicKey));
    await program.methods.settle(0, 99, new BN(1700000000000), 7)
      .accountsStrict({
        settleAuthority: settleAuth.publicKey, market, vault,
        feeRecipient: feeKp.publicKey,
      })
      .signers([settleAuth]).rpc();
    const feeAfter = BigInt(await balance(feeKp.publicKey));
    assert.equal((feeAfter - feeBefore).toString(), fee.toString(), "fee recipient credited exactly the fee");

    // Each participant claims; sum the vault debits.
    let totalPaid = 0n;
    for (const s of stakes) {
      const position = positionPda(market, s.kp.publicKey);
      const vaultBefore = BigInt(await balance(vault));
      await program.methods.claim()
        .accountsStrict({
          bettor: s.kp.publicKey, market, vault, position,
          systemProgram: SystemProgram.programId,
        })
        .signers([s.kp]).rpc();
      const vaultAfter = BigInt(await balance(vault));
      const paid = vaultBefore - vaultAfter;
      totalPaid += paid;

      if (s.bucket === 0) {
        const expected = (s.lamports * distributable) / winnerTotal;
        assert.equal(paid.toString(), expected.toString(), "winner paid exact pro-rata share");
        assert.isTrue(paid >= s.lamports, "winner is principal-safe");
      } else {
        assert.equal(paid.toString(), "0", "loser receives nothing from the vault");
      }
    }

    const dust = distributable - totalPaid;
    assert.isTrue(dust >= 0n, "dust is non-negative");
    assert.isTrue(dust < BigInt(winners.length), "dust < winner_count");

    // The real conservation check: the vault's MEASURED end balance must equal
    // exactly rent_floor + dust. (A bare totalPaid+fee+dust==total_pool sum would
    // be an algebraic tautology since dust is defined as distributable-totalPaid,
    // and raw lamport sums are conserved by the runtime regardless.) This asserts
    // the program stranded nothing beyond the bounded floor-division dust and
    // conjured nothing — combined with the exact per-winner (above), loser-zero,
    // and exact-fee checks, that pins down the full distribution.
    const vaultEnd = BigInt(await balance(vault));
    assert.equal(vaultEnd.toString(), (rentFloor + dust).toString(), "vault ends at exactly rent_floor + dust");
  });
});
