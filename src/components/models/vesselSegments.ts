import { BufferGeometry, Float32BufferAttribute } from "three";
import type { VesselId, VesselState } from "../../types/anatomy";

export interface SegmentDef {
  id: string;
  name: string;
  parentVessel: VesselId;
}

/**
 * 各主幹をいくつのセグメントに分けるか、およびその仮の名称(近位/中間/遠位)。
 * 実際のAHA分類の解剖学的境界データは持っていないため、幹の長さ方向に機械的に
 * 等分しているだけの概算。番号もAHA分類に近いものを仮に割り当てている。
 */
export const SEGMENT_DEFS: Record<VesselId, SegmentDef[]> = {
  RCA: [
    { id: "RCA-1", name: "RCA #1 近位部(概算)", parentVessel: "RCA" },
    { id: "RCA-2", name: "RCA #2 中間部(概算)", parentVessel: "RCA" },
    { id: "RCA-3", name: "RCA #3 遠位部(概算)", parentVessel: "RCA" },
  ],
  LAD: [
    { id: "LAD-1", name: "LAD #6 近位部(概算)", parentVessel: "LAD" },
    { id: "LAD-2", name: "LAD #7 中間部(概算)", parentVessel: "LAD" },
    { id: "LAD-3", name: "LAD #8 遠位部(概算)", parentVessel: "LAD" },
  ],
  LCX: [
    { id: "LCX-1", name: "LCX #11 近位部(概算)", parentVessel: "LCX" },
    { id: "LCX-2", name: "LCX #12 中間部(概算)", parentVessel: "LCX" },
    { id: "LCX-3", name: "LCX #13 遠位部(概算)", parentVessel: "LCX" },
  ],
};

export function buildSegmentVesselStates(): Record<string, VesselState> {
  const defaultColor: Record<VesselId, string> = { RCA: "#3d8bfd", LAD: "#3ddc84", LCX: "#f7b731" };
  const result: Record<string, VesselState> = {};
  for (const trunkId of Object.keys(SEGMENT_DEFS) as VesselId[]) {
    for (const def of SEGMENT_DEFS[trunkId]) {
      result[def.id] = {
        id: def.id,
        name: def.name,
        parentVessel: def.parentVessel,
        visible: true,
        color: defaultColor[trunkId],
        opacity: 1,
      };
    }
  }
  return result;
}

/**
 * 主幹メッシュのジオメトリを、ローカルY座標(心基部側=近位 → 心尖側=遠位)に沿って
 * 三角形単位で N 分割する。解剖学的なランドマークではなく機械的な等間隔分割。
 */
export function splitGeometryByLength(source: BufferGeometry, segmentCount: number): BufferGeometry[] {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const triangleCount = position.count / 3;

  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const range = maxY - minY || 1;

  const buckets: { positions: number[]; normals: number[] }[] = Array.from({ length: segmentCount }, () => ({
    positions: [],
    normals: [],
  }));

  for (let t = 0; t < triangleCount; t++) {
    const i0 = t * 3;
    const i1 = t * 3 + 1;
    const i2 = t * 3 + 2;
    const centroidY = (position.getY(i0) + position.getY(i1) + position.getY(i2)) / 3;
    // 近位(高いY、心基部側)がセグメント#1になるよう降順にビン分けする
    const raw = ((maxY - centroidY) / range) * segmentCount;
    const bin = Math.min(segmentCount - 1, Math.max(0, Math.floor(raw)));
    const bucket = buckets[bin];
    for (const i of [i0, i1, i2]) {
      bucket.positions.push(position.getX(i), position.getY(i), position.getZ(i));
      if (normal) bucket.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
  }

  return buckets.map((bucket) => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(bucket.positions, 3));
    if (bucket.normals.length === bucket.positions.length) {
      g.setAttribute("normal", new Float32BufferAttribute(bucket.normals, 3));
    } else {
      g.computeVertexNormals();
    }
    return g;
  });
}
