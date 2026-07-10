import { useMemo } from "react";
import { CatmullRomCurve3, TubeGeometry } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId } from "../../types/anatomy";
import { getVesselControlPoints } from "./vesselPaths";

interface VesselModelProps {
  id: VesselId;
  /** チューブの太さ。将来セグメントごとに変えられるよう props で受ける */
  radius?: number;
}

/**
 * 血管1本分のプレースホルダーメッシュ(チューブ)。
 * 表示/非表示・色・不透明度は zustand store から取得し、
 * 将来セグメント分割する場合もこのコンポーネントを繰り返し使う想定。
 */
export function VesselModel({ id, radius = 0.09 }: VesselModelProps) {
  const vessel = useCardioStore((s) => s.vessels[id]);

  const geometry = useMemo(() => {
    const curve = new CatmullRomCurve3(getVesselControlPoints(id), false, "catmullrom", 0.2);
    return new TubeGeometry(curve, 64, radius, 12, false);
  }, [id, radius]);

  if (!vessel.visible) return null;

  return (
    <mesh
      name={id}
      userData={{ anatomyId: id }}
      geometry={geometry}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial
        color={vessel.color}
        transparent={vessel.opacity < 1}
        opacity={vessel.opacity}
        roughness={0.4}
        metalness={0.1}
      />
    </mesh>
  );
}
