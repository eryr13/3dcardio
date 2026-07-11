// シネビューを「アンギオ像らしく」見せるための後処理(コントラスト強調・ビネット・
// フィルムグレイン)。WebGLシェーダーは使わず、レンダリング済みの2Dピクセルに対する
// Canvas2D操作だけで完結させている(既存の「標準マテリアル+ブレンディング」路線を
// 踏襲。GIF/PNG書き出し(utils/cineExport.ts)からも同じ関数を呼ぶことで、
// ライブ表示と書き出し結果の見た目を一致させている)。

export interface CineRealismParams {
  /** コントラスト強度。1=無変化、大きいほど白黒がくっきりする(中間調128を中心に伸縮) */
  contrastAmount: number;
  /** ビネット(周辺減光)の強さ。0=無し〜1=強い */
  vignetteStrength: number;
  /** フィルムグレインの不透明度 */
  grainAlpha: number;
}

export const DEFAULT_CINE_REALISM_PARAMS: CineRealismParams = {
  contrastAmount: 1.8,
  vignetteStrength: 0.55,
  grainAlpha: 0.12,
};

/** 0〜255のコントラストLUT(ルックアップテーブル)を作る。中間調128を軸に伸縮する基本的な式 */
function buildContrastLut(amount: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = (v - 128) * amount + 128;
  }
  return lut;
}

/** ImageDataのRGBチャンネルにコントラストLUTを適用する(アルファは変更しない) */
export function applyContrastCurve(imageData: ImageData, amount: number): void {
  const lut = buildContrastLut(amount);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

/** 中心が明るく周辺が暗くなる放射状グラデーションを乗算合成する(古いイメージインテンシファイアの見た目) */
export function applyVignette(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
  if (strength <= 0) return;
  const cx = width / 2;
  const cy = height / 2;
  const innerRadius = Math.min(width, height) * 0.28;
  const outerRadius = Math.max(width, height) * 0.75;
  const gradient = ctx.createRadialGradient(cx, cy, innerRadius, cx, cy, outerRadius);
  const edgeShade = Math.round(255 * (1 - strength));
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(1, `rgb(${edgeShade}, ${edgeShade}, ${edgeShade})`);

  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = prevOp;
}

// フレームごとに再生成したノイズを重ねてちらつかせる(実際の透視/シネ画像の量子モトルに近い)。
// 毎回 canvas 要素を作り直さないよう、1枚だけ使い回してImageDataだけ更新する。
let noiseCanvas: HTMLCanvasElement | null = null;

function getFreshNoiseCanvas(width: number, height: number): HTMLCanvasElement {
  if (!noiseCanvas) noiseCanvas = document.createElement("canvas");
  if (noiseCanvas.width !== width || noiseCanvas.height !== height) {
    noiseCanvas.width = width;
    noiseCanvas.height = height;
  }
  const noiseCtx = noiseCanvas.getContext("2d");
  if (!noiseCtx) return noiseCanvas;
  const imageData = noiseCtx.createImageData(width, height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.random() * 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  noiseCtx.putImageData(imageData, 0, 0);
  return noiseCanvas;
}

/** フィルムグレイン(粒状ノイズ)をoverlay合成で重ねる。中間調ほど強く効き、極端な白黒には効きにくい */
export function applyFilmGrain(ctx: CanvasRenderingContext2D, width: number, height: number, alpha: number): void {
  if (alpha <= 0) return;
  const grain = getFreshNoiseCanvas(width, height);
  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = alpha;
  ctx.drawImage(grain, 0, 0);
  ctx.globalCompositeOperation = prevOp;
  ctx.globalAlpha = prevAlpha;
}

/**
 * ctx に既に描画済みの画像に対して、コントラスト→ビネット→グレインの順で
 * まとめて適用する。ライブ表示(CineRealismOverlay.tsx)と書き出し
 * (utils/cineExport.ts)の両方から呼ばれる共通処理。
 */
export function applyCineRealism(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  params: CineRealismParams = DEFAULT_CINE_REALISM_PARAMS,
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  applyContrastCurve(imageData, params.contrastAmount);
  ctx.putImageData(imageData, 0, 0);
  applyVignette(ctx, width, height, params.vignetteStrength);
  applyFilmGrain(ctx, width, height, params.grainAlpha);
}
