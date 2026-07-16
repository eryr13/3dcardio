import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { buildContrastFillGeometry } from "./contrastFillMesh";
import { computeArrivalTables, getArrivalTimeAt, DEFAULT_CONTRAST_FLOW_PARAMS } from "../../utils/contrastFlow";
import type { CenterlineBranch, VesselGraph } from "./vesselGraph";
import type { CenterlinePoint } from "./vesselCenterline";
import type { StenosisObject } from "../../types/object";

function straightBranchPoints(length: number, count = 41): CenterlinePoint[] {
  const points: CenterlinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push({ position: new Vector3(0, t * length, 0), radius: 0.04, t });
  }
  return points;
}

function buildTestGraph(): VesselGraph {
  const mainTrunk: CenterlineBranch = {
    id: "RCA-main",
    label: "main",
    isMainTrunk: true,
    startNodeId: "n0",
    endNodeId: "n1",
    waypoints: [
      { nodeId: "n0", t: 0 },
      { nodeId: "n1", t: 1 },
    ],
    points: straightBranchPoints(5.6),
  };
  return { rootNodeId: "n0", nodes: [], edges: [], branches: [mainTrunk] };
}

/** For each centerline sample point, the largest ring-vertex distance from it (~= rendered radius there). */
function radiiAlongTube(geometry: ReturnType<typeof buildContrastFillGeometry>, centerlinePoints: Vector3[]): number[] {
  if (!geometry) return centerlinePoints.map(() => 0);
  const position = geometry.getAttribute("position");
  const radii = centerlinePoints.map(() => 0);
  for (let v = 0; v < position.count; v++) {
    const vertex = new Vector3(position.getX(v), position.getY(v), position.getZ(v));
    let closestIndex = 0;
    let closestDistSq = Infinity;
    for (let i = 0; i < centerlinePoints.length; i++) {
      const distSq = vertex.distanceToSquared(centerlinePoints[i]);
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closestIndex = i;
      }
    }
    radii[closestIndex] = Math.max(radii[closestIndex], Math.sqrt(closestDistSq));
  }
  return radii;
}

describe("buildContrastFillGeometry radius (no vanishing neck at a stenosis)", () => {
  it("keeps the stenosis's neck visibly narrow-but-present, and the downstream segment at full caliber, once plateaued", () => {
    const graph = buildTestGraph();
    const objects: StenosisObject[] = [
      { id: "s1", type: "stenosis", vesselId: "RCA", branchId: "RCA-main", position: 0.3, length: 0.1, severity: 95, visible: true },
    ];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main")!;

    const branch = graph.branches[0];
    const upstreamIndex = branch.points.findIndex((p) => p.t >= 0.2);
    const neckIndex = branch.points.findIndex((p) => p.t >= 0.3); // lesion center, worst point
    const downstreamIndex = branch.points.findIndex((p) => p.t >= 0.5); // clearly past the lesion

    // Front speed is constant, so the whole trunk arrives within a short span (~1.9s here).
    // Pick an elapsed time shortly after the LAST of these three points arrives, so all three
    // are simultaneously within their own plateau window (past riseTime, before washout starts)
    // — isolating this fix's effect from ordinary washout dynamics, which are a separate concern.
    // table.arrivalSeconds is indexed by the (checkpoint-augmented) integration grid, not by
    // branch.points position, so arrival times must be looked up via getArrivalTimeAt(t).
    const lastArrival = Math.max(
      getArrivalTimeAt(table, branch.points[upstreamIndex].t),
      getArrivalTimeAt(table, branch.points[neckIndex].t),
      getArrivalTimeAt(table, branch.points[downstreamIndex].t),
    );
    const elapsed = lastArrival + DEFAULT_CONTRAST_FLOW_PARAMS.riseTime + 0.1;
    const geometry = buildContrastFillGeometry(graph, objects, "RCA", tables, elapsed, DEFAULT_CONTRAST_FLOW_PARAMS);
    expect(geometry).not.toBeNull();

    const centerlinePoints = branch.points.map((p) => p.position);
    const radii = radiiAlongTube(geometry, centerlinePoints);

    const vesselRadius = branch.points[0].radius;
    const upstreamRadius = radii[upstreamIndex];
    const neckRadius = radii[neckIndex];
    const downstreamRadius = radii[downstreamIndex];

    // Upstream: full caliber.
    expect(upstreamRadius).toBeGreaterThan(vesselRadius * 0.9);

    // The neck is structurally narrow (severity=95% -> radiusFraction=0.05) but must still be
    // clearly visible, not collapsed to near-zero by also multiplying in the (separately low)
    // ceiling there.
    expect(neckRadius).toBeGreaterThan(vesselRadius * 0.03);
    expect(neckRadius).toBeLessThan(vesselRadius * 0.1);

    // Downstream of the lesion the vessel has no structural narrowing (radiusFraction back to
    // 1), so once its own local rise has completed it should render at full anatomical caliber
    // — dimness is expressed via color (contrastFillColor), not by the tube shrinking away.
    expect(downstreamRadius).toBeGreaterThan(vesselRadius * 0.9);
  });

  it("still shows a growing (not stuck-at-zero) radius immediately after the front arrives, even far downstream of a severe stenosis", () => {
    const graph = buildTestGraph();
    const objects: StenosisObject[] = [
      { id: "s1", type: "stenosis", vesselId: "RCA", branchId: "RCA-main", position: 0.3, length: 0.1, severity: 95, visible: true },
    ];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main")!;

    const branch = graph.branches[0];
    const downstreamPoint = branch.points.find((p) => p.t >= 0.5)!;
    const downstreamIndex = branch.points.indexOf(downstreamPoint);
    const centerlinePoints = branch.points.map((p) => p.position);

    // A moment shortly after this point's own front arrival (not the global elapsed time).
    const arrivalHere = getArrivalTimeAt(table, downstreamPoint.t);
    const justAfter = arrivalHere + DEFAULT_CONTRAST_FLOW_PARAMS.riseTime + DEFAULT_CONTRAST_FLOW_PARAMS.plateauDuration / 2;

    const geometry = buildContrastFillGeometry(graph, objects, "RCA", tables, justAfter, DEFAULT_CONTRAST_FLOW_PARAMS);
    expect(geometry).not.toBeNull();
    const radii = radiiAlongTube(geometry, centerlinePoints);
    expect(radii[downstreamIndex]).toBeGreaterThan(downstreamPoint.radius * 0.5);
  });
});
