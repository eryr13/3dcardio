import { useEffect, useMemo } from "react";
import { Html, Line } from "@react-three/drei";
import { MeshStandardMaterial } from "three";
import type { Mesh, Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import type { GuideAccessRoute } from "../../types/guideDevice";
import { useCardioStore } from "../../store/useCardioStore";
import { computeAorticRootFrame } from "./aorticRootMesh";
import { buildWireCenterline } from "./guideDeviceMesh";
import type { GuideCatheterPath } from "./guideDeviceMesh";
import type { DetectedAorticOpening } from "./heartAorticOpening";
import { getMainTrunk } from "./vesselGraph";
import type { VesselGraph } from "./vesselGraph";
import {
  CATHETER_RADIUS_RATIO,
  WIRE_RADIUS_RATIO,
  computeHeartScale,
  computeHeartWidth,
  useGuideCatheterGeometry,
  useGuideCatheterPath,
  useGuideWireGeometry,
} from "./useGuideDevicePath";

interface GuideDeviceMeshesProps {
  heartMesh: Mesh | undefined;
  heartCentroid: Vector3;
  graphs: Map<VesselId, VesselGraph>;
  /** 心筋メッシュに実在する大動脈弁輪相当の開口部の実測(ModelLoader.tsxで一度だけ
   * 検出したものを受け取る、AorticRootOverlay.tsx参照)。 */
  detectedAorticOpening?: DetectedAorticOpening | null;
}

/**
 * デバッグ表示用: buildCatheterApproach(guideDeviceMesh.ts)がGuideCatheterPlacement.
 * controlPointsに積む順序と対応する、各制御点の意味ラベルを返す。大動脈基部フレームの
 * 有無・アクセスルートで制御点の構成(点数・並び)が変わるため、それぞれに合わせた
 * 固定のラベル列を用意する——buildCatheterApproachの制御点の積み方(controlPoints =
 * [...entryPoints, aortaPoint, ...lumenPoints, bulgePoint, ...hookPoint?, tipAlignmentPoint,
 * ostium])を変更した場合はここも同期して更新すること。
 */
function catheterControlPointLabels(accessRoute: GuideAccessRoute, hasFrame: boolean): string[] {
  if (hasFrame) {
    const entryLabels =
      accessRoute === "femoral"
        ? ["体外(下行大動脈終端)", "下行大動脈開始", "弓頂部"]
        : ["体外(鎖骨下動脈終端)", "弓頂部"];
    return [
      ...entryLabels,
      "上行大動脈終端",
      "内腔上部(top)",
      "下降中(midDescent)",
      "対側壁・底(floor)",
      "反転点(hook)",
      "先端整列",
      "入口部(ostium)",
    ];
  }
  const entryLabels = accessRoute === "femoral" ? ["体外1", "体外2"] : ["体外"];
  return [...entryLabels, "上行大動脈相当", "対側壁バルジ", "先端整列", "入口部(ostium)"];
}

/**
 * ラベルの意味カテゴリに応じたデバッグマーカーの色。体外側=グレー系、上行大動脈=
 * シアン、内腔エンゲージ(J字カーブ)=暖色系、入口部=赤、先端整列=白、と色分けし、
 * 経路上のどの区間にいるかを球の色だけで大まかに把握できるようにする。
 */
function catheterDebugColor(label: string): string {
  if (label.startsWith("体外") || label.includes("下行大動脈") || label.includes("鎖骨下動脈")) return "#9aa0a6";
  if (label.includes("弓頂部") || label.includes("上行大動脈")) return "#00e5ff";
  if (label.includes("入口部")) return "#ff1744";
  if (label.includes("先端整列")) return "#ffffff";
  return "#ffb300";
}

const CATHETER_DEBUG_LINE_COLOR = "#ff00ff";

/**
 * カテーテル経路のデバッグ可視化。実際に密サンプリングした経路全体(fullSplinePoints)を
 * 明るいマゼンタの線で、経路構築に使った意味のある制御点(controlPoints)を色分けした
 * 球+ラベルで表示する。心筋メッシュや他のジオメトリに隠れて経路がどこを通っているか
 * 分かりにくいという問題に対応するため、depthTestを無効にして常に手前に描画する
 * (NodeMarkers、ModelLoader.tsxと同じ考え方)。解剖学的な意味を持つ通常表示ではないため
 * 既定では非表示(guideDevice.showCatheterDebugPathで切り替え)。
 */
function CatheterDebugPath({
  path,
  accessRoute,
  hasFrame,
  heartScale,
}: {
  path: GuideCatheterPath;
  accessRoute: GuideAccessRoute;
  hasFrame: boolean;
  heartScale: number;
}) {
  const labels = catheterControlPointLabels(accessRoute, hasFrame);
  const markerRadius = Math.max(heartScale * 0.02, 0.02);

  return (
    <>
      <Line
        points={path.fullSplinePoints}
        color={CATHETER_DEBUG_LINE_COLOR}
        lineWidth={2}
        transparent
        depthTest={false}
        renderOrder={999}
      />
      {path.placement.controlPoints.map((point, i) => {
        const label = labels[i] ?? `point ${i}`;
        return (
          <group key={i} position={point}>
            <mesh renderOrder={999}>
              <sphereGeometry args={[markerRadius, 12, 12]} />
              <meshBasicMaterial
                color={catheterDebugColor(label)}
                transparent
                opacity={0.95}
                depthTest={false}
                depthWrite={false}
              />
            </mesh>
            <Html distanceFactor={8} style={{ pointerEvents: "none" }}>
              <div className="catheter-debug-label">
                {i}: {label}
              </div>
            </Html>
          </group>
        );
      })}
    </>
  );
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
export function GuideDeviceMeshes({ heartMesh, heartCentroid, graphs, detectedAorticOpening }: GuideDeviceMeshesProps) {
  const guideDevice = useCardioStore((s) => s.guideDevice);
  const setGuideDevicePlacement = useCardioStore((s) => s.setGuideDevicePlacement);

  const heartScale = useMemo(() => computeHeartScale(heartMesh), [heartMesh]);
  const heartWidth = useMemo(() => computeHeartWidth(heartMesh), [heartMesh]);
  const graph = graphs.get(guideDevice.targetVesselId);
  // 冠動脈入口部の実位置から逆算した大動脈基部フレーム(aorticRootMesh.ts)。
  // カテーテルが対側壁に当ててからエンゲージする経路(computeGuideCatheterPath参照)の
  // 基準に使う。
  const aorticRootFrame = useMemo(
    () => computeAorticRootFrame(heartCentroid, graphs, heartWidth, detectedAorticOpening),
    [heartCentroid, graphs, heartWidth, detectedAorticOpening],
  );
  const catheterPath = useGuideCatheterPath(
    graph,
    heartCentroid,
    heartScale,
    guideDevice.targetVesselId,
    guideDevice.accessRoute,
    aorticRootFrame,
    heartMesh ?? null,
  );

  useEffect(() => {
    setGuideDevicePlacement(catheterPath?.placement ?? null);
  }, [catheterPath, setGuideDevicePlacement]);

  // 検証(要件2): ガイドワイヤーの起点(冠動脈中心線グラフの本幹t=0、buildWireCenterline
  // 参照)が、カテーテル先端の座標(catheterPath.placement.tipPosition)と一致することを
  // 確認する。どちらも同じgraph(getMainTrunk(graph).points[0].position)に由来するため
  // 構造的に一致するはずだが、対象血管・目標枝を切り替えるたびに実測してログで報告する。
  useEffect(() => {
    if (!graph || !catheterPath) return;
    const wireStart = buildWireCenterline(graph, guideDevice.targetBranchId).points[0];
    if (!wireStart) return;
    const distance = wireStart.distanceTo(catheterPath.placement.tipPosition);
    console.log(
      `[GuideDeviceMeshes] ワイヤー起点とカテーテル先端の接続検証(${guideDevice.targetVesselId}): ` +
        `距離=${distance.toExponential(2)}(0であるべき)`,
    );
    if (distance > 1e-4) {
      console.warn(
        `[GuideDeviceMeshes] ワイヤー起点がカテーテル先端から乖離しています(${guideDevice.targetVesselId}): ` +
          `距離=${distance.toFixed(4)}`,
      );
    }
  }, [graph, catheterPath, guideDevice.targetBranchId, guideDevice.targetVesselId]);

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
      {guideDevice.showCatheterDebugPath && catheterPath && (
        <CatheterDebugPath
          path={catheterPath}
          accessRoute={guideDevice.accessRoute}
          hasFrame={aorticRootFrame !== null}
          heartScale={heartScale}
        />
      )}
    </>
  );
}
