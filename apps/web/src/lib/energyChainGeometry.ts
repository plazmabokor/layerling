import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { CadModifierEnergyChainPart, ChainFigure } from "@/lib/cadModifierTypes";
import { CHAIN_SLABS, energyChainSpiral, type EnergyChainSpec } from "@/lib/energyChain";
import { chainPieceFigures, movedFigure, type ChainPieceFigures } from "@/lib/energyChainShapes";

/*
 * The energy chain's solids in the print frame (x along the chain, y across its height, z across its width, 0 on
 * the bed): seven slabs (lib/energyChain.ts names them), each a flat figure of exact parts (lib/energyChainShapes.ts
 * works them out) pushed up onto the one below, and the pins. The display mesh draws the figures' arcs finely; the
 * CAD kernel builds the very same figures with true arcs (lib/energyChainSolid.ts), so the two are one shape.
 */

const TONGUE_THICK = 3;
/** The display mesh draws an arc with a point every this many degrees. */
const ARC_STEP = 2;
const SEG = 64;

export type ChainPieceKind = "link" | "start" | "end";

/** Every WebAssembly object made while building, deleted together at the end. */
class Scope {
  private made: Array<{ delete(): void }> = [];
  keep<T extends { delete(): void }>(value: T): T {
    this.made.push(value);
    return value;
  }
  dispose() {
    for (const value of new Set(this.made)) value.delete();
    this.made = [];
  }
}

/** A figure as the 2D kernel's cross-section, its arcs drawn a point every ARC_STEP degrees. */
function crossSectionOf(runtime: ManifoldToplevel, scope: Scope, figure: ChainFigure): CrossSection {
  const { CrossSection } = runtime;
  const k = <T extends { delete(): void }>(value: T) => scope.keep(value);
  const empty = () => {
    const square = k(CrossSection.square([1, 1]));
    return k(square.subtract(square));
  };
  switch (figure.kind) {
    case "outline": {
      // In the kernel's plane z is -y.
      const { loop } = figure;
      const points: Array<[number, number]> = [[loop.x, -loop.z]];
      for (const segment of loop.segments) {
        if (segment.kind === "arc") {
          const steps = Math.max(2, Math.ceil(Math.abs(segment.end - segment.start) / ((ARC_STEP * Math.PI) / 180)));
          for (let i = 1; i <= steps; i++) {
            const t = segment.start + ((segment.end - segment.start) * i) / steps;
            points.push([segment.cx + segment.rx * Math.cos(t), -(segment.cz + segment.rz * Math.sin(t))]);
          }
        } else {
          points.push([segment.x, -segment.z]);
        }
      }
      if (Math.hypot(points[0][0] - points[points.length - 1][0], points[0][1] - points[points.length - 1][1]) < 1e-9) points.pop();
      // Counter-clockwise for the fill.
      const area = points.reduce((sum, [x, y], i) => sum + x * points[(i + 1) % points.length][1] - points[(i + 1) % points.length][0] * y, 0);
      if (area < 0) points.reverse();
      return k(new CrossSection([points], "Positive"));
    }
    case "union": {
      const parts = figure.of.map((part) => crossSectionOf(runtime, scope, part)).filter((part) => !part.isEmpty());
      return parts.length ? k(CrossSection.union(parts)) : empty();
    }
    case "common":
      return figure.of.map((part) => crossSectionOf(runtime, scope, part)).reduce((a, b) => k(a.intersect(b)));
    case "cut": {
      const from = crossSectionOf(runtime, scope, figure.from);
      const minus = figure.minus.map((part) => crossSectionOf(runtime, scope, part)).filter((part) => !part.isEmpty());
      return minus.length ? k(from.subtract(k(CrossSection.union(minus)))) : from;
    }
  }
}

/**
 * A pin from z0 to z1 about the z axis, its free end at z1 (`tip` +1) or z0 (-1): chamfered all round by tipChamfer
 * and cut at 45 degrees on the side `dir` (+1: +x, -1: -x) a plate slides on from.
 */
function pin(runtime: ManifoldToplevel, scope: Scope, spec: EnergyChainSpec, r: number, z0: number, z1: number, tip: 1 | -1, dir: 1 | -1): Manifold {
  const { Manifold } = runtime;
  const k = <T extends { delete(): void }>(value: T) => scope.keep(value);
  const length = z1 - z0;
  const t = spec.tipChamfer;
  // Made with its end at the top, from 0 up to its length.
  const body = k(Manifold.union([k(Manifold.cylinder(length - t, r, r, SEG)), k(k(Manifold.cylinder(t, r, r - t, SEG)).translate([0, 0, length - t]))]));
  const c = spec.chamfer;
  const s = Math.SQRT1_2;
  const cut = k(body.trimByPlane([-dir * s, 0, -s], -((r - c) + length) * s));
  return tip > 0 ? k(cut.translate([0, 0, z0])) : k(k(cut.mirror([0, 0, 1])).translate([0, 0, z1]));
}

/** A tongue along the inside of the bend with two countersunk screw holes (M3), from x0 to x1. */
function tongue(runtime: ManifoldToplevel, scope: Scope, spec: EnergyChainSpec, x0: number, x1: number, holes: number[]): Manifold {
  const { Manifold } = runtime;
  const k = <T extends { delete(): void }>(value: T) => scope.keep(value);
  const thick = TONGUE_THICK;
  const y0 = spec.H / 2 - thick;
  let plate = k(k(Manifold.cube([x1 - x0, thick, spec.W])).translate([x0, y0, 0]));
  for (const x of holes) {
    const shaft = k(k(k(Manifold.cylinder(thick + 2, 1.7, 1.7, SEG)).rotate([-90, 0, 0])).translate([x, y0 - 1, spec.W / 2]));
    const head = k(k(k(Manifold.cylinder(1.7, 1.7, 3.4, SEG)).rotate([-90, 0, 0])).translate([x, spec.H / 2 - 1.7 + 0.001, spec.W / 2]));
    plate = k(k(plate.subtract(shaft)).subtract(head));
  }
  return plate;
}

/** The slabs' figures pushed up one onto another. */
function extrude(runtime: ManifoldToplevel, scope: Scope, spec: EnergyChainSpec, figures: ChainPieceFigures): Manifold {
  const solids = CHAIN_SLABS.map((slab) => {
    const [z0, z1] = spec.z[slab];
    // Sampled arcs leave hairline slivers where a fillet meets its edges; only real areas stay.
    const pieces = scope.keep(crossSectionOf(runtime, scope, figures[slab])).decompose().map((part) => scope.keep(part)).filter((part) => part.area() > 1e-3);
    if (!pieces.length) return null;
    const section = scope.keep(runtime.CrossSection.compose(pieces));
    // Each slab reaches a micrometre into the one below it, so touching slabs always fuse.
    const bottom = z0 > 0 ? z0 - 0.001 : z0;
    return scope.keep(scope.keep(section.extrude(z1 - bottom)).translate([0, 0, bottom]));
  }).filter((solid): solid is Manifold => solid !== null);
  return scope.keep(runtime.Manifold.union(solids));
}

function positionsOf(solid: Manifold): Float32Array {
  const mesh = solid.getMesh();
  const out = new Float32Array(mesh.triVerts.length * 3);
  const stride = mesh.numProp;
  for (let i = 0; i < mesh.triVerts.length; i++) {
    const v = mesh.triVerts[i] * stride;
    out[i * 3] = mesh.vertProperties[v];
    out[i * 3 + 1] = mesh.vertProperties[v + 1];
    out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

export type ChainPieces = {
  /** Triangles (x, y, z per corner) in the print frame: a link with its rear pin at the origin and its front pin at (P, 0). */
  link: Float32Array;
  /** The pin end piece: its pins where the first link's holes are (the origin), its tongue behind. */
  start: Float32Array;
  /** The hole end piece: its holes where the last link's pins are (the origin), its tongue in front. */
  end: Float32Array;
  /** Each piece for the CAD kernel: the same figures, layer by layer, its pins and tongue (no key or placement yet). */
  exact: Record<ChainPieceKind, Omit<CadModifierEnergyChainPart, "key" | "transform" | "expected">>;
};

const cache = new Map<string, Promise<ChainPieces>>();
const resolved = new Map<string, ChainPieces>();

/**
 * The pieces of this spec now, without waiting: made already, or made here with the runtime given; null when
 * neither (the 2D kernel not loaded yet). The CAD kernel's exact bodies are worked out from them.
 */
export function energyChainPiecesNow(runtime: ManifoldToplevel | null, spec: EnergyChainSpec): ChainPieces | null {
  const key = JSON.stringify(spec);
  const known = resolved.get(key);
  if (known) return known;
  if (!runtime) return null;
  const pieces = buildPieces(runtime, spec);
  remember(key, pieces);
  return pieces;
}

function remember(key: string, pieces: ChainPieces) {
  resolved.set(key, pieces);
  if (resolved.size > 6) resolved.delete(resolved.keys().next().value!);
}

/** The link and the two end pieces of a chain of this spec, made once and kept for the session. */
export function energyChainPieces(runtime: ManifoldToplevel, spec: EnergyChainSpec): Promise<ChainPieces> {
  const key = JSON.stringify(spec);
  let made = cache.get(key);
  if (!made) {
    made = Promise.resolve().then(() => resolved.get(key) ?? buildPieces(runtime, spec));
    made.then((pieces) => remember(key, pieces), () => undefined);
    made.catch(() => cache.delete(key));
    cache.set(key, made);
    // A handful of sizes at most stay in memory.
    if (cache.size > 6) cache.delete(cache.keys().next().value!);
  }
  return made;
}

function buildPieces(runtime: ManifoldToplevel, spec: EnergyChainSpec): ChainPieces {
  const scope = new Scope();
  try {
    const pinR = spec.pinD / 2;
    // Both pins at the front joint, standing out of the inner plates through the next link's outer plates to their
    // outer faces: the lower one down to the bed, the upper one up to the top. Both slide-on chamfers face forward.
    type PinAt = { r: number; z0: number; z1: number; tip: 1 | -1; dir: 1 | -1 };
    const lowerPinAt: PinAt = { r: pinR, z0: 0, z1: spec.z.S2[0] + 0.01, tip: -1, dir: 1 };
    const upperPinAt: PinAt = { r: pinR, z0: spec.z.S4[1] - 0.01, z1: spec.W, tip: 1, dir: 1 };
    const frontPins = () => [lowerPinAt, upperPinAt].map((at) => scope.keep(pin(runtime, scope, spec, at.r, at.z0, at.z1, at.tip, at.dir).translate([spec.P, 0, 0])));
    const linkFigures = chainPieceFigures(spec, true, true);
    const linkSolid = scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, linkFigures), ...frontPins()]));
    // The pin end: a link's front end with its pins (the first link's holes go over them), closed behind, with the
    // tongue behind it; moved so its pins are at the origin.
    const startFigures = chainPieceFigures(spec, false, true);
    const back = spec.P - spec.Ro - 5;
    const startTongue = { x0: back - 21, x1: back + 3, holes: [back - 4, back - 15] };
    const startSolid = scope.keep(scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, startFigures), ...frontPins(), tongue(runtime, scope, spec, startTongue.x0, startTongue.x1, startTongue.holes)])).translate([-spec.P, 0, 0]));
    // The hole end: a link's rear end with its holes (they go over the last link's pins), closed in front, with the tongue in front.
    const endFigures = chainPieceFigures(spec, true, false);
    const ahead = spec.Ro + 5;
    // The tongue starts 2 mm inside the square front, clear of the grooves and the clear round about the rear pin.
    const endTongue = { x0: ahead - 2, x1: ahead + 21, holes: [ahead + 4, ahead + 15] };
    const endSolid = scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, endFigures), tongue(runtime, scope, spec, endTongue.x0, endTongue.x1, endTongue.holes)]));
    // The same pieces for the CAD kernel, y up: the figures as layers, the pins as they stand, the tongues.
    const exactOf = (figures: ChainPieceFigures, dx: number, pins: Array<PinAt & { x: number }>, tongueAt?: { x0: number; x1: number; holes: number[] }) => ({
      layers: CHAIN_SLABS.map((slab) => ({ y0: spec.z[slab][0], y1: spec.z[slab][1], figure: dx ? movedFigure(figures[slab], dx) : figures[slab] })),
      pins: pins.map((at) => ({ x: at.x + dx, radius: at.r, y0: at.z0, y1: at.z1, tip: at.tip, chamferSide: at.dir, chamfer: spec.chamfer, tipChamfer: spec.tipChamfer })),
      ...(tongueAt ? { tongue: { x0: tongueAt.x0 + dx, x1: tongueAt.x1 + dx, z0: -spec.H / 2, z1: -spec.H / 2 + TONGUE_THICK, width: spec.W, holes: tongueAt.holes.map((x) => x + dx), hole: 1.7, head: 3.4 } } : {}),
    });
    const exact = {
      link: exactOf(linkFigures, 0, [{ ...lowerPinAt, x: spec.P }, { ...upperPinAt, x: spec.P }]),
      start: exactOf(startFigures, -spec.P, [{ ...lowerPinAt, x: spec.P }, { ...upperPinAt, x: spec.P }], startTongue),
      end: exactOf(endFigures, 0, [], endTongue),
    };
    return { link: positionsOf(linkSolid), start: positionsOf(startSolid), end: positionsOf(endSolid), exact };
  } finally {
    scope.dispose();
  }
}

/**
 * One piece where it lies on the plate: the piece, its pin's place and its turn (degrees, about z), and
 * whether it lies on its side as in the spiral or, printed on its own, on its top (`flat`): a piece alone
 * has no neighbour under its inner plates, so it lies on the flat top of its plates and the lid.
 */
export type ChainPlacement = { piece: ChainPieceKind; x: number; y: number; angle: number; flat?: boolean };

/** How far each piece reaches along the chain, its pin at 0 (print frame x). */
export type ChainExtents = Record<ChainPieceKind, [number, number]>;

export function energyChainExtents(pieces: ChainPieces): ChainExtents {
  const reach = (positions: Float32Array): [number, number] => {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      min = Math.min(min, positions[i]);
      max = Math.max(max, positions[i]);
    }
    return [min, max];
  };
  return { link: reach(pieces.link), start: reach(pieces.start), end: reach(pieces.end) };
}

/** A piece's triangles where the placement puts them, in the print frame (z up from the plate). */
export function placedChainPiece(spec: EnergyChainSpec, source: Float32Array, place: ChainPlacement): Float32Array {
  const angle = (place.angle * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    // On its top: the chain's height (y) goes down into the plate, its width (z) lies across.
    const x = source[i];
    const y = place.flat ? source[i + 2] : source[i + 1];
    const z = place.flat ? spec.H / 2 - source[i + 1] : source[i + 2];
    out[i] = x * cos - y * sin + place.x;
    out[i + 1] = x * sin + y * cos + place.y;
    out[i + 2] = z;
  }
  return out;
}

/** The gap between pieces printed on their own. */
const PIECE_GAP = 2;

/**
 * Where every piece lies when printed (print frame). In the spiral: the links on it, the pin end before
 * the first one bent in towards the free middle as far as the joint goes, the hole end after the last
 * one straight on; an end printed apart lies beside the spiral on its top, to be snapped on. Link by link
 * ("pieces"): every link on its top, in rows close together, about as deep as wide, the ends in a row of
 * their own after them.
 */
export function energyChainLayout(spec: EnergyChainSpec, count: number, start: "none" | "attached" | "separate", end: "none" | "attached" | "separate", extents: ChainExtents, printAs: "spiral" | "pieces" = "spiral"): ChainPlacement[] {
  const placements: ChainPlacement[] = [];
  const across = spec.W + PIECE_GAP;
  const length = (piece: ChainPieceKind) => extents[piece][1] - extents[piece][0];
  // Pieces apart in a row from (x0, y): each one's own reach along x, one after another.
  const row = (pieces: ChainPieceKind[], x0: number, y: number) => {
    let x = x0;
    for (const piece of pieces) {
      placements.push({ piece, x: x - extents[piece][0], y, angle: 0, flat: true });
      x += length(piece) + PIECE_GAP;
    }
  };
  const ends = [...(start === "separate" ? ["start" as const] : []), ...(end === "separate" ? ["end" as const] : [])];
  if (printAs === "pieces") {
    const cell = length("link") + PIECE_GAP;
    const columns = Math.max(1, Math.min(count, Math.ceil(Math.sqrt((count * across) / cell))));
    for (let i = 0; i < count; i++) row(["link"], (i % columns) * cell, Math.floor(i / columns) * across);
    if (ends.length) row(ends, 0, Math.ceil(count / columns) * across);
    return placements;
  }
  const pins = energyChainSpiral(spec, count);
  const angles: number[] = [];
  for (let i = 0; i < count; i++) {
    const [x0, y0] = pins[i];
    const [x1, y1] = pins[i + 1];
    const angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
    angles.push(angle);
    placements.push({ piece: "link", x: x0, y: y0, angle });
  }
  let maxX = -Infinity, minY = Infinity;
  for (const [x, y] of pins) {
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
  }
  if (start === "attached") placements.push({ piece: "start", x: pins[0][0], y: pins[0][1], angle: angles[0] - (spec.th1 - 1) });
  if (end === "attached") placements.push({ piece: "end", x: pins[count][0], y: pins[count][1], angle: angles[count - 1] + spec.th0 + 1 });
  // Apart: beside the spiral on its right, one above the other.
  ends.forEach((piece, i) => row([piece], maxX + spec.H, minY - spec.Ro + i * across));
  return placements;
}
