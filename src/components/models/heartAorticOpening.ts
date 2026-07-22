// 心筋メッシュ(heart-realistic.glb)に実在する、大動脈弁輪・左室流出路にあたる開口部
// (セグメンテーション由来——この領域は心筋組織として再構成されておらず、心筋メッシュの
// 表面が凹んだ「井戸」のような形になっている)を、レイキャストで実測する。
//
// aorticRootMesh.tsのcomputeAorticRootFrameは、これまで冠動脈入口部(RCA/LAD/LCX)の
// 実座標からの幾何学的な逆算のみで大動脈基部の中心位置を決め、中心軸の向きは常に
// 解剖座標系の頭側方向(0,1,0)に固定していたが、これは心筋メッシュ自体の形状とは
// 無関係な独立した推定値だった。この開口部の実測位置・実測した心臓の長軸(心尖部から
// この開口部へ向かう実際の方向)を基準として使うことで、大動脈基部の可視化ジオメトリの
// 位置・向きが心筋メッシュの継ぎ目(実際に組織が途切れている場所)によりよく一致する
// ようにする。
//
// 実測(heart-realistic.glbに対する検証): 心尖部(心筋メッシュの最も足側の頂点)から
// 冠動脈入口部の弦当てはめ中心へ向かう方向は、世界座標の鉛直方向(0,1,0)から約20°
// 傾いている——heart-realistic.glbの心臓モデル自体が世界座標に対してわずかに傾いた
// 姿勢で配置されているため。中心軸を鉛直に固定したままだと、大動脈基部の管が心筋
// 組織の実際の向きとずれた角度で突き刺さるように見える(ユーザー報告により発覚)。

import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from "three";

export interface DetectedAorticOpening {
  /** 開口部の輪郭(輪状にレイキャストしたリング点列)の重心。 */
  center: Vector3;
  /** 中心からリング点列までの平均距離。実際の形は円ではなく角度により変動するため、
   * あくまで平均的な太さの目安(computeAorticRootFrameは位置の基準としてのみ使い、
   * 半径そのものは従来通りheartWidthベースの計算を使う)。 */
  radius: number;
  /** 開口部の輪郭点列(ワールド座標、角度順)そのもの。aorticRootMesh.tsの
   * buildContourCollarRingが、大動脈基部の可視化ジオメトリの断面をこの実際の
   * 輪郭形状に近づけるために使う。 */
  contour: Vector3[];
  /** 心臓メッシュの実際の長軸(心尖部からこの開口部の中心へ向かう単位ベクトル)。
   * aorticRootMesh.tsのAorticRootFrame.axisに使う——世界座標の鉛直方向(0,1,0)固定
   * だった従来の簡略化を置き換え、心臓メッシュ自体が世界座標に対して傾いている場合に
   * それへ追従する。 */
  axis: Vector3;
}

/** axisに垂直な断面基準軸(u, v)を求める。aorticRootMesh.tsのcomputeCrossSectionBasisと
 * 同じ計算だが、あちらをそのままimportすると循環参照になる(aorticRootMesh.tsが
 * このファイルの型を既にimportしているため)ため、このファイル専用に複製する
 * (放射方向のサンプリング点を、axisに垂直な平面上に正しく配置するためだけの用途で、
 * 変更頻度が低い純粋な幾何計算のため複製のコストは小さいと判断)。 */
function computeCrossSectionBasis(axis: Vector3): { u: Vector3; v: Vector3 } {
  let u = new Vector3(1, 0, 0).addScaledVector(axis, -axis.dot(new Vector3(1, 0, 0)));
  if (u.lengthSq() < 1e-8) u = new Vector3(0, 0, 1).addScaledVector(axis, -axis.dot(new Vector3(0, 0, 1)));
  u.normalize();
  const v = new Vector3().crossVectors(u, axis).normalize();
  return { u, v };
}

/**
 * 心臓メッシュの心尖部(最も足側の頂点)をワールド座標で返す。頂点を総当たりで
 * 走査するだけの軽い処理(レイキャスト不要)。心臓の長軸(computeHeartLongAxis参照)の
 * 起点として使う。
 */
function findApex(heartMesh: Mesh): Vector3 {
  const posAttr = heartMesh.geometry.attributes.position;
  const local = new Vector3();
  const world = new Vector3();
  let apex = new Vector3(0, Infinity, 0);
  for (let i = 0; i < posAttr.count; i++) {
    local.fromBufferAttribute(posAttr, i);
    world.copy(local);
    heartMesh.localToWorld(world);
    if (world.y < apex.y) apex.copy(world);
  }
  return apex;
}

/**
 * 心臓メッシュの実際の長軸(心尖部から基準点approxCenterへ向かう単位ベクトル)を
 * 実測する。heart-realistic.glbでは世界座標の鉛直方向から約20°傾いている(ファイル
 * 冒頭のコメント参照)。心尖部の検出に失敗した場合(心尖部とapproxCenterがほぼ同じ
 * 位置にある等)は、従来通りの鉛直方向(0,1,0)にフォールバックする。
 */
export function computeHeartLongAxis(heartMesh: Mesh, approxCenter: Vector3): Vector3 {
  heartMesh.updateWorldMatrix(true, false);
  const apex = findApex(heartMesh);
  const offset = approxCenter.clone().sub(apex);
  if (offset.lengthSq() < 1e-8) return new Vector3(0, 1, 0);
  return offset.normalize();
}

/** 検索対象を近傍の三角形だけに絞り込む半径(heartScaleに対する比率)。全三角形に対して
 * 毎回レイキャストすると1回あたり数秒かかり実用にならないため、事前にapproxCenter近傍の
 * 三角形だけを抽出した小さなジオメトリを作ってからレイキャストする。 */
const FILTER_RADIUS_SCALE = 0.28;
/** 開口部の輪郭を探す放射方向の探索範囲(heartScaleに対する比率)。approxCenterが
 * 実際の開口部の中心に近いことを前提に、この範囲内で二分探索する。 */
const SEARCH_MAX_RADIUS_SCALE = 0.22;
const SEARCH_MIN_RADIUS_SCALE = 0.008;
/** 「開口部の内側(心筋が無い)」と「心筋の外側表面」を区別する、axis方向のしきい値
 * (approxCenterからaxisの逆方向へのオフセット、heartScaleに対する比率)。 */
const SURFACE_HEIGHT_OFFSET_SCALE = 0.1;
/** 輪郭を何方向サンプリングするか。 */
const ANGLE_SAMPLES = 24;
/** 各方向で輪郭の半径を絞り込む二分探索の反復回数。 */
const BINARY_SEARCH_ITERATIONS = 8;

/**
 * approxCenter近傍にある三角形だけを抽出した、レイキャスト専用の軽量メッシュを作る。
 * 心臓メッシュ全体(数万三角形)に対して毎回レイキャストすると遅すぎるため
 * (実測: 全三角形対象だと1回の検出に3秒以上かかる)、事前にこの絞り込みを行う。
 */
function buildLocalRaycastMesh(heartMesh: Mesh, approxCenter: Vector3, filterRadius: number): Mesh | null {
  const geometry = heartMesh.geometry;
  const posAttr = geometry.attributes.position;
  if (!posAttr) return null;
  const index = geometry.index;
  const idxArray = index ? index.array : null;
  const triCount = idxArray ? idxArray.length / 3 : posAttr.count / 3;

  const v0 = new Vector3();
  const v1 = new Vector3();
  const v2 = new Vector3();
  const positions: number[] = [];
  const filterRadiusSq = filterRadius * filterRadius;
  for (let t = 0; t < triCount; t++) {
    const a = idxArray ? idxArray[t * 3] : t * 3;
    const b = idxArray ? idxArray[t * 3 + 1] : t * 3 + 1;
    const c = idxArray ? idxArray[t * 3 + 2] : t * 3 + 2;
    v0.fromBufferAttribute(posAttr, a);
    v1.fromBufferAttribute(posAttr, b);
    v2.fromBufferAttribute(posAttr, c);
    heartMesh.localToWorld(v0);
    heartMesh.localToWorld(v1);
    heartMesh.localToWorld(v2);
    if (
      v0.distanceToSquared(approxCenter) > filterRadiusSq &&
      v1.distanceToSquared(approxCenter) > filterRadiusSq &&
      v2.distanceToSquared(approxCenter) > filterRadiusSq
    ) {
      continue;
    }
    positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z, v2.x, v2.y, v2.z);
  }
  if (positions.length === 0) return null;

  const localGeometry = new BufferGeometry();
  localGeometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  return new Mesh(localGeometry, new MeshBasicMaterial({ side: DoubleSide }));
}

/**
 * 心筋メッシュ(heart-realistic.glb、ワールド座標系)に実在する、大動脈弁輪相当の
 * 開口部の位置・半径・(心臓の実際の長軸に沿った)輪郭を実測する。approxCenter
 * (冠動脈入口部からの弦当てはめで逆算した大動脈基部の推定中心、aorticRootMesh.tsの
 * computeOstiumChordFitPosition参照)の近傍を、心臓の実際の長軸(computeHeartLongAxis
 * 参照、世界座標の鉛直方向とは限らない)に沿って放射状にレイキャストし、「心筋の
 * 外側表面」と「開口部内側」の境界(輪郭)を検出する。以前は鉛直方向に固定して
 * レイキャストしていたため、心臓メッシュ自体が傾いている場合に輪郭が実際より歪んで
 * (楕円状に)検出されてしまっていた。approxCenterが実際の開口部から大きく離れている、
 * または心臓メッシュにこの種の開口が無い場合はnullを返す(呼び出し側はheartWidthベース
 * の従来計算にフォールバックする)。
 */
export function detectAorticOpening(heartMesh: Mesh, approxCenter: Vector3, heartScale: number): DetectedAorticOpening | null {
  if (heartScale <= 1e-6) return null;
  try {
    heartMesh.updateWorldMatrix(true, false);
    const axis = computeHeartLongAxis(heartMesh, approxCenter);
    const { u, v } = computeCrossSectionBasis(axis);

    const filterRadius = FILTER_RADIUS_SCALE * heartScale;
    const localMeshOrNull = buildLocalRaycastMesh(heartMesh, approxCenter, filterRadius);
    if (!localMeshOrNull) return null;
    const localMesh = localMeshOrNull;

    const searchMaxRadius = SEARCH_MAX_RADIUS_SCALE * heartScale;
    const searchMinRadius = SEARCH_MIN_RADIUS_SCALE * heartScale;
    const surfaceOffsetThreshold = -SURFACE_HEIGHT_OFFSET_SCALE * heartScale;

    const box = new Box3().setFromObject(heartMesh);
    const rayFar = box.getSize(new Vector3()).length() + 2 * heartScale;
    const raycaster = new Raycaster();
    const rayOrigin = new Vector3();
    const rayDir = axis.clone().negate();
    const farOrigin = approxCenter.clone().addScaledVector(axis, heartScale * 2);
    /** (du, dv)方向(axisに垂直な平面上、approxCenterからの水平オフセット)にある点へ、
     * axisの逆方向からレイを飛ばし、最初にヒットした点のaxis方向オフセット
     * (approxCenter基準、正=心筋の外側表面に近い/浅い、負=開口部の内側/深い)を返す。 */
    function firstHitAxisOffset(du: number, dv: number): { offset: number; point: Vector3 | null } {
      rayOrigin.copy(farOrigin).addScaledVector(u, du).addScaledVector(v, dv);
      raycaster.set(rayOrigin, rayDir);
      raycaster.far = rayFar;
      const hits = raycaster.intersectObject(localMesh, false);
      if (!hits.length) return { offset: -Infinity, point: null };
      const point = hits[0].point;
      return { offset: axis.dot(point.clone().sub(approxCenter)), point };
    }

    const ringPoints: Vector3[] = [];
    for (let i = 0; i < ANGLE_SAMPLES; i++) {
      const theta = (i / ANGLE_SAMPLES) * Math.PI * 2;
      const dirU = Math.cos(theta);
      const dirV = Math.sin(theta);
      let lo = searchMinRadius;
      let hi = searchMaxRadius;
      for (let iter = 0; iter < BINARY_SEARCH_ITERATIONS; iter++) {
        const mid = (lo + hi) / 2;
        const { offset } = firstHitAxisOffset(dirU * mid, dirV * mid);
        const insideOpening = offset < surfaceOffsetThreshold;
        if (insideOpening) lo = mid;
        else hi = mid;
      }
      const { point } = firstHitAxisOffset(dirU * hi, dirV * hi);
      ringPoints.push(point ?? approxCenter.clone().addScaledVector(u, dirU * hi).addScaledVector(v, dirV * hi));
    }

    const center = new Vector3();
    for (const p of ringPoints) center.add(p);
    center.divideScalar(ringPoints.length);
    let radiusSum = 0;
    for (const p of ringPoints) {
      const offset = p.clone().sub(approxCenter);
      radiusSum += Math.hypot(offset.dot(u), offset.dot(v));
    }
    const radius = radiusSum / ringPoints.length;
    if (!Number.isFinite(radius) || radius <= 1e-6) return null;

    return { center, radius, contour: ringPoints, axis };
  } catch {
    return null;
  }
}

