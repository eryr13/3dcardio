import { describe, expect, it } from "vitest";
import { Mesh, SphereGeometry, Vector3 } from "three";
import { distanceFromAxis, evaluateAorticRootRadius, projectOntoFrame } from "./aorticRootMesh";
import type { AorticRootFrame } from "./aorticRootMesh";
import {
  buildBranchPathPoints,
  buildGuideCatheterGeometry,
  buildGuideWireGeometry,
  computeGuideCatheterPath,
  getAncestryChain,
} from "./guideDeviceMesh";
import type { CenterlineBranch, VesselGraph } from "./vesselGraph";
import type { CenterlinePoint } from "./vesselCenterline";

/** テスト用の大動脈基部フレームを組み立てる(computeAorticRootFrameが実データから逆算する
 * ものと同じ形。個々のテストで角度・半径・中心だけを差し替えられるようにする)。 */
function makeAorticRootFrame(overrides: Partial<AorticRootFrame> = {}): AorticRootFrame {
  return {
    center: new Vector3(0, 0, 0),
    axis: new Vector3(0, 1, 0),
    sinusRadius: 1,
    rcaAngle: 0,
    leftAngle: (Math.PI * 2) / 3,
    nonCoronaryAngle: (-Math.PI * 2) / 3,
    ...overrides,
  };
}

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

  it("RCA and LCA shapes produce different bulge (contralateral wall) points from the same aortic root frame", () => {
    // The RCA/LCA shape distinction now comes entirely from which of the frame's two known
    // angles (rcaAngle vs leftAngle) is used as the "contralateral" direction, plus a different
    // wall-reach fraction -- exactly as production callers do (same frame, different target).
    const frame = makeAorticRootFrame({ rcaAngle: 0, leftAngle: Math.PI / 2, sinusRadius: 2 });
    const rcaPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "radial", frame, null);
    const ladPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "LAD", "radial", frame, null);
    expect(rcaPath).not.toBeNull();
    expect(ladPath).not.toBeNull();
    // Same ostium (tip) but different approach control points. Index 0 is the access-route
    // entry point, which is shape-independent by design (the puncture site doesn't depend on
    // which coronary is being engaged).
    expect(rcaPath!.placement.ostiumPosition.distanceTo(ladPath!.placement.ostiumPosition)).toBeCloseTo(0, 5);
    expect(rcaPath!.placement.controlPoints[0].distanceTo(ladPath!.placement.controlPoints[0])).toBeCloseTo(0, 5);
    // Layout: [...entryOffsets, aortaPoint, bulgePoint, tipAlignmentPoint, ostium]. bulgePoint
    // (length-3) is the one that differs: RCA aims at leftAngle, LCA aims at rcaAngle, and each
    // uses its own wall-reach fraction.
    const bulgeIndex = rcaPath!.placement.controlPoints.length - 3;
    expect(rcaPath!.placement.controlPoints[bulgeIndex].distanceTo(ladPath!.placement.controlPoints[bulgeIndex])).toBeGreaterThan(0.1);
  });

  it("catheter geometry at progress=0 is tiny (near the outside anchor), at progress=1 reaches the ostium", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "radial", null, null)!;
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

  it("tip direction fits the ostium's own origin direction exactly (guiding catheter engagement, not an arbitrary hook)", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "radial", null, null)!;
    // The guiding catheter tip must fit into the coronary ostium aligned with the vessel's own
    // origin direction (buildCatheterApproach's approachPoint = ostium - ostiumDirection*depth
    // makes this hold exactly, by construction).
    expect(path.placement.tipDirection.dot(path.placement.ostiumDirection)).toBeCloseTo(1, 6);
  });

  it("aorta/bulge control points stay well clear of the ostium; the tip-alignment stub is intentionally close", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "radial", null, null)!;
    const ostium = path.placement.ostiumPosition;
    // Layout: [...entryOffsets, aortaPoint, bulgePoint, tipAlignmentPoint, ostium]. aortaPoint/
    // bulgePoint represent the ascending aorta and the contralateral-wall bulge (backup) and
    // should stay clearly away from the ostium; tipAlignmentPoint is the short engagement stub
    // aligned with ostiumDirection and is expected to sit close to the ostium by design.
    const controlPoints = path.placement.controlPoints;
    const aortaPoint = controlPoints[controlPoints.length - 4];
    const bulgePoint = controlPoints[controlPoints.length - 3];
    expect(aortaPoint.distanceTo(ostium)).toBeGreaterThan(0.3);
    expect(bulgePoint.distanceTo(ostium)).toBeGreaterThan(0.3);
  });

  it("femoral access route loops below the heart before the aortic approach, unlike the default radial route", () => {
    // Real anatomy: femoral access enters via the groin/iliac/abdominal aorta, well below
    // the heart, before coming back up and over the arch; radial enters from the arm, always
    // above the heart. This should show up as a much lower minimum height along the path.
    const radialPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "radial", null, null)!;
    const femoralPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "femoral", null, null)!;
    const ostiumY = radialPath.placement.ostiumPosition.y;

    const minYRadial = Math.min(...radialPath.placement.controlPoints.map((p) => p.y));
    const minYFemoral = Math.min(...femoralPath.placement.controlPoints.map((p) => p.y));

    expect(minYRadial).toBeGreaterThan(ostiumY - 1);
    expect(minYFemoral).toBeLessThan(ostiumY - 2);
  });

  it("records the access route used on the placement (for future Phase 10 use)", () => {
    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "femoral", null, null)!;
    expect(path.placement.accessRoute).toBe("femoral");
  });

  it("floor point sits near the frame's contralateral angle (blended toward the target's own angle), deeper (lower + closer to the wall) for LCA than RCA", () => {
    // Layout with a frame present: [...entryOffsets, aortaPoint, topPoint, midDescentPoint,
    // floorPoint (bulgePoint), hookPoint, tipAlignmentPoint, ostium] -- floorPoint sits 4 from
    // the end.
    const frame = makeAorticRootFrame({
      center: new Vector3(5, 5, 5),
      rcaAngle: 0,
      leftAngle: Math.PI / 2,
      sinusRadius: 2,
    });
    const rcaPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "RCA", "radial", frame, null)!;
    const ladPath = computeGuideCatheterPath(graph, heartCentroid, heartScale, "LAD", "radial", frame, null)!;

    const rcaFloor = rcaPath.placement.controlPoints[rcaPath.placement.controlPoints.length - 4];
    const ladFloor = ladPath.placement.controlPoints[ladPath.placement.controlPoints.length - 4];

    // RCA targets aim their floor point mostly at the frame's leftAngle (here, +Z-ish direction
    // from the axis); LCA (LAD/LCX) targets aim mostly at rcaAngle (here, +X-ish direction from
    // the axis) -- but both are now blended 25% (MAIN_LOOP_ANGLE_BLEND) toward the target's own
    // ostium angle, so RCA/LAD/LCX no longer collapse onto identical TOP/MID_DESCENT/FLOOR
    // control points (previously the whole main loop was identical for any two targets sharing
    // the same shape="LCA" bucket, e.g. LAD vs LCX, since it depended only on the coarse
    // RCA-vs-LCA distinction). The test graph's ostium sits at (0,0,0), frame.center at
    // (5,5,5), so ownAngle = atan2(-5,-5) = -135° for both paths (same synthetic graph/ostium
    // reused for both target vessels here) -- this pulls RCA's floor angle from 90° toward -135°
    // (by 25% of the 135° gap) and LAD's from 0° toward -135° (by 25% of the -135° gap).
    const rcaFloorProjection = projectOntoFrame(frame, rcaFloor);
    const ladFloorProjection = projectOntoFrame(frame, ladFloor);
    // Mirrors production's angularDiff (shortest signed angle b -> a, in (-pi, pi]) so the
    // expected blend matches exactly regardless of which side of the wrap the raw angles fall on.
    function angularDiff(a: number, b: number): number {
      let d = (a - b) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      return d;
    }
    const ownAngle = Math.atan2(0 - frame.center.z, 0 - frame.center.x); // ostium at origin, per graph above
    const expectedRcaTheta = frame.leftAngle + angularDiff(ownAngle, frame.leftAngle) * 0.25;
    const expectedLadTheta = frame.rcaAngle + angularDiff(ownAngle, frame.rcaAngle) * 0.25;
    expect(rcaFloorProjection.theta).toBeCloseTo(expectedRcaTheta, 5);
    expect(ladFloorProjection.theta).toBeCloseTo(expectedLadTheta, 5);

    // LCA (JL/EBU) drops to a deeper floor (lower upRelative, i.e. closer to the annulus) and
    // reaches farther into the wall than RCA (JR) -- user requirement: "LCAはRCAより深い、
    // 対側壁をしっかり使うカーブ".
    expect(ladFloorProjection.upRelative).toBeLessThan(rcaFloorProjection.upRelative);
    const rcaFloorDist = distanceFromAxis(frame, rcaFloor);
    const ladFloorDist = distanceFromAxis(frame, ladFloor);
    expect(ladFloorDist).toBeGreaterThan(rcaFloorDist);
    // Both stay within the cylinder's local radius bound at their own height (never overshoot
    // past the wall).
    expect(rcaFloorDist).toBeLessThanOrEqual(evaluateAorticRootRadius(frame, rcaFloor));
    expect(ladFloorDist).toBeLessThanOrEqual(evaluateAorticRootRadius(frame, ladFloor));
  });
});

describe("computeGuideCatheterPath with a real heart mesh (piercing avoidance)", () => {
  // A unit sphere centered at the origin stands in for the heart's myocardium mesh -- it has
  // an exact analytic "outside" test (distance from center > radius), so these tests can check
  // real geometric safety without the noisy multi-directional raycast approach used to validate
  // this design against the actual heart-realistic.glb mesh during development.
  function buildSphereMesh(radius: number): Mesh {
    // High segment count: the mesh-clearance correction tests against the convex hull of this
    // mesh's own vertices, which -- for a perfectly round analytic shape like a sphere -- is a
    // faceted polytope strictly inside the ideal sphere surface (each flat face is a chord of
    // the true curve). A coarse tessellation leaves a small but real gap between "outside the
    // hull" and "outside the ideal sphere" that the exact analytic check below would catch as a
    // false failure; a fine tessellation shrinks that gap well below the correction's step size.
    // This is a property of testing an idealized shape with a discretized mesh, not a concern
    // for the real (concave) heart mesh, whose hull is a conservative superset with a much
    // wider margin -- verified separately via real ray-mesh intersection testing.
    const mesh = new Mesh(new SphereGeometry(radius, 96, 96));
    mesh.updateMatrixWorld(true);
    return mesh;
  }

  function buildGraphWithOstium(ostium: Vector3, ostiumDirection: Vector3): VesselGraph {
    // A short straight branch starting at `ostium` and heading along `ostiumDirection`,
    // matching how sampleCenterline(points, 0).tangent derives ostiumDirection in production.
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

  it("points outside the aortic root lumen still get corrected away from the sphere; points inside stay within the lumen's containment bound", () => {
    // Ostium on the sphere's "equator" (not the pole), with a TANGENTIAL origin direction --
    // like the real heart mesh, where "up" and the frame's own directions are generally
    // different axes. frame.center sits just OUTSIDE the sphere (0.1 beyond the surface --
    // realistic, since the aortic root mostly protrudes from the myocardium's own solid mass),
    // but the contralateral wall point (aimed back toward -X, rcaAngle=PI) dips inside the
    // sphere by construction: center(1.1,0,0) + (-1,0,0)*sinusRadius(0.3)*wallFraction(0.95)
    // = (0.815,0,0), length 0.815 < 1. A real heart mesh has no separate aorta lumen geometry,
    // so this kind of overlap between the visualized root and the myocardium mesh is expected
    // near the base of the great vessels -- ensurePathClearsHeartMesh must NOT fight
    // ensurePathStaysInsideAorticRoot by yanking this point back outside the sphere (that was
    // the actual bug this test used to (mis)detect, before isWithinAorticRootLumen's exemption
    // was added); instead it must stay within the aortic root's own containment bound.
    const sphereRadius = 1.0;
    const sphereMesh = buildSphereMesh(sphereRadius);
    const heartCentroid = new Vector3(0, 0, 0);
    const heartScale = 1.0;

    const ostium = new Vector3(1, 0, 0);
    const ostiumDirection = new Vector3(0, 0, 1);
    const frame = makeAorticRootFrame({ center: new Vector3(1.1, 0, 0), rcaAngle: Math.PI, sinusRadius: 0.3 });
    const graph = buildGraphWithOstium(ostium, ostiumDirection);

    const path = computeGuideCatheterPath(graph, heartCentroid, heartScale, "LAD", "radial", frame, sphereMesh)!;
    expect(path).not.toBeNull();

    // The aorta-point (well beyond the visualized root, heading out toward the body) must
    // still be corrected outside the sphere -- the lumen exemption must not over-reach into
    // the "outside the aorta" part of the path. Layout with a frame present:
    // [...entryOffsets, aortaPoint, lumenExitPoint, midLumenPoint, bulgePoint, tipAlignmentPoint,
    // ostium] -- aortaPoint sits 6 from the end.
    const aortaPoint = path.placement.controlPoints[path.placement.controlPoints.length - 6];
    expect(aortaPoint.length()).toBeGreaterThan(sphereRadius);

    // Every sampled point in the core aortic segment (bulge -> mid-lumen, beyond the tip stub
    // but before the transition toward lumenExit/aortaPoint -- which, in this test, uses
    // heartScale(1.0)-based offsets much larger than the deliberately tiny sinusRadius(0.3),
    // so it necessarily leaves the frame's own scale well before reaching the real aortaPoint;
    // that transition zone is not what this test is about) must satisfy the aortic-root
    // containment bound: horizontal distance from the frame's axis no greater than the local
    // radius at that height, regardless of whether it also reads as "inside" the sphere.
    let worstRatio = 0;
    for (const p of path.fullSplinePoints) {
      const distanceFromOstium = p.distanceTo(ostium);
      if (distanceFromOstium < 0.4 || distanceFromOstium > 0.9) continue;
      const ratio = distanceFromAxis(frame, p) / evaluateAorticRootRadius(frame, p);
      worstRatio = Math.max(worstRatio, ratio);
    }
    expect(worstRatio).toBeLessThan(1.01);
  });

  it("tip direction still fits ostiumDirection exactly even after aortic-root and mesh-based correction moves nearby points", () => {
    const sphereMesh = buildSphereMesh(1.0);
    const heartCentroid = new Vector3(0, 0, 0);
    const ostium = new Vector3(1, 0, 0);
    const ostiumDirection = new Vector3(0, 0, 1);
    const frame = makeAorticRootFrame({ center: new Vector3(1.1, 0, 0), rcaAngle: Math.PI, sinusRadius: 0.3 });
    const graph = buildGraphWithOstium(ostium, ostiumDirection);

    const path = computeGuideCatheterPath(graph, heartCentroid, 1.0, "LAD", "radial", frame, sphereMesh)!;
    expect(path!.placement.tipDirection.dot(path!.placement.ostiumDirection)).toBeCloseTo(1, 6);
  });

  it("numerically verifies the aortic segment of the path stays within the local radius bound at every height (user-facing containment guarantee)", () => {
    // Restrict the check to the aortic segment itself (near the ostium, within the frame's own
    // scale) -- the "exit to outside the body" and access-route entry points are, by design, far
    // beyond the visualized aortic root (anchored to heartScale, not the frame), so they are
    // correctly NOT held to the aortic root's containment bound.
    const sphereMesh = buildSphereMesh(1.0);
    const heartCentroid = new Vector3(0, 0, 0);
    const ostium = new Vector3(1, 0, 0);
    const ostiumDirection = new Vector3(0, 0, 1);
    const frame = makeAorticRootFrame({ center: new Vector3(1.1, 0, 0), rcaAngle: Math.PI, leftAngle: Math.PI / 2, sinusRadius: 0.3 });
    const graph = buildGraphWithOstium(ostium, ostiumDirection);

    for (const target of ["RCA", "LAD"] as const) {
      const path = computeGuideCatheterPath(graph, heartCentroid, 1.0, target, "radial", frame, sphereMesh)!;
      for (const p of path.fullSplinePoints) {
        const distanceFromOstium = p.distanceTo(ostium);
        if (distanceFromOstium < 0.4 || distanceFromOstium > 0.9) continue;
        const ratio = distanceFromAxis(frame, p) / evaluateAorticRootRadius(frame, p);
        expect(ratio).toBeLessThan(1.01);
      }
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

  it("has a floppy tip: bulges sideways well beyond the wire's own radius near the tip", () => {
    // Regression test for the decorative floppy-tip curl (appendFloppyTip). With enough
    // wire out, the tip should curl sideways (here, in +/-X, since the main trunk runs
    // along +Y) by much more than the wire's own radius -- a plain straight-ended tube
    // would stay within wireRadius of the x=0 centerline for its whole length.
    const wireRadius = 0.005;
    const geometry = buildGuideWireGeometry(graph, "RCA-main", wireRadius, 0.6)!;
    const posAttr = geometry.getAttribute("position");
    let maxAbsX = 0;
    for (let i = 0; i < posAttr.count; i++) {
      maxAbsX = Math.max(maxAbsX, Math.abs(posAttr.getX(i)));
    }
    expect(maxAbsX).toBeGreaterThan(wireRadius * 3);
  });

  it("omits the floppy tip when too little wire is out (short stub near the ostium)", () => {
    // At a tiny progress, appendFloppyTip should back off rather than draw a curl bigger
    // than the wire stub itself.
    const wireRadius = 0.005;
    const geometry = buildGuideWireGeometry(graph, "RCA-main", wireRadius, 0.001)!;
    const posAttr = geometry.getAttribute("position");
    let maxAbsX = 0;
    for (let i = 0; i < posAttr.count; i++) {
      maxAbsX = Math.max(maxAbsX, Math.abs(posAttr.getX(i)));
    }
    expect(maxAbsX).toBeLessThan(wireRadius * 3);
  });
});
