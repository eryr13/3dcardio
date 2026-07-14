import type { Group, Mesh, OrthographicCamera, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { EffectComposer } from "postprocessing";
import type { VesselId } from "../../types/anatomy";

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
   * <Canvas onCreated> の時点では makeDefault なカメラがまだ子コンポーネントとして
   * マウントされておらず値が確定しないため、CineOrthoCamera / CineXrayCamera 自身の
   * マウント時に埋める(pulseGroupと同じ理由)。スキーマ表示はOrthographicCamera、
   * リアルX線モードはPerspectiveCameraを使う。
   */
  camera: OrthographicCamera | PerspectiveCamera | null;
  /** HeartbeatGroup が作る <group> への参照。同じくマウント後に埋まる */
  pulseGroup: Group | null;
  /**
   * リアルX線モード時の @react-three/postprocessing EffectComposer。
   * cineExport.ts がライブ表示と同じ見た目でフレームを書き出すために composer.render() を呼ぶ。
   * スキーマ表示中や、リアルX線モードのCanvasがまだマウントされていない間は null。
   */
  composer: EffectComposer | null;
  /** RCA/LAD/LCX の主幹メッシュ。CineVesselThicknessEffect が深度ピール用プロキシの元にする */
  vesselMeshes: Partial<Record<VesselId, Mesh>>;
  /** ユーザー操作(表示/非表示トグル)による主幹単位の表示状態。xrayMode中は塗りつぶしメッシュ自体は隠すため、こちらで別管理する */
  vesselVisible: Partial<Record<VesselId, boolean>>;
  /** 心臓本体メッシュ。常時 visible=false(塗りつぶし表示はしない)だが、CineVesselThicknessEffect が
   * リアルX線モードの陰影用深度ピールプロキシの元ジオメトリとして参照する */
  heartMesh: Mesh | null;
  /**
   * リアルX線モードで深度ピール密度表現の対象にするオブジェクトメッシュ(石灰化・ステント)。
   * CineVesselThicknessEffect が件数に関わらず1枚の共有アキュムレータに加算合成するため、
   * 上限は無い。表示トグルがOFFのオブジェクトはこの配列に含めない。
   */
  objectProxies: ObjectProxyEntry[];
}

export interface ObjectProxyEntry {
  id: string;
  mesh: Mesh;
  /** リアルX線モードでの吸収係数。石灰化は血管より高く(より暗く)、ステントは非常に高くする。 */
  absorption: number;
}

export const cineSceneBridge: { current: CineSceneHandle | null } = { current: null };
