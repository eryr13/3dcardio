import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  buildBranchPathPoints,
  buildGuideCatheterGeometry,
  buildGuideWireGeometry,
  computeGuideCatheterPath,
  getAncestryChain,
} from "./guideDeviceMesh";
import type { CenterlineBranch, VesselGraph } from "./vesselGraph";
import type { CenterlinePoint } from "./vesselCenterline";

function straightBranchPoints(fromY: number, toY: number, count = 21): CenterlinePoint[] {
  const points: CenterlinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push({ position: new Vector3(0, fromY + (toY - fromY) * t, 0), radius: 0.03, t });
  }
  return points;
}

/** 本幹1本、その中間点(t=0.5)から分岐する側枝1本、さらにその側枝から分岐する孫枝1本を持つ簡易グラフ。 */
function buildTestGraph(): VesselGraph {
  const mainTrunk: CenterlineBranch = {
    id: "RCA-main",
    label: "main",
    isMainTrunk: true,
    startNodeId: "n0",
    endNodeId: "n1",
    waypoints: [
      { nodeId: "n0", t: 0 },
      { nodeId: "n-branch", t: 0.5 },
      { nodeId: "n1", t: 1 },
    ],
    points: straightBranchPoints(0, 10),
  };
  const side: CenterlineBranch = {
    id: "RCA-side1",
    label: "side1",
    isMainTrunk: false,
    startNodeId: "n-branch",
    endNodeId: "n-side-end",
    waypoints: [
      { nodeId: "n-branch", t: 0 },
      { nodeId: "n-grandchild-branch", t: 0.5 },
      { nodeId: "n-side-end", t: 1 },
    ],
    points: straightBranchPoints(5, 8, 11).map((p) => ({ ...p, position: new Vector3(1, p.position.y, 0) })),
  };
  const grandchild: CenterlineBranch = {
    id: "RCA-side2",
    label: "side2 (grandchild of main)",
    isMainTrunk: false,
    startNodeId: "n-grandchild-branch",
    endNodeId: "n-grandchild-end",
    waypoints: [
      { nodeId: "n-grandchild-branch", t: 0 },
      { nodeId: "n-grandchild-end", t: 1 },
    ],
    points: straightBranchPoints(6.5, 9, 11).map((p) => ({ ...p, position: new Vector3(2, p.position.y, 0) })),
  };
  return {
    nodes: [],
    edges: [],
    branches: [mainTrunk, side, grandchild],
    rootNodeId: "n0",
  };
}

describe("getAncestryChain", () => {
  const graph = buildTestGraph();

  it("returns just the main trunk when the target IS the main trunk", () => {
    expect(getAncestryChain(graph, "RCA-main").map((b) => b.id)).toEqual(["RCA-main"]);
  });

  it("returns [main, side] for a direct child", () => {
    expect(getAncestryChain(graph, "RCA-side1").map((b) => b.id)).toEqual(["RCA-main", "RCA-side1"]);
  });

  it("returns [main, side, grandchild] for a grandchild branch", () => {
    expect(getAncestryChain(graph, "RCA-side2").map((b) => b.id)).toEqual(["RCA-main", "RCA-side1", "RCA-side2"]);
  });
});

describe("buildBranchPathPoints", () => {
  const graph = buildTestGraph();

  it("for the main trunk, returns points up to targetProgress only", () => {
    const points = buildBranchPathPoints(graph, "RCA-main", 0.5);
    const lastPoint = points[points.length - 1];
    expect(lastPoint.y).toBeCloseTo(5, 5); // t=0.5 on a 0->10 straight branch
  });

  it("for a grandchild branch, includes full ancestor branches up to their divergence, then partial target", () => {
    const points = buildBranchPathPoints(graph, "RCA-side2", 0.5);
    // Path should pass through: main trunk (x=0) up to its divergence at t=0.5 (y=5),
    // then side1 (x=1) up to ITS divergence at t=0.5, then side2 (x=2) up to t=0.5.
    const xs = points.map((p) => Math.round(p.x));
    expect(xs).toContain(0);
    expect(xs).toContain(1);
    expect(xs).toContain(2);
    // Ensure ordering: all x=0 points come before all x=1 points, which come before all x=2 points.
    const firstX1 = xs.indexOf(1);
    const lastX0 = xs.lastIndexOf(0);
    const firstX2 = xs.indexOf(2);
    const lastX1 = xs.lastIndexOf(1);
    expect(lastX0).toBeLessThan(firstX1);
    expect(lastX1).toBeLessThan(firstX2);
  });
});

describe("computeGuideCatheterPath / buildGuideCatheterGeometry", () => {
  const graph = buildTestGraph();
  const heartCentroid = new Vector3(0, -2, 0);
  const heartScale = 1.0;

  it("RCA and LCA shapes produce different control points for the same ostium", () => {
    const rcaPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA");
    const ladPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "LAD");
    expect(rcaPath).not.toBeNull();
    expect(ladPath).not.toBeNull();
    // Same ostium (tip) but different approach control points.
    expect(rcaPath!.placement.ostiumPosition.distanceTo(ladPath!.placement.ostiumPosition)).toBeCloseTo(0, 5);
    expect(rcaPath!.placement.controlPoints[0].distanceTo(ladPath!.placement.controlPoints[0])).toBeGreaterThan(0.1);
  });

  it("catheter geometry at progress=0 is tiny (near the outside anchor), at progress=1 reaches the ostium", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA")!;
    const geomStart = buildGuideCatheterGeometry(path, 0.05, 0);
    const geomEnd = buildGuideCatheterGeometry(path, 0.05, 1);

    const posStart = geomStart.getAttribute("position");
    const posEnd = geomEnd.getAttribute("position");

    // At progress=0, every vertex should be near the spline's starting point (the outside anchor).
    const anchor = path.fullSplinePoints[0];
    let maxDistAtStart = 0;
    for (let i = 0; i < posStart.count; i++) {
      const d = new Vector3(posStart.getX(i), posStart.getY(i), posStart.getZ(i)).distanceTo(anchor);
      maxDistAtStart = Math.max(maxDistAtStart, d);
    }
    expect(maxDistAtStart).toBeLessThan(0.1);

    // At progress=1, at least one vertex should be very close to the ostium (the tip).
    const ostium = path.placement.ostiumPosition;
    let minDistAtEnd = Infinity;
    for (let i = 0; i < posEnd.count; i++) {
      const d = new Vector3(posEnd.getX(i), posEnd.getY(i), posEnd.getZ(i)).distanceTo(ostium);
      minDistAtEnd = Math.min(minDistAtEnd, d);
    }
    expect(minDistAtEnd).toBeLessThan(0.06);
  });

  it("engages the ostium from below: tip direction points upward (+Y), not straight in from the approach side", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA")!;
    // A "hook from below" engagement should have the final approach direction pointing
    // mostly toward +Y (up), matching the real technique of catching the ostium from underneath.
    expect(path.placement.tipDirection.dot(new Vector3(0, 1, 0))).toBeGreaterThan(0.9);
  });

  it("the loop control points stay well clear of the ostium until the final approach (no premature pass-through)", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA")!;
    const ostium = path.placement.ostiumPosition;
    // Every control point except the last two (the final straight hook-up segment) should be
    // clearly away from the ostium -- otherwise the spline would pass back near/through it
    // prematurely during the loop.
    const controlPoints = path.placement.controlPoints;
    for (let i = 0; i < controlPoints.length - 2; i++) {
      expect(controlPoints[i].distanceTo(ostium)).toBeGreaterThan(0.3);
    }
  });
});

describe("buildGuideWireGeometry", () => {
  const graph = buildTestGraph();

  it("returns null at progress=0 (wire hasn't left the catheter yet)", () => {
    expect(buildGuideWireGeometry(graph, "RCA-main", 0.005, 0)).toBeNull();
  });

  it("at progress>0, the wire's furthest point reaches near the expected centerline position", () => {
    const geometry = buildGuideWireGeometry(graph, "RCA-main", 0.005, 0.6)!;
    expect(geometry).not.toBeNull();
    const posAttr = geometry.getAttribute("position");
    const expectedTip = new Vector3(0, 6, 0); // t=0.6 on the 0->10 straight main trunk
    let minDist = Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      const d = new Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).distanceTo(expectedTip);
      minDist = Math.min(minDist, d);
    }
    expect(minDist).toBeLessThan(0.05);
  });

  it("does not pop in at full aortic-path length: a small progress produces a short wire, not one spanning the whole branch chain", () => {
    // Regression test for the bug where the wire always prepended the catheter's entire
    // spline as a fixed prefix, so the instant wireProgress crossed 0 the visible wire
    // jumped to that full length instead of growing from zero at the ostium.
    const tinyGeometry = buildGuideWireGeometry(graph, "RCA-side2", 0.005, 0.02)!;
    expect(tinyGeometry).not.toBeNull();
    const posAttr = tinyGeometry.getAttribute("position");
    const ostium = new Vector3(0, 0, 0); // RCA-main's t=0 in buildTestGraph
    let maxDist = 0;
    for (let i = 0; i < posAttr.count; i++) {
      maxDist = Math.max(maxDist, new Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).distanceTo(ostium));
    }
    // Total chain length (main 0->10 + side1 5->8 + side2 6.5->9) is well over 10; at 2%
    // progress the visible wire should be a short stub near the ostium, not anywhere close to that.
    expect(maxDist).toBeLessThan(1);
  });

  it("stays pinned at the ostium (start) even after relaxation", () => {
    const geometry = buildGuideWireGeometry(graph, "RCA-main", 0.005, 0.6)!;
    const posAttr = geometry.getAttribute("position");
    const ostium = new Vector3(0, 0, 0);
    let minDist = Infinity;
    for (let i = 0; i < posAttr.count; i++) {
      minDist = Math.min(minDist, new Vector3(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).distanceTo(ostium));
    }
    // The centerline point at index 0 is pinned exactly at the ostium; the nearest tube
    // surface vertex should be within about one wire radius of it.
    expect(minDist).toBeLessThan(0.01);
  });
});
