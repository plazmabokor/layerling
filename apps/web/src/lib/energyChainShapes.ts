import type { ChainFigure, CadModifierProfileLoop, CadModifierProfileSegment } from "@/lib/cadModifierTypes";
import type { ChainSlab, EnergyChainSpec } from "@/lib/energyChain";

/*
 * The energy chain's pieces as exact flat figures, slab by slab (lib/energyChain.ts names the slabs), in the print
 * frame: x along the chain, y across its height; a link's rear joint (its holes) at O = (0, 0), its front joint (its
 * pins) at Q = (P, 0).
 *
 * Every figure is made of exact parts, each worked out from what moves past it:
 * - The outer plates (S0, S6) are a D: round round the rear pin, straight above and below. In front they are hollowed
 *   round the next link's round end: a circle of its radius and a play about Q, since a round turning about its own
 *   middle stays itself. Above, the next link's straight edge turns down onto them as the joint bends: at the largest
 *   bend it lies along a line touching that circle, so the plate stops a play short of it - the stop that holds the
 *   smallest radius. Each is one outline whose corners are rounded with true arcs touching both sides.
 * - The inner plates (S2, S4) and the channel walls between them (S3) are the other way round: round about the front
 *   pin, their front corners left square (the heel below, the lug above). Behind, the link before turns in them: its
 *   round (a circle and a play about O), its straight upper edge at the largest bend (a box turned about O), and the
 *   grooves its square corners run in - each the corner as it stands at the two ends of the turn and the arc its outer
 *   point draws between them. Turning back past straight its heel meets the end of its groove, past the largest bend
 *   its lug: the hidden stops.
 * - The thin layers between a link's outer and inner plates (S1, S5) are where both plates are, and none of them
 *   round the rear pin, where the outer plates bend out to come apart.
 * Each piece keeps a play from what its neighbours have in its own slab or a slab touching it, through the whole turn.
 */

/** Builds a closed outline in the print frame; arcs turn counter-clockwise from a0 to a1 (degrees) or the other way. */
class Outline {
  private x0 = 0;
  private y0 = 0;
  private x = 0;
  private y = 0;
  private segments: CadModifierProfileSegment[] = [];

  constructor(x: number, y: number) {
    this.x0 = this.x = x;
    this.y0 = this.y = y;
  }

  line(x: number, y: number) {
    this.segments.push({ kind: "line", x, z: -y });
    this.x = x;
    this.y = y;
    return this;
  }

  /** An arc of the circle (cx, cy, r) from the angle a0 to a1 (degrees, counter-clockwise when a1 > a0), in pieces of 120 degrees at most. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number): this {
    const parts = Math.ceil(Math.abs(a1 - a0) / 120 - 1e-9);
    if (parts > 1) {
      for (let i = 0; i < parts; i++) this.arc(cx, cy, r, a0 + ((a1 - a0) * i) / parts, a0 + ((a1 - a0) * (i + 1)) / parts);
      return this;
    }
    const rad = Math.PI / 180;
    const x = cx + r * Math.cos(a1 * rad);
    const y = cy + r * Math.sin(a1 * rad);
    // In the kernel's plane z is -y: an angle there is the negative of the print frame's.
    this.segments.push({ kind: "arc", x, z: -y, cx, cz: -cy, rx: r, rz: r, start: -a0 * rad, end: -a1 * rad });
    this.x = x;
    this.y = y;
    return this;
  }

  /** Closed with a line back to the start (left out when already there). */
  close(): ChainFigure {
    if (Math.hypot(this.x - this.x0, this.y - this.y0) > 1e-9) this.line(this.x0, this.y0);
    else {
      // Back at the start: the last piece ends exactly there.
      const last = this.segments[this.segments.length - 1];
      if (last.kind === "line") Object.assign(last, { x: this.x0, z: -this.y0 });
    }
    const loop: CadModifierProfileLoop = { x: this.x0, z: -this.y0, segments: this.segments };
    return { kind: "outline", loop };
  }
}

const deg = (radians: number) => (radians * 180) / Math.PI;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** A circle about (cx, cy). */
export function circle(cx: number, cy: number, r: number): ChainFigure {
  return new Outline(cx + r, cy).arc(cx, cy, r, 0, 180).arc(cx, cy, r, 180, 360).close();
}

/** A box, turned by `angle` degrees about (px, py); its sides x0..x1, y0..y1 measured in the turned frame. */
export function box(x0: number, x1: number, y0: number, y1: number, angle = 0, px = 0, py = 0): ChainFigure {
  const c = Math.cos(rad(angle)), s = Math.sin(rad(angle));
  const at = (x: number, y: number): [number, number] => [px + x * c - y * s, py + x * s + y * c];
  const corners = [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];
  const outline = new Outline(...corners[0]);
  for (const corner of corners.slice(1)) outline.line(...corner);
  return outline.close();
}

/** A pie slice about (cx, cy): radius r, from the angle a0 to a1 (degrees, a1 > a0). */
export function sector(cx: number, cy: number, r: number, a0: number, a1: number): ChainFigure {
  const outline = new Outline(cx, cy).line(cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0)));
  // Up to 120 degrees an arc, so none of them is ever a half circle or more.
  const parts = Math.max(1, Math.ceil((a1 - a0) / 120));
  for (let i = 0; i < parts; i++) outline.arc(cx, cy, r, a0 + ((a1 - a0) * i) / parts, a0 + ((a1 - a0) * (i + 1)) / parts);
  return outline.close();
}

const union = (...of: ChainFigure[]): ChainFigure => ({ kind: "union", of });
const cut = (from: ChainFigure, ...minus: ChainFigure[]): ChainFigure => ({ kind: "cut", from, minus });
const common = (...of: ChainFigure[]): ChainFigure => ({ kind: "common", of });

export type ChainPieceFigures = Record<ChainSlab, ChainFigure>;

/** A figure moved along x. */
export function movedFigure(figure: ChainFigure, dx: number): ChainFigure {
  switch (figure.kind) {
    case "outline":
      return {
        kind: "outline",
        loop: {
          x: figure.loop.x + dx,
          z: figure.loop.z,
          segments: figure.loop.segments.map((segment) =>
            segment.kind === "arc"
              ? { ...segment, x: segment.x + dx, cx: segment.cx + dx }
              : segment.kind === "bezier"
                ? { ...segment, x: segment.x + dx, controls: segment.controls.map((control) => ({ x: control.x + dx, z: control.z })) }
                : { ...segment, x: segment.x + dx },
          ),
        },
      };
    case "union":
      return { kind: "union", of: figure.of.map((part) => movedFigure(part, dx)) };
    case "common":
      return { kind: "common", of: figure.of.map((part) => movedFigure(part, dx)) };
    case "cut":
      return { kind: "cut", from: movedFigure(figure.from, dx), minus: figure.minus.map((part) => movedFigure(part, dx)) };
  }
}

/**
 * The figures of a piece, slab by slab: a link (`rear` and `front`), the pin end piece (`front` only: its pins hold the
 * first link, its body closed behind) or the hole end piece (`rear` only). Every edge is a true line or arc, and
 * where two meet they meet exactly (a tangent point, a corner both pass through), so no hairline edges are left.
 */
export function chainPieceFigures(spec: EnergyChainSpec, rear: boolean, front: boolean): ChainPieceFigures {
  const { P, Ro, play: p } = spec;
  const short = Ro + 5;
  const x0 = front && !rear ? P - short : 0;
  const x1 = rear && !front ? short : P;
  const r = spec.rounding;
  /**
   * An outer plate as one outline of true lines and arcs, each meeting the next at a point worked out exactly: the D
   * round about O (or a square end with rounded corners), along the bottom, in front the hollow - a circle a play
   * wider than the next link's round about Q, left where the stop's straight edge touches it - up that edge and back
   * along the top, the corners between rounded with arcs touching both sides.
   */
  const outer = (withHole: boolean) => {
    const outline = rear ? new Outline(0, -Ro) : new Outline(x0 + r, -Ro);
    if (front) {
      const R = Ro + p;
      // Bottom: the round touching the bottom line and the hollow from outside.
      const bx = P - Math.sqrt((R + r) ** 2 - (Ro - r) ** 2);
      const toQ = deg(Math.atan2(Ro - r, P - bx));
      outline.line(bx, -Ro).arc(bx, -Ro + r, r, -90, toQ);
      // Round the hollow the other way (the plate outside it) up to where the stop's edge leaves it.
      const from = toQ - 180;
      const t = spec.th1;
      outline.arc(P, 0, R, from, 90 + t - 360);
      // The edge (along t) up to the top line, the corner between them (t wide) rounded. Where a round of the usual
      // radius would leave a mere sliver of the edge, the round starts right where the edge leaves the hollow: the two
      // arcs then meet head on, with no straight between them.
      const tx = P + R * Math.cos(rad(90 + t)), ty = R * Math.sin(rad(90 + t));
      const edge = (Ro - ty) / Math.sin(rad(t));
      const half = Math.tan(rad(t / 2));
      const round = edge - r / half < 0.5 ? edge * half : r;
      const cy = Ro - round;
      const cx = tx + ((cy - ty) * Math.cos(rad(t)) - round) / Math.sin(rad(t));
      if (round === r) outline.line(cx + r * Math.sin(rad(t)), cy - r * Math.cos(rad(t)));
      outline.arc(cx, cy, round, t - 90, 90);
    } else {
      outline.line(x1 - r, -Ro).arc(x1 - r, -Ro + r, r, -90, 0).line(x1, Ro - r).arc(x1 - r, Ro - r, r, 0, 90);
    }
    if (rear) outline.line(0, Ro).arc(0, 0, Ro, 90, 270);
    else outline.line(x0 + r, Ro).arc(x0 + r, Ro - r, r, 90, 180).line(x0, -Ro + r).arc(x0 + r, -Ro + r, r, 180, 270);
    const plate = outline.close();
    return withHole && rear ? cut(plate, circle(0, 0, spec.pinD / 2 + spec.pinPlay)) : plate;
  };
  /** The inner plates' outline, `e` inside its true one: round about Q with the square heel and lug, or square. */
  const innerOutline = (e: number) => {
    if (!front) return box(x0 + e, x1 - e, -Ro + e, Ro - e);
    const r = Ro - e;
    const heel = spec.heel - e, lug = spec.lug - e;
    const heelY = Math.sqrt(r * r - heel * heel), lugY = Math.sqrt(r * r - lug * lug);
    return new Outline(x0 + e, -r)
      .line(P + heel, -r)
      .line(P + heel, -heelY)
      .arc(P, 0, r, deg(Math.atan2(-heelY, heel)), deg(Math.atan2(lugY, lug)))
      .line(P + lug, r)
      .line(x0 + e, r)
      .close();
  };
  /** What the link behind sweeps through as the joint turns, a play (and `e`) wide, about O. */
  const behind = (e: number): ChainFigure[] => {
    if (!rear) return [];
    const g = p + e;
    const corner = (c: number, ya: number, yb: number) => {
      // The corner box, grown, at both ends of the turn, and the arc its outer point draws between them.
      // Drawn by the grown box's outer corner, so the arc ends on that corner at both ends of the turn.
      const outerY = ya < 0 ? -(Ro + g) : Ro + g;
      const reach = Math.hypot(c + g, outerY);
      const angle = deg(Math.atan2(outerY, c + g));
      return [
        box(-1 - g, c + g, ya - g, yb + g, -spec.th0),
        box(-1 - g, c + g, ya - g, yb + g, -spec.th1),
        sector(0, 0, reach, angle - spec.th1, angle - spec.th0),
      ];
    };
    // A corner's square stands out of the round from where its side meets the round (on a large chain below the channel's edge).
    const lugY = Math.min(spec.h / 2, Math.sqrt(Ro * Ro - spec.lug * spec.lug));
    const heelY = Math.min(spec.h / 2, Math.sqrt(Ro * Ro - spec.heel * spec.heel));
    return [
      circle(0, 0, Ro + g),
      // Its straight body at the largest bend (the rest of the turn lies inside it on this side).
      box(-3 * Ro, g, -(Ro + g), Ro + g, -spec.th1),
      ...corner(spec.lug, lugY, Ro),
      ...corner(spec.heel, -Ro, -heelY),
    ];
  };
  const channel = box(-4 * Ro, P + 4 * Ro, -spec.h / 2, spec.h / 2);
  const inner = (e: number) => cut(innerOutline(e), ...behind(e));
  // The top inner plate ends just past its posts (further out it would hang over the channel), with a ring round its pin.
  const xPost = Math.sqrt(Math.max(Ro * Ro - (spec.h * spec.h) / 4, 0));
  const top = (e: number) => {
    if (!front) return inner(e);
    const end = xPost + 1.2 - e;
    // Corners that reach past that end are kept whole (a large chain's lug).
    const corners = [
      ...(spec.lug - e > end ? [box(P - 1, P + spec.lug - e, spec.h / 2, Ro - e)] : []),
      ...(spec.heel - e > end ? [box(P - 1, P + spec.heel - e, -Ro + e, -spec.h / 2)] : []),
    ];
    return cut(union(common(innerOutline(e), box(-4 * Ro, P + end, -2 * Ro, 2 * Ro)), ...corners, circle(P, 0, spec.pinD / 2 + spec.pinPlay + 1.5 - e)), ...behind(e));
  };
  const S0 = outer(true);
  const S6 = outer(true);
  const S2 = inner(0);
  const S4 = top(0);
  const S3 = cut(innerOutline(0), channel, ...behind(0));
  // On the hole end piece the clear round stays well inside its square front (never touching that edge).
  const free = rear ? [circle(0, 0, front ? spec.free : Math.min(spec.free, x1 - 1.5))] : [];
  // The thin layers join a plate to the one beside it, exactly where both are.
  const S1 = cut(common(S0, S2), ...free);
  const S5 = cut(common(S6, S4), ...free);
  return { S0, S1, S2, S3, S4, S5, S6 };
}

