import { useCardioStore } from "../../store/useCardioStore";

export function ViewControls() {
  const requestCameraReset = useCardioStore((s) => s.requestCameraReset);

  return (
    <section className="panel-section">
      <h2>カメラ</h2>
      <button type="button" onClick={requestCameraReset}>
        視点をリセット
      </button>
    </section>
  );
}
