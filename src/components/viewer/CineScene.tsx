import { useEffect, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { Box3, OrthographicCamera, Sphere, Vector3 } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import { CineAnatomyModel, REALISTIC_HEART_URL } from "../models/CineAnatomyModel";
import { cineSceneBridge } from "../models/cineSceneBridge";

const CINE_BACKGROUND_COLOR = "#d9d9d9";
/** カメラ位置は平行投影の見え方に影響しない(向きだけが効く)。near/farに十分収まる距離を選ぶ */
const CAMERA_DISTANCE = 10;

/** モデルの実サイズに応じてフラスタムを決める(将来メッシュが差し替わっても自動で追従する) */
function useModelFrustumHalfSize(): number {
  const { scene } = useGLTF(REALISTIC_HEART_URL);
  return useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const sphere = new Sphere();
    box.getBoundingSphere(sphere);
    return sphere.radius * 1.15;
  }, [scene]);
}

/**
 * メインビューの現在のカメラ向き(store.camera.quaternion)を投影方向として追従する
 * 平行投影カメラ。
 *
 * drei の <OrthographicCamera left={...} .../> を使うと、シネパネルをリサイズした際に
 * 内部の再レンダリングタイミングの都合で left/right/top/bottom が一瞬 drei 側の
 * デフォルト値(size.width/-2 など、canvasの生ピクセルサイズ基準)に戻ってしまい、
 * フラスタムが極端に大きくなってモデルがほぼ見えなくなる不具合が確認できたため、
 * カメラを自前で1つだけ生成し、毎フレーム明示的に left/right/top/bottom と
 * updateProjectionMatrix() を呼ぶことで、propsの差分検出に依存しないようにしている。
 */
function CineOrthoCamera() {
  const camera = useMemo(() => new OrthographicCamera(-1, 1, 1, -1, 0.1, CAMERA_DISTANCE * 2), []);
  const halfSize = useModelFrustumHalfSize();
  const setDefaultCamera = useThree((s) => s.set);

  useEffect(() => {
    setDefaultCamera({ camera });
    if (cineSceneBridge.current) cineSceneBridge.current.camera = camera;
  }, [camera, setDefaultCamera]);

  useFrame((state) => {
    const aspect = state.size.width / state.size.height || 1;
    camera.left = -halfSize * aspect;
    camera.right = halfSize * aspect;
    camera.top = halfSize;
    camera.bottom = -halfSize;
    camera.updateProjectionMatrix();

    const { camera: mainCamera } = useCardioStore.getState();
    camera.quaternion.set(
      mainCamera.quaternion[0],
      mainCamera.quaternion[1],
      mainCamera.quaternion[2],
      mainCamera.quaternion[3],
    );
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.copy(forward.multiplyScalar(-CAMERA_DISTANCE));
  });

  return null;
}

/**
 * シネビュー(X線風平行投影)専用の独立したCanvas。メインビューのSceneとは完全に別の
 * WebGLコンテキストを持ち、CineAnatomyModelが自前でGLBを複製して描画する。
 * preserveDrawingBuffer はGIF/PNG書き出し時にcanvasから確実にピクセルを読み出すために必要。
 */
export function CineScene() {
  return (
    <Canvas
      gl={{ preserveDrawingBuffer: true }}
      onCreated={(state) => {
        cineSceneBridge.current = {
          gl: state.gl,
          scene: state.scene,
          camera: null,
          pulseGroup: null,
        };
      }}
    >
      <color attach="background" args={[CINE_BACKGROUND_COLOR]} />
      <CineOrthoCamera />
      <CineAnatomyModel />
    </Canvas>
  );
}
