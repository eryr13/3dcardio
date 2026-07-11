import { useEffect, useMemo, useState } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import { cameraQuaternionToCArmAngles } from "../../utils/cArmAngles";

const PRESETS: { label: string; raoLao: number; craCaud: number }[] = [
  { label: "AP", raoLao: 0, craCaud: 0 },
  { label: "RAO30/CAUD30", raoLao: 30, craCaud: -30 },
  { label: "LAO45/CRA20", raoLao: -45, craCaud: 20 },
  { label: "RAO30/CRA0", raoLao: 30, craCaud: 0 },
  { label: "LAO45/CAUD25", raoLao: -45, craCaud: -25 },
  { label: "側面(RAO90)", raoLao: 90, craCaud: 0 },
];

function formatAngle(posLabel: string, negLabel: string, value: number) {
  const rounded = Math.round(value);
  if (rounded === 0) return `${posLabel} 0°`;
  return rounded > 0 ? `${posLabel} ${rounded}°` : `${negLabel} ${-rounded}°`;
}

/** ドラッグ中は入力欄の表示だけ即時更新し、確定時(blur/Enter)にカメラを動かす数値入力 */
function AngleNumberInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(Math.round(value)));

  useEffect(() => {
    setDraft(String(Math.round(value)));
  }, [value]);

  function commit() {
    const parsed = Number(draft);
    if (!Number.isNaN(parsed)) onCommit(parsed);
  }

  return (
    <input
      type="number"
      className="carm-angle-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * サイドパネル常設のCアーム角度表示・逆算移動UI(シネビューの表示/非表示に関わらず
 * 常に見える)。現在のメインビューのカメラ姿勢からリアルタイムに角度を計算して表示し、
 * スライダー/数値入力/プリセットボタンから store.requestCameraAngles() 経由で
 * カメラをアニメーション移動させる。
 */
export function CArmReadout() {
  const cameraQuaternion = useCardioStore((s) => s.camera.quaternion);
  const calibration = useCardioStore((s) => s.calibration);
  const requestCameraAngles = useCardioStore((s) => s.requestCameraAngles);

  const angles = useMemo(
    () => cameraQuaternionToCArmAngles(cameraQuaternion, calibration),
    [cameraQuaternion, calibration],
  );

  // スライダードラッグ中は見た目だけ先行して動かし、離した時にだけカメラを動かす
  // (onChangeのたびにrequestCameraAnglesすると600msアニメーションが毎フレーム
  // やり直しになりカクつくため)。
  const [draftRaoLao, setDraftRaoLao] = useState<number | null>(null);
  const [draftCraCaud, setDraftCraCaud] = useState<number | null>(null);
  const displayRaoLao = draftRaoLao ?? angles.raoLao;
  const displayCraCaud = draftCraCaud ?? angles.craCaud;

  return (
    <section className="panel-section">
      <h2>Cアーム角度</h2>
      <p className="carm-readout">
        {formatAngle("RAO", "LAO", angles.raoLao)} / {formatAngle("CRA", "CAUD", angles.craCaud)}
      </p>

      <label className="opacity-control">
        RAO/LAO
        <input
          type="range"
          min={-180}
          max={180}
          value={displayRaoLao}
          onChange={(e) => setDraftRaoLao(Number(e.target.value))}
          onMouseUp={() => {
            if (draftRaoLao !== null) requestCameraAngles(draftRaoLao, displayCraCaud);
            setDraftRaoLao(null);
          }}
          onTouchEnd={() => {
            if (draftRaoLao !== null) requestCameraAngles(draftRaoLao, displayCraCaud);
            setDraftRaoLao(null);
          }}
        />
        <AngleNumberInput value={displayRaoLao} onCommit={(v) => requestCameraAngles(v, displayCraCaud)} />
      </label>

      <label className="opacity-control">
        CRA/CAUD
        <input
          type="range"
          min={-90}
          max={90}
          value={displayCraCaud}
          onChange={(e) => setDraftCraCaud(Number(e.target.value))}
          onMouseUp={() => {
            if (draftCraCaud !== null) requestCameraAngles(displayRaoLao, draftCraCaud);
            setDraftCraCaud(null);
          }}
          onTouchEnd={() => {
            if (draftCraCaud !== null) requestCameraAngles(displayRaoLao, draftCraCaud);
            setDraftCraCaud(null);
          }}
        />
        <AngleNumberInput value={displayCraCaud} onCommit={(v) => requestCameraAngles(displayRaoLao, v)} />
      </label>

      <div className="carm-preset-grid">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => requestCameraAngles(preset.raoLao, preset.craCaud)}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  );
}
