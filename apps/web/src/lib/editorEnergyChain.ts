import { clearanceMeshShape } from "@/lib/clearanceCheck";
import { groupedShape } from "@/lib/editorBooleans";
import { getManifoldRuntime } from "@/lib/editorMeshCore";
import { energyChainInnerSize, energyChainLinks, energyChainSpec, normalizeEnergyChain, DEFAULT_ENERGY_CHAIN } from "@/lib/energyChain";
import { energyChainLayout, energyChainPieces, type ChainPieceKind } from "@/lib/energyChainGeometry";
import { t } from "@/lib/i18n";
import { createLocalId } from "@/lib/localIds";
import { canonicalizeShape } from "@/lib/workplaneShapes";
import type { EnergyChainSettings, WorkplaneShape } from "@/types/layerling";

const CHAIN_COLOR = "#3d7cc9";
const END_COLOR = "#7a8696";

/** The settings carried by an energy chain, or null for any other shape. */
export function energyChainOf(shape: WorkplaneShape | null | undefined): EnergyChainSettings | null {
  return shape?.energyChain ? normalizeEnergyChain(shape.energyChain) : null;
}

/** "Energy chain 10 x 15" in the person's language, the size inside. */
export function energyChainName(settings: EnergyChainSettings) {
  const { h, w } = energyChainInnerSize(settings);
  return t("energyChain.name", { size: `${h} × ${w}` });
}

/**
 * An energy chain as a new group standing on the plate's middle: its links laid in the spiral they are
 * printed in, each a body of its own a play's width from the next, and its end pieces (lib/energyChain.ts).
 * The print frame (x, y on the plate, z up) becomes the design's (x, z towards the viewer, y up).
 */
export async function energyChainShape(input: EnergyChainSettings): Promise<WorkplaneShape> {
  const settings = normalizeEnergyChain(input) ?? DEFAULT_ENERGY_CHAIN;
  const spec = energyChainSpec(settings);
  const runtime = await getManifoldRuntime();
  const pieces = await energyChainPieces(runtime, spec);
  const { count } = energyChainLinks(settings);
  const layout = energyChainLayout(spec, count, settings.start, settings.end);
  // Laid out round the plate's middle: the box of all the pins and a link's reach round them.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const place of layout) {
    minX = Math.min(minX, place.x);
    maxX = Math.max(maxX, place.x);
    minY = Math.min(minY, place.y);
    maxY = Math.max(maxY, place.y);
  }
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const names: Record<ChainPieceKind, string> = { link: "", start: t("energyChain.startPiece"), end: t("energyChain.endPiece") };
  let linkNumber = 0;
  const parts = layout.map((place) => {
    const source = pieces[place.piece];
    const angle = (place.angle * Math.PI) / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const world = new Array<number>(source.length);
    for (let i = 0; i < source.length; i += 3) {
      const x = source[i] * cos - source[i + 1] * sin + place.x - midX;
      const y = source[i] * sin + source[i + 1] * cos + place.y - midY;
      world[i] = x;
      world[i + 1] = source[i + 2];
      world[i + 2] = -y;
    }
    const name = place.piece === "link" ? t("energyChain.link", { number: ++linkNumber }) : names[place.piece];
    const part = clearanceMeshShape(createLocalId("chain-part"), name, place.piece === "link" ? CHAIN_COLOR : END_COLOR, world);
    if (!part) throw new Error(t("energyChain.failed"));
    return canonicalizeShape(part);
  });
  const group = groupedShape(parts);
  if (!group) throw new Error(t("energyChain.failed"));
  return canonicalizeShape({ ...group, id: createLocalId("energy-chain"), name: energyChainName(settings), color: CHAIN_COLOR, groupOperation: "group", multicolor: true, energyChain: settings, elevation: 0 });
}

/**
 * An energy chain made again with new settings where the old one stood: same id, middle, turn and state.
 * A name the person gave is kept; the chain's own name follows the new size.
 */
export async function regeneratedEnergyChainShape(old: WorkplaneShape, settings: EnergyChainSettings): Promise<WorkplaneShape> {
  const built = await energyChainShape(settings);
  const previous = energyChainOf(old);
  const ownName = previous ? old.name !== energyChainName(previous) : true;
  return canonicalizeShape({
    ...built,
    id: old.id,
    name: ownName ? old.name : built.name,
    x: old.x,
    z: old.z,
    elevation: old.elevation ?? 0,
    rotation: old.rotation,
    rotationX: old.rotationX,
    rotationZ: old.rotationZ,
    hole: old.hole,
    locked: old.locked,
    hidden: old.hidden,
  });
}
