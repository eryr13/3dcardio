// 4つの弁(大動脈弁・肺動脈弁・僧帽弁・三尖弁)の位置・向き・大きさを、大動脈基部
// フレーム(aorticRootMesh.ts)から推定する。
//
// 心臓メッシュ(ImageCAS由来)には弁のラベル情報が含まれていないため、実際の
// セグメンテーションではなく、解剖学的な位置関係からの推定である(大動脈基部の
// 簡易形状と同じ扱い、AorticRootFrame冒頭のコメント参照)。
//
// 経緯: 当初は「大動脈弁は冠動脈入口部のすぐ足側」という解剖学的な一般則からの
// 推定だったが、実データの裏付けが無く繰り返しズレが発生した。次に、ModelLoader.tsxの
// 座標ピッカーでユーザーが実測した値を、大動脈基部フレームの中心軸(axis)に対する
// frame.center基準の相対オフセット(ワールドXYZ方向、heartScale比率)として保持して
// いたが、その後aorticRootMesh.tsのcomputeAorticRootFrameがframe.center自体を
// MEASURED_AORTIC_VALVE_CENTER(実測した大動脈弁の位置)にアンカーするよう変更された
// ため(大動脈基部が肺動脈弁の領域に張り出して見えるバグの根本修正)、frame.center自体が
// 約0.3 heartScale比率も動くことになり、frame.center相対のオフセットのままでは
// 肺動脈弁・僧帽弁・三尖弁の3つがこの移動に連動して意図せずズレてしまう問題があった。
//
// 現在は、4弁ともMEASURED_LEFT_MAIN_OSTIUM(aorticRootMesh.ts)と同じ様式の、
// **絶対座標(mesh空間、Vector3)**として保持する。frame.centerの定義が将来変わっても
// (今回のように大きく動く変更であっても)、各弁の絶対的な位置は影響を受けない。
// 各定数はModelLoader.tsxの座標ピッカーでユーザーが実測した値(1点=1クリック、複数点の
// 平均)を、変更前のframe.center・heartScaleを使って絶対座標へ変換したもの——
// 大動脈弁・肺動脈弁・三尖弁は実測値そのもの、僧帽弁のみ実測データが無いため三尖弁を
// 鏡映した暫定推定値(ValveLegendのUIに明記)。

import { Vector3 } from "three";
import type { ValveId } from "../../types/anatomy";
import { computeAorticValveNormal, computeAorticValvePoint } from "./aorticRootMesh";
import type { AorticRootFrame } from "./aorticRootMesh";

export interface ValvePlacement {
  center: Vector3;
  /** 弁輪平面の法線(円盤メッシュを向ける向き)。 */
  normal: Vector3;
  /** 弁輪の半径(ワールド単位)。 */
  radius: number;
}

/** 各弁輪径の、心臓の幅(heartWidth)に対する比率。
 * 大動脈弁: 座標ピッカーで開口部の縁を6点実測し、最小二乗円フィットで求めた実測値
 * (フィット半径0.4015ワールド単位、heartWidth=2.9931との比率、残差は半径の2%未満と
 * 良好)。
 * 肺動脈弁・僧帽弁・三尖弁: 成人の標準的な弁輪径の目安(約26mm・33mm・38mm)を、
 * aorticRootMesh.tsのARCH_DIAMETER_HEART_WIDTH_RATIO(上行大動脈径30mm/心臓の幅
 * 120mm)と同じ実寸換算(心臓の幅を約120mmとみなす)で比率化したもの(未実測)。 */
const AORTIC_VALVE_DIAMETER_RATIO = 0.2683;
const PULMONARY_VALVE_DIAMETER_RATIO = 26 / 120;
const MITRAL_VALVE_DIAMETER_RATIO = 33 / 120;
const TRICUSPID_VALVE_DIAMETER_RATIO = 38 / 120;

/**
 * 絶対座標(mesh空間、Vector3)。ModelLoader.tsxの座標ピッカーでユーザーが実測した値
 * (変更前のframe.center・heartScaleを使って絶対座標へ一度だけ変換したもの)。
 *
 * 肺動脈弁: 実測4点平均。
 * 三尖弁:   実測4点平均。
 * 僧帽弁:   実測データが未提供のため、大動脈弁の左後方という一般的な位置関係からの
 *           暫定推定値(実測ではない)——要実測(ValveLegendのUIに明記)。
 *
 * 大動脈弁自体はaorticRootMesh.tsのcomputeAorticValvePoint(frame.centerがそのまま
 * MEASURED_AORTIC_VALVE_CENTER)を直接使うため、ここには含まない。
 */
const PULMONARY_ABSOLUTE_CENTER = new Vector3(0.0409, 1.0177, 0.404);
const MITRAL_ABSOLUTE_CENTER = new Vector3(0.2485, 1.8654, -0.2459);
const TRICUSPID_ABSOLUTE_CENTER = new Vector3(-1.0638, 1.4361, -0.3405);

/**
 * 大動脈基部フレームから、4つの弁の位置・向き・大きさを推定する。
 * frameがnull(冠動脈入口部の中心線データが無い等)の場合はnullを返す。
 */
export function computeValvePlacements(frame: AorticRootFrame, heartWidth: number): Record<ValveId, ValvePlacement> {
  const diameterOf = (ratio: number) => ratio * heartWidth;

  return {
    AORTIC: {
      center: computeAorticValvePoint(frame),
      normal: computeAorticValveNormal(frame),
      radius: diameterOf(AORTIC_VALVE_DIAMETER_RATIO) / 2,
    },
    PULMONARY: {
      center: PULMONARY_ABSOLUTE_CENTER.clone(),
      normal: frame.axis.clone(),
      radius: diameterOf(PULMONARY_VALVE_DIAMETER_RATIO) / 2,
    },
    MITRAL: {
      center: MITRAL_ABSOLUTE_CENTER.clone(),
      normal: frame.axis.clone(),
      radius: diameterOf(MITRAL_VALVE_DIAMETER_RATIO) / 2,
    },
    TRICUSPID: {
      center: TRICUSPID_ABSOLUTE_CENTER.clone(),
      normal: frame.axis.clone(),
      radius: diameterOf(TRICUSPID_VALVE_DIAMETER_RATIO) / 2,
    },
  };
}

/**
 * computeValvePlacementsの結果を検証してコンソールへログ出力する。
 * ValveOverlayが弁の表示を有効にした際に一度だけ呼ぶ(aorticRootMesh.tsの
 * computeAorticRootFrameの検証ログと同じ方針)。
 */
export function logValvePlacementVerification(placements: Record<ValveId, ValvePlacement>): void {
  const aorticCenter = placements.AORTIC.center;
  const aorticToPulmonary = placements.AORTIC.center.distanceTo(placements.PULMONARY.center);
  console.log(
    "[heartValveMesh] 大動脈弁-肺動脈弁間の距離検証: " +
      `${aorticToPulmonary.toFixed(4)}(近接しているが別の位置にあることの目安、0に近すぎる/離れすぎる場合は要調整)`,
  );
  const ids: ValveId[] = ["AORTIC", "PULMONARY", "MITRAL", "TRICUSPID"];
  const normal = placements.AORTIC.normal.clone().normalize();
  const planeOffsets = ids.map((id) => normal.dot(placements[id].center.clone().sub(aorticCenter)));
  const maxPlaneOffset = Math.max(...planeOffsets.map(Math.abs));
  console.log(
    "[heartValveMesh] 4弁の同一平面性検証(弁輪平面法線方向のオフセット、0に近いほど同一平面): " +
      ids.map((id, i) => `${id}=${planeOffsets[i].toFixed(4)}`).join(", ") +
      ` (最大=${maxPlaneOffset.toFixed(4)})`,
  );
}
