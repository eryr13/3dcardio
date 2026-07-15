// 造影剤で満たされた内腔チューブ(Phase 7)のジオメトリ生成。狭窄・石灰化による内腔半径の
// 減少(utils/contrastFlow.tsのgetLumenRadiusFractionAt)と、現在時刻での造影剤濃度
// (getConcentrationAt)の両方を、中心線各点の半径に直接反映したチューブを、本幹+全側枝に
// ついて構築しマージする。ステントのラティス生成(stentLatticeMesh.ts)と全く同じ
// buildTubeFromPoints/mergeIndexedGeometriesを再利用しており、新しい深度ピール対応の
// 仕組みは作らない(石灰化・狭窄の内腔減算シェルと同様、「効果を織り込んだ閉じたジオメトリを
// 独立して深度ピールする」という実証済みパターンをそのまま踏襲している)。

import { Color } from "three";
import type { BufferGeometry } from "three";
import type { VesselId } from "../../types/anatomy";
import type { CardioObject } from "../../types/object";
import type { ArrivalTables, ContrastFlowParams } from "../../utils/contrastFlow";
import { getConcentrationAt, getLumenRadiusFractionAt } from "../../utils/contrastFlow";
import { buildTubeFromPoints, mergeIndexedGeometries } from "./stentLatticeMesh";
import type { VesselGraph } from "./vesselGraph";

/**
 * buildTubeFromPointsの既定smoothingPasses(24)は、ステント・狭窄が使う「短い局所区間を
 * 高密度に再サンプリングした点列」でtangentのノイズ増幅を抑えるためのもので、branch.points
 * (中心線グラフのノード・エッジからそのまま来る、再サンプリングしていない実測点列)を
 * 枝全長にわたって渡すこの用途には強すぎる。全長(RCA本幹で40点、複数の分岐を経る
 * カーブを含む)に24回の移動平均をかけると、カーブのたびに内側へ「角を切る」形で
 * ジオメトリが実際の中心線から目に見えてズレてしまう(狭窄・石灰化の判定に使う
 * 位置と、造影剤チューブが実際に描画される位置がズレる不具合の原因だった)。
 * 造影剤フローのチューブはbranch.pointsをそのまま使うため平滑化は不要で、0にする。
 */
const CONTRAST_TUBE_SMOOTHING_PASSES = 0;

/**
 * 造影剤の色を、血管本体の色そのまま(区別しにくい)ではなく、血管色をベースに濃度で
 * 明度・彩度を変えた色にする。濃度が低いところは血管本体よりくすんだ暗い色(=薄い)、
 * 濃度1(充満)では血管本体より明るく鮮やかな色にし、「満ちている区間」がひと目で
 * わかるようにする。加えて、濃度が0→1へ立ち上がる過渡期(=造影剤の先端が今まさに
 * 通過している位置)だけに効く明るさのブースト項(c*(1-c)、c=0.5でピーク、両端で0)を
 * 足し、先端が一瞬明るく光って見えるようにする(プラトーした後方と区別しやすくなる)。
 */
function contrastFillColor(baseColor: Color, concentration: number): Color {
  const c = Math.max(0, Math.min(1, concentration));
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  const saturation = Math.min(1, hsl.s * (0.5 + 0.6 * c));
  const leadingEdgeBoost = 0.72 * c * (1 - c);
  const lightness = Math.min(1, hsl.l * (0.5 + 0.8 * c) + leadingEdgeBoost);
  return new Color().setHSL(hsl.h, saturation, lightness);
}

/**
 * 血管グラフ全体(本幹+全側枝)について、現在時刻elapsedSecondsにおける造影剤充填チューブの
 * ジオメトリを構築する。どの枝にも造影剤が全く無い(濃度が実質0)場合はnullを返す
 * (呼び出し側はメッシュを非表示にする)。各枝は独立にbuildTubeFromPointsでチューブ化して
 * からマージするため、末梢まで先端が届いていない枝は自然にその手前で途切れる
 * (半径が0に収束するため、無理に打ち切り処理をしなくてもチューブが自然に消える)。
 * baseColorを渡すと、メインビュー用に濃度に応じた色(頂点カラー、contrastFillColor参照)を
 * 焼き込む。省略時(シネスキーマ表示)は頂点カラーを付与しない。
 */
export function buildContrastFillGeometry(
  graph: VesselGraph,
  objects: CardioObject[],
  vesselId: VesselId,
  arrivalTables: ArrivalTables,
  elapsedSeconds: number,
  flowParams: ContrastFlowParams,
  baseColor?: Color,
): BufferGeometry | null {
  const tubes: BufferGeometry[] = [];

  for (const branch of graph.branches) {
    if (branch.points.length < 2) continue;
    const table = arrivalTables.get(branch.id);

    let anyConcentration = false;
    const points = branch.points.map((p) => p.position);
    const radii: number[] = [];
    const colors: Color[] | undefined = baseColor ? [] : undefined;
    for (const p of branch.points) {
      const concentration = getConcentrationAt(table, p.t, elapsedSeconds, flowParams);
      if (concentration > 1e-3) anyConcentration = true;
      const radiusFraction = getLumenRadiusFractionAt(objects, vesselId, branch.id, p.t);
      radii.push(p.radius * radiusFraction * concentration);
      if (colors && baseColor) colors.push(contrastFillColor(baseColor, concentration));
    }

    if (!anyConcentration) continue;
    tubes.push(buildTubeFromPoints(points, radii, undefined, CONTRAST_TUBE_SMOOTHING_PASSES, undefined, colors));
  }

  if (tubes.length === 0) return null;
  return mergeIndexedGeometries(tubes);
}

/**
 * 半径を実際の血管より少し大きめに作るための余裕係数。マスク用ジオメトリは厚みを
 * 測るためではなく「その画素にどれだけの濃度が存在するか」を覆うためだけに使うため、
 * 実際の血管の見た目のシルエットより少しでも小さいと縁だけ濃度が乗らない(マスクの
 * 外側に生の血管の輪郭がリング状にはみ出す)不具合が起きる。厚みの正確さは問わないので、
 * 気持ち大きめにしておくほうが安全。
 */
const MASK_RADIUS_MARGIN = 3.0;

/**
 * シネのリアルX線モード専用: 血管本体の光学的厚み(常に生の血管メッシュから計算する、
 * 造影剤フローモードOFF時と全く同じもの)に掛け合わせる「濃度マスク」用ジオメトリ。
 * 通常の造影剤充填チューブ(buildContrastFillGeometry、半径=血管半径×内腔比率×濃度)とは
 * 異なり、こちらは半径を内腔比率(狭窄・石灰化による構造的な狭窄)までしか縮めず、
 * 濃度では縮めない。その代わり各頂点に濃度をaScalar頂点属性として埋め込み、
 * CineVesselThicknessEffect側でMAXブレンドの単一パス(深度ピールの前後面差分ではない)
 * でレンダーすることで、「その画素を覆うどれかのチューブ表面が持つ最大濃度」を
 * 濃淡マスクとして取り出す。
 *
 * 半径そのものの正確さ(実際の血管メッシュの見た目の太さと一致するか)に依存しないのが
 * この設計の要点: 濃度1.0の場所は血管本体の光学的厚みをそのまま(倍率1.0で)通すだけなので、
 * マスク用チューブの半径が多少ズレていても最終的な見た目には影響しない
 * (buildContrastFillGeometryを厚み測定に使っていた旧実装が「血管本体より濃くなりすぎる」
 * 不具合の原因だったため、この専用ジオメトリに分離した)。
 */
export function buildContrastMaskGeometry(
  graph: VesselGraph,
  objects: CardioObject[],
  vesselId: VesselId,
  arrivalTables: ArrivalTables,
  elapsedSeconds: number,
  flowParams: ContrastFlowParams,
): BufferGeometry | null {
  const tubes: BufferGeometry[] = [];

  for (const branch of graph.branches) {
    if (branch.points.length < 2) continue;
    const table = arrivalTables.get(branch.id);

    let anyConcentration = false;
    const points = branch.points.map((p) => p.position);
    const radii: number[] = [];
    const concentrations: number[] = [];
    for (const p of branch.points) {
      const concentration = getConcentrationAt(table, p.t, elapsedSeconds, flowParams);
      if (concentration > 1e-3) anyConcentration = true;
      const radiusFraction = getLumenRadiusFractionAt(objects, vesselId, branch.id, p.t);
      radii.push(p.radius * radiusFraction * MASK_RADIUS_MARGIN);
      concentrations.push(Math.min(1, concentration));
    }

    if (!anyConcentration) continue;
    tubes.push(buildTubeFromPoints(points, radii, undefined, CONTRAST_TUBE_SMOOTHING_PASSES, concentrations));
  }

  if (tubes.length === 0) return null;
  return mergeIndexedGeometries(tubes);
}
