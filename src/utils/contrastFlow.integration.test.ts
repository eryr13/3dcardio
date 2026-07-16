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
  getCeilingAt,
  getConcentrationAt,
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

  it("leaves every side branch's arrival time unchanged by a 90%-stenosed main trunk segment, but lowers its ceiling", () => {
    // Model: the front's arrival timing never depends on upstream lesions — only the
    // ceiling (max reachable concentration) does. A branch hanging off a severely
    // stenosed trunk segment should arrive right on schedule, just dimmer.
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
    const links = buildBranchLinks(graph);

    // link.divergenceTは「この枝の直接の親からの分岐位置」であり、孫枝以降では
    // 本幹上の位置ではなく中間の枝上の位置になる。本幹の狭窄区間(t=0.125〜0.175)より
    // 遠位側かどうかを正しく判定するには、本幹の直接の子である祖先までさかのぼり、
    // その祖先が本幹上のどこで分岐したかを見る必要がある(祖先が狭窄より遠位で分岐して
    // いれば、そこからぶら下がる孫枝以降も必ず遠位側になる)。
    function divergesFromMainTrunkAt(branch: (typeof graph.branches)[number]): number | null {
      let current = branch;
      while (true) {
        const link = links.get(current.id);
        if (!link?.parentBranchId) return null; // 本幹自身、または孤立枝
        if (link.parentBranchId === mainTrunk.id) return link.divergenceT;
        const parent = graph.branches.find((b) => b.id === link.parentBranchId);
        if (!parent) return null;
        current = parent;
      }
    }

    for (const branch of graph.branches) {
      const divergenceOnMainTrunk = divergesFromMainTrunkAt(branch);
      // 狭窄区間(t=0.125〜0.175)より遠位側にある枝だけを対象にする
      const isDownstream = branch.isMainTrunk || (divergenceOnMainTrunk ?? 0) > 0.175;
      if (!isDownstream) continue;

      const tEnd = branch.points[branch.points.length - 1].t;
      const before = getArrivalTimeAt(withoutStenosis.get(branch.id), tEnd);
      const after = getArrivalTimeAt(withStenosis.get(branch.id), tEnd);
      expect(after, `${branch.id} should arrive at the same time regardless of the upstream stenosis`).toBeCloseTo(before, 5);

      const ceiling = getCeilingAt(withStenosis.get(branch.id), tEnd);
      expect(ceiling, `${branch.id} should be dimmed by the upstream 90% stenosis`).toBeLessThan(0.3);
    }
  });

  it("reaches the RCA distal end at the normal arrival time even when the trunk is 100% occluded, but never shows any concentration there", () => {
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
    const healthyTables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get(mainTrunk.id);
    expect(getArrivalTimeAt(table, 1)).toBeCloseTo(getArrivalTimeAt(healthyTables.get(mainTrunk.id), 1), 5);
    expect(getConcentrationAt(table, 1, 1e6, DEFAULT_CONTRAST_FLOW_PARAMS)).toBe(0);
  });

  describe("fine resolution of a realistic (short) stenosis against the real, coarsely-sampled RCA centerline", () => {
    // The real RCA main trunk has ~40 points (~2.6% t-spacing), far coarser than a
    // typical UI stenosis's 10%-of-length taper zone (e.g. 0.8% of branch length for
    // an 8%-long lesion). Without inserting extra integration checkpoints inside the
    // taper, this single native segment straddling the whole taper+plateau got linearly
    // interpolated, which smeared the ceiling drop upstream of where the narrowing
    // actually starts — i.e. contrast appeared to dim/color past the lesion before the
    // front had genuinely fought through the constriction.
    const objects: StenosisObject[] = [
      { id: "s1", type: "stenosis", vesselId: "RCA", branchId: mainTrunk.id, position: 0.3, length: 0.08, severity: 90, visible: true },
    ];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get(mainTrunk.id)!;
    // lesion span = [0.26, 0.34]; 80% plateau = [0.268, 0.332].

    it("keeps the ceiling at its full, unrestricted value immediately upstream of the taper", () => {
      expect(getCeilingAt(table, 0.2)).toBeCloseTo(1, 3);
      expect(getCeilingAt(table, 0.26)).toBeCloseTo(1, 2);
    });

    it("keeps concentration at full strength immediately upstream of the taper once the front has passed and plateaued", () => {
      const arrivalAtEdge = getArrivalTimeAt(table, 0.26);
      const elapsedDuringPlateau = arrivalAtEdge + 1.0; // riseTime(0.15)+plateauDuration(1.0)=1.15 window
      const concentration = getConcentrationAt(table, 0.26, elapsedDuringPlateau, DEFAULT_CONTRAST_FLOW_PARAMS);
      expect(concentration).toBeCloseTo(1, 2);
    });

    it("crosses the entrance taper in exactly the same time as an equivalent healthy stretch (front speed never depends on the lesion)", () => {
      const healthyTables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
      const healthyTable = healthyTables.get(mainTrunk.id)!;
      const stenosedDelta = getArrivalTimeAt(table, 0.268) - getArrivalTimeAt(table, 0.26);
      const healthyDelta = getArrivalTimeAt(healthyTable, 0.268) - getArrivalTimeAt(healthyTable, 0.26);
      expect(stenosedDelta).toBeCloseTo(healthyDelta, 5);
    });

    it("still resolves the ceiling drop precisely at the taper (not smeared by the coarse native centerline spacing)", () => {
      const ceilingJustBeforePlateau = getCeilingAt(table, 0.267);
      const ceilingAtPlateauStart = getCeilingAt(table, 0.268);
      expect(ceilingJustBeforePlateau).toBeGreaterThan(ceilingAtPlateauStart);
      expect(ceilingAtPlateauStart).toBeLessThan(0.3);
    });
  });
});
