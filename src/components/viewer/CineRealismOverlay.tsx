import { useEffect, useRef } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import { cineSceneBridge } from "../models/cineSceneBridge";
import { applyCineRealism } from "../../utils/cineRealism";

/**
 * シネCanvas(WebGL)の上に重ねる2DオーバーレイCanvas。「リアルモード」がONの間だけ
 * 自前のrequestAnimationFrameループでWebGLキャンバスの内容を読み取り、コントラスト
 * 強調・ビネット・フィルムグレインを適用した結果を表示する。WebGL側のCanvasは
 * (書き出し処理からも読み取れるよう)そのまま裏で描画を続けさせ、CSS側で見た目だけ
 * 隠す(CinePanel.tsx / App.css 参照)。
 * cine.fps に合わせて更新頻度を間引き、メインの拍動アニメーションと同じ
 * 「コマ落ち感」を出しつつ負荷も抑える。
 */
export function CineRealismOverlay() {
  const realisticMode = useCardioStore((s) => s.cine.realisticMode);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastDrawAtRef = useRef(0);

  useEffect(() => {
    if (!realisticMode) return;

    let rafId: number;
    const loop = () => {
      rafId = requestAnimationFrame(loop);

      const { fps } = useCardioStore.getState().cine;
      const now = performance.now();
      if (now - lastDrawAtRef.current < 1000 / fps) return;
      lastDrawAtRef.current = now;

      const handle = cineSceneBridge.current;
      const overlayCanvas = canvasRef.current;
      if (!handle || !overlayCanvas) return;

      const source = handle.gl.domElement;
      if (overlayCanvas.width !== source.width || overlayCanvas.height !== source.height) {
        overlayCanvas.width = source.width;
        overlayCanvas.height = source.height;
      }
      const ctx = overlayCanvas.getContext("2d");
      if (!ctx) return;

      ctx.drawImage(source, 0, 0, overlayCanvas.width, overlayCanvas.height);
      applyCineRealism(ctx, overlayCanvas.width, overlayCanvas.height);
    };
    rafId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(rafId);
  }, [realisticMode]);

  if (!realisticMode) return null;

  return <canvas ref={canvasRef} className="cine-realism-canvas" />;
}
