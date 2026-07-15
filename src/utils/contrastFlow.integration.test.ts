// 実際の中心線データセット(src/data/centerlines.json、RCAは多階層の側枝分岐を持つ)に対して
// 造影剤フローの伝播モデルを検証する統合テスト。contrastFlow.test.tsの単体テストは
// 手作りの簡易グラフで境界条件を確認しているのに対し、こちらは本物のvesselGraphを
// 使って「実データでも同じ挙動になるか」を確認する。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTRAST_FLOW_PARAMS,
  buildBranchLinks,
  computeArrivalTables,
  getArrivalTimeAt,
} from "./contrastFlow";
import { getMainTrunk, getVesselGraph } from "../components/models/vesselGraph";
import type { CalcificationObject, StenosisObject } from "../types/object";

describe("computeArrivalTables against the real RCA centerline dataset", () => {
  const graph = getVesselGraph("RCA");
  const mainTrunk = getMainTrunk(graph);

  it("resolves a parent for every side branch (no orphaned branches from multi-level nesting)", () => {
    const links = buildBranchLinks(graph);
    for (const branch of graph.branches) {
      if (branch.isMainTrunk) continue;
      const link = links.get(branch.id);
      expect(link?.parentBranchId, `${branch.id} should have a resolved parent`).not.toBeNull();
    }
  });

  it("propagates from the ostium (t=0) with a monotonically increasing arrival time along the main trunk", () => {
    const tables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get(mainTrunk.id)!;
    expect(getArrivalTimeAt(table, 0)).toBeCloseTo(0, 5);
    for (let i = 1; i < table.arrivalSeconds.length; i++) {
      expect(table.arrivalSeconds[i]).toBeGreaterThanOrEqual(table.arrivalSeconds[i - 1]);
    }
  });

  it("delays every side branch that hangs off a 90%-stenosed main trunk segment", () => {
    const objects: StenosisObject[] = [
      {
        id: "s1",
        type: "stenosis",
        vesselId: "RCA",
        branchId: mainTrunk.id,
        position: 0.15,
        length: 0.05,
        severity: 90,
        visible: true,
      },
    ];
    const withoutStenosis = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const withStenosis = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);

    for (const branch of graph.branches) {
      const links = buildBranchLinks(graph);
      const link = links.get(branch.id);
      // 狭窄区間(t=0.125〜0.175)より遠位側にある枝だけを対象にする
      const isDownstream = branch.isMainTrunk || (link?.divergenceT ?? 0) > 0.175;
      if (!isDownstream) continue;

      const tEnd = branch.points[branch.points.length - 1].t;
      const before = getArrivalTimeAt(withoutStenosis.get(branch.id), tEnd);
      const after = getArrivalTimeAt(withStenosis.get(branch.id), tEnd);
      expect(after, `${branch.id} should arrive later with a 90% stenosis upstream`).toBeGreaterThan(before);
    }
  });

  it("never lets contrast reach the RCA distal end when the trunk is 100% occluded by calcification", () => {
    const objects: CalcificationObject[] = [
      {
        id: "c1",
        type: "calcification",
        vesselId: "RCA",
        branchId: mainTrunk.id,
        position: 0.2,
        length: 0.05,
        thickness: 100,
        angleSpan: 360,
        orientation: 0,
        visible: true,
      },
    ];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const arrivalAtEnd = getArrivalTimeAt(tables.get(mainTrunk.id), 1);
    expect(arrivalAtEnd).toBeGreaterThan(1000);
  });
});
