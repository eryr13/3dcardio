import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { CalcificationObject } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";
import { computeTubeFrame, mergeIndexedGeometries } from "./stentLatticeMesh";
import { narrowingProfile } from "./stenosisPlaqueMesh";

const ANGULAR_SEGMENTS = 28;
const SMOOTHING_PASSES = 24;

/** 石灰化率100%(厚み=血管半径と同じ量)でも内腔半径が0(縮退)にならないよう設ける下限。 */
const MIN_LUMEN_RADIUS_RATIO = 0.02;

/** angleSpanがこの値以上なら「全周性」とみなし、円周方向の端キャップを生成しない(継ぎ目なくループする)。 */
const FULL_CIRCLE_THRESHOLD_DEG = 359.9;

/**
 * angleSpanがこの値未満なら「石灰化なし」として空のジオメトリを返す。単純に
 * angleSpan=0で弧の生成をそのまま行うと、円周方向の角度幅は0でも外径・内径の
 * 半径差(厚み)だけは残るため、退化した薄い帯(1本の線)が見えてしまう
 * (実機検証で確認)。0度=完全に非表示、という要件を満たすため明示的に分岐する。
 */
const MIN_ANGLE_SPAN_DEG = 0.5;

/** 表面の不規則な凹凸の振幅(半径に対する比率)。オプションのリアルさ向上用。 */
const SURFACE_NOISE_AMPLITUDE = 0.06;

/** シード固定の疑似乱数(0〜1)。既存のステント/狭窄と同じハッシュ方式。 */
function hash(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function hashSeedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return h + 1;
}

interface ShellFrame {
  /** 平滑化済み中心線点 */
  points: Vector3[];
  /** 各点でのtangent */
  tangents: Vector3[];
  /** 回転最小化フレームのnormal */
  normals: Vector3[];
  /** normal×tangentから求めたbinormal */
  binormals: Vector3[];
  /**
   * 各点における「向き」の基準角(0度=心筋方向)。tangentに直交する平面へ
   * 心臓重心方向を射影し、(normal, binormal)基底での角度として求める。
   */
  referenceAngles: number[];
  /** 各点の局所血管半径 */
  vesselRadii: number[];
  /** 各点の長さ方向テーパー(区間中央で1、両端でほぼ0) */
  tapers: number[];
}

/**
 * 石灰化シェル生成に必要な共通フレーム(点列・tangent/normal/binormal・血管半径・
 * 心筋方向基準角・長さ方向テーパー)をまとめて1回だけ計算する。外径シェル・
 * 内腔減算用シェルの両方がこの同じフレームを共有することで、2つのシェルが
 * 常にぴったり同じ位置・向きに揃う。
 */
function buildShellFrame(
  centerline: CenterlinePoint[],
  object: CalcificationObject,
  heartCentroid: Vector3,
): ShellFrame {
  const half = Math.max(object.length / 2, 0.005);
  const tStart = Math.max(0, object.position - half);
  const tEnd = Math.min(1, object.position + half);
  const segmentCount = Math.max(16, Math.min(64, Math.round(object.length * 200)));

  const rawPoints: Vector3[] = [];
  const vesselRadii: number[] = [];
  const tapers: number[] = [];
  const heartDirs: Vector3[] = [];
  for (let i = 0; i <= segmentCount; i++) {
    const t = tStart + ((tEnd - tStart) * i) / segmentCount;
    const sample = sampleCenterline(centerline, t);
    rawPoints.push(sample.point);
    vesselRadii.push(sample.radius);
    const s = (t - object.position) / half;
    tapers.push(narrowingProfile(s));
    const dir = heartCentroid.clone().sub(sample.point);
    heartDirs.push(dir.lengthSq() > 1e-10 ? dir.normalize() : sample.tangent.clone());
  }

  const { points, tangents, normals } = computeTubeFrame(rawPoints, SMOOTHING_PASSES);

  const binormals: Vector3[] = [];
  const referenceAngles: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const N = normals[i];
    const T = tangents[i];
    const binormal = new Vector3().crossVectors(T, N).normalize();
    binormals.push(binormal);

    const heartDir = heartDirs[i];
    const proj = heartDir.clone().sub(T.clone().multiplyScalar(heartDir.dot(T)));
    if (proj.lengthSq() < 1e-10) {
      referenceAngles.push(i > 0 ? referenceAngles[i - 1] : 0);
    } else {
      proj.normalize();
      referenceAngles.push(Math.atan2(proj.dot(binormal), proj.dot(N)));
    }
  }

  return { points, tangents, normals, binormals, referenceAngles, vesselRadii, tapers };
}

/** 円周方向・長さ方向のグリッド状頂点群(radial grid)。grid[i][k]がi番目の断面のk番目の角度における頂点。 */
interface RadialGrid {
  positions: Vector3[][];
  normals: Vector3[][];
}

function buildRadialGrid(
  frame: ShellFrame,
  radii: number[],
  orientationRad: number,
  halfSpanRad: number,
  angularSegments: number,
  noiseSeed: number | null,
): RadialGrid {
  const n = frame.points.length;
  const positions: Vector3[][] = [];
  const normals: Vector3[][] = [];
  for (let i = 0; i < n; i++) {
    const N = frame.normals[i];
    const B = frame.binormals[i];
    const center = frame.referenceAngles[i] + orientationRad;
    const row: Vector3[] = [];
    const nrow: Vector3[] = [];
    for (let k = 0; k <= angularSegments; k++) {
      const a = center - halfSpanRad + (2 * halfSpanRad * k) / angularSegments;
      const dir = new Vector3(
        Math.cos(a) * N.x + Math.sin(a) * B.x,
        Math.cos(a) * N.y + Math.sin(a) * B.y,
        Math.cos(a) * N.z + Math.sin(a) * B.z,
      ).normalize();
      const noise = noiseSeed === null ? 1 : 1 + SURFACE_NOISE_AMPLITUDE * (hash(noiseSeed + i * 12.9 + k * 3.7) * 2 - 1);
      const r = radii[i] * noise;
      row.push(new Vector3(frame.points[i].x + dir.x * r, frame.points[i].y + dir.y * r, frame.points[i].z + dir.z * r));
      nrow.push(dir);
    }
    positions.push(row);
    normals.push(nrow);
  }
  return { positions, normals };
}

/** radial gridを標準的な四角形グリッドとして三角形分割する(buildTubeFromPointsと同じインデックス規則)。 */
function triangulateRadialGrid(grid: RadialGrid): BufferGeometry {
  const n = grid.positions.length;
  const segs = grid.positions[0].length - 1;
  const positions: number[] = [];
  const normalsOut: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < n; i++) {
    for (let k = 0; k <= segs; k++) {
      const p = grid.positions[i][k];
      const nn = grid.normals[i][k];
      positions.push(p.x, p.y, p.z);
      normalsOut.push(nn.x, nn.y, nn.z);
      uvs.push(i / Math.max(1, n - 1), k / segs);
    }
  }
  for (let i = 1; i < n; i++) {
    for (let k = 1; k <= segs; k++) {
      const a = (segs + 1) * (i - 1) + (k - 1);
      const b = (segs + 1) * i + (k - 1);
      const c = (segs + 1) * i + k;
      const d = (segs + 1) * (i - 1) + k;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normalsOut, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * 円周方向の端(k=0またはk=segs)で、外径グリッドと内径グリッドを結ぶ帯状の
 * 「切断面」ジオメトリを作る。全周性(isFullRing)の場合は継ぎ目が無いため呼ばれない。
 * マテリアルはDoubleSideを前提にしており、法線の向き(裏表)はここでは厳密に
 * 作り込まない(狭い帯であり、見た目への影響は軽微なため)。
 */
function buildCapStrip(outerGrid: RadialGrid, innerGrid: RadialGrid, kIndex: number): BufferGeometry {
  const n = outerGrid.positions.length;
  const positions: number[] = [];
  const normalsOut: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < n; i++) {
    const capNormal = outerGrid.normals[i][kIndex].clone().negate();
    const outerP = outerGrid.positions[i][kIndex];
    const innerP = innerGrid.positions[i][kIndex];
    positions.push(innerP.x, innerP.y, innerP.z, outerP.x, outerP.y, outerP.z);
    normalsOut.push(capNormal.x, capNormal.y, capNormal.z, capNormal.x, capNormal.y, capNormal.z);
    uvs.push(i / Math.max(1, n - 1), 0, i / Math.max(1, n - 1), 1);
  }
  for (let i = 1; i < n; i++) {
    const a = 2 * (i - 1);
    const b = 2 * (i - 1) + 1;
    const c = 2 * i + 1;
    const d = 2 * i;
    indices.push(a, b, c, a, c, d);
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normalsOut, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * outerRadii/innerRadiiで指定した2枚のアーク面(+全周でなければ円周方向の端2枚の
 * キャップ)を組み合わせ、1つの閉じたシェルジオメトリにする。長さ方向は
 * frame.tapersにより区間の両端でouterRadii≒innerRadiiに収束させておくことで、
 * 明示的な端キャップ無しに自然に閉じる(狭窄の実装と同じ考え方)。
 */
function buildShell(
  frame: ShellFrame,
  outerRadii: number[],
  innerRadii: number[],
  angleSpanRad: number,
  orientationRad: number,
  angularSegments: number,
  noiseSeed: number | null,
): BufferGeometry {
  const halfSpanRad = angleSpanRad / 2;
  const isFullRing = angleSpanRad >= (FULL_CIRCLE_THRESHOLD_DEG * Math.PI) / 180;

  const outerGrid = buildRadialGrid(frame, outerRadii, orientationRad, halfSpanRad, angularSegments, noiseSeed);
  const innerGrid = buildRadialGrid(frame, innerRadii, orientationRad, halfSpanRad, angularSegments, noiseSeed);

  const parts = [triangulateRadialGrid(outerGrid), triangulateRadialGrid(innerGrid)];
  if (!isFullRing) {
    parts.push(buildCapStrip(outerGrid, innerGrid, 0));
    parts.push(buildCapStrip(innerGrid, outerGrid, angularSegments));
  }
  return mergeIndexedGeometries(parts);
}

export interface CalcificationGeometries {
  /** メインビュー・シネスキーマ表示・シネX線の高吸収オブジェクトチャンネル用: 外側+内側成長分の完全なシェル */
  visual: BufferGeometry;
  /**
   * シネX線モードの血管アキュムレータ減算専用: 外径=血管本来の半径(成長前)、
   * 内径=内側成長後の内腔半径というシェル。外側への成長は内腔=造影剤の通り道と
   * 無関係なので、この「内側成長分だけ」を表す独立した閉じたシェルを血管アキュムレータへ
   * 符号反転(-1)で加算することで、内側への張り出し分だけを正しく差し引く
   * (外側への成長は一切差し引かれない)。可視化はされない。
   */
  lumenNarrowing: BufferGeometry;
}

/**
 * 石灰化を「血管壁に沿った、部分的な円弧状の肉厚を持つ筒(部分円筒シェル)」として
 * 生成する。ステント・狭窄と同じ sampleCenterline + computeTubeFrame の組み合わせを
 * 流用し、位置・長さの計算ロジックを共有する。
 *
 * 円周方向は angleSpan 度だけ、orientation(心筋方向=0度からの回転)を中心に生成する。
 * 「心筋方向」は、各中心線点から heartCentroid(心臓メッシュの重心、簡易近似) への
 * ベクトルを tangent に直交する平面へ射影し、そのオブジェクトのローカルフレーム
 * (normal, binormal) での角度として定義する。血管の走行に応じて滑らかに変化する。
 *
 * 厚み(thickness、局所血管半径に対する比率)は、血管壁を基準に外側・内側の両方に
 * 同じ量だけ成長させる。長さ方向は狭窄と同じガウス窓プロファイルで区間の両端に
 * 向かって厚みが0に収束するため、不自然な切断面ができない。
 */
export function buildCalcificationGeometry(
  centerline: CenterlinePoint[],
  object: CalcificationObject,
  heartCentroid: Vector3,
): CalcificationGeometries {
  const angleSpanDeg = Math.max(0, Math.min(360, object.angleSpan));
  if (angleSpanDeg < MIN_ANGLE_SPAN_DEG) {
    return { visual: new BufferGeometry(), lumenNarrowing: new BufferGeometry() };
  }

  const frame = buildShellFrame(centerline, object, heartCentroid);
  const n = frame.points.length;

  const angleSpanRad = (angleSpanDeg * Math.PI) / 180;
  const orientationRad = (object.orientation * Math.PI) / 180;
  const thicknessFraction = Math.max(0, object.thickness) / 100;

  const growthOuterRadii: number[] = [];
  const vesselRadii: number[] = [];
  const innerRadii: number[] = [];
  for (let i = 0; i < n; i++) {
    const R = frame.vesselRadii[i];
    const growth = R * thicknessFraction * frame.tapers[i];
    growthOuterRadii.push(R + growth);
    vesselRadii.push(R);
    innerRadii.push(Math.max(R * MIN_LUMEN_RADIUS_RATIO, R - growth));
  }

  const noiseSeed = hashSeedFromId(object.id);
  const visual = buildShell(frame, growthOuterRadii, innerRadii, angleSpanRad, orientationRad, ANGULAR_SEGMENTS, noiseSeed);
  const lumenNarrowing = buildShell(frame, vesselRadii, innerRadii, angleSpanRad, orientationRad, ANGULAR_SEGMENTS, null);
  return { visual, lumenNarrowing };
}
