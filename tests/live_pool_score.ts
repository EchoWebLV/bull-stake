import { program, expectError, assert } from "./helpers";
import {
  runMatch, gradePlayer, createPool, joinPool, openCall, resolveCall, scoreEntry,
  liveEntryPda, VOID_OUTCOME, KIND, type CallSpec,
} from "./live_helpers";

async function assertEntryMatchesOracle(entry: any, calls: CallSpec[], i: number) {
  const g = gradePlayer(calls, i);
  const e = await program.account.liveEntry.fetch(entry);
  assert.equal(e.basePts, g.base, "base_pts");
  assert.equal(e.bonusPts, g.bonus, "bonus_pts");
  assert.equal(e.streak, g.streak, "streak");
  assert.equal(e.nextScoreSeq, calls.length, "all calls folded");
}

describe("live_pool_score", () => {
  it("banks rarity base and runs the 3-in-a-row escalator (+1/+2/+3)", async () => {
    const calls: CallSpec[] = Array.from({ length: 5 }, () => ({ outcome: 0, picks: [0] }));
    const { entries } = await runMatch(1, calls);
    const e = await program.account.liveEntry.fetch(entries[0]);
    assert.equal(e.basePts, 20); // 5 × 4
    assert.equal(e.bonusPts, 6); // +1 +2 +3 at streaks 3,4,5
    assert.equal(e.streak, 5);
    await assertEntryMatchesOracle(entries[0], calls, 0);
  });

  it("a wrong pick keeps base but wipes streak + bonus (miss)", async () => {
    const calls: CallSpec[] = [
      { outcome: 0, picks: [0] }, { outcome: 0, picks: [0] }, { outcome: 0, picks: [0] },
      { outcome: 0, picks: [0] }, { outcome: 0, picks: [1] }, // last is wrong
    ];
    const { entries } = await runMatch(1, calls);
    const e = await program.account.liveEntry.fetch(entries[0]);
    assert.equal(e.basePts, 16); // 4 hits kept
    assert.equal(e.bonusPts, 0);
    assert.equal(e.streak, 0);
    await assertEntryMatchesOracle(entries[0], calls, 0);
  });

  it("no pick for a resolved call scores as a miss", async () => {
    const calls: CallSpec[] = [
      { outcome: 0, picks: [0] }, { outcome: 0, picks: [0] },
      { outcome: 0, picks: [null] }, { outcome: 0, picks: [0] },
    ];
    const { entries } = await runMatch(1, calls);
    await assertEntryMatchesOracle(entries[0], calls, 0);
    const e = await program.account.liveEntry.fetch(entries[0]);
    assert.equal(e.streak, 1); // reset by the no-pick, then one more hit
    assert.equal(e.bonusPts, 0);
  });

  it("a globally-voided call is a no-op — streak survives it", async () => {
    const calls: CallSpec[] = [
      { outcome: 0, picks: [0] }, { outcome: 0, picks: [0] },
      { outcome: VOID_OUTCOME, picks: [null] }, // void: no penalty, streak preserved
      { outcome: 0, picks: [0] },
    ];
    const { entries } = await runMatch(1, calls);
    const e = await program.account.liveEntry.fetch(entries[0]);
    assert.equal(e.streak, 3); // 1,2,(void),3
    assert.equal(e.bonusPts, 1);
    assert.equal(e.basePts, 12);
    await assertEntryMatchesOracle(entries[0], calls, 0);
  });

  it("driveMatch total matches the on-chain scoring spec exactly (3 players, mixed)", async () => {
    const calls: CallSpec[] = [
      { kind: KIND.nextGoal, numOptions: 3, basePoints: [4, 1, 4], outcome: 0, picks: [0, 0, 1] },
      { kind: KIND.cornerSoon, numOptions: 2, basePoints: [2, 1, 0], outcome: 0, picks: [0, 1, 0] },
      { kind: KIND.cardSoon, numOptions: 2, basePoints: [3, 1, 0], outcome: 0, picks: [0, 0, 0] },
      { kind: KIND.goalRush, numOptions: 2, basePoints: [3, 1, 0], outcome: 1, picks: [1, 1, 1] },
    ];
    const { entries } = await runMatch(3, calls);
    for (let i = 0; i < 3; i++) await assertEntryMatchesOracle(entries[i], calls, i);
  });

  it("rejects out-of-order scoring (ScoreOutOfOrder)", async () => {
    const ctx = await createPool({ numCalls: 4 });
    const { player } = await joinPool(ctx);
    await openCall(ctx, 0); await resolveCall(ctx, 0, 0);
    await openCall(ctx, 1); await resolveCall(ctx, 1, 0);
    // scoring seq 1 before seq 0 is rejected
    await expectError(scoreEntry(ctx, player.publicKey, 1), "ScoreOutOfOrder");
  });

  it("cannot double-count: replaying a scored seq is rejected", async () => {
    const ctx = await createPool({ numCalls: 2 });
    const { player } = await joinPool(ctx);
    await openCall(ctx, 0); await resolveCall(ctx, 0, 0);
    await scoreEntry(ctx, player.publicKey, 0);
    await expectError(scoreEntry(ctx, player.publicKey, 0), "ScoreOutOfOrder");
  });

  it("rejects scoring an unresolved call (CallNotResolved)", async () => {
    const ctx = await createPool({ numCalls: 2 });
    const { player } = await joinPool(ctx);
    await openCall(ctx, 0); // not resolved
    await expectError(scoreEntry(ctx, player.publicKey, 0), "CallNotResolved");
  });
});
