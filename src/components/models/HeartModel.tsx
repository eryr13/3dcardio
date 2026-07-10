import { useMemo } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import { HEART_RADII } from "./vesselPaths";

/**
 * 心臓のプレースホルダーメッシュ。楕円体スケールした球ジオメトリで代用。
 * 将来 DICOM 由来の実メッシュに差し替える際は ModelLoader 側の分岐を
 * 変更するだけでよく、このコンポーネントの props 契約は変えない想定。
 */
export function HeartModel() {
  const heart = useCardioStore((s) => s.heart);

  const geometryArgs = useMemo<[number, number, number]>(() => [1, 48, 32], []);

  if (!heart.visible) return null;

  return (
    <mesh
      name="HEART"
      userData={{ anatomyId: "HEART" }}
      scale={[HEART_RADII.x, HEART_RADII.y, HEART_RADII.z]}
      castShadow
      receiveShadow
    >
      <sphereGeometry args={geometryArgs} />
      <meshStandardMaterial
        color={heart.color}
        transparent={heart.opacity < 1}
        opacity={heart.opacity}
        roughness={0.6}
        metalness={0.05}
      />
    </mesh>
  );
}
