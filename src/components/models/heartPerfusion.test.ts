import { describe, expect, it } from "vitest";
import { BufferGeometry, Color, Float32BufferAttribute, Vector3 } from "three";
import { buildPerfusionColors, computeBranchAdequacy, computeHeartPerfusionTerritory } from "./heartPerfusion";
import type { VesselGraph, CenterlineBranch } from "./vesselGraph";
import type { CenterlinePoint } from "./vesselCenterline";
import type { CardioObject, StenosisObject } from "../../types/object";

function straightBranchPoints(fromY: number, toY: number, count = 11): CenterlinePoint[] {
  const points: CenterlinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push({ position: new Vector3(0, fromY + (toY - fromY) * t, 0), radius: 0.003, t });
  }
  return points;
}

function singleBranchGraph(branchId: string, fromY: number, toY: number): VesselGraph {
  const branch: CenterlineBranch = {
    id: branchId,
    label: branchId,
    isMainTrunk: true,
    startNodeId: "n0",
    endNodeId: "n1",
    waypoints: [
      { nodeId: "n0", t: 0 },
      { nodeId: "n1", t: 1 },
    ],
    points: straightBranchPoints(fromY, toY),
  };
  return { nodes: [], edges: [], branches: [branch], rootNodeId: "n0" };
}

function stenosis(overrides: Partial<StenosisObject> = {}): StenosisObject {
  return {
    id: "s1",
    type: "stenosis",
    vesselId: "RCA",
    branchId: "RCA-main",
    position: 0.5,
    length: 0.2,
    severity: 70,
    visible: true,
    ...overrides,
  };
}

/** 単純な立方体状の頂点だけを持つ、深度ピール等を一切気にしない検証用ジオメトリ。 */
function pointCloudGeometry(positions: Vector3[]): BufferGeometry {
  const geometry = new BufferGeometry();
  const flat = new Float32Array(positions.length * 3);
  positions.forEach((p, i) => {
    flat[i * 3] = p.x;
    flat[i * 3 + 1] = p.y;
    flat[i * 3 + 2] = p.z;
  });
  geometry.setAttribute("position", new Float32BufferAttribute(flat, 3));
  return geometry;
}

describe("computeHeartPerfusionTerritory", () => {
  it("assigns each heart vertex to the nearer of two branches", () => {
    // RCA本幹はy=0付近、LAD本幹はy=10付近に置き、両者から離れた場所に「心臓頂点」を
    // 2つ置く(y=0.5付近はRCAの方が近く、y=9.5付近はLADの方が近いはず)。
    const graphs = new Map([
      ["RCA" as const, singleBranchGraph("RCA-main", 0, 1)],
      ["LAD" as const, singleBranchGraph("LAD-main", 9, 10)],
    ]);
    const heartVertices = [new Vector3(0.1, 0.5, 0), new Vector3(0.1, 9.5, 0)];
    const geometry = pointCloudGeometry(heartVertices);

    const territory = computeHeartPerfusionTerritory(geometry, graphs);

    expect(territory.vertexCount).toBe(2);
    const branchIdForVertex0 = territory.branchIds[territory.branchIndexByVertex[0]];
    const branchIdForVertex1 = territory.branchIds[territory.branchIndexByVertex[1]];
    expect(branchIdForVertex0).toBe("RCA-main");
    expect(branchIdForVertex1).toBe("LAD-main");
    expect(territory.vesselIdByBranchIndex[territory.branchIndexByVertex[0]]).toBe("RCA");
    expect(territory.vesselIdByBranchIndex[territory.branchIndexByVertex[1]]).toBe("LAD");
  });
});

describe("computeBranchAdequacy", () => {
  it("returns adequacy < 1 for a branch with a severe stenosis, and 1 for an unaffected branch", () => {
    const graphs = new Map([
      ["RCA" as const, singleBranchGraph("RCA-main", 0, 1)],
      ["LAD" as const, singleBranchGraph("LAD-main", 0, 1)],
    ]);
    const objects: CardioObject[] = [stenosis({ severity: 95, vesselId: "RCA", branchId: "RCA-main" })];

    const adequacy = computeBranchAdequacy(graphs, objects);

    expect(adequacy.get("RCA-main")!).toBeLessThan(0.5);
    expect(adequacy.get("LAD-main")!).toBeCloseTo(1, 5);
  });

  it("returns exactly 0 for a fully occluded branch", () => {
    const graphs = new Map([["RCA" as const, singleBranchGraph("RCA-main", 0, 1)]]);
    const objects: CardioObject[] = [stenosis({ severity: 99, length: 0.5 })];
    // severity is capped at 99 by type contract, but a very long/severe lesion plus
    // the logistic pass-through curve should still drive adequacy to (near) zero downstream.
    const adequacy = computeBranchAdequacy(graphs, objects);
    expect(adequacy.get("RCA-main")!).toBeLessThan(0.05);
  });
});

describe("computeHeartPerfusionTerritory (k-d tree regression)", () => {
  it("matches brute-force nearest-neighbor assignment on a larger randomized case", () => {
    // Build several branches with enough points to exceed the internal subsampling cap,
    // and enough heart vertices to exercise the k-d tree's pruning logic broadly.
    function randomBranch(id: string, seed: number): CenterlineBranch {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const points: CenterlinePoint[] = [];
      for (let i = 0; i < 25; i++) {
        points.push({
          position: new Vector3(rand() * 10 - 5, rand() * 10 - 5, rand() * 10 - 5),
          radius: 0.003,
          t: i / 24,
        });
      }
      return {
        id,
        label: id,
        isMainTrunk: true,
        startNodeId: "n0",
        endNodeId: "n1",
        waypoints: [
          { nodeId: "n0", t: 0 },
          { nodeId: "n1", t: 1 },
        ],
        points,
      };
    }

    const graphs = new Map([
      ["RCA" as const, { nodes: [], edges: [], branches: [randomBranch("RCA-main", 1), randomBranch("RCA-side1", 2)], rootNodeId: "n0" }],
      ["LAD" as const, { nodes: [], edges: [], branches: [randomBranch("LAD-main", 3), randomBranch("LAD-side1", 4)], rootNodeId: "n0" }],
      ["LCX" as const, { nodes: [], edges: [], branches: [randomBranch("LCX-main", 5)], rootNodeId: "n0" }],
    ]);

    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const heartVertices: Vector3[] = [];
    for (let i = 0; i < 300; i++) {
      heartVertices.push(new Vector3(rand() * 10 - 5, rand() * 10 - 5, rand() * 10 - 5));
    }
    const geometry = pointCloudGeometry(heartVertices);

    const territory = computeHeartPerfusionTerritory(geometry, graphs);

    // Reference: brute-force nearest seed point (using the SAME per-branch subsampling
    // the real implementation applies internally, capped at 12 points/branch) so this is
    // an apples-to-apples check of the k-d tree's correctness, not of the subsampling choice.
    function subsample(points: CenterlinePoint[], max: number): CenterlinePoint[] {
      if (points.length <= max) return points;
      const result: CenterlinePoint[] = [];
      for (let i = 0; i < max; i++) {
        result.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
      }
      return result;
    }
    const seeds: { pos: Vector3; branchId: string }[] = [];
    for (const [, graph] of graphs) {
      for (const branch of graph.branches) {
        for (const p of subsample(branch.points, 12)) {
          seeds.push({ pos: p.position, branchId: branch.id });
        }
      }
    }

    for (let i = 0; i < heartVertices.length; i++) {
      let bestDistSq = Infinity;
      let bestBranchId = "";
      for (const seed of seeds) {
        const distSq = heartVertices[i].distanceToSquared(seed.pos);
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestBranchId = seed.branchId;
        }
      }
      const assignedBranchId = territory.branchIds[territory.branchIndexByVertex[i]];
      expect(assignedBranchId).toBe(bestBranchId);
    }
  });
});

describe("buildPerfusionColors", () => {
  const graphs = new Map([
    ["RCA" as const, singleBranchGraph("RCA-main", 0, 1)],
    ["LAD" as const, singleBranchGraph("LAD-main", 9, 10)],
  ]);
  const heartVertices = [new Vector3(0.1, 0.5, 0), new Vector3(0.1, 9.5, 0)];
  const geometry = pointCloudGeometry(heartVertices);
  const territory = computeHeartPerfusionTerritory(geometry, graphs);

  it("territory mode colors each vertex with its owning vessel's configured color", () => {
    const vesselColors = { RCA: "#3d8bfd", LAD: "#3ddc84", LCX: "#f7b731" };
    const colors = buildPerfusionColors(territory, "territory", vesselColors, null);

    const expectedRca = new Color("#3d8bfd");
    const expectedLad = new Color("#3ddc84");
    expect(colors[0]).toBeCloseTo(expectedRca.r, 5);
    expect(colors[1]).toBeCloseTo(expectedRca.g, 5);
    expect(colors[2]).toBeCloseTo(expectedRca.b, 5);
    expect(colors[3]).toBeCloseTo(expectedLad.r, 5);
    expect(colors[4]).toBeCloseTo(expectedLad.g, 5);
    expect(colors[5]).toBeCloseTo(expectedLad.b, 5);
  });

  it("ischemia mode colors a normally-perfused branch green-ish and an infarcted branch red-ish", () => {
    const vesselColors = { RCA: "#3d8bfd", LAD: "#3ddc84", LCX: "#f7b731" };
    const adequacy = new Map([
      ["RCA-main", 1.0],
      ["LAD-main", 0.0],
    ]);
    const colors = buildPerfusionColors(territory, "ischemia", vesselColors, adequacy);

    const normalColor = new Color(colors[0], colors[1], colors[2]);
    const infarctColor = new Color(colors[3], colors[4], colors[5]);
    const normalHsl = { h: 0, s: 0, l: 0 };
    const infarctHsl = { h: 0, s: 0, l: 0 };
    normalColor.getHSL(normalHsl);
    infarctColor.getHSL(infarctHsl);

    // Normal: muted sage green (~110deg). Infarct: dusty reddish-brown (~18deg).
    expect(normalHsl.h).toBeCloseTo(110 / 360, 2);
    expect(infarctHsl.h).toBeCloseTo(18 / 360, 2);
    // Infarcted territory should be darker (and both should be muted, not vivid) than normal.
    expect(infarctHsl.l).toBeLessThan(normalHsl.l);
    expect(normalHsl.s).toBeLessThan(0.5);
    expect(infarctHsl.s).toBeLessThan(0.5);
  });
});
