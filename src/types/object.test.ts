import { describe, expect, it } from "vitest";
import {
  getObjectsForVessel,
  getMaxStenosisSeverity,
  getStenosisSeverityAt,
} from "./object";
import type { CalcificationObject, CardioObject, StenosisObject, StentObject } from "./object";

function stenosis(overrides: Partial<StenosisObject> = {}): StenosisObject {
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

function calcification(overrides: Partial<CalcificationObject> = {}): CalcificationObject {
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

function stent(overrides: Partial<StentObject> = {}): StentObject {
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

describe("getObjectsForVessel", () => {
  it("filters objects by vesselId only", () => {
    const objects: CardioObject[] = [
      stenosis({ id: "a", vesselId: "RCA" }),
      calcification({ id: "b", vesselId: "LAD" }),
      stent({ id: "c", vesselId: "RCA" }),
    ];
    const result = getObjectsForVessel(objects, "RCA");
    expect(result.map((o) => o.id)).toEqual(["a", "c"]);
  });

  it("returns an empty array when no objects match", () => {
    expect(getObjectsForVessel([stenosis({ vesselId: "LAD" })], "RCA")).toEqual([]);
  });
});

describe("getStenosisSeverityAt", () => {
  it("returns 0 when no stenosis covers the given t", () => {
    const objects: CardioObject[] = [stenosis({ position: 0.5, length: 0.1, severity: 80 })];
    // 0.5 ± 0.05 の範囲外
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.9)).toBe(0);
  });

  it("returns the severity when t falls within [position - length/2, position + length/2]", () => {
    const objects: CardioObject[] = [stenosis({ position: 0.5, length: 0.2, severity: 65 })];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(65);
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.41)).toBe(65);
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.59)).toBe(65);
  });

  it("returns the maximum severity when multiple stenoses overlap the same t", () => {
    const objects: CardioObject[] = [
      stenosis({ id: "a", position: 0.5, length: 0.4, severity: 40 }),
      stenosis({ id: "b", position: 0.5, length: 0.4, severity: 90 }),
    ];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(90);
  });

  it("ignores objects on other vessels", () => {
    const objects: CardioObject[] = [stenosis({ vesselId: "LAD", position: 0.5, length: 0.4, severity: 90 })];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(0);
  });

  it("ignores non-stenosis objects", () => {
    const objects: CardioObject[] = [
      calcification({ position: 0.5, length: 0.4, severity: 90 }),
      stent({ position: 0.5, length: 0.4 }),
    ];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(0);
  });

  it("ignores objects with visible=false", () => {
    const objects: CardioObject[] = [stenosis({ position: 0.5, length: 0.4, severity: 90, visible: false })];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(0);
  });
});

describe("getMaxStenosisSeverity", () => {
  it("returns 0 when the vessel has no stenosis objects", () => {
    expect(getMaxStenosisSeverity([calcification()], "RCA")).toBe(0);
  });

  it("returns the highest severity among all stenoses on the vessel regardless of position", () => {
    const objects: CardioObject[] = [
      stenosis({ id: "a", position: 0.1, severity: 30 }),
      stenosis({ id: "b", position: 0.9, severity: 85 }),
    ];
    expect(getMaxStenosisSeverity(objects, "RCA")).toBe(85);
  });

  it("ignores invisible stenoses and objects on other vessels", () => {
    const objects: CardioObject[] = [
      stenosis({ id: "a", vesselId: "RCA", severity: 95, visible: false }),
      stenosis({ id: "b", vesselId: "LAD", severity: 99 }),
      stenosis({ id: "c", vesselId: "RCA", severity: 40 }),
    ];
    expect(getMaxStenosisSeverity(objects, "RCA")).toBe(40);
  });
});
