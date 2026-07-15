// 造影剤フロー(Phase 7)の再生状態の型定義。cine.tsのCineStateと同じ「再生中/累計秒数」の
// パターンを踏襲しつつ、伝播モデル自体のパラメータ(ContrastFlowParams)は
// utils/contrastFlow.ts側に定義してあるものをそのまま持つ。

import type { ContrastFlowParams, ContrastPlaybackState } from "../utils/contrastFlow";

export interface ContrastState extends ContrastPlaybackState {
  /**
   * 造影剤フローモードのON/OFF。既定はfalseで、この間はPhase 7実装前と全く同じ
   * 「血管が常にフル吸収で末梢まで描出される」挙動になる(CineVesselThicknessEffect参照)。
   * trueにすると、造影剤の注入・伝播・ウォッシュアウトに応じて血管の描出が変化する
   * モードに切り替わる。
   */
  enabled: boolean;
  params: ContrastFlowParams;
}
