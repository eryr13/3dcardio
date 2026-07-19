import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  buildAorticCavityClippingPlanes,
  computeAorticRootFrame,
  distanceFromAxis,
  evaluateAorticRootRadius,
  pointAtRelativeHeight,
} from "./aorticRootMesh";
import type { AorticRootFrame } from "./aorticRootMesh";
import type { CenterlineBranch, VesselGraph } from "./vesselGraph";
import type { CenterlinePoint } from "./vesselCenterline";
import type { VesselId } from "../../types/anatomy";

function buildGraph(ostium: Vector3, ostiumDirection: Vector3): VesselGraph {
  const points: CenterlinePoint[] = [];
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    points.push({ position: ostium.clone().addScaledVector(ostiumDirection, t * 2), radius: 0.03, t });
  }
  const mainTrunk: CenterlineBranch = {
    id: "main",
    label: "main",
    isMainTrunk: true,
    startNodeId: "n0",
    endNodeId: "n1",
    waypoints: [
      { nodeId: "n0", t: 0 },
      { nodeId: "n1", t: 1 },
    ],
    points,
  };
  return { nodes: [], edges: [], branches: [mainTrunk], rootNodeId: "n0" };
}

describe("computeAorticRootFrame containment margin", () => {
  // Real ostium data is never exactly at the frame's up=0 reference height, and LAD/LCX each
  // sit a little off the averaged "leftAngle" lobe center -- both push the real ostium points
  // slightly outside a naively-fit sinusRadius (this was the guiding catheter's reported
  // "tip pierces the aortic root wall" bug: the ostium itself, the point the catheter tip must
  // end at, sat marginally outside the visualized wall). Reproduce that height/angle offset
  // pattern with synthetic-but-realistic ostium placement and verify the frame now guarantees
  // containment for all three.
  const heartCentroid = new Vector3(0, 0, 0);
  const radius = 0.5;
  const rcaAngle = Math.PI; // arbitrary
  const ladAngle = rcaAngle - (2 * Math.PI) / 3 + 0.03; // near the "left" lobe, offset from LCX
  const lcxAngle = rcaAngle - (2 * Math.PI) / 3 - 0.04;

  const rcaOstium = new Vector3(Math.cos(rcaAngle) * radius, -0.12, Math.sin(rcaAngle) * radius);
  const ladOstium = new Vector3(Math.cos(ladAngle) * radius * 1.02, 0.12, Math.sin(ladAngle) * radius * 1.02);
  const lcxOstium = new Vector3(Math.cos(lcxAngle) * radius * 1.05, 0.1, Math.sin(lcxAngle) * radius * 1.05);

  const graphs = new Map<VesselId, VesselGraph>([
    ["RCA", buildGraph(rcaOstium, new Vector3(0, 1, 0))],
    ["LAD", buildGraph(ladOstium, new Vector3(1, 0, 0))],
    ["LCX", buildGraph(lcxOstium, new Vector3(1, 0, 0))],
  ]);

  it("contains all three real ostium points within the visualized lumen wall (distance <= local radius bound)", () => {
    const frame = computeAorticRootFrame(heartCentroid, graphs);
    expect(frame).not.toBeNull();
    if (!frame) return;

    for (const [label, ostium] of [
      ["RCA", rcaOstium],
      ["LAD", ladOstium],
      ["LCX", lcxOstium],
    ] as const) {
      const bound = evaluateAorticRootRadius(frame, ostium);
      const dist = distanceFromAxis(frame, ostium);
      expect(dist, `${label} ostium should sit within the modeled wall's local radius`).toBeLessThanOrEqual(bound);
    }
  });
});

describe("buildAorticCavityClippingPlanes", () => {
  // The heart mesh has no separate hollow aortic lumen -- the guiding catheter's "pierces the
  // heart" bug turned out to be structurally unfixable via path-point correction, because the
  // entire sinus-to-sinotubular-junction volume is solid tissue in the mesh data (verified via
  // raycasting against the real heart-realistic.glb mesh). buildAorticCavityClippingPlanes
  // carves that volume out of the Heart material via Three.js clipIntersection clipping instead.
  function makeFrame(overrides: Partial<AorticRootFrame> = {}): AorticRootFrame {
    return {
      center: new Vector3(1, 2, 3),
      axis: new Vector3(0, 1, 0),
      sinusRadius: 0.6,
      rcaAngle: 0,
      leftAngle: (Math.PI * 2) / 3,
      nonCoronaryAngle: (-Math.PI * 2) / 3,
      ...overrides,
    };
  }

  it("returns one plane per side plus two height caps", () => {
    const frame = makeFrame();
    const planes = buildAorticCavityClippingPlanes(frame);
    expect(planes.length).toBe(16 + 2);
  });

  it("clips (all planes negative) a point on the frame's own axis, at a mid-cavity height", () => {
    const frame = makeFrame();
    const planes = buildAorticCavityClippingPlanes(frame);
    const midHeightPoint = pointAtRelativeHeight(frame, 0); // frame.center itself
    for (const plane of planes) {
      expect(plane.distanceToPoint(midHeightPoint)).toBeLessThan(0);
    }
  });

  it("does NOT clip (at least one plane non-negative) a point far outside the cavity radius", () => {
    const frame = makeFrame();
    const planes = buildAorticCavityClippingPlanes(frame);
    const farPoint = frame.center.clone().add(new Vector3(10, 0, 0));
    expect(planes.some((plane) => plane.distanceToPoint(farPoint) >= 0)).toBe(true);
  });

  it("does NOT clip (at least one plane non-negative) a point far above the cavity's height range", () => {
    const frame = makeFrame();
    const planes = buildAorticCavityClippingPlanes(frame);
    const farAbovePoint = pointAtRelativeHeight(frame, 10);
    expect(planes.some((plane) => plane.distanceToPoint(farAbovePoint) >= 0)).toBe(true);
  });
});
