import { BufferGeometry, Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import type { StenosisLesion } from "../../types/lesion";
import centerlineDataset from "../../data/centerlines.json";

export interface CenterlinePoint {
  /** ローカル座標系での中心線点 */
  position: Vector3;
  /** その断面でのおおよその半径(頂点群の重心からの平均距離) */
  radius: number;
  /**
   * 0=近位(起始部) 〜 1=遠位(末梢)。**正規化弧長**(中心線に沿った実際の3D距離の
   * 累積を全長で割った値)であり、配列インデックスの比率ではない。血管が鋭く
   * 曲がる区間ではインデックス1つ分に対応する実際の移動量が場所によって大きく
   * 異なるため、インデックス比率をそのままpositionパラメータとして扱うと、
   * position(%)と実際の3D座標の対応がズレる不具合があった(実機検証で確認:
   * 分岐部付近でクリック位置と対応するpositionが一致しなかった)。
   */
  t: number;
}

export interface CenterlineSample {
  point: Vector3;
  radius: number;
  tangent: Vector3;
}

interface RawCenterlinePoint {
  position: [number, number, number];
  radius: number;
  t: number;
}

const PRECOMPUTED_CENTERLINES = centerlineDataset as Record<VesselId, RawCenterlinePoint[]>;

/**
 * 血管ごとの中心線データを取得する。中心線は scripts/extract_centerlines.py により
 * オフラインで一度だけ生成した src/data/centerlines.json から読み込む(実行時計算はしない)。
 *
 * かつてはメッシュ頂点をローカルY座標でビン分けし、各ビンの頂点重心を中心線点とする
 * 「Yビン方式」をアプリ実行時に計算していたが、この方式は「血管がY軸方向におおむね
 * 直進している」ことを前提とするため、RCAのように房室溝に沿って心臓表面を大きく
 * 回り込む血管では根本的に破綻していた(実機検証で確認: 同一Yスライスに血管の
 * 往路・復路など空間的に無関係な頂点が混在し、それらの平均が血管の存在しない空間に
 * 出現していた)。extract_centerlines.py は血管メッシュを3Dボクセル化して内部を充填し、
 * skimage.morphology.skeletonize で走行方向に依存しないスケルトンを抽出、
 * グラフ化して本幹(側枝を除いた最長経路)だけを採用する方式に置き換えている。
 * GLBから直接ロードした同一メッシュをボクセル化しているため、血管メッシュの実際の
 * 描画座標と中心線データの座標系は自動的に一致する(座標変換は一切行わない)。
 */
export function getVesselCenterline(vesselId: VesselId): CenterlinePoint[] {
  const raw = PRECOMPUTED_CENTERLINES[vesselId];
  if (!raw) return [];
  return raw.map((p) => ({
    position: new Vector3(p.position[0], p.position[1], p.position[2]),
    radius: p.radius,
    t: p.t,
  }));
}

/**
 * 中心線上の任意のt(正規化弧長)における点・半径・接線方向を線形補間で取得する。
 * centerline[i].tはもはやインデックスに対して等間隔ではない(弧長ベースのため、
 * 血管が鋭く曲がる区間ではインデックス間隔が密になる)ので、tを挟む区間を
 * 二分探索で見つけてから補間する。
 */
export function sampleCenterline(centerline: CenterlinePoint[], t: number): CenterlineSample {
  const clamped = Math.min(1, Math.max(0, t));
  const n = centerline.length;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (centerline[mid].t <= clamped) lo = mid;
    else hi = mid;
  }

  const p0 = centerline[lo];
  const p1 = centerline[hi];
  const span = p1.t - p0.t;
  const frac = span > 1e-12 ? (clamped - p0.t) / span : 0;
  const point = p0.position.clone().lerp(p1.position, frac);
  const radius = p0.radius + (p1.radius - p0.radius) * frac;
  const tangent = p1.position.clone().sub(p0.position).normalize();
  return { point, radius, tangent };
}

/**
 * メッシュ頂点のローカルY座標比率(0=最高Y=近位 〜 1=最低Y=遠位)を、中心線の
 * 正規化弧長tへ変換する。中心線配列は等間隔弧長でリサンプリング済みのため、
 * yRatioを配列のインデックス位置として扱い、そのインデックス前後の(弧長ベースの)
 * tを線形補間する。
 * これにより、狭窄変形のガウス関数比較・sampleCenterline呼び出しの両方で
 * 一貫して弧長ベースのtを使えるようにする(片方だけインデックス比率のまま
 * 残すと、sampleCenterlineとの対応がズレるため)。
 */
function yRatioToArcT(centerline: CenterlinePoint[], yRatio: number): number {
  const n = centerline.length;
  const raw = Math.min(1, Math.max(0, yRatio)) * (n - 1);
  const i0 = Math.min(n - 2, Math.max(0, Math.floor(raw)));
  const i1 = i0 + 1;
  const frac = raw - i0;
  return centerline[i0].t + (centerline[i1].t - centerline[i0].t) * frac;
}

/**
 * 血管ジオメトリを複製し、指定した狭窄群に基づいて断面半径をガウス関数的に
 * 滑らかに絞る。共有GLBジオメトリを直接書き換えないよう必ず複製する
 * (attachProximityAttribute と同じ方針)。狭窄が無ければ複製せず元のジオメトリを
 * そのまま返す。
 */
export function applyStenosisDeformation(
  geometry: BufferGeometry,
  centerline: CenterlinePoint[],
  stenoses: StenosisLesion[],
): BufferGeometry {
  const visibleStenoses = stenoses.filter((s) => s.visible);
  if (visibleStenoses.length === 0) return geometry;

  const deformed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const position = deformed.getAttribute("position");

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const range = maxY - minY || 1;

  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const yRatio = (maxY - y) / range;
    const t = yRatioToArcT(centerline, yRatio);

    let narrowing = 1;
    for (const lesion of visibleStenoses) {
      const half = lesion.length / 2;
      const dt = t - lesion.position;
      if (Math.abs(dt) > half * 3 + 0.001) continue; // ガウス裾は概ね3σで打ち切り(性能対策)
      const sigma = Math.max(half / 2, 0.001);
      const gaussian = Math.exp(-(dt * dt) / (2 * sigma * sigma));
      const localNarrowing = 1 - (lesion.severity / 100) * gaussian;
      narrowing = Math.min(narrowing, localNarrowing);
    }

    if (narrowing >= 0.999) continue;

    const sample = sampleCenterline(centerline, t);
    const vx = position.getX(i);
    const vz = position.getZ(i);
    const nx = sample.point.x + (vx - sample.point.x) * narrowing;
    const nz = sample.point.z + (vz - sample.point.z) * narrowing;
    position.setXYZ(i, nx, y, nz);
  }

  position.needsUpdate = true;
  deformed.computeVertexNormals();
  return deformed;
}
