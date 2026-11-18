import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  holePatternCenters,
  normalizeHolePattern,
  rackCenters,
  rackRailSpacing,
  RACK_HOLE_SPACING,
  RACK_SLOT_LENGTH,
  RACK_SLOT_WIDTH,
  RACK_STANDARD_PANELS,
} from "@/lib/holePattern";
import { holePatternShapes, readPerforableFace } from "@/lib/holePatternShapes";
import { quaternionForShape } from "@/lib/geometryRotation";

const rect = (w: number, d: number) => [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => ({ u, v }));
const sorted = (points: Array<{ u: number; v: number }>) => points.map((p) => [Number(p.u.toFixed(4)), Number(p.v.toFixed(4))]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
const settings = (patch = {}) => normalizeHolePattern({ form: "round", size: 4.3, arrangement: "corners", margin: 5, rack: true, ...patch });

/** The rail's holes, 1/4, 7/8 and 1 1/2 inch up every 1 3/4 inch unit (EIA-310). */
const railHoles = Array.from({ length: 12 }, (_, unit) => [6.35, 22.225, 38.1].map((hole) => unit * 44.45 + hole)).flat();
const onRail = (spacing: number) => railHoles.some((a) => railHoles.some((b) => Math.abs(b - a - spacing) < 1e-6));

describe("19 inch rack holes", () => {
  it("finds the longest distance between two rail holes that fits", () => {
    expect(rackRailSpacing(43.65 - 2 * 5.95)).toBeCloseTo(31.75, 6);
    expect(rackRailSpacing(88.1 - 2 * 5.95)).toBeCloseTo(76.2, 6);
    // A 74 mm panel: four steps of the rail, 5/8 + 1/2 + 5/8 + 5/8 inch.
    expect(rackRailSpacing(74 - 2 * 5.95)).toBeCloseTo(60.325, 6);
    expect(rackRailSpacing(10)).toBe(0);
    for (const limit of [20, 33, 50, 62.1, 99, 150, 260]) expect(onRail(rackRailSpacing(limit))).toBe(true);
  });

  it("puts four slots 465.1 mm apart on a 74 mm panel, the same distance from its upper and lower edges", () => {
    const result = holePatternCenters({ loops: [rect(482.6, 74)] }, settings());
    expect(sorted(result.centers)).toEqual([[-232.55, -30.1625], [-232.55, 30.1625], [232.55, -30.1625], [232.55, 30.1625]]);
    expect(result.rack).toMatchObject({ ok: true, spacing: 60.325, angle: 0 });
    expect(result.rack?.edge).toBeCloseTo(6.8375, 6);
  });

  it("places the standard panels' holes as IEC 60297-3-100 has them", () => {
    const edges = [5.95, 5.95, 37.7, 37.7, 37.7, 37.7];
    RACK_STANDARD_PANELS.forEach((panel, index) => {
      const { centers, fit } = rackCenters([rect(482.6, panel.height)], { rackUnits: panel.units });
      expect(fit?.ok).toBe(true);
      expect(fit?.spacing).toBeCloseTo(panel.spacing, 6);
      expect(fit?.edge).toBeCloseTo(edges[index], 3);
      expect(onRail(panel.spacing)).toBe(true);
      const vs = [...new Set(centers.map((c) => Number(c.v.toFixed(4))))].sort((a, b) => a - b);
      expect(vs[1] - vs[0]).toBeCloseTo(panel.spacing, 4);
      const us = [...new Set(centers.map((c) => Number(c.u.toFixed(4))))].sort((a, b) => a - b);
      expect(us[1] - us[0]).toBeCloseTo(RACK_HOLE_SPACING, 4);
    });
  });

  it("lays the slots along the panel's width when the panel stands the other way in the face", () => {
    const result = holePatternCenters({ loops: [rect(74, 482.6)] }, settings());
    expect(sorted(result.centers)).toEqual([[-30.1625, -232.55], [-30.1625, 232.55], [30.1625, -232.55], [30.1625, 232.55]]);
    expect(result.rack?.angle).toBe(90);
  });

  it("makes no holes on a panel too narrow or too low, and says why", () => {
    expect(holePatternCenters({ loops: [rect(400, 74)] }, settings()).rack).toMatchObject({ ok: false, reason: "narrow" });
    expect(holePatternCenters({ loops: [rect(482.6, 20)] }, settings()).rack).toMatchObject({ ok: false, reason: "low" });
    // The 2U holes do not fit a 74 mm panel.
    const twoU = holePatternCenters({ loops: [rect(482.6, 74)] }, settings({ rackUnits: 2 }));
    expect(twoU.centers).toHaveLength(0);
    expect(twoU.rack).toMatchObject({ ok: false, reason: "low", units: 2, standardHeight: 88.1 });
  });

  it("keeps the choice when the settings are read back", () => {
    expect(settings({ rackUnits: 3 })).toMatchObject({ rack: true, rackUnits: 3 });
    expect(settings({ rackUnits: 0 }).rackUnits).toBeUndefined();
    expect(normalizeHolePattern({ arrangement: "corners", rackUnits: 3 }).rack).toBeUndefined();
  });

  it("makes the holes as slots of the standard size, lying along the panel", () => {
    const geometry = new THREE.BoxGeometry(482.6, 3, 74).toNonIndexed();
    geometry.translate(0, 1.5, 0);
    const positions = Array.from(geometry.getAttribute("position").array as Float32Array);
    const read = readPerforableFace(positions, { x: 10, y: 3, z: 5 }, { x: 0, y: 1, z: 0 });
    if (!read.ok) throw new Error("no face");
    const plan = holePatternShapes(read.face, settings({ holeType: "countersink", depth: null }), "Hole");
    expect(plan.rack?.ok).toBe(true);
    expect(plan.holes).toHaveLength(4);
    const xs = plan.holes.map((hole) => hole.x).sort((a, b) => a - b);
    const zs = plan.holes.map((hole) => hole.z).sort((a, b) => a - b);
    expect(xs[3] - xs[0]).toBeCloseTo(RACK_HOLE_SPACING, 3);
    expect(zs[3] - zs[0]).toBeCloseTo(60.325, 3);
    for (const hole of plan.holes) {
      expect(hole.hole).toBe(true);
      expect(hole.kind).not.toBe("countersink");
      // The slot's length runs across the panel, along the world's x.
      const sizes = [hole.width, hole.depth].sort((a, b) => a - b);
      expect(sizes[0]).toBeCloseTo(RACK_SLOT_WIDTH, 6);
      expect(sizes[1]).toBeCloseTo(RACK_SLOT_LENGTH, 6);
      const along = new THREE.Vector3(hole.width >= hole.depth ? 1 : 0, 0, hole.width >= hole.depth ? 0 : 1).applyQuaternion(quaternionForShape(hole));
      expect(Math.abs(along.x)).toBeCloseTo(1, 4);
    }
  });
});
