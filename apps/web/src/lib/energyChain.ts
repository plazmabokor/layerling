import type { EnergyChainEnd, EnergyChainPrint, EnergyChainSettings, EnergyChainSize } from "@/types/layerling";

/*
 * The energy chain (cable chain) shape: a chain printed in one piece, lying on its side in a spiral, with
 * no supports, whose links still come apart and go together again one by one like a bought one.
 *
 * Every link has a wide rear end - two outer plates with the holes - and a narrow front end - two inner
 * plates with the pins; the next link's outer plates hold this link's inner plates between them. Printed
 * on its side, the pins point up the way they are printed: the outer plate on the bed side carries its pin
 * up into the inner plate above it, the inner plate at the top carries its pin up into the outer plate
 * over it. Each pin is chamfered on the side the plate slides on from, so the outer plates spread over
 * them; they are free round the joint (`free`) so that they bend. Seen from the side a plate is a D, like
 * the bought one's: round round its pin, its other end hollowed round the next link's round end, which
 * turns in it. The inner plates' front corners stay square (`heel` below, `lug` above) and turn in
 * grooves of the next link behind its outer plates: past straight the heel meets it, past the largest
 * bend the lug - the stops, hidden, so the chain stays straight and keeps its smallest radius.
 *
 * Sizes follow the bought chains (inner height x inner width): the outer height is 5 mm more than the
 * inner one, the outer width 2 x (2 plates + play) more, the pitch 5 mm more than the outer height. The
 * 10 mm high ones bend to R18, as the measured 10 x 15 chain does (34.5 mm between its legs); 15 mm high
 * ones to R28, 20 mm high to R38, as ATO, igus and the common open chains list them. A size of one's own
 * keeps the same rules, so it bends the same way.
 */

export const ENERGY_CHAIN_SIZES: readonly Exclude<EnergyChainSize, "custom">[] = ["10x15", "10x20", "15x20", "15x30", "20x25"];
const SIZE_OF: Record<Exclude<EnergyChainSize, "custom">, { h: number; w: number }> = {
  "10x15": { h: 10, w: 15 },
  "10x20": { h: 10, w: 20 },
  "15x20": { h: 15, w: 20 },
  "15x30": { h: 15, w: 30 },
  "20x25": { h: 20, w: 25 },
};
export const ENERGY_CHAIN_ENDS: readonly EnergyChainEnd[] = ["none", "attached", "separate"];

export const MIN_CHAIN_INNER_HEIGHT = 6;
export const MAX_CHAIN_INNER_HEIGHT = 30;
export const MIN_CHAIN_INNER_WIDTH = 6;
export const MAX_CHAIN_INNER_WIDTH = 60;
export const MIN_CHAIN_LENGTH_CM = 5;
export const MAX_CHAIN_LENGTH_CM = 300;
export const MIN_CHAIN_PIECES = 1;
export const MAX_CHAIN_PIECES = 300;
export const DEFAULT_CHAIN_PIECES = 10;
export const ENERGY_CHAIN_PRINTS: readonly EnergyChainPrint[] = ["spiral", "pieces"];
export const MIN_CHAIN_PLAY = 0.2;
export const MAX_CHAIN_PLAY = 0.8;
export const DEFAULT_CHAIN_PLAY = 0.4;

export const DEFAULT_ENERGY_CHAIN: EnergyChainSettings = { size: "10x15", lengthCm: 50, play: DEFAULT_CHAIN_PLAY, start: "attached", end: "attached" };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;
const finite = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** Settings as a saved design, the panel or the MCP tool hand them in, made whole; null for nothing usable. */
export function normalizeEnergyChain(input: Partial<EnergyChainSettings> | null | undefined): EnergyChainSettings | null {
  if (!input || typeof input !== "object") return null;
  const size: EnergyChainSize = input.size === "custom" || ENERGY_CHAIN_SIZES.includes(input.size as never) ? (input.size as EnergyChainSize) : DEFAULT_ENERGY_CHAIN.size;
  const end = (value: unknown, fallback: EnergyChainEnd) => (ENERGY_CHAIN_ENDS.includes(value as never) ? (value as EnergyChainEnd) : fallback);
  const settings: EnergyChainSettings = {
    size,
    lengthCm: round1(clamp(finite(input.lengthCm, DEFAULT_ENERGY_CHAIN.lengthCm), MIN_CHAIN_LENGTH_CM, MAX_CHAIN_LENGTH_CM)),
    play: Math.round(clamp(finite(input.play, DEFAULT_CHAIN_PLAY), MIN_CHAIN_PLAY, MAX_CHAIN_PLAY) * 100) / 100,
    start: end(input.start, DEFAULT_ENERGY_CHAIN.start),
    end: end(input.end, DEFAULT_ENERGY_CHAIN.end),
  };
  if (input.printAs === "pieces") {
    settings.printAs = "pieces";
    settings.pieces = Math.round(clamp(finite(input.pieces, DEFAULT_CHAIN_PIECES), MIN_CHAIN_PIECES, MAX_CHAIN_PIECES));
    // Link by link there is no chain to print an end with: an end comes apart too.
    if (settings.start === "attached") settings.start = "separate";
    if (settings.end === "attached") settings.end = "separate";
  }
  if (size === "custom") {
    const preset = SIZE_OF["10x15"];
    settings.innerHeight = round1(clamp(finite(input.innerHeight, preset.h), MIN_CHAIN_INNER_HEIGHT, MAX_CHAIN_INNER_HEIGHT));
    settings.innerWidth = round1(clamp(finite(input.innerWidth, preset.w), MIN_CHAIN_INNER_WIDTH, MAX_CHAIN_INNER_WIDTH));
  }
  return settings;
}

/** Everything a link is built from, in mm and degrees; the print frame has x along the chain, y across its height, z across its width (0 on the bed). */
export type EnergyChainSpec = {
  /** Inner height and width: the room for the cables. */
  h: number;
  w: number;
  /** Outer height and width. */
  H: number;
  W: number;
  /** Plate thickness, the play between parts, the pitch (pin to pin). */
  T: number;
  play: number;
  P: number;
  /** The smallest inner bend radius and the largest turn of one joint it allows. */
  bendRadius: number;
  thetaMax: number;
  /** The turn the joints are worked out for; the stops meet a play's width past it: at 0 and thetaMax. */
  th0: number;
  th1: number;
  /** Round of a link's end; the posts that carry the top inner plate fill it out to `rh` above and below the channel. */
  Ro: number;
  rh: number;
  pinD: number;
  pinPlay: number;
  /** How far a pin reaches into the plate it holds, and its slide-on chamfer. */
  engage: number;
  chamfer: number;
  /** Radius round the rear pin inside which the outer plates are free to bend out. */
  free: number;
  /** How far the inner plates' square bottom (heel) and top (lug) front corners reach past the pin. */
  heel: number;
  lug: number;
  /** The outer plates' corners are rounded this much. */
  rounding: number;
  /** Degrees between the copies of a part turned through a joint: its corners near the pin stay within ~0.35 mm. */
  sweepStep: number;
  /** z of the seven slabs: outer plate, gap, inner plate, the channel walls, inner plate, gap, outer plate. */
  z: Record<ChainSlab, [number, number]>;
};
export type ChainSlab = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6";
export const CHAIN_SLABS: readonly ChainSlab[] = ["S0", "S1", "S2", "S3", "S4", "S5", "S6"];

/** Inner height and width of a size. */
export function energyChainInnerSize(settings: EnergyChainSettings) {
  if (settings.size === "custom") return { h: settings.innerHeight ?? SIZE_OF["10x15"].h, w: settings.innerWidth ?? SIZE_OF["10x15"].w };
  return SIZE_OF[settings.size];
}

/** The smallest inner bend radius of a chain of this inner height: R18 for 10 mm, R28 for 15, R38 for 20, the same rule between and beyond. */
export function energyChainBendRadius(innerHeight: number) {
  return Math.max(innerHeight + 6, 2 * innerHeight - 2);
}

export function energyChainSpec(settings: EnergyChainSettings): EnergyChainSpec {
  const { h, w } = energyChainInnerSize(settings);
  const play = settings.play ?? DEFAULT_CHAIN_PLAY;
  const H = h + 5;
  const T = h <= 10 ? 1.8 : h <= 15 ? 2.0 : 2.2;
  const W = w + 2 * (2 * T + play);
  const P = H + 5;
  const Ro = H / 2;
  const rh = Ro;
  const bendRadius = energyChainBendRadius(h);
  const thetaMax = (2 * Math.asin(P / (2 * (bendRadius + H / 2))) * 180) / Math.PI;
  const degrees = 180 / Math.PI;
  const z: Record<ChainSlab, [number, number]> = {
    S0: [0, T],
    S1: [T, T + play],
    S2: [T + play, 2 * T + play],
    S3: [2 * T + play, W - 2 * T - play],
    S4: [W - 2 * T - play, W - T - play],
    S5: [W - T - play, W - T],
    S6: [W - T, W],
  };
  return {
    h, w, H, W, T, play, P, bendRadius, thetaMax,
    th0: (play / (Ro + 0.5)) * degrees,
    th1: thetaMax - (play / (Ro + 0.8)) * degrees,
    Ro, rh,
    pinD: clamp(round1(0.55 * h), 3, 8),
    pinPlay: 0.3,
    engage: 1.0,
    chamfer: 0.5,
    free: round1(0.7 * H),
    heel: round1(0.235 * H),
    lug: round1(0.3 * H),
    rounding: 1,
    sweepStep: Math.min(2, (0.35 / (1.2 * Ro)) * degrees),
    z,
  };
}

/** How many links make the length asked for (or as many as asked for, link by link), and the length they make (pin of the first to pin past the last, in mm). */
export function energyChainLinks(settings: EnergyChainSettings) {
  const spec = energyChainSpec(settings);
  const count = settings.printAs === "pieces"
    ? Math.max(MIN_CHAIN_PIECES, settings.pieces ?? DEFAULT_CHAIN_PIECES)
    : Math.max(2, Math.round((settings.lengthCm * 10) / spec.P));
  return { count, length: count * spec.P };
}

/**
 * Where the links lie when printed: pins on a spiral round the plate's middle, one pitch apart, turning
 * one way (each joint bends between th0 and th1, the innermost the most), the turns a 2 mm gap apart.
 * Returns the n + 1 pins in the print plane.
 */
export function energyChainSpiral(spec: EnergyChainSpec, count: number): Array<[number, number]> {
  const firstBend = Math.max(spec.th0 + 1, spec.th1 - 4);
  const r0 = spec.P / (2 * Math.sin((firstBend * Math.PI) / 360));
  const b = (spec.H + 2) / (2 * Math.PI);
  const pins: Array<[number, number]> = [[r0, 0]];
  let theta = 0;
  for (let i = 0; i < count; i++) {
    const [x0, y0] = pins[pins.length - 1];
    let lo = theta;
    let hi = theta + 2;
    for (let k = 0; k < 60; k++) {
      const mid = (lo + hi) / 2;
      const r = r0 + b * mid;
      const d = Math.hypot(r * Math.cos(mid) - x0, r * Math.sin(mid) - y0);
      if (d < spec.P) lo = mid;
      else hi = mid;
    }
    theta = (lo + hi) / 2;
    const r = r0 + b * theta;
    pins.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }
  return pins;
}
