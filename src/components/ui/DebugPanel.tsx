import { useCardioStore } from "../../store/useCardioStore";
import { CollapsibleSection } from "./CollapsibleSection";

/**
 * 開発者向けのデバッグ表示・調整パネル。通常のUIでは不要な内部可視化や
 * 作り込みパラメータをここにまとめ、既定では非表示/既定値にしておく。
 */
export function DebugPanel() {
  const debugShowCenterlines = useCardioStore((s) => s.debugShowCenterlines);
  const setDebugShowCenterlines = useCardioStore((s) => s.setDebugShowCenterlines);
  const debugCoordinatePicker = useCardioStore((s) => s.debugCoordinatePicker);
  const setDebugCoordinatePicker = useCardioStore((s) => s.setDebugCoordinatePicker);
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
      <label className="segment-mode-toggle">
        <input
          type="checkbox"
          checked={debugCoordinatePicker}
          onChange={(e) => setDebugCoordinatePicker(e.target.checked)}
        />
        座標ピッカー(心臓メッシュをクリックすると座標をコンソールに出力)
      </label>
      {debugCoordinatePicker && (
        <p className="panel-note">
          心臓メッシュ(半透明にして内部が見える状態がおすすめ)をクリックすると、ブラウザの開発者ツールのコンソールに、クリック位置のワールド座標と、大動脈基部フレーム基準(左右/前後/頭側方向、heartScale比率)の相対座標を出力します。弁の位置など、実データの無い構造の位置を目視で特定・報告する際に使ってください。
        </p>
      )}

      <h3 className="panel-subheading">ステントの網目(オープンセル・リング構造)</h3>
      <label className="object-form-row">
        リング数(軸方向)
        <input
          type="range"
          min={2}
          max={24}
          step={1}
          value={stentLatticeParams.ringCount}
          onChange={(e) => setStentLatticeParams({ ringCount: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.ringCount}</span>
      </label>
      <label className="object-form-row">
        クラウン数(1リングあたり、周方向)
        <input
          type="range"
          min={3}
          max={12}
          step={1}
          value={stentLatticeParams.crownsPerRing}
          onChange={(e) => setStentLatticeParams({ crownsPerRing: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.crownsPerRing}</span>
      </label>
      <label className="object-form-row">
        リング間コネクタ本数
        <input
          type="range"
          min={1}
          max={4}
          step={1}
          value={stentLatticeParams.connectorsPerRing}
          onChange={(e) => setStentLatticeParams({ connectorsPerRing: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.connectorsPerRing}</span>
      </label>
      <label className="object-form-row">
        ストラットの太さ
        <input
          type="range"
          min={0.02}
          max={0.15}
          step={0.005}
          value={stentLatticeParams.strutRadiusRatio}
          onChange={(e) => setStentLatticeParams({ strutRadiusRatio: Number(e.target.value) })}
        />
        <span className="opacity-value">{stentLatticeParams.strutRadiusRatio.toFixed(3)}</span>
      </label>
    </CollapsibleSection>
  );
}
