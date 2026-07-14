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
  { key: "calcificationAbsorption", label: "石灰化吸収係数", min: 0.5, max: 60, step: 0.5 },
  { key: "stentAbsorption", label: "ステント吸収係数", min: 0.5, max: 80, step: 0.5 },
];

const HEART_SHADOW_SLIDERS: SliderDef[] = [
  { key: "heartShadowIntensity", label: "濃さ", min: 0, max: 1, step: 0.01, decimals: 2 },
  { key: "heartShadowSpread", label: "広がり", min: 0, max: 0.08, step: 0.001, decimals: 3 },
  { key: "heartShadowOffsetX", label: "中心位置X", min: -0.2, max: 0.2, step: 0.005, decimals: 3 },
  { key: "heartShadowOffsetY", label: "中心位置Y", min: -0.2, max: 0.2, step: 0.005, decimals: 3 },
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

      <h3 className="cine-xray-debug-subheading">心臓の陰影</h3>
      {HEART_SHADOW_SLIDERS.map(renderSlider)}
    </div>
  );
}
