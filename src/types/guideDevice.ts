// Phase 9: ガイドワイヤー・ガイディングカテーテルのデモ表示の状態の型定義。
// 物理シミュレーションではなく、あらかじめ定義したスプライン経路に沿って
// カテーテル/ワイヤーの3Dモデルを配置する静的なデモ表示(components/models/guideDeviceMesh.ts参照)。

import type { VesselId } from "./anatomy";

export interface GuideDeviceState {
  /** 全体の表示/非表示。 */
  enabled: boolean;
  showCatheter: boolean;
  showWire: boolean;
  /** どの血管の枝へ挿入するか。カテーテル先端形状はこのvesselIdがRCAかどうかで切り替わる(RCA以外はLCA系のJL/EBU風カーブ)。 */
  targetVesselId: VesselId;
  /** targetVesselIdの血管グラフ内での、ワイヤーの到達目標にする枝ID(本幹または側枝)。 */
  targetBranchId: string;
  /**
   * 挿入アニメーションの進行度(0〜2)。0〜1でカテーテルが大動脈経路に沿って伸び、
   * 1〜2でワイヤーが冠動脈の中心線に沿って進む(guideDeviceMesh.ts参照)。
   */
  insertionPhase: number;
  /** 「デバイスを挿入」再生中かどうか(GuideDeviceControls.tsxのrequestAnimationFrameループが進行度を更新する)。 */
  playing: boolean;
}
