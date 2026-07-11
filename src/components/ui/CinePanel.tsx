import { useEffect, useRef } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import { CineScene } from "../viewer/CineScene";
import { CineRealismOverlay } from "../viewer/CineRealismOverlay";
import { cineSceneBridge } from "../models/cineSceneBridge";

/**
 * シネビュー(X線風平行投影)パネル。cine.enabled が false の間はCanvas自体を
 * マウントしない(=描画コストを払わない)。アンマウント時は古い参照が残らないよう
 * cineSceneBridge をリセットする。
 * 左端の <div className="cine-resize-handle"> をドラッグすると panelWidth
 * (store)が更新され、メインビューを狭めてシネビューを広げられる。
 */
export function CinePanel() {
  const enabled = useCardioStore((s) => s.cine.enabled);
  const panelWidth = useCardioStore((s) => s.cine.panelWidth);
  const setCinePanelWidth = useCardioStore((s) => s.setCinePanelWidth);
  const draggingRef = useRef(false);

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

  if (!enabled) return null;

  function startDragging() {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <section className="cine-panel" style={{ width: panelWidth }}>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div className="cine-resize-handle" onMouseDown={startDragging} />
      <h2 className="cine-panel-title">シネビュー(X線風投影)</h2>
      <div className="cine-canvas-wrap">
        <CineScene />
        <CineRealismOverlay />
      </div>
      <p className="panel-note">
        メインビューのカメラ視線方向を投影方向とした簡易X線風シルエットです。実際のDRR(透視像)ではありません。
      </p>
    </section>
  );
}
