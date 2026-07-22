import { ViewControls } from "./ViewControls";
import { ClippingControls } from "./ClippingControls";
import { AnatomyLegend } from "./AnatomyLegend";
import { ValveLegend } from "./ValveLegend";
import { ObjectPanel } from "./ObjectPanel";
import { CineControls } from "./CineControls";
import { ContrastControls } from "./ContrastControls";
import { PerfusionControls } from "./PerfusionControls";
import { GuideDeviceControls } from "./GuideDeviceControls";
import { CArmCalibration } from "./CArmCalibration";
import { CArmReadout } from "./CArmReadout";
import { DebugPanel } from "./DebugPanel";

export function SidePanel() {
  return (
    <aside className="side-panel">
      <h1>3D Cardio Viewer</h1>
      <ViewControls />
      <ClippingControls />
      <AnatomyLegend />
      <ValveLegend />
      <ObjectPanel />
      <CineControls />
      <ContrastControls />
      <PerfusionControls />
      <GuideDeviceControls />
      <CArmCalibration />
      <CArmReadout />
      <DebugPanel />
    </aside>
  );
}
