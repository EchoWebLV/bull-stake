import { program, connection, freshFunded, sleep, SystemProgram, expectError, assert } from "./helpers";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createPool, joinPool, openCall, lockPick, resolveCall, endPool, claimPool,
  refundVoided, callPda, KIND,
} from "./live_helpers";

const sk = (s: any) => Object.keys(s)[0];

async function voidBy(ctx: any, signer: any) {
  return program.methods
    .voidLivePool()
    .accountsStrict({ settleAuthority: signer.publicKey, pool: ctx.pool })
    .signers([signer]).rpc();
}

describe("live_pool_safety", () => {
  it("keeper void refunds each seat's stake in full; no rake on a void", async () => {
    const ctx = await createPool({ entryPrice: 1e8 });
    const { player: p0 } = await joinPool(ctx);
    const { player: p1 } = await joinPool(ctx);
    await voidBy(ctx, ctx.keeper);
    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(sk(pool.status), "voided");

    const before = await connection.getBalance(p0.publicKey);
    await claimPool(ctx, p0);
    const after = await connection.getBalance(p0.publicKey);
    assert.isAbove(after - before, 1e8); // full refund + rent, minus a tiny fee
    await claimPool(ctx, p1);
  });

  it("refund_voided: permissionless all-seats refund of a voided pool (the delegated keeper-death path)", async () => {
    // Mirrors Finding [2]'s frozen state: on devnet the entries would be delegated
    // (owner = Delegation Program) so claim_live_pool reverts; refund_voided reads
    // each seat owner-agnostically. On localnet the entries are program-owned, which
    // exercises the identical UncheckedAccount code path (the owner is never checked).
    const ctx = await createPool({ entryPrice: 1e8 });
    const { player: p0, entry: e0 } = await joinPool(ctx);
    const { player: p1, entry: e1 } = await joinPool(ctx);
    await voidBy(ctx, ctx.keeper);

    const seats = [
      { entry: e0, playerWallet: p0.publicKey },
      { entry: e1, playerWallet: p1.publicKey },
    ];
    const b0 = await connection.getBalance(p0.publicKey);
    const b1 = await connection.getBalance(p1.publicKey);
    // Permissionless: a STRANGER cranks it and pays the fee. Players never sign, so
    // their balance deltas are EXACTLY the refunded entry_price.
    const stranger = await freshFunded();
    await refundVoided(ctx, seats, stranger);
    assert.equal((await connection.getBalance(p0.publicKey)) - b0, 1e8);
    assert.equal((await connection.getBalance(p1.publicKey)) - b1, 1e8);

    const pool = await program.account.livePool.fetch(ctx.pool);
    assert.equal(pool.claimedCount.toNumber(), 2);
    assert.equal(pool.claimedTotal.toNumber(), 2e8);

    // Single-shot: a second refund fails fast (and the drained pot would fail solvency).
    await expectError(refundVoided(ctx, seats, stranger), "AlreadyRefunded");
  });

  it("SECURITY: after refund_voided, a per-seat void claim is CLOSE-ONLY — no second stake payout even from donated lamports", async () => {
    // Stress-test finding: claim_live_pool's Voided branch shared no state guard
    // with refund_voided; once the bulk refund ran, any lamports later landing in
    // the pool PDA (donation/dust) could be drained by a second per-seat "refund"
    // — the rent-floor solvency check can't see slack above the floor. The fix
    // keys on claimed_count (refund_voided is its only writer on a Voided pool):
    // claimed_count > 0 → the seat's stake already came back, so the claim pays
    // ZERO stake but still closes the entry (rent back to the player).
    const ctx = await createPool({ entryPrice: 1e8 });
    const { player: p0, entry: e0 } = await joinPool(ctx);
    const { player: p1, entry: e1 } = await joinPool(ctx);
    await voidBy(ctx, ctx.keeper);
    await refundVoided(ctx, [
      { entry: e0, playerWallet: p0.publicKey },
      { entry: e1, playerWallet: p1.publicKey },
    ]);

    // Adversarial top-up: a full entry_price lands in the pool PDA after the refund.
    const donor = await freshFunded();
    const donate = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: ctx.pool, lamports: 1e8 }),
    );
    await sendAndConfirmTransaction(connection, donate, [donor]);
    const poolBefore = await connection.getBalance(ctx.pool);

    // The already-refunded seat claims: succeeds, but only the ENTRY RENT moves
    // (close = player) — the 1e8 stake is NOT paid a second time.
    const before = await connection.getBalance(p0.publicKey);
    await claimPool(ctx, p0);
    const delta = (await connection.getBalance(p0.publicKey)) - before;
    assert.isAbove(delta, 0); // entry rent came back…
    assert.isBelow(delta, 0.5e8); // …but nowhere near a second 1e8 stake
    // The pool's lamports (floor + donation) are untouched by the claim.
    assert.equal(await connection.getBalance(ctx.pool), poolBefore);
  });

  it("refund_voided rejects a non-voided pool (PoolNotVoided)", async () => {
    const ctx = await createPool({ entryPrice: 1e8 });
    const { player: p0, entry: e0 } = await joinPool(ctx);
    const { player: p1, entry: e1 } = await joinPool(ctx);
    await expectError(
      refundVoided(ctx, [
        { entry: e0, playerWallet: p0.publicKey },
        { entry: e1, playerWallet: p1.publicKey },
      ]),
      "PoolNotVoided",
    );
  });

  it("refund_voided rejects incomplete coverage and a redirected refund (ScoreMismatch)", async () => {
    const ctx = await createPool({ entryPrice: 1e8 });
    const { player: p0, entry: e0 } = await joinPool(ctx);
    const { player: p1, entry: e1 } = await joinPool(ctx);
    await voidBy(ctx, ctx.keeper);

    // Coverage: only one of two seats passed → count guard fails.
    await expectError(
      refundVoided(ctx, [{ entry: e0, playerWallet: p0.publicKey }]),
      "ScoreMismatch",
    );
    // Redirect: correct entries, but seat 0's wallet swapped for an attacker's.
    const attacker = await freshFunded();
    await expectError(
      refundVoided(ctx, [
        { entry: e0, playerWallet: attacker.publicKey },
        { entry: e1, playerWallet: p1.publicKey },
      ]),
      "ScoreMismatch",
    );
  });

  it("under-filled pool (1 player) is voided-and-refunded, never settled", async () => {
    const ctx = await createPool({ entryPrice: 1e8 });
    const { player } = await joinPool(ctx);
    await voidBy(ctx, ctx.keeper);
    const before = await connection.getBalance(player.publicKey);
    await claimPool(ctx, player);
    assert.isAbove((await connection.getBalance(player.publicKey)) - before, 1e8);
  });

  it("a non-keeper cannot void before the grace window (Unauthorized)", async () => {
    const ctx = await createPool();
    await joinPool(ctx);
    const stranger = await freshFunded();
    await expectError(voidBy(ctx, stranger), "Unauthorized");
  });

  it("open_call / resolve_call reject a non-keeper", async () => {
    const ctx = await createPool({ numCalls: 2 });
    await joinPool(ctx);
    const stranger = await freshFunded();
    await expectError(
      program.methods
        .openCall(0, KIND.nextGoal, 3, [4, 1, 4], 120)
        .accountsStrict({ keeper: stranger.publicKey, pool: ctx.pool, cursor: ctx.cursor, call: callPda(ctx.pool, 0) })
        .signers([stranger]).rpc(),
      "Unauthorized",
    );
    await openCall(ctx, 0);
    await expectError(
      program.methods
        .resolveCall(0)
        .accountsStrict({ keeper: stranger.publicKey, pool: ctx.pool, cursor: ctx.cursor, call: callPda(ctx.pool, 0) })
        .signers([stranger]).rpc(),
      "Unauthorized",
    );
  });

  it("lock_pick rejects a closed answer window and an out-of-range option", async () => {
    const ctx = await createPool({ numCalls: 2 });
    const { player } = await joinPool(ctx);
    // out-of-range option (num_options = 2, option = 2)
    await openCall(ctx, 0, { numOptions: 2, basePoints: [2, 1, 0], answerSecs: 120 });
    await expectError(lockPick(ctx, player, 0, 2), "InvalidOption");
    await resolveCall(ctx, 0, 0);
    // closed window — sleep well past answer_secs so the on-chain clock has moved
    await openCall(ctx, 1, { answerSecs: 2 });
    await sleep(4000);
    await expectError(lockPick(ctx, player, 1, 0), "AnswerWindowClosed");
  });

  it("lock_pick after resolve is rejected (CallNotOpen)", async () => {
    const ctx = await createPool({ numCalls: 2 });
    const { player } = await joinPool(ctx);
    await openCall(ctx, 0);
    await resolveCall(ctx, 0, 0);
    await expectError(lockPick(ctx, player, 0, 0), "CallNotOpen");
  });

  it("resolve_call rejects an out-of-range outcome (InvalidOption)", async () => {
    const ctx = await createPool({ numCalls: 2 });
    await joinPool(ctx);
    await openCall(ctx, 0, { numOptions: 2, basePoints: [2, 1, 0] });
    await expectError(resolveCall(ctx, 0, 5), "InvalidOption");
  });

  it("call sequencing: no second open while one is live; seq must be next; end needs no open call", async () => {
    const ctx = await createPool({ numCalls: 4 });
    await joinPool(ctx);
    await openCall(ctx, 0);
    await expectError(openCall(ctx, 1), "CallStillOpen");     // 0 still open
    await expectError(endPool(ctx), "CallStillOpen");          // can't end mid-call
    await resolveCall(ctx, 0, 0);
    await expectError(openCall(ctx, 2), "CallSeqMismatch");    // must be seq 1 next
  });
});
