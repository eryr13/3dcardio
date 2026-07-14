import { useEffect, useMemo } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera, Vector3 } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import { CineAnatomyModel } from "../models/CineAnatomyModel";
import { cineSceneBridge } from "../models/cineSceneBridge";
import { useModelBoundingSphereRadius } from "./cineCameraUtils";
import { CineXrayCamera } from "./CineXrayCamera";
import { CineXrayPostProcessing } from "./CineXrayPostProcessing";
import { CineBackgroundAnatomy } from "./CineBackgroundAnatomy";

/** スキーマ表示の背景色。従来通り明るいグレーのまま変更しない。 */
const CINE_BACKGROUND_COLOR = "#d9d9d9";
/**
 * リアルX線モードの背景色(縦隔相当の中間〜暗めグレー)。実際のアンギオ画像に近づけるため
 * スキーマ表示より暗くしている。肺野に相当する周辺部の明るさは
 * CineVesselThicknessEffect側のlungBrighten()で放射状に持ち上げる。
 */
const CINE_XRAY_BACKGROUND_COLOR = "#6e6e6e";
/** カメラ位置は平行投影の見え方に影響しない(向きだけが効く)。near/farに十分収まる距離を選ぶ */
const CAMERA_DISTANCE = 10;

/** xrayMode時のみ背景色を暗めグレーに切り替える(スキーマ表示は変更しない) */
function CineSceneBackground() {
  const xrayMode = useCardioStore((s) => s.cine.xrayMode);
  return <color attach="background" args={[xrayMode ? CINE_XRAY_BACKGROUND_COLOR : CINE_BACKGROUND_COLOR]} />;
}

/**
 * メインビューの現在のカメラ向き(store.camera.quaternion)を投影方向として追従する
 * 平行投影カメラ(スキーマ表示)。
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
  const halfSize = useModelBoundingSphereRadius();
  const setDefaultCamera = useThree((s) => s.set);

  useEffect(() => {
    setDefaultCamera({ camera });
    if (cineSceneBridge.current) cineSceneBridge.current.camera = camera;
  }, [camera, setDefaultCamera]);

  useFrame((state) => {
    const aspect = state.size.width / state.size.height || 1;
    const size = halfSize * 1.15;
    camera.left = -size * aspect;
    camera.right = size * aspect;
    camera.top = size;
    camera.bottom = -size;
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
 * スキーマ表示(既定)とリアルX線モードでカメラ・ポストプロセスを出し分ける。
 * スキーマ表示は従来通りOrthographicCamera+素のレンダリングのまま変更しない。
 * リアルX線モードはPerspectiveCamera(CineXrayCamera)+EffectComposer
 * (CineXrayPostProcessing)に切り替える。
 */
function CineModeSwitch() {
  const xrayMode = useCardioStore((s) => s.cine.xrayMode);
  return xrayMode ? (
    <>
      <CineXrayCamera />
      <CineBackgroundAnatomy />
      <CineXrayPostProcessing />
    </>
  ) : (
    <CineOrthoCamera />
  );
}

/**
 * シネビュー(X線風投影)専用の独立したCanvas。メインビューのSceneとは完全に別の
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
          composer: null,
          vesselMeshes: {},
          vesselVisible: {},
          heartMesh: null,
          lesionProxies: [],
        };
      }}
    >
      <CineSceneBackground />
      <CineAnatomyModel />
      <CineModeSwitch />
    </Canvas>
  );
}
