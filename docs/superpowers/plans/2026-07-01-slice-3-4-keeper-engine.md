# Slice 3 (keeper feed→calls) + Slice 4 (engine read routes) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is TDD: write the failing test, watch it fail, implement minimally, watch it pass, commit.

**Goal:** Build the off-chain backend that drives the already-deployed live-match program (`By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ`, devnet) — a keeper that composes a match pool, delegates to the ER, paces calls, resolves outcomes from the TxLINE feed, scores, and settles on-chain (Slice 3); plus engine read routes that expose live pools/standings/entries to the web app (Slice 4).

**Architecture:** Slice 3 adds pure helper modules (`keeper/live-pda.ts`, `keeper/live-feed.ts`) + two CLIs (`keeper/create-match-pool.ts`, `keeper/live-runner.ts`) + a cron job. The live-runner is a productionization of the **proven** `spike/live-er/proof.ts` dual-RPC sequence (base RPC + ER RPC). Slice 4 adds size-filtered `getProgramAccounts` readers to `engine/src/chain.ts` + three `/api/live/*` routes to `engine/src/routes.ts`, mirroring the existing contest readers/routes. Both slices reuse existing plumbing; **no new npm deps, no program redeploy.**

**Tech Stack:** TypeScript (keeper = tsx/NodeNext ESM, vitest; engine = Fastify, vitest), `@coral-xyz/anchor` (CJS default-import idiom), Solana web3.js, MagicBlock ER (base + `devnet.magicblock.app`).

**Execution model:** subagent-driven-development, one subagent per task, spec-review then code-review between tasks. Slice 3 and Slice 4 are **independently shippable** (Slice 4 has no Slice 3 dependency — it only reads on-chain state).

**Full integration maps (exact signatures, all 5 clusters):** `/private/tmp/claude-501/-Users-yordanlasonov-Documents-GitHub-ProofBet/46bd0e01-2d04-4b77-9b0e-51691b11f85d/tasks/wdxy5ixt6.output` (`.result.maps`). Read for any signature not embedded below.

---

## Reference data (byte-exact — do NOT re-derive; verified against `live_state.rs`)

**On-chain account layouts** (size = 8-byte discriminator + INIT_SPACE, no padding, enums = 1 byte):

| Account | Size | Discriminator | Key fields (offset) |
|---|---|---|---|
| `LivePool` (base only, never delegated) | **176** | `[92,143,234,29,14,252,15,4]` | pool_id u64@8, fixture_id i64@16, settle_authority @24, fee_recipient @56, entry_price u64@88, lock_ts i64@96, settle_after_ts i64@104, fee_bps u16@112, status u8@114, num_calls u32@115, player_count u64@119, winning_score u64@127, winner_count u64@135, distributable u64@143, claimed_count u64@151, claimed_total u64@159, settled_ts i64@167, bump@175 |
| `LiveCursor` (delegated) | **53** | `[129,109,80,87,174,244,76,251]` | pool @8, next_seq u32@40, open_seq u32@44, resolved_count u32@48, bump@52 |
| `Call` (delegated) | **62** | `[62,231,169,58,154,150,83,196]` | pool @8, seq u32@40, kind u8@44, state u8@45, opened_ts i64@46, answer_secs u16@54, num_options u8@56, base_points [u8;3]@57, outcome u8@60, bump@61 |
| `LiveEntry` (delegated per-player) | **159** | `[167,229,158,50,91,121,249,22]` | player @8, pool @40, amount u64@72, base_pts u32@80, bonus_pts u32@84, streak u16@88, next_score_seq u32@90, picks [u8;64]@94, bump@158 |

**Enums (u8):** `PoolStatus{Open0,Live1,Ended2,Settled3,RolledOver4,Voided5}` · `CallKind{NextGoal0,GoalRush1,CornerSoon2,CardSoon3}` · `CallState{Empty0,Open1,Resolved2,Voided3}`.
**Sentinels/consts:** `VOID_OUTCOME=0xFE`, `OUTCOME_UNSET=0xFF`, `NO_PICK=0xFF`, `NONE_SEQ=u32::MAX=4294967295`, `MAX_CALLS=64`, `MAX_FEE_BPS=1000`, `VOID_GRACE_SECS=259200` (3d).
**PDA seeds:** livepool `[b"livepool", u64le(pool_id)]` · livecursor `[b"livecursor", pool.key]` · call `[b"call", pool.key, u32le(seq)]` (**u32 seq, 4 bytes — NOT u64**) · liveentry `[b"liveentry", pool.key, player.key]` · jackpot `[b"jackpot"]`.
**Standings total** = `base_pts + bonus_pts` (both u32 LE; there is NO stored total).
**List a pool's entries:** `liveEntry.all([{memcmp:{offset:40, bytes: pool.toBase58()}}])` (pool@40, verified).

**Dual-RPC constants** (from `spike/live-er/proof.ts:29-34`, runtime-verified):
`BASE_RPC=https://api.devnet.solana.com` · `ER_RPC=https://devnet.magicblock.app` · `DELEGATION_PROGRAM=DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` · `VALIDATOR=MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (pinned as `remainingAccounts[0]` on every `delegate_*`).

**Anchor idioms (mandatory):**
- CJS interop: `import anchorDefault from '@coral-xyz/anchor'; const { BN } = anchorDefault;` (named/namespace imports break under tsx/NodeNext).
- IDL is **snake_case** but you call **camelCase** methods: `.createLivePool()`, `.preallocCall()`, `.openCall()`, `.resolveCall()`, `.settleLivePool()`, `.scoreEntry()`, `.commitLive()`, `.endAndUndelegate()`, `.endLivePool()`, `.voidLivePool()`, `.refundVoided()`, `.delegateCursor/Entry/Call()`.
- Account-name casing: IDL JSON is PascalCase (`LivePool`) but `coder.memcmp/decode` + `program.account.<k>` keys are **camelCase** (`livePool`, `liveEntry`, `call`, `liveCursor`).
- i64/u64 args → `new BN(...)`; u32 (`num_calls`, `seq`) and `[u8;3]` arrays → plain `number`/`number[]`.
- `settle_ts` is **milliseconds** (matches `v.summary.updateStats.minTimestamp`).

**Resolve model (fills the "spec gap"):** `resolve_call(outcome:u8)` takes a **winning option index**, not a raw stat. Proof core reused verbatim from `keeper/settle.ts:143-159` → `fetchStatValidation → buildBaseArgs → viewValidate(ctx.program /* Txoracle 6pW64gN… */, base, {threshold, comparison}, op)`. Per kind:
- **NextGoal** (3 opts, base_points [4,1,4]): compare Δ(P1_GOALS) vs Δ(P2_GOALS) since call open → home→0, no-goal→1, away→2.
- **GoalRush/CornerSoon/CardSoon** (2 opts): watched stat rose within the answer window → hit→0, miss→1. (GoalRush→goals, CornerSoon→corners keys 7/8, CardSoon→yellows keys 3/4.)
- **Void-on-goal (global, §1.0.1):** cumulative goal total `Stats['1']+Stats['2']` rose while a non-goal call is open → `resolveCall(seq, 0xFE)`.
- **Feed source:** `getScoreHistory(ctx, auth, fixtureId)` → `ScoreEvent[]` (PascalCase; `Stats` map keyed by period-encoded statKey **string**). Highest `Seq` carries the freshest cumulative stats. Phase via `resolvePhase(ev)`: FINISHED `{5,10,13}`→FT settle, VOID `{14..19}`→void, HT=3 ≠ FT.
- **Feed reality:** devnet is Level-1 **60s-delayed** data on neutral priors; real-money mainnet needs Level-12 (documented, not solved).

---

## Adopted defaults for the synthesized open questions (technical — resolved here)

- **Invocation model:** in-process `runLiveMatch(poolPda, opts)` exported from `live-runner.ts` (testable, shares Program instances) — cron calls it directly. Not a spawn-CLI.
- **Scheduling:** new env `LIVE_INTERVAL_SEC` (default **30**); a **per-pool** in-flight guard (a `Set<string>` of pool pubkeys) so multiple matches run concurrently but a single pool never overlaps itself. Independent of the 10-min settle job. Documented against the 60s data delay.
- **Call composition/cadence:** mirror `web/src/lib/liveGame.ts` `spawnCall` (kinds + weights + 9s windows); `num_calls` is a `create-match-pool` CLI flag (default 8, ≤64).
- **Resolve predicates:** as in the Resolve model above.

**Deferred to real-money mainnet hardening (flagged, not blocking devnet):** (1) split `settle_authority`/`fee_recipient` from the hot keeper key; (2) keeper-death watchdog/failover (the `refund_voided` + 3-day grace is the current backstop); (3) under-filled-pool auto-void + player notification UX (Slice 5). These need explicit product/security sign-off before mainnet.

---

## SLICE 3 — Keeper: feed → call outcomes

### Task S3-T1: Pure PDA + encoding helpers (`keeper/live-pda.ts`)
**Files:** Create `keeper/live-pda.ts`, `keeper/test/live-pda.test.ts`
Export `u32le`/`u64le`/`i64le` (copy `create-parlay.ts:159-160`; add 4-byte `u32le`) and PDA derivers mirroring `proof.ts:53-61`: `livePoolPda`, `liveCursorPda`, `callPda` (**u32le seq**), `liveEntryPda`, `jackpotPda` — all `PublicKey.findProgramAddressSync`. Pure, no I/O.
- [ ] Tests: `livePoolPda` matches a hardcoded expected base58 for a fixed poolId/programId; `callPda` uses **u32le** (assert `callPda(...,0) !=` an 8-byte-seq variant — guards the u32/u64 trap); `u64le` vs `i64le` differ for a negative i64 but match for positive.

### Task S3-T2: `create-match-pool.ts` — createLivePool + prealloc loop (BASE)
**Files:** Create `keeper/create-match-pool.ts`, `keeper/test/create-match-pool.test.ts`
Clone `create-parlay.ts:63-160` structure: `import 'dotenv/config'`, parseArgs (positional `<fixtureId>:<iso>` + flags), `createContext()`, `loadProofbetProgram(ctx.provider)`, `keeper=ctx.wallet.publicKey`. `pool_id == fixture_id`. `createLivePool(new BN(poolId), new BN(fixtureId), new BN(entryPrice), new BN(lockTs), new BN(settleAfterTs), feeRecipient, feeBps, numCalls).accountsStrict({keeper, pool, cursor, systemProgram}).rpc()` (8 args in order). Then loop `seq=0..numCalls-1` → `preallocCall(seq).accountsStrict({keeper, pool, call: callPda(...), systemProgram}).rpc()`. Export pure `buildCreateLiveArgs(fixtureId, kickoffMs, opts)`. `isMain` guard `endsWith('create-match-pool.ts')`.
- [ ] Tests: `buildCreateLiveArgs` throws on each invariant violation (pool_id≠0, fixture_id≠0, entry_price>0, fee_bps≤1000, 1≤num_calls≤64, now<lock_ts<settle_after_ts); `poolId===fixtureId`; prealloc loop emits exactly `numCalls` calls with seq 0..n-1 (spy); `--dry-run` performs zero `.rpc()`.

### Task S3-T3: Pure feed→outcome + void-on-goal (`keeper/live-feed.ts`)
**Files:** Create `keeper/live-feed.ts`, `keeper/test/live-feed.test.ts`
Export pure fns: `goalTotal(stats)` = `Number(stats['1']??0)+Number(stats['2']??0)`; `latestEvent(events)` = max-`Seq`; `mapOutcomeToOption(kind, deltas)` → option index (per Resolve model); `shouldVoidOnGoal(openKind, prevGoals, curGoals)` → true iff goals rose AND openKind ∉ {NextGoal,GoalRush}; `callSpec(kind)` → `{numOptions, basePoints, answerSecs:9}` from liveGame weights; `detectPhase(event)` wrapping `resolvePhase` → `'ft'|'void'|'ht'|'live'`.
- [ ] Tests: `goalTotal` reads string keys `'1'/'2'`, missing→0; `mapOutcomeToOption` NEVER returns 0xFE/0xFF or index ≥ num_options (real-money safety); `shouldVoidOnGoal` true for CornerSoon/CardSoon on a goal rise, **false** for NextGoal/GoalRush and when goals unchanged; `detectPhase` `{5,10,13}`→ft, `{14..19}`→void, `3`→ht (replay real `discover.ts` fixtures); `callSpec(NextGoal)`= `{3,[4,1,4]}`.

### Task S3-T4: `live-runner.ts` core — dual-RPC construction + `step()` harness
**Files:** Create `keeper/live-runner.ts`, `keeper/test/live-runner.test.ts` (deps: S3-T1, S3-T3)
Clone `proof.ts:64-70` VERBATIM: two `Connection` (base/ER), one shared `Wallet(keeper)`, two `AnchorProvider`, two `Program(idl)` named `base`/`er` with `idl.address=PROGRAM_ID` injected first. Port `step(name, fn)` (`proof.ts:74-91`) recording `{name,ms,ok,sig,err,logs}`. Export in-process `runLiveMatch(poolPda, opts)`. `isMain` guard. Harness/report/wiring only.
- [ ] Tests: `step()` records `ok:true`+sig for a resolving fn and `ok:false`+captured err/logs for a throwing fn; `base.provider.connection.rpcEndpoint===BASE_RPC` and `er...===ER_RPC`; `idl.address` overwritten to PROGRAM_ID; importing the module fires no network calls (isMain guard).

### Task S3-T5: live-runner delegation phase — player-count gate + delegate_* (BASE)
**Files:** Modify `keeper/live-runner.ts`, `keeper/test/live-runner.test.ts` (deps: S3-T4)
Per `proof.ts:179-205`: gather seats via `liveEntry.all([{memcmp:{offset:40,bytes:pool}}])`. **HARD GATE:** `player_count<2` → skip delegation, route to void+refund (S3-T7). Else `delegateCursor().accountsPartial({keeper,pool,pda:cursor}).remainingAccounts([{pubkey:VALIDATOR,isSigner:false,isWritable:false}])`; per seat `delegateEntry(player)` (`pda:entry`); per seq `delegateCall(seq)` (`pda:call`) — account key is generic **`pda`**, plus the validator remainingAccount. Then ER-visibility gate: poll `erConn.getAccountInfo(cursor)` every 2500ms up to 60000ms until `owner.equals(PROGRAM_ID)`. Export pure `sortSeatsAscending(pubkeys)`.
- [ ] Tests: seats<2 → zero delegate calls + void branch; every `delegate_*` carries `remainingAccounts[0]===VALIDATOR`; `delegateEntry`×seats, `delegateCall`×numCalls; the account key literally is `pda`; the ER poll proceeds only when owner===PROGRAM_ID (a DELEGATION_PROGRAM-owner mock keeps polling).

### Task S3-T6: live-runner ER gameplay — open/resolve/score/commit (ER)
**Files:** Modify `keeper/live-runner.ts`, `keeper/test/live-runner.test.ts` (deps: S3-T5)
On the `er` Program: `openCall(seq, {<kind>:{}}, numOptions, basePoints, answerSecs).accountsPartial({keeper,pool,cursor,call})` enforcing `cursor.open_seq===NONE_SEQ` and `seq===cursor.next_seq`. Resolve via `settle.ts:143-159` core on **`ctx.program` (Txoracle)** → `mapOutcomeToOption` → `resolveCall(optionIndex | 0xFE).accountsPartial({keeper,pool,cursor,call})`. `scoreEntry().accountsPartial({cranker:keeper,call,entry})` per seat (key **`cranker`**). `commitLive().accountsPartial({keeper,pool}).remainingAccounts([cursor,...entries,...calls].map(pubkey=>({pubkey,isSigner:false,isWritable:true})))` after each resolve.
- [ ] Tests: `viewValidate` receives the **Txoracle** Program (not proofbet); resolve outcome ∈ [0,num_options) or exactly 0xFE, never 0xFF; no second `openCall` while one is open; `scoreEntry` uses key `cranker`, once/seat; `commitLive` remainingAccounts = full writable [cursor, entries, calls]; a goal-rise while CornerSoon open → `resolveCall(…,0xFE)`.

### Task S3-T7: live-runner end→settle→void/refund (BASE)
**Files:** Modify `keeper/live-runner.ts`, `keeper/test/live-runner.test.ts` (deps: S3-T5, S3-T6)
FT (`detectPhase==='ft'`): `endAndUndelegate().accountsPartial({keeper,pool}).remainingAccounts(<same full writable list>)`; poll base until `cursor` (and ≥1 entry) `owner.equals(PROGRAM_ID)` every 3000ms/timeout 90000ms (~21s first flip); `endLivePool().accountsPartial({keeper,pool,cursor})`; gate on-chain clock `getBlockTime(getSlot()) >= settleAfterTs+1` (never wall-clock); `settleLivePool().accountsPartial({settleAuthority:keeper, jackpot, pool, cursor, feeRecipient:keeper}).remainingAccounts(sortSeatsAscending(seats).map(pubkey=>({pubkey,isSigner:false,isWritable:false})))` — **entries only, ascending, exactly player_count, NO score args**. VOID path (`'void'` or player_count<2): `voidLivePool().accountsPartial({settleAuthority:keeper,pool})`; if still delegated, `refundVoided` with **interleaved [entry,player] pairs** (len=player_count*2). Players claim later.
- [ ] Tests: settle remainingAccounts are entries-only, ascending, len=player_count, all `isWritable:false`; refund remainingAccounts are interleaved `[e0,p0,e1,p1,…]` len=player_count*2 (assert the shapes differ); ordering endAndUndelegate→pollBase→endLivePool→settle; settle gated on `getBlockTime≥settleAfterTs+1`; settle called with **no** winner/score arg; player_count<2 routes to void+refund.

### Task S3-T8: Wire fast live job into `cron.ts`
**Files:** Modify `keeper/cron.ts`, `keeper/test/cron.test.ts` (deps: S3-T4)
Add a SECOND independent job mirroring the `settling` flag (`cron.ts:219-227`): a **per-pool** in-flight `Set` + `tickLive()` that discovers Open/Ended live pools and drives `runLiveMatch` per pool; run once on boot + `setInterval(LIVE_INTERVAL_SEC*1000)`. Existing settle (10-min) + daily-create jobs UNTOUCHED. Add a pure `liveIntervalMs(env)` next to `msUntilNextUtcHour` for unit testing.
- [ ] Tests: a pool already in-flight is skipped (per-pool guard); the guard clears in `finally` even when a pass throws; the live interval derives from `LIVE_INTERVAL_SEC` (default asserted) independent of `SETTLE_INTERVAL_MIN`; existing job intervals unchanged (regression).

---

## SLICE 4 — Engine read routes (independent of Slice 3)

### Task S4-T1: `chain.ts` readers — `readLivePools` + `readCall` (size-filtered)
**Files:** Modify `engine/src/chain.ts`, Create `engine/test/live-routes.test.ts`
Clone `readLiveContests` (`chain.ts:323-365`): `coder.memcmp('livePool'|'call')` (camelCase), `size=(program.account as any).livePool.size` (**runtime read, not hardcoded 176**), `getProgramAccounts` with `[{memcmp:disc},{dataSize:size}]`; skip `data.length!==size`, `try{coder.decode(...)}catch{continue}`; wrap memcmp+RPC in one try/catch → `return []`. `readCall(pool)` adds `{memcmp:{offset:8,bytes:pool}}`. Note: delegated accounts have flipped `.owner` but data stays readable and `dataSize` still finds them; do not depend on program-ownership.
- [ ] Tests: reads `.size` at runtime and passes `dataSize:176` (assert the filter, not a literal); a 200-byte account sharing the disc is skipped; a memcmp throw → `[]` not throw; `readCall(pool)` adds `{offset:8,bytes:pool}`; uses camelCase `'livePool'/'call'`.

### Task S4-T2: `chain.ts` scoped reads + View mappers
**Files:** Modify `engine/src/chain.ts`, `engine/test/live-routes.test.ts` (deps: S4-T1)
`readLiveCursor(pool)` = `liveCursor.fetch(cursorPda)` catch→null. `readLiveEntry(wallet, poolId)` via `liveEntry.all([{memcmp:{offset:8,bytes:wallet}},{memcmp:{offset:40,bytes:pool}}])`. `*View` mappers mirroring `toContestView` (`chain.ts:268-309`): `.toBase58()` pubkeys, `.toNumber()` small BNs, **`.toString()` every lamport BN** (never BigInt); enums via `'variant' in obj`; `LiveEntry.total=base_pts+bonus_pts`; picks 0xFF→null; Call.outcome 0xFF→null, 0xFE→`'void'`, else index.
- [ ] Tests: `readLiveEntry` memcmp offsets 8 (wallet) + 40 (pool); `toLivePoolView` emits entry_price/distributable/claimed_total as **strings**, player_count/num_calls as numbers (no BigInt survives `JSON.stringify`); status `{settled:{}}`→`'settled'`; `total===base_pts+bonus_pts`; picks 0xFF→null, outcome 0xFE→`'void'`; `readLiveCursor`→null on missing.

### Task S4-T3: `routes.ts` — `/api/live/pool` + `/pool/:id/standings` + `/entry`
**Files:** Modify `engine/src/routes.ts`, `engine/test/live-routes.test.ts` (deps: S4-T2)
In `registerRoutes(app, store?)`: (1) `GET /api/live/pool?fixtureId=` — missing→400; chain read try/catch→502; empty→200 `{pool:null}` (never 404); enrich with the fixture-name join (`routes.ts:147-160`) + `livePhase(...)` drama fold. (2) `GET /api/live/pool/:id/standings` — all entries for pool, sort by `total` desc, empty→200 `[]`. (3) `GET /api/live/entry?wallet=&poolId=` — both params or 400; missing→200 `{entry:null}`. All lamports as strings.
- [ ] Tests: no fixtureId→400; nonexistent pool→200 `{pool:null}` (not 404); chain throw→502 with message; fixture-name three-tier fallback (live→meta→`#id`); standings sorted desc + `[]` at 200; missing wallet/poolId→400; entry amount is a string; `store===undefined` doesn't crash the pool route.

---

## Risks (from synthesis — carry into implementation)

1. **Outcome mapping is the highest-risk real-money surface** — `mapOutcomeToOption` must never emit a sentinel/out-of-range index; void-on-goal must fire for the right kinds. S3-T3 tests are the lock.
2. **ER timing on devnet is slow/variable** — undelegation first flip ~21s (budget 90s), commit async ~6s, ER-visibility up to 60s. The per-pool guard (S3-T8) prevents overlapping ER txs on one pool.
3. **settle vs refund_voided remaining_accounts DIFFER** (entries-only ascending vs interleaved pairs) — separate mappers, distinct tests; copy-paste reverts on-chain.
4. **score-before-settle is strict** — every seat must reach `next_score_seq==cursor.resolved_count` or settle reverts (`NotAllScored`); verify full coverage before `endLivePool`.
5. **Delegated-account base reads** — validate `coder.decode` against a real delegated account; the `proof.ts` "Account not found" was the **camelCase** decode bug (S4 uses camelCase), but confirm before trusting in-flight reads.
6. **60s devnet data delay, neutral priors** — `LIVE_INTERVAL_SEC` must not open calls faster than data resolves; assumptions won't transfer 1:1 to mainnet Level-12.
7. **Single keeper key** plays keeper+settle_authority+fee_recipient+payer — single point of compromise for real money (see deferred item).

---

## Self-review (writing-plans gate)

- **Spec coverage:** every Slice 3/4 bullet in the design doc (`§SLICE 3`, `§SLICE 4`) maps to a task above (create-match-pool→S3-T2; live-runner feed→S3-T3/T6; open pacing→S3-T6; void-on-goal→S3-T3/T6; score batch→S3-T6; commit/end/settle→S3-T7; lock-delay/caps→deferred as a documented risk, not a code fork; cron fast job→S3-T8; chain readers→S4-T1/T2; routes→S4-T3; tests→each task).
- **Type consistency:** account/method names use the camelCase/PascalCase rules stated in Reference data; `pda` (delegate), `cranker` (score), `settleAuthority`+`feeRecipient` (settle) account keys are consistent across S3-T5/T6/T7.
- **No placeholders:** every task cites exact `file:line` reuse anchors and concrete test assertions.
- **Deferred, not dropped:** lock-delay/per-call caps (§H3) and key-separation are explicitly deferred to mainnet hardening with rationale — not silently omitted.
