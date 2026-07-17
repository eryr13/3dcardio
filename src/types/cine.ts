// シネビュー(X線風平行投影 + 拍動ループ再生)に関する状態の型定義。
// anatomy.ts とは関心が別(表示スタイルではなく再生・書き出し制御)なので分離している。

import type { CineZoomState } from "../utils/cineZoom";

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
  /** 血管(造影剤)濃淡のBeer-Lambert吸収係数。大きいほど同じ太さでも濃く見える */
  vesselAbsorption: number;
  /**
   * 石灰化プラークのBeer-Lambert吸収係数。実際の透視では、石灰化は非造影でも
   * 認識できる数少ない構造の一つだが、その見え方は「淡い灰色の、境界のぼやけた
   * 陰影」であり、造影剤が満ちた血管ほど濃く・くっきりとは写らない。そのため
   * 既定値はvesselAbsorptionより明確に小さく、「造影された血管 > 石灰化」という
   * 濃さの関係が常に成り立つようにしている(石灰化の厚みは通常、血管の生厚み
   * (直径)より薄いこと(局所血管半径×thickness/100程度)も合わせて、この差を
   * 広げる方向に働く)。造影剤注入後は、石灰化がその区間の血管濃度に軽く上乗せ
   * される程度になり、不自然に浮き出て見えることはない。
   *
   * 以前、石灰化シェルの外径/内径ジオメトリの巻き順(法線の向き)に不具合があり、
   * 外径面・内径面が深度ピールで正しく相殺されず単純加算されてしまっていたため
   * (深度ピールの前面/背面パスがどちらも「背面」側に分類され、前面分と背面分が
   * 相殺せず単純加算されてしまい、実際の材質厚みではなく視点からの距離スケールの
   * 桁違いに大きい値になっていた)、この係数をどれだけ下げても真っ黒になる不具合が
   * あった。calcificationMesh.tsのtriangulateRadialGridで外径面の巻き順を反転する
   * 修正によりこれを解消したため、今はこの係数が実際の材質厚みに比例して
   * 正しく効く。
   */
  calcificationAbsorption: number;
  /**
   * ステント(ストラット)のBeer-Lambert吸収係数。金属は石灰化よりさらに吸収が高いため、
   * 既定値は calcificationAbsorption よりさらに大きくしてある。
   */
  stentAbsorption: number;
  /**
   * Phase 9: ガイディングカテーテルのBeer-Lambert吸収係数。カテーテルは血管と同程度の
   * 太さがあるため、ステントのような極端な係数は不要——vesselAbsorptionより明確に
   * 大きい程度で「はっきりした管状の陰影」になる。
   */
  catheterAbsorption: number;
  /**
   * Phase 9: ガイドワイヤーのBeer-Lambert吸収係数。ワイヤーはステントのストラットと
   * 同程度に細い金属線のため、既定値もstentAbsorptionと同程度の大きさにしてある。
   */
  wireAbsorption: number;
  /** 横隔膜/脊椎のダミーシルエットを背景に薄く表示するか(低優先度オプション) */
  showBackgroundAnatomy: boolean;
  /**
   * 心筋(心臓の陰影)のBeer-Lambert吸収係数。血管・石灰化・ステントと全く同じ物理量
   * (X線減弱係数)として扱い、最終的な濃淡は「心臓による減弱+血管による減弱+...」を
   * 単一の指数減衰にまとめて計算する(心臓の陰影を血管の上に重なる不透明な層として
   * 別合成しない)。実際の造影剤は心筋よりX線吸収が桁違いに高いため、既定値は
   * vesselAbsorptionより十分小さくしてあり、どんなカメラ角度で心臓の陰影が濃くなっても
   * 造影された冠動脈のコントラストが埋もれることはない。
   */
  heartAbsorption: number;
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
  /**
   * シネビュー独自のズーム・パン状態(メインビューのカメラ操作とは完全に独立)。
   * スキーマ表示(OrthographicCamera)・リアルX線モード(PerspectiveCamera)の
   * どちらでも同じ値を view offset として適用する。詳細は utils/cineZoom.ts 参照。
   */
  zoom: CineZoomState;
}
