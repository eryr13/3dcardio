import { BufferGeometry, Float32BufferAttribute, IcosahedronGeometry, Vector3 } from "three";
import type { CalcificationObject } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";

/** シード固定の疑似乱数(0〜1)。追加ライブラリなしで再現性のあるノイズを作るための単純なハッシュ。 */
function hash(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function hashSeedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100000;
  return h + 1;
}

/**
 * 石灰化プラークを、血管表面付近に貼り付く不規則な塊状メッシュとして生成する。
 * 低解像度の IcosahedronGeometry(分割0=12頂点/20面の素朴な多面体)をベースに
 * 各頂点をハッシュ乱数で凹凸変位させ、中心線に沿って severity に応じた個数
 * (2〜5個程度)のクラスタをランダム配置して単一の BufferGeometry にまとめる。
 * 血管の実メッシュとは独立したジオメトリなので、複数呼び出しても元の血管には
 * 一切影響しない。
 */
export function buildCalcificationMesh(centerline: CenterlinePoint[], object: CalcificationObject): BufferGeometry {
  const seedBase = hashSeedFromId(object.id);
  const blobCount = 2 + Math.floor((object.severity / 100) * 3);
  const half = Math.max(object.length / 2, 0.005);

  // 血管が分岐する付近では、中心線のY座標ビン分けによる推定(splitGeometryByLength と
  // 同じ簡易手法)が幹側・枝側の頂点を混同し、tがわずかに変わっただけで sample.point/radius/
  // tangent が大きく飛ぶことがある(実機検証で確認: 分岐付近にオブジェクトを置くと、ブロブごとに
  // 中心線を再サンプルする実装ではブロブの一部が本体から離れた場所に浮いて見えた)。
  // これを避けるため、中心線のサンプリングはオブジェクトの代表位置(object.position)1点だけで行い、
  // 各ブロブの分散はその1点のローカルフレーム(接線・法線面)内でのオフセットとして表現する
  // (中心線を分岐ごと跨いで再サンプルしない)。
  const baseSample = sampleCenterline(centerline, object.position);
  const arbitrary = Math.abs(baseSample.tangent.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const perp1 = new Vector3().crossVectors(baseSample.tangent, arbitrary).normalize();
  const perp2 = new Vector3().crossVectors(baseSample.tangent, perp1).normalize();

  const positions: number[] = [];

  for (let b = 0; b < blobCount; b++) {
    const seed = seedBase + b * 131.71;
    // 沿軸方向のブロブ分散は、中心線を再サンプルせず接線方向への直線オフセットで表現する。
    const axialOffset = (hash(seed) * 2 - 1) * half * 0.7;

    // 接線に垂直な面内で、疑似乱数の角度だけ回した方向を「血管表面から外向き」とみなす
    const angle = hash(seed + 3.3) * Math.PI * 2;
    const outward = perp1.clone().multiplyScalar(Math.cos(angle)).add(perp2.clone().multiplyScalar(Math.sin(angle)));

    const blobRadius = baseSample.radius * (0.35 + (object.severity / 100) * 0.5) * (0.7 + hash(seed + 5.1) * 0.6);
    // 血管表面あたりに中心を置く(半分埋まって半分外に飛び出すイメージ)
    const center = baseSample.point
      .clone()
      .add(baseSample.tangent.clone().multiplyScalar(axialOffset))
      .add(outward.multiplyScalar(baseSample.radius * 0.6));

    // IcosahedronGeometry は既定でインデックス付き(分割0=12頂点を20面で共有)。
    // ノイズ変位は「インデックス済みの一意な頂点」ごとに1回だけ計算し、そのあとで
    // インデックスバッファを辿って三角形に展開する。toNonIndexed() してから
    // 頂点ごとにノイズを掛けると、同じ位置を共有していたはずの三角形の角がそれぞれ
    // 別々にずれてしまい、面同士が繋がらずバラバラの板が浮いたような見た目になる
    // (実機検証で確認した不具合)。
    const blobGeometry = new IcosahedronGeometry(blobRadius, 0);
    const uniquePosition = blobGeometry.getAttribute("position");
    const displaced: Vector3[] = [];
    for (let v = 0; v < uniquePosition.count; v++) {
      const vx = uniquePosition.getX(v);
      const vy = uniquePosition.getY(v);
      const vz = uniquePosition.getZ(v);
      const noise = 0.7 + hash(seed + v * 7.13) * 0.6; // 0.7〜1.3倍でごつごつした凹凸を作る
      displaced.push(new Vector3(center.x + vx * noise, center.y + vy * noise, center.z + vz * noise));
    }
    const blobIndex = blobGeometry.getIndex();
    if (blobIndex) {
      for (let k = 0; k < blobIndex.count; k++) {
        const p = displaced[blobIndex.getX(k)];
        positions.push(p.x, p.y, p.z);
      }
    } else {
      for (const p of displaced) positions.push(p.x, p.y, p.z);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}
