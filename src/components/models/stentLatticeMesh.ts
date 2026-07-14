import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { StentObject } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";

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
 */
export function buildTubeFromPoints(rawPoints: Vector3[], radii: number[], radialSegments = 16): BufferGeometry {
  const points = smoothPoints(rawPoints);
  const segments = points.length - 1;
  const tangents = computeTangents(points);
  const normals = propagateNormals(tangents);

  const positions: number[] = [];
  const outNormals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const binormal = new Vector3();
  const normal = new Vector3();

  for (let i = 0; i <= segments; i++) {
    const point = points[i];
    const tangent = tangents[i];
    const N = normals[i];
    binormal.crossVectors(tangent, N).normalize();
    const radius = radii[i];

    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);

      normal.set(cos * N.x + sin * binormal.x, cos * N.y + sin * binormal.y, cos * N.z + sin * binormal.z).normalize();
      outNormals.push(normal.x, normal.y, normal.z);
      positions.push(point.x + radius * normal.x, point.y + radius * normal.y, point.z + radius * normal.z);
      uvs.push(i / segments, j / radialSegments);
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
  return geometry;
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
