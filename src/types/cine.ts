// シネビュー(X線風平行投影 + 拍動ループ再生)に関する状態の型定義。
// anatomy.ts とは関心が別(表示スタイルではなく再生・書き出し制御)なので分離している。

export type CineFps = 15 | 30;

/**
 * リアルX線モードの見た目調整パラメータ(デバッグパネルのスライダーで変更できる)。
 * 値の意味は utils/cineRealism.ts の旧パラメータとは別物(シェーダー/ポストプロセス
 * パイプライン用)なので混同しないこと。
 */
export interface CineXrayParams {
  /** 画面ノイズ(量子モトル)の強さ。0〜1程度 */
  noiseIntensity: number;
  /** 血管輪郭のにじみ(ブラー)量。0〜1程度 */
  blurAmount: number;
  /** ビネット(周辺減光)の強さ。0〜1程度 */
  vignetteStrength: number;
  /** トーンカーブのコントラスト。0〜1(0.5=無変化相当) */
  contrast: number;
  /** 血管濃淡のBeer-Lambert吸収係数。大きいほど同じ太さでも濃く見える */
  vesselAbsorption: number;
  /** 横隔膜/脊椎のダミーシルエットを背景に薄く表示するか(低優先度オプション) */
  showBackgroundAnatomy: boolean;
  /** 心臓の陰影の濃さの上限キャップ。0〜1(血管ほど暗くならないよう頭打ちにする) */
  heartShadowIntensity: number;
  /** 心臓の陰影のぼかし半径(UV単位)。血管のブラーより広めにして輪郭を曖昧にする */
  heartShadowSpread: number;
  /** 心臓の陰影の見かけ上の中心位置、水平オフセット(UV単位) */
  heartShadowOffsetX: number;
  /** 心臓の陰影の見かけ上の中心位置、垂直オフセット(UV単位) */
  heartShadowOffsetY: number;
  /** true で心臓の陰影を非表示にし、冠動脈のみを表示する(見た目の完成度が低い心臓陰影を隠すためのオプション) */
  vesselsOnly: boolean;
}

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
   * true で透視投影+血管厚み積算+GPUポストプロセスによる「リアルX線モード」に切り替える。
   * 既定はfalse(従来のシンプルなシルエット表示=スキーマ表示)。
   */
  xrayMode: boolean;
  xrayParams: CineXrayParams;
  /** GIF/PNG書き出し中フラグ。true の間はライブの拍動更新を止め、書き出しループがscaleを直接制御する */
  exporting: boolean;
}
