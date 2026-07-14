// 血管上に疑似配置する病変(狭窄・石灰化プラーク・ステント)のデータ構造。
// Phase 7(造影剤フロー)・Phase 8(心筋灌流)から参照しやすいよう、
// store に依存しない純粋関数としてセレクタも一緒に定義している。

import type { VesselId } from "./anatomy";

export type LesionType = "stenosis" | "calcification" | "stent";

interface LesionBase {
  id: string;
  vesselId: VesselId;
  /**
   * 配置先の枝ID(vesselGraph.ts の CenterlineBranch.id)。本幹は"{vesselId}-main"、
   * 側枝は発見順に"{vesselId}-side1"のように命名される(scripts/extract_centerlines.py参照)。
   */
  branchId: string;
  /**
   * 枝(branchId)の中心線に沿った正規化位置。0=枝の近位端 〜 1=枝の遠位端。
   * 本幹ではvesselGraphのrootNodeIdに近い側が0、側枝ではその枝が本幹から
   * 分岐する分岐点側が0になる(vesselGraph.ts の CenterlineBranch.points 参照)。
   */
  position: number;
  /**
   * 病変の中心線方向の長さ(血管全長に対する比率、0〜1)。
   * 実際に効果が及ぶ範囲は [position - length/2, position + length/2] (0〜1にクランプ)。
   */
  length: number;
  /** 個別表示トグル(全タイプ共通)。 */
  visible: boolean;
}

export interface StenosisLesion extends LesionBase {
  type: "stenosis";
  /** 狭窄率(%)。0〜99。 */
  severity: number;
}

export interface CalcificationLesion extends LesionBase {
  type: "calcification";
  /** 石灰化の厚み/密度の強さ。0〜100目安。 */
  severity: number;
}

export interface StentLesion extends LesionBase {
  type: "stent";
  /** ステント公称径(mm相当、UI表示・ラティス半径計算用)。 */
  diameter: number;
}

export type Lesion = StenosisLesion | CalcificationLesion | StentLesion;

/**
 * store.updateLesion の patch 用の型。`Partial<Lesion>` はユニオン型の共通キー
 * (id/vesselId/position/length/visible/type)しか許容しないため、severity/diameter
 * のような型ごとに異なるフィールドを部分更新できるよう、type を除いて各バリアントを
 * intersectionしたものを Partial 化している。
 */
export type LesionPatch = Partial<Omit<StenosisLesion, "type">> &
  Partial<Omit<CalcificationLesion, "type">> &
  Partial<Omit<StentLesion, "type">>;

/**
 * store.addLesion の引数用の型。`Omit<Lesion, "id">` はユニオン型の共通キーしか
 * 残さず severity/diameter が消えてしまうため、各バリアントを個別にOmitしてから
 * unionし直したもの。
 */
export type NewLesionInput =
  | Omit<StenosisLesion, "id">
  | Omit<CalcificationLesion, "id">
  | Omit<StentLesion, "id">;

export function getLesionsForVessel(lesions: Lesion[], vesselId: VesselId): Lesion[] {
  return lesions.filter((lesion) => lesion.vesselId === vesselId);
}

function lesionCoversT(lesion: Lesion, t: number): boolean {
  const half = lesion.length / 2;
  return t >= lesion.position - half && t <= lesion.position + half;
}

/**
 * 指定した枝(vesselId+branchId)上の位置tにおける狭窄率(0〜99)。複数の狭窄が重なる場合は
 * 最大値を返す。Phase 7の「狭窄部を通過する際に流速が落ちる」表現で、中心線をサンプリング
 * しながらこの関数を呼ぶ想定。
 */
export function getStenosisSeverityAt(
  lesions: Lesion[],
  vesselId: VesselId,
  branchId: string,
  t: number,
): number {
  let max = 0;
  for (const lesion of lesions) {
    if (lesion.type !== "stenosis" || lesion.vesselId !== vesselId || lesion.branchId !== branchId) continue;
    if (!lesion.visible) continue;
    if (!lesionCoversT(lesion, t)) continue;
    if (lesion.severity > max) max = lesion.severity;
  }
  return max;
}

/**
 * 血管全体で最も重症な狭窄率。Phase 8の「高度狭窄があればその先の灌流領域を
 * 虚血として強調する」表現で、血管単位の重症度判定に使う想定。
 */
export function getMaxStenosisSeverity(lesions: Lesion[], vesselId: VesselId): number {
  let max = 0;
  for (const lesion of lesions) {
    if (lesion.type !== "stenosis" || lesion.vesselId !== vesselId || !lesion.visible) continue;
    if (lesion.severity > max) max = lesion.severity;
  }
  return max;
}
