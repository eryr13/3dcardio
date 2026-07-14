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
   * リアルX線モードで深度ピール密度表現の対象にするステントメッシュ。ステントの網目
   * (ストラット)は実際の透視でも「細く鋭い黒い線」として写るべきで、輪郭をぼかすと
   * 金属特有のシャープさが失われてしまうため、石灰化とは別の専用チャンネル
   * (ブラー無し)に積算する(CineVesselThicknessEffect参照)。
   * CineVesselThicknessEffect が件数に関わらず1枚の共有アキュムレータに加算合成するため、
   * 上限は無い。表示トグルがOFFのオブジェクトはこの配列に含めない。
   */
  stentProxies: ObjectProxyEntry[];
  /**
   * リアルX線モードで深度ピール密度表現の対象にする石灰化メッシュ。石灰化は不整形の
   * 塊で、ジオメトリの分割数由来のポリゴンエッジがそのまま見えると不自然なため、
   * ステントとは別の専用チャンネル(軽くブラーをかける)に積算する
   * (CineVesselThicknessEffect参照)。
   */
  calcificationProxies: ObjectProxyEntry[];
  /**
   * 内腔を狭める要素(狭窄プラークの外径/内径チューブ、石灰化の内腔減算用シェル)の
   * メッシュ。石灰化・ステントの「オブジェクト」チャンネル(高吸収体としての表現)とは別に、
   * 血管本体の共有アキュムレータへ符号付きで加算することで、血管自身の生厚みから
   * 内腔方向への張り出しぶんの厚みを差し引く(CineVesselThicknessEffect参照)。
   * 狭窄は1オブジェクトにつきouter(-1)/inner(+1)の2エントリ、石灰化は
   * 内腔減算専用シェル(-1)の1エントリが入る。
   */
  lumenSubtractionProxies: LumenSubtractionProxyEntry[];
}

export interface ObjectProxyEntry {
  id: string;
  mesh: Mesh;
  /** リアルX線モードでの吸収係数。石灰化は血管より高く(より暗く)、ステントは非常に高くする。 */
  absorption: number;
}

export interface LumenSubtractionProxyEntry {
  id: string;
  mesh: Mesh;
  /**
   * 血管アキュムレータへの加算符号。血管の生厚みから減算したい面(狭窄の外径チューブ、
   * 石灰化の内腔減算シェル)は-1、通常の血管同様に加算する面(狭窄の内径チューブ)は+1。
   */
  sign: 1 | -1;
}

export const cineSceneBridge: { current: CineSceneHandle | null } = { current: null };
