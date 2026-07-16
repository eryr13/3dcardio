// Phase 8: 心筋灌流領域・虚血表示の状態の型定義。

/**
 * 心筋灌流の表示モード。
 * - "off": 通常の心臓メッシュ表示(既定)。
 * - "territory": 各心筋領域を、それを灌流する血管の色で塗り分ける(灌流テリトリー表示)。
 * - "ischemia": 各心筋領域を、灌流の充足度(狭窄・石灰化による血流制限を反映した
 *   Phase 7の到達濃度上限)に応じたヒートマップ(緑→黄→オレンジ→赤)で塗り分ける。
 */
export type PerfusionMode = "off" | "territory" | "ischemia";

export interface PerfusionState {
  mode: PerfusionMode;
}
