import { useMemo } from "react";
import { Box3, Vector3 } from "three";
import type { Mesh } from "three";
import type { VesselId } from "../../types/anatomy";
import type { GuideAccessRoute } from "../../types/guideDevice";
import type { AorticRootFrame } from "./aorticRootMesh";
import {
  buildGuideCatheterGeometry,
  buildGuideWireGeometry,
  computeGuideCatheterPath,
} from "./guideDeviceMesh";
import type { GuideCatheterPath } from "./guideDeviceMesh";
import type { VesselGraph } from "./vesselGraph";

/**
 * カテーテル/ワイヤーの太さの基準になる「心臓の大きさ」。心臓メッシュのバウンディング
 * ボックスの対角線の半分を使う(heartCentroidと同じBox3から求める、簡易な近似)。
 * カテーテルのスプライン制御点のオフセット量(guideDeviceMesh.tsのRCA/LCA_CATHETER_OFFSETS)も
 * この値に比例させることで、モデルのスケールが変わっても崩れないようにしている。
 */
export function computeHeartScale(heartMesh: Mesh | undefined): number {
  if (!heartMesh) return 1;
  const size = new Box3().setFromObject(heartMesh).getSize(new Vector3());
  return Math.max(size.length() / 2, 0.01);
}

/** ガイディングカテーテルの半径を、対象血管のオスティウム半径に対してどの比率にするか(血管と同程度〜やや太い、という仕様)。 */
export const CATHETER_RADIUS_RATIO = 1.0;
/**
 * ガイドワイヤーの半径を、対象血管のオスティウム半径に対してどの比率にするか。実物の
 * 0.014インチ(約0.36mm)は血管よりずっと細いが、比率で言えば主要冠動脈(直径3〜4mm程度)に
 * 対して約12〜15%であり、以前の0.05(5%)は細すぎてシネX線上での存在感(視認性・
 * コントラスト)が実物より薄くなっていた。実物相応の比率に上げて、くっきりした
 * 一本の線として見えるようにする。
 */
export const WIRE_RADIUS_RATIO = 0.13;

/**
 * カテーテルの経路(スプライン+Phase 10向け配置情報)をメモ化するフック。
 * 対象血管・心臓の形状が変わらない限り再計算されない(進行度には依存しない)。
 */
export function useGuideCatheterPath(
  graph: VesselGraph | undefined,
  heartCentroid: Vector3,
  heartScale: number,
  vesselId: VesselId,
  accessRoute: GuideAccessRoute,
  aorticRootFrame: AorticRootFrame | null,
  heartMesh: Mesh | null,
): GuideCatheterPath | null {
  return useMemo(() => {
    if (!graph) return null;
    return computeGuideCatheterPath(
      graph,
      heartCentroid,
      heartScale,
      vesselId,
      accessRoute,
      aorticRootFrame,
      heartMesh,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, heartCentroid, heartScale, vesselId, accessRoute, aorticRootFrame, heartMesh]);
}

/** カテーテルの進行度に応じた表示用ジオメトリをメモ化するフック。 */
export function useGuideCatheterGeometry(path: GuideCatheterPath | null, catheterRadius: number, catheterProgress: number) {
  return useMemo(() => {
    if (!path) return null;
    return buildGuideCatheterGeometry(path, catheterRadius, catheterProgress);
  }, [path, catheterRadius, catheterProgress]);
}

/**
 * ワイヤーの進行度に応じた表示用ジオメトリをメモ化するフック。進行度0の間はnull
 * (まだカテーテルの中)。ワイヤーの経路は冠動脈中心線だけから決まり、カテーテルの
 * スプラインには依存しない(guideDeviceMesh.tsのbuildGuideWireGeometry参照——
 * 大動脈側の共有区間はカテーテル自身のチューブに完全に重なって隠れるため、
 * ワイヤー側では描画しない)。
 */
export function useGuideWireGeometry(
  graph: VesselGraph | undefined,
  targetBranchId: string,
  wireRadius: number,
  wireProgress: number,
) {
  return useMemo(() => {
    if (!graph) return null;
    return buildGuideWireGeometry(graph, targetBranchId, wireRadius, wireProgress);
  }, [graph, targetBranchId, wireRadius, wireProgress]);
}
