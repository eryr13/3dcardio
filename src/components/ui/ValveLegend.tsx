import type { ValveId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import { CollapsibleSection } from "./CollapsibleSection";

const VALVE_IDS: readonly ValveId[] = ["AORTIC", "PULMONARY", "MITRAL", "TRICUSPID"];

function opacityToPercent(opacity: number) {
  return Math.round(opacity * 100);
}

/**
 * 4つの弁(大動脈弁・肺動脈弁・僧帽弁・三尖弁)の表示/非表示・不透明度を編集する
 * コントロール群。位置は実セグメンテーションではなく、冠動脈入口部から逆算した
 * 大動脈基部の位置を起点に、解剖学的な位置関係からの推定であることをUI上に明記する
 * (heartValveMesh.ts参照、大動脈基部の簡易形状と同じ扱い)。
 */
export function ValveLegend() {
  const valves = useCardioStore((s) => s.valves);
  const setValveDisplay = useCardioStore((s) => s.setValveDisplay);
  const setAllValvesVisible = useCardioStore((s) => s.setAllValvesVisible);

  const allVisible = VALVE_IDS.every((id) => valves[id].visible);
  const anyVisible = VALVE_IDS.some((id) => valves[id].visible);

  return (
    <CollapsibleSection title="弁">
      <p className="panel-note">
        冠動脈入口部の位置から逆算した大動脈基部を起点に、解剖学的な位置関係から推定して配置した簡易形状です(実際のCTデータからセグメンテーションしたものではありません)。大動脈基部の円筒が大動脈弁の直上にあり、肺動脈弁とは別の位置にあることを確認する目的で使えます。
      </p>
      <label className="segment-mode-toggle">
        <input
          type="checkbox"
          checked={allVisible}
          ref={(el) => {
            if (el) el.indeterminate = anyVisible && !allVisible;
          }}
          onChange={(e) => setAllValvesVisible(e.target.checked)}
        />
        すべての弁をまとめて表示
      </label>
      <ul className="anatomy-legend">
        {VALVE_IDS.map((id) => {
          const valve = valves[id];
          return (
            <li className="anatomy-item" key={id}>
              <label className="anatomy-item-header">
                <input
                  type="checkbox"
                  checked={valve.visible}
                  onChange={(e) => setValveDisplay(id, { visible: e.target.checked })}
                />
                <input
                  type="color"
                  className="color-picker"
                  value={valve.color}
                  onChange={(e) => setValveDisplay(id, { color: e.target.value })}
                  aria-label={`${valve.name}の色`}
                />
                {valve.name}
              </label>
              <label className="opacity-control">
                不透明度
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={opacityToPercent(valve.opacity)}
                  onChange={(e) => setValveDisplay(id, { opacity: Number(e.target.value) / 100 })}
                />
                <span className="opacity-value">{opacityToPercent(valve.opacity)}%</span>
              </label>
            </li>
          );
        })}
      </ul>
    </CollapsibleSection>
  );
}
