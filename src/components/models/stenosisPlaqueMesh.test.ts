import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import type { BufferGeometry } from "three";
import { buildStenosisPlaqueGeometry } from "./stenosisPlaqueMesh";
import type { CenterlinePoint } from "./vesselCenterline";
import type { StenosisObject } from "../../types/object";

function straightCenterline(length: number, count = 21): CenterlinePoint[] {
  const points: CenterlinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push({ position: new Vector3(0, t * length, 0), radius: 0.003, t });
  }
  return points;
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

/**
 * 与えられたBufferGeometryが「開いた縁(境界エッジ)」を一切持たない閉じたシェルかを
 * 判定する。各三角形が向き付き有向エッジ(p→q)を3本持つとみなし、閉じた2-manifoldなら
 * 有向エッジ(p→q)ごとに、隣接する三角形が持つ反対向き(q→p)がちょうど1本存在する
 * はず(=開口部が無ければ、全ての辺が2枚の三角形に共有される)。頂点は位置で
 * 突き合わせる(pushOrientedTriangleで作るキャップは頂点を共有せず複製するため、
 * buildTubeFromPointsが作るチューブ本体の共有頂点とインデックスが一致しないが、
 * 同じ3D位置には来るはずなので、位置ベースでの突き合わせが必要)。
 */
function findBoundaryEdges(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  const position = geometry.getAttribute("position");
  if (!index || !position) throw new Error("geometry missing index/position");

  const keyOf = (i: number) =>
    `${position.getX(i).toFixed(4)},${position.getY(i).toFixed(4)},${position.getZ(i).toFixed(4)}`;

  const directedEdgeCounts = new Map<string, number>();
  for (let t = 0; t < index.count; t += 3) {
    const verts = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    for (let e = 0; e < 3; e++) {
      const p = keyOf(verts[e]);
      const q = keyOf(verts[(e + 1) % 3]);
      const edgeKey = `${p}|${q}`;
      directedEdgeCounts.set(edgeKey, (directedEdgeCounts.get(edgeKey) ?? 0) + 1);
    }
  }

  let boundaryEdges = 0;
  for (const [edgeKey] of directedEdgeCounts) {
    const [p, q] = edgeKey.split("|");
    const opposite = `${q}|${p}`;
    if (!directedEdgeCounts.has(opposite)) boundaryEdges++;
  }
  return boundaryEdges;
}

describe("buildStenosisPlaqueGeometry end caps (no open tube ends)", () => {
  const centerline = straightCenterline(5.6);

  it("closes outer/inner/merged with no boundary (open) edges", () => {
    const { merged, outer, inner } = buildStenosisPlaqueGeometry(centerline, stenosis({ severity: 80 }));
    expect(findBoundaryEdges(outer)).toBe(0);
    expect(findBoundaryEdges(inner)).toBe(0);
    expect(findBoundaryEdges(merged)).toBe(0);
  });

  it("stays closed at very high severity (near-total occlusion)", () => {
    const { merged, outer, inner } = buildStenosisPlaqueGeometry(centerline, stenosis({ severity: 99 }));
    expect(findBoundaryEdges(outer)).toBe(0);
    expect(findBoundaryEdges(inner)).toBe(0);
    expect(findBoundaryEdges(merged)).toBe(0);
  });

  it("stays closed for a short lesion (small half-length)", () => {
    const { merged, outer, inner } = buildStenosisPlaqueGeometry(centerline, stenosis({ length: 0.02, severity: 90 }));
    expect(findBoundaryEdges(outer)).toBe(0);
    expect(findBoundaryEdges(inner)).toBe(0);
    expect(findBoundaryEdges(merged)).toBe(0);
  });
});
