import { Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";

// 心臓プレースホルダー(楕円体, 半径は HeartModel.tsx と揃えること)の表面に沿う
// おおよその制御点。解剖学的な正確さはなく、後で実メッシュ由来の中心線に
// 差し替えることを前提にした仮データ。
export const HEART_RADII = { x: 1.3, y: 1.6, z: 1.1 };

const controlPoints: Record<VesselId, Vector3[]> = {
  // RCA: 右房室溝を右側から下方へ
  RCA: [
    new Vector3(1.15, 0.75, 0.1),
    new Vector3(1.3, 0.2, 0.35),
    new Vector3(1.1, -0.5, 0.55),
    new Vector3(0.55, -1.15, 0.5),
    new Vector3(0.05, -1.45, 0.3),
  ],
  // LAD: 前室間溝を心尖に向かって
  LAD: [
    new Vector3(-0.15, 0.85, 0.95),
    new Vector3(-0.1, 0.3, 1.05),
    new Vector3(0.0, -0.4, 1.0),
    new Vector3(0.1, -1.05, 0.75),
    new Vector3(0.2, -1.5, 0.35),
  ],
  // LCX: 左房室溝を左側から後方へ
  LCX: [
    new Vector3(-1.1, 0.8, 0.05),
    new Vector3(-1.3, 0.25, -0.3),
    new Vector3(-1.15, -0.4, -0.6),
    new Vector3(-0.7, -1.0, -0.65),
    new Vector3(-0.15, -1.3, -0.5),
  ],
};

export function getVesselControlPoints(id: VesselId): Vector3[] {
  return controlPoints[id];
}
