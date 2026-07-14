// シネビュー(平行投影/リアルX線どちらのカメラでも共通)のズーム・パン計算。
// setViewOffset() (three.jsのPerspective/OrthographicCamera共通API、タイル
// レンダリング用に本来用意されている非対称frustumオフセット機能)を流用し、
// 「仮想的に大きな検出器の一部だけを切り出して見ている」状態を作る。
// カメラのfov/left-right-top-bottom自体(=実際の投影ジオメトリ)は変更しないため、
// Cアーム角度の計算(store.camera.quaternionベース)には一切影響しない。
// また画像を拡大するたびに毎フレーム再レンダリングされるので、CSS/シェーダーでの
// 単純な拡大(案B)と違ってピクセルが粗くならない。

export interface CineZoomState {
  zoom: number;
  /** ビューポート中心からの正規化オフセット(0=中心)。ズーム量に対する比率で解釈する */
  panX: number;
  panY: number;
}

export const CINE_ZOOM_MIN = 1;
export const CINE_ZOOM_MAX = 8;
const PAN_LIMIT = 2;

export const DEFAULT_CINE_ZOOM: CineZoomState = { zoom: 1, panX: 0, panY: 0 };

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * ホイール操作によるズーム。cursorXNorm/cursorYNormはビューポート内でのカーソル位置
 * (0〜1、左上原点)。ズーム後もカーソル直下の点が同じ画面位置に留まるようpanを
 * 再計算する(「見たい血管にカーソルを合わせて拡大」できるようにするため)。
 */
export function zoomAtCursor(
  state: CineZoomState,
  cursorXNorm: number,
  cursorYNorm: number,
  zoomFactor: number,
): CineZoomState {
  const newZoom = clamp(state.zoom * zoomFactor, CINE_ZOOM_MIN, CINE_ZOOM_MAX);
  const uCursor = 0.5 + state.panX + (cursorXNorm - 0.5) / state.zoom;
  const vCursor = 0.5 + state.panY + (cursorYNorm - 0.5) / state.zoom;
  const panX = clamp(uCursor - 0.5 - (cursorXNorm - 0.5) / newZoom, -PAN_LIMIT, PAN_LIMIT);
  const panY = clamp(vCursor - 0.5 - (cursorYNorm - 0.5) / newZoom, -PAN_LIMIT, PAN_LIMIT);
  return { zoom: newZoom, panX, panY };
}

/**
 * ドラッグによるパン。dxNorm/dyNormはビューポート幅・高さに対するドラッグ移動量の比率。
 * 画面上のドラッグ量とコンテンツの見た目の移動量が常に1:1になるよう、zoomで正規化する。
 */
export function dragPan(state: CineZoomState, dxNorm: number, dyNorm: number): CineZoomState {
  return {
    zoom: state.zoom,
    panX: clamp(state.panX - dxNorm / state.zoom, -PAN_LIMIT, PAN_LIMIT),
    panY: clamp(state.panY - dyNorm / state.zoom, -PAN_LIMIT, PAN_LIMIT),
  };
}

/** setViewOffset/clearViewOffsetを受け付けるカメラの最小インターフェース */
interface ViewOffsetCamera {
  setViewOffset(fullWidth: number, fullHeight: number, x: number, y: number, width: number, height: number): void;
  clearViewOffset(): void;
}

/**
 * 現在のズーム/パン状態をカメラのview offsetとして適用する。等倍・パンなしのときは
 * setViewOffsetを呼ばずclearViewOffsetする(浮動小数誤差の蓄積を避ける)。
 * 呼び出し側でこの後 updateProjectionMatrix() を呼ぶこと。
 */
export function applyCineZoomViewOffset(
  camera: ViewOffsetCamera,
  width: number,
  height: number,
  state: CineZoomState,
): void {
  if (state.zoom <= 1 + 1e-6 && state.panX === 0 && state.panY === 0) {
    camera.clearViewOffset();
    return;
  }
  const fullWidth = width * state.zoom;
  const fullHeight = height * state.zoom;
  const centerU = 0.5 + state.panX;
  const centerV = 0.5 + state.panY;
  const x = centerU * fullWidth - width / 2;
  const y = centerV * fullHeight - height / 2;
  camera.setViewOffset(fullWidth, fullHeight, x, y, width, height);
}
