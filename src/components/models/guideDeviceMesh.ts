// Phase 9: ガイドワイヤー・ガイディングカテーテルのデモ表示。
//
// これは物理シミュレーションではなく、あらかじめ定義したスプライン曲線(カテーテル)+
// 中心線グラフ(ワイヤー)に沿ってチューブ状のジオメトリを配置する静的なデモ表示である。
// 大動脈の3Dモデルは無いため、カテーテルの経路は「冠動脈入口部(オスティウム)を
// 終点とし、心臓の重心から見た向き・頭側・側方という局所基準系上のオフセットで
// 定義した制御点」を通るCatmullRom スプラインとして構築する(大動脈壁との厳密な
// 接触計算は行わない)。
//
// 対象がRCAかそれ以外(LCA=LAD/LCX)かで、カテーテル先端のカーブの大きさ・向きを
// 変える(実際のJR/JL・EBUカテーテルの違いを大まかに模したもの。正確な形状再現は
// 目的ではない)。

import { CatmullRomCurve3, Vector3 } from "three";
import type { BufferGeometry } from "three";
import type { VesselId } from "../../types/anatomy";
import { buildBranchLinks } from "../../utils/contrastFlow";
import { buildTubeFromPoints } from "./stentLatticeMesh";
import { sampleCenterline } from "./vesselCenterline";
import { getBranch, getMainTrunk } from "./vesselGraph";
import type { CenterlineBranch, VesselGraph } from "./vesselGraph";

/**
 * 指定した枝から本幹(根)まで、親をたどって祖先の連なりを求める
 * (utils/contrastFlow.tsのbuildBranchLinksは枝同士の親子関係だけを返し、祖先を
 * さかのぼって並べる関数までは提供していないため、ここに用意する)。
 * 返り値は本幹が先頭、対象の枝が末尾になる順序。
 */
export function getAncestryChain(graph: VesselGraph, targetBranchId: string): CenterlineBranch[] {
  const links = buildBranchLinks(graph);
  const chain: CenterlineBranch[] = [];
  const visited = new Set<string>();
  let currentId: string | null = targetBranchId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const branch = getBranch(graph, currentId);
    if (!branch) break;
    chain.push(branch);
    currentId = links.get(currentId)?.parentBranchId ?? null;
  }
  return chain.reverse();
}

interface ChainPathSample {
  point: Vector3;
  radius: number;
}

/**
 * 本幹(起始部)から対象の枝まで、途中の分岐を経由しながら実際にワイヤーが通る
 * 経路を、位置+半径のペアとして求める。祖先の枝は分岐点(次の枝が分かれる位置)
 * までを含み、対象の枝自身はt=0からtargetProgress(0〜1)までを含む。各区間の
 * 終端では、中心線の生のサンプル点だけでなくsampleCenterlineによる補間点も
 * 追加し、進行度アニメーション中に点が飛び飛びにならないようにする。
 * buildBranchPathPoints・buildWireCenterlineの共通実装。
 */
function walkChainPath(graph: VesselGraph, targetBranchId: string, targetProgress: number): ChainPathSample[] {
  const links = buildBranchLinks(graph);
  const chain = getAncestryChain(graph, targetBranchId);
  const result: ChainPathSample[] = [];

  for (let i = 0; i < chain.length; i++) {
    const branch = chain[i];
    const isTarget = i === chain.length - 1;
    const maxT = isTarget
      ? Math.max(0, Math.min(1, targetProgress))
      : Math.max(0, Math.min(1, links.get(chain[i + 1].id)?.divergenceT ?? 1));

    for (const p of branch.points) {
      if (p.t > maxT) break;
      result.push({ point: p.position.clone(), radius: p.radius });
    }
    const sample = sampleCenterline(branch.points, maxT);
    const last = result[result.length - 1];
    if (!last || last.point.distanceToSquared(sample.point) > 1e-10) {
      result.push({ point: sample.point.clone(), radius: sample.radius });
    }
  }
  return result;
}

/**
 * 本幹(起始部)から対象の枝まで、途中の分岐を経由しながら実際にワイヤーが通る
 * 経路の点列を求める(walkChainPathの位置成分だけを取り出したもの)。
 */
export function buildBranchPathPoints(graph: VesselGraph, targetBranchId: string, targetProgress: number): Vector3[] {
  return walkChainPath(graph, targetBranchId, targetProgress).map((s) => s.point);
}

/**
 * 冠動脈入口部(オスティウム)から対象の枝の末端(t=1)までの完全な経路を、
 * 各点の局所血管半径とあわせて求める。ワイヤーの挿入アニメーション
 * (buildGuideWireGeometry)が、この経路全体の弧長を基準に進行度を計算するのに使う
 * (対象の枝が孫枝の場合でも、祖先の枝を含めた経路全体の長さで進行度を測ることで、
 * 進行度がわずかに正になった瞬間に祖先の枝全体が一気に出現する不具合を避ける)。
 */
export function buildWireCenterline(graph: VesselGraph, targetBranchId: string): { points: Vector3[]; radii: number[] } {
  const samples = walkChainPath(graph, targetBranchId, 1);
  return { points: samples.map((s) => s.point), radii: samples.map((s) => s.radius) };
}

export type CoronaryApproachShape = "RCA" | "LCA";

function shapeForVessel(vesselId: VesselId): CoronaryApproachShape {
  return vesselId === "RCA" ? "RCA" : "LCA";
}

/**
 * カテーテルの制御点オフセット(オスティウムを基準にした[頭側, 心臓中心から見て外向き,
 * 側方]の3成分、心臓のスケールに対する比率)。並びは体外側(P0、大動脈からの
 * アプローチ)→オスティウムの手前で一度くぐらせるループ(P2〜P4)→係合直前(P5)で、
 * 最後にオスティウム自身(P6、常に[0,0,0]相当)を追加してスプラインを作る。
 *
 * 実際のカテーテル手技を大まかに模したもの: カテーテル先端はオスティウムの高さを
 * 一度通り過ぎて(P2)大動脈洞の奥まで進み、側方(lateral)へ大きくカーブしながら
 * オスティウムより下(-up)まで潜り込み(P3、ループの頂点)、そこから向きを変えて
 * 側方成分を0へ戻しながら(P4→P5)、オスティウムの真下から上向きにフックして
 * 係合する(P5→P6=オスティウムの区間で、up成分だけが単調に増える)。
 *
 * ループの往路(P2〜P3)と復路(P4〜P5)は、同じ高さ(up)付近でもlateral成分が
 * 大きく離れている(RCAで往復差0.2程度、LCAで0.4〜0.6程度、いずれもカテーテル
 * 半径の10倍以上)ため、チューブ化しても自己交差しない。またP5→P6の区間以外では
 * 側方・外向きのどちらかの成分が常にオスティウムから離れているため、最終区間より
 * 手前でスプラインがオスティウム付近を再度かすめることもない。
 *
 * RCA(JR風): 側方への振れが小さい、比較的コンパクトなフック。
 * LCA(JL/EBU風): 側方への振れが大きい、対側の大動脈壁に沿うような大きめの
 * 二次カーブ。どちらも実在のカテーテル形状の厳密な再現ではなく、大まかな
 * 向き・カーブの違いを表現するためのものである。
 */
const RCA_CATHETER_OFFSETS: readonly [number, number, number][] = [
  [3.4, 1.2, 0.0],
  [1.9, 0.65, 0.05],
  [0.55, 0.1, 0.18],
  [-0.35, -0.12, 0.22],
  [-0.55, 0.05, 0.12],
  [-0.4, 0.0, 0.0],
];

const LCA_CATHETER_OFFSETS: readonly [number, number, number][] = [
  [3.6, 1.4, 0.1],
  [2.1, 0.85, 0.3],
  [0.8, 0.25, 0.6],
  [-0.15, -0.1, 0.75],
  [-0.55, 0.1, 0.35],
  [-0.45, 0.0, 0.0],
];

function buildCatheterControlPoints(
  ostiumPosition: Vector3,
  heartCentroid: Vector3,
  heartScale: number,
  shape: CoronaryApproachShape,
): Vector3[] {
  const outward = ostiumPosition.clone().sub(heartCentroid);
  if (outward.lengthSq() < 1e-8) outward.set(1, 0, 0);
  outward.normalize();

  const up = new Vector3(0, 1, 0);
  const lateral = new Vector3().crossVectors(up, outward);
  if (lateral.lengthSq() < 1e-8) lateral.set(1, 0, 0);
  lateral.normalize();

  const offsets = shape === "RCA" ? RCA_CATHETER_OFFSETS : LCA_CATHETER_OFFSETS;
  const controlPoints = offsets.map(([upAmt, outwardAmt, lateralAmt]) =>
    ostiumPosition
      .clone()
      .addScaledVector(up, upAmt * heartScale)
      .addScaledVector(outward, outwardAmt * heartScale)
      .addScaledVector(lateral, lateralAmt * heartScale),
  );
  controlPoints.push(ostiumPosition.clone());
  return controlPoints;
}

/**
 * Phase 10(将来のバックアップ力簡易評価)向けに保持しておく、カテーテルの
 * エンゲージ状態を表す幾何情報。この描画で既に定まる情報をまとめただけで、
 * 新たな計算は行わない。
 */
export interface GuideCatheterPlacement {
  /** カテーテル先端の位置(=エンゲージした冠動脈入口部の位置と同一点)。 */
  tipPosition: Vector3;
  /**
   * カテーテル先端の向き(単位ベクトル、スプライン最終区間の方向)。血管自身の
   * 走行方向(ostiumDirection)とは独立に決まるため、両者のなす角を将来
   * バックアップ力の指標として使える。
   */
  tipDirection: Vector3;
  /** エンゲージした冠動脈入口部の位置(tipPositionと同一点、意味的に区別して保持)。 */
  ostiumPosition: Vector3;
  /** 冠動脈入口部における血管自身の走行方向(単位ベクトル)。 */
  ostiumDirection: Vector3;
  /**
   * カテーテルの大動脈側経路(スプライン)全体の弧長。大動脈壁メッシュが無いため
   * 正確な接触長ではないが、将来の簡易指標の代用値として保持しておく。
   */
  aorticPathLength: number;
  /** スプラインの元になった制御点(体外側→オスティウムの順)。 */
  controlPoints: Vector3[];
}

/** カテーテルの経路と、そこから導かれるPhase 10向け配置情報。進行度(アニメーション)には依存しない、対象・血管形状が同じなら不変の情報。 */
export interface GuideCatheterPath {
  placement: GuideCatheterPlacement;
  /** スプライン全体を弧長に沿って均等にサンプリングした点列(進行度に関わらず常に全体)。ワイヤーの共有区間としても使う。 */
  fullSplinePoints: Vector3[];
}

/**
 * カテーテルのスプラインを弧長に沿って均等サンプリングする点数。大動脈側の
 * アプローチ区間(P0〜P2)が弧長の大半を占めるため、控えめな点数だとオスティウム
 * 手前のループ(P2〜P5、弧長としては短い)が粗くカクついて見える。ループを
 * 滑らかに解像できるだけの点数を確保する。
 */
const CATHETER_CURVE_RESOLUTION = 64;

export function computeGuideCatheterPath(
  graph: VesselGraph,
  heartCentroid: Vector3,
  heartScale: number,
  vesselId: VesselId,
): GuideCatheterPath | null {
  const mainTrunk = getMainTrunk(graph);
  if (mainTrunk.points.length === 0) return null;

  const ostiumPosition = mainTrunk.points[0].position.clone();
  const ostiumDirection = sampleCenterline(mainTrunk.points, 0).tangent.clone();

  const shape = shapeForVessel(vesselId);
  const controlPoints = buildCatheterControlPoints(ostiumPosition, heartCentroid, heartScale, shape);
  const curve = new CatmullRomCurve3(controlPoints);
  const fullSplinePoints = curve.getSpacedPoints(CATHETER_CURVE_RESOLUTION);
  const aorticPathLength = curve.getLength();

  const tipDelta = new Vector3().subVectors(
    controlPoints[controlPoints.length - 1],
    controlPoints[controlPoints.length - 2],
  );
  const tipDirection = tipDelta.lengthSq() > 1e-10 ? tipDelta.normalize() : ostiumDirection.clone();

  const placement: GuideCatheterPlacement = {
    tipPosition: ostiumPosition.clone(),
    tipDirection,
    ostiumPosition: ostiumPosition.clone(),
    ostiumDirection,
    aorticPathLength,
    controlPoints,
  };

  return { placement, fullSplinePoints };
}

/** カテーテル1本あたりの円周分割数(血管と同程度の太さのため、ワイヤーより多めに)。 */
const CATHETER_RADIAL_SEGMENTS = 12;
/** ワイヤー1本あたりの円周分割数(非常に細いため少なめで十分)。 */
const WIRE_RADIAL_SEGMENTS = 6;

/**
 * カテーテルの挿入アニメーション用ジオメトリを、進行度(0〜1、0=未挿入、1=完全に
 * オスティウムへ係合)に応じて構築する。スプラインの体外側の端(controlPoints[0]相当)を
 * 起点に、進行度に応じて弧長に沿った先頭部分だけを表示する(=カテーテル先端が
 * 体外側からオスティウムへ向かって進んでいくように見える)。
 */
export function buildGuideCatheterGeometry(
  path: GuideCatheterPath,
  catheterRadius: number,
  catheterProgress: number,
): BufferGeometry {
  const progress = Math.max(0, Math.min(1, catheterProgress));
  const total = path.fullSplinePoints.length;
  // fullSplinePointsは弧長に沿って均等サンプリング済みなので、進行度に対応する
  // 正確な先端位置は隣接する2点を線形補間するだけで求まる(スプラインを
  // 作り直す必要はない)。
  const exactIndex = progress * (total - 1);
  const lowerIndex = Math.max(0, Math.min(total - 1, Math.floor(exactIndex)));
  const frac = exactIndex - lowerIndex;
  const exactTip =
    lowerIndex + 1 < total
      ? path.fullSplinePoints[lowerIndex].clone().lerp(path.fullSplinePoints[lowerIndex + 1], frac)
      : path.fullSplinePoints[total - 1].clone();

  const points = path.fullSplinePoints.slice(0, lowerIndex + 1).map((p) => p.clone());
  const last = points[points.length - 1];
  if (!last || last.distanceToSquared(exactTip) > 1e-10) points.push(exactTip);
  if (points.length < 2) points.push(exactTip.clone().addScalar(1e-4));

  const radii = points.map(() => catheterRadius);
  // スプライン自体が既に滑らかなため、buildTubeFromPoints既定の強い平滑化は不要
  // (かけると意図したJカーブの形が鈍る)。
  return buildTubeFromPoints(points, radii, CATHETER_RADIAL_SEGMENTS, 0);
}

/**
 * ワイヤーが血管壁に接しながらなだらかに曲がる様子を近似する、離散ラプラシアン
 * 平滑化+内腔クランプの反復緩和。剛性のあるワイヤーは湾曲部の中心線をそのまま
 * なぞらず、外側の壁に軽く押し付けられながらショートカットする——各内部点を
 * 「両隣の中点」方向へ少しずつ寄せる(=局所的な曲率を打ち消す=直線化する)ことを
 * 繰り返し、ただし元の中心線からの横方向オフセットが「その位置の内腔半径-ワイヤー
 * 半径」を超えないようクランプすることで、直線化が壁に当たったところで止まり、
 * 結果的に湾曲部の外側に軽く沿うような弧になる。
 *
 * 両端(起点=オスティウム側、終点=現在の先端)は一切動かさない。これは
 * buildGuideWireGeometryが以前ここに強い平滑化(smoothPoints、開いた経路の端点を
 * 自分自身とのクランプ平均で扱う方式)をかけていた際に、ワイヤー先端の表示位置が
 * 実際の到達点から手前へ後退してしまっていた不具合(実測: 4回の平滑化で
 * 中心線サンプル間隔の半分以上ずれた)と同じ問題が起きないようにするため。
 *
 * 直線区間ではラプラシアン(隣接2点の中点 - 自分自身)がほぼゼロになるため、
 * このワイヤーは湾曲部でだけ視覚的な効果を持ち、直線区間の中心線からは動かない。
 */
const WIRE_RELAX_ITERATIONS = 6;
const WIRE_RELAX_STIFFNESS = 0.5;
/** 内腔半径のうち実際にオフセットを許容する比率(狭窄・ステント等のSTENT_LUMEN_FIT_RATIO=0.95と同様、壁ぎりぎりに一致させると誤差でチューブが血管の外にはみ出しかねないため、わずかに内側に留める)。 */
const WIRE_LUMEN_FIT_RATIO = 0.9;

function relaxSemiRigidWire(points: Vector3[], lumenRadii: number[], wireRadius: number): Vector3[] {
  if (points.length < 3) return points;
  const base = points.map((p) => p.clone());
  let current = points.map((p) => p.clone());

  for (let iter = 0; iter < WIRE_RELAX_ITERATIONS; iter++) {
    const next = current.map((p) => p.clone());
    for (let i = 1; i < current.length - 1; i++) {
      const midpoint = current[i - 1].clone().add(current[i + 1]).multiplyScalar(0.5);
      const laplacian = midpoint.sub(current[i]);
      const candidate = current[i].clone().addScaledVector(laplacian, WIRE_RELAX_STIFFNESS);

      const maxOffset = Math.max((lumenRadii[i] - wireRadius) * WIRE_LUMEN_FIT_RATIO, 0);
      const offset = candidate.clone().sub(base[i]);
      if (maxOffset <= 0) {
        candidate.copy(base[i]);
      } else if (offset.length() > maxOffset) {
        candidate.copy(base[i]).addScaledVector(offset.normalize(), maxOffset);
      }
      next[i] = candidate;
    }
    current = next;
  }
  return current;
}

/**
 * ワイヤーの挿入アニメーション用ジオメトリを、進行度(0〜1)に応じて構築する。
 *
 * 冠動脈入口部(オスティウム)から対象の枝までの完全な経路(buildWireCenterline)を
 * 1回求め、その経路全体の弧長に対する割合として進行度を適用する(対象の枝自身の
 * tではなく、経路全体の弧長を基準にする)。これにより、対象が孫枝であっても
 * 進行度がわずかに正になった瞬間に祖先の枝全体が一気に出現することがない
 * (t基準だと、祖先の枝は常に「分岐点まで全体」を含んでしまうため、対象の枝の
 * 手前側はtargetProgressで制御できても、その手前にある祖先の枝の長さぶんは
 * 制御できず、進行度0+の瞬間にまとめて出現してしまっていた)。
 *
 * カテーテルの経路(大動脈側のアプローチ区間)は含めない——ワイヤーはこの区間では
 * カテーテルの内腔を通っているだけで、カテーテル自身のチューブ(オスティウムに
 * 先端が到達済み、catheterProgress=1)に完全に重なって隠れているため、ここで
 * 別のチューブとしてもう一度描画すると視覚的に無意味なだけでなく、進行度が
 * 1を超えた瞬間にカテーテルの全長ぶんが一気に出現して見える不具合の原因だった。
 *
 * 進行度が0の場合は「まだカテーテルの中から出ていない」とみなしnullを返す。
 */
export function buildGuideWireGeometry(
  graph: VesselGraph,
  targetBranchId: string,
  wireRadius: number,
  wireProgress: number,
): BufferGeometry | null {
  const progress = Math.max(0, Math.min(1, wireProgress));
  if (progress <= 0) return null;

  const { points, radii } = buildWireCenterline(graph, targetBranchId);
  if (points.length < 2) return null;

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + points[i - 1].distanceTo(points[i]));
  }
  const totalLength = cumulative[cumulative.length - 1];
  const targetLength = progress * totalLength;

  let k = 0;
  while (k < cumulative.length - 2 && cumulative[k + 1] < targetLength) k++;
  const segStart = cumulative[k];
  const segEnd = cumulative[Math.min(k + 1, cumulative.length - 1)];
  const frac = segEnd > segStart ? (targetLength - segStart) / (segEnd - segStart) : 0;
  const nextIndex = Math.min(k + 1, points.length - 1);
  const tip = points[k].clone().lerp(points[nextIndex], frac);
  const tipRadius = radii[k] + (radii[nextIndex] - radii[k]) * frac;

  const grown = points.slice(0, k + 1).map((p) => p.clone());
  const grownRadii = radii.slice(0, k + 1);
  const last = grown[grown.length - 1];
  if (!last || last.distanceToSquared(tip) > 1e-10) {
    grown.push(tip);
    grownRadii.push(tipRadius);
  }
  if (grown.length < 2) {
    grown.push(tip.clone().addScalar(1e-4));
    grownRadii.push(tipRadius);
  }

  const relaxed = relaxSemiRigidWire(grown, grownRadii, wireRadius);
  const tubeRadii = relaxed.map(() => wireRadius);
  // 平滑化(buildTubeFromPointsのsmoothingPasses)は一切かけない。relaxSemiRigidWireが
  // 既に湾曲部の見た目を調整済みであり、これ以上の平滑化は先端位置を後退させる
  // (このファイルの以前のコメント、および同様の問題を持つ他の長経路チューブ
  // (Phase 7の造影剤チューブ)と同じ理由)。
  return buildTubeFromPoints(relaxed, tubeRadii, WIRE_RADIAL_SEGMENTS, 0);
}
