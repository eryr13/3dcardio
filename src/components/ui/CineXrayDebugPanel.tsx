import { useCardioStore } from "../../store/useCardioStore";
import type { CineXrayParams } from "../../types/cine";

type NumericXrayParamKey = Exclude<keyof CineXrayParams, "showBackgroundAnatomy" | "vesselsOnly">;

interface SliderDef {
  key: NumericXrayParamKey;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals?: number;
}

const SLIDERS: SliderDef[] = [
  { key: "noiseIntensity", label: "ノイズ強度", min: 0, max: 1, step: 0.01 },
  { key: "blurAmount", label: "ブラー量", min: 0, max: 1, step: 0.01 },
  { key: "vignetteStrength", label: "ビネット強度", min: 0, max: 1, step: 0.01 },
  { key: "contrast", label: "コントラスト", min: 0, max: 1, step: 0.01 },
  { key: "vesselAbsorption", label: "血管吸収係数", min: 0.5, max: 30, step: 0.5 },
  // 実際の透視での石灰化は「造影された血管より明確に淡い、境界のぼやけた陰影」
  // (types/cine.tsのcalcificationAbsorptionコメント参照)なので、既定値・実用域とも
  // vesselAbsorptionより明確に小さい。
  { key: "calcificationAbsorption", label: "石灰化吸収係数", min: 0.1, max: 20, step: 0.1, decimals: 1 },
  { key: "stentAbsorption", label: "ステント吸収係数", min: 0.5, max: 400, step: 1 },
  // 心筋(心臓の陰影)も血管・石灰化・ステントと同じBeer-Lambert吸収係数として扱う
  // (別立てのopacityキャップではない)。造影剤(血管)より十分小さい値が既定。
  { key: "heartAbsorption", label: "心筋吸収係数", min: 0.1, max: 10, step: 0.1, decimals: 1 },
];

/**
 * リアルX線モード限定の開発者向け微調整パネル。xrayMode時のみ CineControls から表示される。
 * 値は store.cine.xrayParams に直接反映され、CineXrayPostProcessing / CineVesselThicknessEffect が読む。
 */
export function CineXrayDebugPanel() {
  const params = useCardioStore((s) => s.cine.xrayParams);
  const setCineXrayParam = useCardioStore((s) => s.setCineXrayParam);

  function renderSlider(slider: SliderDef) {
    return (
      <label key={slider.key} className="cine-xray-slider">
        <span>
          {slider.label}
          <span className="cine-xray-slider-value">{params[slider.key].toFixed(slider.decimals ?? 2)}</span>
        </span>
        <input
          type="range"
          min={slider.min}
          max={slider.max}
          step={slider.step}
          value={params[slider.key]}
          onChange={(e) => setCineXrayParam(slider.key, Number(e.target.value))}
        />
      </label>
    );
  }

  return (
    <div className="cine-xray-debug-panel">
      <h3>リアルX線モード 調整(開発者向け)</h3>
      {SLIDERS.map(renderSlider)}
      <label className="segment-mode-toggle">
        <input
          type="checkbox"
          checked={params.showBackgroundAnatomy}
          onChange={(e) => setCineXrayParam("showBackgroundAnatomy", e.target.checked)}
        />
        横隔膜/脊椎のダミーシルエットを表示
      </label>
    </div>
  );
}
