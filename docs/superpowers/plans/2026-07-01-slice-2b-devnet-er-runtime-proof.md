# Slice 2b — Devnet ER Runtime Proof (plan)

Branch: `feat/streak-pivot` · Program: `By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ` (extend-in-place, not a new id) · Date: 2026-07-01

This is a **spike** plan: its job is to discover runtime facts that cannot be learned any other way (does a delegated account stay readable on BASE? does the full delegate→ER-write→commit→undelegate cycle actually run on devnet?) and to resolve deferred **Finding [2]** (keeper-death refund freeze). It is not a rigid production build — but every command and number below is concrete and paste-ready. Where a fact is inferred rather than confirmed, it is marked `[UNCONFIRMED — verify at runtime]`.

---

## Goal & pause-point context

**Product framing.** Streak is a real-money on-chain product. This plan performs the **first devnet spend** for the ER layer, and it does so from a funded upgrade-authority wallet. The spec's Finding-3 step 4 explicitly requires a **pause for go-ahead before spending devnet SOL** — so the deploy in Step 1 and the runtime proof in Step 3 are gated on human sign-off, not auto-run.

**What we are proving (three outcomes):**
1. The upgraded program (Slice 2a code: `delegate_*` / `open_call` / `lock_pick` / `commit_live` / `end_and_undelegate`) executes end-to-end against the **real MagicBlock devnet ER**, not just localnet.
2. A concrete latency/behavior read on the ER `lock_pick` path (the 10–50 ms tap).
3. A definitive answer to **Finding [2]**: is a delegated `LiveEntry` readable on the BASE layer between commits? The answer forks the refund fix (`refund_voided`) into a base-read design vs a force-undelegate-first design.

**Wallets (keep these straight — two different keypairs):**
- **Upgrade authority / payer** = `FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM`, keypair `~/.config/solana/lazer-probe.json`. Pays the program upgrade. Must be **funded to ~8 SOL** (see Step 1). Funded via the **PoW faucet** (`devnet-pow mine -d 3 --reward 0.02 --no-infer` → mines to the CLI-default keypair, which is this wallet) since the public devnet airdrop is rate-limited.
- **Spike keeper/player signer** = `spike/live-er/spike-id.json` (already exists). Signs the runtime-proof instructions (keeper + both players can reuse real keypairs for the proof; session keys are a later slice). Fund with ~1 SOL on devnet.

---

## Preconditions

| Item | Target / value | Check |
|---|---|---|
| Upgrade-authority balance | **≥ ~8 SOL** on devnet (peak deploy need ≈ 7.47 SOL) | `solana balance FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM --url devnet` |
| Upgrade-authority keypair | `~/.config/solana/lazer-probe.json` == authority `FP39zt…` | `solana address -k ~/.config/solana/lazer-probe.json` |
| Spike signer keypair | `spike/live-er/spike-id.json`, funded ~1 SOL devnet | `solana balance -k spike/live-er/spike-id.json --url devnet` |
| Solana CLI | **4.1.0-beta.2** (Agave) — has `--no-auto-extend`, so deploy auto-extends by default | `solana --version` (confirmed) |
| Anchor toolchain | **avm 0.32.1** at `~/.avm/bin/anchor` — do NOT use standalone `~/.cargo/bin/anchor` (0.31.1) | `~/.avm/bin/anchor --version` (confirmed) |
| New build artifact | `target/deploy/proofbet.so` = **732080 bytes** | `wc -c target/deploy/proofbet.so` (confirmed) |
| IDL artifact | `target/idl/proofbet.json` | present (confirmed) |
| Cluster config | Leave global `solana config` untouched; pass `--url devnet` explicitly on every command | `solana config get` |

Do **not** rely on `Anchor.toml [provider]` — it is `cluster=localnet` / `wallet=id.json` (`id.json` = `HKVgAY…`, the wrong key). Every command below passes cluster + keypair explicitly.

---

## Step 1 — Upgrade the program in place (extend + upgrade)

**Gate:** get explicit go-ahead before running (first devnet spend).

### 1.0 Fund the authority to headroom

The transient write-buffer needs ~5.1 SOL available **simultaneously** with the ~2.37 SOL permanent top-up. If you run `extend` first, the authority drops to ~3.80 SOL — **below** the buffer requirement — and the deploy fails on insufficient funds. So fund first. The public devnet airdrop is **rate-limited** (`Error: airdrop request failed`), so fund via the **PoW faucet** (mines to the CLI-default keypair = this authority wallet):

```
devnet-pow mine -d 3 --reward 0.02 --no-infer -t 10000000000   # mines ~10 SOL to the CLI-default keypair (FP39zt…)
solana balance FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM --url devnet
# (plain `solana airdrop 2 FP39zt… --url devnet` also works IF the faucet rate limit has reset)
```

### 1.1 Extend ProgramData — compute `ADDITIONAL_BYTES` at runtime (do NOT hardcode)

Target size = `.so_len + 45` (upgradeable-loader header) = `732080 + 45 = 732125`. The **current alloc must be read live** — this program has been redeployed several times (MAX_LEGS 5→6, v2 parlay), so the `392088` observed on 2026-07-01 is not guaranteed stable, and it's the one load-bearing number that can't be verified offline. Read it, then subtract:

```
# 1.1.0 — read the ACTUAL current allocation first
solana program show By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ --url devnet   # note "Data Length" = CURRENT
# ADDITIONAL_BYTES = 732125 − CURRENT   (as of 2026-07-01, CURRENT=392088 → 340037; recompute from the live value)
```

Guards on the computed value:
- If `CURRENT ≥ 732125` → a prior deploy already sized it big enough → **skip extend entirely** (extend would over-allocate and waste permanent rent).
- Else extend by exactly the difference:

```
solana program extend By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ <ADDITIONAL_BYTES> \
  --url devnet \
  --payer ~/.config/solana/lazer-probe.json
```

Explicit `extend` is technically **optional** on CLI 4.1.0-beta.2 (deploy auto-extends, which also removes the hardcode risk), but recommended: it isolates the permanent rent cost into its own tx and keeps the deploy a pure write+swap. If you skip it, do **not** pass `--no-auto-extend`.

### 1.2 Upgrade — raw `solana program deploy` (not `anchor deploy`)

```
solana program deploy /Users/yordanlasonov/Documents/GitHub/ProofBet/target/deploy/proofbet.so \
  --program-id By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ \
  --upgrade-authority ~/.config/solana/lazer-probe.json \
  --url devnet
```

Deploy creates a temporary buffer (~5.096 SOL rent), writes the `.so` across ~150–170 txs, swaps it into ProgramData in the final tx, then **closes the buffer and refunds its rent to the authority** (net-zero on success).

### 1.3 Refresh the on-chain IDL (separate PDA — untouched by upgrade)

Decide which verb applies:

```
~/.avm/bin/anchor idl fetch By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ --provider.cluster devnet
```

- Success → the IDL account exists → **upgrade** it:
```
~/.avm/bin/anchor idl upgrade By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ \
  --filepath /Users/yordanlasonov/Documents/GitHub/ProofBet/target/idl/proofbet.json \
  --provider.cluster devnet \
  --provider.wallet ~/.config/solana/lazer-probe.json
```
- "not found" → first publish → **init**:
```
~/.avm/bin/anchor idl init By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ \
  --filepath /Users/yordanlasonov/Documents/GitHub/ProofBet/target/idl/proofbet.json \
  --provider.cluster devnet \
  --provider.wallet ~/.config/solana/lazer-probe.json
```

### 1.4 Verify

```
solana program show By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ --url devnet
```
Expect **Data Length 732125**, a new **Last Deployed** slot, authority still `FP39zt…`.

### Cost table (Step 1)

Rent basis: `solana rent 732080` → 5.09616768; incl. 45-byte header (`732125`) → 5.09648088. Current basis = `solana rent 392088` → **2.72982336** (the on-chain 392088 already includes the header; do NOT add another 45).

| Item | Type | SOL | Notes |
|---|---|---|---|
| ProgramData rent top-up (→ 732125 B) | **Permanent** | **2.36665752** | 5.09648088 − 2.72982336. Recompute from the live `Data Length` (§1.1.0). Same whether explicit extend or auto-extend. |
| Write-buffer rent-exempt (~732125 B) | **Transient** | ~5.09648088 | **Refunded** on success; must be available during deploy. |
| Tx fees (extend + ~150 write txs + swap) | Fee | ~0.001–0.002 | 5000 lamports/sig. |
| **Net permanent spend** | | **≈ 2.367 SOL** | buffer nets to 0. |
| **Peak balance needed at deploy** | | **≈ 7.47 SOL** | top-up + transient buffer + fees held at once. |

---

## Step 2 — Client scaffolding for dual-RPC (minimal)

**Gap (confirmed by grep):** there is **no** TypeScript ER client in the repo. No `@magicblock-labs/*` / `ephemeral-rollups-sdk` deps; `keeper/package.json` has only `@coral-xyz/anchor`, `@solana/web3.js`, `dotenv`. `tests/live_helpers.ts` drives every instruction against a **single** connection (all BASE) and has no delegate/commit/undelegate wrappers. `spike/live-er/` is Rust-only. So build one thin script.

**Create `spike/live-er/proof.ts`** — a single `tsx`-runnable script:

1. **Two connections** (raw web3.js, explicit routing — matches our delegate/ER split):
   - `baseConn = new Connection("https://api.devnet.solana.com", "confirmed")`
   - `erConn = new Connection("https://devnet-as.magicblock.app", "confirmed")` (Asia ER validator, matching the SDK default identity `MAS1Dt9…`).
   - `[UNCONFIRMED — verify at runtime]` The raw two-Connection read split ("read delegated accounts from the ER RPC; BASE only sees committed snapshots") is the **standard** MagicBlock pattern but is inferred, not quoted verbatim from docs. Fallback if reads misbehave: route through the **Magic Router** (`https://devnet-router.magicblock.app` + `wss://…`), which auto-dispatches by writable-account owner and resolves ER reads transparently.
2. Build an Anchor `Program` bound to each connection (same IDL + programId, different provider). Route: **steps 1–8, 15–17 → base program; steps 9–14 → ER program.**
3. **Add deps:** `ephemeral-rollups-sdk` (TS) or `@magicblock-labs/ephemeral-rollups-sdk` — for `GetCommitmentSignature` and the program-id constants.
4. **Pin constants** (from SDK `consts.rs`; cluster-independent):
   - Delegation program `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` (✅ docs-confirmed, exact match).
   - ER validator identity `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (✅ == SDK `DEFAULT_VALIDATOR_IDENTITY`).
   - `MAGIC_PROGRAM_ID = Magic11111111111111111111111111111111111111`, `MAGIC_CONTEXT_ID = MagicContext1111111111111111111111111111111` — ✅ **CONFIRMED in SDK source**: declared in `magicblock-magic-program-api-0.10.1/src/lib.rs` and re-exported via `ephemeral-rollups-sdk-0.14.4/src/consts.rs` (`MAGIC_PROGRAM_ID` / `MAGIC_CONTEXT_ID`). Anchor resolves both from the IDL automatically, so they only matter if a tx errors on a bad Magic account.
5. **Reuse PDA derivations verbatim** from `tests/live_helpers.ts`: `livePoolPda`, `liveCursorPda`, `callPda`, `liveEntryPda` (layer-agnostic — correct as-is).
6. **New wrappers the helper lacks:**
   - `delegateCursor()`, `delegateEntry(player)`, `delegateCall(seq)` — on the **base** program; `.accounts({ keeper, pool, pda })` + **validator identity as `remainingAccounts[0]`** (the handler reads `remaining_accounts.first()`). Anchor auto-resolves the macro-injected `buffer_*` / `delegation_record_*` / `delegation_metadata_*` / `owner_program` / `delegation_program`.
   - `commitLive(accounts[])`, `endAndUndelegate(accounts[])` — on the **ER** program; `.accounts({ keeper, pool })` + the delegated PDAs in `.remainingAccounts`; `magic_context` / `magic_program` auto-resolved.
   - Wrap `openCall` / `lockPick` / `resolveCall` / `scoreEntry` to send via the **ER** program.
7. **Confirm commits explicitly:** after `commitLive` / `endAndUndelegate`, call `GetCommitmentSignature(...)` on the ER and poll BASE for the committed account. **Never assume synchronous undelegation** (two-phase, async).
8. Keep it **plain keypair signing** (keeper + both players sign with real keypairs). Session keys / gasless (SLICE 6, gum-sdk) are **not** needed for this proof.

---

## Step 3 — The runtime proof (ordered instruction sequence, per-step RPC target)

**Gate:** first ER devnet spend — proceed only on go-ahead.

**Topology rule enforced by the program:** an instruction that **writes a delegated account** (cursor / entry / call) → **ER**; an instruction that **writes `LivePool`** (the pot) → **BASE**. `LivePool` is **never delegated**, so `open_call` / `resolve_call` take `pool` read-only. Use a small `num_calls` (e.g. 2–3; delegate only seq 0 for a minimal 1-call proof).

**Delegated set = { LiveCursor, LiveEntry×2, Call×(opened seqs) }. Never delegated = LivePool.**

| # | Instruction | RPC | Key accounts | Notes |
|---|---|---|---|---|
| 1 | `create_live_pool(pool_id, fixture_id, entry_price, lock_ts, settle_after_ts, fee_recipient, fee_bps, num_calls)` | BASE | keeper, pool, cursor, systemProgram | Inits `LivePool`(Open) + `LiveCursor`. Small `num_calls`. |
| 2 | `prealloc_call(seq)` ×num_calls | BASE | keeper, pool, call(seq), systemProgram | Each `Call` PDA `Empty`. **Must be on BASE before delegation** — nothing can be created inside the ER. Fire concurrently (`Promise.all`). |
| 3 | `join_live_pool()` — player A | BASE | player, pool, entry(A), systemProgram | Transfers `entry_price` into `LivePool`; inits `LiveEntry`; `player_count→1`. |
| 4 | `join_live_pool()` — player B | BASE | player, pool, entry(B), systemProgram | `player_count→2`. **Crosses the ≥2 gate.** ← *(Finding [2] probe baseline read goes here — see Step 4.)* |
| 5 | `delegate_cursor()` | BASE | keeper, pool, pda=LiveCursor, +CPI, +validator[0] | Delegation CPIs run on BASE. Seeds `[b"livecursor", pool_key]`. |
| 6 | `delegate_entry(A)` | BASE | keeper, pool, pda=LiveEntry(A), +CPI, +validator[0] | Seeds `[b"liveentry", pool_key, A]`. ← *(probe post-delegate read on entry A goes here — Step 4.)* |
| 7 | `delegate_entry(B)` | BASE | keeper, pool, pda=LiveEntry(B), +CPI, +validator[0] | Seeds `[b"liveentry", pool_key, B]`. |
| 8 | `delegate_call(seq=0)` | BASE | keeper, pool, pda=Call(0), +CPI, +validator[0] | Seeds `[b"call", pool_key, seq_le]`. **LivePool deliberately absent from all delegations.** |
| 9 | `open_call(seq=0, kind, num_options, base_points, answer_secs)` | ER | keeper, **pool (RO)**, cursor(mut), call(mut) | `Empty→Open`. Pool RO because not delegated. |
| 10 | `lock_pick(option)` — A | ER | player, call(0), entry(A) mut | The tap. `entry.picks[seq]`. **Record wall-clock latency here** (the 10–50 ms path claim). |
| 11 | `lock_pick(option)` — B | ER | player, call(0), entry(B) mut | Same. |
| 12 | `resolve_call(outcome)` | ER | keeper, pool (RO), cursor(mut), call(0) mut | `Open→Resolved` (or `Voided` if `VOID_OUTCOME`); `open_seq→NONE_SEQ`. |
| 12b | `score_entry()` ×2 (A,B) | ER | cranker(keeper), call(0), entry mut | Folds each seat's score for seq 0. Batchable. |
| 13 | `commit_live()` | ER | keeper, pool (RO), magic_context/magic_program (injected); `remaining_accounts` = cursor + 2 entries + call | Mid-match checkpoint to BASE **without** undelegating. Confirm via `GetCommitmentSignature` — not synchronous. ← *(probe "reflects last commit?" read goes here — Step 4.)* |
| 14 | `end_and_undelegate()` | ER | same `CommitLive` struct; `remaining_accounts` = cursor + entries + call | `commit_and_undelegate` — final commit + returns ownership to our program on BASE. Async two-phase; confirm via `GetCommitmentSignature`. |
| 15 | `end_live_pool()` | BASE | keeper, pool(mut), cursor | `Open/Live→Ended`. Requires `cursor.open_seq==NONE_SEQ`. |
| 16 | `settle_live_pool()` | BASE | settleAuthority, jackpot, pool(mut), cursor, feeRecipient, **remainingAccounts = BOTH LiveEntry PDAs, ascending by pubkey** | On-chain argmax; PDA re-derive + owner + coverage. Requires `now≥settle_after_ts`, `player_count≥2`. Sort via `Buffer.compare`. |
| 17 | `claim_live_pool()` — winner(s) | BASE | player, pool(mut), entry(mut, `close=player`), systemProgram | Winner self-proves `total==winning_score`; loser closes for rent. |

**Success = every step lands, ER reads resolve, `GetCommitmentSignature` confirms both commits, and settle/claim pay out correctly** — the full delegate→ER-write→commit→undelegate cycle proven on real devnet.

---

## Step 4 — Finding [2] experiment (base-layer-readability probe + decision fork)

**Why it matters.** `claim_live_pool` declares the entry as `Account<'info, LiveEntry>` with `close = player`. `Account<…>` enforces **`entry.owner == crate::ID`**. When an entry is **delegated**, its on-chain owner is the **Delegation Program** (`DELeGGvXpWV2…`), so the owner check fails (`AccountOwnedByWrongProgram`) before the handler runs, and `close` is illegal. So if the keeper delegates entries then vanishes, the refund-via-`claim` path reverts and the pot freezes — contradicting §1.3's "every seat refunds regardless of delegation." (`void_live_pool` itself still works — it only touches the never-delegated `LivePool` — but the **payout** half runs through the delegated entry.)

**The unproven fact the whole fork hinges on:** *is a delegated account's data readable on the BASE layer between commits?* We know the **owner** flips to the Delegation Program; we do **not** know whether the **data bytes** stay present/current on BASE or are zeroed/stale while the account lives on the ER.

**The probe — instrument the Step-3 sequence (nothing new to deploy). Record all three checkpoints as JSON `{ owner, dataLen, deserializedOk, amount, picks0, basePts }`:**

1. **Baseline** — after step 4, before step 6: `before = await baseConn.getAccountInfo(entryA_pda)`. Expect `owner == crate::ID` (`By8y6y34…`), `data.length == 8 + LiveEntry::INIT_SPACE`; deserialize to confirm `amount == entry_price`, `player == A`.
2. **Post-delegate** — after step 6 confirmed on BASE: `afterDel = await baseConn.getAccountInfo(entryA_pda)` **on the BASE RPC**. Record:
   - **(a)** data present-and-same / all-zero / length-0?
   - **(b)** `.owner` == `crate::ID` vs `DELeGGvXpWV2…` (expected) vs a Magic pubkey?
   - Confirm ER copy is live: `erConn.getAccountInfo(entryA_pda)` should show our-program-owned on the ER side.
3. **Reflects last commit?** — after `lock_pick`(A) (step 10) + `commit_live` (step 13): `afterCommit = await baseConn.getAccountInfo(entryA_pda)`. Deserialize and check **(c)** whether `picks[0]` / score reflect the just-committed ER mutation, i.e. does BASE track last-committed ER state or only the pre-delegation snapshot?

**The decision fork:**

- **FORK A — base-readable-but-foreign-owner** (data present on BASE, `owner == Delegation Program`, and (c) shows committed state tracked): implement a **permissionless, atomic, all-seats `refund_voided`** that bypasses the owner-checked `Account<LiveEntry>`. (Spec "If YES" branch, line 592.)
- **FORK B — NOT base-readable** (data zeroed/absent, or (c) stale): the program can't read `entry.amount`/`player` from BASE, so refund **must force-undelegate first** to pull each entry back to program ownership on BASE. **CONFIRMED (SDK source, not a coin-flip):** `magicblock-delegation-program-api-3.0.0` and `ephemeral-rollups-sdk-0.14.4` expose **no permissionless undelegate** — every path (`instruction_builder/undelegate.rs`, access-control `undelegate_permission.rs`) requires the **validator** as a signer, and our own `end_and_undelegate` is **keeper-signed**. So if the keeper dies with entries delegated AND entries are not base-readable, no third party can crank the funds back: this is a **genuine liveness gap** whose recovery depends on the very keeper/validator we're defending against. **Treat Fork B as the blocking outcome to escalate** (design change required — see mitigations below), not a branch we can quietly patch. (Spec "If NO" branch, line 593.)

**Fork B mitigations to weigh if it lands (pre-committed, not conditional):** (i) **don't delegate `LiveEntry` at all** — keep entries on BASE and delegate only `LiveCursor` + `Call`; `lock_pick` would then write the pick on BASE (slower tap, but entries stay refundable) — evaluate whether the ER value is in the cursor/call fold rather than the entry write; (ii) rely on the validator's **scheduled commit+undelegate** (`commit_frequency_ms = 5_000`) as the eventual-liveness backstop and document the worst-case freeze window; (iii) escalate to MagicBlock for a permissionless-undelegate affordance. Which of these to adopt depends on the Step-4 (a)/(b)/(c) observations.

*Note (solvency is not blocked either way):* `LiveEntry.amount == entry_price` for every seat by the `init`-not-`init_if_needed` invariant, and `pot == player_count * entry_price` holds exactly. So the refund amount is always `pool.entry_price` — only the **player pubkey** is needed to pay. Even a **partially-readable** result (owner foreign but seat pubkeys supplied by the client and bound by PDA) can support Fork A.

---

## Step 5 — Resolve Finding [2] per the observed fork + add the void-refund test

**If Fork A observed — implement `refund_voided` (permissionless, all-seats):**
- Take every seat's entry as `UncheckedAccount<'info>` / raw `AccountInfo` in `remaining_accounts` — **not** `Account<LiveEntry>` — to bypass the owner check that blocks the delegated case.
- **Deserialize manually:** `LiveEntry::try_deserialize(&mut &acc.try_borrow_data()?[..])`.
- **Guard by PDA re-derivation** (identical to `settle_live_pool.rs:52-70`): `find_program_address([b"liveentry", pool_key, entry.player], crate::ID)` then `require_keys_eq!(acc.key(), expected)` + `require_keys_eq!(entry.pool, pool_key)`. Owner is **intentionally not required** (that's the whole point).
- **Pay each seat `entry_price`** (= `entry.amount`) **from the non-delegated `LivePool`** via `pool.sub_lamports` / `player.add_lamports` — LivePool is always program-owned, so this always succeeds.
- **Coverage** `seen == player_count` + **re-run guard** (only in `Voided`; flip a `refunded` flag or gate on `claimed_count`). Do **not** `close` the delegated entries (can't — not owned); reclaim their rent later via undelegate as a nice-to-have, not a safety dependency.

**If Fork B observed — implement force-undelegate-then-refund** (if a permissionless undelegate exists), else escalate the liveness gap and record the exact missing capability.

**Add the void-refund test (either fork):** extend `tests/` (mirror the live-helpers pattern) with a scenario that:
1. Creates a ≥2-seat pool, joins A + B, delegates entries (reaching the exact frozen state Finding [2] describes).
2. Voids the pool after grace (`void_live_pool`).
3. Runs the chosen refund path and asserts **both seats receive `entry_price` back** and the pool cannot be double-refunded.
4. For Fork A, run it in a mode where entries are **still delegated** at refund time — that is the specific regression this test locks in.

---

## Risks / unknowns / recovery

**Dangling write-buffer (deploy dies mid-write).** RPC timeout / blockhash expiry is common for a ~715 KB program; on failure the buffer is **left dangling and NOT refunded** (~5.1 SOL stranded).
```
solana program show --buffers --url devnet --buffer-authority FP39ztVCx7FDPpou4mfPV6HyXoNVDRLEqZyvKkFgpCCM
# RESUME (preferred — reuses the paid buffer):
solana program deploy /Users/yordanlasonov/Documents/GitHub/ProofBet/target/deploy/proofbet.so \
  --program-id By8y6y34eNR5WJQ3XfkTQUtf4u2667B2FcfxeSrMTWZ \
  --upgrade-authority ~/.config/solana/lazer-probe.json \
  --buffer <BUFFER_ADDRESS> --url devnet
# OR reclaim the SOL if abandoning:
solana program close --buffers --authority ~/.config/solana/lazer-probe.json --url devnet
```
Prefer resume; only `close --buffers` if abandoning.

**`[UNCONFIRMED — verify at runtime]` No whitelist / registration to delegate.** Docs never mention one, but never explicitly deny it either. If the **first `delegate_cursor` fails with a permission error**, check the per-program `program_config` PDA (seed `p-conf`) init — that is the only gate the delegation flow surfaces.

**`[UNCONFIRMED — verify at runtime]` ER read semantics / raw two-Connection split.** If BASE/ER reads don't behave as the standard pattern predicts, fall back to the **Magic Router** single endpoint (`https://devnet-router.magicblock.app`) which auto-routes and resolves ER reads transparently.

**ER downtime / unsupported-on-devnet fallback.** The full cycle is docs-confirmed on devnet (linked live txns), but if a specific region validator is down, retarget another region (`devnet-eu` / `devnet-us`) or the router. If delegation itself is unavailable on devnet at run time, the proof cannot complete — record it and escalate rather than paper over it; do not fall back to localnet-only claims of success.

**Async commits.** Never treat `commit_live` / `end_and_undelegate` as synchronous — always confirm via `GetCommitmentSignature` + BASE poll, or a stale read will look like a bug.

**IDL rent.** The IDL PDA incurs its own small permanent rent (grows if the ABI got bigger); funded from the authority wallet.

---

## SOL budget summary

| Bucket | Wallet | SOL | Kind |
|---|---|---|---|
| Program upgrade — permanent rent top-up | authority `FP39zt…` | **≈ 2.367** | permanent |
| Program upgrade — transient write-buffer | authority `FP39zt…` | ~5.096 | refunded on success |
| Program upgrade — tx fees | authority `FP39zt…` | ~0.001–0.002 | spent |
| IDL PDA rent | authority `FP39zt…` | small (~0.01–0.05, grows with IDL) | permanent |
| Runtime proof — pool entries + delegation + ER/commit fees | spike `spike-id.json` | ~0.1–0.5 (mostly recoverable via settle/claim/undelegate) | mixed |
| **Peak simultaneous (authority, at deploy)** | | **≈ 7.47** | — |
| **Fund authority to** | | **~8 SOL** | — |
| **Fund spike signer to** | | **~1 SOL** | — |
| **Net permanent spend (upgrade)** | | **≈ 2.37 + IDL** | — |
