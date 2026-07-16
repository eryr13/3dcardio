import { useCardioStore } from "../../store/useCardioStore";
import type { PerfusionMode } from "../../types/perfusion";
import { CollapsibleSection } from "./CollapsibleSection";

const MODE_OPTIONS: { value: PerfusionMode; label: string }[] = [
  { value: "off", label: "OFF(通常表示)" },
  { value: "territory", label: "灌流テリトリー表示" },
  { value: "ischemia", label: "虚血マップ表示" },
];

/**
 * Phase 8: 心筋灌流領域・虚血表示の切り替え。造影剤フローモード(Phase 7)とは独立して
 * 常時反映される静的な表示で、「造影剤を注入」等の再生操作は不要——狭窄・石灰化の
 * 配置・重症度を変えた瞬間に、対応する心筋領域の色がそのまま更新される。
 */
export function PerfusionControls() {
  const perfusionMode = useCardioStore((s) => s.perfusion.mode);
  const setPerfusionMode = useCardioStore((s) => s.setPerfusionMode);

  return (
    <CollapsibleSection title="心筋灌流(β)">
      <div className="carm-preset-grid">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={perfusionMode === option.value ? "axis-preset-button active" : "axis-preset-button"}
            onClick={() => setPerfusionMode(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {perfusionMode === "territory" && (
        <p className="panel-note">
          各心筋領域を、それを灌流する血管の枝の色(既存の血管色に対応)で塗り分けます。
          RCA/LAD/LCXそれぞれの色ピッカーを変更すると、この表示にも反映されます。
        </p>
      )}
      {perfusionMode === "ischemia" && (
        <p className="panel-note">
          各心筋領域を、その領域を灌流する枝の血流充足度(緑=正常、黄〜オレンジ=虚血、
          赤〜暗色=梗塞相当)で塗り分けます。狭窄・石灰化の重症度を変更するとリアルタイムに
          更新されます。この充足度はPhase 7の造影剤フローが参照する最大到達濃度と同じもので、
          「造影剤を注入」を押していなくても常に現在の狭窄配置を反映します。
        </p>
      )}
    </CollapsibleSection>
  );
}
