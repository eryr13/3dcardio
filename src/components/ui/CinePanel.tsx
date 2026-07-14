import { useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import { CineScene } from "../viewer/CineScene";
import { cineSceneBridge } from "../models/cineSceneBridge";

/** ホイール1「クリック」相当(deltaY≈100)あたりの倍率。deltaYに比例させ滑らかにする */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/**
 * シネビュー(X線風平行投影)パネル。cine.enabled が false の間はCanvas自体を
 * マウントしない(=描画コストを払わない)。アンマウント時は古い参照が残らないよう
 * cineSceneBridge をリセットする。
 * 左端の <div className="cine-resize-handle"> をドラッグすると panelWidth
 * (store)が更新され、メインビューを狭めてシネビューを広げられる。
 *
 * ズーム(マウスホイール、カーソル位置中心)・パン(ドラッグ)は、この
 * .cine-canvas-wrap の上で完結する独立した操作系として実装している
 * (メインビューのOrbitControlsとは無関係。3Dビュー側のカメラ回転操作と
 * 混同しないよう、シネビューには「回転」に相当する概念自体が無い
 * ——投影方向は常にメインビューのカメラ向きに追従するため、ドラッグは
 * すべてパンとして扱ってよい)。
 */
export function CinePanel() {
  const enabled = useCardioStore((s) => s.cine.enabled);
  const panelWidth = useCardioStore((s) => s.cine.panelWidth);
  const setCinePanelWidth = useCardioStore((s) => s.setCinePanelWidth);
  const zoom = useCardioStore((s) => s.cine.zoom);
  const zoomCineAtCursor = useCardioStore((s) => s.zoomCineAtCursor);
  const panCine = useCardioStore((s) => s.panCine);
  const resetCineZoom = useCardioStore((s) => s.resetCineZoom);
  const draggingRef = useRef(false);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const panDragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);

  useEffect(() => {
    if (!enabled) cineSceneBridge.current = null;
  }, [enabled]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      // シネパネルは画面右端に固定なので、幅 = ウィンドウ右端からカーソルまでの距離
      setCinePanelWidth(window.innerWidth - e.clientX);
    }
    function stopDragging() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stopDragging);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stopDragging);
    };
  }, [setCinePanelWidth]);

  // ホイールでのズームは e.preventDefault() でページスクロールを止める必要があるが、
  // Reactのonoheel(JSX)はReact 17以降パッシブリスナーとして登録されるため
  // preventDefault()が効かない。ネイティブのaddEventListenerで{passive:false}を
  // 明示して登録する。
  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = el!.getBoundingClientRect();
      const cursorXNorm = (e.clientX - rect.left) / rect.width;
      const cursorYNorm = (e.clientY - rect.top) / rect.height;
      const zoomFactor = Math.exp(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
      zoomCineAtCursor(cursorXNorm, cursorYNorm, zoomFactor);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // canvasWrapRef.current は enabled が false の間 null (divが未マウント) なので、
    // enabled が true になった直後(divマウント後)に改めて登録し直す必要がある。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return null;

  function startDragging() {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function onCanvasPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest("button")) return;
    panDragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onCanvasPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const dxNorm = (e.clientX - drag.lastX) / rect.width;
    const dyNorm = (e.clientY - drag.lastY) / rect.height;
    panDragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    panCine(dxNorm, dyNorm);
  }

  function onCanvasPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (panDragRef.current?.pointerId === e.pointerId) panDragRef.current = null;
  }

  return (
    <section className="cine-panel" style={{ width: panelWidth }}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="cine-resize-handle" onMouseDown={startDragging} />
      <h2 className="cine-panel-title">シネビュー(X線風投影)</h2>
      <div
        ref={canvasWrapRef}
        className="cine-canvas-wrap"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      >
        <CineScene />
        <div className="cine-zoom-readout">
          <span>{zoom.zoom.toFixed(1)}x</span>
          <button type="button" onClick={resetCineZoom} disabled={zoom.zoom === 1 && zoom.panX === 0 && zoom.panY === 0}>
            全体表示にリセット
          </button>
        </div>
      </div>
      <p className="panel-note">
        メインビューのカメラ視線方向を投影方向とした簡易X線風シルエットです。実際のDRR(透視像)ではありません。
        <br />
        ホイールでズーム(カーソル位置中心)、ドラッグでパンできます。
      </p>
    </section>
  );
}
