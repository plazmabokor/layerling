import type { CrossSection, Manifold, ManifoldToplevel } from "manifold-3d";
import type { CadModifierEnergyChainPart, CadModifierProfileLoop, CadModifierProfileSegment } from "@/lib/cadModifierTypes";
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
const TONGUE_THICK = 3;
/** How far the thin layers beside the plates stay inside the inner plates. */
const THIN_INSET = 0.05;
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
function buildSlabs(spec: EnergyChainSpec, t: ReturnType<typeof tools>, f: ReturnType<typeof features>, rear: boolean, front: boolean, neighbour?: { full: Slabs; whole: Slabs }): { slabs: Slabs; full: Slabs; whole: Slabs; thin: Partial<Slabs> } {
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
  const thin: Partial<Slabs> = {};
  // The plates first: the thin layer between a link's outer and inner plate is where both of them are (and none
  // of it round the rear pin, where the outer plates bend out). So it is made of their own edges, which the CAD
  // kernel joins exactly.
  for (const slab of ["S0", "S6", "S2", "S3", "S4", "S1", "S5"] as ChainSlab[]) {
    // The pins only made room in the others; the solid pins, chamfered and as long as they reach, come with the solid.
    let piece = t.add(body[slab], feats(slab, false));
    // Inside the previous link's pin hole nothing of ours but the pin (a small play leaves a ring there otherwise).
    if (rear && slab === "S2") piece = t.sub(piece, t.circle(f.pinR + spec.pinPlay + play));
    if (front && slab === "S6") piece = t.sub(piece, t.move(t.circle(f.pinR + spec.pinPlay + play), P));
    if (slab === "S0" || slab === "S6") piece = t.round(piece, spec.rounding);
    if (slab === "S1" || slab === "S5") {
      // A hair inside the inner plate, so that no edge of it runs along one of the inner plate's (where the CAD
      // kernel would have to join two faces that only touch); along the outer plate it takes its very edges.
      piece = t.cut(slab === "S1" ? slabs.S0 : slabs.S6, t.k((slab === "S1" ? slabs.S2 : slabs.S4).offset(-THIN_INSET, "Round", 2, SEG)));
      if (rear) piece = t.sub(piece, t.circle(spec.free));
      thin[slab] = t.k(t.k((slab === "S1" ? slabs.S2 : slabs.S4).offset(-THIN_INSET, "Round", 2, SEG)).simplify(SIMPLIFY));
    }
    const parts = t.k(piece).decompose().map((part) => t.k(part)).filter((part) => part.area() > 0.2);
    slabs[slab] = t.k(t.union(parts).simplify(SIMPLIFY));
  }
  return { slabs, full: full(), whole, thin };
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
  const thick = TONGUE_THICK;
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
  /** Each piece as the CAD kernel builds it exactly: the same outlines, every round a true arc (no key or placement yet). */
  exact: Record<ChainPieceKind, Omit<CadModifierEnergyChainPart, "key" | "transform" | "expected">>;
};

/** How far a point may lie off the arc or line it is taken to be on (mm): the outlines' own roundness and simplifying. */
const FIT_TOLERANCE = 0.03;

type XY = [number, number];

/** The circle through three points, or null for points on a line. */
function circleThrough(a: XY, b: XY, c: XY): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const sa = a[0] * a[0] + a[1] * a[1], sb = b[0] * b[0] + b[1] * b[1], sc = c[0] * c[0] + c[1] * c[1];
  const cx = (sa * (b[1] - c[1]) + sb * (c[1] - a[1]) + sc * (a[1] - b[1])) / d;
  const cy = (sa * (c[0] - b[0]) + sb * (a[0] - c[0]) + sc * (b[0] - a[0])) / d;
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
}

/** Where two circles cross, the crossing nearer to `near`; null when they do not cross. */
function circlesCrossing(a: { cx: number; cy: number; r: number }, b: { cx: number; cy: number; r: number }, near: XY): XY | null {
  const dx = b.cx - a.cx, dy = b.cy - a.cy, d = Math.hypot(dx, dy);
  if (d < 1e-9 || d > a.r + b.r || d < Math.abs(a.r - b.r)) return null;
  const along = (a.r * a.r - b.r * b.r + d * d) / (2 * d);
  const across = Math.sqrt(Math.max(0, a.r * a.r - along * along));
  const mx = a.cx + (dx * along) / d, my = a.cy + (dy * along) / d;
  const one: XY = [mx - (dy * across) / d, my + (dx * across) / d];
  const two: XY = [mx + (dy * across) / d, my - (dx * across) / d];
  return Math.hypot(one[0] - near[0], one[1] - near[1]) <= Math.hypot(two[0] - near[0], two[1] - near[1]) ? one : two;
}

type Circle = { cx: number; cy: number; r: number };

/** The same round met again (in another layer, or another part of the outline) is taken as the first one found. */
function canonicalCircle(circles: Circle[], circle: Circle): Circle {
  const known = circles.find((other) => Math.hypot(other.cx - circle.cx, other.cy - circle.cy) < 0.03 && Math.abs(other.r - circle.r) < 0.03);
  if (known) return known;
  circles.push(circle);
  return circle;
}

const turnAt = (a: XY, b: XY, c: XY) => {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
};

/**
 * A closed outline of straight pieces as lines and true arcs: runs of corners that turn little, the same way, and
 * lie on one circle become that arc - its centre a pin's when it lies there, as the joints' rounds do. The loop is
 * in the kernel's X/Z plane: x along the chain, z the print frame's -y.
 */
function fittedLoop(ring: XY[], pivots: XY[], circles: Circle[], levels: number[]): CadModifierProfileLoop {
  const n = ring.length;
  const at = (i: number) => ring[((i % n) + n) % n];
  const turns = ring.map((_, i) => turnAt(at(i - 1), at(i), at(i + 1)));
  // Start at the sharpest corner, which no arc runs through.
  let first = 0;
  turns.forEach((turn, i) => { if (Math.abs(turn) > Math.abs(turns[first])) first = i; });
  type Piece = { to: number; arc?: { cx: number; cy: number; r: number; ccw: boolean } };
  const pieces: Piece[] = [];
  let i = 0;
  while (i < n) {
    let best: Piece | null = null;
    let generic = true, swept = true;
    let pinned = true;
    for (let j = i + 2; j <= n && (generic || swept || pinned); j++) {
      const run = Array.from({ length: j - i + 1 }, (_, k) => at(first + i + k));
      const inner = Array.from({ length: j - i - 1 }, (_, k) => turns[(first + i + 1 + k) % n]);
      const sameWay = inner.every((turn) => turn > 1e-4) || inner.every((turn) => turn < -1e-4);
      // A round about a pin, the joints' own: two straight pieces are enough when every point lies on it.
      if (pinned) {
        const fits = sameWay && inner.every((turn) => Math.abs(turn) <= (25 * Math.PI) / 180) && inner.reduce((sum, turn) => sum + Math.abs(turn), 0) <= (200 * Math.PI) / 180
          ? pivots.map(([px, py]) => {
            const r = run.reduce((sum, [x, y]) => sum + Math.hypot(x - px, y - py), 0) / run.length;
            const off = (x: number, y: number) => Math.abs(Math.hypot(x - px, y - py) - r);
            const worst = Math.max(...run.map(([x, y]) => off(x, y)), ...run.slice(1).map(([x, y], k) => off((x + run[k][0]) / 2, (y + run[k][1]) / 2)));
            return worst <= FIT_TOLERANCE ? { cx: px, cy: py, r } : null;
          }).find(Boolean)
          : null;
        if (fits) {
          best = { to: j, arc: { ...fits, ccw: inner[0] > 0 } };
          continue;
        }
        pinned = false;
      }
      if (j < i + 3) continue;
      // A round of the outline: three straight pieces at least, all turning the same way by less than 25 degrees, on
      // one circle (a pin's, where it lies there).
      if (generic) {
        const steady = inner.every((turn) => Math.abs(turn) <= (25 * Math.PI) / 180 && Math.abs(turn) >= 1e-4) && (inner.every((turn) => turn > 0) || inner.every((turn) => turn < 0));
        // Up to 200 degrees in one arc: a whole round is two.
        const within = inner.reduce((sum, turn) => sum + Math.abs(turn), 0) <= (200 * Math.PI) / 180;
        const circle = steady && within ? circleThrough(run[0], run[Math.floor((j - i) / 3)], run[Math.floor((2 * (j - i)) / 3)]) : null;
        if (!circle || circle.r > 1000) {
          generic = false;
        } else {
          let fit = { ...circle };
          const pivot = pivots.find(([px, py]) => Math.hypot(px - circle.cx, py - circle.cy) < 0.08);
          if (pivot) fit = { cx: pivot[0], cy: pivot[1], r: run.reduce((sum, [x, y]) => sum + Math.hypot(x - pivot[0], y - pivot[1]), 0) / run.length };
          const off = (x: number, y: number) => Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r);
          // The chords' middles too: an arc is not taken across a corner.
          const worst = Math.max(...run.map(([x, y]) => off(x, y)), ...run.slice(1).map(([x, y], k) => off((x + run[k][0]) / 2, (y + run[k][1]) / 2)));
          if (worst > FIT_TOLERANCE) generic = false;
          else {
            best = { to: j, arc: { ...fit, ccw: inner[0] > 0 } };
            continue;
          }
        }
      }
      // What a neighbour's corner sweeps round a pin while the joint turns: a round about that pin, drawn as copies a
      // step apart with notches between them; its true edge is the corner's path, the farthest of the points.
      if (swept) {
        const found = pivots.map(([px, py]) => {
          const distance = run.map(([x, y]) => Math.hypot(x - px, y - py));
          const angles = run.map(([x, y]) => Math.atan2(y - py, x - px));
          const steps = angles.slice(1).map((angle, k) => Math.atan2(Math.sin(angle - angles[k]), Math.cos(angle - angles[k])));
          const total = steps.reduce((sum, step) => sum + step, 0);
          const ok = Math.max(...distance) - Math.min(...distance) <= 0.06
            && (steps.every((step) => step > 0 && step < 0.5) || steps.every((step) => step < 0 && step > -0.5))
            && Math.abs(total) <= (200 * Math.PI) / 180;
          // Taken once it reaches round 3 degrees or more.
          return ok ? { cx: px, cy: py, r: Math.max(...distance), ccw: total > 0, enough: Math.abs(total) >= (3 * Math.PI) / 180 } : null;
        }).find(Boolean);
        if (!found) swept = false;
        else if (found.enough) best = { to: j, arc: { cx: found.cx, cy: found.cy, r: found.r, ccw: found.ccw } };
      }
    }
    if (best) {
      pieces.push(best);
      i = best.to;
    } else {
      pieces.push({ to: i + 1 });
      i += 1;
    }
  }
  // A straight piece shorter than 0.1 mm next to a longer one is part of it (what is left of a round's polygon):
  // the two are one line.
  for (let k = 0; k < pieces.length && pieces.length > 3; k++) {
    if (pieces[k].arc) continue;
    const from = at(first + (k === 0 ? 0 : pieces[k - 1].to)), to = at(first + pieces[k].to);
    if (Math.hypot(to[0] - from[0], to[1] - from[1]) >= 0.1) continue;
    const next = pieces[(k + 1) % pieces.length];
    if (!next.arc && k + 1 < pieces.length) {
      pieces.splice(k, 1);
      k -= 1;
    } else if (k > 0 && !pieces[k - 1].arc) {
      pieces[k - 1].to = pieces[k].to;
      pieces.splice(k, 1);
      k -= 1;
    }
  }
  // The rounds as one set across the piece: the same round in two layers is the same circle.
  for (const piece of pieces) {
    if (!piece.arc) continue;
    const circle = canonicalCircle(circles, piece.arc);
    piece.arc = { ...circle, ccw: piece.arc.ccw };
  }
  const startOf = (k: number) => (k === 0 ? 0 : pieces[k - 1].to);
  // A straight piece is the line through its two corners, laid exactly along x or y when it nearly runs so (the
  // plates' edges do): at the coordinate of an end that is a real corner rather than the last point of a round.
  type Line = { a: XY; d: XY };
  const lines = pieces.map((piece, k): Line | null => {
    if (piece.arc) return null;
    const a = at(first + startOf(k)), b = at(first + piece.to);
    const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy) || 1;
    const afterArc = Boolean(pieces[(k - 1 + pieces.length) % pieces.length].arc);
    const anchor = afterArc && !pieces[(k + 1) % pieces.length].arc ? b : a;
    if (Math.abs(dy) / length < 0.004) {
      // Along x: on one of the piece's own levels (its top and bottom, the channel's) when it lies there.
      const level = levels.find((y) => Math.abs(y - (a[1] + b[1]) / 2) < 0.05);
      return { a: [anchor[0], level ?? anchor[1]], d: [Math.sign(dx) || 1, 0] };
    }
    if (Math.abs(dx) / length < 0.004) return { a: [anchor[0], anchor[1]], d: [0, Math.sign(dy) || 1] };
    return { a, d: [dx / length, dy / length] };
  });
  const onArc = (arc: Circle, point: XY): XY => {
    const d = Math.hypot(point[0] - arc.cx, point[1] - arc.cy) || 1;
    return [arc.cx + ((point[0] - arc.cx) * arc.r) / d, arc.cy + ((point[1] - arc.cy) * arc.r) / d];
  };
  const onLine = (line: Line, point: XY): XY => {
    const u = (point[0] - line.a[0]) * line.d[0] + (point[1] - line.a[1]) * line.d[1];
    return [line.a[0] + u * line.d[0], line.a[1] + u * line.d[1]];
  };
  // Where a line meets a circle near a point: where it crosses it, or where it touches it (a round's tangent end).
  const lineMeetsCircle = (line: Line, arc: Circle, near: XY): XY | null => {
    const foot = onLine(line, [arc.cx, arc.cy]);
    const distance = Math.hypot(foot[0] - arc.cx, foot[1] - arc.cy);
    if (Math.abs(distance - arc.r) < 1e-9) return Math.hypot(foot[0] - near[0], foot[1] - near[1]) < 0.4 ? foot : null;
    if (distance > arc.r) return null;
    const half = Math.sqrt(arc.r * arc.r - distance * distance);
    const one: XY = [foot[0] + half * line.d[0], foot[1] + half * line.d[1]];
    const two: XY = [foot[0] - half * line.d[0], foot[1] - half * line.d[1]];
    const best = Math.hypot(one[0] - near[0], one[1] - near[1]) <= Math.hypot(two[0] - near[0], two[1] - near[1]) ? one : two;
    return Math.hypot(best[0] - near[0], best[1] - near[1]) < 0.1 ? best : null;
  };
  // A round that touches a line at its end takes the line's distance as its radius, so it ends exactly on it.
  pieces.forEach((piece, k) => {
    if (!piece.arc) return;
    for (const other of [(k - 1 + pieces.length) % pieces.length, (k + 1) % pieces.length]) {
      const line = lines[other];
      if (!line) continue;
      const foot = onLine(line, [piece.arc.cx, piece.arc.cy]);
      const distance = Math.hypot(foot[0] - piece.arc.cx, foot[1] - piece.arc.cy);
      if (Math.abs(distance - piece.arc.r) < 0.06 && Math.hypot(foot[0] - at(first + (other === k + 1 || (k === pieces.length - 1 && other === 0) ? piece.to : startOf(k)))[0], foot[1] - at(first + (other === k + 1 || (k === pieces.length - 1 && other === 0) ? piece.to : startOf(k)))[1]) < 0.4) {
        const circle = { cx: piece.arc.cx, cy: piece.arc.cy, r: distance };
        Object.assign(piece.arc, circle);
      }
    }
  });
  // Two rounds that touch rather than cross (a corner's round on a pin's) are made to touch exactly: the one not
  // round a pin (or the smaller) takes the radius that does it; they meet where they touch.
  const touching = new Map<number, XY>();
  pieces.forEach((piece, k) => {
    const before = pieces[(k - 1 + pieces.length) % pieces.length];
    const a = before.arc, b = piece.arc;
    if (!a || !b || a === b) return;
    const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
    if (d < 1e-9) return;
    const onPin = (arc: Circle) => pivots.some(([px, py]) => Math.abs(px - arc.cx) < 1e-9 && Math.abs(py - arc.cy) < 1e-9);
    const [keep, change] = onPin(a) && !onPin(b) ? [a, b] : onPin(b) && !onPin(a) ? [b, a] : a.r >= b.r ? [a, b] : [b, a];
    const ux = (change.cx - keep.cx) / d, uy = (change.cy - keep.cy) / d;
    if (Math.abs(d - (a.r + b.r)) < FIT_TOLERANCE) {
      change.r = d - keep.r;
      touching.set(k, [keep.cx + ux * keep.r, keep.cy + uy * keep.r]);
    } else if (Math.abs(d - Math.abs(a.r - b.r)) < FIT_TOLERANCE) {
      // One inside the other: they touch on the line through both middles, on the side of the inner one.
      change.r = change.r < keep.r ? keep.r - d : keep.r + d;
      const side = change.r < keep.r ? 1 : -1;
      touching.set(k, [keep.cx + side * ux * keep.r, keep.cy + side * uy * keep.r]);
    }
  });
  const meeting = (k: number): { end: XY; start: XY } => {
    const touch = touching.get(k);
    if (touch) return { end: touch, start: touch };
    const before = (k - 1 + pieces.length) % pieces.length;
    const point = at(first + startOf(k));
    const ending = pieces[before].arc, starting = pieces[k].arc;
    if (ending && starting) {
      const crossing = circlesCrossing(ending, starting, point);
      if (crossing && Math.hypot(crossing[0] - point[0], crossing[1] - point[1]) < 0.1) return { end: crossing, start: crossing };
      return { end: onArc(ending, point), start: onArc(starting, point) };
    }
    if (!ending && !starting) {
      // Two lines: where they cross, or the corner itself on both when they run alike.
      const l1 = lines[before]!, l2 = lines[k]!;
      const cross = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
      if (Math.abs(cross) < 1e-9) { const p = onLine(l1, point); return { end: p, start: onLine(l2, p) }; }
      const u = ((l2.a[0] - l1.a[0]) * l2.d[1] - (l2.a[1] - l1.a[1]) * l2.d[0]) / cross;
      const crossing: XY = [l1.a[0] + u * l1.d[0], l1.a[1] + u * l1.d[1]];
      return Math.hypot(crossing[0] - point[0], crossing[1] - point[1]) < 0.1 ? { end: crossing, start: crossing } : { end: onLine(l1, point), start: onLine(l2, point) };
    }
    const arc = (ending ?? starting)!;
    const line = lines[ending ? k : before]!;
    const meet = lineMeetsCircle(line, arc, point);
    if (meet) return { end: meet, start: meet };
    // They do not meet (the outlines' roundness): the arc's end on it, the line's on it, and a short line between.
    return ending ? { end: onArc(arc, point), start: onLine(line, point) } : { end: onLine(line, point), start: onArc(arc, point) };
  };
  // The meeting at the start of piece k (its start) and at its end.
  const meetings = pieces.map((_, k) => meeting(k));
  const toLoop = ([x, y]: XY) => ({ x, z: -y });
  const first0 = meetings[0].start;
  const segments: CadModifierProfileSegment[] = [];
  let current: XY = first0;
  pieces.forEach((piece, k) => {
    const from = meetings[k].start;
    const to = meetings[(k + 1) % pieces.length].end;
    let start = from;
    const gap = Math.hypot(from[0] - current[0], from[1] - current[1]);
    if (gap > 1e-5) segments.push({ kind: "line", ...toLoop(from) });
    else if (gap > 0) {
      // Next to nothing apart: a line before it ends here instead, a line from here starts where the last one ended.
      const last = segments[segments.length - 1];
      if (last?.kind === "line") Object.assign(last, toLoop(from));
      else if (!piece.arc) start = current;
      else segments.push({ kind: "line", ...toLoop(from) });
    }
    // A piece the meetings left without length is dropped.
    if (Math.hypot(to[0] - start[0], to[1] - start[1]) < 1e-5) { current = start; return; }
    if (piece.arc) {
      // In the kernel's plane z is -y: the arc turns the other way there.
      const { cx, cy, r, ccw } = piece.arc;
      const start = Math.atan2(-(from[1] - cy), from[0] - cx);
      let stop = Math.atan2(-(to[1] - cy), to[0] - cx);
      if (ccw) { while (stop >= start) stop -= 2 * Math.PI; } else { while (stop <= start) stop += 2 * Math.PI; }
      segments.push({ kind: "arc", ...toLoop(to), cx, cz: -cy, rx: r, rz: r, start, end: stop });
    } else {
      segments.push({ kind: "line", ...toLoop(to) });
    }
    current = to;
  });
  // Closed: back at the start, a short line if it has to; next to nothing apart, the loop starts where it ended.
  if (Math.hypot(first0[0] - current[0], first0[1] - current[1]) > 1e-5) {
    segments.push({ kind: "line", ...toLoop(first0) });
    return { ...toLoop(first0), segments };
  }
  return { ...toLoop(current), segments };
}

/** A slab's outlines for the kernel: every part of it, its outer loop first and its openings after. */
function fittedOutlines(t: ReturnType<typeof tools>, slab: CrossSection, pivots: XY[], dx: number, circles: Circle[], levels: number[]): CadModifierProfileLoop[][] {
  return t.k(slab).decompose().map((part) => t.k(part)).filter((part) => part.area() > 0.2).map((part) => {
    const rings = part.toPolygons().map((ring) => ring.map(([x, y]) => [x + dx, y] as XY));
    const area = (ring: XY[]) => ring.reduce((sum, [x, y], i) => sum + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0) / 2;
    rings.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    return rings.map((ring) => fittedLoop(ring, pivots.map(([x, y]) => [x + dx, y] as XY), circles, levels));
  });
}

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
    const t = tools(runtime, scope);
    const f = features(spec, t);
    const link = buildSlabs(spec, t, f, true, true);
    const pinR = f.pinR;
    const rearPin = () => pin(runtime, scope, spec, pinR, spec.z.S0[1] - 0.01, spec.z.S2[0] + spec.engage, -1);
    const frontPin = () => scope.keep(pin(runtime, scope, spec, pinR, spec.z.S4[1] - 0.01, spec.z.S6[0] + spec.engage, 1).translate([spec.P, 0, 0]));
    const linkSolid = scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, link.slabs), rearPin(), frontPin()]));
    // The fixed end: a link's front end (it plays the link in front of the first one), closed behind,
    // with the tongue behind it; moved so its front pin is at the origin.
    const startBuilt = buildSlabs(spec, t, f, false, true, link);
    const startSlabs = startBuilt.slabs;
    const back = spec.P - spec.Ro - 5;
    const tongueStart = tongue(runtime, scope, spec, back - 21, back + 3, [back - 4, back - 15]);
    const startSolid = scope.keep(scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, startSlabs), frontPin(), tongueStart])).translate([-spec.P, 0, 0]));
    // The moving end: a link's rear end, closed in front, with the tongue in front.
    const endBuilt = buildSlabs(spec, t, f, true, false, link);
    const endSlabs = endBuilt.slabs;
    const ahead = spec.Ro + 5;
    const tongueEnd = tongue(runtime, scope, spec, ahead - 3, ahead + 21, [ahead + 4, ahead + 15]);
    const endSolid = scope.keep(runtime.Manifold.union([extrude(runtime, scope, spec, endSlabs), rearPin(), tongueEnd]));
    // The same pieces for the CAD kernel, y up: the slabs as layers, the pins as they stand, the tongues.
    const pivots: XY[] = [[0, 0], [spec.P, 0]];
    const levels = [spec.H / 2, -spec.H / 2, spec.h / 2, -spec.h / 2];
    const exactOf = (built: { slabs: Slabs; thin: Partial<Slabs> }, rearOf: boolean, dx: number, pins: CadModifierEnergyChainPart["pins"], tongueAt?: { x0: number; x1: number; holes: number[] }) => {
      const slabs = built.slabs;
      const circles: Circle[] = [];
      return {
      layers: CHAIN_SLABS.map((slab) => {
        const [y0, y1] = spec.z[slab];
        // The thin layers: where the plates on both sides of them are (made so in buildSlabs).
        if (slab === "S1" || slab === "S5") {
          const inner = built.thin[slab]!;
          return { y0, y1, within: slab === "S1" ? 0 : 6, outlines: fittedOutlines(t, inner, pivots, dx, circles, levels), ...(rearOf ? { free: { x: dx, radius: spec.free } } : {}) };
        }
        return { y0, y1, outlines: slabs[slab].isEmpty() ? [] : fittedOutlines(t, slabs[slab], pivots, dx, circles, levels) };
      }),
      pins,
      ...(tongueAt ? { tongue: { x0: tongueAt.x0 + dx, x1: tongueAt.x1 + dx, z0: -spec.H / 2, z1: -spec.H / 2 + TONGUE_THICK, width: spec.W, holes: tongueAt.holes.map((x) => x + dx), hole: 1.7, head: 3.4 } } : {}),
      };
    };
    const rearPinExact = (dx: number) => ({ x: dx, radius: pinR, y0: spec.z.S0[1] - 0.01, y1: spec.z.S2[0] + spec.engage, chamferSide: -1 as const, chamfer: spec.chamfer });
    const frontPinExact = (dx: number) => ({ x: spec.P + dx, radius: pinR, y0: spec.z.S4[1] - 0.01, y1: spec.z.S6[0] + spec.engage, chamferSide: 1 as const, chamfer: spec.chamfer });
    const exact = {
      link: exactOf(link, true, 0, [rearPinExact(0), frontPinExact(0)]),
      start: exactOf(startBuilt, false, -spec.P, [frontPinExact(-spec.P)], { x0: back - 21, x1: back + 3, holes: [back - 4, back - 15] }),
      end: exactOf(endBuilt, true, 0, [rearPinExact(0)], { x0: ahead - 3, x1: ahead + 21, holes: [ahead + 4, ahead + 15] }),
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
