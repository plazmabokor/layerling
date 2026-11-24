import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type { CadModifierEnergyChainPart, ChainFigure } from "@/lib/cadModifierTypes";
import { profileExtrusionSolid } from "@/lib/cadProfileSolid";

/*
 * The exact body of an energy chain piece, in the piece's own frame, y up (see CadModifierEnergyChainPart): every
 * layer is its figure (lib/energyChainShapes.ts) built with true arcs - each outline pushed up the layer's height,
 * joined, cut away and taken in common as the figure says - and the layers, the pins on theirs and the tongue are
 * fused into one solid. A chain repeats one link many times, so a piece built once is kept - as its BREP text,
 * since the worker lets go of every shape after each job - and read back.
 */

const built = new Map<string, string>();

export function energyChainPartSolid(cad: OcctKernel, part: CadModifierEnergyChainPart): ShapeHandle {
  const known = built.get(part.key);
  if (known) {
    try {
      const restored = cad.fromBREP(known);
      const solids = cad.isSolid(restored) ? [restored] : cad.getSubShapes(restored, "solid");
      if (solids.length === 1) return solids[0];
    } catch {
      // Built afresh below.
    }
  }
  const solid = buildPiece(cad, part);
  // A handful of sizes at most stay.
  if (built.size > 12) built.delete(built.keys().next().value!);
  built.set(part.key, cad.toBREP(solid));
  return solid;
}

/** A figure pushed up `height` from y = 0; null when nothing is left of it. */
function figureSolid(cad: OcctKernel, figure: ChainFigure, height: number): ShapeHandle | null {
  switch (figure.kind) {
    case "outline":
      return profileExtrusionSolid(cad, { kind: "extrusion", loops: [figure.loop], height });
    case "union": {
      const parts = figure.of.map((part) => figureSolid(cad, part, height)).filter((part): part is ShapeHandle => part !== null);
      if (!parts.length) return null;
      return parts.length === 1 ? parts[0] : cad.fuseAll(parts);
    }
    case "common": {
      let result: ShapeHandle | null = null;
      for (const part of figure.of) {
        const solid = figureSolid(cad, part, height);
        if (!solid) return null;
        result = result ? cad.common(result, solid) : solid;
      }
      return result && cad.getVolume(result) > 1e-9 ? result : null;
    }
    case "cut": {
      const from = figureSolid(cad, figure.from, height);
      if (!from) return null;
      const minus = figure.minus.map((part) => figureSolid(cad, part, height)).filter((part): part is ShapeHandle => part !== null);
      if (!minus.length) return from;
      const result = cad.cut(from, minus.length === 1 ? minus[0] : cad.fuseAll(minus));
      return cad.getVolume(result) > 1e-9 ? result : null;
    }
  }
}

function buildPiece(cad: OcctKernel, part: CadModifierEnergyChainPart): ShapeHandle {
  const solids: ShapeHandle[] = [];
  for (const layer of part.layers) {
    const height = layer.y1 - layer.y0;
    if (!(height > 0)) throw new Error("An energy chain layer has no height");
    const solid = figureSolid(cad, layer.figure, height);
    if (solid) solids.push(cad.translate(solid, 0, layer.y0, 0));
  }
  for (const pin of part.pins) {
    // Made with its free end at the top (z up turned to y up): a cylinder and the cone of the chamfer all round its
    // end, cut on one side of the end by the slide-on chamfer's plane; turned end down about x if its end is below.
    const height = pin.y1 - pin.y0;
    const t = pin.tipChamfer;
    const upright = (shape: ShapeHandle) => cad.rotate(shape, { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2);
    const body = cad.fuse(upright(cad.makeCylinder(pin.radius, height - t)), cad.translate(upright(cad.makeCone(pin.radius, pin.radius - t, t)), 0, height - t, 0));
    const plane = { x: pin.chamferSide * (pin.radius - pin.chamfer), y: height, z: 0 };
    let shaped = cad.unifySameDomain(cad.cut(body, cad.halfSpace(plane, { x: pin.chamferSide, y: 1, z: 0 })));
    if (pin.tip < 0) shaped = cad.rotate(shaped, { point: { x: 0, y: height / 2, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, Math.PI);
    solids.push(cad.translate(shaped, pin.x, pin.y0, 0));
  }
  let body = solids.length === 1 ? solids[0] : cad.fuseAll(solids);
  if (part.tongue) {
    const tongue = part.tongue;
    let plate = cad.makeBoxFromCorners({ x: tongue.x0, y: 0, z: tongue.z0 }, { x: tongue.x1, y: tongue.width, z: tongue.z1 });
    for (const x of tongue.holes) {
      // Through the plate along z, the countersink opening at z0 (the side the chain bends towards).
      const shaft = cad.translate(cad.makeCylinder(tongue.hole, tongue.z1 - tongue.z0 + 2), x, tongue.width / 2, tongue.z0 - 1);
      const head = cad.translate(cad.makeCone(tongue.head, tongue.hole, tongue.head - tongue.hole), x, tongue.width / 2, tongue.z0);
      plate = cad.cut(cad.cut(plate, shaft), head);
    }
    body = cad.fuse(body, plate);
  }
  body = cad.unifySameDomain(body);
  const pieces = cad.isSolid(body) ? [body] : cad.getSubShapes(body, "solid");
  if (pieces.length !== 1) throw new Error(`The energy chain piece came out as ${pieces.length} solids (${pieces.map((piece) => cad.getVolume(piece).toFixed(1)).join(", ")} mm³)`);
  if (!cad.isValid(pieces[0]) || !(cad.getVolume(pieces[0]) > 0)) throw new Error("The energy chain piece is not a valid solid");
  return pieces[0];
}
