import type { Group, OrthographicCamera, Scene, WebGLRenderer } from "three";

/**
 * シネCanvas(gl/scene/camera)と拍動グループへの参照を保持する、リアクティブでない橋渡し。
 * これらはシリアライズ不可なThree.jsオブジェクトなのでzustandストアには入れない
 * (store の camera: CameraState が数値だけを保持している方針と一貫させるため)。
 * CinePanel が onCreated / ref でセットし、CineControls の書き出しボタンが読み取る。
 */
export interface CineSceneHandle {
  gl: WebGLRenderer;
  scene: Scene;
  /**
   * <Canvas onCreated> の時点では makeDefault なOrthographicCameraがまだ
   * 子コンポーネントとしてマウントされておらず値が確定しないため、
   * CineOrthoCamera 自身のマウント時に埋める(pulseGroupと同じ理由)。
   */
  camera: OrthographicCamera | null;
  /** HeartbeatGroup が作る <group> への参照。同じくマウント後に埋まる */
  pulseGroup: Group | null;
}

export const cineSceneBridge: { current: CineSceneHandle | null } = { current: null };
