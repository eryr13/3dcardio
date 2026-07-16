// 造影剤フロー(Phase 7)の伝播モデル。中心線グラフ(vesselGraph.ts)上で、起始部(本幹の
// t=0)から末梢へ向かって造影剤が広がっていく様子を、店(store)に依存しない純粋関数として
// 計算する。Phase 8(心筋灌流)が「どの枝がどの領域を灌流するか」「狭窄により虚血に
// なっているか」を判定する際に、ここで作る枝ごとの到達時刻テーブルをそのまま再利用できる
// ように設計している。
//
// 伝播モデルの考え方(重要): 狭窄・石灰化の効果は「伝播フロントの速度を落とす」ことでは
// 表現しない。フロントの到達時刻(arrivalSeconds)は、狭窄の有無に関わらず中心線に沿った
// 距離をbaseSpeedで割った一定速度の累積であり、常に近位から遠位へ淀みなく進む
// (integrateArrivalTable参照)。狭窄・石灰化の効果は代わりに「その先へ供給できる
// 造影剤の最大濃度(ceilings)」の低下として表現する——起始部からその点までの経路上に
// ある狭窄・石灰化それぞれのpassThroughCoefficientの積が、その点でフロント到達後に
// 到達しうる濃度の上限になる(getConcentrationAt参照)。
//
// この設計にした理由: 以前はフロントの速度自体を内腔の断面積比率で落としていたが、
// これだと高度狭窄区間の通過に何秒もかかる計算になり、実際の再生では「フロントが
// 狭窄部の直後で何秒も止まって見え、その間に手前のボーラスが完全に洗い流されてから
// ようやく末梢に色がつき始める」という不自然な時系列になっていた。速度をどう調整しても
// この「詰まる」感覚は消えなかった。実際の血流では、造影剤は上流の供給に応じて下流の
// 各点の濃度が時間差で立ち上がるのであり、狭窄の効果は「先端の進行を止める/遅らせる」
// ことではなく「狭窄を境に、その先へ供給できる造影剤の総量(=到達できる最大濃度)を
// 減らす」ことである、という考え方に転換した。これにより、フロントは常に一定速度で
// 末梢まで滑らかに到達し、狭窄より末梢は(到達は正常なタイミングのまま)より薄い濃度
// でしか造影されない、という臨床的に正しい見え方になる。

import type { VesselId } from "../types/anatomy";
import type { CardioObject } from "../types/object";
import { LESION_TAPER_FRACTION, getStenosisSeverityAt, lesionTaperProfile } from "../types/object";
import type { CenterlineBranch, VesselGraph } from "../components/models/vesselGraph";
import { getBranch, getMainTrunk } from "../components/models/vesselGraph";
import { sampleCenterline } from "../components/models/vesselCenterline";

export interface ContrastFlowParams {
  /**
   * 造影剤先端の伝播速度(中心線の弧長と同じ「シーン単位/秒」)。狭窄・石灰化の
   * 有無に関わらず常に一定(伝播モデルの考え方、ファイル先頭のコメント参照)。
   * このGLBモデルは実世界のメートル単位ではなくシーン固有の任意スケールを使っており
   * (実測: RCA本幹の弧長は約5.6シーン単位)、実際の血流速度(cm/s)をそのまま単位換算
   * するのではなく、本幹全体が1〜2秒程度で造影されるように実機で調整した値。
   */
  baseSpeed: number;
  /** 先端到達後、濃度が0→1に立ち上がるまでの時間(秒)。 */
  riseTime: number;
  /** 濃度が1でとどまる時間(注入の持続時間、秒)。 */
  plateauDuration: number;
  /** ウォッシュアウト(濃度減衰)の時定数(秒)。大きいほどゆっくり消える。 */
  decayTimeConstant: number;
}

export const DEFAULT_CONTRAST_FLOW_PARAMS: ContrastFlowParams = {
  baseSpeed: 3.0,
  riseTime: 0.15,
  plateauDuration: 1.0,
  decayTimeConstant: 0.6,
};

export interface ContrastPlaybackState {
  playing: boolean;
  playStartedAtMs: number | null;
  accumulatedSeconds: number;
  /** 再生速度倍率(タイムライン上のUI操作用。ContrastFlowParams.baseSpeedとは別物)。 */
  playbackSpeedMultiplier: number;
}

/** heartbeatAnimation.ts の getElapsedActiveSeconds と同じ考え方(再生中は壁時計との差分を加算)。 */
export function getElapsedContrastSeconds(contrast: ContrastPlaybackState): number {
  const live =
    contrast.playing && contrast.playStartedAtMs !== null
      ? ((performance.now() - contrast.playStartedAtMs) / 1000) * contrast.playbackSpeedMultiplier
      : 0;
  return contrast.accumulatedSeconds + live;
}

/** length=0(点)の縮退を避けるための下限(types/object.tsの同名定数と同じ値)。 */
const MIN_HALF_LENGTH = 0.005;

/**
 * 指定した枝上の位置tにおける、石灰化による内腔半径比率(0〜1、1=狭窄なし)。
 * 複数の石灰化が重なる場合は最も厳しい(最小の)値を返す。thicknessは全周に対する
 * 半径方向の減少量、angleSpan/360は円周方向のカバー率で重み付けする近似。
 * lesionTaperProfileで区間境界へ向けてなめらかにテーパーさせる(石灰化の見た目
 * そのもの、calcificationMesh.tsは区間全体で一様な厚みのまま変更しないが、造影剤
 * フローが参照するこの「内腔がどれだけ狭いか」の値だけは、血管本来の内腔との
 * 接続部に段差が出ないようテーパーさせる)。
 */
export function getCalcificationRadiusFractionAt(
  objects: CardioObject[],
  vesselId: VesselId,
  branchId: string,
  t: number,
): number {
  let minFraction = 1;
  for (const object of objects) {
    if (object.type !== "calcification" || object.vesselId !== vesselId || object.branchId !== branchId) continue;
    if (!object.visible) continue;
    const half = Math.max(object.length / 2, MIN_HALF_LENGTH);
    const profile = lesionTaperProfile((t - object.position) / half);
    if (profile <= 0) continue;
    const coverageFraction = Math.min(1, Math.max(0, object.angleSpan / 360));
    const radiusFraction = 1 - (object.thickness / 100) * coverageFraction * profile;
    if (radiusFraction < minFraction) minFraction = radiusFraction;
  }
  return Math.max(0, minFraction);
}

/**
 * 指定した枝上の位置tにおける、狭窄+石灰化を合わせた内腔半径比率(0〜1)。
 * 2つの病変が同じ位置に重なっている場合、実際の内腔はより厳しい方(値が小さい方)で
 * 決まると考え、積ではなく最小値を採用する(Phase 6のレンダリングも、狭窄・石灰化
 * それぞれの内腔減算シェルを同じ深度ピールバッファに独立に加算する方式であり、
 * 結果として見える内腔もどちらか厳しい方が支配的になるため、これと整合させている)。
 * 描画(造影剤で満たされたチューブの半径)にはこの値をそのまま使う想定なので、
 * 完全閉塞(0)もそのまま返す。流速計算での0除算回避は呼び出し側(このファイル内の
 * integrateArrivalTable)でのみ行う。
 */
export function getLumenRadiusFractionAt(
  objects: CardioObject[],
  vesselId: VesselId,
  branchId: string,
  t: number,
): number {
  const stenosisSeverity = getStenosisSeverityAt(objects, vesselId, branchId, t);
  const stenosisRadiusFraction = 1 - stenosisSeverity / 100;
  const calcificationRadiusFraction = getCalcificationRadiusFractionAt(objects, vesselId, branchId, t);
  return Math.max(0, Math.min(stenosisRadiusFraction, calcificationRadiusFraction));
}

/**
 * 通過係数の非線形カーブの形を決める2定数。冠動脈生理では、軽度〜中等度狭窄
 * (おおむね60%程度まで)は末梢血流をほとんど落とさず(末梢血管床側の抵抗の方が
 * 支配的なため)、高度狭窄(70%以上)から急激に血流が落ち始める、という
 * 「フラット→急峻」なS字カーブが臨床的に知られている(冠血流予備能のGould曲線と
 * 同じ傾向)。ロジスティック関数 1/(1+exp((s-M)/k)) で近似し、M=80%を中間点、
 * k=5%を急峻さとすると: 50%狭窄で係数≈0.998(ほぼ変化なし)、70%で≈0.88、
 * 90%で≈0.12(明らかに低下)、99%で≈0.02(ほぼ通過不可)になる。
 */
const FLOW_LIMITING_MIDPOINT_STENOSIS_PERCENT = 80;
const FLOW_LIMITING_STEEPNESS_PERCENT = 5;

/**
 * 内腔半径比率(1=狭窄なし〜0=完全閉塞)から、その地点を通過できる造影剤の
 * 「通過係数」(0〜1)を求める。radiusFractionはgetLumenRadiusFractionAtが返す
 * 値をそのまま使う想定で、狭窄・石灰化のどちらによる内腔狭小化も同じカーブで扱う
 * (どちらも最終的には同じ「内腔がどれだけ狭くなっているか」という量に帰着するため)。
 * 完全閉塞(radiusFraction=0)はロジスティックが漸近するのみで厳密な0に達しないため、
 * 特別扱いで厳密に0を返す。
 */
export function passThroughCoefficient(radiusFraction: number): number {
  const clamped = Math.max(0, Math.min(1, radiusFraction));
  if (clamped <= 1e-4) return 0;
  if (clamped >= 1) return 1;
  const stenosisPercent = (1 - clamped) * 100;
  const z = (stenosisPercent - FLOW_LIMITING_MIDPOINT_STENOSIS_PERCENT) / FLOW_LIMITING_STEEPNESS_PERCENT;
  return 1 / (1 + Math.exp(z));
}

export interface BranchLink {
  branchId: string;
  parentBranchId: string | null;
  /** 親枝上でこの枝が分岐するt(0〜1)。本幹(親を持たない)ではnull。 */
  divergenceT: number | null;
}

/**
 * 枝の親子関係を実行時に導出する。CenterlineBranchには親枝フィールドが無いため、
 * 自分のstartNodeIdが他の枝のstartNodeId/endNodeId/waypointsのいずれかと一致するかで
 * 探す。実データ(centerlines.json)ではRCA/LADに「側枝からさらに側枝が分岐する」
 * 多階層構造が実在する(本幹に接続する側枝だけではない)ため、本幹を優先しつつ
 * どの枝が親になっても解決できるよう全枝を走査する。
 */
export function buildBranchLinks(graph: VesselGraph): Map<string, BranchLink> {
  const links = new Map<string, BranchLink>();
  const mainTrunk = getMainTrunk(graph);
  const orderedCandidates = [mainTrunk, ...graph.branches.filter((b) => b.id !== mainTrunk.id)];

  for (const branch of graph.branches) {
    if (branch.isMainTrunk) {
      links.set(branch.id, { branchId: branch.id, parentBranchId: null, divergenceT: null });
      continue;
    }
    const parent = findParentBranch(orderedCandidates, branch);
    links.set(branch.id, {
      branchId: branch.id,
      parentBranchId: parent?.parentBranchId ?? null,
      divergenceT: parent?.divergenceT ?? null,
    });
  }
  return links;
}

function findParentBranch(
  candidates: CenterlineBranch[],
  branch: CenterlineBranch,
): { parentBranchId: string; divergenceT: number } | null {
  const startNode = branch.startNodeId;
  for (const candidate of candidates) {
    if (candidate.id === branch.id) continue;
    if (candidate.startNodeId === startNode) return { parentBranchId: candidate.id, divergenceT: 0 };
    if (candidate.endNodeId === startNode) return { parentBranchId: candidate.id, divergenceT: 1 };
    const waypoint = candidate.waypoints.find((wp) => wp.nodeId === startNode);
    if (waypoint) return { parentBranchId: candidate.id, divergenceT: waypoint.t };
  }
  return null;
}

/** 本幹を根としたBFS順(親が必ず先に来る順序)で枝IDを並べる。 */
function topologicalBranchOrder(graph: VesselGraph, links: Map<string, BranchLink>): string[] {
  const mainTrunk = getMainTrunk(graph);
  const order: string[] = [mainTrunk.id];
  const added = new Set<string>(order);

  let remaining = graph.branches.filter((b) => !added.has(b.id));
  while (remaining.length > 0) {
    const next = remaining.filter((b) => {
      const parentId = links.get(b.id)?.parentBranchId;
      return parentId !== null && parentId !== undefined && added.has(parentId);
    });
    if (next.length === 0) break; // 親が見つからない孤立した枝(データ不整合)は諦めて打ち切る
    for (const b of next) {
      order.push(b.id);
      added.add(b.id);
    }
    remaining = remaining.filter((b) => !added.has(b.id));
  }
  return order;
}

export interface ArrivalTable {
  /** branch.pointsと同じ並びのt値(単調増加)。 */
  ts: number[];
  /** 対応するtにおける、造影剤先端の到達時刻(注入開始からの秒数)。 */
  arrivalSeconds: number[];
  /**
   * 対応するtにおける、通過可能な最大濃度(0〜1、1=血流制限なし)。起始部からそのtまでの
   * 経路上にある狭窄・石灰化区間それぞれをpassThroughCoefficientで係数化し、直列に
   * 並ぶ区間ごとに掛け合わせた値。getConcentrationAtがこれを濃度の到達上限として使う
   * (「到達が遅れる」だけでなく「到達しても薄いまま」を表現するのがこの値の役割)。
   */
  ceilings: number[];
}

export type ArrivalTables = Map<string, ArrivalTable>;

/** ceilings計算時、この値未満のradiusFractionを「狭小化区間の中にいる」とみなす閾値。 */
const RESTRICTION_RADIUS_FRACTION_THRESHOLD = 1 - 1e-9;

/**
 * 積分点をテーパー区間内で細分割する分割数(入口・出口それぞれ)。中心線本来の
 * サンプリング間隔(RCA本幹で約2.6%)は、典型的な狭窄の長さ(UI既定で血管全長の
 * 8%程度)に対するテーパー幅(その10%=0.8%)よりずっと粗い。素通しで積分すると、
 * テーパー全体(場合によってはプラトーの一部まで)が中心線の1区間に埋もれてしまい、
 * その区間の通過係数(ceiling)が区間の両端を結ぶ直線で補間されることになる
 * ——実際には狭窄の立ち上がりはもっと急峻(区間のごく手前で起こる)なため、この
 * 線形補間はceilingを実際より緩く見積もってしまう(=造影剤がくびれを実際に
 * 通過し切る前に、その先(末梢・直後の分岐)が実際より濃く色づいてしまう)。
 */
const LESION_CHECKPOINT_SUBDIVISIONS = 4;

/**
 * 指定した枝上にある狭窄・石灰化オブジェクトそれぞれについて、そのテーパー区間
 * (入口・出口それぞれ)を細分割した追加のt値を集める。integrateArrivalTableが
 * これを中心線本来の点列とマージしてから積分することで、中心線のサンプリング
 * 密度に関わらずテーパーの形(=通過係数ceilingの変化する位置)を正しく解像する
 * (病変が無い枝ではcheckpointsが空になり、ネイティブな点列だけを使う
 * 従来通りの挙動になる)。到達時刻(arrivalSeconds)は距離÷baseSpeedの一定速度
 * 積分のため、この細分割の恩恵を受けるのはceilingの計算だけである。
 */
function collectLesionCheckpoints(objects: CardioObject[], vesselId: VesselId, branchId: string): number[] {
  const checkpoints: number[] = [];
  for (const object of objects) {
    if (object.type !== "stenosis" && object.type !== "calcification") continue;
    if (object.vesselId !== vesselId || object.branchId !== branchId || !object.visible) continue;
    const half = Math.max(object.length / 2, MIN_HALF_LENGTH);
    const taperWidth = 2 * LESION_TAPER_FRACTION * half;
    const tStart = object.position - half;
    const tPlateauStart = tStart + taperWidth;
    const tPlateauEnd = object.position + half - taperWidth;
    const tEnd = object.position + half;
    for (const [from, to] of [
      [tStart, tPlateauStart],
      [tPlateauEnd, tEnd],
    ] as const) {
      for (let k = 0; k <= LESION_CHECKPOINT_SUBDIVISIONS; k++) {
        const t = from + ((to - from) * k) / LESION_CHECKPOINT_SUBDIVISIONS;
        if (t >= 0 && t <= 1) checkpoints.push(t);
      }
    }
  }
  return checkpoints;
}

function integrateArrivalTable(
  branch: CenterlineBranch,
  objects: CardioObject[],
  vesselId: VesselId,
  params: ContrastFlowParams,
  startTime: number,
  startCeiling: number,
): ArrivalTable {
  const nativePoints = branch.points;

  // 中心線本来の点列に、この枝上の病変のテーパー区間を細分割した追加のt値
  // (collectLesionCheckpoints)をマージしてから積分する。追加点の3D位置は
  // sampleCenterlineで中心線を線形補間して求める。
  const checkpoints = collectLesionCheckpoints(objects, vesselId, branch.id);
  const tSet = new Set<number>(nativePoints.map((p) => p.t));
  for (const t of checkpoints) tSet.add(t);
  const sortedTs = Array.from(tSet).sort((a, b) => a - b);

  const nativePositionByT = new Map(nativePoints.map((p) => [p.t, p.position] as const));
  const points = sortedTs.map((t) => ({
    position: nativePositionByT.get(t) ?? sampleCenterline(nativePoints, t).point,
    t,
  }));

  const ts: number[] = [points[0].t];
  const arrivalSeconds: number[] = [startTime];
  let time = startTime;

  // ceilings: 狭小化区間(radiusFraction<1が連続する範囲、lesionTaperProfileにより
  // 入口テーパー→最狭窄プラトー→出口テーパーの台形状に連続変化する)に入ると、
  // その時点までの区間内最小radiusFractionを都度更新しながら
  // ceiling = 区間に入る直前のceiling × passThroughCoefficient(その時点までの最小値)
  // を「区間に入るたびに毎回計算し直す」(乗算を繰り返し積み上げるのではなく、
  // 常に最新の最小値から作り直す)ことで、以下を両立する:
  // - 入口テーパーを進むにつれ、radiusFractionが下がるほどceilingも滑らかに
  //   絞られていき、ちょうど最狭窄プラトーに到達した時点で最終的な(その病変の)
  //   最も厳しい値に達する(=「入口テーパーで内腔が十分狭くなるあたりで流れが
  //   大きく制限される」という要求どおりの位置で絞り込みが完了する)。
  // - 出口テーパーでradiusFractionが再び上がっても、Math.minで最小値を更新する
  //   だけなので緩まない(一度絞られた流量は、その先で血管が元の太さに戻っても
  //   回復しない、という生理的に正しい向き)。
  // - 病変の長さや中心線のサンプリング密度に関わらず、最終的なceilingの値は
  //   その病変の最小radiusFractionだけで決まる(セグメントごとに逐次乗算する
  //   方式だとサンプリング密度が高いほど余計に減衰してしまうため、それは避けている)。
  const ceilings: number[] = [startCeiling];
  let ceiling = startCeiling;
  let inRestriction = false;
  let ceilingBeforeRegion = startCeiling;
  let regionMinRadiusFraction = 1;

  const r0 = getLumenRadiusFractionAt(objects, vesselId, branch.id, points[0].t);
  if (r0 < RESTRICTION_RADIUS_FRACTION_THRESHOLD) {
    inRestriction = true;
    regionMinRadiusFraction = r0;
    ceiling = ceilingBeforeRegion * passThroughCoefficient(regionMinRadiusFraction);
    ceilings[0] = ceiling;
  }

  // 到達時刻は狭窄・石灰化の有無に関わらず、距離をbaseSpeedで割った一定速度の
  // 累積で決まる(ファイル先頭のコメント参照)。フロントは狭窄部でも淀みなく通過し、
  // 常に近位から遠位へ一定速度で進む——狭窄の効果は下のceilings(到達可能な
  // 最大濃度)の低下としてのみ表現する。
  const speed = Math.max(params.baseSpeed, 1e-6);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const segmentLength = prev.position.distanceTo(curr.position);
    time += segmentLength / speed;
    ts.push(curr.t);
    arrivalSeconds.push(time);

    const r = getLumenRadiusFractionAt(objects, vesselId, branch.id, curr.t);
    if (r < RESTRICTION_RADIUS_FRACTION_THRESHOLD) {
      if (!inRestriction) {
        ceilingBeforeRegion = ceiling;
        regionMinRadiusFraction = r;
      } else {
        regionMinRadiusFraction = Math.min(regionMinRadiusFraction, r);
      }
      ceiling = ceilingBeforeRegion * passThroughCoefficient(regionMinRadiusFraction);
      inRestriction = true;
    } else {
      inRestriction = false;
    }
    ceilings.push(ceiling);
  }
  return { ts, arrivalSeconds, ceilings };
}

/**
 * 血管グラフ全体(本幹+全側枝、多階層の孫枝も含む)について、造影剤先端の到達時刻
 * テーブルを計算する。本幹はt=0(起始部)から時刻0で出発し、各側枝は親枝が分岐点に
 * 到達した時刻から自分自身の到達時刻計算を開始する(親を必ず先に処理するよう
 * topologicalBranchOrderでBFS順に並べてから積み上げる)。
 */
export function computeArrivalTables(
  graph: VesselGraph,
  objects: CardioObject[],
  vesselId: VesselId,
  params: ContrastFlowParams = DEFAULT_CONTRAST_FLOW_PARAMS,
): ArrivalTables {
  const links = buildBranchLinks(graph);
  const order = topologicalBranchOrder(graph, links);
  const tables: ArrivalTables = new Map();

  for (const branchId of order) {
    const branch = getBranch(graph, branchId);
    if (!branch || branch.points.length === 0) continue;
    const link = links.get(branchId);
    const parentTable = link?.parentBranchId ? tables.get(link.parentBranchId) : undefined;
    const startTime = parentTable ? getArrivalTimeAt(parentTable, link?.divergenceT ?? 0) : 0;
    // 側枝は、親枝が分岐点までに通ってきた狭窄・石灰化による血流制限(ceiling)を
    // そのまま引き継いだ状態から出発する(親枝本体の狭窄は側枝にも上流の血流制限として
    // 効くため)。その上で、側枝自身の区間にある狭窄・石灰化がさらに掛け合わさる。
    const startCeiling = parentTable ? getCeilingAt(parentTable, link?.divergenceT ?? 0) : 1;
    tables.set(branchId, integrateArrivalTable(branch, objects, vesselId, params, startTime, startCeiling));
  }
  return tables;
}

/** 到達時刻テーブルから、任意のt(0〜1)における到達時刻を線形補間で求める。 */
export function getArrivalTimeAt(table: ArrivalTable | undefined, t: number): number {
  if (!table || table.ts.length === 0) return 0;
  const { ts, arrivalSeconds } = table;
  const clamped = Math.min(1, Math.max(0, t));

  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const frac = span > 1e-12 ? (clamped - ts[lo]) / span : 0;
  return arrivalSeconds[lo] + (arrivalSeconds[hi] - arrivalSeconds[lo]) * frac;
}

/**
 * 到達時刻テーブルから、任意のt(0〜1)における通過可能な最大濃度(ceiling)を求める。
 * getArrivalTimeAtと同じ二分探索+線形補間だが、ceilingは狭小化区間を抜けた瞬間にしか
 * 変化しないステップ状の値なので、線形補間が効くのはその変化点をまたぐ隣接サンプル点間の
 * ごく短い区間だけ(見た目のギザギザを避ける程度の意味しかない)。
 */
export function getCeilingAt(table: ArrivalTable | undefined, t: number): number {
  if (!table || table.ts.length === 0) return 1;
  const { ts, ceilings } = table;
  const clamped = Math.min(1, Math.max(0, t));

  let lo = 0;
  let hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const span = ts[hi] - ts[lo];
  const frac = span > 1e-12 ? (clamped - ts[lo]) / span : 0;
  return ceilings[lo] + (ceilings[hi] - ceilings[lo]) * frac;
}

/**
 * 到達時刻テーブル+washoutパラメータから、時刻elapsedSecondsにおけるtでの造影剤濃度
 * (0〜1)を求める。先端到達前は0、到達後riseTimeで1まで立ち上がり、plateauDuration
 * の間1を保ち、その後decayTimeConstantで指数的に0へ減衰する。
 */
export function getConcentrationAt(
  table: ArrivalTable | undefined,
  t: number,
  elapsedSeconds: number,
  params: ContrastFlowParams = DEFAULT_CONTRAST_FLOW_PARAMS,
): number {
  if (!table) return 0;
  const arrival = getArrivalTimeAt(table, t);
  const sinceArrival = elapsedSeconds - arrival;
  if (sinceArrival <= 0) return 0;

  // 立ち上がり・プラトー・ウォッシュアウトの形はそのままに、到達しうる濃度の上限を
  // 固定の1ではなくceiling(狭窄・石灰化による血流制限の直列合成値)に置き換える。
  // ceiling=1なら従来通り(健常区間)、ceiling<1なら「遅れて、かつ薄いまま」プラトーし、
  // そこから同じ時定数でウォッシュアウトする。
  const ceiling = getCeilingAt(table, t);
  if (ceiling <= 1e-4) return 0;

  if (sinceArrival < params.riseTime) {
    return (sinceArrival / Math.max(params.riseTime, 1e-6)) * ceiling;
  }
  const sincePlateauEnd = sinceArrival - params.riseTime - params.plateauDuration;
  if (sincePlateauEnd <= 0) return ceiling;
  return ceiling * Math.exp(-sincePlateauEnd / Math.max(params.decayTimeConstant, 1e-6));
}

/**
 * 到達時刻テーブル上で、時刻elapsedSecondsまでに造影剤先端が到達している最も遠いt
 * (=現在の先端位置)。Phase 8で「この枝は現在造影されているか」を判定する用途を想定。
 */
export function getFrontPositionAtTime(table: ArrivalTable | undefined, elapsedSeconds: number): number {
  if (!table || table.ts.length === 0) return 0;
  const { ts, arrivalSeconds } = table;
  if (elapsedSeconds < arrivalSeconds[0]) return 0;
  let front = 0;
  for (let i = 0; i < ts.length; i++) {
    if (arrivalSeconds[i] <= elapsedSeconds) front = ts[i];
    else break;
  }
  return front;
}
