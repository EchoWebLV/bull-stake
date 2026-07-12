// node test env has no localStorage — minimal in-memory stand-in
if (typeof globalThis.localStorage === "undefined") {
  const m = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => void m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as Storage;
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPfp, setPfp, clearPfp, subscribePfp } from "../src/lib/profile.ts";

beforeEach(() => localStorage.clear());

describe("profile pfp store", () => {
  it("returns null when unset", () => {
    expect(getPfp("addr1")).toBeNull();
  });
  it("stores and returns the bull per wallet", () => {
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(getPfp("addr1")?.asset).toBe("As5et");
    expect(getPfp("addr2")).toBeNull();
  });
  it("clears", () => {
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    clearPfp("addr1");
    expect(getPfp("addr1")).toBeNull();
  });
  it("notifies subscribers on set/clear", () => {
    const cb = vi.fn();
    const off = subscribePfp(cb);
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    clearPfp("addr1");
    off();
    setPfp("addr1", { asset: "As5et", traits: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
