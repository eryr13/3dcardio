import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  DEFAULT_CONTRAST_FLOW_PARAMS,
  buildBranchLinks,
  computeArrivalTables,
  getArrivalTimeAt,
  getCalcificationRadiusFractionAt,
  getCeilingAt,
  getConcentrationAt,
  getFrontPositionAtTime,
  getLumenRadiusFractionAt,
  passThroughCoefficient,
} from "./contrastFlow";
import type { CalcificationObject, CardioObject, StenosisObject } from "../types/object";
import type { CenterlineBranch, VesselGraph } from "../components/models/vesselGraph";
import type { CenterlinePoint } from "../components/models/vesselCenterline";

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

function calcification(overrides: Partial<CalcificationObject> = {}): CalcificationObject {
  return {
    id: "c1",
    type: "calcification",
    vesselId: "RCA",
    branchId: "RCA-main",
    position: 0.5,
    length: 0.2,
    thickness: 40,
    angleSpan: 120,
    orientation: 0,
    visible: true,
    ...overrides,
  };
}

function straightBranchPoints(length: number, count = 21): CenterlinePoint[] {
  const points: CenterlinePoint[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push({ position: new Vector3(0, t * length, 0), radius: 0.003, t });
  }
  return points;
}

/** 本幹1本、その中間点(t=0.5)から分岐する側枝1本、さらにその側枝から分岐する孫枝1本を持つ簡易グラフ。 */
function buildTestGraph(): VesselGraph {
  const mainPoints = straightBranchPoints(0.1);
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
    points: mainPoints,
  };
  const sidePoints = straightBranchPoints(0.05);
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
    points: sidePoints,
  };
  const grandchildPoints = straightBranchPoints(0.02);
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
    points: grandchildPoints,
  };

  return {
    rootNodeId: "n0",
    nodes: [],
    edges: [],
    branches: [mainTrunk, side, grandchild],
  };
}

describe("getCalcificationRadiusFractionAt / getLumenRadiusFractionAt", () => {
  it("returns 1 (no narrowing) when nothing covers t", () => {
    expect(getCalcificationRadiusFractionAt([], "RCA", "RCA-main", 0.5)).toBe(1);
    expect(getLumenRadiusFractionAt([], "RCA", "RCA-main", 0.5)).toBe(1);
  });

  it("weights calcification radius reduction by angleSpan coverage", () => {
    const objects: CardioObject[] = [calcification({ thickness: 50, angleSpan: 180 })];
    // 1 - 0.5 * (180/360) = 0.75
    expect(getCalcificationRadiusFractionAt(objects, "RCA", "RCA-main", 0.5)).toBeCloseTo(0.75);
  });

  it("takes the stricter (smaller) of stenosis and calcification radius fractions", () => {
    const objects: CardioObject[] = [
      stenosis({ severity: 30 }), // radiusFraction 0.7
      calcification({ thickness: 80, angleSpan: 360 }), // radiusFraction 0.2
    ];
    expect(getLumenRadiusFractionAt(objects, "RCA", "RCA-main", 0.5)).toBeCloseTo(0.2);
  });

  it("reaches exactly 0 (full occlusion) at thickness=100, angleSpan=360", () => {
    const objects: CardioObject[] = [calcification({ thickness: 100, angleSpan: 360 })];
    expect(getLumenRadiusFractionAt(objects, "RCA", "RCA-main", 0.5)).toBe(0);
  });
});

describe("buildBranchLinks", () => {
  it("derives multi-level parent/divergence relationships via BFS", () => {
    const graph = buildTestGraph();
    const links = buildBranchLinks(graph);

    expect(links.get("RCA-main")).toEqual({ branchId: "RCA-main", parentBranchId: null, divergenceT: null });
    expect(links.get("RCA-side1")).toEqual({ branchId: "RCA-side1", parentBranchId: "RCA-main", divergenceT: 0.5 });
    // grandchild's parent is the side branch (not the main trunk directly)
    expect(links.get("RCA-side2")).toEqual({ branchId: "RCA-side2", parentBranchId: "RCA-side1", divergenceT: 0.5 });
  });
});

describe("computeArrivalTables", () => {
  it("produces a monotonically increasing arrival time along an unobstructed branch", () => {
    const graph = buildTestGraph();
    const tables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const mainTable = tables.get("RCA-main")!;
    for (let i = 1; i < mainTable.arrivalSeconds.length; i++) {
      expect(mainTable.arrivalSeconds[i]).toBeGreaterThan(mainTable.arrivalSeconds[i - 1]);
    }
    expect(getArrivalTimeAt(mainTable, 0)).toBeCloseTo(0);
  });

  it("starts a side branch's arrival clock from its parent's arrival time at the divergence point", () => {
    const graph = buildTestGraph();
    const tables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const mainTable = tables.get("RCA-main")!;
    const sideTable = tables.get("RCA-side1")!;
    const divergenceArrival = getArrivalTimeAt(mainTable, 0.5);
    expect(getArrivalTimeAt(sideTable, 0)).toBeCloseTo(divergenceArrival);
  });

  it("does not delay the propagation front at all, even through a high-grade stenosis (front speed is constant)", () => {
    // Model: the front always advances at a constant baseSpeed, regardless of any
    // stenosis/calcification along the way — narrowing is expressed purely as a lower
    // ceiling (max reachable concentration) downstream, never as a slower front. This is
    // what keeps propagation from ever looking like it "stalls" at a narrowing.
    const graph = buildTestGraph();
    const objects: CardioObject[] = [stenosis({ vesselId: "RCA", branchId: "RCA-main", position: 0.5, length: 0.2, severity: 90 })];
    const withoutStenosis = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const withStenosis = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const arrivalAtEndWithout = getArrivalTimeAt(withoutStenosis.get("RCA-main"), 1);
    const arrivalAtEndWith = getArrivalTimeAt(withStenosis.get("RCA-main"), 1);
    expect(arrivalAtEndWith).toBeCloseTo(arrivalAtEndWithout, 5);
  });

  it("still reaches a 100% occlusion's downstream territory at the normal, undelayed arrival time", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [
      calcification({ vesselId: "RCA", branchId: "RCA-main", position: 0.5, length: 0.2, thickness: 100, angleSpan: 360 }),
    ];
    const healthy = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    // The front itself still reaches t=1 right on schedule — it's the ceiling (tested
    // separately below) that blocks any visible concentration from ever appearing there.
    expect(getArrivalTimeAt(tables.get("RCA-main"), 1)).toBeCloseTo(getArrivalTimeAt(healthy.get("RCA-main"), 1), 5);
  });
});

describe("getConcentrationAt / getFrontPositionAtTime", () => {
  it("is 0 before arrival, rises to 1, plateaus, then decays back toward 0", () => {
    const table = { ts: [0, 1], arrivalSeconds: [0, 1], ceilings: [1, 1] };
    const params = { baseSpeed: 1, riseTime: 0.2, plateauDuration: 0.5, decayTimeConstant: 0.3 };

    expect(getConcentrationAt(table, 0, -1, params)).toBe(0);
    expect(getConcentrationAt(table, 0, 0.1, params)).toBeCloseTo(0.5, 1);
    expect(getConcentrationAt(table, 0, 0.2, params)).toBeCloseTo(1);
    expect(getConcentrationAt(table, 0, 0.6, params)).toBeCloseTo(1);
    const decayed = getConcentrationAt(table, 0, 5, params);
    expect(decayed).toBeGreaterThan(0);
    expect(decayed).toBeLessThan(0.01);
  });

  it("caps the plateau at the ceiling instead of 1 when downstream of a flow-limiting lesion", () => {
    const table = { ts: [0, 1], arrivalSeconds: [0, 1], ceilings: [1, 0.4] };
    const params = { baseSpeed: 1, riseTime: 0.2, plateauDuration: 0.5, decayTimeConstant: 0.3 };

    expect(getConcentrationAt(table, 1, 1.3, params)).toBeCloseTo(0.4);
  });

  it("reports the current front position as the furthest t whose arrival time has passed", () => {
    const table = { ts: [0, 0.5, 1], arrivalSeconds: [0, 1, 2], ceilings: [1, 1, 1] };
    expect(getFrontPositionAtTime(table, -1)).toBe(0);
    expect(getFrontPositionAtTime(table, 0.5)).toBe(0);
    expect(getFrontPositionAtTime(table, 1.5)).toBe(0.5);
    expect(getFrontPositionAtTime(table, 3)).toBe(1);
  });
});

describe("passThroughCoefficient", () => {
  it("is 1.0 with no stenosis and exactly 0 at full occlusion", () => {
    expect(passThroughCoefficient(1)).toBe(1);
    expect(passThroughCoefficient(0)).toBe(0);
  });

  it("barely reduces flow for mild-to-moderate stenosis but drops sharply for severe stenosis", () => {
    const mild = passThroughCoefficient(1 - 0.5); // 50% stenosis
    const severe = passThroughCoefficient(1 - 0.9); // 90% stenosis
    expect(mild).toBeGreaterThan(0.95);
    expect(severe).toBeLessThan(0.3);
    expect(severe).toBeLessThan(mild);
  });
});

describe("flow-limiting ceiling (peripheral fill fraction, not just delay)", () => {
  it("keeps the ceiling near 1 downstream of a moderate (50%) stenosis", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [stenosis({ severity: 50, position: 0.5, length: 0.2 })];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const ceilingAtEnd = getCeilingAt(tables.get("RCA-main"), 1);
    expect(ceilingAtEnd).toBeGreaterThan(0.9);
  });

  it("clearly lowers the ceiling downstream of a severe (90%) stenosis", () => {
    const graph = buildTestGraph();
    const healthy = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const objects: CardioObject[] = [stenosis({ severity: 90, position: 0.5, length: 0.2 })];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const ceilingAtEnd = getCeilingAt(tables.get("RCA-main"), 1);
    expect(ceilingAtEnd).toBeLessThan(getCeilingAt(healthy.get("RCA-main"), 1));
    expect(ceilingAtEnd).toBeLessThan(0.3);
  });

  it("drives the plateau concentration to ~0 downstream of a 100% occlusion, not just delayed arrival", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [
      calcification({ position: 0.5, length: 0.2, thickness: 100, angleSpan: 360 }),
    ];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main");
    // Even at an implausibly distant elapsed time, the peripheral point never fills.
    expect(getConcentrationAt(table, 1, 1e6, DEFAULT_CONTRAST_FLOW_PARAMS)).toBe(0);
  });

  it("multiplies ceilings for two stenoses in series along the same branch", () => {
    const graph = buildTestGraph();
    const single: CardioObject[] = [stenosis({ severity: 80, position: 0.2, length: 0.05 })];
    const series: CardioObject[] = [
      stenosis({ id: "s1", severity: 80, position: 0.2, length: 0.05 }),
      stenosis({ id: "s2", severity: 80, position: 0.6, length: 0.05 }),
    ];
    const singleTables = computeArrivalTables(graph, single, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const seriesTables = computeArrivalTables(graph, series, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const singleCeiling = getCeilingAt(singleTables.get("RCA-main"), 1);
    const seriesCeiling = getCeilingAt(seriesTables.get("RCA-main"), 1);
    expect(seriesCeiling).toBeCloseTo(singleCeiling * singleCeiling, 3);
  });

  it("reaches its final (worst) value once the entrance taper meets the plateau, not at the lesion's far exit", () => {
    const graph = buildTestGraph();
    // length=0.8 keeps each 10% taper zone (0.08 wide) comfortably larger than the test
    // graph's 0.05 sample spacing, so real branch sample points fall inside the taper.
    const objects: CardioObject[] = [stenosis({ severity: 90, position: 0.5, length: 0.8 })];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main");
    const ceilingEarlyInEntranceTaper = getCeilingAt(table, 0.15); // still tapering in (s≈-0.875)
    const ceilingAtPlateauStart = getCeilingAt(table, 0.2); // just past the entrance taper (s=-0.75)
    const ceilingFarDownstream = getCeilingAt(table, 1); // past the entire lesion, including exit taper
    expect(ceilingAtPlateauStart).toBeLessThan(ceilingEarlyInEntranceTaper);
    expect(ceilingAtPlateauStart).toBeCloseTo(ceilingFarDownstream, 5);
  });

  it("propagates a main-trunk stenosis's ceiling reduction into side branches", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [stenosis({ severity: 90, position: 0.2, length: 0.05 })];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const sideCeiling = getCeilingAt(tables.get("RCA-side1"), 1);
    expect(sideCeiling).toBeLessThan(0.3);
  });
});

describe("propagation front speed is constant regardless of stenosis (continuous flow, never stalls)", () => {
  // Regression coverage for the model shift away from "front slows down at a narrowing"
  // (which always looked like the front stalling/jamming at the stenosis, however the
  // slowdown curve was tuned) toward "front always advances at a constant speed; a
  // narrowing only lowers the maximum concentration reachable downstream of it". Any
  // remaining dependence of arrivalSeconds on lesion severity would reintroduce the
  // stall — these tests pin arrival time to be identical to a healthy vessel across the
  // full severity range, with only the ceiling (tested separately above) varying.
  it("keeps arrival time identical to healthy across mild, severe, and complete-occlusion severities", () => {
    const graph = buildTestGraph();
    const healthyTables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const healthyArrival = getArrivalTimeAt(healthyTables.get("RCA-main"), 1);

    for (const severity of [10, 50, 90, 99]) {
      const objects: CardioObject[] = [stenosis({ severity, position: 0.5, length: 0.1 })];
      const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
      expect(getArrivalTimeAt(tables.get("RCA-main"), 1), `severity=${severity}`).toBeCloseTo(healthyArrival, 5);
    }

    const occludedObjects: CardioObject[] = [calcification({ position: 0.5, length: 0.1, thickness: 100, angleSpan: 360 })];
    const occludedTables = computeArrivalTables(graph, occludedObjects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    expect(getArrivalTimeAt(occludedTables.get("RCA-main"), 1)).toBeCloseTo(healthyArrival, 5);
  });

  it("starts the downstream concentration rising at the same time as a healthy vessel, just capped lower", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [stenosis({ severity: 90, position: 0.5, length: 0.1 })];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main");
    const healthyTables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const healthyTable = healthyTables.get("RCA-main");
    const tDownstream = 0.6; // clearly past the lesion (span [0.45, 0.55])

    const arrival = getArrivalTimeAt(table, tDownstream);
    const healthyArrival = getArrivalTimeAt(healthyTable, tDownstream);
    expect(arrival).toBeCloseTo(healthyArrival, 5);

    // Right as the front arrives, concentration starts rising immediately (no stall) —
    // toward the lesion's lower ceiling rather than 1.
    const justAfterArrival = getConcentrationAt(table, tDownstream, arrival + 0.05, DEFAULT_CONTRAST_FLOW_PARAMS);
    expect(justAfterArrival).toBeGreaterThan(0);
    const ceiling = getCeilingAt(table, tDownstream);
    expect(ceiling).toBeLessThan(0.3);
  });

  it("leaves no gap where neither the upstream nor the downstream side of a stenosis has any contrast", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [stenosis({ severity: 90, position: 0.5, length: 0.1 })];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main");
    const tUpstream = 0.4; // clearly before the lesion (span [0.45, 0.55])
    const tDownstream = 0.6; // clearly after it

    // Find the last moment upstream still shows any contrast, and the first moment
    // downstream begins to. With a constant front speed these should now overlap or sit
    // right next to each other, never separated by a long stretch of total blankness.
    const step = 0.1;
    let lastUpstreamVisible = -1;
    let firstDownstreamVisible = -1;
    for (let elapsed = 0; elapsed <= 10; elapsed += step) {
      const up = getConcentrationAt(table, tUpstream, elapsed, DEFAULT_CONTRAST_FLOW_PARAMS);
      const down = getConcentrationAt(table, tDownstream, elapsed, DEFAULT_CONTRAST_FLOW_PARAMS);
      if (up > 0.01) lastUpstreamVisible = elapsed;
      if (down > 0.01 && firstDownstreamVisible < 0) firstDownstreamVisible = elapsed;
    }
    expect(lastUpstreamVisible).toBeGreaterThan(0);
    expect(firstDownstreamVisible).toBeGreaterThan(0);
    expect(firstDownstreamVisible - lastUpstreamVisible).toBeLessThan(0.5);
  });

  it("still makes a true 100% occlusion's downstream concentration stay at 0 forever, despite the front arriving normally", () => {
    const graph = buildTestGraph();
    const objects: CardioObject[] = [
      calcification({ position: 0.5, length: 0.1, thickness: 100, angleSpan: 360 }),
    ];
    const tables = computeArrivalTables(graph, objects, "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    const table = tables.get("RCA-main");
    // The front reaches t=1 at the normal, undelayed time...
    const healthyTables = computeArrivalTables(graph, [], "RCA", DEFAULT_CONTRAST_FLOW_PARAMS);
    expect(getArrivalTimeAt(table, 1)).toBeCloseTo(getArrivalTimeAt(healthyTables.get("RCA-main"), 1), 5);
    // ...but concentration there never rises, at any elapsed time, because the ceiling is 0.
    expect(getConcentrationAt(table, 1, 1e6, DEFAULT_CONTRAST_FLOW_PARAMS)).toBe(0);
  });
});
