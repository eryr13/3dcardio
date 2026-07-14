import { describe, expect, it } from "vitest";
import {
  getLesionsForVessel,
  getMaxStenosisSeverity,
  getStenosisSeverityAt,
} from "./lesion";
import type { CalcificationLesion, Lesion, StenosisLesion, StentLesion } from "./lesion";

function stenosis(overrides: Partial<StenosisLesion> = {}): StenosisLesion {
  return {
    id: "s1",
    type: "stenosis",
    vesselId: "RCA",
    branchId: "RCA-main",
    position: 0.5,
    length: 0.1,
    severity: 70,
    visible: true,
    ...overrides,
  };
}

function calcification(overrides: Partial<CalcificationLesion> = {}): CalcificationLesion {
  return {
    id: "c1",
    type: "calcification",
    vesselId: "RCA",
    branchId: "RCA-main",
    position: 0.5,
    length: 0.1,
    severity: 50,
    visible: true,
    ...overrides,
  };
}

function stent(overrides: Partial<StentLesion> = {}): StentLesion {
  return {
    id: "st1",
    type: "stent",
    vesselId: "RCA",
    branchId: "RCA-main",
    position: 0.5,
    length: 0.1,
    diameter: 3,
    visible: true,
    ...overrides,
  };
}

describe("getLesionsForVessel", () => {
  it("filters lesions by vesselId only", () => {
    const lesions: Lesion[] = [
      stenosis({ id: "a", vesselId: "RCA" }),
      calcification({ id: "b", vesselId: "LAD" }),
      stent({ id: "c", vesselId: "RCA" }),
    ];
    const result = getLesionsForVessel(lesions, "RCA");
    expect(result.map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array when no lesions match", () => {
    expect(getLesionsForVessel([stenosis({ vesselId: "LAD" })], "RCA")).toEqual([]);
  });
});

describe("getStenosisSeverityAt", () => {
  it("returns 0 when no stenosis covers the given t", () => {
    const lesions: Lesion[] = [stenosis({ position: 0.5, length: 0.1, severity: 80 })];
    // 0.5 ± 0.05 の範囲外
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.9)).toBe(0);
  });

  it("returns the severity when t falls within [position - length/2, position + length/2]", () => {
    const lesions: Lesion[] = [stenosis({ position: 0.5, length: 0.2, severity: 65 })];
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.5)).toBe(65);
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.41)).toBe(65);
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.59)).toBe(65);
  });

  it("returns the maximum severity when multiple stenoses overlap the same t", () => {
    const lesions: Lesion[] = [
      stenosis({ id: "a", position: 0.5, length: 0.4, severity: 40 }),
      stenosis({ id: "b", position: 0.5, length: 0.4, severity: 90 }),
    ];
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.5)).toBe(90);
  });

  it("ignores lesions on other vessels", () => {
    const lesions: Lesion[] = [stenosis({ vesselId: "LAD", position: 0.5, length: 0.4, severity: 90 })];
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.5)).toBe(0);
  });

  it("ignores non-stenosis lesions", () => {
    const lesions: Lesion[] = [
      calcification({ position: 0.5, length: 0.4, severity: 90 }),
      stent({ position: 0.5, length: 0.4 }),
    ];
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.5)).toBe(0);
  });

  it("ignores lesions with visible=false", () => {
    const lesions: Lesion[] = [stenosis({ position: 0.5, length: 0.4, severity: 90, visible: false })];
    expect(getStenosisSeverityAt(lesions, "RCA", "RCA-main", 0.5)).toBe(0);
  });
});

describe("getMaxStenosisSeverity", () => {
  it("returns 0 when the vessel has no stenosis lesions", () => {
    expect(getMaxStenosisSeverity([calcification()], "RCA")).toBe(0);
  });

  it("returns the highest severity among all stenoses on the vessel regardless of position", () => {
    const lesions: Lesion[] = [
      stenosis({ id: "a", position: 0.1, severity: 30 }),
      stenosis({ id: "b", position: 0.9, severity: 85 }),
    ];
    expect(getMaxStenosisSeverity(lesions, "RCA")).toBe(85);
  });

  it("ignores invisible stenoses and lesions on other vessels", () => {
    const lesions: Lesion[] = [
      stenosis({ id: "a", vesselId: "RCA", severity: 95, visible: false }),
      stenosis({ id: "b", vesselId: "LAD", severity: 99 }),
      stenosis({ id: "c", vesselId: "RCA", severity: 40 }),
    ];
    expect(getMaxStenosisSeverity(lesions, "RCA")).toBe(40);
  });
});
