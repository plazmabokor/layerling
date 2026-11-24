import ManifoldModule from "manifold-3d";
import { OcctKernel, type ShapeHandle } from "occt-wasm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyCadTransform } from "@/lib/cadModifierRuntime";
import { cadModifierEnergyChainForShape, cadProfileExpectation } from "@/lib/cadProfileExtrusion";
import { cadProfileSolidMismatch } from "@/lib/cadProfileSolid";
import { DEFAULT_ENERGY_CHAIN, energyChainSpec, normalizeEnergyChain } from "@/lib/energyChain";
import { energyChainPieces } from "@/lib/energyChainGeometry";
import { energyChainPartSolid } from "@/lib/energyChainSolid";
import { energyChainShape } from "@/lib/editorEnergyChain";
import { rememberManifoldRuntime } from "@/lib/manifoldHandle";
import { stepSourceForShape } from "@/lib/stepExport";
import type { EnergyChainSettings, WorkplaneShape } from "@/types/layerling";

/*
 * The energy chain's pieces as exact CAD bodies (Discussion #2032): built from the same outlines as their meshes, every
 * round a true arc, one valid solid each, placed where the mesh lies, and as free to turn as the mesh between the stops.
 */

const manifold = vi.hoisted(() => ({ runtime: null as unknown }));
vi.mock("@/lib/editorMeshCore", async (original) => ({ ...(await original<typeof import("@/lib/editorMeshCore")>()), getManifoldRuntime: async () => manifold.runtime }));

let cad: OcctKernel;
beforeAll(async () => {
  const runtime = await ManifoldModule();
  runtime.setup();
  manifold.runtime = runtime;
  rememberManifoldRuntime(runtime);
  cad = await OcctKernel.init({ wasm: join(dirname(fileURLToPath(import.meta.resolve("occt-wasm"))), "occt-wasm.wasm") });
});

const settings = (patch: Partial<EnergyChainSettings>) => normalizeEnergyChain({ ...DEFAULT_ENERGY_CHAIN, ...patch })!;

function worldMesh(part: WorkplaneShape) {
  const positions = part.importedMesh!.positions;
  const vertices: Array<[number, number, number]> = [];
  const faces: Array<[number, number, number]> = [];
  for (let i = 0; i < positions.length; i += 3) vertices.push([positions[i] + part.x, positions[i + 1] + (part.elevation ?? 0), positions[i + 2] + part.z]);
  for (let i = 0; i < vertices.length; i += 3) faces.push([i, i + 1, i + 2]);
  return { vertices, faces };
}

function exactBody(part: WorkplaneShape): ShapeHandle {
  const exact = cadModifierEnergyChainForShape(part);
  expect(exact).not.toBeNull();
  const placed = applyCadTransform(cad, energyChainPartSolid(cad, exact!), exact!.transform);
  const mesh = worldMesh(part);
  expect(cadProfileSolidMismatch(cad, placed, cadProfileExpectation(mesh.vertices, mesh.faces))).toBeNull();
  return placed;
}

describe("energy chain as exact bodies", () => {
  for (const [name, patch] of [
    ["10 x 15 in the spiral with both ends", { lengthCm: 10 }],
    ["20 x 25 link by link, ends apart", { size: "20x25", printAs: "pieces", pieces: 2, start: "separate", end: "separate" }],
    ["one's own 6 x 6", { size: "custom", innerHeight: 6, innerWidth: 6, lengthCm: 5 }],
  ] as const) {
    it(`${name}: every piece one valid solid where its mesh lies, its rounds true cylinders`, async () => {
      const chain = await energyChainShape(settings(patch as Partial<EnergyChainSettings>));
      const parts = chain.groupedShapes!;
      for (const part of parts) {
        // STEP export builds the same body.
        expect(stepSourceForShape(part)).toBe("energyChain");
        const body = exactBody(part);
        expect(cad.getSubShapes(body, "solid")).toHaveLength(1);
        expect(cad.isValid(body)).toBe(true);
        const kinds = cad.getSubShapes(body, "face").map((face) => cad.surfaceType(face));
        expect(kinds.filter((kind) => kind === "cylinder").length).toBeGreaterThan(8);
      }
    }, 300000);
  }

  for (const [name, patch] of [
    ["10x15", {}],
    ["20x25", { size: "20x25" }],
    ["one's own 30x60, play 0.2", { size: "custom", innerHeight: 30, innerWidth: 60, play: 0.2 }],
    ["one's own 6x6, play 0.8", { size: "custom", innerHeight: 6, innerWidth: 6, play: 0.8 }],
  ] as const) {
    it(`${name}: every piece a valid solid of true lines and arcs, no hairline edges, the link free between the stops`, async () => {
      const spec = energyChainSpec(settings(patch as Partial<EnergyChainSettings>));
      const pieces = (await energyChainPieces(manifold.runtime as never, spec))!;
      for (const kind of ["link", "start", "end"] as const) {
        const body = energyChainPartSolid(cad, { key: `${name}-${kind}`, ...pieces.exact[kind] });
        expect(cad.isValid(body)).toBe(true);
        expect(cad.getSubShapes(body, "solid")).toHaveLength(1);
        const edges = cad.getSubShapes(body, "edge");
        // Where two edges meet they meet at a point worked out exactly: none is a sliver left between them.
        expect(Math.min(...edges.map((edge) => cad.curveLength(edge)))).toBeGreaterThanOrEqual(0.2 - 1e-6);
        expect(edges.every((edge) => ["line", "circle", "ellipse"].includes(cad.curveType(edge)))).toBe(true);
      }
      const link = energyChainPartSolid(cad, { key: `${name}-link`, ...pieces.exact.link });
      const next = (degrees: number) => cad.translate(cad.rotate(link, { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, (degrees * Math.PI) / 180), spec.P, 0, 0);
      for (let theta = spec.th0; theta <= spec.th1 + 1e-9; theta += 4) expect(cad.getVolume(cad.common(link, next(theta)))).toBeLessThan(1e-3);
      expect(cad.getVolume(cad.common(link, next(-3)))).toBeGreaterThan(0.02);
      expect(cad.getVolume(cad.common(link, next(spec.thetaMax + 3)))).toBeGreaterThan(0.02);
    }, 300000);
  }

  it("a link turns as freely as its mesh: nothing in common between the stops, the stops hold beyond", async () => {
    const spec = energyChainSpec(settings({}));
    const pieces = await energyChainPieces(manifold.runtime as never, spec).catch(() => null);
    expect(pieces).not.toBeNull();
    const link = energyChainPartSolid(cad, { key: "turn", ...pieces!.exact.link });
    // In its own frame y is up (the print frame's z) and z the print frame's -y: a joint turns about +y, the next link a pitch along x.
    const next = (degrees: number) => cad.translate(cad.rotate(link, { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } }, (degrees * Math.PI) / 180), spec.P, 0, 0);
    const common = (degrees: number) => cad.getVolume(cad.common(link, next(degrees)));
    for (let theta = spec.th0; theta <= spec.th1 + 1e-9; theta += 4) expect(common(theta)).toBeLessThan(1e-3);
    expect(common(-1.5)).toBeGreaterThan(0.05);
    expect(common(spec.thetaMax + 2)).toBeGreaterThan(0.05);
    // The edge tools work on it: the outer plate's edges on the bed rounded off at once.
    const onBed = cad.getSubShapes(link, "edge").filter((edge) => {
      const box = cad.getBoundingBox(edge);
      return Math.abs(box.ymin) < 1e-6 && Math.abs(box.ymax) < 1e-6;
    });
    expect(onBed.length).toBeGreaterThan(4);
    const rounded = cad.fillet(link, onBed, 0.5);
    expect(cad.isValid(rounded)).toBe(true);
  }, 300000);
});
