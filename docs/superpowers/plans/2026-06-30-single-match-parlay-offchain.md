# Single-Match Parlay — Off-Chain Implementation Plan (Plan #2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the engine, keeper, and web to the merged **v2 single-match parlay** program so 1–3 concurrent parlay contests/day are created, read, settled, and played end-to-end in the app.

**Architecture:** The v2 program (Jackpot PDA + per-contest escrow + `market_ids` legs + concurrent contests) is already built/merged. This plan brings the off-chain layer to match: regenerate+sync the IDL, add `marketId 16` (1st-Half Result), generalize the engine reader to per-leg `marketIds` and multiple live contests (+`/api/jackpot`), rewrite the keeper for the parlay card / jackpot-aware settle / `void-contest`, and turn the web Sweepstake view into a 4-leg parlay view (1–3 cards, 2-way O/U control, jackpot headline). Finally deploy v2 to devnet and create a live parlay.

**Tech Stack:** Engine = Fastify + `@coral-xyz/anchor` (read-only), vitest. Keeper = tsx CLIs + pure helpers, vitest. Web = Vite React PWA + Anchor (web3.js v1) + Privy, vitest. Program id unchanged (`By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`).

**Spec:** `docs/superpowers/specs/2026-06-30-single-match-parlay-design.md` (§1 legs, §5 keeper, §6 engine, §7 web, §8 provability).

**Worktree:** build in `.worktrees/parlay-offchain` (branch `feat/parlay-offchain`, off `feat/streak-pivot`). No `anchor test` needed — engine/keeper/web are unit-tested with mocks/pure functions; the IDL regen runs `anchor build` once.

---

## Ground truth (v2 on-chain, frozen — every task conforms)

From the merged `programs/proofbet/src` (NOT the stale on-disk IDL):

- `Jackpot { bump }` singleton at PDA `[b"jackpot"]`; rolling pool = lamports above `minimum_balance(8 + 1)`.
- `Contest { contest_id, settle_authority, fee_recipient, fixtures:[i64;5], market_ids:[u8;5], num_legs:u8, entry_price, lock_ts, settle_after_ts, fee_bps, status, winning_buckets:[u8;5], entry_count, perfect_count, distributable, claimed_count, claimed_total, settled_ts, bump }` — **NO `pot_snapshot`**. The Contest PDA **holds its own pot**: free pot = `balance(contestPda) − minimum_balance(8 + Contest::INIT_SPACE)`.
- `Entry { bettor, contest, nonce, picks:[u8;5], amount, bump }` (seeds `[b"entry", contest, bettor, nonce_le]`; `contest` at byte offset 40).
- Instructions: `initialize_jackpot()` (accts `{keeper, jackpot, system_program}`); `create_contest(contest_id, fixtures:[i64;5], market_ids:[u8;5], num_legs:u8, entry_price, lock_ts, settle_after_ts, fee_recipient:Pubkey, fee_bps:u16)` (accts `{keeper, contest, system_program}` — **no vault**); `enter(nonce, picks:[u8;5])` (accts `{bettor, contest, entry, system_program}` — **no vault**); `settle_contest(perfect_count)` (accts `{settle_authority, jackpot, contest, fee_recipient}` + `num_legs` result-market PDAs as `remainingAccounts` in leg order; guard `perfect_count <= entry_count`); `claim_contest()` (accts `{bettor, contest, entry, system_program}` — **no vault**); `void_contest()` (accts `{settle_authority, contest}`; keeper anytime, permissionless after `settle_after_ts + 3 days`).
- Leg encoding (spec §1): legs in order `[16,15,12,11]`. 3-way (16,12): `0=home/lead, 1=draw/level, 2=away`. 2-way O/U (15,11): `0=over, 1=under`. Parlay fills `picks[0..3]`, `picks[4]=0`, `num_legs=4`.

**Decisions locked for this plan:**
- **`contest_id = the carded fixtureId`** (unique, non-zero, ties contest↔match; avoids the epoch-day collision for 1–3/day). Engine discovers live contests via `program.account.contest.all()` (not by assuming today's id), tolerating un-deserializable old v1 contests (e.g. 20635).
- **`/api/contest/today` is replaced by `/api/contest/live`** (array). Keep no back-compat alias (only the web consumes it).
- **Marquee selection** is by staggered kickoff only (the slate has no quality score); operator curates via the allow-list. `selectParlayMatches` enforces the stagger.

---

## File structure / change map

**Phase A — foundation**
- `target/idl/proofbet.json`, `web/src/idl/proofbet.json` — regenerate v2 IDL (anchor build) + copy.
- `engine/src/markets.ts` — add `marketId 16` + `marketById()` helper. Test: `engine/test/markets.test.ts`.

**Phase B — engine**
- `engine/src/chain.ts` — jackpot PDA/reader, `ContestView` (numLegs, marketIds, legs, pot), `readLiveContests()`, `entryOutcome` rename, `listEntriesForWallet`. Test: `engine/test/chain.contest.test.ts`.
- `engine/src/routes.ts` — `/api/contest/live`, `/api/jackpot`, entries. `engine/src/server.ts` — `refreshContestNames` multi-contest. Test: `engine/test/routes.test.ts`.

**Phase C — keeper**
- `keeper/contest.ts` — `selectParlayMatches`, parlay param builder, v2 `previewSettle`, `countPerfect` rename. Test: `keeper/test/contest.test.ts`.
- `keeper/create-parlay.ts` (rewrite of `create-contest.ts`), `keeper/settle-contest.ts`, `keeper/init-jackpot.ts` (rewrite of `init-vault.ts`), `keeper/void-contest.ts` (new), `keeper/list-slate.ts` (optional selector print).

**Phase D — web**
- `web/src/lib/pdas.ts`, `web/src/lib/anchorClient.ts` — jackpot PDA + drop vault. Test: `web/test/lib.test.ts`.
- `web/src/lib/api.ts` — `getContestLive`, `getJackpot`, types. `web/src/components/SweepstakeView.tsx` — parlay view. `web/src/components/OverUnderSelector.tsx` (new 2-way control). `web/src/App.css` — `.r2` styles.

**Phase E — deploy + wire live** (operational, user-gated): deploy v2, `init-jackpot`, `create-parlay`, verify in the running app.

---

## Task 1: IDL regen + sync + `marketId 16`

**Files:**
- Regenerate: `target/idl/proofbet.json`; Copy: `web/src/idl/proofbet.json`
- Modify: `engine/src/markets.ts`
- Test: `engine/test/markets.test.ts`

- [ ] **Step 1: Regenerate + sync the v2 IDL.**

```bash
anchor build                                   # regenerates target/idl/proofbet.json from the merged v2 program
cp target/idl/proofbet.json web/src/idl/proofbet.json
# sanity: v2 markers present, address unchanged
grep -q '"name": "initialize_jackpot"' target/idl/proofbet.json && \
grep -q '"name": "market_ids"' target/idl/proofbet.json && \
grep -q 'By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ' target/idl/proofbet.json && echo "IDL v2 OK"
```
Expected: `IDL v2 OK`. The keeper (`keeper/settle.ts` `loadProofbetProgram`) and engine (`engine/src/chain.ts`) read `target/idl/proofbet.json`; the web bundles `web/src/idl/proofbet.json`. Both must be v2.

- [ ] **Step 2: Write the failing test** in `engine/test/markets.test.ts` — add a `marketId 16` spec and fix the catalog-shape assertions.

```ts
// in the existing describe for MARKET_TEMPLATE:
it("defines marketId 16 — 1st-Half Result, 3-way, settles at HT", () => {
  const m = MARKET_TEMPLATE.find((d) => d.marketId === 16)!;
  expect(m).toBeDefined();
  expect(m.group).toBe("result");
  expect(m.numBuckets).toBe(3);
  expect(m.settleAt).toBe("HT");
  expect(m.statKey).toBe(1001);     // 1st-half home goals
  expect(m.statKey2).toBe(1002);    // 1st-half away goals
  expect(m.op).toBe("subtract");    // home - away → sign maps to bucket
});
it("marketById resolves label/group for the 4 parlay legs", () => {
  expect([16, 15, 12, 11].map((id) => marketById(id)?.numBuckets)).toEqual([3, 2, 3, 2]);
});
// update the existing length/id-list assertions: template now has 7 markets, ids [10,11,12,13,14,15,16];
// "three-way" markets are now {12, 16} (both group:"result", numBuckets:3).
```
Run: `npm --prefix engine test -- markets` → FAIL (`marketId 16` undefined, `marketById` not exported).

- [ ] **Step 3: Add `marketId 16` + `marketById`** in `engine/src/markets.ts`.

Append to `MARKET_TEMPLATE` (after the `marketId 15` entry):
```ts
  {
    marketId: 16, label: "1st-Half Result", group: "result", line: 0,
    statKey: 1001, statKey2: 1002, op: "subtract",
    comparison: "greaterThan", threshold: 0, settleAt: "HT", numBuckets: 3,
  },
```
Add an exported lookup (source of truth for per-leg labels the engine reader joins on):
```ts
const BY_ID = new Map<number, MarketDef>(MARKET_TEMPLATE.map((d) => [d.marketId, d]));
export function marketById(id: number): MarketDef | undefined {
  return BY_ID.get(id);
}
```

- [ ] **Step 4: Run tests** → `npm --prefix engine test -- markets` PASS. Also `npm --prefix engine exec tsc -- --noEmit` clean.

- [ ] **Step 5: Commit.**
```bash
git add target/idl/proofbet.json web/src/idl/proofbet.json engine/src/markets.ts engine/test/markets.test.ts
git commit -m "feat(offchain): sync v2 IDL + add marketId 16 (1st-Half Result) + marketById"
```

---

## Task 2: Engine reader — jackpot, multi-contest, per-leg legs (`chain.ts`)

**Files:**
- Modify: `engine/src/chain.ts`
- Test: `engine/test/chain.contest.test.ts`

- [ ] **Step 1: Update the test mock + fixtures to v2 (failing first).** In `engine/test/chain.contest.test.ts`:
  - In the `@coral-xyz/anchor` mock, rename the account client `jackpotVault` → `jackpot` (`{ fetchNullable }`) and add `contest: { fetch, all }` (the new `all` stub for discovery). `contest.fetch`/`all` return v2 fields: `marketIds: [12,12,12,0,0]` (or `[16,15,12,11,0]`), `numLegs`, **no** `potSnapshot`, plus `getBalance(contestPda)` for the per-contest pot.
  - Rewrite the `entryOutcome` literal `ContestView` fixtures: `numMatches`→`numLegs`, drop `potSnapshot`, add `marketIds`.
  - Add a `readLiveContests` test: `contest.all()` returns two Open contests + one that throws on decode (old v1) → result has the two, skips the undecodable one.
  - Add a `readJackpot` test: `jackpot.fetchNullable` present → `pot = balance − rentFloor`; absent → `{ pot: "0" }` sentinel; genuine RPC error still rejects.

Run: `npm --prefix engine test -- chain.contest` → FAIL.

- [ ] **Step 2: Rework `chain.ts`.** Concrete edits (symbols from the map):
  - `deriveJackpotVaultPda` → **`deriveJackpotPda(programId)`** seed `[Buffer.from("jackpot")]`. Drop `JACKPOT_VAULT_SIZE`; add `JACKPOT_SIZE = 8 + 1`.
  - Replace `JackpotVaultView`/`readJackpotVault` with:
    ```ts
    export interface JackpotView { lamports: string; rentFloor: string; pot: string }
    export async function readJackpot(): Promise<JackpotView> {
      const p = getProgram(); const pda = deriveJackpotPda(p.programId);
      const acct = await p.account.jackpot.fetchNullable(pda);
      if (!acct) return { lamports: "0", rentFloor: "0", pot: "0" };          // pre-launch sentinel
      const conn = p.provider.connection;
      const lamports = BigInt(await conn.getBalance(pda));
      const rentFloor = BigInt(await conn.getMinimumBalanceForRentExemption(JACKPOT_SIZE));
      const pot = lamports > rentFloor ? lamports - rentFloor : 0n;
      return { lamports: lamports.toString(), rentFloor: rentFloor.toString(), pot: pot.toString() };
    }
    ```
    Keep the existing "genuine RPC error rejects vs missing-account sentinel" discipline (the `fetchNullable` null path = sentinel; a thrown network error propagates).
  - `ContestView`: rename `numMatches`→`numLegs`; **drop** `potSnapshot`; add `marketIds: number[]`, `legs: LegView[]`, and `pot: string` (the contest's own escrow). `LegView = { marketId, label, group, numBuckets, fixtureId, winningBucket: number | null }` — join `marketById(marketIds[i])` from `markets.ts` for `label/group/numBuckets`; `winningBucket` = `winning_buckets[i]` when settled else `null`.
  - Add a helper to read a contest's pot: `pot = getBalance(contestPda) − minimum_balance(8 + Contest::INIT_SPACE)`. Compute the Contest rent floor once via `getMinimumBalanceForRentExemption(CONTEST_SIZE)` where `CONTEST_SIZE` matches the IDL account size (read it from `program.account.contest.size` if exposed, else a constant derived from the struct).
  - Map a fetched contest account → `ContestView` in a shared `toContestView(pubkey, acct, pot)` so `readLiveContests` and the entries path reuse it.
  - Replace `readActiveContest` with:
    ```ts
    export async function readLiveContests(): Promise<ContestView[]> {
      const p = getProgram();
      let all: { publicKey: PublicKey; account: any }[] = [];
      try { all = await p.account.contest.all(); } catch { return []; }
      const out: ContestView[] = [];
      for (const { publicKey, account } of all) {
        try {
          const pot = await readContestPot(publicKey);   // getBalance − rent floor
          out.push(toContestView(publicKey, account, pot));
        } catch { /* skip un-deserializable / stale v1 contest */ }
      }
      return out;
    }
    ```
    (Decode failures of old v1 contests surface as exceptions from `contest.all()` deserialization OR per-item; wrap defensively so one bad account never breaks the list.)
  - `entryOutcome` + `ContestOutcomeCtx`: rename `numMatches`→`numLegs` (loop bound). Math otherwise unchanged (distributable already includes folded jackpot post-settle).
  - `listEntriesForWallet(wallet, contestId?)`: keep memcmp (bettor@8, contest@40). When `contestId` given, scope to that contest's entries; otherwise iterate `readLiveContests()` and aggregate, tagging each `EntryView` with its `contestId`. Enrich via `entryOutcome` using that contest's `ContestOutcomeCtx`.

- [ ] **Step 3: Run** `npm --prefix engine test -- chain.contest` → PASS; `tsc --noEmit` clean.

- [ ] **Step 4: Commit.** `feat(engine): v2 chain reader — Jackpot PDA, multi-contest discovery, per-leg legs`

---

## Task 3: Engine routes — `/api/contest/live` + `/api/jackpot` (`routes.ts`, `server.ts`)

**Files:**
- Modify: `engine/src/routes.ts`, `engine/src/server.ts`
- Test: `engine/test/routes.test.ts`

- [ ] **Step 1: Failing tests** in `engine/test/routes.test.ts` (Fastify `app.inject`, partial-mock `../src/chain.ts`):
  - `GET /api/contest/live` → 200, **array**; each item has `contestId, status, pot, entryPrice, lockTs, settleAfterTs, entryCount, perfectCount, distributable, numLegs, match:{fixtureId,home,away,kickoffMs}, legs:[{marketId,label,group,numBuckets,winningBucket}]`. Empty when `readLiveContests()` returns `[]`.
  - `GET /api/jackpot` → 200, `{ pot: string }` from `readJackpot()`.
  - `GET /api/contest/entries?wallet=…` → unchanged shape (array of `ContestEntry`), now sourced from the multi-contest `listEntriesForWallet`.
  - Update the mock to stub `readLiveContests`, `readJackpot` (replacing `readActiveContest`/`readJackpotVault`).

Run: `npm --prefix engine test -- routes` → FAIL.

- [ ] **Step 2: Implement.** In `routes.ts`:
  - Update imports (line 4): `readActiveContest`→`readLiveContests`, `readJackpotVault`→`readJackpot`.
  - Replace the `GET /api/contest/today` handler with `GET /api/contest/live`: `const contests = await readLiveContests();` then for each, build `match` (join `store.getMatches()`/`getFixtureMeta()` by the contest's single `fixtures[0]`) and `legs` (from `contest.legs`). Return the array.
  - Add `GET /api/jackpot` → `return await readJackpot();` (or `{ pot }`).
  - Entries handler: keep `listEntriesForWallet(wallet)` (aggregated across live contests); pass `?contestId=` through if present.
  - In `server.ts`, `refreshContestNames`: replace `const c = await readActiveContest(); if(!c) return;` with `const cs = await readLiveContests();` then union all `cs[i].fixtures` (single fixture each) into the `wanted` set and resolve names across spanning days.

- [ ] **Step 3: Run** `npm --prefix engine test` (full) → PASS; `tsc --noEmit` clean.

- [ ] **Step 4: Commit.** `feat(engine): /api/contest/live (array) + /api/jackpot; multi-contest name refresh`

---

## Task 4: Keeper pure helpers — selector + v2 jackpot preview (`contest.ts`)

**Files:**
- Modify: `keeper/contest.ts`
- Test: `keeper/test/contest.test.ts`

- [ ] **Step 1: Failing tests** in `keeper/test/contest.test.ts` (pure, table-style):
  - `selectParlayMatches`: from a slate of 5 with varied kickoffs, `maxN=3, minGapMins=120` → returns ≤3, each ≥120 min after the previous, earliest-first; matches with `kickoffMs<=0` excluded; fewer than maxN when the day is thin.
  - `previewSettle` (v2): winners (jpool=0) → `distributable == pot−rake`, `share == distributable/perfectCount`, `jackpotIn==0`, `jackpotOut==0`. Rollover (`perfectCount=0`) → `distributable==0`, `jackpotOut==pot−rake`. Scoop (jpool>0, 1 winner) → `distributable==(pot−rake)+jpool`, `jackpotIn==jpool`, jackpot left at `dust`. Dust case → `payable==share*perfectCount`, `dust==raw−payable`. Edge `dust>jpool` (small pot, large perfectCount) → `jackpotOut==potNet−payable` (contest→jackpot). Mirror the exact lamport math in `programs/proofbet/src/instructions/settle_contest.rs`.

Run: `npm --prefix keeper test -- contest` → FAIL.

- [ ] **Step 2: Implement** in `keeper/contest.ts`.

```ts
export interface SlateMatch { fixtureId: number; home: string; away: string; kickoffMs: number }
/** Pick ≤maxN marquee matches with staggered (non-overlapping) kickoffs, earliest-first. */
export function selectParlayMatches(slate: SlateMatch[], maxN: number, minGapMins: number): SlateMatch[] {
  const gap = minGapMins * 60_000;
  const sorted = slate.filter((m) => m.kickoffMs > 0).sort((a, b) => a.kickoffMs - b.kickoffMs);
  const picked: SlateMatch[] = [];
  for (const m of sorted) {
    if (picked.length >= maxN) break;
    const last = picked[picked.length - 1];
    if (!last || m.kickoffMs - last.kickoffMs >= gap) picked.push(m);
  }
  return picked;
}

/** Parlay contest window: one fixture, 4 fixed legs. contest_id = fixtureId. */
export interface ParlayParams { contestId: number; fixtureId: number; marketIds: number[]; numLegs: number; lockTs: number; settleAfterTs: number }
export function parlayParams(fixtureId: number, kickoffMs: number, bufferSecs = 3 * 3600): ParlayParams {
  const lockTs = Math.floor(kickoffMs / 1000);
  return { contestId: fixtureId, fixtureId, marketIds: [16, 15, 12, 11], numLegs: 4, lockTs, settleAfterTs: lockTs + bufferSecs };
}

export interface SettlePreviewInput {
  contestLamports: bigint; contestRentFloor: bigint;
  jackpotLamports: bigint; jackpotRentFloor: bigint;
  entryCount: bigint; entryPrice: bigint; feeBps: number; perfectCount: bigint;
}
export interface SettlePreview {
  pot: bigint; rake: bigint; jpool: bigint; distributable: bigint;
  share: bigint; payable: bigint; dust: bigint; jackpotIn: bigint; jackpotOut: bigint; rolledOver: boolean;
}
export function previewSettle(i: SettlePreviewInput): SettlePreview {
  const max0 = (x: bigint) => (x > 0n ? x : 0n);
  const pot = max0(i.contestLamports - i.contestRentFloor);
  const jpool = max0(i.jackpotLamports - i.jackpotRentFloor);
  const rakeRaw = (i.entryCount * i.entryPrice * BigInt(i.feeBps)) / 10_000n;
  const rake = rakeRaw < pot ? rakeRaw : pot;
  const potNet = pot - rake;
  if (i.perfectCount === 0n) {
    return { pot, rake, jpool, distributable: 0n, share: 0n, payable: 0n, dust: 0n, jackpotIn: 0n, jackpotOut: potNet, rolledOver: true };
  }
  const raw = potNet + jpool;
  const share = raw / i.perfectCount;
  const payable = share * i.perfectCount;
  const dust = raw - payable;
  const jackpotIn = payable >= potNet ? payable - potNet : 0n;
  const jackpotOut = payable >= potNet ? 0n : potNet - payable;
  return { pot, rake, jpool, distributable: payable, share, payable, dust, jackpotIn, jackpotOut, rolledOver: false };
}
```
Rename `countPerfect`'s `numMatches` param → `numLegs` (logic unchanged). Keep/remove the old `computeContestParams`/`SettlePreviewInput`(v1) as needed (delete the v1 `previewSettle` body it replaces; update any importers in the same commit).

- [ ] **Step 3: Run** `npm --prefix keeper test -- contest` PASS; `npm --prefix keeper run typecheck` clean.

- [ ] **Step 4: Commit.** `feat(keeper): selectParlayMatches + parlayParams + v2 jackpot-aware previewSettle`

---

## Task 5: Keeper `create-parlay` CLI (`create-parlay.ts`)

**Files:**
- Create: `keeper/create-parlay.ts` (supersedes `keeper/create-contest.ts` — delete the old v1 file)
- (uses `keeper/contest.ts`, `engine/src/markets.ts` `MARKET_TEMPLATE`/`toInitArgs`)

- [ ] **Step 1:** Implement `create-parlay.ts`. CLI: `npx tsx create-parlay.ts <fixtureId>:<isoKickoff> [more...]` (or `--auto` to run `selectParlayMatches` over the slate). For each carded fixture:
  1. `parlayParams(fixtureId, kickoffMs)` → `{ contestId=fixtureId, marketIds:[16,15,12,11], numLegs:4, lockTs, settleAfterTs }`.
  2. **Ensure the 4 result markets exist** on that ONE fixture: for `mid` in `[16,15,12,11]`, derive `[b"market", i64le(fixtureId), [mid]]`, and if absent call `initializeMarket(new BN(fixtureId), mid, toInitArgs(marketById(mid)!, keeper.publicKey, lockSec))`. (marketId 16 now exists in MARKET_TEMPLATE from Task 1.)
  3. Call v2 `createContest(new BN(contestId), padFixtures([fixtureId×4]), padMarketIds([16,15,12,11]), 4, new BN(entryPrice), new BN(lockTs), new BN(settleAfterTs), feeRecipient, feeBps)` with `accountsStrict({ keeper, contest: deriveContestPda(contestId), systemProgram })` — **no vault**.
  - `padFixtures`/`padMarketIds` pad to `[*;5]` with 0. Keep the `isMain` guard so tests can import without firing `main`.
  - Arg order (critical): `market_ids` between `fixtures` and `num_legs`; `fee_recipient` before `fee_bps`.

- [ ] **Step 2:** Pure-testable extraction: keep the card-building/arg-assembly logic as exported pure functions where reasonable (e.g. a `buildCreateArgs(fixtureId, kickoffMs, entryPrice, feeRecipient, feeBps)` returning the BN tuple) and unit-test it in `keeper/test/contest.test.ts` (assert market_ids/fixtures padding + num_legs + window). The RPC wiring stays in `main()`.

- [ ] **Step 3:** `npm --prefix keeper test` + `typecheck` clean. **Step 4: Commit.** `feat(keeper): create-parlay CLI (4 legs on one fixture, v2 create_contest, contest_id=fixtureId)`

---

## Task 6: Keeper `settle-contest` v2 (jackpot + per-leg, multi-contest)

**Files:**
- Modify: `keeper/settle-contest.ts`
- (reuses `keeper/settle.ts` `settleMarketByPubkey`, `keeper/settle-all.ts` `marketsToSettle`)

- [ ] **Step 1:** Implement. CLI: `npx tsx settle-contest.ts --contest-id <fixtureId> [--dry-run]` (or enumerate Open contests via `program.account.contest.all()` filtered to `status==Open && settle_after_ts<=now` when no id given).
  1. Fetch the contest; read `numLegs`, `fixtures[0..numLegs]`, `marketIds[0..numLegs]`.
  2. **Settle the legs in two waves** using `marketsToSettle(phaseCode, legs.map(l => ({marketId:l.marketId, settleAt: marketById(l.marketId)!.settleAt})))` — HT legs (15,16) once H1 final, FT legs (11,12) once full-game final. For each settleable leg derive `[b"market", i64le(fixtures[i]), [marketIds[i]]]` and call `settleMarketByPubkey` (handles 3-way vs 2-way generically; market 16 = 3-way sign map).
  3. Read each leg's `winning_bucket`; if any leg is genuinely abandoned (no bucket), **abort and direct the operator to `void-contest`** (don't settle).
  4. `entry.all` memcmp on `contest` @ offset 40 → `countPerfect(entries, winningBuckets, numLegs)`.
  5. **Audit (always print, dry-run and live):** read `getBalance(contestPda)` + Contest rent floor → `contestLamports`; read `getBalance(jackpotPda)` + jackpot rent floor → `jackpotLamports`; call the v2 `previewSettle({...})`; print `pot, rake, jpool, distributable, share, dust, jackpotIn, jackpotOut, rolledOver` + the perfect_count.
  6. Enforce `perfectCount <= entryCount` (matches on-chain guard `PerfectCountExceedsEntries`); abort with a clear message otherwise.
  7. If not `--dry-run`: `settleContest(new BN(perfectCount)).accountsStrict({ settleAuthority: keeper, jackpot: deriveJackpotPda(), contest, feeRecipient }).remainingAccounts(legMarkets /* leg order */)`.
  - Drop `JACKPOT_VAULT_SIZE`, `jackpot_vault.activeContestId`, `reserved`, the hard-coded `RESULT_MARKET_ID=12`.

- [ ] **Step 2:** Keep any newly-extracted pure decisions (e.g. "which legs settle now", "abort-to-void") testable; rely on existing `keeper/test/settle-all.test.ts` for `marketsToSettle`. Manual integration is covered in Phase E.

- [ ] **Step 3:** `typecheck` + `npm --prefix keeper test` clean. **Step 4: Commit.** `feat(keeper): settle-contest v2 — per-leg market_ids, two-wave, jackpot-aware preview`

---

## Task 7: Keeper `init-jackpot` + `void-contest` CLIs

**Files:**
- Create: `keeper/init-jackpot.ts` (supersedes `keeper/init-vault.ts` — delete old)
- Create: `keeper/void-contest.ts`

- [ ] **Step 1: `init-jackpot.ts`** — derive `[b"jackpot"]`, `program.account.jackpot.fetchNullable` for idempotency, else `initializeJackpot().accountsStrict({ keeper, jackpot, systemProgram })`. Print created/exists + bump. `isMain` guard.
- [ ] **Step 2: `void-contest.ts`** — CLI `npx tsx void-contest.ts --contest-id <fixtureId>`: fetch the contest, require `status==Open`, print a confirmation summary (entry_count, pot), then `voidContest().accountsStrict({ settleAuthority: keeper, contest })`. After void, refunds happen per-ticket via `claim_contest`'s Voided branch (no further keeper action). `isMain` guard. (This is the abandoned-match insurance the program-plan deferred to off-chain.)
- [ ] **Step 3:** `typecheck` clean. **Step 4: Commit.** `feat(keeper): init-jackpot + void-contest CLIs (v2)`

---

## Task 8: Web PDAs + tx builders (drop vault, jackpot seed)

**Files:**
- Modify: `web/src/lib/pdas.ts`, `web/src/lib/anchorClient.ts`
- Test: `web/test/lib.test.ts`

- [ ] **Step 1: Failing test** in `web/test/lib.test.ts` — replace the `deriveJackpotVaultPda` case with `deriveJackpotPda(P)`: assert it's a `PublicKey`, stable, and differs from `deriveContestPda(P, 1)`. (No contestId arg.)

Run: `npm --prefix web test` → FAIL.

- [ ] **Step 2:** In `pdas.ts`, replace `deriveJackpotVaultPda` with `deriveJackpotPda(programId)` seed `[Buffer.from("jackpot")]` (no contestId). `deriveContestPda`/`deriveEntryPda` unchanged. In `anchorClient.ts`:
  - `buildEnterTx`: remove the `vault` derivation + account → `accountsStrict({ bettor, contest, entry, systemProgram })`. Keep picks pad-to-5.
  - `buildClaimContestTx`: remove `vault` → `accountsStrict({ bettor, contest, entry, systemProgram })`.
  - Remove the now-unused `deriveJackpotVaultPda` import. (The web never builds settle/void/create — those are keeper-side — so no jackpot account is referenced by any web tx.)

- [ ] **Step 3:** `npm --prefix web test` PASS; `npm --prefix web run build` (the `tsc --noEmit && vite build` gate) — `accountsStrict` now typechecks against the v2 IDL (it would fail if account names mismatched). PASS.

- [ ] **Step 4: Commit.** `feat(web): v2 PDAs + tx builders (drop vault, jackpot seed)`

---

## Task 9: Web parlay view + 2-way O/U control

**Files:**
- Create: `web/src/components/OverUnderSelector.tsx`
- Modify: `web/src/components/SweepstakeView.tsx`, `web/src/lib/api.ts`, `web/src/App.css`

- [ ] **Step 1: `api.ts`** — add types + clients:
  ```ts
  export interface ParlayLeg { fixtureId: number; marketId: number; label: string; group: "result" | "goals"; numBuckets: 2 | 3; line?: number; winningBucket: number | null }
  export interface ContestLive {
    contestId: number; status: "open" | "settled" | "rolledOver" | "voided"; pot: string;
    entryPrice: string; lockTs: number; settleAfterTs: number; entryCount: number;
    perfectCount: number; distributable: string;
    match: { fixtureId: number; home: string; away: string; kickoffMs: number | null };
    legs: ParlayLeg[];
  }
  export const getContestLive = (): Promise<ContestLive[]> => fetch(`${ENGINE}/api/contest/live`).then(json);
  export const getJackpot = (): Promise<{ pot: string }> => fetch(`${ENGINE}/api/jackpot`).then(json);
  ```
  Keep `ContestEntry` verbatim (won/claimable/payout/picks). `getContestEntries(wallet)` unchanged.

- [ ] **Step 2: `OverUnderSelector.tsx`** — a 2-button pick control (bucket `0=Over, 1=Under`), styled with new `.r2`/`.r2-over`/`.r2-under` classes (parallel to `.r3`). Props: `{ value: number | undefined; onPick: (b: number) => void; line: number; disabled?: boolean }`. Pure presentational, no stake input.

- [ ] **Step 3: `SweepstakeView.tsx`** — convert to the parlay view:
  - `refresh()` calls `getContestLive()` + `getJackpot()` (+ `getContestEntries`).
  - Render the **jackpot headline** from `getJackpot().pot`; then `.map` over 1–3 `ContestLive` cards (factor a `ParlayCard` child or key all state — `picks`, `openTicket`, `busy` — by `contestId`).
  - Each card: a match header (`home v away`, kickoff) + the **4 fixed legs in order** `[16,15,12,11]`: 3-way legs (16,12) reuse the existing `.r3` 3-way buttons; 2-way legs (15,11) use `OverUnderSelector`. **`picks` key by leg index 0..3** (NOT fixtureId — all legs share one fixtureId). `orderedPicks = legs.map((_,i)=>picks[i])` padded to 5.
  - `enter()`/`claim()` reuse `buildEnterTx`/`buildClaimContestTx` with the same nonce multi-ticket logic, passing the card's `contestId`.
  - **Reuse verbatim** (the v1 polish per spec §7): the Your-tickets block — status pill Won/No-win/Refund, Claim gated on `e.claimable`, expandable per-ticket caret. Only the per-leg label mapping inside changes: 3-way legs use `home/Draw/away`, 2-way legs use `Over/Under` (use the leg's `numBuckets` to pick the labeler). Entries are grouped by `contestId`.
  - Empty state: `getContestLive() == []` → "No live parlays right now."

- [ ] **Step 4:** `web/src/App.css` — add `.r2`, `.r2-over`, `.r2-under` (mirror `.r3` styling). Optionally relabel the `sweepstake` tab to "Parlay" in `BottomNav.tsx`.

- [ ] **Step 5:** `npm --prefix web run build` (typecheck+build) PASS. **Step 6: Commit.** `feat(web): single-match parlay view (4 legs, O/U control, 1–3 cards, jackpot headline)`

---

## Task 10: Deploy v2 + wire live (operational — USER-GATED)

> This task changes devnet and is gated on a deploy-target decision. Do NOT run it without confirmation. It does not affect the unit-tested Tasks 1–9.

- [ ] **Decision:** how to deploy v2 to devnet:
  - **(A) Fresh program id** — generate a new program keypair, set `declare_id!` + `Anchor.toml` + `PROOFBET_PROGRAM_ID` (engine/.env) + IDL `address`, `anchor deploy`. Unblocks immediately; leaves v1 + contest 20635 untouched on the old id. **Recommended for an immediate demo.**
  - **(B) In-place upgrade (same id)** — first **settle/finish contest 20635** (runbook `docs/settle-claim-runbook.md`, dated), then `anchor upgrade`. Keeps one id; date-gated; the v2 layout makes any leftover v1 contest undecodable, so 20635 must be closed first.
- [ ] **Steps (after the decision):** `anchor deploy`/`upgrade` → re-sync IDL (Task 1 Step 1) if the id changed → `npx tsx keeper/init-jackpot.ts` → `npx tsx keeper/create-parlay.ts <fixtureId>:<iso>` (or `--auto`) → restart engine + web → verify in the running app: jackpot headline, a parlay card with the 4 legs, enter a ticket, see it in "Your tickets". Use the preview tooling (`.claude/launch.json` engine+web) for the visual check.

---

## Final review (after Tasks 1–9)
- [ ] `npm --prefix engine test && npm --prefix keeper test && npm --prefix web test` all green; `tsc --noEmit` clean in engine/keeper, `vite build` clean in web.
- [ ] Adversarial review (Workflow) of the v2 `previewSettle` (must mirror `settle_contest.rs` exactly), the multi-contest discovery (tolerates stale v1 accounts), and the leg/bucket encoding consistency across markets.ts ↔ engine reader ↔ web picks ↔ keeper settle order.
- [ ] Merge `feat/parlay-offchain` `--no-ff` into `feat/streak-pivot`.

## Out of scope (future)
- Live "still-alive at HT" board, streak chip, jackpot history (spec §10 M1).
- 2nd-half legs (needs proof-pipeline extension).
- On-chain result-proof verification (vs trusted keeper).
- The float-yield / staking monetization (separate back-burner — see memory `streak-float-yield-monetization`).
