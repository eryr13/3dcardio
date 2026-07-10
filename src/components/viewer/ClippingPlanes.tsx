import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Plane, Vector3 } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import type { ClippingAxis } from "../../types/anatomy";

// スライダー位置(-1〜1)をワールド座標のオフセットへ変換する係数。
// 心臓プレースホルダー(半径 x:1.3 y:1.6 z:1.1)を十分にスライスできる範囲。
const CLIP_RANGE = 2;

const AXIS_NORMALS: Record<ClippingAxis, Vector3> = {
  x: new Vector3(-1, 0, 0),
  y: new Vector3(0, -1, 0),
  z: new Vector3(0, 0, -1),
};

/**
 * store のクリッピング状態から THREE.Plane を組み立て、renderer のグローバル
 * clippingPlanes に反映するだけのヘッドレスコンポーネント。
 */
export function ClippingPlanes() {
  const { gl } = useThree();
  const clipping = useCardioStore((s) => s.clipping);

  const planes = useMemo(() => {
    return (Object.keys(AXIS_NORMALS) as ClippingAxis[])
      .filter((axis) => clipping[axis].enabled)
      .map((axis) => new Plane(AXIS_NORMALS[axis].clone(), clipping[axis].position * CLIP_RANGE));
  }, [clipping]);

  useEffect(() => {
    gl.localClippingEnabled = true;
    gl.clippingPlanes = planes;
  }, [gl, planes]);

  useEffect(
    () => () => {
      gl.clippingPlanes = [];
    },
    [gl],
  );

  return null;
}
