import { useCardioStore } from "../../store/useCardioStore";

const HEAD_AXIS_PRESETS: { label: string; axis: [number, number, number] }[] = [
  { label: "+X", axis: [1, 0, 0] },
  { label: "-X", axis: [-1, 0, 0] },
  { label: "+Y", axis: [0, 1, 0] },
  { label: "-Y", axis: [0, -1, 0] },
  { label: "+Z", axis: [0, 0, 1] },
  { label: "-Z", axis: [0, 0, -1] },
];

function isSameAxis(a: [number, number, number], b: [number, number, number]) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * 患者解剖座標系のキャリブレーション。「頭側の軸を選ぶ」+「現在の視点をAP正面として
 * 記録する」の2アクションだけで、Cアーム角度計算に必要な3自由度の回転が確定する
 * (残りの左右軸は utils/cArmAngles.ts の deriveCalibrationBasis が自動的に導出する)。
 */
export function CArmCalibration() {
  const headAxis = useCardioStore((s) => s.calibration.headAxis);
  const setHeadAxis = useCardioStore((s) => s.setHeadAxis);
  const setApAxisFromCurrentCamera = useCardioStore((s) => s.setApAxisFromCurrentCamera);

  return (
    <section className="panel-section">
      <h2>解剖座標キャリブレーション</h2>
      <p className="panel-note">
        メインビューの軸表示(黄=頭側 / 青=AP)を見ながら、①だいたいの頭側の軸を選び、
        ②視点を患者の正面(AP)に合わせてボタンを押してください。②を押した時点の視点が
        常にRAO/LAO・CRA/CAUDともに0°の基準になります(①はその基準の向きを決めるための
        大まかな下書きです)。
      </p>
      <div className="axis-preset-grid">
        {HEAD_AXIS_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={isSameAxis(headAxis, preset.axis) ? "axis-preset-button active" : "axis-preset-button"}
            onClick={() => setHeadAxis(preset.axis)}
          >
            頭側={preset.label}
          </button>
        ))}
      </div>
      <button type="button" className="reset-display-button" onClick={setApAxisFromCurrentCamera}>
        この視点をAP正面として設定
      </button>
    </section>
  );
}
