import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { CalcificationObject } from "../../types/object";
import { lesionTaperProfile } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";
import { computeTubeFrame, mergeIndexedGeometries, pushOrientedTriangle } from "./stentLatticeMesh";

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
  /**
   * 各点における軸方向のテーパー係数(0〜1、lesionTaperProfile)。区間中央80%で1
   * (厚みそのまま)、両端10%ずつのテーパーで0(厚みゼロ=血管本来の内腔)へなめらかに
   * 収束する。狭窄プラーク(stenosisPlaqueMesh.ts)・造影剤フローの通過係数
   * (utils/contrastFlow.tsのgetCalcificationRadiusFractionAt)と同じ関数を使うため、
   * 石灰化の見た目の内腔・造影剤フローが参照する内腔は常に一致する。
   */
  taperProfiles: number[];
}

/**
 * 石灰化シェル生成に必要な共通フレーム(点列・tangent/normal/binormal・血管半径・
 * 心筋方向基準角・軸方向テーパー係数)をまとめて1回だけ計算する。外径シェル・
 * 内腔減算用シェルの両方がこの同じフレームを共有することで、2つのシェルが常に
 * ぴったり同じ位置・向きに揃う。
 *
 * 狭窄と同じ台形状の軸方向テーパー(lesionTaperProfile)を厚みに適用する。区間の
 * 両端では厚みが自然に0(内径=外径=血管本来の半径)へ収束するため、buildShell側の
 * 端キャップ(longitudinal cap)は境界で幅ゼロとなり実質的に見えなくなる
 * (狭窄の環状キャップが区間境界で消えるのと同じ仕組み)。
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
  const taperProfiles: number[] = [];
  const heartDirs: Vector3[] = [];
  for (let i = 0; i <= segmentCount; i++) {
    const t = tStart + ((tEnd - tStart) * i) / segmentCount;
    const sample = sampleCenterline(centerline, t);
    rawPoints.push(sample.point);
    vesselRadii.push(sample.radius);
    taperProfiles.push(lesionTaperProfile((t - object.position) / half));
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

  return { points, tangents, normals, binormals, referenceAngles, vesselRadii, taperProfiles };
}

/**
 * 円周方向・長さ方向のグリッド状頂点群(radial grid)。grid[i][k]がi番目の断面のk番目の
 * 角度における頂点。normalsは常に「軸から離れる方向」(dir)を格納する生の値であり、
 * これをそのまま使うか反転するか(=表がdir方向/軸方向のどちらを向くか)はこのgridが
 * 外径・内径のどちらかによって異なる(triangulateRadialGridのfaceOutward引数参照)。
 */
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
      const r = radii[i];
      row.push(new Vector3(frame.points[i].x + dir.x * r, frame.points[i].y + dir.y * r, frame.points[i].z + dir.z * r));
      nrow.push(dir);
    }
    positions.push(row);
    normals.push(nrow);
  }
  return { positions, normals };
}

/**
 * radial gridを標準的な四角形グリッドとして三角形分割する。
 *
 * grid.normals(buildRadialGridが位置のオフセットにも使う「軸から離れる方向」dir)を
 * そのまま頂点法線として使えるのは、この面の実際に表を向けたい方向がdirと一致する
 * 場合(faceOutward=true、外径面: 血管壁に接する側が実体、軸から離れる向きが表)だけ。
 * 内径面(faceOutward=false)は実体が外径側(=大きい半径側)にあるため、表は逆に
 * 軸へ向かう向き(-dir)でなければならない——しかしa/b/c/dのインデックス規則
 * (four-quad→2triangle)自体は外径面・内径面で共通(同じ(i,k)格子構造を単に
 * 半径だけ変えて再利用するため)であり、素朴に同じ巻き順を使うと外径面・内径面の
 * 表が両方ともdir方向(同じ側)を向いてしまう——外径・内径という「入れ子の2枚の面」
 * では表裏が逆向きでなければ閉じた立体として正しく成立しない(実機検証で、
 * 外径面・内径面どちらの三角形もdirと逆向き=軸側を向いてしまっていることを確認:
 * このため深度ピールの前面/背面パスがどちらも「背面」側にしか分類されず、前面
 * 分(-viewZ)と背面分(+viewZ)が相殺されず単純加算されてしまい、実際の肉厚よりも
 * 桁違いに大きい光学的厚みになっていた——石灰化が吸収係数を下げても真っ黒に
 * 見え、輪郭も破綻していた根本原因)。
 * faceOutward=falseの場合は巻き順はそのまま(素の規則で既にdirと逆＝軸向きになる
 * ため反転不要)、法線属性だけ-dirへ反転する。faceOutward=trueの場合は巻き順を
 * 反転して表をdir向きにし、法線属性はdirのまま(既に向きが合っている)。
 */
function triangulateRadialGrid(grid: RadialGrid, faceOutward: boolean): BufferGeometry {
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
      normalsOut.push(faceOutward ? nn.x : -nn.x, faceOutward ? nn.y : -nn.y, faceOutward ? nn.z : -nn.z);
      uvs.push(i / Math.max(1, n - 1), k / segs);
    }
  }
  for (let i = 1; i < n; i++) {
    for (let k = 1; k <= segs; k++) {
      const a = (segs + 1) * (i - 1) + (k - 1);
      const b = (segs + 1) * i + (k - 1);
      const c = (segs + 1) * i + k;
      const d = (segs + 1) * (i - 1) + k;
      if (faceOutward) {
        indices.push(a, d, b, b, d, c);
      } else {
        indices.push(a, b, d, b, c, d);
      }
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
 * 目標法線は、外径グリッドの隣接角度列との差分ベクトル(=弧から離れる方向)を使う
 * (kIndex=0側は角度が1つ増える方向との差分、kIndex=segs側は1つ減る方向との差分を
 * 取ることで、いずれも「弧の外側」を向くベクトルになる)。
 */
function buildCircumferentialCap(outerGrid: RadialGrid, innerGrid: RadialGrid, kIndex: number): BufferGeometry {
  const n = outerGrid.positions.length;
  const kNeighbor = kIndex === 0 ? kIndex + 1 : kIndex - 1;
  const positions: number[] = [];
  const normalsOut: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 1; i < n; i++) {
    const awayDir = new Vector3().subVectors(outerGrid.positions[i][kIndex], outerGrid.positions[i][kNeighbor]);
    const desiredNormal = awayDir.lengthSq() > 1e-10 ? awayDir.normalize() : outerGrid.normals[i][kIndex];

    const outerA = outerGrid.positions[i - 1][kIndex];
    const outerB = outerGrid.positions[i][kIndex];
    const innerA = innerGrid.positions[i - 1][kIndex];
    const innerB = innerGrid.positions[i][kIndex];
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

/**
 * 長さ方向の端(i=0またはi=n-1)で、外径グリッドと内径グリッドを結ぶ環状(または
 * 弧状)の「端面キャップ」ジオメトリを作る。厚みは区間境界(i=0, i=n-1)で
 * lesionTaperProfileにより厳密に0へ収束する(外径=内径=血管本来の半径)ため、
 * このキャップ自体は幅ゼロの退化した面となり実質的に見えなくなる(狭窄の環状
 * キャップと同じ仕組み)。目標法線はtangent方向(iIndex=0側は近位方向=-tangent、
 * iIndex=n-1側は遠位方向=+tangent)。
 */
function buildLongitudinalCap(frame: ShellFrame, outerGrid: RadialGrid, innerGrid: RadialGrid, iIndex: number): BufferGeometry {
  const segs = outerGrid.positions[iIndex].length - 1;
  const positions: number[] = [];
  const normalsOut: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const desiredNormal = iIndex === 0 ? frame.tangents[iIndex].clone().negate() : frame.tangents[iIndex].clone();

  for (let k = 1; k <= segs; k++) {
    const outerA = outerGrid.positions[iIndex][k - 1];
    const outerB = outerGrid.positions[iIndex][k];
    const innerA = innerGrid.positions[iIndex][k - 1];
    const innerB = innerGrid.positions[iIndex][k];
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

/**
 * outerRadii/innerRadiiで指定した2枚のアーク面を、円周方向の端キャップ(全周で
 * なければ)・長さ方向の端キャップ(常に、区間境界でテーパーにより幅ゼロへ収束
 * するが、ジオメトリとしては常に生成する)で閉じ、1つの閉じたシェルジオメトリに
 * する。深度ピールのfront/backカリングが正しく機能するには、外径面・内径面・
 * 全キャップを含めた全体が「表が常に実体の外側を向く」向きで閉じた2-manifoldである
 * 必要がある。キャップはpushOrientedTriangleで巻き順を自動的に正しく揃えている一方、
 * 外径面・内径面(triangulateRadialGrid)は同じ(i,k)格子構造を共有するため、
 * faceOutward引数で明示的に互いに逆向きの表(外径=軸から離れる向き、内径=軸へ
 * 向かう向き)になるようにしている(この2枚を素朴に同じ巻き順で生成すると、
 * 「入れ子の2枚の面」として表裏が逆転してしまい、深度ピールの前面/背面が正しく
 * 相殺されず、実際の材質厚みよりも桁違いに大きい光学的厚みになる不具合があった)。
 *
 * 以前は表面にごく小さな凹凸ノイズ(±6%程度の半径ジッター)を掛けて石灰化らしい
 * 不整形さを表現していたが、シネX線モードの深度ピール(前面/背面深度差から厚みを
 * 求める)と組み合わせると、細かい凹凸ひとつひとつが独立した前面/背面の交差点を
 * 作ってしまい、本来1つの滑らかな影になるはずの部分が多数の小さな黒い斑点に
 * 分裂して見える不具合が実機検証で確認された。ブラー(mainImage側)で吸収できる
 * 程度を超えていたため、ノイズは廃止し、血管の自然なカーブに沿った滑らかな
 * シェル形状のみで「完全な円柱ではない不整形さ」を表現する方針にした。
 */
function buildShell(
  frame: ShellFrame,
  outerRadii: number[],
  innerRadii: number[],
  angleSpanRad: number,
  orientationRad: number,
  angularSegments: number,
): BufferGeometry {
  const halfSpanRad = angleSpanRad / 2;
  const isFullRing = angleSpanRad >= (FULL_CIRCLE_THRESHOLD_DEG * Math.PI) / 180;

  const outerGrid = buildRadialGrid(frame, outerRadii, orientationRad, halfSpanRad, angularSegments);
  const innerGrid = buildRadialGrid(frame, innerRadii, orientationRad, halfSpanRad, angularSegments);

  const parts = [
    triangulateRadialGrid(outerGrid, true),
    triangulateRadialGrid(innerGrid, false),
    buildLongitudinalCap(frame, outerGrid, innerGrid, 0),
    buildLongitudinalCap(frame, outerGrid, innerGrid, outerGrid.positions.length - 1),
  ];
  if (!isFullRing) {
    parts.push(buildCircumferentialCap(outerGrid, innerGrid, 0));
    parts.push(buildCircumferentialCap(outerGrid, innerGrid, angularSegments));
  }
  return mergeIndexedGeometries(parts);
}

export interface CalcificationGeometries {
  /** メインビュー・シネスキーマ表示・シネX線の高吸収オブジェクトチャンネル用シェル */
  visual: BufferGeometry;
  /**
   * シネX線モードの血管アキュムレータ減算専用: 外径=血管本来の半径、内径=内腔方向へ
   * 成長した後の内腔半径というシェル。この「内腔方向への張り出し分だけ」を表す
   * 独立した閉じたシェルを血管アキュムレータへ符号反転(-1)で加算することで、
   * 内側への張り出し分だけを正しく差し引く。可視化はされない。
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
 * 厚み(thickness、局所血管半径に対する比率)は狭窄と同じ考え方で、外径(血管壁に
 * 接する側、厚みを変えても変化しない)を基準に内腔方向だけへ成長させる
 * (内径 = 外径 - 厚み)。長さ方向は狭窄と同じ台形状のテーパー(lesionTaperProfile、
 * 区間中央80%が最も厚いプラトー、両端10%ずつがなめらかな入口/出口テーパー)を
 * 厚みに適用し、区間境界では厚みが0(内径=外径=血管本来の半径)に収束する。
 * 円周方向は angleSpan/orientation による部分的な弧のまま(この軸方向テーパーの
 * 影響を受けない)なので、「円周方向は部分的、軸方向はなだらかにテーパー」という
 * 形状になる。造影剤フロー(utils/contrastFlow.tsのgetCalcificationRadiusFractionAt)も
 * 同じlesionTaperProfileを使うため、石灰化の内腔の見た目と造影剤フローが参照する
 * 内腔は常に一致する。
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

  const vesselRadii: number[] = [];
  const innerRadii: number[] = [];
  for (let i = 0; i < n; i++) {
    const R = frame.vesselRadii[i];
    const growth = R * thicknessFraction * frame.taperProfiles[i];
    vesselRadii.push(R);
    innerRadii.push(Math.max(R * MIN_LUMEN_RADIUS_RATIO, R - growth));
  }

  // 可視化用(visual)と内腔減算用(lumenNarrowing)は全く同じ外径・内径・角度範囲の
  // シェルなので(以前は表面ノイズの有無だけが違ったが、そのノイズ自体を廃止した
  // ため)、1回だけ生成して同じジオメトリを両方の用途に使い回す。
  const shell = buildShell(frame, vesselRadii, innerRadii, angleSpanRad, orientationRad, ANGULAR_SEGMENTS);
  return { visual: shell, lumenNarrowing: shell };
}
