import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import { cArmAnglesToCameraDirection, cameraDirectionToCArmAngles, deriveCalibrationBasis } from "./cArmAngles";
import type { PatientFrameCalibration } from "../types/cArmCalibration";

// テスト用キャリブレーション: 頭側=+Y, 正面(AP)=+Z(単純な直交系にして手計算しやすくする)
const calibration: PatientFrameCalibration = {
  headAxis: [0, 1, 0],
  apAxis: [0, 0, 1],
};

function expectAngles(direction: Vector3, expectedRaoLao: number, expectedCraCaud: number) {
  const angles = cameraDirectionToCArmAngles(direction, calibration);
  expect(angles.raoLao).toBeCloseTo(expectedRaoLao, 5);
  expect(angles.craCaud).toBeCloseTo(expectedCraCaud, 5);
}

describe("deriveCalibrationBasis", () => {
  it("returns an orthonormal right-handed basis (right = ap × head)", () => {
    const { right, ap, head } = deriveCalibrationBasis(calibration);
    expect(head.length()).toBeCloseTo(1, 6);
    expect(ap.length()).toBeCloseTo(1, 6);
    expect(right.length()).toBeCloseTo(1, 6);
    expect(ap.dot(head)).toBeCloseTo(0, 6);
    expect(right.dot(head)).toBeCloseTo(0, 6);
    expect(new Vector3().crossVectors(ap, head).equals(right)).toBe(true);
  });

  it("keeps apAxis exactly as given (unadjusted) when headAxis is not perpendicular to it", () => {
    // 「この視点をAP正面として設定」ボタンは押した瞬間のカメラ方向をそのまま
    // apAxisとして保存するだけなので、headAxisと直交していなくてもapAxis自体は
    // 一切動かず、その視点でraoLao=0・craCaud=0になる必要がある(head側が補正される)。
    const nonOrthogonal: PatientFrameCalibration = { headAxis: [0.3, 1, 0.2], apAxis: [4, 2.5, 5] };
    const { ap } = deriveCalibrationBasis(nonOrthogonal);
    const expectedAp = new Vector3(4, 2.5, 5).normalize();
    expect(ap.x).toBeCloseTo(expectedAp.x, 6);
    expect(ap.y).toBeCloseTo(expectedAp.y, 6);
    expect(ap.z).toBeCloseTo(expectedAp.z, 6);

    const angles = cameraDirectionToCArmAngles(new Vector3(4, 2.5, 5), nonOrthogonal);
    expect(angles.raoLao).toBeCloseTo(0, 5);
    expect(angles.craCaud).toBeCloseTo(0, 5);
  });
});

describe("cameraDirectionToCArmAngles", () => {
  it("AP正面: raoLao=0, craCaud=0", () => {
    expectAngles(new Vector3(0, 0, 1), 0, 0);
  });

  it("RAO30 (headAxis, apAxisの平面内で30度): raoLao=30, craCaud=0", () => {
    const rad = (30 * Math.PI) / 180;
    // right = normalize(cross(ap=(0,0,1), head=(0,1,0))) = (-1,0,0)
    // V = sin(30)*right + cos(30)*ap
    const v = new Vector3(-Math.sin(rad), 0, Math.cos(rad));
    expectAngles(v, 30, 0);
  });

  it("CRA30 (頭側に30度): raoLao=0, craCaud=30", () => {
    const rad = (30 * Math.PI) / 180;
    const v = new Vector3(0, Math.sin(rad), Math.cos(rad));
    expectAngles(v, 0, 30);
  });

  it("LAO45: raoLao=-45", () => {
    const rad = (45 * Math.PI) / 180;
    const v = new Vector3(Math.sin(rad), 0, Math.cos(rad));
    expectAngles(v, -45, 0);
  });

  it("CAUD20: craCaud=-20", () => {
    const rad = (20 * Math.PI) / 180;
    const v = new Vector3(0, -Math.sin(rad), Math.cos(rad));
    expectAngles(v, 0, -20);
  });

  it("真横(RAO90): raoLao=90, craCaud=0", () => {
    expectAngles(new Vector3(-1, 0, 0), 90, 0);
  });

  it("真上(CRA90): craCaud=90", () => {
    expectAngles(new Vector3(0, 1, 0), 0, 90);
  });
});

describe("cArmAnglesToCameraDirection (forward/inverse round-trip)", () => {
  const cases: Array<{ raoLao: number; craCaud: number }> = [
    { raoLao: 0, craCaud: 0 },
    { raoLao: 30, craCaud: 0 },
    { raoLao: -45, craCaud: 20 },
    { raoLao: 30, craCaud: -25 },
    { raoLao: -30, craCaud: -30 },
  ];

  for (const { raoLao, craCaud } of cases) {
    it(`roundtrips raoLao=${raoLao}, craCaud=${craCaud}`, () => {
      const direction = cArmAnglesToCameraDirection({ raoLao, craCaud }, calibration);
      const angles = cameraDirectionToCArmAngles(direction, calibration);
      expect(angles.raoLao).toBeCloseTo(raoLao, 5);
      expect(angles.craCaud).toBeCloseTo(craCaud, 5);
    });
  }
});
