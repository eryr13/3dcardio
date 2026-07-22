import { useMemo } from "react";
import { Text } from "@react-three/drei";
import { CircleGeometry, DoubleSide, MeshStandardMaterial, Quaternion, Vector3 } from "three";
import type { Vector3 as Vector3Type } from "three";
import type { ValveId, VesselId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import { computeAorticRootFrame } from "./aorticRootMesh";
import type { DetectedAorticOpening } from "./heartAorticOpening";
import { computeValvePlacements, logValvePlacementVerification } from "./heartValveMesh";
import type { ValvePlacement } from "./heartValveMesh";
import type { VesselGraph } from "./vesselGraph";

const VALVE_IDS: readonly ValveId[] = ["AORTIC", "PULMONARY", "MITRAL", "TRICUSPID"];

/** CircleGeometryは既定でXY平面上(法線+Z)を向くため、この基準法線から実際の
 * placement.normalへ回転させるクォータニオンを求める。 */
const CIRCLE_DEFAULT_NORMAL = new Vector3(0, 0, 1);

function ValveDisk({ placement, color, opacity, label }: { placement: ValvePlacement; color: string; opacity: number; label: string }) {
  const geometry = useMemo(() => new CircleGeometry(placement.radius, 32), [placement.radius]);
  const material = useMemo(
    () => new MeshStandardMaterial({ color, transparent: opacity < 1, opacity, side: DoubleSide, roughness: 0.5, metalness: 0.05 }),
    [color, opacity],
  );
  const quaternion = useMemo(
    () => new Quaternion().setFromUnitVectors(CIRCLE_DEFAULT_NORMAL, placement.normal.clone().normalize()),
    [placement.normal],
  );
  const labelPosition = useMemo(
    () => placement.center.clone().addScaledVector(placement.normal, placement.radius * 0.15),
    [placement.center, placement.normal, placement.radius],
  );

  return (
    <>
      <mesh geometry={geometry} material={material} position={placement.center} quaternion={quaternion} />
      <Text position={labelPosition} fontSize={placement.radius * 0.35} color={color} anchorX="center" anchorY="middle">
        {label}
      </Text>
    </>
  );
}

interface ValveOverlayProps {
  heartCentroid: Vector3Type;
  heartWidth: number;
  graphs: Map<VesselId, VesselGraph>;
  detectedAorticOpening?: DetectedAorticOpening | null;
}

/**
 * 4つの弁(大動脈弁・肺動脈弁・僧帽弁・三尖弁)の推定位置を円盤で表示する
 * (heartValveMesh.ts参照)。大動脈基部と同じ大動脈基部フレーム(冠動脈入口部の
 * 実位置から幾何学的に逆算したもの)を共有するため、大動脈基部が接続すべき
 * 位置(大動脈弁の直上)を視覚的に確認できる。
 */
export function ValveOverlay({ heartCentroid, heartWidth, graphs, detectedAorticOpening }: ValveOverlayProps) {
  const valves = useCardioStore((s) => s.valves);

  const frame = useMemo(
    () => computeAorticRootFrame(heartCentroid, graphs, heartWidth, detectedAorticOpening),
    [heartCentroid, graphs, heartWidth, detectedAorticOpening],
  );
  const placements = useMemo(() => {
    if (!frame) return null;
    const result = computeValvePlacements(frame, heartWidth);
    logValvePlacementVerification(result);
    return result;
  }, [frame, heartWidth]);

  if (!placements) return null;

  return (
    <>
      {VALVE_IDS.map((id) => {
        const state = valves[id];
        if (!state.visible) return null;
        return <ValveDisk key={id} placement={placements[id]} color={state.color} opacity={state.opacity} label={state.name} />;
      })}
    </>
  );
}
