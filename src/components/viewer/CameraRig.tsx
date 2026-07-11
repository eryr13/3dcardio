import { useEffect, useRef } from "react";
import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { Vector3 } from "three";
import { DEFAULT_CAMERA_POSITION, useCardioStore } from "../../store/useCardioStore";
import { cArmAnglesToCameraDirection } from "../../utils/cArmAngles";

const CAMERA_ANGLE_ANIMATION_MS = 600;

interface AngleAnimation {
  startDir: Vector3;
  endDir: Vector3;
  distance: number;
  startedAt: number;
}

/**
 * OrbitControls によるカメラ操作(回転/パン/ズーム)と、視点リセット、
 * カメラ姿勢の store 同期を担当する。
 *
 * カメラの position/quaternion を store に保持しておくことで、C-arm 角度
 * (LAO/RAO, CRA/CAUD)への変換処理(utils/cArmAngles.ts)をここに差し込める。
 * store.cameraAngleRequest が変化すると、その角度に対応する視点へカメラを
 * アニメーション移動させる(Cアーム角度の逆算・プリセット呼び出し用)。
 */
export function CameraRig() {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);
  const setCamera = useCardioStore((s) => s.setCamera);
  const resetCameraSignal = useCardioStore((s) => s.resetCameraSignal);
  const cameraAngleRequest = useCardioStore((s) => s.cameraAngleRequest);
  const animationRef = useRef<AngleAnimation | null>(null);
  const hasSyncedInitialFrame = useRef(false);

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
    animationRef.current = null;
    controlsRef.current?.reset();
  }, [resetCameraSignal]);

  useEffect(() => {
    if (!cameraAngleRequest) return;
    const { calibration } = useCardioStore.getState();
    const distance = camera.position.length() || 1;
    const startDir = camera.position.clone().normalize();
    const endDir = cArmAnglesToCameraDirection(
      { raoLao: cameraAngleRequest.raoLao, craCaud: cameraAngleRequest.craCaud },
      calibration,
    );
    animationRef.current = { startDir, endDir, distance, startedAt: performance.now() };
    // cameraAngleRequest オブジェクト全体ではなく nonce の変化だけを見る
    // (raoLao/craCaudが同じ値でも再リクエストしたら再アニメーションさせたいため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraAngleRequest?.nonce]);

  useFrame(() => {
    // マウント直後の useEffect による syncCameraState() は、OrbitControls 自身の
    // 初期化(内部の球面座標状態の構築)やReact StrictModeの二重実行タイミングと
    // 競合し、store の camera が初期値(quaternion=[0,0,0,1])のまま更新されない
    // ことがある(実機で確認済み)。レンダリングが実際に始まった後の最初のフレームで
    // 改めて同期することで、常に実際のカメラ姿勢が store に反映されるようにする。
    if (!hasSyncedInitialFrame.current) {
      hasSyncedInitialFrame.current = true;
      syncCameraState();
    }

    const anim = animationRef.current;
    if (!anim) return;
    const t = Math.min(1, (performance.now() - anim.startedAt) / CAMERA_ANGLE_ANIMATION_MS);
    const eased = smoothstep(t);
    const dir = slerpVectors(anim.startDir, anim.endDir, eased);
    camera.position.copy(dir.multiplyScalar(anim.distance));
    camera.lookAt(0, 0, 0);
    // OrbitControls は内部にも独自の球面座標状態を持っているため、カメラを直接
    // 動かした後は update() を呼んで内部状態を同期しておかないと、次にユーザーが
    // ドラッグ操作した瞬間にカメラ位置が古い内部状態へ「戻って」しまう。
    controlsRef.current?.update();
    syncCameraState();
    if (t >= 1) animationRef.current = null;
  });

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

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 2つの単位ベクトルの球面線形補間(three.jsのVector3にslerpが無いための自前実装) */
function slerpVectors(a: Vector3, b: Vector3, t: number): Vector3 {
  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  const theta = Math.acos(dot) * t;
  if (theta < 1e-6) return a.clone();
  const relative = b.clone().addScaledVector(a, -dot).normalize();
  return a.clone().multiplyScalar(Math.cos(theta)).addScaledVector(relative, Math.sin(theta));
}
