import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId } from "../../types/anatomy";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];

/**
 * 心臓・血管の表示/非表示を切り替える最小限のリスト。
 * 色/不透明度の編集UIはPhase 2で追加予定(store側は既に対応済み)。
 */
export function AnatomyLegend() {
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);
  const setHeartDisplay = useCardioStore((s) => s.setHeartDisplay);
  const setVesselDisplay = useCardioStore((s) => s.setVesselDisplay);

  return (
    <section className="panel-section">
      <h2>表示オブジェクト</h2>
      <ul className="anatomy-legend">
        <li>
          <label>
            <input
              type="checkbox"
              checked={heart.visible}
              onChange={(e) => setHeartDisplay({ visible: e.target.checked })}
            />
            <span className="legend-swatch" style={{ backgroundColor: heart.color }} />
            {heart.name}
          </label>
        </li>
        {VESSEL_IDS.map((id) => {
          const vessel = vessels[id];
          return (
            <li key={id}>
              <label>
                <input
                  type="checkbox"
                  checked={vessel.visible}
                  onChange={(e) => setVesselDisplay(id, { visible: e.target.checked })}
                />
                <span className="legend-swatch" style={{ backgroundColor: vessel.color }} />
                {vessel.name}
              </label>
            </li>
          );
        })}
      </ul>
      <p className="panel-note">色分け・不透明度の個別編集はPhase 2で追加予定です。</p>
    </section>
  );
}
