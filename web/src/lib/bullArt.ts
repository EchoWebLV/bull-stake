// web/src/lib/bullArt.ts
/* Bull art pipeline — mirrors the SOL bulls demo: on-chain trait indices (9 bytes,
 * padded) map positionally onto manifest categories; the bull image is the
 * category layers stacked in order on a canvas. Assets live in /bull (vendored). */

export type BullTrait = { name: string; weight: number; tile: string; layer: string };
export type BullCategory = { name: string; traits: BullTrait[] };
export type BullManifest = BullCategory[];

const BASE = "/bull/";

let _manifest: BullManifest | null = null;
export async function loadManifest(): Promise<BullManifest> {
  if (_manifest) return _manifest;
  const res = await fetch(`${BASE}manifest.json`);
  if (!res.ok) throw new Error(`manifest load failed: ${res.status}`);
  _manifest = (await res.json()) as BullManifest;
  return _manifest;
}

/** Trait indices → ordered layer asset paths. Extra indices beyond the manifest
 *  (on-chain pads to 9) are ignored; an out-of-range index is a real error. */
export function traitLayerPaths(manifest: BullManifest, traits: number[]): string[] {
  return manifest.map((cat, ci) => {
    const ti = traits[ci];
    const t = cat.traits[ti];
    if (t === undefined) throw new Error(`trait index out of range: category ${ci} (${cat.name}) index ${ti}`);
    return BASE + t.layer;
  });
}

export function traitTilePath(manifest: BullManifest, category: number, trait: number): string {
  const t = manifest[category]?.traits[trait];
  if (!t) throw new Error(`trait index out of range: category ${category} index ${trait}`);
  return BASE + t.tile;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${src}`));
    img.src = src;
  });
}

/** Compose the bull onto a square canvas and return a PNG data URL.
 *  Browser-only (canvas); callers cache the result. */
export async function composeBull(traits: number[], size = 512): Promise<string> {
  const manifest = await loadManifest();
  const layers = await Promise.all(traitLayerPaths(manifest, traits).map(loadImg));
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  for (const img of layers) ctx.drawImage(img, 0, 0, size, size);
  return c.toDataURL("image/png");
}
