import { useCardioStore } from "../../store/useCardioStore";
import type { ClippingAxis } from "../../types/anatomy";

const AXES: { id: ClippingAxis; label: string }[] = [
  { id: "x", label: "X" },
  { id: "y", label: "Y" },
  { id: "z", label: "Z" },
];

export function ClippingControls() {
  const clipping = useCardioStore((s) => s.clipping);
  const setClippingAxis = useCardioStore((s) => s.setClippingAxis);
  const resetClipping = useCardioStore((s) => s.resetClipping);

  return (
    <section className="panel-section">
      <h2>断面表示 (クリッピング)</h2>
      {AXES.map(({ id, label }) => {
        const axisState = clipping[id];
        return (
          <div className="clip-axis" key={id}>
            <label className="clip-axis-header">
              <input
                type="checkbox"
                checked={axisState.enabled}
                onChange={(e) => setClippingAxis(id, { enabled: e.target.checked })}
              />
              {label} 軸で切断
            </label>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.01}
              value={axisState.position}
              disabled={!axisState.enabled}
              onChange={(e) => setClippingAxis(id, { position: Number(e.target.value) })}
            />
          </div>
        );
      })}
      <button type="button" onClick={resetClipping}>
        断面をリセット
      </button>
    </section>
  );
}
