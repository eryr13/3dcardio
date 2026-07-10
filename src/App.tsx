import { SidePanel } from "./components/ui/SidePanel";
import { Scene } from "./components/viewer/Scene";
import "./App.css";

function App() {
  return (
    <div className="app-layout">
      <SidePanel />
      <main className="viewer-area">
        <Scene />
      </main>
    </div>
  );
}

export default App;
