import { useLayoutEffect, useMemo } from "react";
import { DoubleSide, Float32BufferAttribute, MeshBasicMaterial } from "three";
import type { Mesh } from "three";
import type { VesselId } from "../../types/anatomy";
import type { CardioObject } from "../../types/object";
import { useCardioStore } from "../../store/useCardioStore";
import { buildPerfusionColors, computeBranchAdequacy, computeHeartPerfusionTerritory } from "./heartPerfusion";
import type { VesselGraph } from "./vesselGraph";

interface HeartPerfusionOverlayProps {
  heartMesh: Mesh | undefined;
  graphs: Map<VesselId, VesselGraph>;
  objects: CardioObject[];
}

/**
 * Phase 8: 心筋灌流領域・虚血表示。心臓メッシュ(HEART)のposition/normal/indexを
 * 共有した別ジオメトリに頂点カラーを追加し、通常の心臓メッシュの代わりに表示する
 * (呼び出し側=ModelLoader.tsxが、灌流表示モード中は元のHEARTメッシュをvisible=falseに
 * する)。表示/非表示・不透明度は心臓の既存の表示設定(store.heart)にそのまま従う。
 *
 * ジオメトリのposition/normal/indexは心臓メッシュから1回だけクローンし(以後不変)、
 * 頂点カラー(color属性)だけを表示モード・充足度が変わるたびに差し替える。
 * これにより、狭窄の重症度をドラッグ操作で連続的に変えても、毎回position/normalを
 * 複製し直すことなく色だけを再計算すればよい。
 *
 * 灌流領域の割り当て(どの頂点をどの枝が灌流するか)は心臓メッシュ・血管グラフが
 * 変わらない限り不変なので、こちらも1回だけ計算してキャッシュする
 * (heartPerfusion.tsのcomputeHeartPerfusionTerritory参照)。狭窄・石灰化を変更した際に
 * 再計算されるのは、枝ごとの充足度(computeBranchAdequacy)だけである。
 */
export function HeartPerfusionOverlay({ heartMesh, graphs, objects }: HeartPerfusionOverlayProps) {
  const perfusionMode = useCardioStore((s) => s.perfusion.mode);
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);

  const territory = useMemo(() => {
    if (!heartMesh) return null;
    return computeHeartPerfusionTerritory(heartMesh.geometry, graphs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartMesh, graphs]);

  // 充足度は虚血表示モードの間だけ必要(狭窄・石灰化ごとに複数枝分の到達濃度上限を
  // 計算するため、テリトリー表示時やOFF時には無駄な再計算を避ける)。
  const adequacyByBranchId = useMemo(() => {
    if (perfusionMode !== "ischemia") return null;
    return computeBranchAdequacy(graphs, objects);
  }, [perfusionMode, graphs, objects]);

  const geometry = useMemo(() => {
    if (!heartMesh) return null;
    const cloned = heartMesh.geometry.clone();
    // MeshBasicMaterial(下記)は非照明のため法線を一切参照せず、法線の向きが
    // 表示色に影響することは無いはずだが、念のため頂点法線を再計算しておく
    // (副作用は無いはずで、コストも心臓メッシュ1回分のみ)。
    cloned.computeVertexNormals();
    return cloned;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartMesh]);

  // 灌流テリトリー/虚血の色分けは「データ」であり、シーンのライティングによって
  // 見え方が変わってはならない。既定のAP視点(DEFAULT_CAMERA_POSITION)がメイン
  // ディレクショナルライト(Scene.tsx)の方向とほぼ一致しており、MeshStandardMaterial
  // (光源の影響を受けるPBRマテリアル)を使うとAP視点で頂点カラーが明るく飛んで
  // 色が薄く/違って見え、斜めから見ると正しい色に戻る、という視点依存の不具合が
  // あった。非照明のMeshBasicMaterialにすることで、頂点カラーがどの視点・光源
  // 方向でも常に同じ見え方になるようにする(石灰化・狭窄等の他のシルエット表示
  // (createObjectSilhouetteMaterial)と同じ考え方)。sideもDoubleSideにして、
  // 万一の片面カリングによる見落としも防ぐ。
  const material = useMemo(() => new MeshBasicMaterial({ vertexColors: true, side: DoubleSide }), []);

  const vesselColors = useMemo(
    () => ({ RCA: vessels.RCA?.color, LAD: vessels.LAD?.color, LCX: vessels.LCX?.color }) as Record<VesselId, string>,
    [vessels],
  );

  useLayoutEffect(() => {
    if (!geometry || !territory || perfusionMode === "off") return;
    const colors = buildPerfusionColors(territory, perfusionMode, vesselColors, adequacyByBranchId);
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  }, [geometry, territory, perfusionMode, vesselColors, adequacyByBranchId]);

  // 心臓の既定の不透明度(DEFAULT_HEART_OPACITY=0.9)は1未満のため、他のメッシュと
  // 同じ「不透明度<1ならdepthWriteをオフにする」パターンを踏襲すると、DoubleSideの
  // 単一メッシュで奥(内側)の面と手前(外側)の面が深度でソートされず描画順(インデックス
  // 順)のまま合成されてしまい、視点によって奥の面の色が手前に透けて見える/入れ替わって
  // 見える不具合が起きた(前回「正面だと暗い色になる」として報告された現象の実体)。
  // depthWriteは常にtrueにして深度テストを効かせることで、視点に関わらず常に
  // 手前(外側)の面の色だけが最終的に見えるようにする(depthWrite=falseは他の
  // 半透明オブジェクトとの重なりを自然に見せるためのものだが、この用途では
  // 「データを表す色分けが視点によって欠ける」方が実害が大きいため優先度を変えている)。
  useLayoutEffect(() => {
    material.transparent = heart.opacity < 1;
    material.opacity = heart.opacity;
    material.depthWrite = true;
    material.needsUpdate = true;
  }, [material, heart.opacity]);

  if (!geometry || perfusionMode === "off") return null;

  return <mesh geometry={geometry} material={material} visible={heart.visible} />;
}
