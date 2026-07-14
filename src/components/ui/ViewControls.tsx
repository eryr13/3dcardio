import { useCardioStore } from "../../store/useCardioStore";
import { CollapsibleSection } from "./CollapsibleSection";

export function ViewControls() {
  const requestCameraReset = useCardioStore((s) => s.requestCameraReset);

  return (
    <CollapsibleSection title="カメラ">
      <button type="button" onClick={requestCameraReset}>
        視点をリセット
      </button>
    </CollapsibleSection>
  );
}
