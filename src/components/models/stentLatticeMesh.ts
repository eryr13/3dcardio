import { BufferGeometry, Color, Float32BufferAttribute, Vector3 } from "three";
import type { StentObject } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";

/**
 * ステントの網目(ストラット)生成パラメータ。デバッグパネルから調整できる。
 *
 * 実在の薬剤溶出ステント(例: Terumo Ultimaster、コバルトクロム・ストラット厚80µmの
 * オープンセル・2リンク設計)の構造を参考にしている。以前の実装は「strutCount本の
 * 連続したワイヤーが全長を貫いてジグザグし、隣接ワイヤー同士が交差する」編み込み
 * (braided)ワイヤーメッシュ型で、自己拡張型の編組ステントに近い見た目だった。
 * 実際のバルーン拡張型DESは、独立した正弦波状の「リング」が軸方向に並び、
 * 隣接リング同士はごく少数の短いコネクタ(リンク)でだけ接続される
 * (オープンセル設計)。この構造に合わせて作り直した。
 */
export interface StentLatticeParams {
  /** ステント全長に配置するリング(正弦波状の輪)の数 */
  ringCount: number;
  /** 1リングあたりの周方向クラウン(山)数(Ultimasterクラスの実サイズで6〜9程度が一般的) */
  crownsPerRing: number;
  /** リング間を接続するコネクタ(リンク)の本数(オープンセル設計。Ultimasterは2) */
  connectorsPerRing: number;
  /**
   * ストラットの太さ(ステント半径に対する比率)。実測値(80µmストラット/3mm径ステント)
   * では半径比にしておよそ0.027だが、その値だと3Dビューでほぼ視認できなくなるため、
   * 視認性とのバランスを取ってやや太めの既定値にしてある(実機で見ながら調整可能)。
   */
  strutRadiusRatio: number;
}

export const DEFAULT_STENT_LATTICE_PARAMS: StentLatticeParams = {
  ringCount: 10,
  crownsPerRing: 7,
  connectorsPerRing: 2,
  strutRadiusRatio: 0.05,
};

/**
 * ステント径(mm相当のUI入力値)を、GLBメッシュのワールド単位系に依存しない形で
 * 局所血管半径にスケールするための基準値。典型的な冠動脈径3.0mmを基準に、
 * diameter=3.0のときステント半径が局所血管半径とほぼ一致するようにする。
 * 絶対的な「mm→シーン単位」換算は一切行わず、常に測定済みの血管半径(sample.radius、
 * シーン単位)に対する比率としてステント半径を決めるため、mmの数値自体がどんな
 * 値でもスケール不一致(シーンに対して桁違いに巨大/極小)は構造的に起こらない。
 */
const STENT_REFERENCE_VESSEL_DIAMETER_MM = 3.0;

/** 血管の内腔にほぼ収まるよう、実測血管半径よりわずかに内側(95%)に収める。 */
const STENT_LUMEN_FIT_RATIO = 0.95;

/**
 * 中心線上の点をステント用に細かくサンプリングすると(中心線本体の解像度より
 * 密に取ると)、隣接点の差分から求めるtangentが小さな位置ノイズを増幅してしまい、
 * 実際には滑らかな血管経路なのにtangentの向きが数点おきに大きく暴れる不具合が
 * あった(実機検証で確認: 各点のnormalは数値的に完全に直交・単位長を保っていたが、
 * その"向き"自体が細かい位置ノイズに引きずられて暴れ、断面がバラバラの方向を向いた
 * 塊状の見た目になっていた)。tangent計算の前に点列自体を軽く移動平均で平滑化し、
 * 微分によるノイズ増幅を抑える。
 */
function smoothPoints(points: Vector3[], passes = 24): Vector3[] {
  let result = points;
  for (let pass = 0; pass < passes; pass++) {
    result = result.map((p, i) => {
      const prev = result[Math.max(0, i - 1)];
      const next = result[Math.min(result.length - 1, i + 1)];
      return p.clone().multiplyScalar(0.5).add(prev.clone().multiplyScalar(0.25)).add(next.clone().multiplyScalar(0.25));
    });
  }
  return result;
}

function computeTangents(points: Vector3[]): Vector3[] {
  const n = points.length;
  return points.map((_, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const diff = next.clone().sub(prev);
    return diff.lengthSq() > 1e-12 ? diff.normalize() : new Vector3(0, 1, 0);
  });
}

function buildInitialNormal(tangent: Vector3): Vector3 {
  const arbitrary = Math.abs(tangent.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  return new Vector3().crossVectors(tangent, arbitrary).normalize();
}

/**
 * 各点のtangentから、回転最小化フレーム(Rotation-Minimizing Frame)のnormal列を作る。
 * 最初の点だけ任意基準ベクトルからnormalを作り、以降は「前点のtangentから今回の
 * tangentへの最小回転」を前点のnormalに適用して伝播させる。基準ベクトルを毎回
 * 選び直す方式だと、tangent.yが0.9を跨ぐ等で不連続に反転し隣接リングがねじれる
 * 不具合があったため、この方式を採用している(実機検証で確認済み)。
 */
function propagateNormals(tangents: Vector3[]): Vector3[] {
  const normals: Vector3[] = [buildInitialNormal(tangents[0])];
  const axis = new Vector3();
  for (let i = 1; i < tangents.length; i++) {
    const prevTangent = tangents[i - 1];
    const currTangent = tangents[i];
    axis.crossVectors(prevTangent, currTangent);
    let rotatedNormal = normals[i - 1].clone();
    if (axis.lengthSq() > 1e-12) {
      axis.normalize();
      const theta = Math.acos(Math.min(1, Math.max(-1, prevTangent.dot(currTangent))));
      rotatedNormal = normals[i - 1].clone().applyAxisAngle(axis, theta);
    }
    // 直交性の浮動小数点誤差蓄積を避けるため、tangentに対して毎回re-orthogonalizeする。
    const binormal = new Vector3().crossVectors(currTangent, rotatedNormal).normalize();
    normals.push(new Vector3().crossVectors(binormal, currTangent).normalize());
  }
  return normals;
}

/**
 * 中心線の点列から、平滑化済み点列・各点のtangent・回転最小化フレームのnormalを
 * まとめて計算する。buildTubeFromPointsの内部計算そのものだが、ストラットの
 * ジグザグ生成でも「土台円筒と同じ安定したフレーム」を1回だけ計算して全ストラット線で
 * 共有したいため、独立した関数として切り出している(ジグザグ点列自体から
 * フレームを再計算すると、鋭い折れ線でtangentが暴れ、過去に問題が出た向きの破綻を
 * 再現しかねないため避ける)。
 */
export function computeTubeFrame(
  rawPoints: Vector3[],
  smoothingPasses = 24,
): { points: Vector3[]; tangents: Vector3[]; normals: Vector3[] } {
  const points = smoothPoints(rawPoints, smoothingPasses);
  const tangents = computeTangents(points);
  const normals = propagateNormals(tangents);
  return { points, tangents, normals };
}

/**
 * 中心線の点列(points)と各点の半径(radii)から可変半径のチューブメッシュを生成する
 * 唯一のジオメトリ生成ロジック。血管本体は静的GLBメッシュであり「点列+半径配列から
 * チューブを生成する既存関数」は実在しないため、この関数をステント(および将来的に
 * 他の管状オブジェクト)から共通で使えるものとして切り出した。
 *
 * three.jsのTubeGeometryは定数半径しか受け付けないため使えず、また
 * Curve.computeFrenetFrames()はgetPointAt()の弧長再パラメータ化を経由するため、
 * ここで渡すpoints/radiiのインデックス(パラメータt等間隔)と対応が取れなくなる
 * (実装検討中に判明)。そのため、フレーム計算は自前のpropagateNormals(前点からの
 * 回転伝播)で行い、points[i]/radii[i]と1対1に対応する形で頂点を生成する。
 *
 * smoothingPassesは既定で強め(24回)の平滑化をかけるが、ストラットのジグザグ点列の
 * ように「意図した折れ線形状を保ったまま太さだけ与えたい」場合は小さい値
 * (または0)を渡せるようにしている。
 */
export function buildTubeFromPoints(
  rawPoints: Vector3[],
  radii: number[],
  radialSegments = 16,
  smoothingPasses = 24,
  /**
   * 各中心線点(rawPoints[i]と1対1対応)に紐づく任意のスカラー値。指定すると
   * "aScalar" という頂点属性として、同じ点から生成される全周方向の頂点に同じ値を
   * 複製して埋め込む(造影剤フローの濃度マスク用途、contrastFillMesh.ts参照)。
   */
  pointScalars?: number[],
  /**
   * 各中心線点(rawPoints[i]と1対1対応)に紐づく任意の色。指定すると標準の"color"
   * 頂点属性として埋め込み、MeshStandardMaterial等のvertexColors:trueで直接使える
   * (メインビューの造影剤充填チューブが、血管色をベースに濃度で明度・彩度を変えた
   * 色を焼き込むのに使う、contrastFillMesh.ts参照)。
   */
  pointColors?: Color[],
): BufferGeometry {
  const { points, tangents, normals } = computeTubeFrame(rawPoints, smoothingPasses);
  return buildTubeFromFrame(points, tangents, normals, radii, radialSegments, pointScalars, pointColors);
}

/**
 * buildTubeFromPointsの三角形分割ロジックそのものだが、フレーム(tangents/normals)を
 * computeTubeFrame(回転最小化・前点からの伝播)で計算する代わりに、呼び出し側が
 * あらかじめ用意したフレームをそのまま使う。
 *
 * ステントのリング(閉じた正弦波状の輪、stentLatticeMesh.tsのbuildRingSamples参照)は
 * 円周方向に閉じたループであり、computeTubeFrameの回転伝播(propagateNormals)は
 * 開いた経路が前提のため、ループを1周した後の法線が起点の法線と厳密に一致する保証が
 * ない(パスがねじれ(トーション)を持つ場合、伝播した法線が起点とわずかにずれ、
 * 継ぎ目にねじれの段差が出うる)。リングは角度の周期関数として各点の位置・接線・
 * 断面基準方向を直接(伝播でなく)計算しているため、角度=0と角度=2πで厳密に同じ
 * 値になり、継ぎ目のねじれが構造的に起こらない。この関数はそのような「フレーム計算
 * 自体を伝播に頼らない」呼び出し元のために、三角形分割ロジックだけを共有する。
 */
export function buildTubeFromFrame(
  points: Vector3[],
  tangents: Vector3[],
  normals: Vector3[],
  radii: number[],
  radialSegments = 16,
  pointScalars?: number[],
  pointColors?: Color[],
): BufferGeometry {
  const segments = points.length - 1;

  const positions: number[] = [];
  const outNormals: number[] = [];
  const uvs: number[] = [];
  const scalars: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const binormal = new Vector3();
  const normal = new Vector3();

  for (let i = 0; i <= segments; i++) {
    const point = points[i];
    const tangent = tangents[i];
    const N = normals[i];
    binormal.crossVectors(tangent, N).normalize();
    const radius = radii[i];
    const scalar = pointScalars?.[i] ?? 0;
    const color = pointColors?.[i];

    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);

      normal.set(cos * N.x + sin * binormal.x, cos * N.y + sin * binormal.y, cos * N.z + sin * binormal.z).normalize();
      outNormals.push(normal.x, normal.y, normal.z);
      positions.push(point.x + radius * normal.x, point.y + radius * normal.y, point.z + radius * normal.z);
      uvs.push(i / segments, j / radialSegments);
      if (pointScalars) scalars.push(scalar);
      if (color) colors.push(color.r, color.g, color.b);
    }
  }

  for (let j = 1; j <= segments; j++) {
    for (let i = 1; i <= radialSegments; i++) {
      const a = (radialSegments + 1) * (j - 1) + (i - 1);
      const b = (radialSegments + 1) * j + (i - 1);
      const c = (radialSegments + 1) * j + i;
      const d = (radialSegments + 1) * (j - 1) + i;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(outNormals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  if (pointScalars) geometry.setAttribute("aScalar", new Float32BufferAttribute(scalars, 1));
  if (pointColors) geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

/**
 * 三角形1枚を、指定した目標法線(desiredNormal)を向くように頂点順序を自動調整して
 * 追加する。手作業でインデックスの巻き順を数え上げるとキャップ形状のたびに間違え
 * やすく、しかも巻き順は深度ピールのfront/back面カリング(=正しいシネX線減算)にも
 * 直結するため、外積で実際の法線を計算し目標と逆なら頂点を入れ替える方式にして
 * 常に正しい向きを保証する(各三角形が専用の頂点を持つため頂点共有はしない)。
 * 石灰化シェル(calcificationMesh.ts)・狭窄プラークの端キャップ(stenosisPlaqueMesh.ts)
 * のどちらも同じ「閉じたキャップ形状を正しい巻き順で作る」要件を持つため、
 * 低レベルの共有ユーティリティとしてここに置く。
 */
export function pushOrientedTriangle(
  positions: number[],
  normalsOut: number[],
  uvs: number[],
  indices: number[],
  pA: Vector3,
  pB: Vector3,
  pC: Vector3,
  desiredNormal: Vector3,
): void {
  const ab = new Vector3().subVectors(pB, pA);
  const ac = new Vector3().subVectors(pC, pA);
  const faceNormal = new Vector3().crossVectors(ab, ac);
  const baseIndex = positions.length / 3;
  const [v0, v1, v2] = faceNormal.dot(desiredNormal) < 0 ? [pA, pC, pB] : [pA, pB, pC];
  positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
  normalsOut.push(
    desiredNormal.x,
    desiredNormal.y,
    desiredNormal.z,
    desiredNormal.x,
    desiredNormal.y,
    desiredNormal.z,
    desiredNormal.x,
    desiredNormal.y,
    desiredNormal.z,
  );
  uvs.push(0, 0, 1, 0, 0, 1);
  indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
}

/** 代表半径を求めるために区間内でサンプリングする点数。 */
const RADIUS_SAMPLE_COUNT = 9;

/**
 * ステント区間内の血管半径を複数点サンプリングし、その中央値を代表半径とする。
 * 実物のステントはリジッドな一定直径の筒であり、留置区間内で血管側が多少
 * テーパーしていてもステント自体の直径は変わらない。区間中心1点の値だけを
 * 使うと、その1点がベンド区間(Yビン分割が断面幅を過大評価しやすい区間)に
 * たまたま当たった場合に円錐状の見た目になる不具合があった(実機検証で確認:
 * RCA48〜58%相当の区間で半径が約3.7倍に滑らかに変化し、tangentに追従する
 * 可変半径のままステントを生成すると円錐形になっていた)。中央値を使うことで、
 * 区間内に外れ値が1〜2点混ざっていても代表値が大きく引っ張られないようにする。
 */
function computeMedianStentRadius(centerline: CenterlinePoint[], tStart: number, tEnd: number, diameter: number): number {
  const vesselRadiusSamples: number[] = [];
  for (let i = 0; i < RADIUS_SAMPLE_COUNT; i++) {
    const t = tStart + ((tEnd - tStart) * i) / Math.max(1, RADIUS_SAMPLE_COUNT - 1);
    vesselRadiusSamples.push(sampleCenterline(centerline, t).radius);
  }
  const sorted = [...vesselRadiusSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianVesselRadius = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Math.max(medianVesselRadius * (diameter / STENT_REFERENCE_VESSEL_DIAMETER_MM) * STENT_LUMEN_FIT_RATIO, 0.003);
}

/**
 * ステントの「土台」円筒ジオメトリを、血管中心線の[position-length/2,
 * position+length/2]区間から直接スライスした点列を使って生成する。
 * 中心座標・向き(tangent)は各点で更新して経路に追従させるが、半径は
 * computeMedianStentRadiusで求めた区間代表値1つに固定する(一定直径の円筒)。
 * 絶対的な「mm→シーン単位」換算は行わず、常に測定済みの血管半径(シーン単位)に
 * 対する比率としてステント半径を決めるため、mmの数値自体がどんな値でも
 * スケール不一致は構造的に起こらない。
 */
export function buildStentGeometry(centerline: CenterlinePoint[], object: StentObject): BufferGeometry {
  const half = Math.max(object.length / 2, 0.005);
  const tStart = Math.max(0, object.position - half);
  const tEnd = Math.min(1, object.position + half);

  const stentRadius = computeMedianStentRadius(centerline, tStart, tEnd, object.diameter);

  const segmentCount = Math.max(16, Math.min(64, Math.round(object.length * 200)));
  const points: Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i <= segmentCount; i++) {
    const t = tStart + ((tEnd - tStart) * i) / segmentCount;
    points.push(sampleCenterline(centerline, t).point);
    radii.push(stentRadius);
  }

  return buildTubeFromPoints(points, radii);
}

/** ストラット(細いチューブ)1本あたりの円周分割数。太さが細いため少なめで十分。 */
const STRUT_RADIAL_SEGMENTS = 6;

/**
 * 複数のBufferGeometry(いずれもposition/normal/uv属性とindexを持つ)を1つに
 * 手動で連結する。three.jsのBufferGeometryUtils.mergeGeometriesはこのリポジトリの
 * 依存関係に含まれておらず、新規に依存を追加するほどの処理でもないため、
 * 既存のcalcificationMesh.tsと同様に手動連結で対応する。
 */
export function mergeIndexedGeometries(geometries: BufferGeometry[]): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const scalars: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  // 全ジオメトリがaScalar/color属性を持つ場合のみ結合結果にも付与する(いずれも
  // buildTubeFromPointsのpointScalars/pointColors引数で作られたジオメトリのみが持つ、
  // 造影剤フロー用の任意属性)。
  const hasScalar = geometries.length > 0 && geometries.every((g) => !!g.getAttribute("aScalar"));
  const hasColor = geometries.length > 0 && geometries.every((g) => !!g.getAttribute("color"));

  for (const geometry of geometries) {
    const positionAttr = geometry.getAttribute("position");
    const normalAttr = geometry.getAttribute("normal");
    const uvAttr = geometry.getAttribute("uv");
    const scalarAttr = hasScalar ? geometry.getAttribute("aScalar") : null;
    const colorAttr = hasColor ? geometry.getAttribute("color") : null;
    const index = geometry.getIndex();
    if (!index) continue;

    for (let i = 0; i < positionAttr.count; i++) {
      positions.push(positionAttr.getX(i), positionAttr.getY(i), positionAttr.getZ(i));
      normals.push(normalAttr.getX(i), normalAttr.getY(i), normalAttr.getZ(i));
      uvs.push(uvAttr.getX(i), uvAttr.getY(i));
      if (scalarAttr) scalars.push(scalarAttr.getX(i));
      if (colorAttr) colors.push(colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i));
    }
    for (let i = 0; i < index.count; i++) {
      indices.push(index.getX(i) + vertexOffset);
    }
    vertexOffset += positionAttr.count;
  }

  const merged = new BufferGeometry();
  merged.setIndex(indices);
  merged.setAttribute("position", new Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  merged.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  if (hasScalar) merged.setAttribute("aScalar", new Float32BufferAttribute(scalars, 1));
  if (hasColor) merged.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return merged;
}

/** 1リング(1周)の正弦波を、1クラウン(山+谷1周期)あたり何点でサンプリングするか。偶数にして谷がちょうど半周期の位置に来るようにする。 */
const RING_SAMPLES_PER_CROWN = 16;

/** リングのピーク-トラフ間の軸方向振幅を、リング間隔に対してどの比率にするか。1リング分の山-谷幅がリング間隔いっぱいまで広がるとコネクタの隙間が無くなるため、余裕を持たせて0.32程度に抑える。 */
const RING_HEIGHT_TO_SPACING_RATIO = 0.32;

interface RingFrame {
  /** リング中心点(centerline上のこのリングの軸位置)。 */
  center: Vector3;
  /** リングの軸方向(centerline tangent)。 */
  tangent: Vector3;
  /** リング断面の基準方向1(centerline normal)。 */
  normal: Vector3;
  /** リング断面の基準方向2(normal×tangentから求めたbinormal)。 */
  binormal: Vector3;
}

/**
 * 1リング(独立した正弦波状の輪)の閉じた点列と、各点でのチューブ化用フレーム
 * (tangent, 断面基準方向)を、角度の周期関数として直接計算する(前点からの
 * 回転伝播には一切頼らない)。
 *
 * 位置: pos(angle) = center + tangent*axialOffset(angle) + stentRadius*radialDir(angle)
 *   radialDir(angle) = cos(angle)*normal + sin(angle)*binormal (周期2π)
 *   axialOffset(angle) = ringHalfHeight * cos(crownsPerRing * angle)
 *     → crownsPerRing個の山(軸方向+側、次リング側)とcrownsPerRing個の谷
 *       (軸方向-側、前リング側)が等間隔に交互する、閉じた正弦波リングになる。
 *
 * チューブ化用フレーム: 位置と同じ式をangleで解析的に微分してこのリング自身の
 * 経路接線(wireTangent)を求め、radialDir(angle)からwireTangentに直交する成分だけを
 * 残したもの(グラム・シュミット直交化)を断面基準方向(refUp)とする。両方とも
 * angle単独の周期関数として毎回そのまま計算しているため(状態を前の点から
 * 引き継がない)、angle=0とangle=2πでの値が数値誤差の範囲で完全に一致し、
 * 継ぎ目にねじれのズレが構造的に起こらない
 * (computeTubeFrameの回転伝播は開いた経路が前提で、閉じたループを1周した後の
 * 法線が起点と厳密に一致する保証がないため、リングにはこちらを使う)。
 *
 * 返す点列はangle=0(index 0)からangle=2π(index totalSamples、位置・フレームとも
 * index 0と同一)まで含む、buildTubeFromFrameでそのまま閉じたチューブになる形。
 */
function buildRingSamples(frame: RingFrame, stentRadius: number, ringHalfHeight: number, crownsPerRing: number) {
  const { center, tangent: T, normal: N, binormal: B } = frame;
  const totalSamples = crownsPerRing * RING_SAMPLES_PER_CROWN;

  const positions: Vector3[] = [];
  const tangents: Vector3[] = [];
  const refUps: Vector3[] = [];

  for (let s = 0; s <= totalSamples; s++) {
    const angle = (2 * Math.PI * s) / totalSamples;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const radialDir = new Vector3().addScaledVector(N, cosA).addScaledVector(B, sinA);
    const axialOffset = ringHalfHeight * Math.cos(crownsPerRing * angle);
    positions.push(center.clone().addScaledVector(T, axialOffset).addScaledVector(radialDir, stentRadius));

    const dAxialOffset = -ringHalfHeight * crownsPerRing * Math.sin(crownsPerRing * angle);
    const dRadialDir = new Vector3().addScaledVector(N, -sinA).addScaledVector(B, cosA);
    const wireTangent = new Vector3()
      .addScaledVector(T, dAxialOffset)
      .addScaledVector(dRadialDir, stentRadius)
      .normalize();
    tangents.push(wireTangent);

    const refUp = radialDir.addScaledVector(wireTangent, -radialDir.dot(wireTangent)).normalize();
    refUps.push(refUp);
  }

  return { positions, tangents, refUps };
}

/** リング内でk番目のクラウン(山、次リング側へ張り出す点)に対応するサンプルindex。 */
function crownSampleIndex(k: number): number {
  return k * RING_SAMPLES_PER_CROWN;
}

/** リング内でk番目のクラウンの直後にあるトラフ(谷、前リング側へ張り出す点)に対応するサンプルindex。 */
function troughSampleIndex(k: number): number {
  return k * RING_SAMPLES_PER_CROWN + RING_SAMPLES_PER_CROWN / 2;
}

/**
 * ステントの、実在の薬剤溶出ステント(Terumo Ultimasterのオープンセル・2リンク設計を
 * 参考にした)構造を模したラティス(網目状ストラット構造)ジオメトリを生成する。
 *
 * 実際のバルーン拡張型ステントは、コバルトクロムのチューブからレーザーカットで
 * 作られ、独立した正弦波状の「リング」がステント全長に並び、隣接リング同士は
 * 全周ではなくごく少数の短いコネクタ(リンク)だけで接続される「オープンセル」構造を
 * 持つ(以前の実装は、strutCount本の連続したワイヤーが全長を貫いてジグザグし
 * 隣接ワイヤー同士が交差する「編み込みワイヤーメッシュ」型で、自己拡張型の
 * 編組ステントに近い見た目になっていた)。
 *
 * 生成手順:
 * 1. ステント区間の中心線上にringCount個のリング中心点を等間隔に置き、
 *    computeTubeFrameでこの粗い点列だけのフレーム(tangent・回転最小化normal)を
 *    1回計算する(リングの本数は通常十分少ないため、回転伝播によるねじれの
 *    蓄積リスクは無視できる)。
 * 2. 各リング中心で、buildRingSamplesにより閉じた正弦波リングの点列・フレームを
 *    角度の周期関数として直接計算し(伝播に頼らない、詳細は同関数のコメント参照)、
 *    buildTubeFromFrameで細いチューブ化する。
 * 3. 隣接するリングの間を、connectorsPerRing本の短い直線コネクタで接続する。
 *    リングrのk番目のクラウン(次リング側へ張り出す山)から、リングr+1の
 *    対応するトラフ(前リング側へ張り出す谷、山とは半クラウン分角度がずれた
 *    位置にある)へ接続する。これにより、リングの正弦波の位相そのものから
 *    自然に千鳥配置(隣接リング間でコネクタ位置が半クラウン分ずれる)になる。
 *    どのクラウンにコネクタを付けるかは、リングの隙間(gap)ごとに1クラウン分ずつ
 *    回転させ、実際のオープンセル設計のようにコネクタ位置がリングごとに
 *    ずれるようにする。
 */
export function buildStentLatticeGeometry(
  centerline: CenterlinePoint[],
  object: StentObject,
  params: StentLatticeParams,
): BufferGeometry {
  const half = Math.max(object.length / 2, 0.005);
  const tStart = Math.max(0, object.position - half);
  const tEnd = Math.min(1, object.position + half);

  const stentRadius = computeMedianStentRadius(centerline, tStart, tEnd, object.diameter);
  const strutRadius = Math.max(stentRadius * params.strutRadiusRatio, 0.0003);
  const crownsPerRing = Math.max(3, Math.round(params.crownsPerRing));
  const ringCount = Math.max(1, Math.round(params.ringCount));
  const connectorsPerRing = Math.max(1, Math.min(crownsPerRing, Math.round(params.connectorsPerRing)));

  const ringRawPoints: Vector3[] = [];
  for (let r = 0; r < ringCount; r++) {
    const t = ringCount > 1 ? tStart + ((tEnd - tStart) * r) / (ringCount - 1) : (tStart + tEnd) / 2;
    ringRawPoints.push(sampleCenterline(centerline, t).point);
  }
  const { points: ringCenters, tangents: ringTangents, normals: ringNormals } = computeTubeFrame(ringRawPoints, 4);

  let totalSpacing = 0;
  for (let r = 1; r < ringCount; r++) totalSpacing += ringCenters[r].distanceTo(ringCenters[r - 1]);
  const avgSpacing = ringCount > 1 ? totalSpacing / (ringCount - 1) : stentRadius * 2;
  const ringHalfHeight = (avgSpacing * RING_HEIGHT_TO_SPACING_RATIO) / 2;

  const ringFrames: RingFrame[] = ringCenters.map((center, r) => {
    const tangent = ringTangents[r];
    const normal = ringNormals[r];
    const binormal = new Vector3().crossVectors(tangent, normal).normalize();
    return { center, tangent, normal, binormal };
  });

  const ringSamples = ringFrames.map((frame) => buildRingSamples(frame, stentRadius, ringHalfHeight, crownsPerRing));

  const geometries: BufferGeometry[] = [];
  for (const sample of ringSamples) {
    const radii = sample.positions.map(() => strutRadius);
    geometries.push(buildTubeFromFrame(sample.positions, sample.tangents, sample.refUps, radii, STRUT_RADIAL_SEGMENTS));
  }

  for (let r = 0; r < ringCount - 1; r++) {
    const fromSamples = ringSamples[r];
    const toSamples = ringSamples[r + 1];
    for (let c = 0; c < connectorsPerRing; c++) {
      // ゲート(隙間)ごとに1クラウン分ずつ回転させ、コネクタ位置が実際の
      // オープンセル設計のようにリング間で千鳥にずれるようにする。
      const k = (Math.round((c * crownsPerRing) / connectorsPerRing) + r) % crownsPerRing;
      const fromPoint = fromSamples.positions[crownSampleIndex(k)];
      const toPoint = toSamples.positions[troughSampleIndex(k)];
      geometries.push(
        buildTubeFromPoints([fromPoint, toPoint], [strutRadius, strutRadius], STRUT_RADIAL_SEGMENTS, 0),
      );
    }
  }

  return mergeIndexedGeometries(geometries);
}
