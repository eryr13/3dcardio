import { useEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera, Vector3 } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import { cineSceneBridge } from "../models/cineSceneBridge";
import { useModelBoundingSphereRadius } from "./cineCameraUtils";

/** 実際のCアーム(点X線源からの円錐投影)を模した画角。40〜50度の中間値で固定する */
const XRAY_FOV_DEGREES = 45;
/** モデルの外接球がフレーム内にきちんと収まるための余白係数 */
const FIT_MARGIN = 1.25;

/**
 * リアルX線モード用の透視投影カメラ。CineOrthoCamera(CineScene.tsx)と同じ設計方針
 * (dreiの宣言的<PerspectiveCamera>ではなく、自前でカメラを1つ生成して毎フレーム
 * 明示的にfov/position/quaternionを更新する)を踏襲している。理由も同じで、drei側の
 * カメラコンポーネントは内部再レンダリングのタイミング次第でpropsが一瞬デフォルト値に
 * 戻る不具合を実際に踏んでいるため。
 *
 * 距離は「モデルの外接球がちょうどFOV内に収まる点光源からの距離」= radius / sin(FOV/2)
 * で動的に算出する(モデル差し替えにも自動追従し、ハードコードしない)。
 */
export function CineXrayCamera() {
  const camera = useMemo(() => new PerspectiveCamera(XRAY_FOV_DEGREES, 1, 0.1, 100), []);
  const radius = useModelBoundingSphereRadius();
  const setDefaultCamera = useThree((s) => s.set);

  useEffect(() => {
    setDefaultCamera({ camera });
    if (cineSceneBridge.current) cineSceneBridge.current.camera = camera;
  }, [camera, setDefaultCamera]);

  useFrame((state) => {
    const aspect = state.size.width / state.size.height || 1;
    const halfFovRad = (XRAY_FOV_DEGREES * Math.PI) / 180 / 2;
    const distance = (radius * FIT_MARGIN) / Math.sin(halfFovRad);

    camera.fov = XRAY_FOV_DEGREES;
    camera.aspect = aspect;
    camera.near = Math.max(0.01, distance - radius * 3);
    camera.far = distance + radius * 3;
    camera.updateProjectionMatrix();

    const { camera: mainCamera } = useCardioStore.getState();
    camera.quaternion.set(
      mainCamera.quaternion[0],
      mainCamera.quaternion[1],
      mainCamera.quaternion[2],
      mainCamera.quaternion[3],
    );
    const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.copy(forward.multiplyScalar(-distance));
  });

  return null;
}
