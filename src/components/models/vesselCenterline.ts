import { BufferGeometry, Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import type { StenosisLesion } from "../../types/lesion";
import type { VesselGraph } from "./vesselGraph";
import { getMainTrunk, getVesselGraph } from "./vesselGraph";

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

/**
 * 血管の本幹の中心線データを取得する。中心線グラフ(本幹+側枝)は
 * scripts/extract_centerlines.py がオフラインで一度だけ生成した
 * src/data/centerlines.json から読み込む(実行時計算はしない、詳細は vesselGraph.ts 参照)。
 * 病変を特定の枝(本幹/側枝)に配置する必要がある箇所では、この関数ではなく
 * vesselGraph.ts の getVesselGraph/getBranch を直接使うこと。
 */
export function getVesselCenterline(vesselId: VesselId): CenterlinePoint[] {
  return getMainTrunk(getVesselGraph(vesselId)).points;
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
 * 血管ジオメトリを複製し、指定した狭窄群に基づいて断面半径をガウス関数的に
 * 滑らかに絞る。共有GLBジオメトリを直接書き換えないよう必ず複製する
 * (attachProximityAttribute と同じ方針)。狭窄が無ければ複製せず元のジオメトリを
 * そのまま返す。
 *
 * 各頂点は、その頂点に最も近い点を持つ枝(本幹または側枝)に属するとみなし、
 * その枝上の最近傍点のtをもとに狭窄の重なりを判定する(かつてはメッシュ頂点の
 * ローカルY座標比率から中心線tを近似していたが、中心線がグラフ構造化された
 * ことで単一の枝に対応しなくなったため、実際の3D最近傍探索に置き換えた。
 * 中心線がグラフになる前から残っていたY比率近似より正確になる副次効果もある)。
 */
export function applyStenosisDeformation(
  geometry: BufferGeometry,
  graph: VesselGraph,
  stenoses: StenosisLesion[],
): BufferGeometry {
  const visibleStenoses = stenoses.filter((s) => s.visible);
  if (visibleStenoses.length === 0) return geometry;

  const targetBranchIds = new Set(visibleStenoses.map((s) => s.branchId));
  const targetBranches = graph.branches.filter((b) => targetBranchIds.has(b.id));
  if (targetBranches.length === 0) return geometry;

  const deformed = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const position = deformed.getAttribute("position");
  const vertex = new Vector3();

  for (let i = 0; i < position.count; i++) {
    vertex.set(position.getX(i), position.getY(i), position.getZ(i));

    let nearestBranchId: string | null = null;
    let nearestT = 0;
    let nearestDistSq = Infinity;
    for (const branch of targetBranches) {
      for (const p of branch.points) {
        const d = p.position.distanceToSquared(vertex);
        if (d < nearestDistSq) {
          nearestDistSq = d;
          nearestBranchId = branch.id;
          nearestT = p.t;
        }
      }
    }
    if (!nearestBranchId) continue;

    let narrowing = 1;
    for (const lesion of visibleStenoses) {
      if (lesion.branchId !== nearestBranchId) continue;
      const half = lesion.length / 2;
      const dt = nearestT - lesion.position;
      if (Math.abs(dt) > half * 3 + 0.001) continue; // ガウス裾は概ね3σで打ち切り(性能対策)
      const sigma = Math.max(half / 2, 0.001);
      const gaussian = Math.exp(-(dt * dt) / (2 * sigma * sigma));
      const localNarrowing = 1 - (lesion.severity / 100) * gaussian;
      narrowing = Math.min(narrowing, localNarrowing);
    }

    if (narrowing >= 0.999) continue;

    const branch = targetBranches.find((b) => b.id === nearestBranchId)!;
    const sample = sampleCenterline(branch.points, nearestT);
    const nx = sample.point.x + (vertex.x - sample.point.x) * narrowing;
    const nz = sample.point.z + (vertex.z - sample.point.z) * narrowing;
    position.setXYZ(i, nx, vertex.y, nz);
  }

  position.needsUpdate = true;
  deformed.computeVertexNormals();
  return deformed;
}
