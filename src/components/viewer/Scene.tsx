import { Canvas } from "@react-three/fiber";
import { AnatomyModels } from "../models/ModelLoader";
import { CameraRig } from "./CameraRig";
import { ClippingPlanes } from "./ClippingPlanes";

/**
 * 3Dビューアのエントリポイント。Canvas配下にモデル・ライト・カメラ操作・
 * クリッピングを配置する。
 */
export function Scene() {
  return (
    <Canvas
      shadows
      camera={{ fov: 45, near: 0.1, far: 100 }}
      gl={{ localClippingEnabled: true }}
    >
      <color attach="background" args={["#0b0f14"]} />
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[5, 8, 5]}
        intensity={1.2}
        castShadow
        shadow-mapSize={[1024, 1024]}
      />
      <directionalLight position={[-5, -3, -4]} intensity={0.3} />

      <AnatomyModels />

      <CameraRig />
      <ClippingPlanes />
    </Canvas>
  );
}
