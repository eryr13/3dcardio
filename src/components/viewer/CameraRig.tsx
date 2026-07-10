import { useEffect, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { useCardioStore } from "../../store/useCardioStore";

const DEFAULT_CAMERA_POSITION: [number, number, number] = [4, 2.5, 5];

/**
 * OrbitControls によるカメラ操作(回転/パン/ズーム)と、視点リセット、
 * カメラ姿勢の store 同期を担当する。
 *
 * カメラの position/quaternion を store に保持しておくことで、将来
 * C-arm 角度(LAO/RAO, CRA/CAUD)への変換処理(utils/cArmAngles.ts)を
 * ここに差し込みやすくしてある。
 */
export function CameraRig() {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const setCamera = useCardioStore((s) => s.setCamera);
  const resetCameraSignal = useCardioStore((s) => s.resetCameraSignal);

  const syncCameraState = () => {
    setCamera({
      position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      quaternion: [camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w],
    });
  };

  useEffect(() => {
    camera.position.set(...DEFAULT_CAMERA_POSITION);
    camera.lookAt(0, 0, 0);
    // OrbitControls はマウント時点のカメラ位置を reset() の復帰先として
    // 保存するため、初期位置を設定した直後に明示的に保存し直す。
    controlsRef.current?.saveState();
    syncCameraState();
    // 初回マウント時のみ初期姿勢を適用する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resetCameraSignal === 0) return;
    controlsRef.current?.reset();
  }, [resetCameraSignal]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={0.1}
      onChange={syncCameraState}
    />
  );
}
