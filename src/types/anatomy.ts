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

/**
 * 血管1本(または将来的には1セグメント)分の状態。
 * 現状は RCA/LAD/LCX という主幹単位だが、将来 AHA 分類のセグメント番号
 * (#1〜#15 等)単位に分割する場合も、同じ形のエントリを増やし
 * parentVessel で所属する主幹を示すだけで対応できるようにしてある。
 * 主幹自体(現状の RCA/LAD/LCX)は parentVessel: null。
 */
export interface VesselState extends AnatomyDisplayState {
  id: string;
  name: string;
  parentVessel: VesselId | null;
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
