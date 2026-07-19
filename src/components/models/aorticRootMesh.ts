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

import { BufferAttribute, BufferGeometry, Plane, Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
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
 * 追加の倍率。倍率1.0(=純粋な120°弦当てはめ)だと、中心が心臓の重心軸から
 * あまり離れず(実測でこのモデルでは約0.39——半径とほぼ同じ大きさ)、洞管接合部
 * より上の「上行大動脈」に相当する部分まで心臓メッシュの内部に埋もれてしまう
 * (実際のheart-realistic.glbに対するレイキャスト実測で確認済み)。中心をさらに
 * 外側へ押し出すことで解消するが、両オスティウムを通る円という制約は保ったまま
 * (半径をその分再計算する)なので、入口部が円筒の側面上に乗るという不変条件は
 * 崩れない——ただし押し出すほどRCA・左冠動脈入口部間の見かけの角度は120°より
 * 狭くなる(押し出すほど遠くの中心から見た弦の張る角度は小さくなるため)。1.5倍は
 * 実測で「洞管接合部(up=0.85)より上はほぼ心臓メッシュの外に出る」かつ「角度の
 * 縮み(120°→約98°)が過大にならない」バランス点として選んだ値。
 */
const CENTER_OUTWARD_PUSH_FACTOR = 1.5;

/**
 * 冠動脈入口部の実位置から幾何学的に逆算した、大動脈基部(バルサルバ洞)の
 * 中心軸・半径・3つの洞の角度位置。
 */
export interface AorticRootFrame {
  /** 中心軸上の代表点(バルサルバ洞のピーク高さ = RCA/左冠動脈入口部の平均高さ)。 */
  center: Vector3;
  /** 中心軸の方向。解剖座標系の頭側方向に固定する(実際の上行大動脈はやや前方に
   * 傾くが、まずは単純化のため純粋な頭側方向とする)。 */
  axis: Vector3;
  /** バルサルバ洞レベルでの半径。RCA/左冠動脈入口部の両方が、この半径の円筒の
   * 側面上に来るよう逆算した値(computeAorticRootFrameのコメント参照)。 */
  sinusRadius: number;
  /** 右冠尖洞(RCA入口部)の中心角度(ラジアン、中心軸から見たX-Z平面上の角度)。 */
  rcaAngle: number;
  /** 左冠尖洞(LAD/LCX入口部の中点)の中心角度。 */
  leftAngle: number;
  /** 無冠尖洞の中心角度(対応する入口部が実データに無いため、残りの弧の中点に置く)。 */
  nonCoronaryAngle: number;
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
export function computeAorticRootFrame(
  heartCentroid: Vector3,
  graphs: Map<VesselId, VesselGraph>,
): AorticRootFrame | null {
  const rcaGraph = graphs.get("RCA");
  const ladGraph = graphs.get("LAD");
  const lcxGraph = graphs.get("LCX");
  if (!rcaGraph || !ladGraph || !lcxGraph) return null;

  const rcaOstium = getMainTrunk(rcaGraph).points[0]?.position;
  const ladOstium = getMainTrunk(ladGraph).points[0]?.position;
  const lcxOstium = getMainTrunk(lcxGraph).points[0]?.position;
  if (!rcaOstium || !ladOstium || !lcxOstium) return null;

  // LAD/LCXは解剖学的には単一の左冠動脈主幹部(左バルサルバ洞)から起始するため、
  // その代表点としてLAD/LCXそれぞれの起始点の中点を「左冠動脈入口部」とみなす。
  const leftOstium = ladOstium.clone().add(lcxOstium).multiplyScalar(0.5);

  const axis = new Vector3(0, 1, 0);
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

  const centerY = (rcaOstium.y + leftOstium.y) / 2;
  const center = new Vector3(chosen.x, centerY, chosen.z);

  const rcaAngle = Math.atan2(rcaOstium.z - center.z, rcaOstium.x - center.x);
  const leftAngle = Math.atan2(leftOstium.z - center.z, leftOstium.x - center.x);
  const nonCoronaryAngle = bisectLargerArc(rcaAngle, leftAngle);

  const rcaDistanceToAxis = Math.hypot(rcaOstium.x - center.x, rcaOstium.z - center.z);
  const leftDistanceToAxis = Math.hypot(leftOstium.x - center.x, leftOstium.z - center.z);

  // 弦当てはめで求めた半径は、RCA・左冠動脈入口部「の中点」がちょうど乗る円の半径で
  // あり、(1) LAD/LCXそれぞれの入口部は中点からわずかにずれるため必ずしもこの半径
  // 上には無い、(2) AORTIC_ROOT_PROFILEの台地は高さ0(=frame.center、RCA・左冠動脈
  // 入口部の平均高さ)を基準とするが、RCA/LAD/LCX個々の入口部の高さはそこから多少
  // ずれる。このため弦当てはめの半径をそのままsinusRadiusとして使うと、実際の
  // 入口部(=カテーテル先端が嵌まるべき位置)が可視化した内腔の壁からわずかに
  // はみ出すことがある。3つの入口部それぞれについて、この半径・角度で
  // AORTIC_ROOT_PROFILEを評価した局所半径に対する実際の距離の比率を求め、最大値
  // (=最も壁からはみ出す入口部)を吸収できるよう半径を拡大する。
  const provisionalFrame: AorticRootFrame = {
    center,
    axis,
    sinusRadius: geometricSinusRadius,
    rcaAngle,
    leftAngle,
    nonCoronaryAngle,
  };
  let containmentRatio = 1;
  for (const [label, ostium] of [
    ["RCA", rcaOstium],
    ["LAD", ladOstium],
    ["LCX", lcxOstium],
  ] as const) {
    const { upRelative } = projectOntoFrame(provisionalFrame, ostium);
    if (upRelative < SINUS_PLATEAU_UP_RANGE[0] || upRelative > SINUS_PLATEAU_UP_RANGE[1]) {
      // 台地の外では半径が高さに応じて変化するため、この安全マージン計算の前提
      // (台地内では半径が高さに依存しない)が崩れる。実際の解剖では稀なはずだが、
      // 発生した場合はマージンが不足する可能性があるため警告する。
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
  const containmentScale = containmentRatio * CONTAINMENT_SAFETY_BUFFER;
  const sinusRadius = geometricSinusRadius * containmentScale;

  console.log(
    "[aorticRootMesh] 大動脈基部フレームの検証: " +
      `弦当てはめ半径=${geometricSinusRadius.toFixed(4)}, ` +
      `RCA入口部までの距離=${rcaDistanceToAxis.toFixed(4)}(誤差${Math.abs(rcaDistanceToAxis - geometricSinusRadius).toExponential(2)}), ` +
      `左冠動脈入口部までの距離=${leftDistanceToAxis.toFixed(4)}(誤差${Math.abs(leftDistanceToAxis - geometricSinusRadius).toExponential(2)}), ` +
      `内腔安全マージン適用後の半径=${sinusRadius.toFixed(4)}(倍率${containmentScale.toFixed(3)})`,
  );

  return { center, axis, sinusRadius, rcaAngle, leftAngle, nonCoronaryAngle };
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
  [4.5, 1.15, 0], // 大動脈弓へ向かう手前(見た目の連続性のため実際の大動脈長より延ばしている)
  [8.3, 1.12, 0],
  [12.3, 1.08, 0],
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

/** 3つの洞の張り出し量(0〜1)。各洞中心からLOBE_HALF_WIDTHの範囲でなめらかに0へ落ち、
 * 複数の洞の張り出しが重なる場合は大きい方を採用する(=洞同士の交連部で自然に括れる)。 */
function lobeBulge(theta: number, lobeCenters: readonly number[]): number {
  let bulge = 0;
  for (const center of lobeCenters) {
    const d = Math.abs(angularDiff(theta, center));
    if (d < LOBE_HALF_WIDTH) {
      bulge = Math.max(bulge, Math.cos((d / LOBE_HALF_WIDTH) * (Math.PI / 2)));
    }
  }
  return bulge;
}

/** frameの断面基準軸(u, v)を求める。中心軸は常に頭側方向(0,1,0)の固定軸のため、
 * 断面の基準軸は全リングで共通(このファイル・guideDeviceMesh.tsの両方で同じ角度
 * 規約(atan2(z,x)がu,vのなす角と一致する)を使うために共有する)。 */
function computeCrossSectionBasis(frame: AorticRootFrame): { u: Vector3; v: Vector3 } {
  let u = new Vector3(1, 0, 0).addScaledVector(frame.axis, -frame.axis.dot(new Vector3(1, 0, 0)));
  if (u.lengthSq() < 1e-8) u = new Vector3(0, 0, 1).addScaledVector(frame.axis, -frame.axis.dot(new Vector3(0, 0, 1)));
  u.normalize();
  // atan2(z, x)で求めた角度と、実際に頂点を配置する向きが一致するように v = u×axis に
  // する(cross(axis, u)にすると符号が反転し、角度の向きが逆になってしまう)。
  const v = new Vector3().crossVectors(u, frame.axis).normalize();
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
  const { u, v } = computeCrossSectionBasis(frame);
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
export function evaluateAorticRootRadius(frame: AorticRootFrame, point: Vector3): number {
  const scale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  const { upRelative, theta } = projectOntoFrame(frame, point);
  const lobeCenters = [frame.rcaAngle, frame.leftAngle, frame.nonCoronaryAngle] as const;

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
  const baseRadiusAmt = lower[1] + (upper[1] - lower[1]) * t;
  const lobeAmplitudeAmt = lower[2] + (upper[2] - lower[2]) * t;

  const bulge = lobeBulge(theta, lobeCenters);
  return (baseRadiusAmt + lobeAmplitudeAmt * bulge) * scale;
}

/** buildAorticCavityClippingPlanesが作る空洞の高さ範囲(up相対値)。 */
const AORTIC_CAVITY_UP_MIN = -1.0;
const AORTIC_CAVITY_UP_MAX = 1.5;
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
export function buildAorticCavityClippingPlanes(frame: AorticRootFrame): Plane[] {
  const radius = frame.sinusRadius * AORTIC_CAVITY_RADIUS_MARGIN;
  const planes: Plane[] = [];
  for (let i = 0; i < AORTIC_CAVITY_SIDE_COUNT; i++) {
    const angle = (i / AORTIC_CAVITY_SIDE_COUNT) * TWO_PI;
    // axisは常に頭側方向(0,1,0)固定のため、断面基準軸はcomputeCrossSectionBasisと同じ
    // (u=X, v=Z)になる——ここでは直接(cosθ, 0, sinθ)として組み立てる。
    const normal = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    // distanceToPoint(p) = normal・(p-center) - radius: 円柱の内側(軸からradius未満)で
    // 負になる(clipIntersection=trueは、全平面で負になる点だけをクリップする)。
    const constant = -normal.dot(frame.center) - radius;
    planes.push(new Plane(normal, constant));
  }
  const bottomY = pointAtRelativeHeight(frame, AORTIC_CAVITY_UP_MIN).y;
  const topY = pointAtRelativeHeight(frame, AORTIC_CAVITY_UP_MAX).y;
  // 下キャップ: p.y > bottomYで負(空洞は弁輪の高さより上)。
  planes.push(new Plane(new Vector3(0, -1, 0), bottomY));
  // 上キャップ: p.y < topYで負(空洞は洞管接合部より少し上まで)。
  planes.push(new Plane(new Vector3(0, 1, 0), -topY));
  return planes;
}

/**
 * frame(中心軸・半径・3つの洞の角度)とAORTIC_ROOT_PROFILEから、断面が3つの洞で
 * 膨らむローフト形状を構築する。stentLatticeMeshのbuildTubeFromFrame/
 * buildTubeFromPointsは断面が円形(半径のみ可変)であることが前提のため使えず、
 * ここで断面自体が角度に応じて変わるローフトを直接組む。
 *
 * 巻き順(表裏)の検証・保証よりも実装を単純にするため、マテリア側でside=DoubleSideに
 * するのを前提とし、ここでは巻き順を厳密には気にしない(AorticRootOverlay参照)。
 */
function buildLobedTubeGeometry(frame: AorticRootFrame, radialSegments: number): BufferGeometry {
  const scale = frame.sinusRadius / PEAK_RADIUS_UNITS;
  const lobeCenters = [frame.rcaAngle, frame.leftAngle, frame.nonCoronaryAngle] as const;
  const { u, v } = computeCrossSectionBasis(frame);

  const ringCount = AORTIC_ROOT_PROFILE.length;
  const verticesPerRing = radialSegments + 1; // 継ぎ目用に0番目と同じ位置をもう1つ複製する
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < ringCount; i++) {
    const [upAmt, baseRadiusAmt, lobeAmplitudeAmt] = AORTIC_ROOT_PROFILE[i];
    const ringCenter = frame.center.clone().addScaledVector(frame.axis, upAmt * scale);
    const baseRadius = baseRadiusAmt * scale;
    const lobeAmplitude = lobeAmplitudeAmt * scale;

    for (let j = 0; j < verticesPerRing; j++) {
      const theta = (j / radialSegments) * TWO_PI;
      const radius = baseRadius + lobeAmplitude * lobeBulge(theta, lobeCenters);
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

/**
 * 大動脈基部・上行大動脈のジオメトリを、RCA/LAD/LCXの冠動脈入口部(オスティウム)位置から
 * 幾何学的に逆算して構築する(computeAorticRootFrame参照)。いずれかの中心線グラフが
 * 欠けている、または逆算不能な場合はnullを返す。
 */
export function buildAorticRootGeometry(
  heartCentroid: Vector3,
  graphs: Map<VesselId, VesselGraph>,
): BufferGeometry | null {
  const frame = computeAorticRootFrame(heartCentroid, graphs);
  if (!frame) return null;
  return buildLobedTubeGeometry(frame, RADIAL_SEGMENTS);
}
