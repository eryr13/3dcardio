import { useMemo } from "react";
import { Text } from "@react-three/drei";
import { DoubleSide, MeshStandardMaterial } from "three";
import type { Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import {
  MEASURED_LEFT_MAIN_OSTIUM,
  buildBrachiocephalicBranchGeometry,
  buildLeftCommonCarotidBranchGeometry,
  buildLeftSubclavianBranchGeometry,
  buildSeamlessAorticGeometry,
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

  // 大動脈基部(バルサルバ洞)・上行大動脈・弓部・下行大動脈は、継ぎ目で頂点を溶接した
  // 単一の連続したジオメトリとして構築する(buildSeamlessAorticGeometry参照——別々の
  // ジオメトリのままだと各々がcomputeVertexNormals()を個別に呼ぶため、位置がぴったり
  // 一致していても継ぎ目にシェーディングの段差が残っていた)。
  const rootGeometry = useMemo(
    () => buildSeamlessAorticGeometry(heartCentroid, graphs, heartWidth, detectedAorticOpening, heartScale),
    [heartCentroid, graphs, heartWidth, detectedAorticOpening, heartScale],
  );

  // 3分枝(腕頭動脈・左総頸動脈・左鎖骨下動脈)はどれも弓部と同じフレームから作るため、
  // 一度だけ計算して使い回す。
  const frame = useMemo(
    () => computeAorticRootFrame(heartCentroid, graphs, heartWidth, detectedAorticOpening),
    [heartCentroid, graphs, heartWidth, detectedAorticOpening],
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
        // 他の半透明メッシュと同じ「不透明度<1ならdepthWriteをオフにする」パターンを
        // 踏襲すると、心臓メッシュ(既定不透明度90%)・大動脈基部メッシュ(既定45%)は
        // どちらも半透明の透過ソート対象になる。three.jsの透過オブジェクトのソートは
        // オブジェクト単位(1つの代表点からカメラまでの距離)でしか行われないため、
        // 心臓の全表面を覆う大きなメッシュと、心臓の周りを長く回り込む大動脈基部
        // ・弓部・下行大動脈の1本の連続したメッシュ(buildSeamlessAorticGeometry)
        // という、互いに複雑に入り組んで重なる2つの大きな半透明メッシュの前後関係を
        // 単一の距離値では正しく決められず、画角によって「大動脈が心臓の上に乗っている
        // ように見える」「心臓が大動脈の上に乗っているように見える」の両方が起こって
        // いた(HeartPerfusionOverlay.tsxで発見・修正した「視点によって奥/手前が
        // 入れ替わって見える」不具合と同種——あちらは1メッシュの表裏面同士だったが、
        // こちらは2つの別メッシュ同士で起きている)。depthWriteを常にtrueにして
        // 深度テストを効かせることで、少なくとも大動脈基部メッシュ自身は常に正しい
        // 深度を書き込み、描画順に関わらず心臓側との前後関係が安定するようにする。
        depthWrite: true,
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
