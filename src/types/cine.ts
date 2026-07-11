// シネビュー(X線風平行投影 + 拍動ループ再生)に関する状態の型定義。
// anatomy.ts とは関心が別(表示スタイルではなく再生・書き出し制御)なので分離している。

export type CineFps = 15 | 30;

export interface CineState {
  /** シネパネル(平行投影ビュー)を表示するか */
  enabled: boolean;
  /** シネパネルの幅[px]。境界をドラッグしてリサイズできる */
  panelWidth: number;
  /** 拍動アニメーションが再生中か。メインビュー・シネビュー両方に影響する */
  playing: boolean;
  /** performance.now() 基準。playing=false の間は null */
  playStartedAtMs: number | null;
  /** 一時停止するたびに加算していく、再生中だった時間の累計(秒) */
  accumulatedSeconds: number;
  fps: CineFps;
  /** シネビューで心臓を薄い輪郭として表示するか(false = 完全非表示) */
  showHeartOutline: boolean;
  /**
   * true でアンギオ風の質感(コントラスト強調+ビネット+フィルムグレイン)を
   * 後処理で加える「リアルモード」。既定はfalse(従来のシンプルなシルエット表示)。
   */
  realisticMode: boolean;
  /** GIF/PNG書き出し中フラグ。true の間はライブの拍動更新を止め、書き出しループがscaleを直接制御する */
  exporting: boolean;
}
