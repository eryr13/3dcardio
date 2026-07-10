// 心臓・冠動脈の解剖オブジェクトに関する共通型定義。
// 将来DICOM由来の実メッシュ(GLTF/GLB)に差し替える際も、この型は変えずに
// ModelSource だけを 'placeholder' -> 'gltf' に切り替えられるようにしてある。

export type VesselId = "RCA" | "LAD" | "LCX";

export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

/** 個々の解剖オブジェクト(血管・心臓)が共通して持つ表示プロパティ */
export interface AnatomyDisplayState {
  visible: boolean;
  color: string;
  opacity: number;
}

/** 血管1本分の状態。将来的にセグメント分割する場合は segments を追加する想定 */
export interface VesselState extends AnatomyDisplayState {
  id: VesselId;
  name: string;
}

export interface HeartState extends AnatomyDisplayState {
  id: "HEART";
  name: string;
}

/** モデルの供給元。今回は placeholder のみ実装し、将来 gltf を追加する */
export type ModelSource =
  | { type: "placeholder" }
  | { type: "gltf"; url: string };

export type ClippingAxis = "x" | "y" | "z";

export interface ClippingAxisState {
  enabled: boolean;
  /** -1〜1 のワールド座標に対応する断面位置 */
  position: number;
}

export type ClippingState = Record<ClippingAxis, ClippingAxisState>;

/** カメラの現在姿勢。C-arm角度変換など将来の処理のための最小限の情報 */
export interface CameraState {
  position: Vec3Tuple;
  quaternion: [number, number, number, number];
}
