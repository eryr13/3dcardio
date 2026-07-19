import { useEffect, useMemo } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId } from "../../types/anatomy";
import type { GuideAccessRoute } from "../../types/guideDevice";
import { getVesselGraph } from "../models/vesselGraph";
import { CollapsibleSection } from "./CollapsibleSection";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];
const VESSEL_LABELS: Record<VesselId, string> = { RCA: "RCA", LAD: "LAD", LCX: "LCX" };
const ACCESS_ROUTE_LABELS: Record<GuideAccessRoute, string> = {
  radial: "橈骨アプローチ(手首・標準的)",
  femoral: "大腿アプローチ(鼠径部)",
};

function phaseLabel(phase: number): string {
  if (phase <= 0) return "未挿入";
  if (phase < 1) return "カテーテル挿入中";
  if (phase < 2) return "ワイヤー進行中";
  return "挿入完了";
}

/**
 * Phase 9: ガイドワイヤー・ガイディングカテーテルのデモ表示の操作パネル。
 * 対象血管・目標枝の選択、表示/非表示、挿入アニメーション(進行度0〜2、0〜1で
 * カテーテルが大動脈経路を進み、1〜2でワイヤーが冠動脈中心線を進む)の再生/
 * リセット/スライダーを提供する。
 *
 * 造影剤フロー(Phase 7)のような秒単位の正確な到達時刻計算は不要な単純な
 * デモアニメーションのため、再生中はrequestAnimationFrameで直接
 * store.guideDevice.insertionPhaseを更新する(store側にelapsed時間を持たせて
 * 都度計算する方式ほどの精度は必要ない)。
 */
export function GuideDeviceControls() {
  const guideDevice = useCardioStore((s) => s.guideDevice);
  const setGuideDeviceEnabled = useCardioStore((s) => s.setGuideDeviceEnabled);
  const setGuideDeviceShowCatheter = useCardioStore((s) => s.setGuideDeviceShowCatheter);
  const setGuideDeviceShowWire = useCardioStore((s) => s.setGuideDeviceShowWire);
  const setGuideDeviceTargetVessel = useCardioStore((s) => s.setGuideDeviceTargetVessel);
  const setGuideDeviceTargetBranch = useCardioStore((s) => s.setGuideDeviceTargetBranch);
  const setGuideDeviceInsertionPhase = useCardioStore((s) => s.setGuideDeviceInsertionPhase);
  const setGuideDevicePlaying = useCardioStore((s) => s.setGuideDevicePlaying);
  const setGuideDeviceInsertionDuration = useCardioStore((s) => s.setGuideDeviceInsertionDuration);
  const setGuideDeviceAccessRoute = useCardioStore((s) => s.setGuideDeviceAccessRoute);

  const graph = useMemo(() => getVesselGraph(guideDevice.targetVesselId), [guideDevice.targetVesselId]);

  useEffect(() => {
    if (!guideDevice.playing) return;
    let raf = 0;
    let lastTime = performance.now();
    const step = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const state = useCardioStore.getState().guideDevice;
      const next = state.insertionPhase + (2 / state.insertionDurationSeconds) * dt;
      if (next >= 2) {
        setGuideDeviceInsertionPhase(2);
        setGuideDevicePlaying(false);
        return;
      }
      setGuideDeviceInsertionPhase(next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [guideDevice.playing, setGuideDeviceInsertionPhase, setGuideDevicePlaying]);

  function handlePlay() {
    // 完了状態(進行度2)から押した場合は最初からやり直す。途中から押した場合は続きから再生する。
    if (guideDevice.insertionPhase >= 2) setGuideDeviceInsertionPhase(0);
    setGuideDevicePlaying(true);
  }

  function handleReset() {
    setGuideDevicePlaying(false);
    setGuideDeviceInsertionPhase(0);
  }

  return (
    <CollapsibleSection title="ガイドワイヤー・カテーテル(β)">
      <p className="panel-note">
        PCIの基本的な状態(ガイディングカテーテルが冠動脈入口部にエンゲージし、
        ガイドワイヤーが末梢まで進んでいる状態)を再現するデモ表示です。あらかじめ
        定義した経路に沿ってモデルを配置するだけで、力学シミュレーションは行いません。
      </p>

      <label className="segment-mode-toggle">
        <input type="checkbox" checked={guideDevice.enabled} onChange={(e) => setGuideDeviceEnabled(e.target.checked)} />
        表示する
      </label>

      {guideDevice.enabled && (
        <>
          <label className="object-form-row">
            アクセスルート
            <select
              value={guideDevice.accessRoute}
              onChange={(e) => setGuideDeviceAccessRoute(e.target.value as GuideAccessRoute)}
            >
              {(Object.keys(ACCESS_ROUTE_LABELS) as GuideAccessRoute[]).map((route) => (
                <option key={route} value={route}>
                  {ACCESS_ROUTE_LABELS[route]}
                </option>
              ))}
            </select>
          </label>

          <label className="object-form-row">
            対象血管
            <select
              value={guideDevice.targetVesselId}
              onChange={(e) => setGuideDeviceTargetVessel(e.target.value as VesselId)}
            >
              {VESSEL_IDS.map((id) => (
                <option key={id} value={id}>
                  {VESSEL_LABELS[id]}
                </option>
              ))}
            </select>
          </label>

          <label className="object-form-row">
            目標の枝(ワイヤーの到達先)
            <select value={guideDevice.targetBranchId} onChange={(e) => setGuideDeviceTargetBranch(e.target.value)}>
              {graph.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.label}
                </option>
              ))}
            </select>
          </label>

          <label className="segment-mode-toggle">
            <input type="checkbox" checked={guideDevice.showCatheter} onChange={(e) => setGuideDeviceShowCatheter(e.target.checked)} />
            ガイディングカテーテルを表示
          </label>
          <label className="segment-mode-toggle">
            <input type="checkbox" checked={guideDevice.showWire} onChange={(e) => setGuideDeviceShowWire(e.target.checked)} />
            ガイドワイヤーを表示
          </label>

          <div className="cine-transport">
            <button type="button" onClick={guideDevice.playing ? () => setGuideDevicePlaying(false) : handlePlay}>
              {guideDevice.playing ? "一時停止" : "デバイスを挿入"}
            </button>
            <button type="button" onClick={handleReset}>
              リセット
            </button>
          </div>

          <label className="cine-xray-slider">
            <span>
              挿入にかける時間
              <span className="cine-xray-slider-value">{guideDevice.insertionDurationSeconds.toFixed(0)}秒</span>
            </span>
            <input
              type="range"
              min={3}
              max={30}
              step={1}
              value={guideDevice.insertionDurationSeconds}
              onChange={(e) => setGuideDeviceInsertionDuration(Number(e.target.value))}
            />
          </label>

          <label className="cine-xray-slider">
            <span>
              進行度({phaseLabel(guideDevice.insertionPhase)})
              <span className="cine-xray-slider-value">{guideDevice.insertionPhase.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.01}
              value={guideDevice.insertionPhase}
              onChange={(e) => {
                setGuideDevicePlaying(false);
                setGuideDeviceInsertionPhase(Number(e.target.value));
              }}
            />
          </label>
        </>
      )}
    </CollapsibleSection>
  );
}
