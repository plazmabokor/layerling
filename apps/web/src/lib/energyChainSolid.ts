import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type { CadModifierEnergyChainPart } from "@/lib/cadModifierTypes";

type CadModifierPart = CadModifierEnergyChainPart;
import { profileExtrusionSolid } from "@/lib/cadProfileSolid";

/*
 * The exact body of an energy chain piece (lib/energyChainGeometry.ts works out its outlines), in the piece's own
 * frame, y up (see CadModifierEnergyChainPart). Every layer is its outlines pushed up; the layers touch, the pins
 * stand on theirs, and all of it is fused into one solid. A chain repeats one link many times, so a piece built once
 * is kept - as its BREP text, since the worker lets go of every shape after each job - and read back.
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

function buildPiece(cad: OcctKernel, part: CadModifierEnergyChainPart): ShapeHandle {
  const solids: ShapeHandle[] = [];
  const prism = (loops: CadModifierPart["layers"][number]["outlines"][number], y0: number, height: number) => cad.translate(profileExtrusionSolid(cad, { kind: "extrusion", loops, height }), 0, y0, 0);
  for (const layer of part.layers) {
    const height = layer.y1 - layer.y0;
    if (!(height > 0)) throw new Error("An energy chain layer has no height");
    if (layer.within === undefined) {
      for (const loops of layer.outlines) solids.push(prism(loops, layer.y0, height));
      continue;
    }
    // The thin layer: the plate's own outline (its very edges), within its own outlines, over its own height.
    for (const outer of part.layers[layer.within].outlines) {
      for (const own of layer.outlines) {
        let common = cad.common(prism(outer, layer.y0, height), prism(own, layer.y0, height));
        if (layer.free) {
          const round = cad.translate(cad.rotate(cad.makeCylinder(layer.free.radius, height + 2), { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2), layer.free.x, layer.y0 - 1, 0);
          common = cad.cut(common, round);
        }
        for (const solid of cad.getSubShapes(common, "solid")) if (cad.getVolume(solid) > 0.05) solids.push(solid);
      }
    }
  }
  for (const pin of part.pins) {
    // An upright cylinder (z up turned to y up), cut on one side of its top by the chamfer's plane.
    const height = pin.y1 - pin.y0;
    const cylinder = cad.rotate(cad.makeCylinder(pin.radius, height), { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, -Math.PI / 2);
    const placed = cad.translate(cylinder, pin.x, pin.y0, 0);
    const plane = { x: pin.x + pin.chamferSide * (pin.radius - pin.chamfer), y: pin.y1, z: 0 };
    solids.push(cad.cut(placed, cad.halfSpace(plane, { x: pin.chamferSide, y: 1, z: 0 })));
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
  if (pieces.length !== 1) throw new Error(`The energy chain piece came out as ${pieces.length} solids (${pieces.map((piece) => cad.getVolume(piece).toFixed(1) + " @" + JSON.stringify(Object.values(cad.getBoundingBox(piece)).map((v) => Number(v).toFixed(1)))).join(", ")} mm³)`);
  if (!cad.isValid(pieces[0]) || !(cad.getVolume(pieces[0]) > 0)) throw new Error("The energy chain piece is not a valid solid");
  return pieces[0];
}
