/* Profile picture store — which minted bull this wallet shows as its PFP.
 * localStorage per wallet (devnet demo custody model, same as session keys);
 * subscribers make the LoginBar chip / views react in-tab. */
import { useEffect, useState } from "react";

export type Pfp = { asset: string; traits: number[]; setAt?: number };

const key = (address: string) => `bullstake:pfp:${address}`;
const subs = new Set<() => void>();
const notify = () => { for (const cb of subs) cb(); };

export function getPfp(address: string): Pfp | null {
  const raw = localStorage.getItem(key(address));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Pfp;
    // Corrupt/foreign storage self-heals to the mascot fallback.
    return typeof v.asset === "string" && Array.isArray(v.traits) ? v : null;
  } catch { return null; }
}

export function setPfp(address: string, pfp: Pfp): void {
  localStorage.setItem(key(address), JSON.stringify({ ...pfp, setAt: pfp.setAt ?? Date.now() }));
  notify();
}

export function clearPfp(address: string): void {
  localStorage.removeItem(key(address));
  notify();
}

export function subscribePfp(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

/** The wallet's current PFP (reactive). null = fall back to the mascot. */
export function usePfp(address: string | undefined): Pfp | null {
  const [pfp, set] = useState<Pfp | null>(() => (address ? getPfp(address) : null));
  useEffect(() => {
    set(address ? getPfp(address) : null);
    return subscribePfp(() => set(address ? getPfp(address) : null));
  }, [address]);
  return pfp;
}
