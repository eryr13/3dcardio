import { GIFEncoder, quantize, applyPalette } from "gifenc";
import { zipSync } from "fflate";
import { useCardioStore } from "../store/useCardioStore";
import type { CineSceneHandle } from "../components/models/cineSceneBridge";
import { computeHeartbeatTransform } from "./heartbeatAnimation";

/** 書き出す長さ(秒)。0.5秒周期なら4サイクル分で、ループ用途として十分な長さの定数。 */
const EXPORT_DURATION_SECONDS = 2;

interface CapturedFrames {
  width: number;
  height: number;
  frames: ImageData[];
}

/**
 * フレームごとに拍動位相を手動で指定してレンダリング → 同じタスク内で
 * drawImage + getImageData により同期的にピクセルを取得する。
 * canvas.toBlob() はコールバックが非同期でバッファ保持のタイミング保証が弱いため使わない。
 */
async function captureCineFrames(handle: CineSceneHandle, fps: number): Promise<CapturedFrames> {
  const { gl, scene, camera, pulseGroup } = handle;
  if (!camera || !pulseGroup) {
    throw new Error("シネビューの準備がまだ完了していません。少し待ってから再度お試しください。");
  }

  const canvasEl = gl.domElement;
  const width = canvasEl.width;
  const height = canvasEl.height;
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D contextの取得に失敗しました");

  const { xrayMode } = useCardioStore.getState().cine;
  const frameCount = Math.max(1, Math.round(EXPORT_DURATION_SECONDS * fps));
  const frames: ImageData[] = [];

  for (let i = 0; i < frameCount; i++) {
    const t = i / fps;
    const transform = computeHeartbeatTransform(t);
    pulseGroup.scale.set(...transform.scale);
    pulseGroup.rotation.y = transform.twistY;
    // リアルX線モード中はEffectComposer経由でレンダリングし、ライブ表示(CineXrayPostProcessing.tsx)
    // と同じポストプロセス結果を書き出しに反映する。スキーマ表示は従来通り素のgl.render。
    if (xrayMode && handle.composer) {
      handle.composer.render(1 / fps);
      // EffectComposerは血管厚みエフェクトの深度ピール用に描画ターゲットを何度も切り替える。
      // このため composer.render() 直後に即 drawImage/getImageData を呼ぶと、実機検証で
      // 空の画像を読んでしまうことを確認した(gl.finish()を挟んでも解消しない — GPUコマンドの
      // 完了待ちの問題ではなく、ブラウザ側のcanvas提示がアニメーションフレーム境界に紐づいている
      // ためと推測される)。次のrequestAnimationFrameまで待ってから読み取ることで確実に反映させる。
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    } else {
      gl.render(scene, camera);
    }
    ctx.drawImage(canvasEl, 0, 0, width, height);
    frames.push(ctx.getImageData(0, 0, width, height));
    // UIが固まらないよう数フレームごとに1tick譲る
    if (i % 4 === 3) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return { width, height, frames };
}

async function withExportingFlag<T>(task: () => Promise<T>): Promise<T> {
  const { setCineExporting } = useCardioStore.getState();
  setCineExporting(true);
  try {
    return await task();
  } finally {
    setCineExporting(false);
  }
}

export async function exportCineGif(handle: CineSceneHandle): Promise<void> {
  await withExportingFlag(async () => {
    const { fps } = useCardioStore.getState().cine;
    const { width, height, frames } = await captureCineFrames(handle, fps);

    const gif = GIFEncoder();
    const delay = 1000 / fps;
    for (const frame of frames) {
      const palette = quantize(frame.data, 256);
      const index = applyPalette(frame.data, palette);
      gif.writeFrame(index, width, height, { palette, delay, repeat: 0 });
    }
    gif.finish();

    downloadBlob(gif.bytes(), "image/gif", "cine.gif");
  });
}

export async function exportCinePngZip(handle: CineSceneHandle): Promise<void> {
  await withExportingFlag(async () => {
    const { fps } = useCardioStore.getState().cine;
    const { width, height, frames } = await captureCineFrames(handle, fps);

    const pngCanvas = document.createElement("canvas");
    pngCanvas.width = width;
    pngCanvas.height = height;
    const pngCtx = pngCanvas.getContext("2d");
    if (!pngCtx) throw new Error("2D contextの取得に失敗しました");

    const files: Record<string, [Uint8Array, { level: 0 }]> = {};
    frames.forEach((frame, i) => {
      pngCtx.putImageData(frame, 0, 0);
      const dataUrl = pngCanvas.toDataURL("image/png");
      // PNGは既に圧縮済みなのでzip側の圧縮はかけない(level:0)
      files[`frame-${String(i).padStart(3, "0")}.png`] = [dataUrlToUint8Array(dataUrl), { level: 0 }];
    });

    const zipped = zipSync(files);
    downloadBlob(zipped, "application/zip", "cine-frames.zip");
  });
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function downloadBlob(bytes: Uint8Array, mimeType: string, filename: string) {
  // bytes.buffer は型上 ArrayBufferLike(SharedArrayBufferを含む)なので、
  // BlobPart に渡せる通常のArrayBuffer裏付きコピーを作ってから渡す。
  const blob = new Blob([bytes.slice()], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
