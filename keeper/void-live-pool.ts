/**
 * void-live-pool.ts — OPS ESCAPE HATCH: void a live pool and refund every seat.
 *
 *   npx tsx void-live-pool.ts <fixtureId>
 *
 * For a pool that cannot finalize normally (e.g. the ER never releases the
 * delegated cursor/entries back to base, so end/settle bounce with
 * AccountOwnedByWrongProgram forever). Both instructions are reachable by design
 * in exactly this state:
 *   - `void_live_pool`  — LivePool is NEVER delegated, so its status can always
 *     be flipped on base (keeper signer; Open|Live|Ended accepted).
 *   - `refund_voided`   — reads every seat OWNER-AGNOSTICALLY (raw AccountInfo,
 *     no owner check), so refunds work even while entries are still delegated.
 * Every stake returns to its seat's wallet; the pot never strands.
 */
import "dotenv/config";
import anchorDefault from "@coral-xyz/anchor";
import { createContext } from "../spike/src/auth.js";
import { livePoolPda } from "./live-pda.js";
import {
  createLiveRunner,
  gatherSeats,
  voidLivePoolOnBase,
  refundVoidedOnBase,
} from "./live-runner.js";

const { BN } = anchorDefault;

async function main() {
  const fixtureId = Number(process.argv[2]);
  if (!Number.isInteger(fixtureId) || fixtureId <= 0) {
    throw new Error("usage: npx tsx void-live-pool.ts <fixtureId>");
  }
  const ctx = createContext();
  const runner = createLiveRunner({ keypair: ctx.wallet });
  const pool = livePoolPda(new BN(fixtureId));

  const seats = await gatherSeats(runner.base, pool);
  console.log(`[void] pool ${pool.toBase58()} · ${seats.length} seat(s):`);
  for (const s of seats) console.log(`[void]   ${s.toBase58()}`);

  await voidLivePoolOnBase(runner, { pool });
  if (seats.length > 0) {
    await refundVoidedOnBase(runner, { pool, seats });
  }

  for (const step of runner.report.steps ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st: any = step;
    console.log(`[void] ${st.name}: ${st.ok ? `OK ${st.sig ?? ""}` : `FAILED ${st.err ?? ""}`}`);
  }
  const failed = (runner.report.errors ?? []).length;
  console.log(failed === 0 ? "[void] DONE — all seats refunded" : `[void] ${failed} step(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
