// 大動脈基部(バルサルバ洞)・上行大動脈の補助表示。
//
// 心臓モデル(ImageCAS由来のheart-realistic.glb)には大動脈本体のメッシュが含まれて
// いないため、冠動脈入口部(オスティウム)の位置から手続き的に形状を生成する。目的は
// 正確な生体計測の再現ではなく、ガイディングカテーテルが「バルサルバ洞からどのように
// 冠動脈入口部へエンゲージしているか」を利用者が視覚的に理解しやすくすることにある。
//
// 実際のバルサルバ洞は3つの独立した膨らみ(右冠尖洞・左冠尖洞・無冠尖洞)が交連部
// (commissure)で括れた「三つ葉」状の断面を持ち、軸対称な単純な樽型ではない。この
// ファイルはその形状的特徴を、実際の冠動脈入口部の角度位置を使って再現する
// (buildLobedTubeGeometry参照)。各部の寸法比は成人の標準的な経胸壁心エコー/CT
// 基準値に基づく(下記AORTIC_ROOT_PROFILEのコメント参照)。
//
// 位置・向き・サイズはcomputeAorticRootFrameが冠動脈入口部の実位置から幾何学的に
// 逆算する(guideDeviceMesh.tsのガイディングカテーテルの経路も同じフレームを使い、
// 大動脈基部の内腔を通って対側壁に当たってからエンゲージする経路を組み立てる)。

import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Plane, Vector3 } from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import type { VesselId } from "../../types/anatomy";
import type { DetectedAorticOpening } from "./heartAorticOpening";
import { buildTubeFromPoints } from "./stentLatticeMesh";
import { getMainTrunk } from "./vesselGraph";
import type { VesselGraph } from "./vesselGraph";

const TWO_PI = Math.PI * 2;
/**
 * 冠動脈入口部同士の解剖学的な標準角度間隔。バルサルバ洞は右冠尖洞・左冠尖洞・
 * 無冠尖洞の3つがおよそ等間隔(120°)に並ぶとされる。
 */
const OSTIUM_SEPARATION_ANGLE = TWO_PI / 3;
/**
 * 幾何学的な弦当てはめから逆算した半径に対し、RCA/LAD/LCX個々の入口部を可視化した
 * 内腔の壁の内側に確実に収めるための追加の安全率(computeAorticRootFrame参照)。
 */
const CONTAINMENT_SAFETY_BUFFER = 1.03;
/**
 * 弦の垂直二等分線上で、120°の弦当てはめが与える最小の中心オフセットに掛ける
 * 追加の倍率。倍率1.0(=純粋な120°弦当てはめ、現在の値)は、中心を冠動脈入口部の
 * 実際の位置に最も忠実な値——これより大きくすると、両オスティウムを通る円という
 * 制約は保ったまま(半径をその分再計算する)中心が外側へ押し出され、見かけの角度も
 * 120°より狭くなる(押し出すほど遠くの中心から見た弦の張る角度は小さくなるため)。
 *
 * 以前は1.5倍を使っていた(洞管接合部より上が心筋メッシュの内部に埋もれるのを
 * 避ける目的)が、この押し出しがheartAorticOpening.tsのdetectAorticOpening(実測
 * 開口部の検出)の探索起点をずらし、冠動脈入口部から離れた別の領域(セグメンテー
 * ション時に残った他の大血管の断端等)を検出してしまう副作用があることが実測で
 * 判明した(ユーザーからの指摘・断面表示での目視確認により発覚)。現在は上行大動脈の
 * 埋もれ対策をAORTIC_CAVITY_UP_MAX(クリッピング空洞の高さ)側で担っているため、
 * こちらの押し出しは不要と判断し1.0に戻した——実測(heart-realistic.glbに対する
 * 全テスト)でも、この変更後に内腔収まり・空洞の高さ範囲などの既存の安全マージンは
 * 崩れていないことを確認済み。
 */
const CENTER_OUTWARD_PUSH_FACTOR = 1.0;
/**
 * 左冠動脈主幹部(LMT)の大動脈壁側の起始点(座標ピッカーでユーザーが実測した値)。
 *
 * 経緯: 中心線データ(centerlines.json、scripts/extract_centerlines.pyが生成)には
 * LMTが独立したセグメントとして含まれておらず、LAD/LCXそれぞれの起始点(根ノード)は
 * 既にLMTの分岐点より末梢側(=大動脈壁からは離れた位置)にある。これまでは
 * `(LAD起始点+LCX起始点)/2`を「左冠動脈入口部」の代役として使っていたが、これは
 * 実際の大動脈壁上のLMT起始点ではなく、LMTが分岐した後の点に過ぎない
 * (ユーザーが座標ピッカーで両者を実測し、位置が大きく異なることを確認・報告)。
 * この代役をそのまま大動脈基部の中心軸の逆算(弦当てはめ)に使うと、大動脈基部
 * (バルサルバ洞)の位置自体が実際の大動脈弁とは無関係な位置(LMT分岐点寄り)に
 * ズレてしまう——これが、大動脈基部が肺動脈弁に近い位置に見えていた根本原因の
 * 一つだった可能性が高い。
 *
 * この値は、computeOstiumChordFitPositionの弦当てはめ(位置・角度の逆算)にのみ使う。
 * LAD/LCXそれぞれの実際の入口部座標(ladOstium/lcxOstium、内腔収まりの検証に使う値)
 * はcenterlines.json由来のまま変更しない——LMT区間自体の可視化(血管メッシュとして
 * 表示すること)は別途の作業として扱う。
 */
export const MEASURED_LEFT_MAIN_OSTIUM = new Vector3(0.0792, 0.8275, -0.0134);
/**
 * 実測した大動脈弁の位置(座標ピッカーで大動脈弁の開口部の縁を6点なぞってクリックし、
 * 最小二乗法で平面・円をフィッティングして求めた絶対座標。フィット残差は最大0.009・
 * 平均0.007ワールド単位、半径0.40に対して2%未満と非常に良好な一致——詳細な計測手順は
 * AORTIC_VALVE_NORMALのコメント参照)。
 *
 * computeAorticRootFrameのcenter(大動脈基部フレームの中心軸上の代表点)に直接使う。
 *
 * 経緯: 以前は、冠動脈入口部の弦当てはめ(またはdetectAorticOpeningが実測した心筋
 * メッシュの開口部中心)をcenterとして使い、実測したこの弁の位置とのずれ(実測で
 * 約0.3 heartScale比率)を、管の下端だけをsmoothstepで弁の方向へ後付けで曲げる方式
 * (valveLeanOffsetAt、削除済み)で橋渡ししていた。しかしこれは管の下端だけの局所的な
 * 補正に過ぎず、洞全体・上行大動脈の大部分は実測弁から離れた位置に居座ったままで、
 * 肺動脈弁の領域にまで張り出して見える原因になっていた(ユーザー報告・実測で確認:
 * 旧center→肺動脈弁中心の距離0.28 vs 実測弁→肺動脈弁中心の距離0.55、後者の方が
 * ほぼ2倍離れている)。この値を直接centerに使うことで、後付けの曲げを一切必要とせず、
 * 洞全体が最初から正しい位置にアンカーされるようにする。
 *
 * detectedOpening.axis(実測した心臓の傾いた長軸)を前提にキャリブレーションされた
 * 絶対座標のため、detectedOpeningが無い場合の単純化されたフォールバック(垂直固定軸)
 * には使わない(computeAorticRootFrame参照)。
 */
export const MEASURED_AORTIC_VALVE_CENTER = new Vector3(-0.1985, 0.7354, 0.0042);
/**
 * 上行大動脈(frame.ascendingRadius)の直径を、心臓の幅(heartWidth)の何倍にするか。
 * 実測(成人の経胸壁心エコー/CT基準値): 上行大動脈径 約30mm、心臓の幅 約120mm程度
 * →比率にして概ね1/4(0.25)。バルサルバ洞(sinusRadius)は解剖学的にこれより太い
 * (AORTIC_ROOT_PROFILEのコメント参照、洞:上行大動脈の径比は概ね1.3:1.15)ため、
 * この比率はバルサルバ洞ではなく上行大動脈・弓部・下行大動脈にのみ適用する。
 * sinusRadius(実際の冠動脈入口部の間隔から逆算)を上行大動脈以降にもそのまま
 * 使うと、実データでは心臓の幅の30〜40%にもなり(冠動脈入口部の間隔と心臓全体の
 * サイズは独立した実測値のため)、大動脈が心臓に対して不自然に太く見え、心臓
 * メッシュと重なって見える原因になっていた。
 */
const ARCH_DIAMETER_HEART_WIDTH_RATIO = 0.225;
/**
 * heartWidthが得られない場合(未ロード時・heartWidth未指定のテスト等)の
 * frame.ascendingRadiusフォールバック値——sinusRadiusに対する比率。従来
 * (heartWidthベースの算出を導入する前)のARCH_RADIUS_RATIOS[0]/PEAK_RADIUS_UNITS
 * と同じ比率にし、heartWidth情報が無い場合は挙動を変えない。
 */
const ASCENDING_RADIUS_FALLBACK_RATIO = 1.15 / 1.35;

/**
 * 冠動脈入口部の実位置から幾何学的に逆算した、大動脈基部(バルサルバ洞)の
 * 中心軸・半径・3つの洞の角度位置。
 */
export interface AorticRootFrame {
  /** 中心軸上の代表点。detectedOpeningがある場合はMEASURED_AORTIC_VALVE_CENTER
   * (実測した大動脈弁の位置そのもの)、無い場合は冠動脈入口部の弦当てはめ位置に
   * フォールバックする(computeAorticRootFrame参照)。 */
  center: Vector3;
  /** 中心軸の方向。解剖座標系の頭側方向に固定する(実際の上行大動脈はやや前方に
   * 傾くが、まずは単純化のため純粋な頭側方向とする)。 */
  axis: Vector3;
  /**
   * バルサルバ洞レベルでの交連部(3つの洞の間のくびれ部分)の基準半径。心臓メッシュの
   * バウンディングボックス幅(heartWidth)から算出する(ascendingRadiusと同じ考え方、
   * ARCH_DIAMETER_HEART_WIDTH_RATIO参照)——実際の冠動脈入口部の間隔にはよらない
   * (入口部への到達はrca/leftLobeAmplitudeScaleが担う)。heartWidth未指定時のみ、
   * 従来通り冠動脈入口部の間隔から逆算した値にフォールバックする。
   */
  sinusRadius: number;
  /**
   * 上行大動脈(洞管接合部より上、ASCENDING_END_UP)の半径。sinusRadiusとは独立に、
   * 心臓メッシュのバウンディングボックス幅(heartWidth)から算出する
   * (ARCH_DIAMETER_HEART_WIDTH_RATIO参照)——sinusRadiusは実際の冠動脈入口部の
   * 間隔(弦当てはめ)から逆算するため、心臓全体のサイズとは独立に決まり、実データでは
   * 心臓の幅の30〜40%にもなってしまう(バルサルバ洞は解剖学的に最も太い部分のため
   * ある程度太いのは正しいが、この値をそのまま上行大動脈・大動脈弓・下行大動脈の
   * 半径にも使うと、実物より遥かに太い管になり、心臓メッシュと不自然に重なって見える
   * 原因になっていた)。洞管接合部(up=0.85)からascendingEnd(up=4.5)にかけて、
   * sinusRadius由来のスケールからこのascendingRadius由来のスケールへ滑らかに
   * テーパーさせ(evaluateAorticRootRadius/buildLobedTubeGeometry参照)、弓部・
   * 下行大動脈・鎖骨下動脈相当の分岐(buildAorticArchGeometry等)はこのスケールを
   * そのまま引き継ぐ。バルサルバ洞自体(冠動脈入口部を含む台地、up<=0.85)は
   * 実際の入口部座標を内腔に収める必要があるため、引き続きsinusRadius由来のまま
   * 変更しない。
   */
  ascendingRadius: number;
  /** 右冠尖洞(RCA入口部)の中心角度(ラジアン、中心軸から見たX-Z平面上の角度)。 */
  rcaAngle: number;
  /** 左冠尖洞(LAD/LCX入口部の中点)の中心角度。 */
  leftAngle: number;
  /** 無冠尖洞の中心角度(対応する入口部が実データに無いため、残りの弧の中点に置く)。 */
  nonCoronaryAngle: number;
  /**
   * 各洞(RCA洞・左冠洞・無冠尖洞)の局所的な張り出し量の倍率(AORTIC_ROOT_PROFILEの
   * lobeAmplitudeAmt列——洞の張り出しの高さ方向の形状——に掛ける、洞ごとに異なる係数、
   * lobeBulge参照)。sinusRadius(交連部の基準半径、心臓の幅から算出)を全ての冠動脈
   * 入口部を収める大きさまで一律に膨らませる従来の方式(3洞が均等に大きな円になり、
   * 心臓に対して不自然に太くなる原因だった)ではなく、基準円は心臓サイズに応じた
   * 適切な太さのまま、実際に入口部がある2つの洞(RCA洞・左冠洞)だけを、その入口部の
   * 実座標に届くよう個別に張り出させる——実際のバルサルバ洞の3つの弁尖洞がそれぞれ
   * 局所的に膨らむ構造(このファイル冒頭のコメント参照)そのものであり、解剖学的にも
   * より正確。computeAorticRootFrameが、各入口部の実座標・その洞の角度からの
   * ずれ(falloff)・高さを使って、その洞の壁がちょうど入口部に届くように逆算する。
   * 無冠尖洞は対応する実データが無いため、他の2つの平均を使う(3つの洞がおおむね
   * 同程度の大きさになる実際の解剖に合わせる)。
   */
  rcaLobeAmplitudeScale: number;
  leftLobeAmplitudeScale: number;
  nonCoronaryLobeAmplitudeScale: number;
}

/** 2つの角度の間で、円周上のより大きい方の弧を二等分する角度を返す(無冠尖洞の
 * 位置決めに使う。実データには対応する入口部が無いため、他の2つの洞から最も
 * 離れた位置に置く)。 */
function bisectLargerArc(angleA: number, angleB: number): number {
  const forwardAtoB = (((angleB - angleA) % TWO_PI) + TWO_PI) % TWO_PI;
  const forwardBtoA = TWO_PI - forwardAtoB;
  return forwardAtoB >= forwardBtoA ? angleA + forwardAtoB / 2 : angleB + forwardBtoA / 2;
}

/**
 * RCA/LAD/LCXの冠動脈入口部の位置から、大動脈基部(バルサルバ洞)の中心軸・半径・
 * 3つの洞の角度位置を幾何学的に逆算する。
 *
 * 手順:
 *   1. RCA入口部と左冠動脈入口部(LAD/LCXの中点)を、頭側軸に垂直な水平面
 *      (X-Z平面)へ投影する(Y=頭側成分は無視する)。
 *   2. この2点が、中心角OSTIUM_SEPARATION_ANGLE(120°)の弦をなす円の円周上に
 *      あるとみなし、弦の長さ(2入口部間の水平距離)から半径を逆算する
 *      (弦長 = 2・半径・sin(角度/2))。
 *   3. 弦の垂直二等分線上で、その半径になる中心位置を求める(解は弦を挟んで
 *      2つあるため、心臓の重心からより遠い側=解剖学的に「外向き」の側を採用する)。
 *   4. 中心軸の高さ(Y)は、2つの入口部の高さの平均。
 *
 * 検証として、RCA/左冠動脈入口部それぞれから求めた中心軸(頭側方向の直線)までの
 * 水平距離を、逆算した半径と比較してコンソールへログ出力する(構築上ほぼ厳密に
 * 一致するはずだが、念のため実測して報告する)。
 *
 * 3本すべての中心線グラフが必要(基部の中心・向き・3つの洞の角度位置を実データに
 * 基づかせるため)。いずれか欠けている場合、または2つの入口部の水平距離がほぼ0の
 * 場合(逆算不能)はnullを返す。
 */
/** computeOstiumChordFitPositionの戻り値。位置(中心・軸・3洞の角度)のみを扱い、
 * heartWidthに依存する太さの計算は含まない(computeAorticRootFrameが別途行う)。 */
interface OstiumChordFitPosition {
  center: Vector3;
  axis: Vector3;
  rcaAngle: number;
  leftAngle: number;
  nonCoronaryAngle: number;
  rcaOstium: Vector3;
  ladOstium: Vector3;
  lcxOstium: Vector3;
  leftOstium: Vector3;
  geometricSinusRadius: number;
}

/**
 * RCA/LAD/LCXの冠動脈入口部の位置から、大動脈基部(バルサルバ洞)の中心軸・
 * 3つの洞の角度位置を幾何学的に逆算する(位置のみ、太さは含まない)。
 *
 * 手順:
 *   1. RCA入口部と左冠動脈入口部(LAD/LCXの中点)を、頭側軸に垂直な水平面
 *      (X-Z平面)へ投影する(Y=頭側成分は無視する)。
 *   2. この2点が、中心角OSTIUM_SEPARATION_ANGLE(120°)の弦をなす円の円周上に
 *      あるとみなし、弦の長さ(2入口部間の水平距離)から半径を逆算する
 *      (弦長 = 2・半径・sin(角度/2))。
 *   3. 弦の垂直二等分線上で、その半径になる中心位置を求める(解は弦を挟んで
 *      2つあるため、心臓の重心からより遠い側=解剖学的に「外向き」の側を採用する)。
 *   4. 中心軸の高さ(Y)は、2つの入口部の高さの平均。
 *
 * computeAorticRootFrameから呼ばれるほか、heartAorticOpening.tsのdetectAorticOpeningに
 * 渡す「探索の中心」(approxCenter)を得るためにも単独で使われる(ModelLoader.tsx等)。
 */
export function computeOstiumChordFitPosition(
  heartCentroid: Vector3,
  graphs: Map<VesselId, VesselGraph>,
  /**
   * 大動脈基部の中心軸の向き。省略時は解剖座標系の頭側方向(0,1,0)に固定する(従来の
   * 挙動)。heartAorticOpening.tsのdetectAorticOpeningが実測する、心臓メッシュ自身の
   * 長軸(心尖部→大動脈基部の実際の方向、AorticRootFrame.axis参照)を渡すと、
   * 心臓メッシュ自体が世界座標の鉛直方向から傾いている場合にそれへ追従する。
   */
  axisOverride?: Vector3 | null,
): OstiumChordFitPosition | null {
  const rcaGraph = graphs.get("RCA");
  const ladGraph = graphs.get("LAD");
  const lcxGraph = graphs.get("LCX");
  if (!rcaGraph || !ladGraph || !lcxGraph) return null;

  const rcaOstium = getMainTrunk(rcaGraph).points[0]?.position;
  const ladOstium = getMainTrunk(ladGraph).points[0]?.position;
  const lcxOstium = getMainTrunk(lcxGraph).points[0]?.position;
  if (!rcaOstium || !ladOstium || !lcxOstium) return null;

  // LAD/LCXは解剖学的には単一の左冠動脈主幹部(LMT)から起始するが、中心線データには
  // LMT自体が独立したセグメントとして含まれていない(LAD/LCXの起始点は既にLMTの
  // 分岐点より末梢側)。弦当てはめ(位置・角度の逆算)には、実測した大動脈壁側の
  // LMT起始点(MEASURED_LEFT_MAIN_OSTIUM参照)を「左冠動脈入口部」として使う——
  // LAD/LCXそれぞれの実際の入口部座標(内腔収まりの検証に使う)はそのまま。
  const leftOstium = MEASURED_LEFT_MAIN_OSTIUM.clone();

  const axis = axisOverride ?? new Vector3(0, 1, 0);
  const dx = leftOstium.x - rcaOstium.x;
  const dz = leftOstium.z - rcaOstium.z;
  const chordLength = Math.hypot(dx, dz);
  if (chordLength < 1e-8) return null;

  const baseSinusRadius = chordLength / (2 * Math.sin(OSTIUM_SEPARATION_ANGLE / 2));
  const midX = (rcaOstium.x + leftOstium.x) / 2;
  const midZ = (rcaOstium.z + leftOstium.z) / 2;
  const halfChord = chordLength / 2;
  const baseCenterOffset = Math.sqrt(Math.max(baseSinusRadius * baseSinusRadius - halfChord * halfChord, 0));
  const centerOffset = baseCenterOffset * CENTER_OUTWARD_PUSH_FACTOR;
  // 中心を押し出した分、半径を再計算する(両オスティウムは引き続きこの新しい中心から
  // 等距離にあり、円筒の側面上に乗る)。
  const geometricSinusRadius = Math.hypot(halfChord, centerOffset);
  const perpX = -dz / chordLength;
  const perpZ = dx / chordLength;

  // 弦の垂直二等分線上の2つの候補のうち、心臓の重心からより遠い側(解剖学的に
  // 「外向き」)を大動脈基部の中心とする。
  const candidateA = { x: midX + perpX * centerOffset, z: midZ + perpZ * centerOffset };
  const candidateB = { x: midX - perpX * centerOffset, z: midZ - perpZ * centerOffset };
  const distA = Math.hypot(candidateA.x - heartCentroid.x, candidateA.z - heartCentroid.z);
  const distB = Math.hypot(candidateB.x - heartCentroid.x, candidateB.z - heartCentroid.z);
  const chosen = distA >= distB ? candidateA : candidateB;

  // 中心の高さ(centerYの一次元的な近似)はaxisが鉛直(0,1,0)の場合のみ意味を持つが、
  // 弦当てはめ自体は元々axis=(0,1,0)前提のX-Z平面上の幾何(この関数のコメント参照)
  // であり、centerはあくまで位置の推定値(detectedOpeningがあればそちらで上書きされる、
  // computeAorticRootFrame参照)なので、axisが傾いていてもこの単純な高さの平均のままで
  // 十分な近似とする。
  const centerY = (rcaOstium.y + leftOstium.y) / 2;
  const center = new Vector3(chosen.x, centerY, chosen.z);

  // 3洞の角度は、axisに垂直な断面基準(u, v)から見た角度で求める(axis=(0,1,0)固定
  // だった頃はu=(1,0,0), v=(0,0,1)となり、atan2(z,x)と完全に一致する——computeAorticRootFrame・
  // buildLobedTubeGeometry等、この角度を使う側は全てaxis由来のu,vを前提にしているため、
  // axisが傾いた場合もこの基準を使わないと、3洞の張り出しが実際のオスティウムの方向を
  // 向かなくなってしまう)。
  const { u, v } = computeCrossSectionBasis(axis);
  const rcaOffset = rcaOstium.clone().sub(center);
  const leftOffset = leftOstium.clone().sub(center);
  const rcaAngle = Math.atan2(rcaOffset.dot(v), rcaOffset.dot(u));
  const leftAngle = Math.atan2(leftOffset.dot(v), leftOffset.dot(u));
  const nonCoronaryAngle = bisectLargerArc(rcaAngle, leftAngle);

  return { center, axis, rcaAngle, leftAngle, nonCoronaryAngle, rcaOstium, ladOstium, lcxOstium, leftOstium, geometricSinusRadius };
}

export function computeAorticRootFrame(
  heartCentroid: Vector3,
  graphs: Map<VesselId, VesselGraph>,
  /**
   * 心臓メッシュのバウンディングボックス幅(左右方向、ARCH_LEFT_DIRECTION=(1,0,0)の
   * 軸に対応)。frame.ascendingRadius(上行大動脈・大動脈弓・下行大動脈・鎖骨下動脈
   * 相当の分岐の太さの基準)の算出に使う(ARCH_DIAMETER_HEART_WIDTH_RATIO参照)。
   * 未指定(0)の場合はASCENDING_RADIUS_FALLBACK_RATIOによるsinusRadius基準の
   * フォールバック値を使う(heartMesh未ロード時やテストでの簡易フレーム構築向け)。
   */
  heartWidth = 0,
  /**
   * heartAorticOpening.tsのdetectAorticOpeningが実測した、心筋メッシュに実在する
   * 大動脈弁輪相当の開口部の位置(省略時・検出失敗時はnull/undefined)。指定された
   * 場合、中心位置(center)はMEASURED_AORTIC_VALVE_CENTER(実測した大動脈弁の位置、
   * 下記コメント参照)を使う。半径(sinusRadius/ascendingRadius)は従来通り
   * heartWidthベースのまま変更しない——検出した開口部の半径は角度によって大きく
   * 不規則なため、可視化する円筒の太さの基準としては使わない。
   *
   * detectedOpeningが無い(心筋メッシュ未ロード時・テストでの簡易フレーム構築等)
   * 場合は、従来通り冠動脈入口部の弦当てはめ位置(position.center)にフォールバック
   * する——MEASURED_AORTIC_VALVE_CENTERは、detectedOpening.axis(実測した心臓の
   * 傾いた長軸)を前提にキャリブレーションされた絶対座標のため、フォールバック時の
   * 単純化された垂直固定軸(axis=(0,1,0))と組み合わせると、洞の張り出しが非対称に
   * 歪むことを実測で確認済み(RCA入口部が洞の台地の範囲外に出て張り出し倍率が
   * 2倍以上に膨れ上がる)。本番では心筋メッシュのロード後は常にdetectedOpeningが
   * 得られるため、この条件分岐で実際の不具合(大動脈弁とのズレ・肺動脈弁領域への
   * はみ出し)は解消される。
   */
  detectedOpening?: DetectedAorticOpening | null,
): AorticRootFrame | null {
  const position = computeOstiumChordFitPosition(heartCentroid, graphs, detectedOpening?.axis);
  if (!position) return null;
  const { axis, rcaOstium, ladOstium, lcxOstium, leftOstium, geometricSinusRadius } = position;

  // 過去の試行錯誤: 一時期、中心軸(axis)自体を「centerから実測した大動脈弁の位置へ
  // 向かう方向」として定義し直したことがあったが、これは座標ピッカーのクリック誤差
  // (3D視点での目分量クリックは数cm相当ブレる)が軸の向き自体を大きく狂わせ、上行
  // 大動脈が心臓からほぼ水平に近い、解剖学的にありえない角度で伸びる結果になった
  // (実際にレンダリングして確認、ユーザー報告により発覚)。axis自体は心尖部基準の
  // 心臓の長軸(detectedOpening.axis、心臓全体の傾きという、より安定した実測値)の
  // まま変更しない。
  //
  // center自体は、以前は冠動脈入口部の弦当てはめ・detectAorticOpeningの実測開口部
  // 中心を使っていたが、いずれも実測した大動脈弁の位置そのものとは一致せず(実測で
  // 約0.3 heartScale比率のずれ)、この2つを橋渡しするために管の下端だけをsmoothstepで
  // 実測弁の方向へ後付けで曲げる方式(valveLeanOffsetAt)を採っていた。しかしこれは
  // 管の下端だけの局所的な補正に過ぎず、洞全体・上行大動脈の大部分は依然として
  // 実測弁から離れた位置に居座ったままで、肺動脈弁の領域にまで張り出して見える
  // 原因になっていた(ユーザー報告・実測で確認)。今はMEASURED_AORTIC_VALVE_CENTER
  // (実測した大動脈弁の位置そのもの)を直接centerに使うことで、後付けの曲げを
  // 一切必要とせず、洞全体が最初から正しい位置にアンカーされるようにする。
  const center = detectedOpening ? MEASURED_AORTIC_VALVE_CENTER.clone() : position.center;
  // 3洞の角度は、中心・軸が確定した後に、この中心・軸から見た角度として求め直す
  // (角度は中心からの相対値のため、中心が動けば入口部の実座標に対する角度も変わる)。
  // axisに垂直な断面基準(u, v)から見た角度を使う(computeOstiumChordFitPosition内の
  // コメント参照——axisが傾いている場合、生のatan2(z,x)では3洞の張り出しが実際の
  // オスティウムの方向を向かなくなる)。
  const { u: axisU, v: axisV } = computeCrossSectionBasis(axis);
  const rcaOffset = rcaOstium.clone().sub(center);
  const leftOffset = leftOstium.clone().sub(center);
  const rcaAngle = Math.atan2(rcaOffset.dot(axisV), rcaOffset.dot(axisU));
  const leftAngle = Math.atan2(leftOffset.dot(axisV), leftOffset.dot(axisU));
  const nonCoronaryAngle = bisectLargerArc(rcaAngle, leftAngle);

  // 中心軸(axis)からの距離も、axisに沿った成分を除いた大きさで求める(axis=(0,1,0)
  // 固定だった頃はhypot(x,z)と一致するが、傾いたaxisでは軸方向の成分を正しく除かないと
  // 距離が実際より大きく(または小さく)算出されてしまう)。
  const rcaDistanceToAxis = rcaOffset.clone().addScaledVector(axis, -rcaOffset.dot(axis)).length();
  const leftDistanceToAxis = leftOffset.clone().addScaledVector(axis, -leftOffset.dot(axis)).length();

  // heartWidthが無い場合(未ロード時・テスト等)専用のフォールバック計算: 従来通り、
  // 弦当てはめの半径(geometricSinusRadius)を基準円にし、3つの入口部それぞれが
  // 局所半径に収まっているかの比率(containmentRatio)で基準円自体を拡大する
  // (洞ごとの張り出しではなく、基準円を一律に大きくして対応する——heartWidthが
  // 無い状況では心臓サイズに合わせる目標自体が意味を持たないため、入口部の
  // 内腔収まりを最優先する従来の挙動をそのまま維持する)。
  const provisionalFrame: AorticRootFrame = {
    center,
    axis,
    sinusRadius: geometricSinusRadius,
    ascendingRadius: geometricSinusRadius * ASCENDING_RADIUS_FALLBACK_RATIO,
    rcaAngle,
    leftAngle,
    nonCoronaryAngle,
    rcaLobeAmplitudeScale: 1,
    leftLobeAmplitudeScale: 1,
    nonCoronaryLobeAmplitudeScale: 1,
  };
  let containmentRatio = 1;
  for (const [label, ostium] of [
    ["RCA", rcaOstium],
    ["LAD", ladOstium],
    ["LCX", lcxOstium],
  ] as const) {
    const { upRelative } = projectOntoFrame(provisionalFrame, ostium);
    if (upRelative < SINUS_PLATEAU_UP_RANGE[0] || upRelative > SINUS_PLATEAU_UP_RANGE[1]) {
      console.warn(
        `[aorticRootMesh] ${label}入口部の高さ(up相対値=${upRelative.toFixed(3)})が洞の台地の範囲` +
          `[${SINUS_PLATEAU_UP_RANGE[0]}, ${SINUS_PLATEAU_UP_RANGE[1]}]の外にあるため、内腔安全マージンが不足する可能性があります。`,
      );
    }
    const bound = evaluateAorticRootRadius(provisionalFrame, ostium);
    if (bound > 1e-6) {
      containmentRatio = Math.max(containmentRatio, distanceFromAxis(provisionalFrame, ostium) / bound);
    }
  }
  const chordFitSinusRadius = geometricSinusRadius * containmentRatio * CONTAINMENT_SAFETY_BUFFER;

  // 上行大動脈の基準半径はheartWidthから算出する(AorticRootFrame.ascendingRadius参照)。
  // heartWidthが未指定(0)の場合のみ、上のフォールバック計算(chordFitSinusRadius)を使う。
  const ascendingRadius =
    heartWidth > 1e-6 ? (heartWidth * ARCH_DIAMETER_HEART_WIDTH_RATIO) / 2 : chordFitSinusRadius * ASCENDING_RADIUS_FALLBACK_RATIO;
  const initialSinusRadius = heartWidth > 1e-6 ? ascendingRadius * (PEAK_RADIUS_UNITS / ARCH_RADIUS_RATIOS[0]) : chordFitSinusRadius;

  // バルサルバ洞の交連部の基準半径(sinusRadius)は、heartWidthから求めた見た目上の
  // 大きさ(initialSinusRadius)をそのまま使うのではなく、RCA洞・左冠洞のどちらかが
  // 実際の入口部に届くために基準の張り出し(amplitudeScale=1、PEAK_RADIUS_UNITSに
  // 相当)を超えて大きく張り出す必要がある場合は、基準円自体をその分だけ底上げする
  // (フォールバック分岐のcontainmentRatioと同じ考え方を、heartWidthベースの分岐にも
  // 適用したもの)。
  //
  // 経緯: 大動脈基部の中心を実測した大動脈弁の位置にアンカーするよう変更した後、
  // ある実データで「RCA入口部に届かせるには基準の張り出し(amplitudeScale=1.0)の
  // 約1.5倍もの局所的な張り出しが必要」という事態が発生し、その洞だけが周囲から
  // 切り離された「角」のように突出して見える不具合になっていた(ユーザー報告・
  // 実測で確認)。原因は、heartWidthベースの基準円が実際の入口部の位置とは無関係に
  // (見た目上の太さだけを基準に)決まっており、基準円が実際に必要な大きさより
  // 小さい場合、その不足分がすべて1つの洞の局所的な張り出しだけに押し付けられて
  // いたこと——RCA洞は大きく張り出す一方、左冠洞は基準円の内側に余裕を残したまま
  // (張り出し倍率0)になっており、この非対称さが不自然な突起として現れていた。
  // 基準円自体を(全洞共通で)底上げすることで、不足分を一部の洞だけに集中させず、
  // 3洞全体でより均等な、なだらかな膨らみになるようにする。
  const provisionalReferenceFrame: AorticRootFrame = {
    center,
    axis,
    sinusRadius: initialSinusRadius,
    ascendingRadius,
    rcaAngle,
    leftAngle,
    nonCoronaryAngle,
    rcaLobeAmplitudeScale: 1,
    leftLobeAmplitudeScale: 1,
    nonCoronaryLobeAmplitudeScale: 1,
  };
  let sinusGrowthRatio = 1;
  if (heartWidth > 1e-6) {
    for (const [, ostium] of [
      ["RCA", rcaOstium],
      ["LMT", MEASURED_LEFT_MAIN_OSTIUM],
    ] as const) {
      const bound = evaluateAorticRootRadius(provisionalReferenceFrame, ostium);
      if (bound > 1e-6) {
        sinusGrowthRatio = Math.max(sinusGrowthRatio, (distanceFromAxis(provisionalReferenceFrame, ostium) * CONTAINMENT_SAFETY_BUFFER) / bound);
      }
    }
  }
  const sinusRadius = heartWidth > 1e-6 ? initialSinusRadius * sinusGrowthRatio : chordFitSinusRadius;

  // 各洞(RCA洞・左冠洞)の局所的な張り出し倍率を、実際の入口部座標に届くよう逆算する
  // (AorticRootFrame.rca/leftLobeAmplitudeScaleのコメント参照)。基準円を上でsinusGrowthRatio
  // 分だけ底上げ済みのため、ここで解く倍率は1.0付近の穏やかな値になるはず(heartWidthが
  // 無い場合は、chordFitSinusRadius(=sinusRadius)自体が既に3入口部を包含する大きさに
  // なっているため、張り出し倍率は基準の1のままでよい)。
  //
  // 左冠洞は、LAD/LCX個々の入口部ではなくMEASURED_LEFT_MAIN_OSTIUM(実測したLMTの
  // 大動脈壁側起始点)に届くよう逆算する——解剖学的には、大動脈壁を実際に貫くのは
  // LMTの起始点ただ1点であり、LAD/LCX自体はLMTが分岐した後の、既に心筋表面上に
  // ある構造のため、大動脈基部の可視化ジオメトリがLAD/LCXの座標まで包含する必要は
  // 本来無い(以前はLMTの実測データが無かったため、代役としてLAD/LCXを個別に
  // 包含する設計にしていた)。
  let rcaLobeAmplitudeScale = 1;
  let leftLobeAmplitudeScale = 1;
  let nonCoronaryLobeAmplitudeScale = 1;
  if (heartWidth > 1e-6) {
    const scaleReferenceFrame: AorticRootFrame = {
      center,
      axis,
      sinusRadius,
      ascendingRadius,
      rcaAngle,
      leftAngle,
      nonCoronaryAngle,
      rcaLobeAmplitudeScale: 1,
      leftLobeAmplitudeScale: 1,
      nonCoronaryLobeAmplitudeScale: 1,
    };
    rcaLobeAmplitudeScale = computeRequiredLobeAmplitudeScale("RCA", rcaOstium, rcaAngle, scaleReferenceFrame);
    leftLobeAmplitudeScale = computeRequiredLobeAmplitudeScale("LMT", MEASURED_LEFT_MAIN_OSTIUM, leftAngle, scaleReferenceFrame);
    // 無冠尖洞は対応する実データが無いため、他の2つの平均を使う(3つの洞がおおむね
    // 同程度の大きさになる実際の解剖に合わせる、AorticRootFrame参照)。
    nonCoronaryLobeAmplitudeScale = (rcaLobeAmplitudeScale + leftLobeAmplitudeScale) / 2;
  }

  console.log(
    "[aorticRootMesh] 大動脈基部フレームの検証: " +
      `弦当てはめ半径(位置の逆算に使用、参考値)=${geometricSinusRadius.toFixed(4)}, ` +
      `RCA入口部までの距離=${rcaDistanceToAxis.toFixed(4)}, 左冠動脈入口部までの距離=${leftDistanceToAxis.toFixed(4)}, ` +
      `中心=${detectedOpening ? "心筋メッシュの実測開口部" : "冠動脈入口部の弦当てはめ(推定)"}` +
      `(${center.x.toFixed(4)}, ${center.y.toFixed(4)}, ${center.z.toFixed(4)})` +
      (detectedOpening
        ? `, 弦当てはめとの差=${center.distanceTo(position.center).toFixed(4)}, 実測開口部の平均半径(参考値)=${detectedOpening.radius.toFixed(4)}`
        : ""),
  );
  console.log(
    "[aorticRootMesh] 大動脈の太さの検証: " +
      `心臓の幅(heartWidth)=${heartWidth.toFixed(4)}, ` +
      `上行大動脈の直径(2*ascendingRadius)=${(2 * ascendingRadius).toFixed(4)}, ` +
      `比率=${heartWidth > 1e-6 ? ((2 * ascendingRadius) / heartWidth).toFixed(4) : "N/A(heartWidth未指定、フォールバック使用)"}` +
      `(目標: 0.20〜0.25)`,
  );
  console.log(
    "[aorticRootMesh] 洞ごとの張り出し倍率の検証: " +
      `RCA洞=${rcaLobeAmplitudeScale.toFixed(3)}, 左冠洞=${leftLobeAmplitudeScale.toFixed(3)}, ` +
      `無冠尖洞=${nonCoronaryLobeAmplitudeScale.toFixed(3)}(基準の張り出し量に対する倍率、1.0が基準)`,
  );

  const frame: AorticRootFrame = {
    center,
    axis,
    sinusRadius,
    ascendingRadius,
    rcaAngle,
    leftAngle,
    nonCoronaryAngle,
    rcaLobeAmplitudeScale,
    leftLobeAmplitudeScale,
    nonCoronaryLobeAmplitudeScale,
  };

  // 検証: RCA入口部・LMT起始点(実測値)が、最終的なframeで実際に内腔の壁の中に
  // 収まっているかを実測してログに報告する(基準円を心臓サイズに縮めたため、洞の
  // 張り出しが実際に入口部へ届いているかを必ず確認する)。LAD/LCXはLMT分岐後の
  // 構造のため、ここでの内腔収まり検証の対象には含めない(上のコメント参照)。
  for (const [label, ostium] of [
    ["RCA", rcaOstium],
    ["LMT", MEASURED_LEFT_MAIN_OSTIUM],
  ] as const) {
    const bound = evaluateAorticRootRadius(frame, ostium);
    const actual = distanceFromAxis(frame, ostium);
    const ratio = bound > 1e-6 ? actual / bound : Infinity;
    const withinWall = ratio <= 1.001;
    (withinWall ? console.log : console.warn)(
      `[aorticRootMesh] ${label}入口部の内腔収まり検証: 距離=${actual.toFixed(4)}, 局所半径=${bound.toFixed(4)}, ` +
        `到達率=${(ratio * 100).toFixed(1)}%${withinWall ? "" : " -- 壁からはみ出しています"}`,
    );
  }

  return frame;
}

/**
 * ある洞(lobeAngle、frame.rca/leftAngleのいずれか)が、実際の冠動脈入口部座標
 * (ostium)にちょうど届くために必要なamplitudeScale(lobeBulge参照)を逆算する。
 * 入口部の高さ(up)・角度でのプロファイル補間値(baseRadiusAmt・lobeAmplitudeAmt)・
 * 洞中心からの角度のずれ(falloff)を使い、「その洞の壁の半径が入口部までの距離
 * (安全マージン込み)にちょうど一致する」amplitudeScaleを解く。
 *
 * 台地の外(lobeAmplitudeAmt≈0、入口部の高さが台地の範囲から外れている)、または
 * 洞の角度範囲の外(falloff≈0、入口部の角度が対応する洞から離れすぎている)の場合は、
 * 局所的な張り出しだけでは入口部に届かせられないため、警告を出してamplitudeScale=0
 * (張り出し無し、基準円のみ)を返す——この場合、入口部が壁からわずかにはみ出す
 * 可能性がある(SINUS_PLATEAU_UP_RANGEの警告と同じ性質の限界で、実際の解剖では稀)。
 */
function computeRequiredLobeAmplitudeScale(
  label: string,
  ostium: Vector3,
  lobeAngle: number,
  positionFrame: AorticRootFrame,
): number {
  const { upRelative, theta } = projectOntoFrame(positionFrame, ostium);
  const scale = computeEffectiveRootScale(positionFrame, upRelative);
  const requiredRadius = distanceFromAxis(positionFrame, ostium) * CONTAINMENT_SAFETY_BUFFER;
  const { baseRadiusAmt, lobeAmplitudeAmt } = interpolateRootProfile(upRelative);
  const angularOffset = Math.abs(angularDiff(theta, lobeAngle));
  const falloff = lobeFalloff(angularOffset, LOBE_HALF_WIDTH);

  if (upRelative < SINUS_PLATEAU_UP_RANGE[0] || upRelative > SINUS_PLATEAU_UP_RANGE[1]) {
    console.warn(
      `[aorticRootMesh] ${label}入口部の高さ(up相対値=${upRelative.toFixed(3)})が洞の台地の範囲` +
        `[${SINUS_PLATEAU_UP_RANGE[0]}, ${SINUS_PLATEAU_UP_RANGE[1]}]の外にあるため、洞の張り出しが不足する可能性があります。`,
    );
  }
  if (lobeAmplitudeAmt < 1e-6 || falloff < 1e-6) {
    console.warn(
      `[aorticRootMesh] ${label}入口部に洞の局所的な張り出しが届きません` +
        `(高さ方向の張り出し形状=${lobeAmplitudeAmt.toFixed(3)}, 角度方向の減衰=${falloff.toFixed(3)})。` +
        "基準円のみでは内腔からはみ出す可能性があります。",
    );
    return 0;
  }
  const scaleNeeded = (requiredRadius / scale - baseRadiusAmt) / (lobeAmplitudeAmt * falloff);
  return Math.max(0, scaleNeeded);
}

/**
 * 中心軸に沿った各リングの [頭側方向のオフセット(up), 基準半径(baseRadius),
 * 洞の張り出し量(lobeAmplitude)]。いずれも「バルサルバ洞の最大半径(=
 * AorticRootFrame.sinusRadius)を基準スケールとする」相対値で、実際に使う際は
 * SCALE = sinusRadius / PEAK_RADIUS_UNITS でスケールする。upは「バルサルバ洞の
 * ピーク高さ(=frame.center)」を0とする相対値(負が弁輪側、正が上行大動脈側)。
 *
 * 実測比率(成人の標準的な経胸壁心エコー・CT基準値、概ね次の実寸に相当):
 *   大動脈弁輪径 約26mm : バルサルバ洞径(最大) 約34mm : 洞管接合部径 約29mm : 上行大動脈径 約30mm
 *   → 半径比でおよそ 1 : 1.3 : 1.1 : 1.15
 * 大動脈基部の高さ(弁輪〜洞管接合部)は弁輪径とほぼ同程度(やや短い)。
 *
 * baseRadiusは断面の「くびれ」部分(交連部)の半径、lobeAmplitudeはそこに加わる
 * 洞の張り出し量(baseRadius+lobeAmplitudeが洞の最大径になる、PEAK_RADIUS_UNITS=
 * 1.05+0.3=1.35に相当)。洞管接合部より上(上行大動脈)ではlobeAmplitude=0
 * (円形断面に戻る)。
 */
const AORTIC_ROOT_PROFILE: readonly [number, number, number][] = [
  [-1.0, 0.95, 0], // 弁輪よりわずかに下(チューブ末端の見切れ防止)
  [-0.7, 1.0, 0], // 大動脈弁輪
  [-0.5, 1.05, 0.3], // 洞下部(張り出しが立ち上がる。台地の開始 = frame.center)
  [0.0, 1.05, 0.3], // バルサルバ洞(最大膨隆部。冠動脈入口部はおよそこの高さ = frame.center)
  [0.5, 1.05, 0.3], // バルサルバ洞上部(台地の終わり)
  [0.85, 1.12, 0], // 洞管接合部(sinotubular junction、円形断面に戻る)
  [1.5, 1.18, 0], // 上行大動脈起始部
  [2.9, 1.18, 0], // 上行大動脈中間部
  [4.5, 1.15, 0], // 大動脈弓へ向かう手前(ここから先はbuildAorticArchGeometryが弓部・下行大動脈として引き継ぐ)
];
/**
 * 洞の最大膨隆部の高さ範囲(up相対値)。RCA/LAD/LCXの実際の入口部の高さは
 * frame.center(=RCA・左冠動脈入口部の平均高さ)からずれるのが通常であり、この
 * 範囲より外に出ると台地の外(半径が細くなる区間)に落ちてしまう。
 * computeAorticRootFrameの内腔安全マージン計算がこの前提(台地の内側では半径が
 * 高さに依存しない)を使うため、3つの入口部の実際の高さがこの範囲に収まっている
 * 必要がある(通常の解剖ではRCA/左冠動脈入口部の高さの差はさほど大きくないため、
 * 十分な余裕を持たせてある)。
 */
const SINUS_PLATEAU_UP_RANGE: readonly [number, number] = [-0.5, 0.5];
/** AORTIC_ROOT_PROFILEでの「バルサルバ洞の最大半径」(baseRadius+lobeAmplitude、up=0の行)。 */
const PEAK_RADIUS_UNITS = 1.35;
/** 洞管接合部(sinotubular junction)の高さ(up相対値、AORTIC_ROOT_PROFILEの該当行と一致)。
 * computeEffectiveRootScale参照。 */
const SINOTUBULAR_JUNCTION_UP = 0.85;

/**
 * upRelativeの高さにおける、AORTIC_ROOT_PROFILEの半径列に掛ける実効スケールを返す。
 * 洞管接合部(SINOTUBULAR_JUNCTION_UP)以下ではsinusRadius由来のスケール(従来通り、
 * 実際の冠動脈入口部を内腔に収めるために必要——AorticRootFrame.sinusRadiusのコメント
 * 参照)を、ASCENDING_END_UP以上ではframe.ascendingRadius由来のスケール(heartWidthから
 * 算出、AorticRootFrame.ascendingRadiusのコメント参照)を使い、その間は高さに応じて
 * 線形に補間する——洞管接合部でsinusRadius由来のスケールと連続しつつ、上行大動脈終端
 * (ascendingEnd、buildAorticArchGeometryが弓部として引き継ぐ点)でascendingRadius由来の
 * スケールに一致させ、可視化ジオメトリの継ぎ目に段差ができないようにする。
 */
function computeEffectiveRootScale(frame: AorticRootFrame, upRelative: number): number {
  const sinusScale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  if (upRelative <= SINOTUBULAR_JUNCTION_UP) return sinusScale;
  const ascendingEndRatio = AORTIC_ROOT_PROFILE[AORTIC_ROOT_PROFILE.length - 1][1];
  const ascendingScale = frame.ascendingRadius / ascendingEndRatio;
  if (upRelative >= ASCENDING_END_UP) return ascendingScale;
  const t = (upRelative - SINOTUBULAR_JUNCTION_UP) / (ASCENDING_END_UP - SINOTUBULAR_JUNCTION_UP);
  return sinusScale + (ascendingScale - sinusScale) * t;
}

/** チューブの円周分割数(3つの洞の丸みが分かる程度)。 */
const RADIAL_SEGMENTS = 32;
/** 洞の張り出し(交連部との境)を滑らかにするための半値幅(ラジアン)。実際の交連部は
 * 概ね120°間隔だが、実データの入口部角度は必ずしも等間隔ではないため、各洞の張り出しが
 * 隣接する洞の張り出しと衝突しても不自然にならない程度の固定値にしている。 */
const LOBE_HALF_WIDTH = Math.PI / 3;

function angularDiff(a: number, b: number): number {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

/**
 * 洞の中心角度からの角度差(d、0〜LOBE_HALF_WIDTH)に対する張り出しの減衰形状
 * (1=洞の中心、0=洞の範囲の境界)。単純なcos(d/halfWidth * π/2)は境界(d=halfWidth)で
 * 値こそ0になるが傾き(導関数)が0にならず、断面をロフトした際に洞と洞の境目に
 * 微小な折れ目(先の尖った「角」のような突起)が生じる原因になっていた(実測・
 * Playwrightで確認)。raised cosine(Hann窓と同じ形)を使うと、中心(d=0)・境界
 * (d=halfWidth)の両方で傾きが0になり、折れ目のない滑らかな盛り上がりになる。
 */
function lobeFalloff(angularOffset: number, halfWidth: number): number {
  if (angularOffset >= halfWidth) return 0;
  return 0.5 * (1 + Math.cos((angularOffset / halfWidth) * Math.PI));
}

/**
 * 3つの洞の張り出し量(AORTIC_ROOT_PROFILEのlobeAmplitudeAmtに掛ける倍率)。各洞中心
 * からLOBE_HALF_WIDTHの範囲でなめらかに0へ落ちる角度方向の形状(falloff、lobeFalloff
 * 参照)に、洞ごとのamplitudeScale(AorticRootFrame.rca/left/nonCoronaryLobeAmplitudeScale
 * ——実際の冠動脈入口部の座標に届くよう洞ごとに算出した倍率)を掛け、複数の洞の
 * 張り出しが重なる場合は大きい方を採用する(=洞同士の交連部で自然に括れる)。
 * amplitudeScaleが1.0を超える洞は、基準の張り出し量より大きく膨らむ(=実際の入口部が
 * 交連部の基準円より外側にある)ことを意味する。
 */
function lobeBulge(theta: number, lobes: readonly { angle: number; amplitudeScale: number }[]): number {
  let bulge = 0;
  for (const lobe of lobes) {
    const d = Math.abs(angularDiff(theta, lobe.angle));
    const falloff = lobeFalloff(d, LOBE_HALF_WIDTH);
    if (falloff > 0) bulge = Math.max(bulge, falloff * lobe.amplitudeScale);
  }
  return bulge;
}

/** axisに垂直な断面基準軸(u, v)を求める。axisが常に頭側方向(0,1,0)の固定軸だった
 * 頃は、この基準軸は事実上(1,0,0)/(0,0,1)(=atan2(z,x)と一致)だったが、
 * computeOstiumChordFitPositionが心臓の実際の長軸(先端から大動脈基部へ向かう方向、
 * 心臓メッシュ自体が世界座標の鉛直方向から傾いている場合はそれに追従する)を
 * axisとして使うようになったため、この関数は任意のaxisに対して機能する一般形に
 * している(axisがどの向きでも、それに垂直な安定した基準軸を返す)。このファイル・
 * guideDeviceMesh.tsの両方が同じ角度規約(axis=(0,1,0)の場合はatan2(z,x)と一致する)
 * を使うために共有する。 */
export function computeCrossSectionBasis(axis: Vector3): { u: Vector3; v: Vector3 } {
  let u = new Vector3(1, 0, 0).addScaledVector(axis, -axis.dot(new Vector3(1, 0, 0)));
  if (u.lengthSq() < 1e-8) u = new Vector3(0, 0, 1).addScaledVector(axis, -axis.dot(new Vector3(0, 0, 1)));
  u.normalize();
  // atan2(z, x)で求めた角度と、実際に頂点を配置する向きが一致するように v = u×axis に
  // する(cross(axis, u)にすると符号が反転し、角度の向きが逆になってしまう)。
  const v = new Vector3().crossVectors(u, axis).normalize();
  return { u, v };
}

/**
 * frameの中心軸から見たpointの高さ(頭側方向のオフセット、AORTIC_ROOT_PROFILEのup単位
 * 相対値)と、断面内の角度(ラジアン)を求める。evaluateAorticRootRadiusと
 * guideDeviceMesh.tsの経路構築の両方で使う共通の投影。
 */
export function projectOntoFrame(frame: AorticRootFrame, point: Vector3): { upRelative: number; theta: number } {
  const scale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  const offset = point.clone().sub(frame.center);
  const upRelative = frame.axis.dot(offset) / scale;
  const { u, v } = computeCrossSectionBasis(frame.axis);
  const theta = Math.atan2(offset.dot(v), offset.dot(u));
  return { upRelative, theta };
}

/**
 * AORTIC_ROOT_PROFILEのup(頭側方向のオフセット、相対値)に対応する、中心軸上の
 * 絶対座標を返す(guideDeviceMesh.tsが、大動脈基部の内腔内にカテーテルの経路点を
 * 具体的な高さ基準で配置するために使う)。
 */
export function pointAtRelativeHeight(frame: AorticRootFrame, upRelative: number): Vector3 {
  const scale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  return frame.center.clone().addScaledVector(frame.axis, upRelative * scale);
}

/**
 * frameの中心軸からpointまでの水平距離(頭側方向の成分を除いた距離)。
 */
export function distanceFromAxis(frame: AorticRootFrame, point: Vector3): number {
  const offset = point.clone().sub(frame.center);
  const alongAxis = frame.axis.clone().multiplyScalar(frame.axis.dot(offset));
  return offset.sub(alongAxis).length();
}

/**
 * pointの高さ・角度における、可視化された大動脈基部ローフト形状の局所半径を返す
 * (AORTIC_ROOT_PROFILEの該当区間を線形補間し、洞の張り出しも考慮する)。
 * プロファイルの範囲外(弁輪より下、または上行大動脈の先)は、それぞれ最も近い
 * 端のリングの値をそのまま使う(クランプ)。
 *
 * guideDeviceMesh.tsが、ガイディングカテーテルの経路がこの可視化形状の内腔に
 * 収まっているかを検証・補正するために使う。
 */
/**
 * AORTIC_ROOT_PROFILEをupRelativeの高さで線形補間し、[baseRadiusAmt(交連部の基準半径),
 * lobeAmplitudeAmt(その高さでの洞の張り出し量の形状——実際の張り出し量は洞ごとの
 * amplitudeScaleを掛けたもの、lobeBulge参照)]を返す。プロファイルの範囲外(弁輪より
 * 下、または上行大動脈の先)は、それぞれ最も近い端のリングの値をそのまま使う
 * (クランプ)。evaluateAorticRootRadius・computeAorticRootFrame(各洞のamplitudeScaleを
 * 実際の入口部座標から逆算する際)の両方が使う共通の補間。
 */
function interpolateRootProfile(upRelative: number): { baseRadiusAmt: number; lobeAmplitudeAmt: number } {
  const rows = AORTIC_ROOT_PROFILE;
  let lower = rows[0];
  let upper = rows[rows.length - 1];
  if (upRelative <= rows[0][0]) {
    lower = upper = rows[0];
  } else if (upRelative >= rows[rows.length - 1][0]) {
    lower = upper = rows[rows.length - 1];
  } else {
    for (let i = 0; i < rows.length - 1; i++) {
      if (upRelative >= rows[i][0] && upRelative <= rows[i + 1][0]) {
        lower = rows[i];
        upper = rows[i + 1];
        break;
      }
    }
  }
  const span = upper[0] - lower[0];
  const t = span > 1e-8 ? (upRelative - lower[0]) / span : 0;
  return {
    baseRadiusAmt: lower[1] + (upper[1] - lower[1]) * t,
    lobeAmplitudeAmt: lower[2] + (upper[2] - lower[2]) * t,
  };
}

export function evaluateAorticRootRadius(frame: AorticRootFrame, point: Vector3): number {
  const { upRelative, theta } = projectOntoFrame(frame, point);
  const scale = computeEffectiveRootScale(frame, upRelative);
  const lobes = [
    { angle: frame.rcaAngle, amplitudeScale: frame.rcaLobeAmplitudeScale },
    { angle: frame.leftAngle, amplitudeScale: frame.leftLobeAmplitudeScale },
    { angle: frame.nonCoronaryAngle, amplitudeScale: frame.nonCoronaryLobeAmplitudeScale },
  ] as const;

  const { baseRadiusAmt, lobeAmplitudeAmt } = interpolateRootProfile(upRelative);
  const bulge = lobeBulge(theta, lobes);
  return (baseRadiusAmt + lobeAmplitudeAmt * bulge) * scale;
}

/**
 * buildAorticCavityClippingPlanesが作る空洞の高さ範囲(up相対値)。上限は、実際の
 * heart-realistic.glbに対する実測で「上行大動脈の管が完全に心筋メッシュの外に出る」
 * 高さ(実測up≈1.96)を安全マージン込みで上回るよう設定する——洞の基準半径を心臓の
 * 幅から算出するよう変更した際(AorticRootFrame.sinusRadius参照)、管が以前より
 * 細くなった結果、心臓上部の先細った塊の中に埋もれたまま外に出る高さがかえって
 * 上がった(実測: 半径0.622時代はup≈1.34で外に出ていたが、半径0.395時代はup≈1.96まで
 * 埋もれる——先細ったヘラのような形状の心尖部を、より細い管の方がより深くまで
 * 突き抜ける形になるため)。
 */
const AORTIC_CAVITY_UP_MIN = -1.0;
export const AORTIC_CAVITY_UP_MAX = 2.3;
/** 空洞の半径に掛ける安全マージン(可視化した洞の最大膨隆部(sinusRadius)より
 * 一回り大きく取り、ローフト形状のどの断面も空洞内に収まるようにする)。 */
const AORTIC_CAVITY_RADIUS_MARGIN = 1.15;
/** 空洞の円周を近似する平面の枚数(多いほど円形に近づく)。 */
const AORTIC_CAVITY_SIDE_COUNT = 16;

/**
 * frameが表す大動脈基部の位置・形状に合わせて、心筋メッシュ(Heart)を部分的に
 * クリッピングするための平面群を返す。
 *
 * 心臓メッシュ(ImageCAS由来)には大動脈の内腔が別メッシュとして分離されておらず、
 * バルサルバ洞〜洞管接合部にあたる領域が実質組織として表現されている(実測: 実際の
 * 心筋メッシュに対するレイキャストで、この領域の大部分が「心筋内部」と判定されることを
 * 確認済み——内腔の中心軸付近まで押し出しても内部と判定されるため、経路点をどう
 * 補正しても心筋メッシュとの干渉は解消できない)。このため、ガイディングカテーテルが
 * この領域を貫通して見える問題は経路側の補正では原理的に直せず、心筋メッシュ側に
 * 大動脈基部の分だけ空洞を開けることで対処する。
 *
 * Three.jsのMaterial.clippingPlanes + clipIntersection=trueは、割り当てた全ての平面の
 * 「負」側に同時にある部分だけをクリッピングする(=平面群の交差領域=有限の凸形状を
 * くり抜ける)。frameの中心軸を囲むAORTIC_CAVITY_SIDE_COUNT枚の側面(円柱の外接多角形)
 * と、上下2枚のキャップ平面(AORTIC_CAVITY_UP_MIN〜MAX)を組み合わせ、大動脈基部の
 * ローフト形状を安全マージ込みで包含する円柱状の空洞を作る。
 */
export function buildAorticCavityClippingPlanes(
  frame: AorticRootFrame,
  /**
   * heartAorticOpening.tsが実測した、心筋メッシュに実在する開口部の輪郭(省略時は
   * 従来通りformula形状のみで空洞を組む)。指定された場合、空洞の半径(角度ごと)を
   * 「formula形状の半径」と「実測輪郭までの距離」の大きい方にする——buildContourCollarRing
   * と同じ考え方を、可視化したチューブだけでなく心筋側のクリッピング形状にも適用する
   * (可視化側だけ実測輪郭に寄せても、心筋を削り取る穴の形自体が一律の円錐のままでは
   * 「削られている」印象は残るため)。
   */
  detectedOpening?: DetectedAorticOpening | null,
): Plane[] {
  // 洞の局所的な張り出し(rca/leftLobeAmplitudeScale)は角度によって異なる
  // (buildLobedTubeGeometryのlobeBulge参照)。以前はこの3洞のうち最大の張り出し倍率を
  // 全方向に一律適用していたため、洞と洞の間(交連部)の谷にあたる方向では、実際の
  // チューブがずっと細い(基準円のみ)にもかかわらず空洞は最大の洞と同じ太さのまま
  // 残ってしまい、そこだけ心筋メッシュに一回り以上太い円柱状の穴が残っていた——これも
  // 「削られている」ように見える一因だった。ここでは角度ごとに実際のlobeBulge値を
  // 使い、空洞の断面形状をチューブ自身の(3洞で膨らむ)形に合わせる。
  const { baseRadiusAmt, lobeAmplitudeAmt } = interpolateRootProfile(0);
  const peakScale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  const lobes = [
    { angle: frame.rcaAngle, amplitudeScale: frame.rcaLobeAmplitudeScale },
    { angle: frame.leftAngle, amplitudeScale: frame.leftLobeAmplitudeScale },
    { angle: frame.nonCoronaryAngle, amplitudeScale: frame.nonCoronaryLobeAmplitudeScale },
  ] as const;

  // 洞のピーク(up=0、角度ごと)を基準に、空洞の上端(AORTIC_CAVITY_UP_MAX)にかけて
  // 円錐状に先細らせる。洞管接合部より上では実際のチューブの半径がascendingRadius
  // 由来のスケールまで大きく細くなる(evaluateAorticRootRadius参照)にもかかわらず、
  // 以前はpeakRadiusを空洞の全高さ範囲(-1.0〜2.3)に一律適用していたため、上行大動脈
  // 側では実際のチューブの直径のおよそ2倍もの円柱状の穴が心筋に開いたままになり、
  // それが「心臓が削られている」ように見える主因になっていた(実測で確認済み——
  // up=0.85付近で実チューブ半径0.328に対し空洞半径0.715、oversize約2.18倍)。
  // 洞管接合部より上ではlobeAmplitudeAmt=0(円形断面に戻る、AORTIC_ROOT_PROFILE参照)
  // のため、topRadiusは角度によらず一定でよい。
  const positionScale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  const topProfile = interpolateRootProfile(AORTIC_CAVITY_UP_MAX);
  const topScale = computeEffectiveRootScale(frame, AORTIC_CAVITY_UP_MAX);
  const topRadius = topProfile.baseRadiusAmt * topScale * AORTIC_CAVITY_RADIUS_MARGIN;

  let contourSamples: { theta: number; value: number }[] | null = null;
  if (detectedOpening && detectedOpening.contour.length >= 8) {
    contourSamples = detectedOpening.contour
      .map((point) => ({ theta: projectOntoFrame(frame, point).theta, value: distanceFromAxis(frame, point) }))
      .sort((a, b) => a.theta - b.theta);
  }

  // axisが常に頭側方向(0,1,0)固定だった頃は断面基準軸が事実上(u=X, v=Z)と一致して
  // いたため、水平方向を直接(cosθ, 0, sinθ)として組み立てていたが、axisが心臓メッシュ
  // 自身の長軸(傾いている場合がある、computeAorticRootFrame参照)に追従するように
  // なったため、axisに垂直な実際の断面基準(u, v)を使って組み立てる一般形にする。
  const { u, v } = computeCrossSectionBasis(frame.axis);

  const planes: Plane[] = [];
  for (let i = 0; i < AORTIC_CAVITY_SIDE_COUNT; i++) {
    const angle = (i / AORTIC_CAVITY_SIDE_COUNT) * TWO_PI;
    let peakRadiusAtAngle = (baseRadiusAmt + lobeAmplitudeAmt * lobeBulge(angle, lobes)) * peakScale * AORTIC_CAVITY_RADIUS_MARGIN;
    if (contourSamples) {
      peakRadiusAtAngle = Math.max(peakRadiusAtAngle, interpolateCircular(contourSamples, angle) * AORTIC_CAVITY_RADIUS_MARGIN);
    }
    const radiusSlopePerUp = (topRadius - peakRadiusAtAngle) / AORTIC_CAVITY_UP_MAX;
    const radiusSlopePerAxisUnit = radiusSlopePerUp / positionScale;
    // u,v方向の成分でこの角度の水平方向を作り、axis方向の成分に-radiusSlopePerAxisUnitを
    // 入れることで、平面自体をaxisに沿って傾け、円柱ではなく円錐(のN角形近似)を表す
    // 半空間にする(distanceToPoint = normal・(p-center) - peakRadiusAtAngleが、up0からの
    // axis方向の距離に応じて実効半径が線形に変化する制約になる)。
    const normal = u
      .clone()
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(v, Math.sin(angle))
      .addScaledVector(frame.axis, -radiusSlopePerAxisUnit);
    // distanceToPoint(p) = normal・(p-center) - peakRadiusAtAngle: 円錐の内側で負になる
    // (clipIntersection=trueは、全平面で負になる点だけをクリップする)。
    const constant = -normal.dot(frame.center) - peakRadiusAtAngle;
    planes.push(new Plane(normal, constant));
  }
  // frame.centerは(detectedOpeningがある場合)実測した大動脈弁の位置そのものに
  // アンカーされており、管の下端だけを別途横方向へずらす処理は無い(computeAorticRootFrame・
  // MEASURED_AORTIC_VALVE_CENTER参照)ため、この空洞の円錐も他の断面と同じくframe.center
  // を基準に一貫して組めばよい。frame.centerとdetectAorticOpeningが実測した実際の開口部
  // 中心とは最大で約0.3ワールド単位ずれうるが、側面(上のAORTIC_CAVITY_SIDE_COUNT枚の
  // 平面)はup=0でのpeakRadiusAtAngleから線形に外挿する円錐のため、up<0の方向ではむしろ
  // 半径が大きくなる(傘のように広がる)——実測でこの余裕(up=-1.0付近で半径0.86〜0.94
  // ワールド単位)がこのずれより十分大きいことを確認済みのため、下キャップの高さは
  // 拡張せずAORTIC_CAVITY_UP_MINのまま使う。
  const bottomPoint = pointAtRelativeHeight(frame, AORTIC_CAVITY_UP_MIN);
  const topPoint = pointAtRelativeHeight(frame, AORTIC_CAVITY_UP_MAX);
  // 下キャップ: axis方向で見てbottomPointより頭側(内側)で負になる
  // (空洞は弁輪の高さより上)。
  planes.push(new Plane(frame.axis.clone().negate(), frame.axis.dot(bottomPoint)));
  // 上キャップ: axis方向で見てtopPointより足側(内側)で負になる
  // (空洞は洞管接合部より少し上まで)。
  planes.push(new Plane(frame.axis.clone(), -frame.axis.dot(topPoint)));
  return planes;
}

/** 1つのリング(高さ・角度ごとの半径関数)。formula行(AORTIC_ROOT_PROFILE由来)と、
 * 心筋メッシュの実測開口部から挿入するcollar行の両方をこの共通の形で扱う
 * (buildLobedTubeGeometryのリング生成ループを1本にまとめるため)。 */
interface RingSpec {
  upAmt: number;
  radiusAt: (theta: number) => number;
}

/** 円周方向にソート済みのサンプル列theta[i]に対し、周期境界(2π)をまたいで
 * 線形補間する。detectedOpening.contourをbuildLobedTubeGeometryの角度規約
 * (theta、computeCrossSectionBasis参照)へ投影したサンプルの補間に使う。 */
function interpolateCircular(sortedSamples: readonly { theta: number; value: number }[], theta: number): number {
  const n = sortedSamples.length;
  const t = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
  for (let i = 0; i < n; i++) {
    const a = sortedSamples[i];
    const b = sortedSamples[(i + 1) % n];
    const aTheta = a.theta;
    const bTheta = i + 1 < n ? b.theta : b.theta + TWO_PI;
    if (t >= aTheta && t <= bTheta) {
      const span = bTheta - aTheta;
      const localT = span > 1e-8 ? (t - aTheta) / span : 0;
      return a.value + (b.value - a.value) * localT;
    }
  }
  return sortedSamples[0].value;
}

/**
 * detectedOpening.contour(心筋メッシュに実測した、大動脈弁輪相当の開口部の実際の
 * 輪郭点列、heartAorticOpening.ts参照)から、buildLobedTubeGeometryへ挿入する
 * 追加リング(collar)を構築する。輪郭点をframeへ投影して(theta, upRelative,
 * 中心軸からの距離)を求め、その平均高さに1枚のリングを挿入する——このリングの
 * 各角度の半径は「その高さ・角度でのformula半径(3洞のローフト形状が本来持つ半径、
 * 冠動脈入口部の内腔収まりを保証する値)」と「実測した輪郭までの距離」の大きい方を
 * 採用する(Math.max)。これにより、実測開口部が既存のformula形状より外側に張り
 * 出している角度ではそちらに合わせて張り出し、逆に実測開口部の方が内側に狭い
 * 角度(輪郭点が疎な方向や、隣接する別の構造物に近い方向)ではformula側の半径を
 * 下回らない(=冠動脈入口部の内腔収まり保証を崩さない)。
 *
 * 輪郭点までの距離(radius)は、frame.center(=実測した大動脈弁の位置、
 * MEASURED_AORTIC_VALVE_CENTER)を基準に測る。輪郭点自体は実測開口部の重心
 * (detectedOpening.center、frame.centerとは別の点)の周りに分布しているため、
 * frame.centerがその重心から離れているほど、実際にはほぼ円形にまとまっている輪郭が
 * 「frame.centerから見て片側だけ大きく遠い(=半径が大きい)」ように投影されてしまう
 * (偏心した視点から円を見ると、片側の見かけの半径が実際よりずっと大きくなるのと
 * 同じ現象)。実測(Playwrightでの目視・輪郭点のtheta/radius比較)で、この投影の
 * 歪みだけでformula半径の2倍以上に達する角度があり、Math.max経由でその角度だけ
 * 壁面から薄い「羽」のような突起が生じることを確認した。CONTOUR_OVERSHOOT_RATIO_CAPで
 * 輪郭がformula半径を超えて張り出せる量に上限を設け、実測開口部の正当な非対称さは
 * 反映しつつ、投影の歪みによる過大な突起は抑える。
 *
 * 輪郭の平均高さが洞の台地(SINUS_PLATEAU_UP_RANGE)から大きく外れている場合や、
 * 輪郭点が少なすぎる場合はnullを返す(呼び出し側はcollarを挿入せず、従来通りの
 * formula行だけでローフトを組む)。
 */
/** 輪郭(実測開口部)がformula半径をどこまで超えて張り出せるかの上限比率。
 * buildContourCollarRingのコメント参照——frame.centerが実測開口部の重心から離れて
 * いるほど、投影の歪みだけで輪郭の見かけの半径がformula半径の2倍以上に達しうるため、
 * この上限で歪みによる過大な突起を抑える。 */
const CONTOUR_OVERSHOOT_RATIO_CAP = 1.2;

function buildContourCollarRing(frame: AorticRootFrame, detectedOpening: DetectedAorticOpening | null | undefined): RingSpec | null {
  if (!detectedOpening || detectedOpening.contour.length < 8) return null;

  const projected = detectedOpening.contour
    .map((point) => {
      const { upRelative, theta } = projectOntoFrame(frame, point);
      const radius = distanceFromAxis(frame, point);
      return { upRelative, theta, radius };
    })
    .sort((a, b) => a.theta - b.theta);

  const avgUp = projected.reduce((sum, p) => sum + p.upRelative, 0) / projected.length;
  // 洞の台地からかけ離れた高さ(検出が何らかの理由で異常な値を返した場合)には
  // 適用しない——collarはあくまで洞〜洞管接合部付近の継ぎ目を馴染ませるためのもので、
  // 弁輪側や上行大動脈側まで実測輪郭で置き換えることは想定していない。
  if (!Number.isFinite(avgUp) || avgUp <= AORTIC_ROOT_PROFILE[0][0] || avgUp >= ASCENDING_END_UP) return null;

  const contourSamples = projected.map((p) => ({ theta: p.theta, value: p.radius }));
  const lobes = [
    { angle: frame.rcaAngle, amplitudeScale: frame.rcaLobeAmplitudeScale },
    { angle: frame.leftAngle, amplitudeScale: frame.leftLobeAmplitudeScale },
    { angle: frame.nonCoronaryAngle, amplitudeScale: frame.nonCoronaryLobeAmplitudeScale },
  ] as const;
  const { baseRadiusAmt, lobeAmplitudeAmt } = interpolateRootProfile(avgUp);
  const radiusScale = computeEffectiveRootScale(frame, avgUp);
  const baseRadius = baseRadiusAmt * radiusScale;
  const lobeAmplitude = lobeAmplitudeAmt * radiusScale;

  return {
    upAmt: avgUp,
    radiusAt: (theta: number) => {
      const formulaRadius = baseRadius + lobeAmplitude * lobeBulge(theta, lobes);
      const contourRadius = interpolateCircular(contourSamples, theta);
      return Math.max(formulaRadius, Math.min(contourRadius, formulaRadius * CONTOUR_OVERSHOOT_RATIO_CAP));
    },
  };
}

/**
 * フィットした弁輪平面の法線(frame.axis基準のu/v/axis成分、単位ベクトル)。
 * 6点の実測データから最小二乗法で平面フィットした結果——単純にframe.axisを
 * 弁の向きとして流用していた以前の方式とは異なり、実測した弁輪面そのものの
 * 傾きを反映する(frame.axisとの角度差は約25°で、解剖学的にも妥当な範囲)。
 * PCAによる平面フィットは法線の符号が不定なため、frame.axisと同じ向き
 * (内積が正)になるよう符号を揃えてある。
 */
export const AORTIC_VALVE_NORMAL = { left: -0.3108, anterior: -0.1674, up: 0.9356 };

/**
 * 実測した大動脈弁の位置を、frameの絶対座標で返す。frame.center自体が
 * MEASURED_AORTIC_VALVE_CENTER(実測した大動脈弁の位置そのもの)であるため、
 * 単にframe.centerを返すだけでよい(以前はframe.center基準の相対オフセットを
 * 都度復元していたが、frame.center自体を実測弁の位置にアンカーしたことで不要に
 * なった)。heartValveMesh.tsの大動脈弁マーカーがこの関数を使う。
 */
export function computeAorticValvePoint(frame: AorticRootFrame): Vector3 {
  return frame.center.clone();
}

/**
 * フィットした大動脈弁輪平面の法線(AORTIC_VALVE_NORMAL)を、frameの絶対座標系
 * (ワールド空間)の単位ベクトルとして返す。heartValveMesh.tsの大動脈弁マーカーが、
 * 円盤の向きにframe.axisではなくこちらを使う。
 */
export function computeAorticValveNormal(frame: AorticRootFrame): Vector3 {
  const { u, v } = computeCrossSectionBasis(frame.axis);
  return u
    .clone()
    .multiplyScalar(AORTIC_VALVE_NORMAL.left)
    .addScaledVector(v, AORTIC_VALVE_NORMAL.anterior)
    .addScaledVector(frame.axis, AORTIC_VALVE_NORMAL.up)
    .normalize();
}

/**
 * 隣接するAORTIC_ROOT_PROFILE行間でlobeAmplitudeAmt(洞の張り出し量)が変化する区間
 * (弁輪→洞の台地、洞の台地→洞管接合部)に挿入する追加の補間リングの本数。
 *
 * AORTIC_ROOT_PROFILEの行はどこも疎らだが、lobeAmplitudeAmtが変化する区間だけは
 * 断面が「3洞で膨らんだ形」から「真円」へ(またはその逆に)短いup区間で大きく変形する
 * ため、そのままリング間を直線で結ぶと、洞の張り出し方向だけ半径が急激に収縮/膨張し、
 * 目に見える段差(facetted "neck")になる(実測: 洞の台地上端up=0.5から洞管接合部
 * up=0.85にかけて、RCA洞方向の半径が0.437→0.328へ約25%収縮するのに対し、この区間には
 * 2行しか無い)。以前バルサルバ洞下端で見つかった同種の折れ目(実測弁への後付けの
 * 傾け——現在は削除済み——のブレンドがリング不足で折れ目になっていた件)と同じ原因
 * であり、同じ対処(新しい補間式は増やさず、既存のinterpolateRootProfile/
 * computeEffectiveRootScale/lobeBulgeを追加の高さでも呼ぶだけの細分化)で直す。
 */
const LOBE_TRANSITION_RING_SUBDIVISIONS = 6;

/**
 * AORTIC_ROOT_PROFILEから、frame(中心軸・半径・3つの洞の角度)に基づくリング列
 * (RingSpec、高さ・角度ごとの半径関数)を構築する。lobeAmplitudeAmtが変化する区間
 * (LOBE_TRANSITION_RING_SUBDIVISIONS参照)には追加の補間リングを挿入し、断面が
 * 短いup区間で急激に変形して段差になるのを防ぐ。
 */
function buildRootProfileRingSpecs(
  frame: AorticRootFrame,
  lobes: readonly { angle: number; amplitudeScale: number }[],
): RingSpec[] {
  const makeRingSpec = (upAmt: number): RingSpec => {
    const radiusScale = computeEffectiveRootScale(frame, upAmt);
    const { baseRadiusAmt, lobeAmplitudeAmt } = interpolateRootProfile(upAmt);
    const baseRadius = baseRadiusAmt * radiusScale;
    const lobeAmplitude = lobeAmplitudeAmt * radiusScale;
    return { upAmt, radiusAt: (theta: number) => baseRadius + lobeAmplitude * lobeBulge(theta, lobes) };
  };
  const specs: RingSpec[] = [];
  for (let i = 0; i < AORTIC_ROOT_PROFILE.length; i++) {
    const [upAmt, , lobeAmplitudeAmt] = AORTIC_ROOT_PROFILE[i];
    specs.push(makeRingSpec(upAmt));
    if (i < AORTIC_ROOT_PROFILE.length - 1) {
      const [nextUpAmt, , nextLobeAmplitudeAmt] = AORTIC_ROOT_PROFILE[i + 1];
      if (Math.abs(nextLobeAmplitudeAmt - lobeAmplitudeAmt) > 1e-6) {
        for (let k = 1; k <= LOBE_TRANSITION_RING_SUBDIVISIONS; k++) {
          specs.push(makeRingSpec(upAmt + (nextUpAmt - upAmt) * (k / (LOBE_TRANSITION_RING_SUBDIVISIONS + 1))));
        }
      }
    }
  }
  return specs;
}

/**
 * frame(中心軸・半径・3つの洞の角度)とAORTIC_ROOT_PROFILEから、断面が3つの洞で
 * 膨らむローフト形状を構築する。stentLatticeMeshのbuildTubeFromFrame/
 * buildTubeFromPointsは断面が円形(半径のみ可変)であることが前提のため使えず、
 * ここで断面自体が角度に応じて変わるローフトを直接組む。
 *
 * detectedOpeningが指定されている場合、心筋メッシュに実測した開口部の輪郭
 * (buildContourCollarRing参照)を追加の1リングとして挿入し、その高さでの
 * 断面を実際の開口部の形に近づける(冠動脈入口部の内腔収まりは下回らない)。
 *
 * 巻き順(表裏)の検証・保証よりも実装を単純にするため、マテリア側でside=DoubleSideに
 * するのを前提とし、ここでは巻き順を厳密には気にしない(AorticRootOverlay参照)。
 */
function buildLobedTubeGeometry(
  frame: AorticRootFrame,
  radialSegments: number,
  detectedOpening?: DetectedAorticOpening | null,
): BufferGeometry {
  // 位置(リング中心の高さ)は従来通りsinusRadius基準のスケールのまま
  // (pointAtRelativeHeightと同じ——高さの基準はテーパーの対象外)。半径だけ、
  // 高さに応じてsinusRadius由来からascendingRadius由来へテーパーさせる
  // (computeEffectiveRootScale参照)。
  const positionScale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  const lobes = [
    { angle: frame.rcaAngle, amplitudeScale: frame.rcaLobeAmplitudeScale },
    { angle: frame.leftAngle, amplitudeScale: frame.leftLobeAmplitudeScale },
    { angle: frame.nonCoronaryAngle, amplitudeScale: frame.nonCoronaryLobeAmplitudeScale },
  ] as const;
  const { u, v } = computeCrossSectionBasis(frame.axis);

  const ringSpecs: RingSpec[] = buildRootProfileRingSpecs(frame, lobes);
  const collarRing = buildContourCollarRing(frame, detectedOpening);
  if (collarRing) ringSpecs.push(collarRing);
  ringSpecs.sort((a, b) => a.upAmt - b.upAmt);

  const ringCount = ringSpecs.length;
  const verticesPerRing = radialSegments + 1; // 継ぎ目用に0番目と同じ位置をもう1つ複製する
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < ringCount; i++) {
    const { upAmt, radiusAt } = ringSpecs[i];
    const ringCenter = frame.center.clone().addScaledVector(frame.axis, upAmt * positionScale);

    for (let j = 0; j < verticesPerRing; j++) {
      const theta = (j / radialSegments) * TWO_PI;
      const radius = radiusAt(theta);
      const dir = u.clone().multiplyScalar(Math.cos(theta)).addScaledVector(v, Math.sin(theta));
      const vertex = ringCenter.clone().addScaledVector(dir, radius);
      positions.push(vertex.x, vertex.y, vertex.z);
    }
  }

  for (let i = 1; i < ringCount; i++) {
    for (let j = 1; j <= radialSegments; j++) {
      const a = verticesPerRing * (i - 1) + (j - 1);
      const b = verticesPerRing * i + (j - 1);
      const c = verticesPerRing * i + j;
      const d = verticesPerRing * (i - 1) + j;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** buildAorticArchGeometryの経路サンプリング数。 */
const ARCH_SAMPLE_COUNT = 48;
/** 上行大動脈の直線円筒の終端(AORTIC_ROOT_PROFILEの最後の行と一致させる——ここから
 * 先を弓部・下行大動脈として引き継ぐ)。 */
const ASCENDING_END_UP = 4.5;
/** 弓部カーブ(論理t値、toArchCurveT参照)において弓頂部(archApex)に対応するt値
 * (4制御点だった頃の「区間を3等分」という意味をそのまま引き継ぐ、助走点追加後も
 * 値・意味は変えない)。3分枝の起点t値(BRACHIOCEPHALIC_ORIGIN_T_FRACTION等)が
 * この値を参照するため、それらより前で定義する必要がある。 */
export const ARCH_TRUNK_T_FRACTION = 1 / 3;
/**
 * 解剖学的な左方向の簡略化。実データ(RCA/LAD/LCXオスティウム座標)には「解剖学的な
 * 左右」を明示する軸は無いが、LAD/LCX(左冠動脈)入口部が軒並みX>0、RCA(右冠動脈)が
 * X<0という傾向が実データにあるため、この座標系での「解剖学的左」を+Xと仮定する
 * ——axis=(0,1,0)を頭側方向に固定するのと同じ精神の簡略化(正確な生体計測の再現が
 * 目的ではなく、弓が心臓の外側を回り込んで下行する見た目を作るための割り切り)。
 */
const ARCH_LEFT_DIRECTION = new Vector3(1, 0, 0);
/**
 * 解剖学的な後方向の簡略化。実データに手がかりが無いため、実際にレンダリングした
 * 見た目(心臓本体を貫通しないか)を確認しながら符号を決めた——上記と同じ簡略化。
 */
const ARCH_POSTERIOR_DIRECTION = new Vector3(0, 0, -1);
/**
 * 弓部・下行大動脈の主要点(上行大動脈終端からの相対オフセット)。大動脈自体の口径
 * (sinusRadius)ではなく心臓全体のスケール(heartScale)に対する比率で定義する——
 * 心臓の外側を回り込んで下行するのに必要な移動量は、大動脈自体の口径ではなく
 * 心臓全体の大きさに比例するため(ガイディングカテーテルのAORTA_UP_FRACTION/
 * AORTA_OUTWARD_FRACTIONと同じ考え方、guideDeviceMesh.ts参照)。
 */
const ARCH_APEX_UP_FRACTION = 0.9;
const ARCH_APEX_LEFT_FRACTION = 0.5;
const ARCH_APEX_POSTERIOR_FRACTION = 0.35;
const DESCENDING_START_UP_FRACTION = 0.35;
const DESCENDING_START_LEFT_FRACTION = 0.75;
const DESCENDING_START_POSTERIOR_FRACTION = 0.65;
/**
 * 下行大動脈の長さ(descendingStartからの距離)。ガイディングカテーテルの大腿
 * アプローチは、この経路上(descendingStart〜descendingEndの間)を通って体外側の
 * 穿刺部位(大腿動脈)へ向かうため、カテーテルが実際に到達する範囲より短いと
 * 「血管の外側で浮いて見える」ことになる——十分に長く取り、カテーテルの経路が
 * 常にこの下行大動脈チューブの中を通るようにする。
 */
const DESCENDING_LENGTH_FRACTION = 4.5;
/**
 * 上行大動脈終端(ascendingEnd)から見た、弓部カーブの「助走点」までのup方向オフセット
 * (heartScale比率)。開いたCatmullRomCurve3は最初の制御点における接線を隣接する点
 * だけから決めるため、ascendingEndの直後がarchApex(横方向にオフセットされている)
 * しか無いと、上行大動脈の直線円筒(frame.axis方向にまっすぐ)から弓部への継ぎ目で
 * 接線が不連続になり、いきなり横に折れて見える(実測・Playwrightで確認)。この助走点は
 * 横オフセットを一切持たせず、frame.axis方向のみに置くことで、CatmullRomに「まっすぐ
 * 上昇してきた」という文脈を与える——経路のサンプル対象(sampleAorticArchTrunk等)には
 * 一切含まれない、接線を安定させるためだけの制御点(ARCH_APPROACH_T_SPAN・
 * toArchCurveT参照)。
 */
const ASCENDING_APPROACH_UP_OFFSET = 0.6;
/**
 * 上肢へ向かう3分枝(腕頭動脈・左総頸動脈・左鎖骨下動脈)の、弓部カーブ上の起点
 * (論理t値、ARCH_TRUNK_T_FRACTION参照)。実際の解剖と同じく、上行大動脈側から
 * 下行大動脈側に向かって腕頭動脈→左総頸動脈→左鎖骨下動脈の順に並ぶ
 * (BRACHIOCEPHALIC < LEFT_COMMON_CAROTID < ARCH_TRUNK_T_FRACTION(弓頂部) <
 * LEFT_SUBCLAVIAN)。
 */
export const BRACHIOCEPHALIC_ORIGIN_T_FRACTION = ARCH_TRUNK_T_FRACTION * 0.4;
export const LEFT_COMMON_CAROTID_ORIGIN_T_FRACTION = ARCH_TRUNK_T_FRACTION * 0.9;
export const LEFT_SUBCLAVIAN_ORIGIN_T_FRACTION = ARCH_TRUNK_T_FRACTION + (1 - ARCH_TRUNK_T_FRACTION) * 0.3;
/**
 * 3分枝の長さ(それぞれの起点からの距離、heartScale比率)。腕頭動脈はガイディング
 * カテーテルの橈骨アプローチ(右橈骨、腕頭動脈経由)の体外側経路を担うため、旧
 * 「鎖骨下動脈相当」の代役と同じ長さを引き継ぐ(体外側の穿刺部位まで届く必要がある)。
 * 左総頸動脈・左鎖骨下動脈はカテーテル経路を担わない可視化専用のため、実物の血管らしく
 * 見える程度の短い長さでよい。
 */
const BRACHIOCEPHALIC_LENGTH_FRACTION = 2.2;
const LEFT_COMMON_CAROTID_LENGTH_FRACTION = 1.2;
const LEFT_SUBCLAVIAN_LENGTH_FRACTION = 1.3;
/**
 * 3分枝それぞれが実際に伸びる方向(frame.axis(頭側)・ARCH_LEFT_DIRECTION(解剖学的左)・
 * ARCH_POSTERIOR_DIRECTION(解剖学的後方)の合成、正規化して使う)。
 *
 * 以前は弓部カーブ自体の局所接線、または弓全体の弦の向き(archDirection、archApexが
 * 左・後方に大きくオフセットされているため、必然的に左・後方寄りの向きになる)を
 * そのまま(または局所接線とブレンドして)使っていた。この方式だと3分枝全員が
 * 「弓が曲がっていく先」に引きずられ、実際の解剖のように扇状に開かず、ほぼ平行な
 * 3本の管が束になって同じ方向(左・後方寄り)を向くだけになっていた(Playwrightで
 * 目視確認——上から見ると3本がほとんど重なって見える)。
 *
 * 実際の解剖では3分枝はそれぞれ別の方向を向く:
 *   - 腕頭動脈: 右総頸動脈・右鎖骨下動脈へ分岐するため右側(解剖学的左と逆方向)へ
 *     大きく開きながら上行する。3分枝の中で唯一、弓の湾曲方向(左)と逆側に開く。
 *   - 左総頸動脈: ほぼ真上(頭側)へ、左右にはわずかしか傾かない。
 *   - 左鎖骨下動脈: 上行しつつ、弓自体の湾曲(左・後方)よりもさらに強く左・後方へ
 *     開き、左肩・左上肢へ向かう(3分枝の中で最も左・後方寄り)。
 * この3方向を、それぞれ独立したUP/LEFT(またはRIGHT)/POSTERIOR(またはANTERIOR)の
 * 合成比率として明示的に定義することで、実際の解剖のように3分枝が扇状に分かれる
 * ようにする(以前のように弓の局所形状に従属させない)。起点は引き続き弓部カーブ上
 * (BRACHIOCEPHALIC_ORIGIN_T_FRACTION等)のままとし、そこから先の伸びる向きだけを
 * 各分枝固有のものにする。
 */
const BRACHIOCEPHALIC_UP_FRACTION = 1.0;
const BRACHIOCEPHALIC_RIGHT_FRACTION = 0.4;
const BRACHIOCEPHALIC_ANTERIOR_FRACTION = 0.1;
const LEFT_COMMON_CAROTID_UP_FRACTION = 1.0;
const LEFT_COMMON_CAROTID_LEFT_FRACTION = 0.12;
const LEFT_COMMON_CAROTID_ANTERIOR_FRACTION = 0.05;
const LEFT_SUBCLAVIAN_UP_FRACTION = 0.8;
const LEFT_SUBCLAVIAN_LEFT_FRACTION = 0.6;
const LEFT_SUBCLAVIAN_POSTERIOR_FRACTION = 0.5;
/**
 * 弓部・下行大動脈の断面半径比(sinusRadius基準、上行大動脈終端の1.15から弓頂部・
 * 下行開始・下行終端にかけて緩やかに先細りさせる——実測比の目安として、弓部は
 * 上行大動脈とほぼ同径〜やや細め、下行大動脈はさらに細くなる)。
 */
const ARCH_RADIUS_RATIOS: readonly number[] = [1.15, 1.03, 0.95, 0.85];
/**
 * 3分枝それぞれの太さ(起点での大動脈弓の局所半径に対する比率)。実際の血管の太さの
 * 目安通り、腕頭動脈が最も太く(大動脈弓自体に次ぐ太さ)、左総頸動脈が最も細い。
 */
const BRACHIOCEPHALIC_RADIUS_RATIO = 0.48;
const LEFT_COMMON_CAROTID_RADIUS_RATIO = 0.24;
const LEFT_SUBCLAVIAN_RADIUS_RATIO = 0.33;

/**
 * 弓部大動脈・下行大動脈・上肢への3分枝(腕頭動脈・左総頸動脈・左鎖骨下動脈)の主要点。
 * buildAorticArchGeometry/build*BranchGeometry(可視化用のチューブ)と、ガイディング
 * カテーテルの体外側経路(guideDeviceMesh.ts)の両方が、同じ大動脈の形に沿うようこれを
 * 共有する——弓部・下行大動脈を追加した直後は、カテーテルの体外側経路の「どこまで
 * 伸ばすか」をguideDeviceMesh.ts側に独立した定数として複製しており、この可視化
 * ジオメトリ側の長さと食い違って「カテーテルが血管の外に突き抜けて見える」不具合に
 * なっていた。単一の関数から両方の値を得ることで、この食い違いが再発しないようにする。
 */
export interface AorticArchControlPoints {
  /** 上行大動脈終端の直前、frame.axis方向のみの助走点(ASCENDING_APPROACH_UP_OFFSET
   * 参照)。経路のサンプル対象には含まれない、接線安定化専用。 */
  ascendingApproach: Vector3;
  ascendingEnd: Vector3;
  archApex: Vector3;
  descendingStart: Vector3;
  descendingEnd: Vector3;
  brachiocephalicOrigin: Vector3;
  brachiocephalicEnd: Vector3;
  leftCommonCarotidOrigin: Vector3;
  leftCommonCarotidEnd: Vector3;
  leftSubclavianOrigin: Vector3;
  leftSubclavianEnd: Vector3;
}

/** ascendingApproach〜descendingEndの5制御点から、共有のCatmullRomCurve3を組む
 * (buildAorticArchCurve・computeAorticArchControlPointsの両方が使う、唯一の組み立て
 * 箇所)。 */
function buildCatmullRomFromPrimaryPoints(
  ascendingApproach: Vector3,
  ascendingEnd: Vector3,
  archApex: Vector3,
  descendingStart: Vector3,
  descendingEnd: Vector3,
): CatmullRomCurve3 {
  return new CatmullRomCurve3([ascendingApproach, ascendingEnd, archApex, descendingStart, descendingEnd]);
}

export function computeAorticArchControlPoints(frame: AorticRootFrame, heartScale: number): AorticArchControlPoints {
  const ascendingEnd = pointAtRelativeHeight(frame, ASCENDING_END_UP);
  const ascendingApproach = pointAtRelativeHeight(frame, ASCENDING_END_UP - ASCENDING_APPROACH_UP_OFFSET);
  const archApex = ascendingEnd
    .clone()
    .addScaledVector(frame.axis, ARCH_APEX_UP_FRACTION * heartScale)
    .addScaledVector(ARCH_LEFT_DIRECTION, ARCH_APEX_LEFT_FRACTION * heartScale)
    .addScaledVector(ARCH_POSTERIOR_DIRECTION, ARCH_APEX_POSTERIOR_FRACTION * heartScale);
  const descendingStart = ascendingEnd
    .clone()
    .addScaledVector(frame.axis, DESCENDING_START_UP_FRACTION * heartScale)
    .addScaledVector(ARCH_LEFT_DIRECTION, DESCENDING_START_LEFT_FRACTION * heartScale)
    .addScaledVector(ARCH_POSTERIOR_DIRECTION, DESCENDING_START_POSTERIOR_FRACTION * heartScale);
  const descendingEnd = descendingStart.clone().addScaledVector(frame.axis, -DESCENDING_LENGTH_FRACTION * heartScale);

  const curve = buildCatmullRomFromPrimaryPoints(ascendingApproach, ascendingEnd, archApex, descendingStart, descendingEnd);
  const brachiocephalicOrigin = curve.getPoint(toArchCurveT(BRACHIOCEPHALIC_ORIGIN_T_FRACTION));
  const leftCommonCarotidOrigin = curve.getPoint(toArchCurveT(LEFT_COMMON_CAROTID_ORIGIN_T_FRACTION));
  const leftSubclavianOrigin = curve.getPoint(toArchCurveT(LEFT_SUBCLAVIAN_ORIGIN_T_FRACTION));
  // 3分枝それぞれ固有の方向(BRACHIOCEPHALIC_UP_FRACTION等のコメント参照)。以前は
  // 弓部カーブ自体の局所接線や弓全体の弦の向き(archDirection)に従属させていたため、
  // 3分枝がほぼ平行な束になり、実際の解剖のような扇状の分かれ方に見えなかった
  // (Playwrightで目視確認)。
  const brachiocephalicDirection = new Vector3()
    .addScaledVector(frame.axis, BRACHIOCEPHALIC_UP_FRACTION)
    .addScaledVector(ARCH_LEFT_DIRECTION, -BRACHIOCEPHALIC_RIGHT_FRACTION)
    .addScaledVector(ARCH_POSTERIOR_DIRECTION, -BRACHIOCEPHALIC_ANTERIOR_FRACTION)
    .normalize();
  const leftCommonCarotidDirection = new Vector3()
    .addScaledVector(frame.axis, LEFT_COMMON_CAROTID_UP_FRACTION)
    .addScaledVector(ARCH_LEFT_DIRECTION, LEFT_COMMON_CAROTID_LEFT_FRACTION)
    .addScaledVector(ARCH_POSTERIOR_DIRECTION, -LEFT_COMMON_CAROTID_ANTERIOR_FRACTION)
    .normalize();
  const leftSubclavianDirection = new Vector3()
    .addScaledVector(frame.axis, LEFT_SUBCLAVIAN_UP_FRACTION)
    .addScaledVector(ARCH_LEFT_DIRECTION, LEFT_SUBCLAVIAN_LEFT_FRACTION)
    .addScaledVector(ARCH_POSTERIOR_DIRECTION, LEFT_SUBCLAVIAN_POSTERIOR_FRACTION)
    .normalize();
  const brachiocephalicEnd = brachiocephalicOrigin
    .clone()
    .addScaledVector(brachiocephalicDirection, BRACHIOCEPHALIC_LENGTH_FRACTION * heartScale);
  const leftCommonCarotidEnd = leftCommonCarotidOrigin
    .clone()
    .addScaledVector(leftCommonCarotidDirection, LEFT_COMMON_CAROTID_LENGTH_FRACTION * heartScale);
  const leftSubclavianEnd = leftSubclavianOrigin
    .clone()
    .addScaledVector(leftSubclavianDirection, LEFT_SUBCLAVIAN_LENGTH_FRACTION * heartScale);

  return {
    ascendingApproach,
    ascendingEnd,
    archApex,
    descendingStart,
    descendingEnd,
    brachiocephalicOrigin,
    brachiocephalicEnd,
    leftCommonCarotidOrigin,
    leftCommonCarotidEnd,
    leftSubclavianOrigin,
    leftSubclavianEnd,
  };
}

/**
 * 弓部大動脈本体(助走点→上行大動脈終端→弓頂部→下行大動脈開始点→終端点)を通る単一の
 * CatmullRomCurve3。この1本のカーブが「大動脈弓の中心線」の唯一のデータソースであり、
 * buildAorticArchGeometry(可視化)・sampleAorticArchTrunk/sampleAorticDescendingBranch
 * (ガイディングカテーテルの経路、guideDeviceMesh.ts)は全てこの関数(または
 * その結果を経由するsample*関数)を通じてのみ点を得る。
 *
 * 論理t値(0=ascendingEnd, ARCH_TRUNK_T_FRACTION=archApex, 1=descendingEnd——助走点
 * 追加前と同じ意味・同じ値)と、この関数が返す実カーブ上のt値(0=ascendingApproach、
 * 助走点1個分ずれる)は異なる。sample*関数は必ずtoArchCurveTで変換してから
 * curve.getPointを呼ぶこと——ARCH_TRUNK_T_FRACTION自体やその消費側
 * (evaluateAorticArchRadius・buildAorticArchGeometry・guideDeviceMesh.ts)は
 * 論理t値のみを扱うため、この関数の内部実装が変わっても影響しない。
 */
function buildAorticArchCurve(frame: AorticRootFrame, heartScale: number): CatmullRomCurve3 {
  const { ascendingApproach, ascendingEnd, archApex, descendingStart, descendingEnd } = computeAorticArchControlPoints(
    frame,
    heartScale,
  );
  return buildCatmullRomFromPrimaryPoints(ascendingApproach, ascendingEnd, archApex, descendingStart, descendingEnd);
}

/** 5制御点(助走点込み)のCatmullRomCurve3において、ascendingEnd〜descendingEndの
 * 「主要区間」が占めるtの開始値(助走点1個分=1/4区間)。 */
const ARCH_APPROACH_T_SPAN = 1 / 4;

/** 論理t値(0=ascendingEnd, 1=descendingEnd)を、buildAorticArchCurveが返す実カーブの
 * t値へ変換する。toArchCurveT(0)=ARCH_APPROACH_T_SPAN(ascendingEndに厳密一致)、
 * toArchCurveT(1)=1(descendingEndに厳密一致)。 */
function toArchCurveT(logicalT: number): number {
  return ARCH_APPROACH_T_SPAN + logicalT * (1 - ARCH_APPROACH_T_SPAN);
}

/**
 * 上行大動脈終端(ascendingEnd)から弓頂部(archApex)までの「幹」区間の密なサンプル点
 * (ascendingEnd起点、終点の順、両端を含む)。buildAorticArchCurveが返す単一のカーブ
 * から直接切り出す。endLogicalT(省略時はARCH_TRUNK_T_FRACTION=弓頂部まで)を指定
 * すると、幹区間の途中(3分枝いずれかの起点など)まででサンプルを打ち切れる
 * ——ガイディングカテーテルの橈骨アプローチ(guideDeviceMesh.ts)が、腕頭動脈の起点
 * までで幹区間の検証を打ち切るために使う。
 *
 * ガイディングカテーテルの体外側経路(guideDeviceMesh.ts、大腿・橈骨の両アプローチ共通)
 * がこの関数をそのまま呼んで経路点として使うことで、画面に実際に表示される弓部の形
 * (buildAorticArchGeometryが同じ関数から作るチューブ)と、カテーテルが通る経路が
 * 構造的に同一の3D点列になることを保証する——制御点の「値」だけを共有し、可視化側・
 * カテーテル側がそれぞれ独立にCatmullRomCurve3を組んでいた従来の実装は、大腿
 * アプローチ(制御点の並びがたまたま可視化側と完全に一致・逆順なだけ)では実害が
 * 無かったが、橈骨アプローチ(制御点セット自体が異なる)では、この幹区間でカテーテルが
 * 弓の可視化ジオメトリから大きく外れる不具合があった。
 */
export function sampleAorticArchTrunk(
  frame: AorticRootFrame,
  heartScale: number,
  sampleCount: number,
  endLogicalT: number = ARCH_TRUNK_T_FRACTION,
): Vector3[] {
  const curve = buildAorticArchCurve(frame, heartScale);
  const points: Vector3[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    points.push(curve.getPoint(toArchCurveT((i / sampleCount) * endLogicalT)));
  }
  return points;
}

/**
 * 弓頂部(archApex)から下行大動脈終端(descendingEnd)までの密なサンプル点(archApex起点、
 * descendingEnd終点の順、両端を含む)。sampleAorticArchTrunkと同じ単一カーブ
 * (buildAorticArchCurve)から直接切り出すため、幹区間との継ぎ目(archApex)で座標が
 * 厳密に一致する(同じカーブの同じt値を評価しているため)。
 */
export function sampleAorticDescendingBranch(frame: AorticRootFrame, heartScale: number, sampleCount: number): Vector3[] {
  const curve = buildAorticArchCurve(frame, heartScale);
  const points: Vector3[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const t = ARCH_TRUNK_T_FRACTION + (i / sampleCount) * (1 - ARCH_TRUNK_T_FRACTION);
    points.push(curve.getPoint(toArchCurveT(t)));
  }
  return points;
}

/** origin〜endの直線上の密なサンプル点(origin起点、end終点の順、両端を含む)。
 * 腕頭動脈・左総頸動脈・左鎖骨下動脈はいずれも実際の形状が直線(2点チューブ)なので、
 * この共通ヘルパーを3分枝それぞれのsample*関数から呼ぶ。 */
function sampleLinearArchBranch(origin: Vector3, end: Vector3, sampleCount: number): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i <= sampleCount; i++) points.push(origin.clone().lerp(end, i / sampleCount));
  return points;
}

/**
 * 弓部カーブ上の起点から腕頭動脈の終端(brachiocephalicEnd)までの密なサンプル点。
 * ガイディングカテーテルの橈骨アプローチ(guideDeviceMesh.ts)がこの関数をそのまま
 * 使うことで、可視化ジオメトリと同一の点列を通ることを保証する。
 */
export function sampleAorticBrachiocephalicBranch(frame: AorticRootFrame, heartScale: number, sampleCount: number): Vector3[] {
  const { brachiocephalicOrigin, brachiocephalicEnd } = computeAorticArchControlPoints(frame, heartScale);
  return sampleLinearArchBranch(brachiocephalicOrigin, brachiocephalicEnd, sampleCount);
}

/** 弓部カーブ上の起点から左総頸動脈の終端までの密なサンプル点(可視化専用、
 * カテーテル経路には使わない)。 */
export function sampleAorticLeftCommonCarotidBranch(frame: AorticRootFrame, heartScale: number, sampleCount: number): Vector3[] {
  const { leftCommonCarotidOrigin, leftCommonCarotidEnd } = computeAorticArchControlPoints(frame, heartScale);
  return sampleLinearArchBranch(leftCommonCarotidOrigin, leftCommonCarotidEnd, sampleCount);
}

/** 弓部カーブ上の起点から左鎖骨下動脈の終端までの密なサンプル点(可視化専用、
 * カテーテル経路には使わない)。 */
export function sampleAorticLeftSubclavianBranch(frame: AorticRootFrame, heartScale: number, sampleCount: number): Vector3[] {
  const { leftSubclavianOrigin, leftSubclavianEnd } = computeAorticArchControlPoints(frame, heartScale);
  return sampleLinearArchBranch(leftSubclavianOrigin, leftSubclavianEnd, sampleCount);
}

/**
 * 弓部大動脈・下行大動脈のジオメトリを構築する。sampleAorticArchTrunk・
 * sampleAorticDescendingBranchが返す点列(単一のカーブ=大動脈の中心線から直接
 * 切り出したもの)をそのまま連結し、先細りの半径列と合わせてチューブを組む。断面は
 * 常に円形(洞の三つ葉ローフトは上行大動脈の根本近くのみに必要)なので、
 * buildLobedTubeGeometryのような専用ロフトは使わず、stentLatticeMeshの
 * buildTubeFromPoints(ガイディングカテーテルや血管メッシュで既に使われている
 * 中心線点列+半径列→チューブ生成)をそのまま再利用する。
 *
 * smoothingPassesは明示的に0を渡す——既定値24はストラットのジグザグ点列を滑らかにする
 * 想定の強い平滑化で、始点・終点も隣接点側へ引き寄せてしまう(実測で始点が上行大動脈の
 * 終端から離れ、2つのチューブの間に隙間ができる不具合になっていた)。CatmullRomで
 * 密にサンプリングした点列は既に滑らかなため、平滑化は不要かつ有害。
 */
export function buildAorticArchGeometry(frame: AorticRootFrame, heartScale: number): BufferGeometry {
  // ascendingEnd(弓部の起点、AORTIC_ROOT_PROFILEの最後の行と同じ高さ)でのスケールが
  // computeEffectiveRootScaleの終端値(=frame.ascendingRadius由来)と厳密に一致するよう、
  // ARCH_RADIUS_RATIOS[0](=AORTIC_ROOT_PROFILE最終行のbaseRadiusAmtと同じ値)を基準に
  // frame.ascendingRadiusから直接スケールを求める(sinusRadius由来のスケールは使わない
  // ——AorticRootFrame.ascendingRadiusのコメント参照)。
  const scale = frame.ascendingRadius / ARCH_RADIUS_RATIOS[0];
  const trunkCount = Math.round(ARCH_SAMPLE_COUNT * ARCH_TRUNK_T_FRACTION);
  const branchCount = ARCH_SAMPLE_COUNT - trunkCount;
  const trunkPoints = sampleAorticArchTrunk(frame, heartScale, trunkCount);
  const branchPoints = sampleAorticDescendingBranch(frame, heartScale, branchCount);
  // trunkPointsの終点とbranchPointsの始点はどちらもarchApexそのもの(重複)なので、
  // 連結時に片方だけ残す。
  const points = [...trunkPoints, ...branchPoints.slice(1)];
  const totalSegments = points.length - 1;

  const segmentCount = ARCH_RADIUS_RATIOS.length - 1;
  const radii = points.map((_, i) => {
    const segmentT = (i / totalSegments) * segmentCount;
    const segmentIndex = Math.min(Math.floor(segmentT), segmentCount - 1);
    const localT = segmentT - segmentIndex;
    const ratio =
      ARCH_RADIUS_RATIOS[segmentIndex] + (ARCH_RADIUS_RATIOS[segmentIndex + 1] - ARCH_RADIUS_RATIOS[segmentIndex]) * localT;
    return ratio * scale;
  });

  // 上行大動脈チューブ(buildLobedTubeGeometry)の最後のリングは、frame.axisから求めた
  // 断面基準(u, v)を使ってvertex 0をu方向に置く。buildTubeFromPointsは自前の回転最小化
  // フレームを使い、既定では断面の向きを任意の基準ベクトルから決めてしまうため、これを
  // seedNormalで上書きしないと、位置・半径・接線が継ぎ目でぴったり一致していても
  // 断面の回転(頂点の周方向の並び)が食い違い、ねじれた段差に見える(実測: 頂点0の
  // 向きが継ぎ目で90°食い違っていたことを確認)。buildTubeFromFrameの頂点0は
  // -N方向(cos=-cos(0)=-1)になるため、u方向に一致させるにはseedNormal=-uを渡す。
  //
  // さらにseedTangentとしてframe.axisそのものを渡す。points[0](trunkPointsの先頭、
  // ascendingEndそのもの)のtangentは、本来はcomputeTangentsがpoints[0]/points[1]から
  // 実測するが、archApexへ向かう最初の区間は横方向に大きくオフセットしているため、
  // 実測tangentはframe.axisから約20°ずれる(実測確認済み)。これをそのままseedNormalの
  // 直交化に使うと、u自体が継ぎ目でわずかに回転してしまい、上行大動脈側の最後のリングと
  // 厳密には重ならない。seedTangent=frame.axisを渡すことで、この直交化がframe.axisに
  // 対して行われる(u,vは元々frame.axisに直交するよう構成されているため、直交化は
  // 事実上no-opになる)ようにし、継ぎ目の断面(リング全体の頂点位置)が上行大動脈側と
  // 浮動小数点誤差の範囲で厳密に一致するようにする——これにより、buildSeamlessAorticGeometry
  // が2つのチューブを頂点溶接(mergeVertices)で単一メッシュに統合できる。
  const { u: rootU } = computeCrossSectionBasis(frame.axis);
  return buildTubeFromPoints(points, radii, RADIAL_SEGMENTS, 0, undefined, undefined, rootU.clone().negate(), frame.axis);
}

/** buildSeamlessAorticGeometryが上行大動脈側と弓部側の継ぎ目リングを頂点溶接する際の
 * 許容誤差。seedTangent(frame.axis)により継ぎ目の頂点位置は理論上浮動小数点誤差の
 * 範囲で一致するため、この値は「隣接リング間の間隔」よりは十分小さく、かつ
 * 浮動小数点の丸め誤差(1e-6〜1e-5程度)よりは十分大きい値であればよい。 */
const SEAM_WELD_TOLERANCE = 1e-4;

/** 位置(position)属性以外(normal・uv等)を持たない、頂点溶接専用のジオメトリの複製を
 * 作る。mergeVertices(three/addons)は全属性をまとめてハッシュ化して同一頂点かどうかを
 * 判定するため、法線がまだ各チューブ内で別々に計算された(=継ぎ目で値が異なる)状態の
 * まま渡すと、位置が厳密に一致していても法線の違いのせいで溶接されない。位置だけを
 * 残して溶接し、統合後に改めてcomputeVertexNormals()を1回だけ呼ぶことで、継ぎ目を
 * またぐ面同士が法線計算で互いに影響し合うようにする。 */
function stripToPositionOnly(geometry: BufferGeometry): BufferGeometry {
  const stripped = new BufferGeometry();
  const index = geometry.getIndex();
  if (index) stripped.setIndex(index);
  stripped.setAttribute("position", geometry.getAttribute("position"));
  return stripped;
}

/**
 * 大動脈基部(バルサルバ洞)・上行大動脈(buildAorticRootGeometry)と、弓部・下行大動脈
 * (buildAorticArchGeometry)を、継ぎ目で頂点を共有する単一の連続したBufferGeometryとして
 * 構築する。
 *
 * 従来はこの2つを別々のBufferGeometryとして描画しており、buildAorticArchGeometryの
 * seedNormal/seedTangentにより継ぎ目の位置・断面の向きを厳密に一致させても、
 * 各ジオメトリが個別にcomputeVertexNormals()を呼ぶため(そちらは頂点位置ではなく
 * 頂点インデックスごとに法線を平均する)、継ぎ目をまたぐ面同士が互いの法線計算に
 * 影響せず、シェーディングの段差が残っていた(ユーザー報告により発覚——「上行大動脈と
 * 弓部大動脈がシームレスにつながるようにしてほしい」)。
 *
 * この関数は、位置だけを残した2つのジオメトリをBufferGeometryUtils.mergeGeometriesで
 * 連結し、mergeVerticesで継ぎ目の重複頂点を溶接してから、統合後のジオメトリに対して
 * 1回だけcomputeVertexNormals()を呼ぶ。これにより、継ぎ目をまたぐ面同士が法線計算で
 * 互いに影響し合い、真にシームレスな1枚のメッシュになる。
 */
export function buildSeamlessAorticGeometry(
  heartCentroid: Vector3,
  graphs: Map<VesselId, VesselGraph>,
  heartWidth: number,
  detectedOpening: DetectedAorticOpening | null | undefined,
  heartScale: number,
): BufferGeometry | null {
  const frame = computeAorticRootFrame(heartCentroid, graphs, heartWidth, detectedOpening);
  if (!frame) return null;
  const rootGeometry = buildLobedTubeGeometry(frame, RADIAL_SEGMENTS, detectedOpening);
  const archGeometry = buildAorticArchGeometry(frame, heartScale);
  const merged = mergeGeometries([stripToPositionOnly(rootGeometry), stripToPositionOnly(archGeometry)]);
  if (!merged) return rootGeometry;
  const welded = mergeVertices(merged, SEAM_WELD_TOLERANCE);
  welded.computeVertexNormals();
  return welded;
}

/** 3分枝それぞれの経路サンプリング数。腕頭動脈はカテーテル経路の検証にも使うため
 * 太め・細かめに、左総頸動脈・左鎖骨下動脈は可視化専用のため少なめでよい。 */
const BRACHIOCEPHALIC_SAMPLE_COUNT = 12;
const LEFT_COMMON_CAROTID_SAMPLE_COUNT = 8;
const LEFT_SUBCLAVIAN_SAMPLE_COUNT = 8;

/**
 * pointの位置における大動脈弓・下行大動脈(sampleAorticArchTrunk/sampleAorticDescendingBranch
 * が返す中心線)の局所半径を、buildAorticArchGeometryが使うのと同じARCH_RADIUS_RATIOSの
 * 補間で返す。centerlineFraction(中心線全体に沿った0〜1の位置、0=ascendingEnd、
 * 1=descendingEnd)を明示的に受け取る——中心線は直線ではないため、pointの実座標から
 * この位置を逆算するのではなく、呼び出し側(サンプリング時)が知っているfractionを
 * そのまま渡す。guideDeviceMesh.tsの経路内腔検証が使う。
 */
export function evaluateAorticArchRadius(frame: AorticRootFrame, centerlineFraction: number): number {
  const scale = frame.ascendingRadius / ARCH_RADIUS_RATIOS[0];
  const segmentCount = ARCH_RADIUS_RATIOS.length - 1;
  const segmentT = Math.max(0, Math.min(1, centerlineFraction)) * segmentCount;
  const segmentIndex = Math.min(Math.floor(segmentT), segmentCount - 1);
  const localT = segmentT - segmentIndex;
  const ratio =
    ARCH_RADIUS_RATIOS[segmentIndex] + (ARCH_RADIUS_RATIOS[segmentIndex + 1] - ARCH_RADIUS_RATIOS[segmentIndex]) * localT;
  return ratio * scale;
}

/** fraction(0=起点、1=終端)における3分枝それぞれの局所半径を返す(起点での大動脈弓の
 * 局所半径×それぞれのRADIUS_RATIO、そこから末端にかけてわずかに先細り)。
 * guideDeviceMesh.tsの経路内腔検証が使う。 */
function evaluateLinearArchBranchRadius(originRadius: number, fraction: number): number {
  return originRadius * (1 - 0.15 * Math.max(0, Math.min(1, fraction)));
}

export function evaluateAorticBrachiocephalicRadius(frame: AorticRootFrame, fraction: number): number {
  const originRadius = evaluateAorticArchRadius(frame, BRACHIOCEPHALIC_ORIGIN_T_FRACTION) * BRACHIOCEPHALIC_RADIUS_RATIO;
  return evaluateLinearArchBranchRadius(originRadius, fraction);
}

export function evaluateAorticLeftCommonCarotidRadius(frame: AorticRootFrame, fraction: number): number {
  const originRadius = evaluateAorticArchRadius(frame, LEFT_COMMON_CAROTID_ORIGIN_T_FRACTION) * LEFT_COMMON_CAROTID_RADIUS_RATIO;
  return evaluateLinearArchBranchRadius(originRadius, fraction);
}

export function evaluateAorticLeftSubclavianRadius(frame: AorticRootFrame, fraction: number): number {
  const originRadius = evaluateAorticArchRadius(frame, LEFT_SUBCLAVIAN_ORIGIN_T_FRACTION) * LEFT_SUBCLAVIAN_RADIUS_RATIO;
  return evaluateLinearArchBranchRadius(originRadius, fraction);
}

/** origin〜endの直線点列(sampleLinearArchBranch)と半径列から、細く先細りするチューブを
 * 構築する共通ヘルパー(旧buildSubclavianBranchGeometryと同じロフト)。 */
function buildLinearArchBranchGeometry(points: Vector3[], radii: number[]): BufferGeometry {
  return buildTubeFromPoints(points, radii, Math.round(RADIAL_SEGMENTS / 2), 0);
}

/**
 * 腕頭動脈のジオメトリを構築する。ガイディングカテーテルの橈骨アプローチ(右橈骨、
 * 腕頭動脈経由)はこの分岐に沿って体外側へ向かうため(guideDeviceMesh.ts参照)、
 * この分岐が無いとカテーテルが血管の外側(何もない空間)を通っているように見えてしまう。
 */
export function buildBrachiocephalicBranchGeometry(frame: AorticRootFrame, heartScale: number): BufferGeometry {
  const points = sampleAorticBrachiocephalicBranch(frame, heartScale, BRACHIOCEPHALIC_SAMPLE_COUNT);
  const radii = points.map((_, i) => evaluateAorticBrachiocephalicRadius(frame, i / BRACHIOCEPHALIC_SAMPLE_COUNT));
  return buildLinearArchBranchGeometry(points, radii);
}

/** 左総頸動脈のジオメトリを構築する(可視化専用、カテーテル経路には使わない)。 */
export function buildLeftCommonCarotidBranchGeometry(frame: AorticRootFrame, heartScale: number): BufferGeometry {
  const points = sampleAorticLeftCommonCarotidBranch(frame, heartScale, LEFT_COMMON_CAROTID_SAMPLE_COUNT);
  const radii = points.map((_, i) => evaluateAorticLeftCommonCarotidRadius(frame, i / LEFT_COMMON_CAROTID_SAMPLE_COUNT));
  return buildLinearArchBranchGeometry(points, radii);
}

/** 左鎖骨下動脈のジオメトリを構築する(可視化専用、カテーテル経路には使わない)。 */
export function buildLeftSubclavianBranchGeometry(frame: AorticRootFrame, heartScale: number): BufferGeometry {
  const points = sampleAorticLeftSubclavianBranch(frame, heartScale, LEFT_SUBCLAVIAN_SAMPLE_COUNT);
  const radii = points.map((_, i) => evaluateAorticLeftSubclavianRadius(frame, i / LEFT_SUBCLAVIAN_SAMPLE_COUNT));
  return buildLinearArchBranchGeometry(points, radii);
}

/**
 * 大動脈基部・上行大動脈のジオメトリを、RCA/LAD/LCXの冠動脈入口部(オスティウム)位置から
 * 幾何学的に逆算して構築する(computeAorticRootFrame参照)。いずれかの中心線グラフが
 * 欠けている、または逆算不能な場合はnullを返す。
 */
export function buildAorticRootGeometry(
  heartCentroid: Vector3,
  graphs: Map<VesselId, VesselGraph>,
  heartWidth = 0,
  detectedOpening?: DetectedAorticOpening | null,
): BufferGeometry | null {
  const frame = computeAorticRootFrame(heartCentroid, graphs, heartWidth, detectedOpening);
  if (!frame) return null;
  return buildLobedTubeGeometry(frame, RADIAL_SEGMENTS, detectedOpening);
}
