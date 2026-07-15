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
  /**
   * RCA/LAD/LCX の主幹メッシュ。シネスキーマ表示(!xrayMode)の塗りつぶし描画に使うほか、
   * CineVesselThicknessEffect の深度ピール用アキュムレータの登録元として、造影剤
   * フローモードのON/OFFに関わらず常にこれを使う(常時フル吸収で末梢まで濃く描出する、
   * Phase 7以前からの挙動)。造影剤フローモードONの間は、この上にさらに濃度マスク
   * (contrastMaskMeshes)を掛け合わせて「濃度に応じて薄く見せる」効果を追加するだけで、
   * ベースとなる光学的厚みの計算自体は一切変更しない——これにより濃度1.0の区間は
   * モードOFF時と完全に同じ見え方になることが保証される。
   */
  vesselMeshes: Partial<Record<VesselId, Mesh>>;
  /** ユーザー操作(表示/非表示トグル)による主幹単位の表示状態。xrayMode中は塗りつぶしメッシュ自体は隠すため、こちらで別管理する */
  vesselVisible: Partial<Record<VesselId, boolean>>;
  /**
   * Phase 7: 造影剤フローモード(contrastFlowModeEnabled)がONの間だけ使われる、濃度
   * マスク用チューブ(ContrastFillTube.tsxのContrastMaskTube)。半径は内腔比率
   * (狭窄・石灰化による構造的な狭窄)までしか縮めず、濃度は頂点属性として持つ。
   * CineVesselThicknessEffectがMAXブレンドの単一パスで描画し、「その画素における
   * 最大濃度」を0〜1のマスクとして取り出し、vesselMeshes由来の光学的厚みに掛け合わせる
   * (厚みの測定には使わない——厚みとして使うと血管本体より濃くなりすぎる不具合の
   * 原因だったため、マスク専用に分離した)。
   */
  contrastMaskMeshes: Partial<Record<VesselId, Mesh>>;
  /**
   * true の間だけ contrastMaskMeshes によるマスクを血管の光学的厚みに掛け合わせる
   * (造影剤フローモードのcontrast.enabledをCineAnatomyModel.tsxが反映する)。
   * false(既定)ではマスクを一切適用せず、Phase 7実装前と全く同じ常時フル吸収描画になる。
   */
  contrastFlowModeEnabled: boolean;
  /**
   * 内腔を狭める要素(狭窄プラークの外径/内径チューブ、石灰化の内腔減算用シェル)の
   * メッシュ。石灰化・ステントの「オブジェクト」チャンネル(高吸収体としての表現)とは別に、
   * 血管本体の共有アキュムレータへ符号付きで加算することで、血管自身の生厚みから内腔
   * 方向への張り出しぶんの厚みを差し引く(CineVesselThicknessEffect参照)。狭窄は
   * 1オブジェクトにつきouter(-1)/inner(+1)の2エントリ、石灰化は内腔減算専用シェル(-1)の
   * 1エントリが入る。造影剤フローモードのON/OFFに関わらず常時適用される
   * (狭窄・石灰化による構造的な狭窄は造影剤の有無とは無関係な解剖学的事実のため)。
   */
  lumenSubtractionProxies: LumenSubtractionProxyEntry[];
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
