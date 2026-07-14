import { ViewControls } from "./ViewControls";
import { ClippingControls } from "./ClippingControls";
import { AnatomyLegend } from "./AnatomyLegend";
import { LesionPanel } from "./LesionPanel";
import { CineControls } from "./CineControls";
import { CArmCalibration } from "./CArmCalibration";
import { CArmReadout } from "./CArmReadout";

export function SidePanel() {
  return (
    <aside className="side-panel">
      <h1>3D Cardio Viewer</h1>
      <ViewControls />
      <ClippingControls />
      <AnatomyLegend />
      <LesionPanel />
      <CineControls />
      <CArmCalibration />
      <CArmReadout />
    </aside>
  );
}
