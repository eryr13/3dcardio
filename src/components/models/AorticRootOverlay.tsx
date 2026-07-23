import { useMemo } from "react";
import { Text } from "@react-three/drei";
import { DoubleSide, MeshStandardMaterial } from "three";
import type { Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import {
  MEASURED_LEFT_MAIN_OSTIUM,
  buildAorticArchGeometry,
  buildAorticRootGeometry,
  buildBrachiocephalicBranchGeometry,
  buildLeftCommonCarotidBranchGeometry,
  buildLeftSubclavianBranchGeometry,
  computeAorticRootFrame,
} from "./aorticRootMesh";
import type { DetectedAorticOpening } from "./heartAorticOpening";
import type { VesselGraph } from "./vesselGraph";

/** LMT(左冠動脈主幹部)起始点マーカーの色。RCA/LAD/LCXの血管カラー(青緑橙)と
 * 紛れないよう、既存の配色に無い白系にする。 */
const LMT_MARKER_COLOR = "#f5f3ce";
/** LMT起始点マーカーの球体半径(heartScale比率)。ノードマーカー(ModelLoader.tsx、
 * 絶対値0.02〜0.028)より一回り大きく、弁の円盤(半径0.1〜0.2程度)より小さい、
 * 「1点の目印」として視認できるサイズにする。 */
const LMT_MARKER_RADIUS_RATIO = 0.045;

interface AorticRootOverlayProps {
  heartCentroid: Vector3;
  heartScale: number;
  /** 上行大動脈・大動脈弓・下行大動脈の太さの算出基準(AorticRootFrame.ascendingRadius参照)。 */
  heartWidth: number;
  graphs: Map<VesselId, VesselGraph>;
  /** 心筋メッシュに実在する大動脈弁輪相当の開口部の実測(heartAorticOpening.ts参照、
   * ModelLoader.tsxで一度だけ検出したものを受け取る——レイキャストを伴うため各コンポー
   * ネントで個別に検出しない)。未検出/未指定の場合は従来通りの弦当てはめにフォール
   * バックする。 */
  detectedAorticOpening?: DetectedAorticOpening | null;
}

/**
 * 大動脈基部(バルサルバ洞)・上行大動脈・弓部大動脈・下行大動脈の補助表示
 * (AnatomyLegendの「心臓」の下にあるトグルで表示/非表示を切り替える)。ガイディング
 * カテーテルが冠動脈入口部にどうエンゲージしているかを理解しやすくするための、
 * 半透明の補助メッシュ。位置・向き・サイズは冠動脈入口部の実位置から幾何学的に
 * 逆算する(大動脈基部自体の寸法はheartScaleに依存しないが、弓部・下行大動脈が
 * 心臓の外側を回り込む距離はheartScaleに比例するため、こちらはheartScaleを使う
 * ——aorticRootMesh.ts参照)。経路の構築自体はaorticRootMesh.ts(純粋関数)に委ね、
 * ここではstoreの表示設定を読んでマテリアルを付けて描画するだけ
 * (GuideDeviceMeshesと同じ役割分担)。
 */
export function AorticRootOverlay({
  heartCentroid,
  heartScale,
  heartWidth,
  graphs,
  detectedAorticOpening,
}: AorticRootOverlayProps) {
  const display = useCardioStore((s) => s.aorticRoot);

  const rootGeometry = useMemo(
    () => buildAorticRootGeometry(heartCentroid, graphs, heartWidth, detectedAorticOpening),
    [heartCentroid, graphs, heartWidth, detectedAorticOpening],
  );

  // 弓部・鎖骨下動脈相当の分岐はどちらも同じフレームから作るため、一度だけ計算して使い回す
  // (buildAorticRootGeometry自身は内部で別途computeAorticRootFrameを呼ぶが、公開APIの
  // 引数を変えるほどではないためそちらはそのままにしておく)。
  const frame = useMemo(
    () => computeAorticRootFrame(heartCentroid, graphs, heartWidth, detectedAorticOpening),
    [heartCentroid, graphs, heartWidth, detectedAorticOpening],
  );

  const archGeometry = useMemo(
    () => (frame ? buildAorticArchGeometry(frame, heartScale) : null),
    [frame, heartScale],
  );

  const brachiocephalicGeometry = useMemo(
    () => (frame ? buildBrachiocephalicBranchGeometry(frame, heartScale) : null),
    [frame, heartScale],
  );
  const leftCommonCarotidGeometry = useMemo(
    () => (frame ? buildLeftCommonCarotidBranchGeometry(frame, heartScale) : null),
    [frame, heartScale],
  );
  const leftSubclavianGeometry = useMemo(
    () => (frame ? buildLeftSubclavianBranchGeometry(frame, heartScale) : null),
    [frame, heartScale],
  );

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: display.color,
        transparent: display.opacity < 1,
        opacity: display.opacity,
        depthWrite: display.opacity >= 1,
        roughness: 0.5,
        metalness: 0.05,
        // 洞の三つ葉断面ローフト(aorticRootMesh.ts)は巻き順を厳密に保証していないため、
        // 両面描画にして裏返った面が透けて消えないようにする。
        side: DoubleSide,
      }),
    [display.color, display.opacity],
  );

  if (!display.visible || !rootGeometry) return null;

  const lmtMarkerRadius = Math.max(heartScale, 0) * LMT_MARKER_RADIUS_RATIO;

  return (
    <>
      <mesh geometry={rootGeometry} material={material} />
      {archGeometry && <mesh geometry={archGeometry} material={material} />}
      {brachiocephalicGeometry && <mesh geometry={brachiocephalicGeometry} material={material} />}
      {leftCommonCarotidGeometry && <mesh geometry={leftCommonCarotidGeometry} material={material} />}
      {leftSubclavianGeometry && <mesh geometry={leftSubclavianGeometry} material={material} />}
      {lmtMarkerRadius > 1e-6 && (
        <group>
          <mesh position={MEASURED_LEFT_MAIN_OSTIUM}>
            <sphereGeometry args={[lmtMarkerRadius, 16, 16]} />
            <meshBasicMaterial color={LMT_MARKER_COLOR} transparent opacity={0.9} depthTest={false} depthWrite={false} />
          </mesh>
          <Text
            position={[
              MEASURED_LEFT_MAIN_OSTIUM.x,
              MEASURED_LEFT_MAIN_OSTIUM.y + lmtMarkerRadius * 2.2,
              MEASURED_LEFT_MAIN_OSTIUM.z,
            ]}
            fontSize={lmtMarkerRadius * 2.5}
            color={LMT_MARKER_COLOR}
            anchorX="center"
            anchorY="middle"
          >
            LMT起始部
          </Text>
        </group>
      )}
    </>
  );
}
