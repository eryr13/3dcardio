// Phase 8: 心筋灌流領域の計算(どの心筋領域をどの血管の枝が灌流するか)と、
// Phase 7の造影剤フロー(到達濃度上限)を使った虚血の可視化。
//
// 灌流領域の割り当ては、心臓メッシュの各頂点を「最も近い冠動脈の枝上の点」に割り当てる
// 最近傍法(ユークリッド距離)で行う。測地距離(心臓表面に沿った距離)の方が解剖学的には
// 正確だが、以下の理由でまずユークリッド距離を採用する:
// - 冠動脈は心外膜表面の解剖学的な溝(前後の心室間溝・房室溝)を走行しており、実際の
//   灌流領域の境界もほぼこの溝に沿う。母点(中心線上の点)自体がその溝上にあるため、
//   心臓のようなおおむね凸型の形状では、ユークリッド距離でも境界が溝付近に落ち着きやすい。
// - 測地距離はメッシュの隣接グラフ上での多始点最短路計算が必要で実装が重くなる。
// 既知の限界: 心基部付近など、壁を挟んで表と裏が3D距離的に近い部分では、表面沿いの
// 距離と逆転する可能性がある(将来、目視で問題が見つかれば測地距離版への切り替えを検討)。
//
// 各枝への割り当ては、枝の点列を「点群」として扱い最近傍点までのユークリッド距離で行う
// (枝は既に十分密にサンプリングされているため、線分への投影は行わない)。

import { Color } from "three";
import type { BufferAttribute, BufferGeometry } from "three";
import type { VesselId } from "../../types/anatomy";
import type { CardioObject } from "../../types/object";
import type { PerfusionMode } from "../../types/perfusion";
import { computeArrivalTables, getCeilingAt } from "../../utils/contrastFlow";
import type { VesselGraph } from "./vesselGraph";

/**
 * 心臓メッシュの各頂点(vertexCount個)を、どの血管の枝が灌流するかに割り当てた結果。
 * 心臓メッシュ・血管グラフが変わらない限り不変なので、1回計算すれば使い回せる
 * (狭窄・石灰化を変更しても再計算不要。変わるのはbranchAdequacyByIdの方だけ)。
 */
export interface HeartPerfusionTerritory {
  vertexCount: number;
  /** 頂点ごとの、最も近い枝のbranchIds配列上のインデックス。 */
  branchIndexByVertex: Int16Array;
  /** 枝ID(vesselGraph.tsの命名規則により血管間で衝突しないグローバルに一意な文字列)。 */
  branchIds: string[];
  /** branchIdsと同じ並びの、各枝が属する血管ID(テリトリー表示の色に使う)。 */
  vesselIdByBranchIndex: VesselId[];
}

/**
 * 1枝あたりの母点数の上限。中心線は本幹で40点前後まであるが、枝の形状を捉えるのに
 * それほど密なサンプリングは要らない(領域境界は枝のおおまかな経路で決まる)ため、
 * 等間隔に間引く。実測(心臓メッシュ約23000頂点、全枝の点を間引かず総当たり
 * 探索した場合)で1回あたり1.5秒を超え、UIが目に見えて固まってしまったため導入した。
 */
const MAX_SEED_POINTS_PER_BRANCH = 12;

function subsamplePoints<T>(points: T[], maxCount: number): T[] {
  if (points.length <= maxCount) return points;
  const result: T[] = [];
  for (let i = 0; i < maxCount; i++) {
    const index = Math.round((i * (points.length - 1)) / (maxCount - 1));
    result.push(points[index]);
  }
  return result;
}

/** 3次元点群に対する最近傍探索用のk-d木(軸を深さに応じてx→y→z→x…と巡回して分割)。 */
interface KdNode {
  seedIndex: number;
  axis: 0 | 1 | 2;
  left: KdNode | null;
  right: KdNode | null;
}

function buildKdTree(
  indices: number[],
  xs: Float32Array,
  ys: Float32Array,
  zs: Float32Array,
  depth: number,
): KdNode | null {
  if (indices.length === 0) return null;
  const axis = (depth % 3) as 0 | 1 | 2;
  const coord = axis === 0 ? xs : axis === 1 ? ys : zs;
  indices.sort((a, b) => coord[a] - coord[b]);
  const mid = indices.length >> 1;
  return {
    seedIndex: indices[mid],
    axis,
    left: buildKdTree(indices.slice(0, mid), xs, ys, zs, depth + 1),
    right: buildKdTree(indices.slice(mid + 1), xs, ys, zs, depth + 1),
  };
}

/** 見つかった最近傍を使い回すためのミュータブルな作業用オブジェクト(探索のたびに新規オブジェクトを割り当てないため)。 */
interface NearestSearchState {
  seedIndex: number;
  distSq: number;
}

function searchKdTree(
  node: KdNode | null,
  x: number,
  y: number,
  z: number,
  xs: Float32Array,
  ys: Float32Array,
  zs: Float32Array,
  state: NearestSearchState,
): void {
  if (!node) return;
  const nx = xs[node.seedIndex];
  const ny = ys[node.seedIndex];
  const nz = zs[node.seedIndex];
  const dx = x - nx;
  const dy = y - ny;
  const dz = z - nz;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq < state.distSq) {
    state.distSq = distSq;
    state.seedIndex = node.seedIndex;
  }

  const queryCoord = node.axis === 0 ? x : node.axis === 1 ? y : z;
  const nodeCoord = node.axis === 0 ? nx : node.axis === 1 ? ny : nz;
  const diff = queryCoord - nodeCoord;
  const nearSide = diff < 0 ? node.left : node.right;
  const farSide = diff < 0 ? node.right : node.left;
  searchKdTree(nearSide, x, y, z, xs, ys, zs, state);
  // 分割軸までの距離がこれまでの最良距離より近ければ、反対側にもっと近い点がある
  // 可能性が残るため、その場合だけ探索する(k-d木の枝刈り)。
  if (diff * diff < state.distSq) {
    searchKdTree(farSide, x, y, z, xs, ys, zs, state);
  }
}

/**
 * 心臓メッシュの各頂点を最も近い冠動脈の枝に割り当てる(ユークリッド距離の最近傍法)。
 * 母点(全血管・全枝の中心線上の間引き済み点)からk-d木を構築し、心臓メッシュの
 * 各頂点についてO(log n)程度で最近傍を探す(実測: 素朴な総当たりでは心臓メッシュ
 * 約23000頂点×母点約1500個で1.5秒以上かかりUIが固まったため、母点の間引き
 * (MAX_SEED_POINTS_PER_BRANCH)とk-d木の両方で高速化している)。
 */
export function computeHeartPerfusionTerritory(
  heartGeometry: BufferGeometry,
  graphs: Map<VesselId, VesselGraph>,
): HeartPerfusionTerritory {
  const branchIds: string[] = [];
  const vesselIdByBranchIndex: VesselId[] = [];
  const seedXList: number[] = [];
  const seedYList: number[] = [];
  const seedZList: number[] = [];
  const seedBranchIndexList: number[] = [];

  for (const [vesselId, graph] of graphs) {
    for (const branch of graph.branches) {
      if (branch.points.length === 0) continue;
      const branchIndex = branchIds.length;
      branchIds.push(branch.id);
      vesselIdByBranchIndex.push(vesselId);
      for (const p of subsamplePoints(branch.points, MAX_SEED_POINTS_PER_BRANCH)) {
        seedXList.push(p.position.x);
        seedYList.push(p.position.y);
        seedZList.push(p.position.z);
        seedBranchIndexList.push(branchIndex);
      }
    }
  }

  const seedCount = seedXList.length;
  const seedXs = new Float32Array(seedXList);
  const seedYs = new Float32Array(seedYList);
  const seedZs = new Float32Array(seedZList);
  const tree = buildKdTree([...Array(seedCount).keys()], seedXs, seedYs, seedZs, 0);

  const posAttr = heartGeometry.getAttribute("position") as BufferAttribute;
  const vertexCount = posAttr.count;
  const branchIndexByVertex = new Int16Array(vertexCount);
  const searchState: NearestSearchState = { seedIndex: 0, distSq: Infinity };

  for (let i = 0; i < vertexCount; i++) {
    const x = posAttr.getX(i);
    const y = posAttr.getY(i);
    const z = posAttr.getZ(i);
    searchState.seedIndex = 0;
    searchState.distSq = Infinity;
    searchKdTree(tree, x, y, z, seedXs, seedYs, seedZs, searchState);
    branchIndexByVertex[i] = seedBranchIndexList[searchState.seedIndex];
  }

  return { vertexCount, branchIndexByVertex, branchIds, vesselIdByBranchIndex };
}

/**
 * 各枝の「灌流の充足度」(0〜1、1=正常灌流、0=完全に血流が届かない=梗塞相当)を、
 * Phase 7の到達濃度上限(ceiling)から求める。ceilingは起始部からその枝までの経路上に
 * ある狭窄・石灰化の影響を既に織り込んでおり、かつ枝内で単調非増加(一度絞られた
 * 流量はその先で回復しない設計、utils/contrastFlow.ts参照)であるため、枝の末端
 * (t=1)のceilingがその枝全体(=その枝が灌流する領域全体)の充足度を代表する値になる。
 * baseSpeed等の再生パラメータはceilingの値に影響しない(伝播速度・到達時刻にのみ
 * 影響する)ため、常定数のデフォルトパラメータで計算してよい。
 */
export function computeBranchAdequacy(
  graphs: Map<VesselId, VesselGraph>,
  objects: CardioObject[],
): Map<string, number> {
  const adequacyByBranchId = new Map<string, number>();
  for (const [vesselId, graph] of graphs) {
    const tables = computeArrivalTables(graph, objects, vesselId);
    for (const branch of graph.branches) {
      adequacyByBranchId.set(branch.id, getCeilingAt(tables.get(branch.id), 1));
    }
  }
  return adequacyByBranchId;
}

/**
 * 虚血ヒートマップの配色。解剖標本のような落ち着いた見た目を狙い、彩度・明度とも
 * 低め(くすんだ色)に抑える。色相は充足度1.0(正常)の落ち着いた緑(黄緑寄りの
 * セージグリーン、110°)から、0(梗塞)のくすんだ赤茶色(18°)まで直線補間する
 * (0°の純粋な赤や60°の明るい黄色までは振らないことで、途中で不自然に鮮やかな
 * オレンジ/黄色を経由しないようにしている)。
 */
const ISCHEMIA_HUE_NORMAL_DEG = 110;
const ISCHEMIA_HUE_INFARCT_DEG = 18;
const ISCHEMIA_SATURATION_NORMAL = 0.32;
const ISCHEMIA_SATURATION_INFARCT = 0.42;
/** 梗塞側ほど暗く(明度を下げる)して「暗い赤茶色」の見た目に近づける。 */
const ISCHEMIA_LIGHTNESS_INFARCT = 0.22;
const ISCHEMIA_LIGHTNESS_NORMAL = 0.36;

function ischemiaColor(adequacy: number): Color {
  const a = Math.max(0, Math.min(1, adequacy));
  const hueDeg = ISCHEMIA_HUE_INFARCT_DEG + (ISCHEMIA_HUE_NORMAL_DEG - ISCHEMIA_HUE_INFARCT_DEG) * a;
  const saturation = ISCHEMIA_SATURATION_INFARCT + (ISCHEMIA_SATURATION_NORMAL - ISCHEMIA_SATURATION_INFARCT) * a;
  const lightness = ISCHEMIA_LIGHTNESS_INFARCT + (ISCHEMIA_LIGHTNESS_NORMAL - ISCHEMIA_LIGHTNESS_INFARCT) * a;
  return new Color().setHSL(hueDeg / 360, saturation, lightness);
}

/**
 * 各頂点の色(Float32Array、RGB×vertexCount)を計算する。枝ごとに1回だけ色を決めてから
 * 頂点へ配るため、頂点数が多くても色計算(HSL変換等)自体は枝数分(数十回)で済む。
 *
 * - "territory": その枝が属する血管の現在の表示色(色ピッカーと連動、vesselColors参照)。
 * - "ischemia": その枝の充足度(adequacyByBranchId、無ければ正常=1として扱う)による
 *   ヒートマップ色。
 */
export function buildPerfusionColors(
  territory: HeartPerfusionTerritory,
  mode: Exclude<PerfusionMode, "off">,
  vesselColors: Record<VesselId, string>,
  adequacyByBranchId: Map<string, number> | null,
): Float32Array {
  const branchColors: Color[] = territory.branchIds.map((branchId, i) => {
    if (mode === "territory") {
      return new Color(vesselColors[territory.vesselIdByBranchIndex[i]]);
    }
    const adequacy = adequacyByBranchId?.get(branchId) ?? 1;
    return ischemiaColor(adequacy);
  });

  const colors = new Float32Array(territory.vertexCount * 3);
  for (let i = 0; i < territory.vertexCount; i++) {
    const c = branchColors[territory.branchIndexByVertex[i]];
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  return colors;
}
