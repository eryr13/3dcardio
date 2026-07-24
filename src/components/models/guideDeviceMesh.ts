// Phase 9: ガイドワイヤー・ガイディングカテーテルのデモ表示。
//
// これは物理シミュレーションではなく、あらかじめ定義したスプライン曲線(カテーテル)+
// 中心線グラフ(ワイヤー)に沿ってチューブ状のジオメトリを配置する静的なデモ表示である。
// 大動脈の3Dモデルは無いため、カテーテルの経路は「冠動脈入口部(オスティウム)を
// 終点とし、心臓の重心から見た向き・頭側・側方という局所基準系上のオフセットで
// 定義した制御点」を通るCatmullRom スプラインとして構築する(大動脈壁との厳密な
// 接触計算は行わない)。
//
// 対象がRCAかそれ以外(LCA=LAD/LCX)かで、カテーテル先端のカーブの大きさ・向きを
// 変える(実際のJR/JL・EBUカテーテルの違いを大まかに模したもの。正確な形状再現は
// 目的ではない)。

import { CatmullRomCurve3, Vector3 } from "three";
import type { BufferGeometry, Color, Mesh } from "three";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
import type { VesselId } from "../../types/anatomy";
import type { GuideAccessRoute } from "../../types/guideDevice";
import { buildBranchLinks } from "../../utils/contrastFlow";
import {
  ARCH_TRUNK_T_FRACTION,
  BRACHIOCEPHALIC_ORIGIN_T_FRACTION,
  computeAorticArchControlPoints,
  distanceFromAxis,
  evaluateAorticArchRadius,
  evaluateAorticBrachiocephalicRadius,
  evaluateAorticRootRadius,
  pointAtRelativeHeight,
  projectOntoFrame,
  sampleAorticArchTrunk,
  sampleAorticBrachiocephalicBranch,
  sampleAorticDescendingBranch,
} from "./aorticRootMesh";
import type { AorticRootFrame } from "./aorticRootMesh";
import { buildTubeFromPoints } from "./stentLatticeMesh";
import { sampleCenterline } from "./vesselCenterline";
import { getBranch, getMainTrunk } from "./vesselGraph";
import type { CenterlineBranch, VesselGraph } from "./vesselGraph";

/**
 * 指定した枝から本幹(根)まで、親をたどって祖先の連なりを求める
 * (utils/contrastFlow.tsのbuildBranchLinksは枝同士の親子関係だけを返し、祖先を
 * さかのぼって並べる関数までは提供していないため、ここに用意する)。
 * 返り値は本幹が先頭、対象の枝が末尾になる順序。
 */
export function getAncestryChain(graph: VesselGraph, targetBranchId: string): CenterlineBranch[] {
  const links = buildBranchLinks(graph);
  const chain: CenterlineBranch[] = [];
  const visited = new Set<string>();
  let currentId: string | null = targetBranchId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const branch = getBranch(graph, currentId);
    if (!branch) break;
    chain.push(branch);
    currentId = links.get(currentId)?.parentBranchId ?? null;
  }
  return chain.reverse();
}

interface ChainPathSample {
  point: Vector3;
  radius: number;
}

/**
 * 本幹(起始部)から対象の枝まで、途中の分岐を経由しながら実際にワイヤーが通る
 * 経路を、位置+半径のペアとして求める。祖先の枝は分岐点(次の枝が分かれる位置)
 * までを含み、対象の枝自身はt=0からtargetProgress(0〜1)までを含む。各区間の
 * 終端では、中心線の生のサンプル点だけでなくsampleCenterlineによる補間点も
 * 追加し、進行度アニメーション中に点が飛び飛びにならないようにする。
 * buildBranchPathPoints・buildWireCenterlineの共通実装。
 */
function walkChainPath(graph: VesselGraph, targetBranchId: string, targetProgress: number): ChainPathSample[] {
  const links = buildBranchLinks(graph);
  const chain = getAncestryChain(graph, targetBranchId);
  const result: ChainPathSample[] = [];

  for (let i = 0; i < chain.length; i++) {
    const branch = chain[i];
    const isTarget = i === chain.length - 1;
    const maxT = isTarget
      ? Math.max(0, Math.min(1, targetProgress))
      : Math.max(0, Math.min(1, links.get(chain[i + 1].id)?.divergenceT ?? 1));

    for (const p of branch.points) {
      if (p.t > maxT) break;
      result.push({ point: p.position.clone(), radius: p.radius });
    }
    const sample = sampleCenterline(branch.points, maxT);
    const last = result[result.length - 1];
    if (!last || last.point.distanceToSquared(sample.point) > 1e-10) {
      result.push({ point: sample.point.clone(), radius: sample.radius });
    }
  }
  return result;
}

/**
 * 本幹(起始部)から対象の枝まで、途中の分岐を経由しながら実際にワイヤーが通る
 * 経路の点列を求める(walkChainPathの位置成分だけを取り出したもの)。
 */
export function buildBranchPathPoints(graph: VesselGraph, targetBranchId: string, targetProgress: number): Vector3[] {
  return walkChainPath(graph, targetBranchId, targetProgress).map((s) => s.point);
}

/**
 * 冠動脈入口部(オスティウム)から対象の枝の末端(t=1)までの完全な経路を、
 * 各点の局所血管半径とあわせて求める。ワイヤーの挿入アニメーション
 * (buildGuideWireGeometry)が、この経路全体の弧長を基準に進行度を計算するのに使う
 * (対象の枝が孫枝の場合でも、祖先の枝を含めた経路全体の長さで進行度を測ることで、
 * 進行度がわずかに正になった瞬間に祖先の枝全体が一気に出現する不具合を避ける)。
 */
export function buildWireCenterline(graph: VesselGraph, targetBranchId: string): { points: Vector3[]; radii: number[] } {
  const samples = walkChainPath(graph, targetBranchId, 1);
  return { points: samples.map((s) => s.point), radii: samples.map((s) => s.radius) };
}

export type CoronaryApproachShape = "RCA" | "LCA";

function shapeForVessel(vesselId: VesselId): CoronaryApproachShape {
  return vesselId === "RCA" ? "RCA" : "LCA";
}

/**
 * アクセスルート別の、体外側〜上行大動脈手前までの経路オフセット(オスティウムを
 * 基準にした[頭側, 心臓中心から見て外向き, 側方]、entryLateral軸で解釈される——
 * どちらの冠動脈を狙うかに関わらず穿刺部位は体に対して一定の側なので、狙う血管
 * ごとに向きが変わる側方軸とは別の固定軸を使う)。いずれも心臓から十分離れた
 * (heartScaleの1.5倍以上の)領域にとどまるため、心筋を貫通する心配はない。
 *
 * 大腿アプローチ: 鼠径部(大腿動脈)は心臓よりずっと下にあり、腸骨動脈・腹部大動脈・
 * 下行大動脈を通って大動脈弓を越えるまで、経路の大半が心臓より低い位置にある。
 * 橈骨アプローチ: 手首から上腕動脈・腋窩動脈・鎖骨下動脈・腕頭動脈を経て弓部へ
 * 到達するため、経路は常に心臓より高い位置にある。
 */
const FEMORAL_ENTRY_OFFSETS: readonly [number, number, number][] = [
  [-4.5, 0.4, -0.3],
  [-1.0, 1.0, -0.4],
];
const RADIAL_ENTRY_OFFSETS: readonly [number, number, number][] = [[4.6, 1.7, 1.6]];

/**
 * カテーテル先端がオスティウムへ係合する深さ(heartScaleに対する比率)。ガイディング
 * カテーテルは入口部にエンゲージするのみで冠動脈の奥へは入り込まないため、ごく浅い
 * 値にする(冠動脈の中へ進むのはガイドワイヤーの役目)。
 */
const TIP_ENGAGEMENT_DEPTH_FRACTION = 0.02;
/**
 * 「し」の字(J字)エンゲージ経路の制御点(いずれも大動脈基部フレームの局所半径に
 * 対する到達率・AORTIC_ROOT_PROFILEのup相対値で定義し、内腔からはみ出さないことを
 * 構築時点で保証する)。実際のJudkinsカテーテルの手技を模す:
 *   1. TOP: 上行大動脈側から円筒に入る点(軸付近)
 *   2. MID_DESCENT: 洞管接合部あたりの高さで、対側壁方向へ寄りながら下降する点
 *   3. FLOOR: 円筒下端付近(大動脈弁のすぐ上、弁輪の高さ)まで落とし込む「底」の点。
 *      対側壁に深く当たり、支点(バックアップ)になる——LCA(JL/EBU型)はRCA(JR型)より
 *      深く落とし込む(ユーザー要件:「LCAはRCAより深い、対側壁をしっかり使うカーブ」)
 *   4. HOOK: 底からやや上がり、角度も対側壁側から対象冠動脈入口部側へ回転した点。
 *      底で反転し下から持ち上がる「し」の字のカーブをここで作る
 * HOOKの角度は、frame.rcaAngle/leftAngle(RCA/LAD+LCXの平均)ではなく、対象冠動脈
 * 自身の実際の入口部方向(ownAngle、buildCatheterApproach内で個別に算出)へ寄せる
 * ——LADとLCXは実際には別の角度にあるため、平均値ではなく個別の実データを使う。
 *
 * HOOK自体は壁基準(wallHookPoint、高さ・角度・到達率とも従来通りの固定式)で求めた
 * うえで、そこから対象冠動脈自身の実際の入口部位置(ostiumPosition)へ、直線補間で
 * HOOK_OSTIUM_BLENDの割合だけ寄せる。LAD/LCXは解剖学的にLMT分岐後の構造のため、
 * 実際の入口部は壁基準の到達率(HOOK_RADIUS_FRACTION=0.4、壁の内側)よりかなり
 * 外側(到達率1.6前後)にある。以前はHOOKの高さだけを実際の入口部の高さへ寄せて
 * いたが、そうすると高さは合っても到達率(半径方向)は壁基準の小さい値のままなので、
 * HOOKから先端(tipAlignmentPoint→ostiumPosition)までのごく短い区間だけで壁内から
 * 壁の1.6倍外側までの半径変化を一気に埋めることになり、そこだけ不自然に急激に
 * 膨らんで見える不具合になっていた(ユーザー報告:「カテーテルが上に飛び上がって
 * しまっている」——実測でも、内腔到達率がこの区間だけ1点間隔で0.95→1.59まで跳ね
 * 上がっていたことを確認した)。高さ・角度・到達率をそれぞれ別々の割合で個別に
 * 実際の入口部へ寄せるのではなく、HOOK自体の3D座標を実際の入口部の3D座標へ直線
 * 補間することで、どの成分についても不連続な跳躍が起きないようにする。
 */
const LUMEN_TOP_UP_RELATIVE = 2.9;
const LUMEN_TOP_RADIUS_FRACTION = 0.15;
const MID_DESCENT_UP_RELATIVE = 0.7;
const MID_DESCENT_RADIUS_FRACTION = 0.5;
/** 底の高さ(up相対値)。LCAはRCAより深く(弁輪に近く)落とし込む。 */
const RCA_FLOOR_UP_RELATIVE = -0.3;
const LCA_FLOOR_UP_RELATIVE = -0.5;
/** 底での対側壁への到達率。LCAはRCAより深く壁に当てる。 */
const RCA_FLOOR_WALL_FRACTION = 0.7;
const LCA_FLOOR_WALL_FRACTION = 0.95;
/** 反転点(フック)の高さ(底の高さから入口部の高さ=0までの間の、底からの距離の割合)。壁基準のwallHookPointの計算にのみ使う。 */
const HOOK_UP_RELATIVE_FRACTION = 0.55;
/** 反転点の角度(対側壁の角度から対象入口部自身の角度へ、この割合だけ回転させる)。壁基準のwallHookPointの計算にのみ使う。 */
const HOOK_ANGLE_BLEND = 0.65;
/** 壁基準のwallHookPointの到達率。 */
const HOOK_RADIUS_FRACTION = 0.4;
/** wallHookPoint(壁基準)から対象入口部自身の実際の位置(ostiumPosition)へ、直線補間で寄せる割合。 */
const HOOK_OSTIUM_BLEND = 0.4;
/**
 * TOP/MID_DESCENT/FLOOR(底)の角度も、対側壁の角度(frame.rcaAngle/leftAngle、
 * RCA目標かLCA目標かの2択でしか変わらない)から対象冠動脈自身の角度(ownAngle)へ、
 * この割合だけ回転させる。LAD/LCXはどちらもshape="LCA"のため、この寄せが無いと
 * TOP/MID_DESCENT/FLOORが完全に同一の点になり、対象血管を切り替えても経路の
 * 大部分が区別できなくなる(HOOKだけでは差が小さすぎる——LAD/LCXのownAngleの差は
 * 数度程度で、HOOK_ANGLE_BLEND(0.65)をかけてもなお視覚的にほぼ同じに見える)。
 * HOOK_ANGLE_BLENDより小さくして、「対側壁にしっかり当ててから反転する」という
 * J字カーブの基本形は保つ。
 */
const MAIN_LOOP_ANGLE_BLEND = 0.25;
/**
 * 大動脈基部フレームが得られない場合(未ロード等)の底点フォールバック
 * (heartScaleに対する比率、up/outward成分。側方成分無しの簡易版)。
 */
const FALLBACK_BULGE_UP_FRACTION = 0.15;
const FALLBACK_BULGE_OUTWARD_FRACTION = 0.45;
/**
 * 上行大動脈点のオフセット(heartScaleに対する比率、大動脈基部フレームが得られない
 * 場合のフォールバックのみで使う)。内腔を出た後、さらに頭側・外向きへ進み、
 * 心臓から明確に離れる。
 */
const AORTA_UP_FRACTION = 1.4;
const AORTA_OUTWARD_FRACTION = 0.6;
/**
 * 大動脈基部フレームが得られる場合、体外側の経路(aortaPoint・entryPoints)は
 * 実際に表示している弓部・下行大動脈・腕頭動脈(aorticRootMesh.tsの
 * computeAorticArchControlPoints、AorticRootOverlayが同じ点から可視化用チューブを
 * 作る)に沿わせる。橈骨アプローチ(右橈骨、腕頭動脈経由)は腕頭動脈の終端
 * (brachiocephalicEnd)、大腿アプローチは下行大動脈の終端(descendingEnd)を、
 * そのまま体外側の穿刺部位とする——「どこまで伸ばすか」を可視化ジオメトリ側と別々の
 * 定数で持つと、片方だけ調整したときに食い違って経路が血管の外に突き抜けて見える
 * (過去に実際に起きた不具合)。必ずcomputeAorticArchControlPointsの値をそのまま使うこと。
 *
 * 大動脈基部の内腔からはみ出さないことを検証・補正する対象とする高さの範囲
 * (AORTIC_ROOT_PROFILEのup相対値。この範囲外の点(体外側の経路など)は対象外)。
 * 下限はLCA_FLOOR_UP_RELATIVE(-0.5)より十分下まで確保し、底点付近でCatmullRomが
 * 予測しにくく膨らんでも(=底より下に突き抜けても)検証・補正の対象に含める。
 */
const AORTIC_CONTAINMENT_UP_RELATIVE_MIN = -0.9;
const AORTIC_CONTAINMENT_UP_RELATIVE_MAX = 3.2;
/** 補正後に局所半径の何%以内に収めるか(ぴったり境界に置くと数値誤差で再びはみ出しかねないため、わずかに余裕を持たせる)。 */
const AORTIC_CONTAINMENT_SAFETY_MARGIN = 0.95;

/** 干渉補正1回あたりに点を押し出す距離(heartScaleに対する比率)。 */
const CORRECTION_STEP_FRACTION = 0.03;
/** 干渉補正の最大反復回数(通常は数回〜十数回で収束する。実測ではRCA/LAD/LCXいずれも10回未満)。 */
const CORRECTION_MAX_ITERATIONS = 60;
/**
 * オスティウムからこの距離(TIP_ENGAGEMENT_DEPTH_FRACTIONの倍数)未満の点は干渉補正の
 * 対象から除外する。オスティウム自身は定義上心筋表面に接しているため、この近傍の点を
 * 無理に押し出すと「先端が入口部にエンゲージしている」という前提が崩れてしまう。
 */
const TIP_CORRECTION_GUARD_MULTIPLIER = 1.5;
/**
 * 心筋干渉補正(ensurePathClearsHeartMesh)のガード距離は、通常はTIP_CORRECTION_GUARD_MULTIPLIER
 * ベースのtipGuardDistance(オスティウムのごく近傍のみ)で十分だが、HOOKから先端までの
 * 区間(実際には未モデル化のLMT——大動脈壁からLAD/LCXの分岐点まで—— に相当する)は、
 * この関数が「心筋メッシュの内側」と判定しうる、心臓表面に沿った領域を通る。
 * moveOutsideHeartMeshは心臓の重心から見た放射方向へ点を押し出すため、凹んだ表面
 * 形状の近くではこの押し出しが何度も繰り返されて大きく迂回し、経路が一点だけ大きく
 * 跳ね上がって見える不具合になっていた(実測: LCXでY座標が0.7付近から1.2付近まで
 * 1点間隔で跳ね上がっていた——heartMeshをnullにして同じ補正を無効化すると、この
 * 跳躍は完全に消え、元のCatmullRom曲線自体は滑らかであることを確認した)。
 * HOOKから先端までの区間全体を、tipGuardDistanceと同じ理由(この区間は解剖学的に
 * 心筋表面に沿っており、外へ逃がせる「外側」が実質存在しない)でガード対象から除外する
 * ——ガード距離をHOOKからオスティウムまでの実際の距離ベースにすることで、対象血管ごとに
 * 適切な範囲だけを除外する(RCAのようにHOOKが壁のすぐ近くにある場合はガード距離も
 * 小さいままになる)。
 */
const HOOK_GUARD_MARGIN = 1.15;

/** 心臓メッシュ(Mesh)ごとに計算済みの凸包を再利用するキャッシュ。凸包の計算はメッシュの
 * 全頂点を使うため軽くないが、対象血管やアクセスルートを切り替えるたびに毎回計算し直す
 * 必要はなく、同じMeshインスタンスに対しては一度計算すれば十分なため。 */
const heartConvexHullCache = new WeakMap<Mesh, ConvexHull>();

function getHeartConvexHull(mesh: Mesh): ConvexHull {
  const cached = heartConvexHullCache.get(mesh);
  if (cached) return cached;
  const hull = new ConvexHull().setFromObject(mesh);
  heartConvexHullCache.set(mesh, hull);
  return hull;
}

/**
 * pointが心筋メッシュの内側にあるかどうかを判定する。心筋メッシュ自体(凹形状)に対して
 * 毎回レイキャストするのは低速すぎる(実測: 約5万三角形のメッシュに対し数千回のレイ
 * キャストで数十秒かかった)ため、代わりにメッシュの凸包(ConvexHull、一度だけ計算して
 * 再利用)で判定する。凸包は実メッシュを内包する(実メッシュ⊆凸包)ので、「凸包の外側」
 * は必ず「実メッシュの外側」でもある——安全側に倒れた判定になる(凹んだ領域では実際より
 * やや過剰に「内側」と判定されうるが、それは経路を心臓からわずかに余分に離す方向にしか
 * 働かないため、貫通を見逃すことはない)。
 *
 * さらに、メッシュ全体はその境界球(中心heartCentroid、半径heartScale)に必ず収まるため、
 * 境界球の外側にある点は凸包の判定を待たずに「確実に外側」と即断できる(安価な事前
 * チェック)。体外側の制御点はほぼ全てこの事前チェックだけで済むため、実際に凸包の
 * containsPointを呼ぶのはオスティウム近傍の少数の点に限られる。
 */
function isInsideHeartMesh(hull: ConvexHull, heartCentroid: Vector3, heartScale: number, point: Vector3): boolean {
  if (point.distanceTo(heartCentroid) > heartScale) return false;
  return hull.containsPoint(point);
}

/**
 * pointが心筋メッシュの内側にある場合、referenceCenter(心臓の重心)から見て外向きの
 * 方向へ少しずつ押し出し、外側に出るまで繰り返す。ユーザー要件「経路上の各点について
 * 心臓メッシュとの干渉がないことを検証し、貫通しそうな場合は制御点を心臓の外側へ移動
 * させて回避する」をそのまま実装したもの。
 */
function moveOutsideHeartMesh(hull: ConvexHull, heartCentroid: Vector3, heartScale: number, point: Vector3): Vector3 {
  const corrected = point.clone();
  for (let i = 0; i < CORRECTION_MAX_ITERATIONS; i++) {
    if (!isInsideHeartMesh(hull, heartCentroid, heartScale, corrected)) break;
    const direction = corrected.clone().sub(heartCentroid);
    if (direction.lengthSq() < 1e-10) direction.set(0, 1, 0);
    direction.normalize();
    corrected.addScaledVector(direction, heartScale * CORRECTION_STEP_FRACTION);
  }
  return corrected;
}

/** 角度bからaへの最短の符号付き差(ラジアン、-π〜π)。フック点の角度を対側壁側から
 * 対象入口部側へ回転させる際、常に短い方の弧をたどるようにするために使う。 */
function angularDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * pointが大動脈基部フレームの内腔(ensurePathStaysInsideAorticRootが保証する高さ範囲・
 * 局所半径以内)に収まっているかどうか。心筋メッシュ(心臓モデルには大動脈の内腔が
 * 別メッシュとして分離されていない)は、この領域を「心筋の内部」と誤判定しうる——
 * 実際には大動脈の内腔であり心筋そのものではないため、この領域内の点は心筋干渉の
 * 補正対象から除外する(ensurePathClearsHeartMesh参照)。
 */
function isWithinAorticRootLumen(frame: AorticRootFrame, point: Vector3): boolean {
  const { upRelative } = projectOntoFrame(frame, point);
  if (upRelative < AORTIC_CONTAINMENT_UP_RELATIVE_MIN || upRelative > AORTIC_CONTAINMENT_UP_RELATIVE_MAX) return false;
  return distanceFromAxis(frame, point) <= evaluateAorticRootRadius(frame, point) * AORTIC_CONTAINMENT_SAFETY_MARGIN;
}

/**
 * 密な点列の各点(オスティウム直近の短いスタブを除く)について心筋メッシュとの干渉を
 * 検証し、内側と判定された点を外側へ押し出す。オスティウム自身とその直近のスタブは、
 * 定義上心筋表面に接しているため対象外にする(押し出すと先端のエンゲージが崩れる)。
 * 大動脈基部フレームの内腔に収まっている点(isWithinAorticRootLumen)も対象外にする
 * ——心筋メッシュには大動脈の内腔が別メッシュとして分離されておらず、実測では
 * この内腔領域の大部分がそもそも心筋メッシュの「内部」(=空洞のない実質組織)である
 * ことを確認している(内腔の中心軸付近まで押し出しても心筋メッシュの内部と判定される
 * ——つまりこの領域には経路点を移動して逃がせる「外」が存在しない)。この領域の
 * 貫通の見た目は、経路点の補正では原理的に解消できず、AorticRootOverlay側の表示
 * (心筋メッシュを大動脈基部フレームの形状でクリッピングする、buildAorticRootGeometry
 * 参照)で対処する。
 */
function ensurePathClearsHeartMesh(
  points: Vector3[],
  ostiumPosition: Vector3,
  heartMesh: Mesh,
  heartCentroid: Vector3,
  heartScale: number,
  tipGuardDistance: number,
  aorticRootFrame: AorticRootFrame | null,
): Vector3[] {
  const hull = getHeartConvexHull(heartMesh);
  return points.map((point) => {
    if (point.distanceTo(ostiumPosition) < tipGuardDistance) return point.clone();
    if (aorticRootFrame && isWithinAorticRootLumen(aorticRootFrame, point)) return point.clone();
    if (!isInsideHeartMesh(hull, heartCentroid, heartScale, point)) return point.clone();
    return moveOutsideHeartMesh(hull, heartCentroid, heartScale, point);
  });
}

function polylineLength(points: Vector3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += points[i - 1].distanceTo(points[i]);
  return total;
}

/**
 * pointsの各内部点における局所曲率ベクトル(隣接2区間の単位接線の差unitIn-unitOutを、
 * 前後区間の平均弧長で割ったもの)を返す。大きさは真の曲率(単位弧長あたりの向きの
 * 変化量、たとえば半径Rの円弧なら1/R)に相当する——鋭く曲がっている箇所ほど大きい。
 * 向きは局所的な湾曲の外側(凸側)を向く(区間が右へ曲がればベクトルは左を向く、が
 * 常に「湾曲の外側」を向く、というのがこのベクトルの幾何学的な意味——導出は
 * pressAgainstOuterWallのコメント参照)。先頭・末尾は隣接区間が定義できないため
 * ゼロベクトルにする。配列の前後を反転しても値は変わらない(unitIn/unitOutが入れ替わり
 * 符号が2回反転して打ち消し合うため)、そのため呼び出し側は経路の向き(体外側→大動脈基部
 * 側か、その逆か)を気にせず使ってよい。
 *
 * 平均弧長で割る理由: sampleAorticArchTrunk/sampleAorticDescendingBranchが返す点列は
 * 論理t値に対して等間隔なだけで、弧長に対しては等間隔ではない(CatmullRomの弧長は
 * 論理tに対して一様ではなく、特に湾曲がきつい弓頂部付近で1ステップあたりの弧長が
 * 大きく変動する)。unitIn-unitOutをそのまま(弧長で正規化せずに)使うと、これは
 * 「1サンプルあたりの向きの変化量」であり、同じ真の曲率でもサンプル間隔が広いほど
 * 大きな値になってしまう——実測で、サンプリングの粗密が変わる箇所(弓頂部そのものや、
 * CatmullRomの弧長が急に変化する区間)で、実際には滑らかな曲線に対して見かけ上の
 * 曲率スパイクが生じることを確認した(弓頂部での過大な折れと、湾曲とは無関係な
 * 区間での見かけ上の折れの両方)。平均弧長で割ることで、真の(サンプリング密度に
 * 依存しない)曲率を得られ、この不具合が構造的に起こらなくなる。
 */
export function computeCurvatureVectors(points: Vector3[]): Vector3[] {
  const vectors = points.map(() => new Vector3());
  for (let i = 1; i < points.length - 1; i++) {
    const segmentIn = points[i].clone().sub(points[i - 1]);
    const segmentOut = points[i + 1].clone().sub(points[i]);
    const lengthIn = segmentIn.length();
    const lengthOut = segmentOut.length();
    if (lengthIn < 1e-9 || lengthOut < 1e-9) continue;
    const unitIn = segmentIn.multiplyScalar(1 / lengthIn);
    const unitOut = segmentOut.multiplyScalar(1 / lengthOut);
    const averageLength = (lengthIn + lengthOut) / 2;
    vectors[i].copy(unitIn).sub(unitOut).multiplyScalar(1 / averageLength);
  }
  return vectors;
}

/** pointsのcomputeCurvatureVectors(平滑化前、生の値)の最大の大きさを返す。
 * pressAgainstOuterWallのreferenceMaxMagnitude(呼び出し側が別の区間の基準値を
 * 渡したい場合に使う)を求めるための補助。 */
function computeMaxRawCurvatureMagnitude(points: Vector3[]): number {
  let maxMagnitude = 0;
  for (const vector of computeCurvatureVectors(points)) maxMagnitude = Math.max(maxMagnitude, vector.length());
  return maxMagnitude;
}

/**
 * 血管の中心線からどれだけ外側(大弯)へ寄せてカテーテルの経路とするかを、当てずっぽうの
 * 定数ではなく、実際に内腔の壁に接するまでの量として解析的に求める。
 *
 * 物理的な根拠: ある程度の硬さを持つ実際のガイディングカテーテルは、まっすぐであろうと
 * する(曲げ剛性に抗って曲がるのを嫌う)。大動脈弓のように内腔の中心線自体が大きく
 * 湾曲している区間では、カテーテルは中心線ほど鋭くは曲がれないため、内腔の外側
 * (大弯)の壁に押し付けられながら、中心線よりゆるやかな(=より直線に近い)経路を取る
 * ——これは「経路長を最小化する」(たわんだ紐が湾曲の内側=小弯に寄る)のとは逆に、
 * 「曲率(曲がりの鋭さ)を最小化する」ことに相当し、内腔という制約の中で実現できる
 * 最小曲率の経路は、幾何学的に内腔の外側の壁面をなぞる経路になる(壁に接するまでは
 * 直進し、壁に押し付けられた区間だけ壁なりに曲がる、という古典的な接触問題と同じ形)。
 *
 * 実装: 中心線の各点における局所曲率ベクトル(computeCurvatureVectors、向きは
 * 湾曲の外側)へ、点列全体で共通の係数kを掛けてオフセットする。「共通の係数」で
 * あることが重要——各点を独立に(局所的な曲率だけを見て)動かすと、曲率推定の
 * 揺らぎやサンプリングの継ぎ目でオフセット量が不連続に変化し、経路全体としては
 * 不自然な急な折れ曲がりになることが実測で分かっている(過去の実装の failure mode)。
 * kは、最も鋭く曲がっている点(=局所曲率ベクトルが最大の点)で、ちょうど内腔の壁に
 * 触れる直前(containmentMargin、壁との数値的な余裕)まで達するように解析的に決める
 * ——「それ以上は物理的に壁が止める」という接触の条件をそのまま数式にしたものが
 * containmentMargin = k * max(|curvatureVector|) であり、kについて解けば
 * k = containmentMargin / max(|curvatureVector|) となる(曲率ベクトルの大きさは
 * 各点の局所半径に掛けてからオフセット量にするため、半径は式から相殺されず正しく
 * 反映される)。曲率がほぼ0の区間(直線に近い上行大動脈・下行大動脈・腕頭動脈)では
 * 曲率ベクトル自体がほぼ0になるため、この点列はほとんど動かない。
 *
 * pointsの先頭・末尾付近(endpointTaperCount点分)は、オフセット量を0まで線形に
 * 減衰させる。computeCurvatureVectorsは先頭・末尾そのものは定義上0を返すが、その
 * 1つ内側の点では実際の曲率(0でないことが多い)がそのまま使われるため、末尾側で
 * オフセット量が「非0→0」と1点だけで急に落ちることがある——この点列の直後に
 * 別の(このオフセット処理を適用しない)点列を連結する呼び出し側(橈骨アプローチの
 * 腕頭動脈直線区間など)では、この急な落ち込みが2点間の間隔だけ不自然に広がる形で
 * 現れる。先頭・末尾に向けて滑らかに0へ減衰させることで、連結先が何であっても
 * (別の点列でも、単に配列の端でも)継ぎ目がなだらかになることを保証する。
 *
 * pointsはそのまま(並べ直さず)使う——computeCurvatureVectors自体が弧長で正規化された
 * 真の曲率を返すため、サンプリング密度が変化する箇所(弓頂部や、複数のsample関数を
 * 連結した継ぎ目)でも汚染されない。
 */
const CATHETER_WALL_CONTACT_MARGIN = 0.9;
/** pressAgainstOuterWallが先頭・末尾でオフセットを0まで線形に減衰させる区間の点数。 */
const CATHETER_WALL_CONTACT_TAPER_COUNT = 5;
/**
 * 曲率ベクトル場を近傍平均で滑らかにする反復回数(pressAgainstOuterWall参照)。
 * 実際のガイディングカテーテルは有限の曲げ剛性を持ち、無限に短い区間の曲率の
 * 揺らぎに瞬時に反応するわけではなく、自身の剛性が支配するある程度の長さに
 * わたって平均化された曲がり方に応じてしなう——単一の点だけが際立って鋭い
 * (隣接点よりずっと大きい)曲率を持っていても、カテーテルはそこだけ瞬間的に
 * 折れ曲がったりせず、周囲の区間全体でその曲がりを分け合う。この平滑化を
 * 怠ると、computeCurvatureVectorsが弧長で正規化した「真の曲率」であっても
 * なお残る離散化・サンプリングの点ごとの揺らぎ(平均化はバイアスは除くが
 * ノイズそのものは除かない)が、大きな係数kでそのまま拡大されてしまい、
 * 実測でオフセット後の経路に70度を超える折れ(通常の湾曲では見えるはずのない
 * 急峻な二重の折れ)が生じることを確認した。
 */
const CATHETER_CURVATURE_SMOOTHING_PASSES = 6;

function smoothVectorField(vectors: Vector3[], passes: number): Vector3[] {
  let current = vectors.map((v) => v.clone());
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((v) => v.clone());
    for (let i = 1; i < current.length - 1; i++) {
      next[i] = current[i - 1].clone().add(current[i]).add(current[i + 1]).multiplyScalar(1 / 3);
    }
    current = next;
  }
  return current;
}

/**
 * kは平滑化「前」の生の曲率(rawCurvatureVectors)の最大値を基準に決める——平滑化後の
 * 最大値を基準にすると、平滑化によって最大点自身の値が(近傍の小さい値と混ざって)
 * 下がった分だけkが大きく再計算されてしまい、他の点のオフセットがその分だけ余計に
 * 増幅されてしまう(実測: 橈骨アプローチの腕頭動脈分岐の継ぎ目付近で、平滑化前は
 * 約98度だった見かけ上の折れが、平滑化後の最大値でkを引き直したことでかえって
 * 約140度まで悪化する逆効果を確認した)。
 *
 * 生のkを平滑化後のベクトルに適用することには、副作用として構造的に嬉しい性質がある:
 * 近傍平均(smoothVectorField)は凸結合(3点の平均)の反復であるため、平滑化後の
 * どの点のベクトルの大きさも、平滑化前の最大値を超えることは数学的にあり得ない
 * (三角不等式|a+b+c|/3 ≤ max(|a|,|b|,|c|)より)。したがって
 * offset = k * smoothedVector * radii[i] は、containmentMargin*radii[i]を
 * 追加のクランプ処理なしに常に下回ることが保証される——「壁を物理的に貫通できない」
 * という制約が、後付けの補正ではなく計算の構造そのものから導かれる。
 *
 * referenceMaxMagnitude(省略可): kの基準となる最大曲率を、渡されたpoints自身の
 * 最大値ではなく、呼び出し側が別途指定した値で置き換える。橈骨アプローチの幹区間
 * (trunkPoints)は弓頂部よりずっと手前(BRACHIOCEPHALIC_ORIGIN_T_FRACTION)で
 * 打ち切られており、その短い区間自体はほぼ直線に近い(実測でも1点あたりの折れが
 * 1度未満)。この短い、ほとんど曲がっていない区間「自身」の中での最大値を基準にkを
 * 決めてしまうと、その最大値自体が非常に小さいためkが不自然に大きくなり、点ごとの
 * わずかな曲率のばらつきが増幅されて、実際には存在しない急な折れが生じる(実測で
 * 確認: 大腿アプローチ(弓全体を対象にpressAgainstOuterWallを1回で適用)では起きず、
 * 橈骨アプローチの幹区間だけ切り出して単独できを決めた場合にのみ発生)。弓全体
 * (大腿アプローチが対象にする全区間)の生の最大曲率を共通の基準として渡すことで、
 * 「この経路が壁に触れるとしたら、弓の中で最も鋭く曲がる箇所と同じだけの余裕度で
 * 触れる」という一貫した物理的基準になり、ほとんど曲がっていない区間では
 * (基準に対して相対的に小さい曲率のため)自然に小さいオフセットしか生じなくなる。
 */
function pressAgainstOuterWall(points: Vector3[], radii: number[], containmentMargin: number, referenceMaxMagnitude?: number): Vector3[] {
  const rawCurvatureVectors = computeCurvatureVectors(points);
  const curvatureVectors = smoothVectorField(rawCurvatureVectors, CATHETER_CURVATURE_SMOOTHING_PASSES);
  let maxRawMagnitude = referenceMaxMagnitude ?? 0;
  if (referenceMaxMagnitude === undefined) {
    for (const vector of rawCurvatureVectors) maxRawMagnitude = Math.max(maxRawMagnitude, vector.length());
  }
  if (maxRawMagnitude < 1e-9) return points.map((p) => p.clone());
  const k = containmentMargin / maxRawMagnitude;
  const taperCount = Math.min(CATHETER_WALL_CONTACT_TAPER_COUNT, Math.floor((points.length - 1) / 2));
  return points.map((point, i) => {
    const edgeDistance = Math.min(i, points.length - 1 - i);
    const taper = taperCount > 0 ? Math.min(1, edgeDistance / taperCount) : 1;
    const rawOffset = curvatureVectors[i].clone().multiplyScalar(k * radii[i] * taper);
    const maxOffsetLength = containmentMargin * radii[i];
    if (rawOffset.length() > maxOffsetLength) rawOffset.setLength(maxOffsetLength);
    return point.clone().add(rawOffset);
  });
}

/**
 * pressAgainstOuterWallは1本の滑らかな中心線(同一のbuildAorticArchCurve由来)を
 * 前提に、単一の解析的なk(曲率最大点で壁に触れる量)で決めている。橈骨アプローチの
 * 腕頭動脈のように、湾曲するtrunk(sampleAorticArchTrunk)と直線近似のbranch
 * (sampleLinearArchBranch)を継ぎ足す場合、その継ぎ目には実際の血管の湾曲とは
 * 無関係な、直線近似というモデル化そのものに由来する人為的な折れが残る(trunk単体で
 * kを決めているため、pressAgainstOuterWall自身はこの継ぎ目を「知らない」)。
 *
 * これを解析的なkの再設計で吸収しようとする代わりに、経路全体に対して局所的な
 * 位置ベースの緩和(離散ラプラシアン平滑化+内腔クランプ)を少数回だけ追加で適用する。
 * pressAgainstOuterWallが既に決めた「壁へ寄る」という大局的な形は、この程度の
 * 反復回数では実質的に崩れない(低周波成分は緩和の影響をほぼ受けない)一方、
 * 継ぎ目1点だけに集中する高周波の折れは、隣接点との平均へ寄せる緩和で直接的に
 * 均される——relaxSemiRigidWire(ワイヤー側)と同じ考え方だが、内腔クランプの基準を
 * オフセット後の自分自身ではなく真の中心線(centerlinePoints)からの距離にする
 * ことで、pressAgainstOuterWallが既に壁ぎりぎりまで寄せた点を緩和がさらに
 * 壁の外へ押し出してしまうことがないようにする。両端(体外側の起点・大動脈基部側の
 * 終点)は固定する。
 */
const OUTER_PATH_SEAM_RELAX_ITERATIONS = 4;
const OUTER_PATH_SEAM_RELAX_STIFFNESS = 0.5;

function relaxOuterPathSeams(points: Vector3[], centerlinePoints: Vector3[], radii: number[], containmentMargin: number): Vector3[] {
  if (points.length < 3) return points.map((p) => p.clone());
  let current = points.map((p) => p.clone());
  for (let iter = 0; iter < OUTER_PATH_SEAM_RELAX_ITERATIONS; iter++) {
    const next = current.map((p) => p.clone());
    for (let i = 1; i < current.length - 1; i++) {
      const midpoint = current[i - 1].clone().add(current[i + 1]).multiplyScalar(0.5);
      const laplacian = midpoint.sub(current[i]);
      const candidate = current[i].clone().addScaledVector(laplacian, OUTER_PATH_SEAM_RELAX_STIFFNESS);
      const maxOffsetLength = containmentMargin * radii[i];
      const offset = candidate.clone().sub(centerlinePoints[i]);
      if (offset.length() > maxOffsetLength) candidate.copy(centerlinePoints[i]).addScaledVector(offset.normalize(), maxOffsetLength);
      next[i] = candidate;
    }
    current = next;
  }
  return current;
}

/**
 * aortaPoint(=ascendingEnd、弓部から降りてきた経路がここで大動脈基部の内腔へ入る)から
 * topPoint(内腔上部)を経てmidDescentPointまでの区間は、従来は単に4点(aortaPoint,
 * topPoint, midDescentPoint, bulgePoint)を通るCatmullRomの滑らかな補間曲線を
 * そのまま経路として使っていた——つまり、大動脈弓と違って「壁との接触」を一切
 * 考慮していなかった。しかしユーザー指摘の通り、ここも弓部と全く同じ接触問題のはずで、
 * 実測でもaortaPoint(軸上の点)からtopPoint(軸から離れた特定の壁寄りの点)へ
 * 急に向きを変える不自然な折れが確認された。ある程度の硬さを持つカテーテルは、
 * 弓部から内腔へ入る際もやはり中心線ほど鋭くは曲がれず、内腔の壁に軽く押し付け
 * られながらより緩やかな経路を取る、と考える方が物理的に妥当。
 *
 * pressAgainstOuterWall(曲率ベクトルをそのまま外側へ寄せる解析的な手法)をこの区間に
 * 直接適用したところ、区間全体が定常的な平面内の湾曲ではなく(軸上→軸から離れた
 * 特定角度への3次元的なひねりを伴う遷移のため)、曲率ベクトルの向き自体が点ごとに
 * 大きく回転し、かえって細かい波打ち(見かけ上のさざ波状の折れ)が広範囲に増えて
 * しまうことを実測で確認した——単一の解析的なk一発で押し出すこの手法は、大動脈弓の
 * ような単純な平面的湾曲には適するが、この区間のような3次元的な遷移には合わない。
 *
 * 代わりに、継ぎ目の折れを均すために既に使っているrelaxOuterPathSeams(離散
 * ラプラシアン平滑化+内腔クランプ、両端は固定)をそのままこの区間に転用する。
 * ただし、単純にinnerRawPoints(aortaPoint起点)だけを対象にすると、aortaPoint
 * そのものが対象配列の「先頭」になり、relaxOuterPathSeamsは両端を完全に固定する
 * ため、肝心の折れの頂点(aortaPointそのものでの急な向きの変化)が一切動かせず、
 * 実測でも折れが全く改善しないことを確認した——折れているのは「aortaPointの前後
 * (弓部側の末尾とtopPoint側の先頭)の接線が食い違っている」ことそのものなので、
 * aortaPoint自身も含めて動かせる区間にする必要がある。そこで、体外側の経路
 * (outerPathPoints)の末尾側も一定区間分ここに含め、aortaPointを対象配列の
 * 内部の1点として扱う(固定するのは弓部側に十分入った点と、floorPoint側の
 * カットオフ点の両端のみ)。反復的な近傍平均は曲率ベクトルの向きのノイズを増幅せず、
 * 区間全体の折れをなだらかに分散させるだけなので、pressAgainstOuterWallで起きた
 * 波打ちが起きない。内腔半径(evaluateAorticRootRadius、洞の三つ葉形状を反映)で
 * クランプしているため、なだらかにする過程で経路が内腔の壁へ寄っていく箇所では
 * その壁面(のcontainmentMargin倍の位置)で止まる——結果として、直線的に均すだけ
 * でなく、壁に触れるところでは実際に壁沿いになる、という接触問題としての性質も
 * 保たれる。
 *
 * 対側壁バックアップ・反転(floorPoint以降)はユーザーが「エンゲージ時の屈曲は許容する」
 * と明示した区間であり、今回の対象外——innerRawPoints側はupRelativeが
 * MID_DESCENT_UP_RELATIVEまで下がる手前までに留める。
 */
const ROOT_ENTRY_OUTER_TAIL_COUNT = 12;

function pressRootEntryAgainstWall(
  outerPathPoints: Vector3[],
  innerRawPoints: Vector3[],
  frame: AorticRootFrame,
): { outerPathPoints: Vector3[]; innerRawPoints: Vector3[] } {
  let sliceEnd = innerRawPoints.length - 1;
  for (let i = 0; i < innerRawPoints.length; i++) {
    if (projectOntoFrame(frame, innerRawPoints[i]).upRelative <= MID_DESCENT_UP_RELATIVE) {
      sliceEnd = i;
      break;
    }
  }
  const outerTailCount = Math.min(ROOT_ENTRY_OUTER_TAIL_COUNT, outerPathPoints.length - 1);
  if (sliceEnd < 3 || outerTailCount < 1) {
    return { outerPathPoints, innerRawPoints: innerRawPoints.map((p) => p.clone()) };
  }
  const outerTailStart = outerPathPoints.length - 1 - outerTailCount;
  // outerPathPoints末尾(=aortaPoint)とinnerRawPoints[0](=aortaPointの複製)は同じ点なので、
  // combinedにはouterPathPoints側の分だけを入れ、aortaPoint自体はinnerRawPoints側から1回だけ含める。
  const combined = [...outerPathPoints.slice(outerTailStart, outerPathPoints.length - 1), ...innerRawPoints.slice(0, sliceEnd + 1)];
  const radii = combined.map((point) => evaluateAorticRootRadius(frame, point));
  const relaxed = relaxOuterPathSeams(combined, combined, radii, CATHETER_WALL_CONTACT_MARGIN);
  const newAortaPoint = relaxed[outerTailCount];
  const newOuterPathPoints = [...outerPathPoints.slice(0, outerTailStart), ...relaxed.slice(0, outerTailCount), newAortaPoint];
  const newInnerRawPoints = [newAortaPoint, ...relaxed.slice(outerTailCount + 1), ...innerRawPoints.slice(sliceEnd + 1).map((p) => p.clone())];
  return { outerPathPoints: newOuterPathPoints, innerRawPoints: newInnerRawPoints };
}

/**
 * pointの大動脈基部フレームからの水平距離(distanceFromAxis)が、その高さ・角度に
 * おける可視化形状の局所半径(evaluateAorticRootRadius、AORTIC_CONTAINMENT_SAFETY_MARGIN
 * を掛けたもの)を超えている場合、頭側方向の成分は保ったまま水平成分だけを縮めて
 * 内腔に収める。ユーザー要件「経路上の各点が大動脈基部の内腔に収まっていることを
 * 検証し、はみ出す点があれば内腔に収まるよう制御点を調整する」をそのまま実装したもの。
 */
function moveInsideAorticRoot(frame: AorticRootFrame, point: Vector3): Vector3 {
  const offset = point.clone().sub(frame.center);
  const alongAxis = frame.axis.clone().multiplyScalar(frame.axis.dot(offset));
  const horizontal = offset.clone().sub(alongAxis);
  const axisDistance = horizontal.length();
  const localBound = evaluateAorticRootRadius(frame, point) * AORTIC_CONTAINMENT_SAFETY_MARGIN;
  if (axisDistance <= localBound || axisDistance < 1e-10) return point.clone();
  horizontal.multiplyScalar(localBound / axisDistance);
  return frame.center.clone().add(alongAxis).add(horizontal);
}

/**
 * 密な点列の各点(オスティウム直近の短いスタブを除く)のうち、大動脈基部の可視化形状の
 * 高さ範囲(AORTIC_CONTAINMENT_UP_RELATIVE_MIN〜MAX、体外側の経路などその範囲外の点は
 * 対象外)にあるものについて、内腔からはみ出していないかを検証し、はみ出す点は
 * moveInsideAorticRootで軸寄りに補正する。検証結果(最大到達率)をログに報告する。
 */
function ensurePathStaysInsideAorticRoot(
  points: Vector3[],
  ostiumPosition: Vector3,
  frame: AorticRootFrame,
  tipGuardDistance: number,
  shape: CoronaryApproachShape,
): Vector3[] {
  let worstRatio = 0;
  const corrected = points.map((point) => {
    if (point.distanceTo(ostiumPosition) < tipGuardDistance) return point.clone();
    const { upRelative } = projectOntoFrame(frame, point);
    if (upRelative < AORTIC_CONTAINMENT_UP_RELATIVE_MIN || upRelative > AORTIC_CONTAINMENT_UP_RELATIVE_MAX) {
      return point.clone();
    }
    const rawBound = evaluateAorticRootRadius(frame, point);
    const axisDistance = distanceFromAxis(frame, point);
    worstRatio = Math.max(worstRatio, axisDistance / rawBound);
    // isWithinAorticRootLumen(呼び出し側のensurePathClearsHeartMesh)が「内腔内なので
    // 心筋干渉補正の対象外」と判定するのと同じ、余裕を持たせた基準(rawBound*
    // AORTIC_CONTAINMENT_SAFETY_MARGIN)で「収まっている」を判定する。ここをrawBoundの
    // 100%までを許容範囲にしてしまうと、95%〜100%の間の点が「収まっている」と
    // 判定されつつ心筋干渉補正の対象外の基準(95%以内)は満たさないという不整合が生じ、
    // 後段の心筋干渉補正がその点を大動脈基部の外側へ押し出してしまいかねない。
    if (axisDistance <= rawBound * AORTIC_CONTAINMENT_SAFETY_MARGIN) return point.clone();
    return moveInsideAorticRoot(frame, point);
  });
  console.log(
    `[guideDeviceMesh] 大動脈基部内腔の検証(${shape}): 経路上の最大到達率=` +
      `${(worstRatio * 100).toFixed(1)}%(100%以内なら内腔に収まっている)`,
  );
  return corrected;
}

/**
 * カテーテルの体外側経路(finalPoints先頭のcenterlinePoints.length個、entry〜aortaPoint=
 * 上行大動脈終端の区間)の全サンプル点について、大動脈弓・下行大動脈・腕頭動脈の
 * 中心線(centerlinePoints、buildCatheterApproachがaorticRootMesh.tsのsample*関数から
 * 直接取得したもの——finalPointsの対応点は、心筋干渉補正(ensurePathClearsHeartMesh)を
 * 経る前はcenterlinePointsそのものと一致する)までの距離を検証し、その位置の局所半径
 * (centerlineRadii)を超えている点があればログに座標・距離・半径を出力する。
 * ユーザー要件「カテーテル経路の全サンプル点について、大動脈の中心線までの距離が、
 * その位置の大動脈の半径以内であることを数値で検証する」の実装。
 *
 * centerlinePoints自体は可視化ジオメトリ(buildAorticArchGeometry/
 * buildBrachiocephalicBranchGeometry)と同一のsample関数から得た点であるため、心筋干渉補正で
 * 動かされない限り違反は構造的に起こり得ない——この検証は、その保証が実際に保たれて
 * いること(心筋干渉補正がこの区間の点を誤って押し出していないこと)を実測で確認する
 * 安全網であり、将来の変更に対する回帰検出も兼ねる。
 */
function verifyOuterPathWithinAorta(
  finalPoints: Vector3[],
  centerlinePoints: Vector3[],
  centerlineRadii: number[],
  accessRoute: GuideAccessRoute,
  shape: CoronaryApproachShape,
): void {
  let worstRatio = 0;
  let worstIndex = -1;
  for (let i = 0; i < centerlinePoints.length && i < finalPoints.length; i++) {
    const distance = finalPoints[i].distanceTo(centerlinePoints[i]);
    const radius = centerlineRadii[i];
    const ratio = radius > 1e-8 ? distance / radius : distance > 1e-8 ? Infinity : 0;
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstIndex = i;
    }
    if (ratio > 1) {
      console.warn(
        `[guideDeviceMesh] 大動脈弓内腔の逸脱を検出(${shape}/${accessRoute}, index=${i}): ` +
          `座標=(${finalPoints[i].x.toFixed(3)}, ${finalPoints[i].y.toFixed(3)}, ${finalPoints[i].z.toFixed(3)}), ` +
          `中心線までの距離=${distance.toFixed(4)}, 局所半径=${radius.toFixed(4)}`,
      );
    }
  }
  console.log(
    `[guideDeviceMesh] 大動脈弓・下行大動脈/腕頭動脈内腔の検証(${shape}/${accessRoute}): ` +
      `経路上の最大到達率=${(worstRatio * 100).toFixed(1)}%(100%以内なら内腔に収まっている、` +
      `worst index=${worstIndex})`,
  );
}

/** カテーテル経路の終端が入口部座標からどこまで離れていたら「乖離」として警告するか(絶対距離)。数値誤差の範囲(1e-6程度)を大きく超えるものだけを報告する。 */
const TIP_ENDPOINT_TOLERANCE = 1e-4;
/**
 * 経路の単調性検証(verifyPathMonotonicity)で「逆走」として警告する、オスティウムまでの
 * 距離の増加量の閾値(heartScaleに対する比率)。大動脈基部の内腔エンゲージ(J字カーブ)は、
 * 対側壁に一度深く当ててから反転して入口部側へ持ち上がる、という実際のJudkinsカテーテル
 * 手技を意図的に模しており、この「底から持ち上がる」区間ではオスティウムまでの距離が
 * 一時的にわずかに増加する(実測: RCA/LAD/LCX×大腿/橈骨の全組み合わせで、heartScale=2.5
 * 相当の実データにおいて最大でも0.11程度の増加——対側壁への到達がゴールではなく、
 * そこから反発してオスティウムへ嵌まり込む動きの一部であるため、これは想定内)。
 * この既知の想定内の増加量を明確に超える(=経路が明確に逆走している)場合だけを
 * 違反として警告する。
 */
const MONOTONICITY_VIOLATION_TOLERANCE_FRACTION = 0.15;

/**
 * 密な点列(体外側→オスティウムの順)について、各点からオスティウムまでの距離が
 * 単調に減少しているかを検証する。ユーザー要件「カテーテル経路が体外側から先端に
 * 向かって一方向に進んでいること(途中で逆走して戻る箇所がないこと)」の実装。
 * MONOTONICITY_VIOLATION_TOLERANCE_FRACTIONのコメント参照——J字カーブの対側壁
 * バックアップによる小さな増加は想定内として許容し、それを明確に超える増加だけを
 * 違反として警告する。
 */
function verifyPathMonotonicity(
  points: Vector3[],
  ostiumPosition: Vector3,
  heartScale: number,
  vesselId: VesselId,
  accessRoute: GuideAccessRoute,
): void {
  if (points.length < 2) return;
  const tolerance = heartScale * MONOTONICITY_VIOLATION_TOLERANCE_FRACTION;
  let worstIncrease = 0;
  let worstIndex = -1;
  let prevDist = points[0].distanceTo(ostiumPosition);
  for (let i = 1; i < points.length; i++) {
    const dist = points[i].distanceTo(ostiumPosition);
    if (dist - prevDist > worstIncrease) {
      worstIncrease = dist - prevDist;
      worstIndex = i;
    }
    prevDist = dist;
  }
  const withinTolerance = worstIncrease <= tolerance;
  const log = withinTolerance ? console.log : console.warn;
  log(
    `[guideDeviceMesh] 経路の単調性検証(${vesselId}/${accessRoute}): ` +
      `最大の逆行量=${worstIncrease.toFixed(4)}(許容=${tolerance.toFixed(4)}、index=${worstIndex}/${points.length}` +
      (worstIndex >= 0
        ? `、座標=(${points[worstIndex].toArray().map((v) => v.toFixed(3)).join(", ")})`
        : "") +
      `)${withinTolerance ? " -- 許容範囲内(J字カーブの対側壁バックアップ)" : " -- 許容範囲を超える逆走を検出"}`,
  );
}

interface CatheterApproach {
  /** 体外側→オスティウムの順の、意味のある制御点(Phase 10向け指標や回帰テストで使う)。 */
  controlPoints: Vector3[];
  /** 実際に描画する密な点列(体外側→オスティウムの順、弧長に沿った均等間隔ではない)。 */
  densePoints: Vector3[];
}

/**
 * 冠動脈入口部(オスティウム)エンゲージ区間の制御点を、解剖学的な基準点として構築し、
 * 経路全体を実際の心臓メッシュとの干渉について検証・補正する。
 *
 * 基準点(体外→オスティウムの順):
 *   1. 体外への出口点(アクセスルート別、FEMORAL/RADIAL_ENTRY_OFFSETS)
 *   2. 上行大動脈点: オスティウムから頭側・外向きへheartScaleオーダーで離れた点
 *   3. 大動脈基部・対側壁バルジ点: 先端の手前で対側壁に一度当たってからオスティウムへ
 *      向かう、というJudkinsカテーテルの特徴的な挙動(バックアップ)を表す。大動脈基部
 *      フレーム(aorticRootMesh.ts、冠動脈入口部の実位置から逆算した実際の円筒)が
 *      得られる場合は、対象と反対側の冠動脈入口部の角度方向にある円筒内壁上の点を使う。
 *      RCA(JR型)は浅め、LCA(JL/EBU型)はより深く対側壁を使う
 *   4. 先端スタブ: オスティウム - ostiumDirection×深さ。tipDirectionが厳密に
 *      ostiumDirectionと一致する(「先端が入口部の起始方向に沿って嵌まり込む」要件)
 *   5. オスティウム(先端)
 *
 * これら全点を1本のCatmullRomスプラインで結び、密にサンプリングした上で、
 * ensurePathClearsHeartMesh により経路上の全点(オスティウム直近の短いスタブを除く)が
 * 心筋メッシュの外側にあることを検証し、内側と判定された点は心臓の重心から見て外向きへ
 * 押し出して補正する。パラメトリックな構築だけでは(特にCatmullRomが制御点間で予測し
 * にくく膨らむ性質上)貫通を防ぎきれないことが実測で分かったため、この検証・補正を
 * 経路全体に対する最終的な安全網として必ず適用する。
 */
function buildCatheterApproach(
  ostiumPosition: Vector3,
  ostiumDirection: Vector3,
  heartCentroid: Vector3,
  heartScale: number,
  shape: CoronaryApproachShape,
  accessRoute: GuideAccessRoute,
  aorticRootFrame: AorticRootFrame | null,
  heartMesh: Mesh | null,
): CatheterApproach {
  const up = new Vector3(0, 1, 0);
  const outward = ostiumPosition.clone().sub(heartCentroid);
  if (outward.lengthSq() < 1e-8) outward.set(1, 0, 0);
  outward.normalize();

  // 先端スタブ。tipDirection = normalize(ostium - tipAlignmentPoint) が厳密に
  // ostiumDirectionと一致する。
  const depth = TIP_ENGAGEMENT_DEPTH_FRACTION * heartScale;
  const tipAlignmentPoint = ostiumPosition.clone().addScaledVector(ostiumDirection, -depth);

  // 「し」の字(J字)エンゲージ経路。大動脈基部フレーム(aorticRootMesh.ts、冠動脈
  // 入口部の実位置から逆算した実際の円筒)が得られている場合は、上行大動脈側から
  // 円筒に入り(top)、対側壁へ寄りながら下降し(midDescent)、円筒下端付近まで
  // 落とし込んで対側壁に深く当て(floor、支点=バックアップ)、そこで反転して
  // 角度・高さの両方を対象入口部側へ戻しながら持ち上がる(hook)——実際の
  // Judkinsカテーテルが「底に当ててから、し字の反発で下から入口部に嵌まる」
  // 手技をそのまま表現する。フレームが無い場合(未ロード等)は、心臓中心から
  // 見た放射方向を使った簡易フォールバックにする(内腔の中継点は使わない)。
  let bulgePoint: Vector3;
  let hookPoint: Vector3 | null = null;
  let lumenPoints: Vector3[] = [];
  let aortaPoint: Vector3;
  let entryPoints: Vector3[];
  if (aorticRootFrame) {
    const frame = aorticRootFrame;
    const contralateralAngle = shape === "RCA" ? frame.leftAngle : frame.rcaAngle;
    // 対象冠動脈自身の実際の角度(LAD/LCXはfrmae.leftAngleの元になった平均値とは
    // 個別にずれるため、対象個別の入口部位置から直接求める)。
    const ownAngle = Math.atan2(ostiumPosition.z - frame.center.z, ostiumPosition.x - frame.center.x);

    const pointAtAngle = (upRelative: number, angle: number, fraction: number): Vector3 => {
      const axisPoint = pointAtRelativeHeight(frame, upRelative);
      const dir = new Vector3(Math.cos(angle), 0, Math.sin(angle));
      const probe = axisPoint.clone().addScaledVector(dir, 1);
      const localBound = evaluateAorticRootRadius(frame, probe);
      return axisPoint.addScaledVector(dir, localBound * fraction);
    };

    const floorUpRelative = shape === "RCA" ? RCA_FLOOR_UP_RELATIVE : LCA_FLOOR_UP_RELATIVE;
    const floorWallFraction = shape === "RCA" ? RCA_FLOOR_WALL_FRACTION : LCA_FLOOR_WALL_FRACTION;
    const mainLoopAngle = contralateralAngle + angularDiff(ownAngle, contralateralAngle) * MAIN_LOOP_ANGLE_BLEND;

    const topPoint = pointAtAngle(LUMEN_TOP_UP_RELATIVE, mainLoopAngle, LUMEN_TOP_RADIUS_FRACTION);
    const midDescentPoint = pointAtAngle(MID_DESCENT_UP_RELATIVE, mainLoopAngle, MID_DESCENT_RADIUS_FRACTION);
    const floorPoint = pointAtAngle(floorUpRelative, mainLoopAngle, floorWallFraction);
    // 反転点(フック): 底からわずかに持ち上がり、角度も対側壁側から対象入口部側へ
    // HOOK_ANGLE_BLENDの割合だけ回転させる(shortest-path方向、angularDiff参照)。
    const hookUpRelative = floorUpRelative * (1 - HOOK_UP_RELATIVE_FRACTION);
    const hookAngle = contralateralAngle + angularDiff(ownAngle, contralateralAngle) * HOOK_ANGLE_BLEND;
    const wallHookPoint = pointAtAngle(hookUpRelative, hookAngle, HOOK_RADIUS_FRACTION);
    // 壁基準のフック位置(wallHookPoint)を、対象入口部自身の実際の位置(ostiumPosition)へ
    // HOOK_OSTIUM_BLENDの割合だけ寄せる(直線補間)。LAD/LCXは解剖学的にLMT分岐後の
    // 構造のため、実際の入口部は壁からかなり外側(distanceFromAxis/evaluateAorticRootRadius
    // の比が1.6前後)にある——壁基準の到達率(HOOK_RADIUS_FRACTION=0.4、壁の内側)の
    // ままだと、フックから先端(tipAlignmentPoint→ostiumPosition)までのごく短い区間
    // だけで壁内から壁の1.6倍外側までの半径変化を一気に埋めることになり、そこだけ
    // 不自然に急激に膨らんで見える不具合になっていた(ユーザー報告:「カテーテルが
    // 上に飛び上がってしまっている」——実測でも、この区間だけ内腔到達率が0.95→1.59
    // まで1点間隔で跳ね上がっていたことを確認した)。壁基準の点と実際の入口部の位置を
    // 直接(半径・高さ・角度をそれぞれ別々に扱うのではなく)直線補間することで、
    // どの成分についても不連続な跳躍が起きないようにする。
    hookPoint = wallHookPoint.lerp(ostiumPosition, HOOK_OSTIUM_BLEND);

    bulgePoint = floorPoint;
    lumenPoints = [topPoint, midDescentPoint];

    // 上行大動脈から先(体外側)は、実際に表示している弓部・下行大動脈・腕頭動脈に
    // 沿わせる(対象がRCA/LAD/LCXのどれでも、狙う冠動脈がどちらでも穿刺部位は体に
    // 対して一定の側にあるため、shapeやownAngleには依存しない)。橈骨アプローチは
    // 右橈骨(腕頭動脈経由、臨床上最も標準的)を表す。entryPointsの終端は、可視化
    // ジオメトリ(buildBrachiocephalicBranchGeometry/buildAorticArchGeometryの下行
    // 大動脈部分)自体の終端と同じ点を使う——別々の定数で「どこまで伸ばすか」を決めると、
    // 可視化側だけ変更した際に食い違ってカテーテルが血管の外に突き抜けて見える
    // (過去に実際に起きた不具合)。
    //
    // 重要: 弓部の制御点(archApex・ascendingEnd)を経路に必ず含めること。以前は
    // 体外側の点(descendingStart/腕頭動脈終端など、heartScale基準で心臓から
    // 大きく離れた位置)から、いきなりtopPoint(大動脈基部フレームの局所半径基準の
    // ごく小さいオフセットで、中心軸のすぐ近く)へ直接つないでいたため、2点間の
    // 位置・スケールの差が大きすぎてCatmullRomの補間が不自然に暴れ(体外側の経路が
    // 大動脈のカーブに沿わず、宙に浮いた水平な断片のように見える不具合になっていた
    // ——実際にはバグではなく、この巨大な区間を1本のCatmullRomで飛ばしていたことが
    // 原因)。弓の形をなぞる中間点(ascendingEnd・archApex・大腿の場合はさらに
    // descendingStart)を経由させることで、実際の弓部大動脈と同じ滑らかな曲線を
    // カテーテルの経路にも作る。
    const archControlPoints = computeAorticArchControlPoints(frame, heartScale);
    aortaPoint = archControlPoints.ascendingEnd;
    if (accessRoute === "femoral") {
      // 大腿アプローチ: 体外(下行大動脈の先)→下行大動脈→弓頂部→上行大動脈終端、の順。
      entryPoints = [archControlPoints.descendingEnd, archControlPoints.descendingStart, archControlPoints.archApex];
    } else {
      // 橈骨アプローチ(右橈骨、腕頭動脈経由): 体外(腕頭動脈の先)→腕頭動脈の起点、の順。
      entryPoints = [archControlPoints.brachiocephalicEnd, archControlPoints.brachiocephalicOrigin];
    }
  } else {
    bulgePoint = ostiumPosition
      .clone()
      .addScaledVector(up, FALLBACK_BULGE_UP_FRACTION * heartScale)
      .addScaledVector(outward, FALLBACK_BULGE_OUTWARD_FRACTION * heartScale);
    aortaPoint = ostiumPosition
      .clone()
      .addScaledVector(up, AORTA_UP_FRACTION * heartScale)
      .addScaledVector(outward, AORTA_OUTWARD_FRACTION * heartScale);

    // 体外側の経路(アクセスルート別)は、狙う冠動脈がどちらでも穿刺部位は体に対して
    // 一定の側にあるため、心臓中心から見た放射方向(outward)を基準にする固定軸を使う
    // (大動脈基部フレームが無く、弓部・下行大動脈に沿わせられない場合のフォールバック)。
    const entryLateral = new Vector3(1, 0, 0);
    const entryOffsets = accessRoute === "femoral" ? FEMORAL_ENTRY_OFFSETS : RADIAL_ENTRY_OFFSETS;
    entryPoints = entryOffsets.map(([upAmt, outwardAmt, lateralAmt]) =>
      ostiumPosition
        .clone()
        .addScaledVector(up, upAmt * heartScale)
        .addScaledVector(outward, outwardAmt * heartScale)
        .addScaledVector(entryLateral, lateralAmt * heartScale),
    );
  }

  // 体外→オスティウムの順: entry, aorta, top, midDescent, floor(=bulgePoint、底=支点),
  // hook(底で反転して対象入口部側へ戻る「し」の字の頂点、フレームが無い場合はnullで省く),
  // tipAlignmentPoint, ostium。
  const controlPoints = [
    ...entryPoints,
    aortaPoint,
    ...lumenPoints,
    bulgePoint,
    ...(hookPoint ? [hookPoint] : []),
    tipAlignmentPoint,
    ostiumPosition.clone(),
  ];

  const tipGuardDistance = depth * TIP_CORRECTION_GUARD_MULTIPLIER;
  let densePoints: Vector3[];
  // 体外側(entry〜aortaPoint=上行大動脈終端)の経路の元になった中心線点列・各点での
  // 局所半径(verifyOuterPathWithinAortaでの検証用。心筋干渉補正より前の、可視化
  // ジオメトリと厳密に同一の点列を保持しておく)。
  let outerCenterlinePoints: Vector3[] = [];
  let outerCenterlineRadii: number[] = [];
  if (aorticRootFrame) {
    const frame = aorticRootFrame;
    // 体外側(entry〜aortaPoint=上行大動脈終端)の経路は、可視化している弓部・下行大動脈・
    // 腕頭動脈と同一の中心線(aorticRootMesh.tsのsampleAorticArchTrunk/
    // sampleAorticDescendingBranch/sampleAorticBrachiocephalicBranch)からそのまま点を取る
    // ——独立にCatmullRomCurve3を組み直す従来の実装は、大腿アプローチではたまたま
    // 可視化側と同じ制御点を逆順で通るだけで一致していた(CatmullRomは制御点の並びを
    // 丸ごと逆にしても同じ曲線を描く)が、橈骨アプローチは制御点セット自体が異なり、
    // 実測でこの区間が可視化ジオメトリの局所半径の約3倍まで外れ、カテーテルが大動脈弓の
    // カーブを無視して上肢方向へ直進して見える不具合があった。可視化側と同じsample関数を
    // 直接呼ぶことで、この発散が構造的に起こり得ないことを保証する。
    //
    // 橈骨アプローチ(右橈骨、腕頭動脈経由)は幹区間を腕頭動脈の起点
    // (BRACHIOCEPHALIC_ORIGIN_T_FRACTION)までで打ち切る——弓頂部(ARCH_TRUNK_T_FRACTION)
    // まで検証すると、腕頭動脈より先(左総頸動脈・左鎖骨下動脈側)の幹区間まで含めてしまい、
    // 実際にカテーテルが通らない区間まで検証対象になってしまう。
    const trunkEndLogicalT = accessRoute === "radial" ? BRACHIOCEPHALIC_ORIGIN_T_FRACTION : ARCH_TRUNK_T_FRACTION;
    const trunkPoints = sampleAorticArchTrunk(frame, heartScale, TRUNK_SAMPLE_COUNT, trunkEndLogicalT); // ascendingEnd -> archApex(大腿) / 腕頭動脈起点(橈骨)
    const trunkRadii = trunkPoints.map((_, i) => evaluateAorticArchRadius(frame, (i / TRUNK_SAMPLE_COUNT) * trunkEndLogicalT));
    let branchPoints: Vector3[];
    let branchRadii: number[];
    if (accessRoute === "femoral") {
      branchPoints = sampleAorticDescendingBranch(frame, heartScale, DESCENDING_BRANCH_SAMPLE_COUNT); // archApex -> descendingEnd
      branchRadii = branchPoints.map((_, i) =>
        evaluateAorticArchRadius(
          frame,
          ARCH_TRUNK_T_FRACTION + (i / DESCENDING_BRANCH_SAMPLE_COUNT) * (1 - ARCH_TRUNK_T_FRACTION),
        ),
      );
    } else {
      branchPoints = sampleAorticBrachiocephalicBranch(frame, heartScale, BRACHIOCEPHALIC_BRANCH_SAMPLE_COUNT); // 腕頭動脈起点 -> brachiocephalicEnd
      branchRadii = branchPoints.map((_, i) => evaluateAorticBrachiocephalicRadius(frame, i / BRACHIOCEPHALIC_BRANCH_SAMPLE_COUNT));
    }
    // trunkPoints・branchPointsはどちらもascendingEnd起点・体外方向終点の順(可視化側と
    // 同じ向き)なので、entry→aortaPointの順で使うには連結してから反転する。継ぎ目
    // (archApex、trunkPointsの終点=branchPointsの始点)は重複するため片方だけ残す。
    outerCenterlinePoints = [...trunkPoints, ...branchPoints.slice(1)].reverse();
    outerCenterlineRadii = [...trunkRadii, ...branchRadii.slice(1)].reverse();
    // カテーテルが実際に通る点列は、真の中心線(outerCenterlinePoints)そのものではなく、
    // pressAgainstOuterWallが解く「内腔の壁に接するまで外側(大弯)へ寄せた」点列
    // (そちらのコメント参照)。
    //
    // 大腿アプローチ(trunk+descendingBranch)はどちらもbuildAorticArchCurveという
    // 同一の滑らかな1本のカーブから直接切り出した点列なので、継ぎ目(archApex)を
    // またいでも実際の湾曲がそのまま連続しており、連結してから1回で曲率を評価しても
    // 問題ない。橈骨アプローチのbranch(腕頭動脈)は分枝自体の解剖学的な向きを持つ
    // 独立した区間(3分枝が扇状に開く、computeAorticArchControlPoints参照)であり、
    // trunkと同じ「弓の中心線」の一部として曲率を評価すべきものではないため、
    // 引き続きtrunk単体(実際に弓が湾曲する区間のみ)に対してpressAgainstOuterWallを
    // 適用し、branchには適用しない。
    //
    // 橈骨アプローチのtrunkは弓頂部よりずっと手前(BRACHIOCEPHALIC_ORIGIN_T_FRACTION)
    // で打ち切られており、その短い区間自体はほぼ直線に近い(実測: 1点あたりの折れが
    // 1度未満)。この短い区間「自身」の中での最大曲率を基準にk(壁へ寄せる量)を
    // 決めてしまうと、その最大値自体が小さすぎるためkが不自然に大きくなり、
    // わずかな曲率のばらつきが増幅されて実際には存在しない急な折れが生じることを
    // 実測で確認した(pressAgainstOuterWallのreferenceMaxMagnitudeのコメント参照)。
    // 大腿アプローチが対象にする弓全体(trunk+descendingBranch)の生の最大曲率を
    // 共通の基準として渡すことで、この不具合を構造的に防ぐ。
    const archWideCurvatureReference =
      accessRoute === "radial"
        ? computeMaxRawCurvatureMagnitude([
            ...sampleAorticArchTrunk(frame, heartScale, TRUNK_SAMPLE_COUNT, ARCH_TRUNK_T_FRACTION),
            ...sampleAorticDescendingBranch(frame, heartScale, DESCENDING_BRANCH_SAMPLE_COUNT).slice(1),
          ])
        : undefined;
    const pressedOuterPathPoints =
      accessRoute === "femoral"
        ? pressAgainstOuterWall(outerCenterlinePoints, outerCenterlineRadii, CATHETER_WALL_CONTACT_MARGIN)
        : [
            ...pressAgainstOuterWall(trunkPoints, trunkRadii, CATHETER_WALL_CONTACT_MARGIN, archWideCurvatureReference),
            ...branchPoints.slice(1),
          ].reverse();
    const outerPathPoints = relaxOuterPathSeams(
      pressedOuterPathPoints,
      outerCenterlinePoints,
      outerCenterlineRadii,
      CATHETER_WALL_CONTACT_MARGIN,
    );

    const innerControlPoints = [
      aortaPoint,
      ...lumenPoints,
      bulgePoint,
      ...(hookPoint ? [hookPoint] : []),
      tipAlignmentPoint,
      ostiumPosition.clone(),
    ];
    const innerCurve = new CatmullRomCurve3(innerControlPoints);
    const innerResolution = Math.max(
      MIN_CURVE_SEGMENT_RESOLUTION,
      CATHETER_CURVE_RESOLUTION - outerCenterlinePoints.length,
    );
    const innerRawPoints = innerCurve.getSpacedPoints(innerResolution);
    const rootEntryPressed = pressRootEntryAgainstWall(outerPathPoints, innerRawPoints, frame);
    const innerPoints = ensurePathStaysInsideAorticRoot(
      rootEntryPressed.innerRawPoints,
      ostiumPosition,
      aorticRootFrame,
      tipGuardDistance,
      shape,
    );
    // outerPathPointsの末尾とinnerPointsの先頭はどちらもaortaPointそのもの(重複)
    // なので、結合時に片方だけ残す。
    densePoints = [...rootEntryPressed.outerPathPoints, ...innerPoints.slice(1)];
  } else {
    const curve = new CatmullRomCurve3(controlPoints);
    densePoints = curve.getSpacedPoints(CATHETER_CURVE_RESOLUTION);
  }

  // 干渉補正は、実際に描画・使用する最終点列に対して直接行う(補正後にさらに間引き・
  // 再サンプリングを挟むと、補正で押し出した点とその隣の未補正点との間の直線/曲線補間が
  // 再びメッシュを横切ってしまい、補正が台無しになりかねないため)。大動脈基部の内腔への
  // 収まり(上の分岐)を先に確定させ、そのあとで心筋メッシュとの干渉補正
  // (ensurePathClearsHeartMesh)を行う——後者は内腔内と確定した点を対象外にする
  // ため、順序を逆にすると2つの補正が競合しうる(isWithinAorticRootLumenのコメント参照)。
  if (heartMesh) {
    // HOOK_GUARD_MARGINのコメント参照: HOOKから先端までの区間(未モデル化のLMTに相当)は
    // 心筋メッシュとの干渉補正の対象から除外する。
    const heartMeshGuardDistance = hookPoint ? Math.max(tipGuardDistance, hookPoint.distanceTo(ostiumPosition) * HOOK_GUARD_MARGIN) : tipGuardDistance;
    densePoints = ensurePathClearsHeartMesh(
      densePoints,
      ostiumPosition,
      heartMesh,
      heartCentroid,
      heartScale,
      heartMeshGuardDistance,
      aorticRootFrame,
    );
  }

  if (outerCenterlinePoints.length > 0) {
    verifyOuterPathWithinAorta(densePoints, outerCenterlinePoints, outerCenterlineRadii, accessRoute, shape);
  }

  return { controlPoints, densePoints };
}

/**
 * Phase 10(将来のバックアップ力簡易評価)向けに保持しておく、カテーテルの
 * エンゲージ状態を表す幾何情報。この描画で既に定まる情報をまとめただけで、
 * 新たな計算は行わない。
 */
export interface GuideCatheterPlacement {
  /** 穿刺部位(アクセスルート)。将来のバックアップ力簡易評価は、ルートによって
   * 操作者からカテーテル先端への力の伝わり方(トルク応答等)が異なりうるため保持する。 */
  accessRoute: GuideAccessRoute;
  /** カテーテル先端の位置(=エンゲージした冠動脈入口部の位置と同一点)。 */
  tipPosition: Vector3;
  /**
   * カテーテル先端の向き(単位ベクトル、スプライン最終区間の方向)。血管自身の
   * 走行方向(ostiumDirection)とは独立に決まるため、両者のなす角を将来
   * バックアップ力の指標として使える。
   */
  tipDirection: Vector3;
  /** エンゲージした冠動脈入口部の位置(tipPositionと同一点、意味的に区別して保持)。 */
  ostiumPosition: Vector3;
  /** 冠動脈入口部における血管自身の走行方向(単位ベクトル)。 */
  ostiumDirection: Vector3;
  /**
   * カテーテルの大動脈側経路(スプライン)全体の弧長。大動脈壁メッシュが無いため
   * 正確な接触長ではないが、将来の簡易指標の代用値として保持しておく。
   */
  aorticPathLength: number;
  /** スプラインの元になった制御点(体外側→オスティウムの順)。 */
  controlPoints: Vector3[];
}

/** カテーテルの経路と、そこから導かれるPhase 10向け配置情報。進行度(アニメーション)には依存しない、対象・血管形状が同じなら不変の情報。 */
export interface GuideCatheterPath {
  placement: GuideCatheterPlacement;
  /** スプライン全体を弧長に沿って均等にサンプリングした点列(進行度に関わらず常に全体)。ワイヤーの共有区間としても使う。 */
  fullSplinePoints: Vector3[];
}

/**
 * カテーテルのスプラインを弧長に沿って均等サンプリングする点数。体外側〜大動脈基部の
 * アプローチ区間が弧長の大半を占めるため、控えめな点数だとオスティウム手前のバルジ
 * (弧長としては短い)が粗くカクついて見える。この点数は心筋メッシュとの干渉検証・補正
 * (ensurePathClearsHeartMesh)の解像度も兼ねるため、オスティウム近傍の危険域を十分
 * 細かく捉えられるだけの点数を確保する。
 */
const CATHETER_CURVE_RESOLUTION = 200;
/**
 * オスティウム側(inner)のCatmullRomサンプリング点数の下限(buildCatheterApproach参照)。
 * 体外側(outer)は大動脈弓・下行大動脈・腕頭動脈の中心線からそのままサンプル数を
 * 決めるため対象外(TRUNK_SAMPLE_COUNT等参照)。
 */
const MIN_CURVE_SEGMENT_RESOLUTION = 24;
/**
 * 体外側の経路(entry〜aortaPoint=上行大動脈終端)を、大動脈弓・下行大動脈・腕頭動脈の
 * 可視化ジオメトリと同一の中心線(aorticRootMesh.tsのsampleAorticArchTrunk/
 * sampleAorticDescendingBranch/sampleAorticBrachiocephalicBranch)から直接サンプリングする際の
 * 点数。可視化ジオメトリ(buildAorticArchGeometry等)と厳密に同じ関数を呼ぶため、
 * 両者が構造的に同一の3D点列を通ることが保証される(制御点の値だけを共有し、
 * それぞれ独立にCatmullRomCurve3を組んでいた従来の実装は、橈骨アプローチで
 * 大きく発散する不具合があった——buildCatheterApproachのコメント参照)。
 */
const TRUNK_SAMPLE_COUNT = 40;
const DESCENDING_BRANCH_SAMPLE_COUNT = 90;
const BRACHIOCEPHALIC_BRANCH_SAMPLE_COUNT = 40;

/**
 * @param aorticRootFrame 冠動脈入口部の実位置から逆算した大動脈基部フレーム
 * (aorticRootMesh.ts の computeAorticRootFrame。呼び出し側のgraphs(VesselId→VesselGraph)
 * とheartCentroidから求める——このファイル自身はVesselIdの列挙を知らないため、
 * 呼び出し側の責務とする)。対側壁バルジ点(buildCatheterApproach参照)の基準に使う。
 * 未ロード等でnullの場合はheartScaleベースの簡易フォールバックになる。
 * @param heartMesh 心筋メッシュ本体。経路が心筋を貫通していないかの検証・補正
 * (ensurePathClearsHeartMesh参照)に使う。未ロード等でnullの場合は検証・補正を
 * スキップする(パラメトリックな構築のみになる)。
 */
export function computeGuideCatheterPath(
  graph: VesselGraph,
  heartCentroid: Vector3,
  heartScale: number,
  vesselId: VesselId,
  accessRoute: GuideAccessRoute,
  aorticRootFrame: AorticRootFrame | null,
  heartMesh: Mesh | null,
): GuideCatheterPath | null {
  const mainTrunk = getMainTrunk(graph);
  if (mainTrunk.points.length === 0) return null;

  const ostiumPosition = mainTrunk.points[0].position.clone();
  const ostiumDirection = sampleCenterline(mainTrunk.points, 0).tangent.clone();

  const shape = shapeForVessel(vesselId);
  const { controlPoints, densePoints } = buildCatheterApproach(
    ostiumPosition,
    ostiumDirection,
    heartCentroid,
    heartScale,
    shape,
    accessRoute,
    aorticRootFrame,
    heartMesh,
  );
  const fullSplinePoints = densePoints;
  const aorticPathLength = polylineLength(densePoints);

  const tipDelta = new Vector3().subVectors(
    controlPoints[controlPoints.length - 1],
    controlPoints[controlPoints.length - 2],
  );
  const tipDirection = tipDelta.lengthSq() > 1e-10 ? tipDelta.normalize() : ostiumDirection.clone();

  // 検証(要件1): カテーテル先端の座標が、対象冠動脈の起始ノード(中心線グラフの根ノード)の
  // 座標と一致することを確認する(tipPositionはostiumPositionそのものの複製のため
  // 構造的に厳密に一致するが、念のため実測してログで報告する)。
  console.log(
    `[guideDeviceMesh] 先端座標の検証(${vesselId}): 先端-入口部間の距離=` +
      `${ostiumPosition.distanceTo(mainTrunk.points[0].position).toExponential(2)}(0であるべき)`,
  );

  // 検証(要件1、より実質的なチェック): 実際に描画に使う密な点列(densePoints、心筋
  // 干渉補正等の後段処理を全て経た最終値)の末尾が、入口部座標と一致することを確認する。
  // 上のtipPosition検証はostiumPositionのクローン同士の比較で構造的に自明だが、
  // こちらはスプライン補間・各種補正を経てもなお終端が入口部からずれていないかを
  // 実測する、より意味のある検証になっている。
  const tipEndpointDistance = fullSplinePoints[fullSplinePoints.length - 1].distanceTo(ostiumPosition);
  console.log(
    `[guideDeviceMesh] カテーテル経路終端の検証(${vesselId}/${accessRoute}): ` +
      `最終サンプル点-入口部間の距離=${tipEndpointDistance.toExponential(2)}(0であるべき)`,
  );
  if (tipEndpointDistance > TIP_ENDPOINT_TOLERANCE) {
    console.warn(
      `[guideDeviceMesh] カテーテル経路の終端が入口部から乖離しています(${vesselId}/${accessRoute}): ` +
        `距離=${tipEndpointDistance.toFixed(4)}, 終端座標=(${fullSplinePoints[fullSplinePoints.length - 1].toArray().map((v) => v.toFixed(3)).join(", ")}), ` +
        `入口部座標=(${ostiumPosition.toArray().map((v) => v.toFixed(3)).join(", ")})`,
    );
  }

  // 検証(要件3): 経路(体外側→オスティウムの順)が一方向に進んでいるか(オスティウムまでの
  // 距離が単調に減少しているか)を検証する。
  verifyPathMonotonicity(fullSplinePoints, ostiumPosition, heartScale, vesselId, accessRoute);

  const placement: GuideCatheterPlacement = {
    accessRoute,
    tipPosition: ostiumPosition.clone(),
    tipDirection,
    ostiumPosition: ostiumPosition.clone(),
    ostiumDirection,
    aorticPathLength,
    controlPoints,
  };

  return { placement, fullSplinePoints };
}

/** カテーテル1本あたりの円周分割数(血管と同程度の太さのため、ワイヤーより多めに)。 */
const CATHETER_RADIAL_SEGMENTS = 12;
/** ワイヤー1本あたりの円周分割数。実寸相応の太さ(WIRE_RADIUS_RATIO参照)に上げたため、
 * 以前の6分割のままだと断面の角ばりが目立つ。滑らかな丸みを保てる分割数にする。 */
const WIRE_RADIAL_SEGMENTS = 10;

/**
 * カテーテルの挿入アニメーション用ジオメトリを、進行度(0〜1、0=未挿入、1=完全に
 * オスティウムへ係合)に応じて構築する。スプラインの体外側の端(controlPoints[0]相当)を
 * 起点に、進行度に応じて弧長に沿った先頭部分だけを表示する(=カテーテル先端が
 * 体外側からオスティウムへ向かって進んでいくように見える)。
 */
/**
 * @param pointColors 指定すると、guideCatheterStress.tsのバックアップ力ヒートマップ用の
 * 頂点色として焼き込む(未指定の場合は従来通り単色マテリアルで描画される)。
 * `path.fullSplinePoints`と1対1対応(同じ長さ・同じ添字)の配列であることが前提——
 * 以下の`points`配列に対して行うスライス・追加操作を、この関数呼び出し内で
 * `colors`配列にも全く同じ添字操作で並行して適用し、2つの配列が食い違わない
 * ようにする(ここがずれるとbuildTubeFromFrameが頂点色を誤った点に割り当ててしまう)。
 */
export function buildGuideCatheterGeometry(
  path: GuideCatheterPath,
  catheterRadius: number,
  catheterProgress: number,
  pointColors?: Color[] | null,
): BufferGeometry {
  const progress = Math.max(0, Math.min(1, catheterProgress));
  const total = path.fullSplinePoints.length;
  // fullSplinePointsは弧長に沿って均等サンプリング済みなので、進行度に対応する
  // 正確な先端位置は隣接する2点を線形補間するだけで求まる(スプラインを
  // 作り直す必要はない)。
  const exactIndex = progress * (total - 1);
  const lowerIndex = Math.max(0, Math.min(total - 1, Math.floor(exactIndex)));
  const frac = exactIndex - lowerIndex;
  const exactTip =
    lowerIndex + 1 < total
      ? path.fullSplinePoints[lowerIndex].clone().lerp(path.fullSplinePoints[lowerIndex + 1], frac)
      : path.fullSplinePoints[total - 1].clone();

  const points = path.fullSplinePoints.slice(0, lowerIndex + 1).map((p) => p.clone());
  const last = points[points.length - 1];
  const needsTipPush = !last || last.distanceToSquared(exactTip) > 1e-10;
  if (needsTipPush) points.push(exactTip);
  const needsPad = points.length < 2;
  if (needsPad) points.push(exactTip.clone().addScalar(1e-4));

  let colors: Color[] | undefined;
  if (pointColors && pointColors.length === total) {
    const tipColor =
      lowerIndex + 1 < total ? pointColors[lowerIndex].clone().lerp(pointColors[lowerIndex + 1], frac) : pointColors[total - 1].clone();
    colors = pointColors.slice(0, lowerIndex + 1).map((c) => c.clone());
    if (needsTipPush) colors.push(tipColor);
    if (needsPad) colors.push(tipColor.clone());
  }

  const radii = points.map(() => catheterRadius);
  // スプライン自体が既に滑らかなため、buildTubeFromPoints既定の強い平滑化は不要
  // (かけると意図したJカーブの形が鈍る)。
  return buildTubeFromPoints(points, radii, CATHETER_RADIAL_SEGMENTS, 0, undefined, colors);
}

/**
 * ワイヤーが血管壁に接しながらなだらかに曲がる様子を近似する、離散ラプラシアン
 * 平滑化+内腔クランプの反復緩和。剛性のあるワイヤーは湾曲部の中心線をそのまま
 * なぞらず、外側の壁に軽く押し付けられながらショートカットする——各内部点を
 * 「両隣の中点」方向へ少しずつ寄せる(=局所的な曲率を打ち消す=直線化する)ことを
 * 繰り返し、ただし元の中心線からの横方向オフセットが「その位置の内腔半径-ワイヤー
 * 半径」を超えないようクランプすることで、直線化が壁に当たったところで止まり、
 * 結果的に湾曲部の外側に軽く沿うような弧になる。
 *
 * 両端(起点=オスティウム側、終点=現在の先端)は一切動かさない。これは
 * buildGuideWireGeometryが以前ここに強い平滑化(smoothPoints、開いた経路の端点を
 * 自分自身とのクランプ平均で扱う方式)をかけていた際に、ワイヤー先端の表示位置が
 * 実際の到達点から手前へ後退してしまっていた不具合(実測: 4回の平滑化で
 * 中心線サンプル間隔の半分以上ずれた)と同じ問題が起きないようにするため。
 *
 * 直線区間ではラプラシアン(隣接2点の中点 - 自分自身)がほぼゼロになるため、
 * このワイヤーは湾曲部でだけ視覚的な効果を持ち、直線区間の中心線からは動かない。
 */
const WIRE_RELAX_ITERATIONS = 9;
const WIRE_RELAX_STIFFNESS = 0.65;
/** 内腔半径のうち実際にオフセットを許容する比率(狭窄・ステント等のSTENT_LUMEN_FIT_RATIO=0.95と同様、壁ぎりぎりに一致させると誤差でチューブが血管の外にはみ出しかねないため、わずかに内側に留める)。 */
const WIRE_LUMEN_FIT_RATIO = 0.9;

function relaxSemiRigidWire(points: Vector3[], lumenRadii: number[], wireRadius: number): Vector3[] {
  if (points.length < 3) return points;
  const base = points.map((p) => p.clone());
  let current = points.map((p) => p.clone());

  for (let iter = 0; iter < WIRE_RELAX_ITERATIONS; iter++) {
    const next = current.map((p) => p.clone());
    for (let i = 1; i < current.length - 1; i++) {
      const midpoint = current[i - 1].clone().add(current[i + 1]).multiplyScalar(0.5);
      const laplacian = midpoint.sub(current[i]);
      const candidate = current[i].clone().addScaledVector(laplacian, WIRE_RELAX_STIFFNESS);

      const maxOffset = Math.max((lumenRadii[i] - wireRadius) * WIRE_LUMEN_FIT_RATIO, 0);
      const offset = candidate.clone().sub(base[i]);
      if (maxOffset <= 0) {
        candidate.copy(base[i]);
      } else if (offset.length() > maxOffset) {
        candidate.copy(base[i]).addScaledVector(offset.normalize(), maxOffset);
      }
      next[i] = candidate;
    }
    current = next;
  }
  return current;
}

/** フロッピーチップの円弧が全体でどれだけ曲がるか(ラジアン)。実物のガイドワイヤー先端に
 * 特徴的な、J字/カール状に丸まった柔らかい形状を模す(実際の手技上の意味はなく、純粋に
 * 見た目のための装飾)。 */
const FLOPPY_TIP_ARC_RADIANS = (110 * Math.PI) / 180;
/** フロッピーチップの円弧を近似する分割点数。 */
const FLOPPY_TIP_SEGMENTS = 6;
/** フロッピーチップのカール半径を、ワイヤー本体の半径の何倍にするか(実物は太さの数倍程度の
 * 緩いカーブを描く)。 */
const FLOPPY_TIP_CURL_RADIUS_TO_WIRE_RATIO = 9;
/** カール半径がこれ未満なら省略する(挿入直後の短いスタブに対して不自然に大きく見えるのを防ぐ)。 */
const FLOPPY_TIP_MIN_CURL_RADIUS_TO_WIRE_RATIO = 1.5;

/**
 * ワイヤー先端に、実物のフロッピーチップを模した柔らかいカール(円弧)を追加する。
 * 挿入経路(中心線・進行度)の計算そのものには一切影響しない、純粋に見た目のための
 * 装飾的な延長であり、末端点(=進行度から求めた本来の先端位置)の接線方向から
 * 連続的に(C1連続に)始まるようにする。
 *
 * カール半径は、(1)手前の描画済み区間の弧長、(2)先端付近の内腔半径、の両方で頭打ちに
 * する——挿入直後の短いスタブや、先端が細い末梢枝にある場合に、カールが実際の
 * 長さ・血管の太さに対して不自然に大きくならないようにするため。頭打ちにより
 * カール半径が小さくなりすぎる場合は、カール自体を省略する(無理に小さく潰れた
 * カールを描くより、まっすぐな先端のままの方が自然なため)。
 */
function appendFloppyTip(
  points: Vector3[],
  wireRadius: number,
  lumenRadiusAtTip: number,
): { points: Vector3[]; radii: number[] } {
  const straightRadii = points.map(() => wireRadius);
  const tipIndex = points.length - 1;
  if (tipIndex < 1) return { points, radii: straightRadii };

  const tangent = points[tipIndex].clone().sub(points[tipIndex - 1]);
  if (tangent.lengthSq() < 1e-12) return { points, radii: straightRadii };
  tangent.normalize();

  const availableLength = polylineLength(points);
  const maxByLumen = Math.max(lumenRadiusAtTip - wireRadius, 0) * 0.8;
  const curlRadius = Math.min(wireRadius * FLOPPY_TIP_CURL_RADIUS_TO_WIRE_RATIO, availableLength * 0.4, maxByLumen);
  if (curlRadius < wireRadius * FLOPPY_TIP_MIN_CURL_RADIUS_TO_WIRE_RATIO) {
    return { points, radii: straightRadii };
  }

  // 接線方向と直交する、一貫した向きの平面(curlAxis)を選ぶ。参照ベクトルは接線とほぼ
  // 平行な場合だけ別の軸に切り替える(stentLatticeMesh.tsのcomputeTubeFrameと同じ考え方)。
  let reference = new Vector3(0, 1, 0);
  if (Math.abs(tangent.dot(reference)) > 0.95) reference = new Vector3(1, 0, 0);
  const curlPlaneNormal = new Vector3().crossVectors(tangent, reference).normalize();
  const curlAxis = new Vector3().crossVectors(curlPlaneNormal, tangent).normalize();

  // 中心を先端からcurlAxis方向にcurlRadius分オフセットし、角度=πの点がちょうど
  // 先端(base)に一致し、角度減少方向の接線がtangentと一致するように弧をパラメータ化する。
  const center = points[tipIndex].clone().addScaledVector(curlAxis, curlRadius);
  const curlPoints: Vector3[] = [];
  const curlRadii: number[] = [];
  for (let i = 1; i <= FLOPPY_TIP_SEGMENTS; i++) {
    const t = i / FLOPPY_TIP_SEGMENTS;
    const angle = Math.PI - t * FLOPPY_TIP_ARC_RADIANS;
    const pos = center
      .clone()
      .addScaledVector(curlAxis, Math.cos(angle) * curlRadius)
      .addScaledVector(tangent, Math.sin(angle) * curlRadius);
    curlPoints.push(pos);
    // 先端に向かってわずかに細くし、実物の柔らかいフロッピーチップらしさを出す。
    curlRadii.push(wireRadius * (1 - 0.35 * t));
  }

  return { points: [...points, ...curlPoints], radii: [...straightRadii, ...curlRadii] };
}

/**
 * ワイヤーの挿入アニメーション用ジオメトリを、進行度(0〜1)に応じて構築する。
 *
 * 冠動脈入口部(オスティウム)から対象の枝までの完全な経路(buildWireCenterline)を
 * 1回求め、その経路全体の弧長に対する割合として進行度を適用する(対象の枝自身の
 * tではなく、経路全体の弧長を基準にする)。これにより、対象が孫枝であっても
 * 進行度がわずかに正になった瞬間に祖先の枝全体が一気に出現することがない
 * (t基準だと、祖先の枝は常に「分岐点まで全体」を含んでしまうため、対象の枝の
 * 手前側はtargetProgressで制御できても、その手前にある祖先の枝の長さぶんは
 * 制御できず、進行度0+の瞬間にまとめて出現してしまっていた)。
 *
 * カテーテルの経路(大動脈側のアプローチ区間)は含めない——ワイヤーはこの区間では
 * カテーテルの内腔を通っているだけで、カテーテル自身のチューブ(オスティウムに
 * 先端が到達済み、catheterProgress=1)に完全に重なって隠れているため、ここで
 * 別のチューブとしてもう一度描画すると視覚的に無意味なだけでなく、進行度が
 * 1を超えた瞬間にカテーテルの全長ぶんが一気に出現して見える不具合の原因だった。
 *
 * 進行度が0の場合は「まだカテーテルの中から出ていない」とみなしnullを返す。
 *
 * 緩和(relaxSemiRigidWire)後、先端にappendFloppyTipで装飾的なカールを追加する。
 */
export function buildGuideWireGeometry(
  graph: VesselGraph,
  targetBranchId: string,
  wireRadius: number,
  wireProgress: number,
): BufferGeometry | null {
  const progress = Math.max(0, Math.min(1, wireProgress));
  if (progress <= 0) return null;

  const { points, radii } = buildWireCenterline(graph, targetBranchId);
  if (points.length < 2) return null;

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + points[i - 1].distanceTo(points[i]));
  }
  const totalLength = cumulative[cumulative.length - 1];
  const targetLength = progress * totalLength;

  let k = 0;
  while (k < cumulative.length - 2 && cumulative[k + 1] < targetLength) k++;
  const segStart = cumulative[k];
  const segEnd = cumulative[Math.min(k + 1, cumulative.length - 1)];
  const frac = segEnd > segStart ? (targetLength - segStart) / (segEnd - segStart) : 0;
  const nextIndex = Math.min(k + 1, points.length - 1);
  const tip = points[k].clone().lerp(points[nextIndex], frac);
  const tipRadius = radii[k] + (radii[nextIndex] - radii[k]) * frac;

  const grown = points.slice(0, k + 1).map((p) => p.clone());
  const grownRadii = radii.slice(0, k + 1);
  const last = grown[grown.length - 1];
  if (!last || last.distanceToSquared(tip) > 1e-10) {
    grown.push(tip);
    grownRadii.push(tipRadius);
  }
  if (grown.length < 2) {
    grown.push(tip.clone().addScalar(1e-4));
    grownRadii.push(tipRadius);
  }

  const relaxed = relaxSemiRigidWire(grown, grownRadii, wireRadius);
  const { points: withFloppyTip, radii: tubeRadii } = appendFloppyTip(relaxed, wireRadius, grownRadii[grownRadii.length - 1]);
  // 平滑化(buildTubeFromPointsのsmoothingPasses)は一切かけない。relaxSemiRigidWireが
  // 既に湾曲部の見た目を調整済みであり、これ以上の平滑化は先端位置を後退させる
  // (このファイルの以前のコメント、および同様の問題を持つ他の長経路チューブ
  // (Phase 7の造影剤チューブ)と同じ理由)。
  return buildTubeFromPoints(withFloppyTip, tubeRadii, WIRE_RADIAL_SEGMENTS, 0);
}
