import { useCardioStore } from "../../store/useCardioStore";
import { CollapsibleSection } from "./CollapsibleSection";

/**
 * 開発者向けのデバッグ表示・調整パネル。通常のUIでは不要な内部可視化や
 * 作り込みパラメータをここにまとめ、既定では非表示/既定値にしておく。
 */
export function DebugPanel() {
  const debugShowCenterlines = useCardioStore((s) => s.debugShowCenterlines);
  const setDebugShowCenterlines = useCardioStore((s) => s.setDebugShowCenterlines);
  const stentLatticeParams = useCardioStore((s) => s.stentLatticeParams);
  const setStentLatticeParams = useCardioStore((s) => s.setStentLatticeParams);

  return (
    <CollapsibleSection title="デバッグ (開発者向け)">
      <label className="segment-mode-toggle">
        <input
          type="checkbox"
          checked={debugShowCenterlines}
          onChange={(e) => setDebugShowCenterlines(e.target.checked)}
        />
        中心線グラフを3Dビューに表示(本幹=白、側枝=色分け)
      </label>

      <h3 className="panel-subheading">ステントの網目(ストラット)</h3>
      <label className="object-form-row">
        本数(周方向)
        <input
          type="range"
          min={4}
          max={16}
          step={1}
          value={stentLatticeParams.strutCount}
          onChange={(e) => setStentLatticeParams({ strutCount: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.strutCount}</span>
      </label>
      <label className="object-form-row">
        ジグザグ数(軸方向)
        <input
          type="range"
          min={2}
          max={20}
          step={1}
          value={stentLatticeParams.crossingsPerWire}
          onChange={(e) => setStentLatticeParams({ crossingsPerWire: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.crossingsPerWire}</span>
      </label>
      <label className="object-form-row">
        ストラットの太さ
        <input
          type="range"
          min={0.05}
          max={0.3}
          step={0.01}
          value={stentLatticeParams.strutRadiusRatio}
          onChange={(e) => setStentLatticeParams({ strutRadiusRatio: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.strutRadiusRatio.toFixed(2)}</span>
      </label>
    </CollapsibleSection>
  );
}
