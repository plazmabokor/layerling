import ManifoldModule, { type Manifold, type ManifoldToplevel } from "manifold-3d";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ENERGY_CHAIN, energyChainBendRadius, energyChainLinks, energyChainSpec, energyChainSpiral, normalizeEnergyChain } from "@/lib/energyChain";
import { energyChainExtents, energyChainLayout, energyChainPieces, placedChainPiece } from "@/lib/energyChainGeometry";
import type { EnergyChainSettings } from "@/types/layerling";

let runtime: ManifoldToplevel;
beforeAll(async () => {
  runtime = await ManifoldModule();
  runtime.setup();
});

const settings = (patch: Partial<EnergyChainSettings>) => normalizeEnergyChain({ ...DEFAULT_ENERGY_CHAIN, ...patch })!;

function solid(positions: Float32Array): Manifold {
  const mesh = new runtime.Mesh({ numProp: 3, vertProperties: positions, triVerts: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) });
  mesh.merge();
  return new runtime.Manifold(mesh);
}

describe("energy chain sizes", () => {
  it("follows the bought chains: the measured 10 x 15 is 15 x 23 outside, 20 pitch, R18", () => {
    const spec = energyChainSpec(settings({ size: "10x15" }));
    expect([spec.H, spec.W, spec.P, spec.T, spec.pinD, spec.bendRadius]).toEqual([15, 23, 20, 1.8, 5.5, 18]);
    // R18 with a 20 mm pitch: about 46 degrees a joint, the 48 the measured chain's 34.5 mm between its legs gives.
    expect(spec.thetaMax).toBeCloseTo(46.2, 1);
    expect(energyChainSpec(settings({ size: "15x30" })).bendRadius).toBe(28);
    expect(energyChainSpec(settings({ size: "20x25" })).bendRadius).toBe(38);
    expect([energyChainBendRadius(6), energyChainBendRadius(12)]).toEqual([12, 22]);
  });

  it("keeps one's own size inside its limits and the rest of the settings whole", () => {
    expect(normalizeEnergyChain({ size: "custom", innerHeight: 99, innerWidth: 1, lengthCm: 1000, play: 0, start: "nope" as never, end: "separate" })).toEqual({
      size: "custom", innerHeight: 30, innerWidth: 6, lengthCm: 300, play: 0.2, start: "attached", end: "separate",
    });
    // A standard size carries no inner size of its own.
    expect(normalizeEnergyChain({ size: "15x20", innerHeight: 12, lengthCm: 30, play: 0.4, start: "none", end: "none" })).not.toHaveProperty("innerHeight");
    expect(normalizeEnergyChain(null)).toBeNull();
  });

  it("makes the length of whole links", () => {
    expect(energyChainLinks(settings({ lengthCm: 100 }))).toEqual({ count: 50, length: 1000 });
    expect(energyChainLinks(settings({ lengthCm: 51 }))).toEqual({ count: 26, length: 520 });
    expect(energyChainLinks(settings({ size: "15x20", lengthCm: 5 })).count).toBe(2);
  });

  it("lays the links one pitch apart on a spiral whose joints bend between the stops", () => {
    const spec = energyChainSpec(settings({}));
    const pins = energyChainSpiral(spec, 80);
    const angles = pins.slice(1).map(([x, y], i) => Math.atan2(y - pins[i][1], x - pins[i][0]));
    pins.slice(1).forEach(([x, y], i) => expect(Math.hypot(x - pins[i][0], y - pins[i][1])).toBeCloseTo(spec.P, 6));
    const bends = angles.slice(1).map((a, i) => ((((a - angles[i]) * 180) / Math.PI + 540) % 360) - 180);
    expect(Math.max(...bends)).toBeLessThanOrEqual(spec.th1);
    expect(Math.min(...bends)).toBeGreaterThanOrEqual(spec.th0);
  });
});

describe("energy chain geometry", () => {
  for (const size of ["10x15", "15x20"] as const) {
    it(`${size}: one link a piece, never touching its neighbour between the stops, held by them beyond`, async () => {
      const spec = energyChainSpec(settings({ size }));
      const pieces = await energyChainPieces(runtime, spec);
      const link = solid(pieces.link);
      expect(link.decompose()).toHaveLength(1);
      for (let theta = spec.th0; theta <= spec.th1 + 1e-9; theta += 1) {
        expect(link.intersect(link.rotate([0, 0, theta]).translate([spec.P, 0, 0])).volume()).toBeLessThan(1e-3);
      }
      // A degree past straight or past the smallest radius the inner plates' square corners meet the next link.
      expect(link.intersect(link.rotate([0, 0, -1]).translate([spec.P, 0, 0])).volume()).toBeGreaterThan(0.1);
      expect(link.intersect(link.rotate([0, 0, spec.thetaMax + 1]).translate([spec.P, 0, 0])).volume()).toBeGreaterThan(0.1);
      // Held: the next link cannot slide off across or along the pins.
      const next = link.rotate([0, 0, 20]).translate([spec.P, 0, 0]);
      for (const shift of [[0, 0, 1], [0, 0, -1], [1.5, 0, 0], [-1.5, 0, 0]] as const) {
        expect(link.intersect(next.translate(shift)).volume()).toBeGreaterThan(0.5);
      }
      // Lying on the bed, no higher than the chain is wide.
      const box = link.boundingBox();
      expect(box.min[2]).toBeCloseTo(0, 6);
      expect(box.max[2]).toBeCloseTo(spec.W, 3);
    }, 120000);
  }

  it("takes apart: the outer plates spread over the pins and the link slides off forward", async () => {
    const spec = energyChainSpec(settings({}));
    const link = solid((await energyChainPieces(runtime, spec)).link);
    const theta = 20;
    const next = link.rotate([0, 0, theta]).translate([spec.P, 0, 0]);
    const spread = spec.engage + 0.15;
    const bottom = next.trimByPlane([0, 0, -1], -(spec.z.S0[1] + 0.001)).translate([0, 0, -spread]);
    const top = next.trimByPlane([0, 0, 1], spec.z.S6[0] - 0.001).translate([0, 0, spread]);
    for (const d of [0, 3, 8]) {
      const move: [number, number, number] = [d * Math.cos((theta * Math.PI) / 180), d * Math.sin((theta * Math.PI) / 180), 0];
      expect(link.intersect(bottom.translate(move)).volume()).toBeLessThan(1e-3);
      expect(link.intersect(top.translate(move)).volume()).toBeLessThan(1e-3);
    }
  }, 120000);

  it("prints a metre with both ends in place: every piece apart from every other", async () => {
    const chain = settings({ lengthCm: 100, start: "attached", end: "attached" });
    const spec = energyChainSpec(chain);
    const pieces = await energyChainPieces(runtime, spec);
    const { count } = energyChainLinks(chain);
    const layout = energyChainLayout(spec, count, "attached", "attached", energyChainExtents(pieces));
    expect(layout.filter((place) => place.piece === "link")).toHaveLength(count);
    const solids = layout.map((place) => solid(placedChainPiece(spec, pieces[place.piece], place)));
    const all = runtime.Manifold.union(solids);
    // Apart by the play everywhere: fused, two pieces would be one.
    expect(all.decompose()).toHaveLength(solids.length);
    // On a 256 mm plate.
    const box = all.boundingBox();
    expect(box.max[0] - box.min[0]).toBeLessThan(256);
    expect(box.max[1] - box.min[1]).toBeLessThan(256);
  }, 300000);

  it("lays ends printed apart beside the spiral on their tops, clear of it", async () => {
    const chain = settings({ lengthCm: 30, start: "separate", end: "separate" });
    const spec = energyChainSpec(chain);
    const pieces = await energyChainPieces(runtime, spec);
    const layout = energyChainLayout(spec, energyChainLinks(chain).count, "separate", "separate", energyChainExtents(pieces));
    const solids = layout.map((place) => solid(placedChainPiece(spec, pieces[place.piece], place)));
    expect(runtime.Manifold.union(solids).decompose()).toHaveLength(solids.length);
    layout.forEach((place, i) => {
      if (place.piece === "link") return;
      expect(place.flat).toBe(true);
      const box = solids[i].boundingBox();
      expect(box.min[2]).toBeCloseTo(0, 3);
      expect(box.max[2]).toBeCloseTo(spec.H, 3);
    });
  }, 120000);

  it("prints link by link: as many links as asked, each on its top, in rows close together, the ends apart", async () => {
    const chain = settings({ printAs: "pieces", pieces: 12, start: "attached", end: "separate" });
    expect(chain.start).toBe("separate");
    expect(energyChainLinks(chain).count).toBe(12);
    const spec = energyChainSpec(chain);
    const pieces = await energyChainPieces(runtime, spec);
    const layout = energyChainLayout(spec, 12, chain.start, chain.end, energyChainExtents(pieces), "pieces");
    expect(layout.filter((place) => place.piece === "link")).toHaveLength(12);
    expect(layout.every((place) => place.flat)).toBe(true);
    const solids = layout.map((place) => solid(placedChainPiece(spec, pieces[place.piece], place)));
    const all = runtime.Manifold.union(solids);
    expect(all.decompose()).toHaveLength(solids.length);
    for (const one of solids) expect(one.boundingBox().min[2]).toBeCloseTo(0, 3);
    // Rows close together: the block about as deep as wide, with 2 mm between the pieces.
    const box = all.boundingBox();
    const [width, depth] = [box.max[0] - box.min[0], box.max[1] - box.min[1]];
    expect(Math.max(width, depth) / Math.min(width, depth)).toBeLessThan(2);
    expect(width * depth).toBeLessThan(13 * (spec.P + 2 * spec.Ro + 8) * (spec.W + 2) * 1.6);
    // Back to the spiral: the length counts again.
    expect(energyChainLinks(settings({ lengthCm: 30 })).count).toBe(15);
  }, 120000);
});
