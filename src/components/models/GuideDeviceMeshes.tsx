import { useEffect, useMemo } from "react";
import { MeshStandardMaterial } from "three";
import type { Mesh, Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import { getMainTrunk } from "./vesselGraph";
import type { VesselGraph } from "./vesselGraph";
import {
  CATHETER_RADIUS_RATIO,
  WIRE_RADIUS_RATIO,
  computeHeartScale,
  useGuideCatheterGeometry,
  useGuideCatheterPath,
  useGuideWireGeometry,
} from "./useGuideDevicePath";

interface GuideDeviceMeshesProps {
  heartMesh: Mesh | undefined;
  heartCentroid: Vector3;
  graphs: Map<VesselId, VesselGraph>;
}

/**
 * Phase 9: ガイディングカテーテル・ガイドワイヤーのデモ表示(メインビュー)。
 * 経路の構築自体はguideDeviceMesh.ts(純粋関数)に委ね、ここでは進行度・表示設定を
 * storeから読んでジオメトリ生成フックに渡し、マテリアルを付けて描画するだけ。
 *
 * カテーテルの配置情報(先端位置・向き等、GuideCatheterPlacement)は進行度に関わらず
 * 対象血管が決まれば一意に定まるため、経路が変わるたびにstore.guideDevicePlacementへ
 * 書き戻す(Phase 10のバックアップ力簡易評価が、ここで一度計算した情報を再利用
 * できるようにするため)。
 */
export function GuideDeviceMeshes({ heartMesh, heartCentroid, graphs }: GuideDeviceMeshesProps) {
  const guideDevice = useCardioStore((s) => s.guideDevice);
  const setGuideDevicePlacement = useCardioStore((s) => s.setGuideDevicePlacement);

  const heartScale = useMemo(() => computeHeartScale(heartMesh), [heartMesh]);
  const graph = graphs.get(guideDevice.targetVesselId);
  const catheterPath = useGuideCatheterPath(graph, heartCentroid, heartScale, guideDevice.targetVesselId);

  useEffect(() => {
    setGuideDevicePlacement(catheterPath?.placement ?? null);
  }, [catheterPath, setGuideDevicePlacement]);

  const ostiumRadius = graph ? getMainTrunk(graph).points[0]?.radius ?? 0.03 : 0.03;
  const catheterRadius = ostiumRadius * CATHETER_RADIUS_RATIO;
  const wireRadius = ostiumRadius * WIRE_RADIUS_RATIO;

  const catheterProgress = Math.min(1, guideDevice.insertionPhase);
  const wireProgress = Math.max(0, guideDevice.insertionPhase - 1);

  const catheterGeometry = useGuideCatheterGeometry(catheterPath, catheterRadius, catheterProgress);
  const wireGeometry = useGuideWireGeometry(graph, guideDevice.targetBranchId, wireRadius, wireProgress);

  const catheterMaterial = useMemo(
    () => new MeshStandardMaterial({ color: "#3a3d42", roughness: 0.4, metalness: 0.2 }),
    [],
  );
  const wireMaterial = useMemo(
    () => new MeshStandardMaterial({ color: "#d9dce1", roughness: 0.25, metalness: 0.85 }),
    [],
  );

  if (!guideDevice.enabled) return null;

  return (
    <>
      {guideDevice.showCatheter && catheterGeometry && <mesh geometry={catheterGeometry} material={catheterMaterial} />}
      {guideDevice.showWire && wireGeometry && <mesh geometry={wireGeometry} material={wireMaterial} />}
    </>
  );
}
