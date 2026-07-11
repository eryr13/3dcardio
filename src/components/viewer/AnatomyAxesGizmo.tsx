import { useMemo } from "react";
import { Line, Text } from "@react-three/drei";
import { useCardioStore } from "../../store/useCardioStore";
import { deriveCalibrationBasis } from "../../utils/cArmAngles";

const GIZMO_LENGTH = 2.2;

/**
 * メインビューに「頭側(Head)」「正面(AP)」の基準軸を小さく表示する。
 * キャリブレーション(headAxis/apAxis)が実際に正しい向きを指しているか、
 * ユーザーが視覚的に確認できるようにするためのもの。
 */
export function AnatomyAxesGizmo() {
  const calibration = useCardioStore((s) => s.calibration);

  const { headEnd, apEnd } = useMemo(() => {
    const basis = deriveCalibrationBasis(calibration);
    return {
      headEnd: basis.head.clone().multiplyScalar(GIZMO_LENGTH).toArray() as [number, number, number],
      apEnd: basis.ap.clone().multiplyScalar(GIZMO_LENGTH).toArray() as [number, number, number],
    };
  }, [calibration]);

  return (
    <group>
      <Line points={[[0, 0, 0], headEnd]} color="#f7b731" lineWidth={2} />
      <Text position={headEnd} fontSize={0.18} color="#f7b731" anchorX="center" anchorY="middle">
        Head
      </Text>
      <Line points={[[0, 0, 0], apEnd]} color="#3d8bfd" lineWidth={2} />
      <Text position={apEnd} fontSize={0.18} color="#3d8bfd" anchorX="center" anchorY="middle">
        AP
      </Text>
    </group>
  );
}
