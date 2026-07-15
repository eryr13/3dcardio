import { useEffect, useState } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import type { ContrastFlowParams } from "../../utils/contrastFlow";
import { getElapsedContrastSeconds } from "../../utils/contrastFlow";
import { CollapsibleSection } from "./CollapsibleSection";

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];
/** タイムラインスクラバーの表示上限(秒)。実際の消失時刻はwashoutパラメータ次第で前後する。 */
const TIMELINE_MAX_SECONDS = 12;

interface ParamSliderDef {
  key: keyof ContrastFlowParams;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
}

const PARAM_SLIDERS: ParamSliderDef[] = [
  { key: "baseSpeed", label: "伝播速度", min: 0.5, max: 10, step: 0.1, decimals: 1 },
  { key: "riseTime", label: "立ち上がり時間(秒)", min: 0.02, max: 1, step: 0.01, decimals: 2 },
  { key: "plateauDuration", label: "持続時間(秒)", min: 0.1, max: 5, step: 0.1, decimals: 1 },
  { key: "decayTimeConstant", label: "ウォッシュアウト時定数(秒)", min: 0.1, max: 3, step: 0.05, decimals: 2 },
];

/** playing中だけ、表示中の経過秒数(スクラバー位置)を一定間隔で再取得して再描画する。 */
function useContrastElapsedSeconds(): number {
  const contrast = useCardioStore((s) => s.contrast);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!contrast.playing) return;
    let raf = 0;
    let lastUpdateMs = 0;
    const loop = (now: number) => {
      if (now - lastUpdateMs > 80) {
        lastUpdateMs = now;
        setTick((t) => t + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [contrast.playing]);

  return getElapsedContrastSeconds(contrast);
}

/**
 * Phase 7: 造影剤フローの再生操作。「造影剤を注入」ボタンは毎回時刻0から再生し直す
 * (実際の造影剤注入操作を1回押すごとに1シーケンス再生する、という運用を模している)。
 * 再生速度倍率(playbackSpeedMultiplier)は表示上のタイムライン倍速であり、
 * 造影剤の物理的な伝播速度(伝播速度パラメータ、baseSpeed)とは別物。
 */
export function ContrastControls() {
  const contrast = useCardioStore((s) => s.contrast);
  const setContrastEnabled = useCardioStore((s) => s.setContrastEnabled);
  const injectContrast = useCardioStore((s) => s.injectContrast);
  const playContrast = useCardioStore((s) => s.playContrast);
  const pauseContrast = useCardioStore((s) => s.pauseContrast);
  const resetContrast = useCardioStore((s) => s.resetContrast);
  const seekContrast = useCardioStore((s) => s.seekContrast);
  const setContrastParam = useCardioStore((s) => s.setContrastParam);
  const setContrastPlaybackSpeed = useCardioStore((s) => s.setContrastPlaybackSpeed);
  const elapsed = useContrastElapsedSeconds();

  return (
    <CollapsibleSection title="造影剤フロー">
      <label className="segment-mode-toggle">
        <input type="checkbox" checked={contrast.enabled} onChange={(e) => setContrastEnabled(e.target.checked)} />
        造影剤フローモード
      </label>
      <p className="panel-note">
        OFF(既定)では、造影剤の有無に関わらずすべての血管が常に良好なコントラストで
        末梢まで描出されます。ONにすると、注入前は血管が写らない状態になり、
        「造影剤を注入」で起始部から末梢へ向かって段階的にコントラストがつくように
        なります(石灰化・ステントはどちらのモードでも常時表示されます)。
      </p>

      {contrast.enabled && (
        <>
          <div className="cine-transport">
            <button type="button" onClick={injectContrast}>
              造影剤を注入
            </button>
            <button type="button" onClick={contrast.playing ? pauseContrast : playContrast}>
              {contrast.playing ? "一時停止" : "再生"}
            </button>
            <button type="button" onClick={resetContrast}>
              リセット
            </button>
          </div>

          <label className="cine-fps-select">
            再生速度
            <select
              value={contrast.playbackSpeedMultiplier}
              onChange={(e) => setContrastPlaybackSpeed(Number(e.target.value))}
            >
              {SPEED_OPTIONS.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
          </label>

          <label className="cine-xray-slider">
            <span>
              タイムライン
              <span className="cine-xray-slider-value">{elapsed.toFixed(1)}s</span>
            </span>
            <input
              type="range"
              min={0}
              max={TIMELINE_MAX_SECONDS}
              step={0.1}
              value={Math.min(elapsed, TIMELINE_MAX_SECONDS)}
              onChange={(e) => seekContrast(Number(e.target.value))}
            />
          </label>

          <p className="panel-note">
            「造影剤を注入」を押すと、起始部(本幹の起点)から末梢へ向かって造影剤が伝播する
            シーケンスが最初から再生されます。狭窄・石灰化で内腔が狭くなっている区間ほど、
            そこから先への造影剤の到達が遅れます(高度狭窄や完全閉塞では、その先の領域には
            現実的な再生時間内では届きません)。
          </p>

          <div className="cine-xray-debug-panel">
            <h3>造影剤伝播 調整(開発者向け)</h3>
            {PARAM_SLIDERS.map((slider) => (
              <label key={slider.key} className="cine-xray-slider">
                <span>
                  {slider.label}
                  <span className="cine-xray-slider-value">
                    {contrast.params[slider.key].toFixed(slider.decimals)}
                  </span>
                </span>
                <input
                  type="range"
                  min={slider.min}
                  max={slider.max}
                  step={slider.step}
                  value={contrast.params[slider.key]}
                  onChange={(e) => setContrastParam(slider.key, Number(e.target.value))}
                />
              </label>
            ))}
          </div>
        </>
      )}
    </CollapsibleSection>
  );
}
