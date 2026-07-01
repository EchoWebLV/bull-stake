import { describe, it, expect, vi } from "vitest";
import { broadcastAndConfirm, type BroadcastConn, type SignatureStatusLike } from "../src/lib/broadcast.ts";

// A mock connection that scripts getSignatureStatuses responses and records sends.
function makeConn(statuses: (SignatureStatusLike | null)[]): {
  conn: BroadcastConn;
  sends: number;
  statusCalls: () => number;
} {
  let sends = 0;
  let i = 0;
  const conn: BroadcastConn = {
    sendRawTransaction: vi.fn(async () => {
      sends++;
      return "SIG";
    }),
    getSignatureStatuses: vi.fn(async () => {
      const value = [statuses[Math.min(i, statuses.length - 1)]];
      i++;
      return { value };
    }),
  };
  return { conn, get sends() { return sends; }, statusCalls: () => i };
}

const raw = new Uint8Array([1, 2, 3]);
const noSleep = async () => {};

describe("broadcastAndConfirm — ER fast profile (#4)", () => {
  it("accepts a present, error-free status even when confirmationStatus is null (the ER-sequencer case)", async () => {
    // devnet.magicblock.app may not populate confirmationStatus — a landed tap must
    // still confirm, not hang for the whole match.
    const { conn } = makeConn([{ err: null, confirmationStatus: null }]);
    const sig = await broadcastAndConfirm(raw, conn, { fast: true, sleep: noSleep });
    expect(sig).toBe("SIG");
  });

  it("accepts confirmationStatus: 'processed' in fast mode", async () => {
    const { conn } = makeConn([{ err: null, confirmationStatus: "processed" }]);
    expect(await broadcastAndConfirm(raw, conn, { fast: true, sleep: noSleep })).toBe("SIG");
  });

  it("sends the first ER tx with skipPreflight:true (no unproven ER preflight dependency)", async () => {
    const { conn } = makeConn([{ err: null, confirmationStatus: null }]);
    await broadcastAndConfirm(raw, conn, { fast: true, sleep: noSleep });
    const firstSend = (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstSend.skipPreflight).toBe(true);
  });

  it("throws on an on-chain error (status.err) instead of reporting success", async () => {
    const { conn } = makeConn([{ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" }]);
    await expect(broadcastAndConfirm(raw, conn, { fast: true, sleep: noSleep })).rejects.toThrow(/transaction failed/);
  });

  it("times out fast (short ceiling) when the tap never lands — the whole-match hang guard", async () => {
    const { conn } = makeConn([null]); // status never appears
    let t = 0;
    const now = () => (t += 5); // each read advances the clock 5ms
    await expect(
      broadcastAndConfirm(raw, conn, { fast: true, sleep: noSleep, timeoutMs: 12, now }),
    ).rejects.toThrow(/tap not confirmed within timeout/);
  });
});

describe("broadcastAndConfirm — base money profile", () => {
  it("does NOT accept 'processed' — holds out for 'confirmed'", async () => {
    // First poll 'processed' (ignored), second 'confirmed' → resolves.
    const { conn } = makeConn([
      { err: null, confirmationStatus: "processed" },
      { err: null, confirmationStatus: "confirmed" },
    ]);
    const sig = await broadcastAndConfirm(raw, conn, { sleep: noSleep });
    expect(sig).toBe("SIG");
    // It kept polling past the 'processed' status (≥2 reads).
    expect((conn.getSignatureStatuses as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("sends the first base tx with skipPreflight:false (server-side simulation surfaces errors)", async () => {
    const { conn } = makeConn([{ err: null, confirmationStatus: "confirmed" }]);
    await broadcastAndConfirm(raw, conn, { sleep: noSleep });
    const firstSend = (conn.sendRawTransaction as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(firstSend.skipPreflight).toBe(false);
  });

  it("re-broadcasts while waiting (idempotent keep-alive) and ignores duplicate-send errors", async () => {
    let call = 0;
    const conn: BroadcastConn = {
      sendRawTransaction: vi.fn(async () => {
        call++;
        if (call === 2) throw new Error("already processed"); // the re-broadcast raises → swallowed
        return "SIG";
      }),
      getSignatureStatuses: vi
        .fn()
        .mockResolvedValueOnce({ value: [null] }) // miss → sleep + re-broadcast
        .mockResolvedValueOnce({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
    };
    const sig = await broadcastAndConfirm(raw, conn, { sleep: noSleep });
    expect(sig).toBe("SIG");
    expect(call).toBeGreaterThanOrEqual(2); // at least the initial send + one re-broadcast
  });
});
