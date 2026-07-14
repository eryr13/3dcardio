import { useState } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import type { CineFps } from "../../types/cine";
import { cineSceneBridge } from "../models/cineSceneBridge";
import { exportCineGif, exportCinePngZip } from "../../utils/cineExport";
import { CineXrayDebugPanel } from "./CineXrayDebugPanel";
import { CollapsibleSection } from "./CollapsibleSection";

const FPS_OPTIONS: CineFps[] = [15, 30];

/**
 * シネビューの操作一式。再生/一時停止はメインビュー・シネビュー両方の拍動に効くため
 * (常に拍動する仕様のため)、シネパネルの外であるサイドパネルに常設している。
 */
export function CineControls() {
  const cine = useCardioStore((s) => s.cine);
  const setCineEnabled = useCardioStore((s) => s.setCineEnabled);
  const playCine = useCardioStore((s) => s.playCine);
  const pauseCine = useCardioStore((s) => s.pauseCine);
  const setCineFps = useCardioStore((s) => s.setCineFps);
  const setCineShowHeartOutline = useCardioStore((s) => s.setCineShowHeartOutline);
  const setCineXrayMode = useCardioStore((s) => s.setCineXrayMode);
  const setCineXrayParam = useCardioStore((s) => s.setCineXrayParam);
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleExport(kind: "gif" | "png") {
    setExportError(null);
    const handle = cineSceneBridge.current;
    if (!handle) {
      setExportError("シネビューを表示してから書き出してください。");
      return;
    }
    try {
      if (kind === "gif") await exportCineGif(handle);
      else await exportCinePngZip(handle);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "書き出しに失敗しました。");
    }
  }

  return (
    <CollapsibleSection title="シネ画像">
      <label className="segment-mode-toggle">
        <input type="checkbox" checked={cine.enabled} onChange={(e) => setCineEnabled(e.target.checked)} />
        シネビューを表示
      </label>

      <div className="cine-transport">
        <button type="button" onClick={cine.playing ? pauseCine : playCine}>
          {cine.playing ? "一時停止" : "再生"}
        </button>
        <label className="cine-fps-select">
          フレームレート
          <select value={cine.fps} onChange={(e) => setCineFps(Number(e.target.value) as CineFps)}>
            {FPS_OPTIONS.map((fps) => (
              <option key={fps} value={fps}>
                {fps} fps
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="segment-mode-toggle">
        <input
          type="checkbox"
          checked={cine.showHeartOutline}
          disabled={!cine.enabled}
          onChange={(e) => setCineShowHeartOutline(e.target.checked)}
        />
        心臓の輪郭を表示(シネビュー)
      </label>

      <label className="segment-mode-toggle">
        <input
          type="checkbox"
          checked={cine.xrayMode}
          disabled={!cine.enabled}
          onChange={(e) => setCineXrayMode(e.target.checked)}
        />
        リアルX線表示に切り替え
      </label>
      {cine.xrayMode && (
        <>
          <p className="panel-note">
            透視投影(点X線源からの円錐投影)+血管の厚み積算+ノイズ/ブラー/ビネットの
            ポストプロセスを加えたリアルX線風表示です。オフにするといつものシンプルな
            スキーマ表示(平行投影シルエット)に戻ります。
          </p>
          <label className="segment-mode-toggle">
            <input
              type="checkbox"
              checked={cine.xrayParams.vesselsOnly}
              onChange={(e) => setCineXrayParam("vesselsOnly", e.target.checked)}
            />
            冠動脈のみ表示(心臓の陰影を隠す)
          </label>
          <CineXrayDebugPanel />
        </>
      )}

      <div className="cine-export-buttons">
        <button type="button" disabled={!cine.enabled || cine.exporting} onClick={() => handleExport("gif")}>
          {cine.exporting ? "書き出し中…" : "GIFを書き出す"}
        </button>
        <button type="button" disabled={!cine.enabled || cine.exporting} onClick={() => handleExport("png")}>
          {cine.exporting ? "書き出し中…" : "PNG連番を書き出す(zip)"}
        </button>
      </div>
      {exportError && <p className="panel-note cine-export-error">{exportError}</p>}
      <p className="panel-note">
        拍動アニメーションは0.5秒周期(収縮は素早く、拡張はゆっくり)・長軸方向優位の収縮+軽い捻れを
        近似したプレースホルダーです(実データ差し替え予定)。既定は静止状態で、「再生」を押すと動き始めます。
      </p>
    </CollapsibleSection>
  );
}
