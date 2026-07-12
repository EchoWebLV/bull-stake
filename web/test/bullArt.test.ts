// web/test/bullArt.test.ts
import { describe, expect, it } from "vitest";
import { traitLayerPaths, traitTilePath, type BullManifest } from "../src/lib/bullArt.ts";

const MANIFEST: BullManifest = [
  { name: "Background", traits: [
    { name: "Blue", weight: 1, tile: "tiles/c0_t0.png", layer: "layers/c0_t0.png" },
    { name: "Brown", weight: 1, tile: "tiles/c0_t1.png", layer: "layers/c0_t1.png" },
  ]},
  { name: "Body", traits: [
    { name: "Tan", weight: 1, tile: "tiles/c1_t0.png", layer: "layers/c1_t0.png" },
  ]},
];

describe("traitLayerPaths", () => {
  it("maps trait indices to layer paths in category order", () => {
    expect(traitLayerPaths(MANIFEST, [1, 0])).toEqual([
      "/bull/layers/c0_t1.png",
      "/bull/layers/c1_t0.png",
    ]);
  });
  it("ignores trailing indices beyond the manifest categories (on-chain traits are padded to 9)", () => {
    expect(traitLayerPaths(MANIFEST, [1, 0, 0, 0, 0, 0, 0, 0, 0])).toHaveLength(2);
  });
  it("throws on an out-of-range trait index", () => {
    expect(() => traitLayerPaths(MANIFEST, [9, 0])).toThrow(/out of range/);
  });
});

describe("traitTilePath", () => {
  it("maps (category, trait) to the tile path", () => {
    expect(traitTilePath(MANIFEST, 0, 1)).toBe("/bull/tiles/c0_t1.png");
  });
});
