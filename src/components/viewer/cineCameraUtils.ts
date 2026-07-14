import { useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { Box3, Sphere } from "three";
import { REALISTIC_HEART_URL } from "../models/CineAnatomyModel";

/**
 * モデル全体を包む外接球の半径。スキーマ表示のOrthographicCamera(frustumサイズ)と
 * リアルX線モードのPerspectiveCamera(距離)の両方が、モデル差し替え時にも自動追従
 * できるよう共通のフックとして切り出している。
 */
export function useModelBoundingSphereRadius(): number {
  const { scene } = useGLTF(REALISTIC_HEART_URL);
  return useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const sphere = new Sphere();
    box.getBoundingSphere(sphere);
    return sphere.radius;
  }, [scene]);
}
