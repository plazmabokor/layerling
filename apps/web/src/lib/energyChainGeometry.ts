import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import { CHAIN_SLABS, energyChainSpiral, type ChainSlab, type EnergyChainSpec } from "@/lib/energyChain";

/*
 * The energy chain's solids, worked out in the print frame (x along the chain, y across its height, z
 * across its width, 0 on the bed) as seven slabs of 2D outlines extruded one on another (lib/energyChain.ts
 * names them). At every joint the link behind (its rear end) and the link in front (its front end) meet;
 * their own joint pieces are fixed (outer plates with the holes, inner plates with their square corners,
 * posts, pins). Everything else of a link - its body - keeps a play's width from whatever its neighbours
 * have in the same slab or a slab touching it, swept over the turn the joint makes; worked out three times
 * over, since a neighbour is the same link. A round end has the right of way: the plates' straight ends
 * are hollowed round the neighbour's whole round end, so seen from the side every plate is a D whose
 * neighbour turns in its hollow, as on a bought chain. A link is solid where one slab sits on another,
 * apart from each other link by the play, so the chain is printed in one piece and moves.
 */

const SEG = 48;
/** Outlines lose points closer than this to a straight line through their neighbours: a tidy, light mesh, the play kept. */
const SIMPLIFY = 0.03;

export type ChainPieceKind = "link" | "start" | "end";

type Slabs = Record<ChainSlab, CrossSection>;

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

function tools(runtime: ManifoldToplevel, scope: Scope) {
  const { CrossSection } = runtime;
  const k = <T extends { delete(): void }>(value: T) => scope.keep(value);
  const circle = (r: number, x = 0, y = 0) => k(k(CrossSection.circle(r, SEG)).translate([x, y]));
  const rect = (x0: number, x1: number, y0: number, y1: number) => k(new CrossSection([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]], "Positive"));
  const union = (parts: CrossSection[]) => {
    const real = parts.filter((part) => !part.isEmpty());
    if (real.length) return k(CrossSection.union(real));
    const square = k(CrossSection.square([1, 1]));
    return k(square.subtract(square));
  };
  const add = (a: CrossSection, b: CrossSection) => k(a.add(b));
  const sub = (a: CrossSection, b: CrossSection) => k(a.subtract(b));
  const cut = (a: CrossSection, b: CrossSection) => k(a.intersect(b));
  const grow = (a: CrossSection, d: number) => (d > 0 ? k(a.offset(d, "Round", 2, SEG)) : a);
  const move = (a: CrossSection, x: number, y = 0) => k(a.translate([x, y]));
  const turn = (a: CrossSection, degrees: number) => k(a.rotate(degrees));
  const sweep = (a: CrossSection, from: number, to: number, step: number) => {
    // A lighter outline turned step by step; between two steps a corner near the pin moves ~0.35 mm.
    const light = k(a.simplify(0.02));
    const n = Math.max(1, Math.ceil((to - from) / step));
    return union(Array.from({ length: n + 1 }, (_, i) => turn(light, from + ((to - from) * i) / n)));
  };
  const hull = (parts: CrossSection[]) => k(CrossSection.hull(parts));
  // Rounds the outline's outer corners (in and out again); it only ever takes material away.
  const round = (a: CrossSection, r: number) => (r > 0 ? k(k(a.offset(-r, "Round", 2, SEG)).offset(r, "Round", 2, SEG)) : a);
  return { circle, rect, union, add, sub, cut, grow, move, turn, sweep, hull, round, k };
}

function features(spec: EnergyChainSpec, t: ReturnType<typeof tools>) {
  const { H, h, Ro, rh } = spec;
  const pinR = spec.pinD / 2;
  const disc = t.circle(Ro);
  const hole = t.circle(pinR + spec.pinPlay);
  const ring = t.circle(pinR + spec.pinPlay + 1.5);
  // The inner plates' front corners stay square, round in between: under the next link's outer plate they
  // turn in its grooves, and past straight (the heel, below) or past the largest bend (the lug, above) they
  // meet it - the stops.
  const corners = t.add(t.rect(-1, spec.heel, -Ro, -h / 2), t.rect(-1, spec.lug, h / 2, Ro));
  const posts = t.sub(t.add(t.circle(rh), corners), t.rect(-H * 3, H * 3, -h / 2, h / 2));
  const xPost = Math.sqrt(Math.max(rh * rh - (h * h) / 4, 0));
  // The top inner plate ends just past its posts: further out it would hang over the channel.
  const ft = t.union([t.cut(disc, t.rect(-H * 4, xPost + 1.2, -H * 4, H * 4)), ring, corners]);
  const front: Partial<Slabs> = { S2: t.sub(t.add(disc, corners), hole), S3: posts, S4: ft };
  const rear: Partial<Slabs> = { S0: disc, S6: t.sub(disc, hole) };
  return { front, rear, disc, pin: t.circle(pinR), pinR };
}

/**
 * A link's (or end piece's) slabs: `rear` when a link sits behind it (its outer plates, the free room
 * round them, its pin), `front` when one sits in front (its inner plates, posts, pin). `neighbour` is the
 * chain link the end pieces meet (its slabs, and its outline before anything gave way); a link is its
 * own neighbour, worked out over three passes.
 */
function buildSlabs(spec: EnergyChainSpec, t: ReturnType<typeof tools>, f: ReturnType<typeof features>, rear: boolean, front: boolean, neighbour?: { full: Slabs; whole: Slabs }): { slabs: Slabs; full: Slabs; whole: Slabs } {
  const { P, Ro, h, play } = spec;
  // A link reaches from one pin's round to the other's; an end piece only a short way past its one joint.
  const short = Ro + 5;
  const stadium = rear && front
    ? t.hull([t.circle(Ro), t.circle(Ro, P)])
    : front
      ? t.hull([t.circle(Ro, P), t.rect(P - short, P, -Ro, Ro)])
      : t.hull([t.circle(Ro), t.rect(0, short, -Ro, Ro)]);
  const channel = t.rect(-Ro * 3, P + Ro * 3, -h / 2, h / 2);
  const zoneFront = t.move(f.disc, P);
  const raw = {} as Slabs;
  for (const slab of CHAIN_SLABS) {
    let outline = slab === "S3" ? t.sub(stadium, channel) : stadium;
    if (front) outline = t.sub(outline, zoneFront);
    // Right inside the outer plates nothing of the link's own: they bend out there to come apart.
    if (rear && (slab === "S1" || slab === "S5")) outline = t.sub(outline, t.circle(spec.free));
    raw[slab] = outline;
  }
  const feats = (slab: ChainSlab, pins: boolean) => {
    const parts: CrossSection[] = [];
    if (rear && f.rear[slab]) parts.push(f.rear[slab]!);
    if (pins && rear && (slab === "S1" || slab === "S2")) parts.push(f.pin);
    if (front && f.front[slab]) parts.push(t.move(f.front[slab]!, P));
    if (pins && front && (slab === "S5" || slab === "S6")) parts.push(t.move(f.pin, P));
    return t.union(parts);
  };
  // What of a neighbour can reach this joint while it turns: its own joint's round, its square corners and a play.
  const near = t.circle(Math.min(P * 0.95, 2 * Ro + 2 + 2 * play));
  // A link's outline before anything gives way: what its round ends (the outer plates' at the rear, the
  // inner plates' at the front) keep whole, so the neighbour's other end is hollowed round them.
  const whole = neighbour?.whole ?? (Object.fromEntries(CHAIN_SLABS.map((slab) => [slab, t.add(raw[slab], feats(slab, false))])) as Slabs);
  let body = {} as Slabs;
  for (const slab of CHAIN_SLABS) body[slab] = t.sub(raw[slab], t.grow(f.disc, play));
  const full = () => Object.fromEntries(CHAIN_SLABS.map((slab) => [slab, t.add(body[slab], feats(slab, true))])) as Slabs;
  const passes = neighbour ? 1 : 3;
  for (let pass = 0; pass < passes; pass++) {
    const other = neighbour?.full ?? full();
    const next = {} as Slabs;
    CHAIN_SLABS.forEach((slab, i) => {
      const adjacent = [CHAIN_SLABS[i - 1], slab, CHAIN_SLABS[i + 1]].filter(Boolean) as ChainSlab[];
      let outline = raw[slab];
      if (rear) {
        const prev = t.union(adjacent.map((a) => t.cut(t.move(a === "S2" || a === "S4" ? whole[a] : other[a], -P), near)));
        outline = t.sub(outline, t.grow(t.sweep(prev, -spec.th1, -spec.th0, spec.sweepStep), play));
      }
      if (front) {
        const nxt = t.union(adjacent.map((a) => t.cut(a === "S0" || a === "S6" ? whole[a] : other[a], near)));
        outline = t.sub(outline, t.move(t.grow(t.sweep(nxt, spec.th0, spec.th1, spec.sweepStep), play), P));
      }
      next[slab] = outline;
    });
    body = next;
  }
  const slabs = {} as Slabs;
  // The outer plates first: the thin gaps beside them stay within their rounded corners.
  for (const slab of ["S0", "S6", "S1", "S2", "S3", "S4", "S5"] as ChainSlab[]) {
    // The pins only made room in the others; the solid pins, chamfered and as long as they reach, come with the solid.
    let piece = t.add(body[slab], feats(slab, false));
    if (rear && (slab === "S1" || slab === "S2")) piece = t.sub(piece, t.grow(f.pin, 0.01));
    if (front && (slab === "S5" || slab === "S6")) piece = t.sub(piece, t.move(t.grow(f.pin, 0.01), P));
    if (slab === "S0" || slab === "S6") piece = t.round(piece, spec.rounding);
    if (slab === "S1") piece = t.cut(piece, slabs.S0);
    if (slab === "S5") piece = t.cut(piece, slabs.S6);
    const parts = t.k(piece).decompose().map((part) => t.k(part)).filter((part) => part.area() > 0.2);
    slabs[slab] = t.k(t.union(parts).simplify(SIMPLIFY));
  }
  return { slabs, full: full(), whole };
}

/** A pin standing from z0 to z1, its top edge cut at 45 degrees on the side `dir` (+1: +x, -1: -x) a plate slides on from. */
function pin(runtime: ManifoldToplevel, scope: Scope, spec: EnergyChainSpec, r: number, z0: number, z1: number, dir: 1 | -1): Manifold {
  const cylinder = scope.keep(scope.keep(runtime.Manifold.cylinder(z1 - z0, r, r, SEG)).translate([0, 0, z0]));
  const c = Math.min(spec.chamfer, z1 - z0 - 0.2);
  const s = Math.SQRT1_2;
  return scope.keep(cylinder.trimByPlane([-dir * s, 0, -s], -((r - c) + z1) * s));
}

/** A tongue along the inside of the bend with two countersunk screw holes (M3), from x0 to x1. */
function tongue(runtime: ManifoldToplevel, scope: Scope, spec: EnergyChainSpec, x0: number, x1: number, holes: number[]): Manifold {
  const { Manifold } = runtime;
  const k = <T extends { delete(): void }>(value: T) => scope.keep(value);
  const thick = 3;
  const y0 = spec.H / 2 - thick;
  let plate = k(k(Manifold.cube([x1 - x0, thick, spec.W])).translate([x0, y0, 0]));
  for (const x of holes) {
    const shaft = k(k(k(Manifold.cylinder(thick + 2, 1.7, 1.7, 32)).rotate([-90, 0, 0])).translate([x, y0 - 1, spec.W / 2]));
    const head = k(k(k(Manifold.cylinder(1.7, 1.7, 3.4, 32)).rotate([-90, 0, 0])).translate([x, spec.H / 2 - 1.7 + 0.001, spec.W / 2]));
    plate = k(k(plate.subtract(shaft)).subtract(head));
  }
  return plate;
}

function extrude(runtime: ManifoldToplevel, scope: Scope, spec: EnergyChainSpec, slabs: Slabs): Manifold {
  const solids = CHAIN_SLABS.filter((slab) => !slabs[slab].isEmpty()).map((slab) => {
    const [z0, z1] = spec.z[slab];
    // Each slab reaches a micrometre into the one below it, so touching slabs always fuse.
    const bottom = z0 > 0 ? z0 - 0.001 : z0;
    return scope.keep(scope.keep(slabs[slab].extrude(z1 - bottom)).translate([0, 0, bottom]));
  });
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
  /** The fixed end piece: its pin where the first link's rear pin is (the origin), its tongue behind. */
  start: Float32Array;
  /** The moving end piece: its rear pin where the last link's front pin is (the origin), its tongue in front. */
  end: Float32Array;
};

const cache = new Map<string, Promise<ChainPieces>>();

/** The link and the two end pieces of a chain of this spec, made once and kept for the session. */
export function energyChainPieces(runtime: ManifoldToplevel, spec: EnergyChainSpec): Promise<ChainPieces> {
  const key = JSON.stringify(spec);
  let made = cache.get(key);
  if (!made) {
    made = Promise.resolve().then(() => buildPieces(runtime, spec));
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
    const t = tools(runtime, scope);
    const f = features(spec, t);
    const link = buildSlabs(spec, t, f, true, true);
    const pinR = f.pinR;
    const rearPin = () => pin(runtime, scope, spec, pinR, spec.z.S0[1] - 0.01, spec.z.S2[0] + spec.engage, -1);
    const frontPin = () => scope.keep(pin(runtime, scope, spec, pinR, spec.z.S4[1] - 0.01, spec.z.S6[0] + spec.engage, 1).translate([spec.P, 0, 0]));
    const linkSolid = scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, link.slabs), rearPin(), frontPin()]));
    // The fixed end: a link's front end (it plays the link in front of the first one), closed behind,
    // with the tongue behind it; moved so its front pin is at the origin.
    const startSlabs = buildSlabs(spec, t, f, false, true, link).slabs;
    const back = spec.P - spec.Ro - 5;
    const tongueStart = tongue(runtime, scope, spec, back - 21, back + 3, [back - 4, back - 15]);
    const startSolid = scope.keep(scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, startSlabs), frontPin(), tongueStart])).translate([-spec.P, 0, 0]));
    // The moving end: a link's rear end, closed in front, with the tongue in front.
    const endSlabs = buildSlabs(spec, t, f, true, false, link).slabs;
    const ahead = spec.Ro + 5;
    const tongueEnd = tongue(runtime, scope, spec, ahead - 3, ahead + 21, [ahead + 4, ahead + 15]);
    const endSolid = scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, endSlabs), rearPin(), tongueEnd]));
    return { link: positionsOf(linkSolid), start: positionsOf(startSolid), end: positionsOf(endSolid) };
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
 * Where every piece lies when printed (print frame). In the spiral: the links on it, the fixed end before
 * the first one bent in towards the free middle as far as the joint goes, the moving end after the last
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
