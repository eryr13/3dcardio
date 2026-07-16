import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { StenosisObject } from "../../types/object";
import { lesionTaperProfile } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";
import { buildTubeFromPoints, computeTubeFrame, mergeIndexedGeometries, pushOrientedTriangle } from "./stentLatticeMesh";

/** プラークの色。石灰化(黄, #e8c400)・ステント(灰, #9098a0)と区別できる、脂質性プラークを想起させるクリーム色 */
export const STENOSIS_PLAQUE_COLOR = "#d8c9a3";

const RADIAL_SEGMENTS = 20;
const SMOOTHING_PASSES = 24;

/**
 * 血管壁とちょうど同じ半径だとz-fightingしうるため、最狭窄プラトーではごくわずかに
 * 内側に収める。区間境界(テーパーがprofile=0に収束する位置)ではこのマージンを
 * 0まで滑らかに戻し、外径をvesselRadiusちょうどに一致させる(margin自体もprofileで
 * テーパーさせる、下のouterRadiusFractionFor参照)。これをしないと、区間境界では
 * 内径(thickness=0のためvesselRadiusちょうど)の方が外径(常にvesselRadius*0.995)より
 * 大きくなってしまい、外径<内径という反転した(自己交差する)環状ジオメトリになる
 * ——狭窄の端キャップ(buildTubeEndAnnularCap)がちょうどこの反転した断面を繋ごうと
 * して破綻し、リング状の見た目の破綻(境界エッジが閉じない)の原因になっていた。
 */
const OUTER_RADIUS_MARGIN = 0.995;

/** プラトー(profile=1)でOUTER_RADIUS_MARGIN、区間境界(profile=0)で1(マージン無し)になる、外径用のマージン率。 */
function outerRadiusFractionFor(profile: number): number {
  return 1 - (1 - OUTER_RADIUS_MARGIN) * profile;
}

/** 狭窄率99%でも内腔半径が0(縮退ジオメトリ)にならないよう設ける下限(局所血管半径に対する比率)。 */
const MIN_LUMEN_RADIUS_RATIO = 0.02;

/**
 * buildTubeFromPointsが各リング頂点に使う角度パラメータ化(v=(j/radialSegments)*2π、
 * normal=cos(v)*N - cos(v)*...ではなくcos*N+sin*binormal、cos=-cos(v))と完全に同じ式で、
 * 端キャップのリム頂点を求める。ここがチューブ本体の式とずれると、キャップとチューブ本体の
 * リムが噛み合わず、細い隙間やオーバーラップ(=新たなリング状の見た目)が生じてしまう。
 */
function ringDirectionAt(N: Vector3, binormal: Vector3, j: number, radialSegments: number): Vector3 {
  const v = (j / radialSegments) * Math.PI * 2;
  const sin = Math.sin(v);
  const cos = -Math.cos(v);
  return new Vector3(cos * N.x + sin * binormal.x, cos * N.y + sin * binormal.y, cos * N.z + sin * binormal.z).normalize();
}

/**
 * チューブの片端を、指定した半径1つのソリッドディスク(円盤)として閉じるキャップ。
 * outer/innerチューブはそれぞれ独立した閉じた立体としてシネX線の深度ピール減算に
 * 使われる(CineVesselThicknessEffect参照)。buildTubeFromPointsは側面(筒の壁)しか
 * 生成せず端が開いたままだったため、開口部の縁が特定の角度から見ると薄いリング状の
 * 輪郭として見えてしまう不具合があった(前回の内腔プロファイルの平滑化で筒の側面同士は
 * なめらかに繋がるようになったが、この「開いた端」自体は別の問題として残っていた)。
 * ソリッドディスクで閉じることで、深度ピールが端の直前まで正しく機能するようになる。
 */
function buildTubeEndDiscCap(
  center: Vector3,
  tangent: Vector3,
  N: Vector3,
  radius: number,
  isStart: boolean,
  radialSegments: number,
): BufferGeometry {
  const binormal = new Vector3().crossVectors(tangent, N).normalize();
  const desiredNormal = isStart ? tangent.clone().negate() : tangent.clone();

  const positions: number[] = [];
  const normalsOut: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let j = 1; j <= radialSegments; j++) {
    const dirA = ringDirectionAt(N, binormal, j - 1, radialSegments);
    const dirB = ringDirectionAt(N, binormal, j, radialSegments);
    const rimA = center.clone().addScaledVector(dirA, radius);
    const rimB = center.clone().addScaledVector(dirB, radius);
    pushOrientedTriangle(positions, normalsOut, uvs, indices, center, rimA, rimB, desiredNormal);
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normalsOut, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * チューブの片端を、外径リムと内径リムを繋ぐ環状(ワッシャー状)のキャップとして閉じる。
 * 見た目用のmerged(外径チューブ+内径チューブ)専用——buildTubeEndDiscCapと違い、
 * 内腔を塞ぐソリッドディスクではなく「プラーク自身の壁の厚み」だけを表す薄い環にする
 * (区間端では外径≈内径≈血管半径まで先細りしているため、この環は実質的に見えなくなり、
 * 血管本来の内腔にシームレスに溶け込む)。
 */
function buildTubeEndAnnularCap(
  center: Vector3,
  tangent: Vector3,
  N: Vector3,
  outerRadius: number,
  innerRadius: number,
  isStart: boolean,
  radialSegments: number,
): BufferGeometry {
  const binormal = new Vector3().crossVectors(tangent, N).normalize();
  const desiredNormal = isStart ? tangent.clone().negate() : tangent.clone();

  const positions: number[] = [];
  const normalsOut: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let j = 1; j <= radialSegments; j++) {
    const dirA = ringDirectionAt(N, binormal, j - 1, radialSegments);
    const dirB = ringDirectionAt(N, binormal, j, radialSegments);
    const outerA = center.clone().addScaledVector(dirA, outerRadius);
    const outerB = center.clone().addScaledVector(dirB, outerRadius);
    const innerA = center.clone().addScaledVector(dirA, innerRadius);
    const innerB = center.clone().addScaledVector(dirB, innerRadius);
    pushOrientedTriangle(positions, normalsOut, uvs, indices, innerA, outerA, outerB, desiredNormal);
    pushOrientedTriangle(positions, normalsOut, uvs, indices, innerA, outerB, innerB, desiredNormal);
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normalsOut, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}

export interface StenosisPlaqueGeometries {
  /** メインビュー・シネスキーマ表示用: 外径チューブ+内径チューブを結合した1枚のジオメトリ */
  merged: BufferGeometry;
  /** シネX線モードの深度ピール減算用: 外径(血管壁に接する側)チューブ単体 */
  outer: BufferGeometry;
  /** シネX線モードの深度ピール減算用: 内径(狭窄後の内腔)チューブ単体 */
  inner: BufferGeometry;
}

/**
 * 狭窄を「血管ジオメトリそのものの変形」ではなく、血管の内側に付着する肉厚を持つ管
 * (内腔が狭まった中空チューブ)として生成する。ステントの土台円筒
 * (buildStentGeometry)と全く同じ sampleCenterline + buildTubeFromPoints の組み合わせを
 * 流用し、位置・長さ・向きの計算ロジックを共有する。
 *
 * three.jsに「内腔付き管」の標準ジオメトリは無いため、外径(血管壁に接する)チューブと
 * 内径(狭窄後の内腔)チューブを別々に生成し、視覚表示用にはこの2枚を1つのジオメトリへ
 * 結合する(merged)。シネX線モードの深度ピール減算には外径・内径を独立したメッシュとして
 * 個別に登録する必要があるため、結合前のジオメトリもそれぞれ返す(CineVesselThicknessEffect
 * 側で「外径は符号反転、内径は通常符号」で同じ血管アキュムレータに加算し、
 * 血管の生厚みからプラーク自身の厚みぶんを差し引く仕組みに使う)。
 *
 * 区間中央(object.position)を中心とした最狭窄プラトー(中央80%)を最も厚く保ち、
 * 両端それぞれ10%の入口/出口テーパーで厚みが0へなめらかに収束する台形状のプロファイル
 * (lesionTaperProfile、types/object.ts)を使う(「指定した狭窄率」は最狭窄プラトーに
 * おける値として扱う)。造影剤フロー(utils/contrastFlow.ts)が参照する内腔半径比率も
 * 同じlesionTaperProfileを使うため、このプラークの内腔境界と造影剤で満たされる
 * チューブの半径は常に一致する。血管半径は固定値を使わず、各サンプル点ごとに
 * sampleCenterline から実際に取得した局所半径を使う(区間内で血管が自然にテーパー
 * していれば、プラーク厚みもそれに追従する)。
 *
 * buildTubeFromPointsは筒の側面しか生成せず両端が開いたままなので、それぞれを
 * 明示的なキャップで閉じる: outer/inner単体(シネX線の深度ピール減算用)は
 * それぞれソリッドディスクのキャップ(buildTubeEndDiscCap)で閉じ、mergedは
 * 外径リムと内径リムを繋ぐ環状キャップ(buildTubeEndAnnularCap、プラーク自身の
 * 壁厚みだけを表す)で閉じる。区間端では外径≈内径≈血管半径(テーパーで厚みが
 * 0に収束するため)、環状キャップは実質的に消え、血管本来の内腔にシームレスに
 * 溶け込む。閉じずに開いた端をそのままにすると、特定の角度から見た際に
 * 開口部の縁が薄いリング(楕円)状の輪郭として見えてしまう不具合があった。
 */
export function buildStenosisPlaqueGeometry(
  centerline: CenterlinePoint[],
  object: StenosisObject,
): StenosisPlaqueGeometries {
  const half = Math.max(object.length / 2, 0.005);
  const tStart = Math.max(0, object.position - half);
  const tEnd = Math.min(1, object.position + half);
  const segmentCount = Math.max(16, Math.min(64, Math.round(object.length * 200)));

  const points: Vector3[] = [];
  const outerRadii: number[] = [];
  const innerRadii: number[] = [];
  for (let i = 0; i <= segmentCount; i++) {
    const t = tStart + ((tEnd - tStart) * i) / segmentCount;
    const sample = sampleCenterline(centerline, t);
    points.push(sample.point);

    const vesselRadius = sample.radius;
    const s = (t - object.position) / half;
    const profile = lesionTaperProfile(s);
    const thickness = vesselRadius * (object.severity / 100) * profile;

    outerRadii.push(vesselRadius * outerRadiusFractionFor(profile));
    innerRadii.push(Math.max(vesselRadius * MIN_LUMEN_RADIUS_RATIO, vesselRadius - thickness));
  }

  const outer = buildTubeFromPoints(points, outerRadii, RADIAL_SEGMENTS, SMOOTHING_PASSES);
  const inner = buildTubeFromPoints(points, innerRadii, RADIAL_SEGMENTS, SMOOTHING_PASSES);

  // buildTubeFromPoints内部が使うのと全く同じ入力(points, SMOOTHING_PASSES)で
  // フレームを求めるため、決定的に同じ結果になり、キャップのリムはチューブ本体の
  // リムと寸分違わず一致する。
  const frame = computeTubeFrame(points, SMOOTHING_PASSES);
  const lastIndex = frame.points.length - 1;

  const outerCapStart = buildTubeEndDiscCap(frame.points[0], frame.tangents[0], frame.normals[0], outerRadii[0], true, RADIAL_SEGMENTS);
  const outerCapEnd = buildTubeEndDiscCap(
    frame.points[lastIndex],
    frame.tangents[lastIndex],
    frame.normals[lastIndex],
    outerRadii[outerRadii.length - 1],
    false,
    RADIAL_SEGMENTS,
  );
  const innerCapStart = buildTubeEndDiscCap(frame.points[0], frame.tangents[0], frame.normals[0], innerRadii[0], true, RADIAL_SEGMENTS);
  const innerCapEnd = buildTubeEndDiscCap(
    frame.points[lastIndex],
    frame.tangents[lastIndex],
    frame.normals[lastIndex],
    innerRadii[innerRadii.length - 1],
    false,
    RADIAL_SEGMENTS,
  );
  const annularCapStart = buildTubeEndAnnularCap(
    frame.points[0],
    frame.tangents[0],
    frame.normals[0],
    outerRadii[0],
    innerRadii[0],
    true,
    RADIAL_SEGMENTS,
  );
  const annularCapEnd = buildTubeEndAnnularCap(
    frame.points[lastIndex],
    frame.tangents[lastIndex],
    frame.normals[lastIndex],
    outerRadii[outerRadii.length - 1],
    innerRadii[innerRadii.length - 1],
    false,
    RADIAL_SEGMENTS,
  );

  const outerClosed = mergeIndexedGeometries([outer, outerCapStart, outerCapEnd]);
  const innerClosed = mergeIndexedGeometries([inner, innerCapStart, innerCapEnd]);
  const merged = mergeIndexedGeometries([outer, inner, annularCapStart, annularCapEnd]);
  return { merged, outer: outerClosed, inner: innerClosed };
}
