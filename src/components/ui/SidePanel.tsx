import { ViewControls } from "./ViewControls";
import { ClippingControls } from "./ClippingControls";
import { AnatomyLegend } from "./AnatomyLegend";
import { CineControls } from "./CineControls";

export function SidePanel() {
  return (
    <aside className="side-panel">
      <h1>3D Cardio Viewer</h1>
      <ViewControls />
      <ClippingControls />
      <AnatomyLegend />
      <CineControls />
    </aside>
  );
}
