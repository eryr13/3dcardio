import { describe, expect, it } from "vitest";
import {
  getObjectsForVessel,
  getMaxStenosisSeverity,
  getStenosisSeverityAt,
  lesionTaperProfile,
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
    thickness: 40,
    angleSpan: 120,
    orientation: 0,
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

  it("returns the full severity within the central 80% plateau", () => {
    const objects: CardioObject[] = [stenosis({ position: 0.5, length: 0.2, severity: 65 })];
    // plateau spans position ± 0.8*half = 0.5 ± 0.08
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(65);
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.43)).toBeCloseTo(65);
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.57)).toBeCloseTo(65);
  });

  it("tapers smoothly through the entrance/exit 10% instead of stepping abruptly", () => {
    const objects: CardioObject[] = [stenosis({ position: 0.5, length: 0.2, severity: 80 })];
    // The object's edges (t = position ± half) match the vessel exactly: no stenosis effect.
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.4)).toBeCloseTo(0);
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.6)).toBeCloseTo(0);
    // Partway through the entrance/exit taper, severity sits strictly between 0 and full.
    const midEntranceTaper = getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.41);
    expect(midEntranceTaper).toBeGreaterThan(0);
    expect(midEntranceTaper).toBeLessThan(80);
    const midExitTaper = getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.59);
    expect(midExitTaper).toBeGreaterThan(0);
    expect(midExitTaper).toBeLessThan(80);
    // Symmetric around the center.
    expect(midExitTaper).toBeCloseTo(midEntranceTaper);
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
      calcification({ position: 0.5, length: 0.4 }),
      stent({ position: 0.5, length: 0.4 }),
    ];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(0);
  });

  it("ignores objects with visible=false", () => {
    const objects: CardioObject[] = [stenosis({ position: 0.5, length: 0.4, severity: 90, visible: false })];
    expect(getStenosisSeverityAt(objects, "RCA", "RCA-main", 0.5)).toBe(0);
  });
});

describe("lesionTaperProfile", () => {
  it("is exactly 0 at and beyond the object's edges (s = ±1)", () => {
    expect(lesionTaperProfile(1)).toBe(0);
    expect(lesionTaperProfile(-1)).toBe(0);
    expect(lesionTaperProfile(1.5)).toBe(0);
    expect(lesionTaperProfile(-2)).toBe(0);
  });

  it("is exactly 1 across the central 80% plateau (|s| <= 0.8)", () => {
    expect(lesionTaperProfile(0)).toBe(1);
    expect(lesionTaperProfile(0.8)).toBe(1);
    expect(lesionTaperProfile(-0.8)).toBe(1);
  });

  it("is monotonic and strictly between 0 and 1 within the taper (0.8 < |s| < 1)", () => {
    const a = lesionTaperProfile(0.85);
    const b = lesionTaperProfile(0.9);
    const c = lesionTaperProfile(0.95);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  it("is symmetric around s=0", () => {
    expect(lesionTaperProfile(0.9)).toBeCloseTo(lesionTaperProfile(-0.9));
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
