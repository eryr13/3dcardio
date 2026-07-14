// 血管上に疑似配置するオブジェクト(狭窄・石灰化プラーク・ステント等の治療デバイス/病変所見)の
// データ構造。Phase 7(造影剤フロー)・Phase 8(心筋灌流)から参照しやすいよう、
// store に依存しない純粋関数としてセレクタも一緒に定義している。

import type { VesselId } from "./anatomy";

export type ObjectType = "stenosis" | "calcification" | "stent";

interface ObjectBase {
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
   * オブジェクトの中心線方向の長さ(血管全長に対する比率、0〜1)。
   * 実際に効果が及ぶ範囲は [position - length/2, position + length/2] (0〜1にクランプ)。
   */
  length: number;
  /** 個別表示トグル(全タイプ共通)。 */
  visible: boolean;
}

export interface StenosisObject extends ObjectBase {
  type: "stenosis";
  /** 狭窄率(%)。0〜99。 */
  severity: number;
}

export interface CalcificationObject extends ObjectBase {
  type: "calcification";
  /**
   * 石灰化の厚み(局所血管半径に対する比率、%)。血管壁を基準に外側(心筋方向の
   * 組織側)・内側(内腔方向)の両方に同じ量だけ成長する。内側方向の成長分だけ
   * 内腔が狭くなり、シネビューでは造影剤の厚みが減って血管が細く写る。
   */
  thickness: number;
  /** 円周方向の広がり(度、0〜360)。0=石灰化なし、360=全周性(完全な筒)。 */
  angleSpan: number;
  /**
   * 向き(度、0〜360)。血管の中心線tangentに直交する平面内で、0=心筋方向
   * (心臓の重心を向く方向)、180=心外膜方向(その逆)を基準とした回転角。
   * angleSpanで指定した弧は、この角度を中心に左右対称に広がる。
   */
  orientation: number;
}

export interface StentObject extends ObjectBase {
  type: "stent";
  /** ステント公称径(mm相当、UI表示・ラティス半径計算用)。 */
  diameter: number;
}

export type CardioObject = StenosisObject | CalcificationObject | StentObject;

/**
 * store.updateObject の patch 用の型。`Partial<CardioObject>` はユニオン型の共通キー
 * (id/vesselId/position/length/visible/type)しか許容しないため、severity/diameter
 * のような型ごとに異なるフィールドを部分更新できるよう、type を除いて各バリアントを
 * intersectionしたものを Partial 化している。
 */
export type ObjectPatch = Partial<Omit<StenosisObject, "type">> &
  Partial<Omit<CalcificationObject, "type">> &
  Partial<Omit<StentObject, "type">>;

/**
 * store.addObject の引数用の型。`Omit<CardioObject, "id">` はユニオン型の共通キーしか
 * 残さず severity/diameter が消えてしまうため、各バリアントを個別にOmitしてから
 * unionし直したもの。
 */
export type NewObjectInput =
  | Omit<StenosisObject, "id">
  | Omit<CalcificationObject, "id">
  | Omit<StentObject, "id">;

export function getObjectsForVessel(objects: CardioObject[], vesselId: VesselId): CardioObject[] {
  return objects.filter((object) => object.vesselId === vesselId);
}

function objectCoversT(object: CardioObject, t: number): boolean {
  const half = object.length / 2;
  return t >= object.position - half && t <= object.position + half;
}

/**
 * 指定した枝(vesselId+branchId)上の位置tにおける狭窄率(0〜99)。複数の狭窄が重なる場合は
 * 最大値を返す。Phase 7の「狭窄部を通過する際に流速が落ちる」表現で、中心線をサンプリング
 * しながらこの関数を呼ぶ想定。
 */
export function getStenosisSeverityAt(
  objects: CardioObject[],
  vesselId: VesselId,
  branchId: string,
  t: number,
): number {
  let max = 0;
  for (const object of objects) {
    if (object.type !== "stenosis" || object.vesselId !== vesselId || object.branchId !== branchId) continue;
    if (!object.visible) continue;
    if (!objectCoversT(object, t)) continue;
    if (object.severity > max) max = object.severity;
  }
  return max;
}

/**
 * 血管全体で最も重症な狭窄率。Phase 8の「高度狭窄があればその先の灌流領域を
 * 虚血として強調する」表現で、血管単位の重症度判定に使う想定。
 */
export function getMaxStenosisSeverity(objects: CardioObject[], vesselId: VesselId): number {
  let max = 0;
  for (const object of objects) {
    if (object.type !== "stenosis" || object.vesselId !== vesselId || !object.visible) continue;
    if (object.severity > max) max = object.severity;
  }
  return max;
}
