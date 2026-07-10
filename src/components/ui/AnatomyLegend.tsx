import { useCardioStore } from "../../store/useCardioStore";

function opacityToPercent(opacity: number) {
  return Math.round(opacity * 100);
}

/**
 * 心臓・冠動脈の表示/非表示・色・不透明度を編集するコントロール群。
 * 冠動脈は store の vessels を Object.values() で列挙しているため、
 * 将来 AHA セグメント単位のエントリが増えてもこのコンポーネントは変更不要。
 */
export function AnatomyLegend() {
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);
  const segmentMode = useCardioStore((s) => s.segmentMode);
  const setHeartDisplay = useCardioStore((s) => s.setHeartDisplay);
  const setVesselDisplay = useCardioStore((s) => s.setVesselDisplay);
  const toggleSegmentMode = useCardioStore((s) => s.toggleSegmentMode);
  const resetDisplayDefaults = useCardioStore((s) => s.resetDisplayDefaults);

  const vesselList = Object.values(vessels);

  return (
    <section className="panel-section">
      <h2>心臓</h2>
      <div className="anatomy-item">
        <label className="anatomy-item-header">
          <input
            type="checkbox"
            checked={heart.visible}
            onChange={(e) => setHeartDisplay({ visible: e.target.checked })}
          />
          <span className="legend-swatch" style={{ backgroundColor: heart.color }} />
          {heart.name}
        </label>
        <label className="opacity-control">
          不透明度
          <input
            type="range"
            min={0}
            max={100}
            value={opacityToPercent(heart.opacity)}
            onChange={(e) => setHeartDisplay({ opacity: Number(e.target.value) / 100 })}
          />
          <span className="opacity-value">{opacityToPercent(heart.opacity)}%</span>
        </label>
      </div>

      <h2>冠動脈</h2>
      <label className="segment-mode-toggle">
        <input type="checkbox" checked={segmentMode} onChange={toggleSegmentMode} />
        セグメント単位で色分け(β)
      </label>
      {segmentMode && (
        <p className="panel-note">
          3D表示上で血管にカーソルを合わせるとセグメント名がツールチップ表示されます。区切りは幹の長さに沿った機械的な等分割で、実際のAHA分類の解剖学的境界とは一致しません。
        </p>
      )}
      <ul className="anatomy-legend">
        {vesselList.map((vessel) => (
          <li className="anatomy-item" key={vessel.id}>
            <label className="anatomy-item-header">
              <input
                type="checkbox"
                checked={vessel.visible}
                onChange={(e) => setVesselDisplay(vessel.id, { visible: e.target.checked })}
              />
              <input
                type="color"
                className="color-picker"
                value={vessel.color}
                onChange={(e) => setVesselDisplay(vessel.id, { color: e.target.value })}
                aria-label={`${vessel.name}の色`}
              />
              {vessel.name}
            </label>
            <label className="opacity-control">
              不透明度
              <input
                type="range"
                min={0}
                max={100}
                value={opacityToPercent(vessel.opacity)}
                onChange={(e) => setVesselDisplay(vessel.id, { opacity: Number(e.target.value) / 100 })}
              />
              <span className="opacity-value">{opacityToPercent(vessel.opacity)}%</span>
            </label>
          </li>
        ))}
      </ul>
      <button type="button" className="reset-display-button" onClick={resetDisplayDefaults}>
        色・不透明度をリセット
      </button>
    </section>
  );
}
