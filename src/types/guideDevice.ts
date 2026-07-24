// Phase 9: ガイドワイヤー・ガイディングカテーテルのデモ表示の状態の型定義。
// 物理シミュレーションではなく、あらかじめ定義したスプライン経路に沿って
// カテーテル/ワイヤーの3Dモデルを配置する静的なデモ表示(components/models/guideDeviceMesh.ts参照)。

import type { VesselId } from "./anatomy";

/**
 * カテーテルの穿刺部位(アクセスルート)。心臓に到達するまでの体内経路の見た目
 * (guideDeviceMesh.tsのFEMORAL_ENTRY_OFFSETS/RADIAL_ENTRY_OFFSETS)が変わる。
 * 大動脈基部から冠動脈入口部へのエンゲージ手技自体はどちらのルートでも共通
 * (両ルートとも最終的に上行大動脈を経て大動脈基部に到達するため)。
 * 既定は橈骨(現在の主流のアプローチ)。
 */
export type GuideAccessRoute = "radial" | "femoral";

export interface GuideDeviceState {
  /** 全体の表示/非表示。 */
  enabled: boolean;
  showCatheter: boolean;
  showWire: boolean;
  /** どの血管の枝へ挿入するか。カテーテル先端形状はこのvesselIdがRCAかどうかで切り替わる(RCA以外はLCA系のJL/EBU風カーブ)。 */
  targetVesselId: VesselId;
  /** カテーテルの穿刺部位(アクセスルート)。既定は橈骨。 */
  accessRoute: GuideAccessRoute;
  /** targetVesselIdの血管グラフ内での、ワイヤーの到達目標にする枝ID(本幹または側枝)。 */
  targetBranchId: string;
  /**
   * 挿入アニメーションの進行度(0〜2)。0〜1でカテーテルが大動脈経路に沿って伸び、
   * 1〜2でワイヤーが冠動脈の中心線に沿って進む(guideDeviceMesh.ts参照)。
   */
  insertionPhase: number;
  /** 「デバイスを挿入」再生中かどうか(GuideDeviceControls.tsxのrequestAnimationFrameループが進行度を更新する)。 */
  playing: boolean;
  /** 挿入アニメーション全体(進行度0→2)の再生時間(秒)。GUIのスライダーで調整可能。 */
  insertionDurationSeconds: number;
  /**
   * デバッグ表示: カテーテル経路の構築に使う制御点(体外側→オスティウムの順、
   * GuideCatheterPlacement.controlPoints)と、密にサンプリングした経路全体
   * (fullSplinePoints)を、常に手前に描画する球マーカー+ラインとして可視化する。
   * 経路が意図した領域からはみ出す・繋がらない等の不具合を切り分けるための機能で、
   * 通常のシーンには含まれない解剖学的に無意味な補助表示のため既定は非表示。
   */
  showCatheterDebugPath: boolean;
  /**
   * Phase 10: カテーテルの経路形状からEuler-Bernoulli梁理論で求めた、相対的な
   * バックアップ力(血管壁からの接触反力の目安)のヒートマップ表示(components/models/
   * guideCatheterStress.ts参照)。ONにするとカテーテルの単色マテリアルの代わりに
   * 頂点色ベースのマテリアルへ切り替わる。既定は非表示(通常の見た目を保つため)。
   */
  showStressHeatmap: boolean;
}
