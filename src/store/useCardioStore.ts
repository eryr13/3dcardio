import { create } from "zustand";
import { PerspectiveCamera } from "three";
import type {
  CameraState,
  ClippingAxis,
  ClippingState,
  HeartState,
  VesselId,
  VesselState,
} from "../types/anatomy";
import type { CineFps, CineState, CineXrayParams } from "../types/cine";
import { DEFAULT_CINE_ZOOM, dragPan, zoomAtCursor } from "../utils/cineZoom";
import type { PatientFrameCalibration } from "../types/cArmCalibration";
import { DEFAULT_CALIBRATION } from "../types/cArmCalibration";
import type { CardioObject, ObjectPatch, NewObjectInput } from "../types/object";
import { buildSegmentVesselStates } from "../components/models/vesselSegments";
import type { StentLatticeParams } from "../components/models/stentLatticeMesh";
import { DEFAULT_STENT_LATTICE_PARAMS } from "../components/models/stentLatticeMesh";

/**
 * メインビューの初期カメラ位置。CameraRig.tsx が実際にマウントした際もこの値を使う
 * (このファイルからimportする、二重定義しない)。
 */
export const DEFAULT_CAMERA_POSITION: [number, number, number] = [4, 2.5, 5];

interface CardioStore {
  heart: HeartState;
  /**
   * 血管(主幹単位、またはセグメント単位)の状態を id で引けるマップ。
   * segmentMode の切り替えで、この中身が主幹3本 <-> セグメント群に丸ごと
   * 入れ替わる。AnatomyLegend 側は Object.values(vessels) で列挙しているだけ
   * なので、どちらのモードでも変更不要。
   */
  vessels: Record<string, VesselState>;
  /** セグメント単位の色分け・ホバー表示を有効にするかどうか(既定OFF) */
  segmentMode: boolean;
  clipping: ClippingState;
  camera: CameraState;
  /** インクリメントするたびに CameraRig 側で視点リセットを実行させるための信号 */
  resetCameraSignal: number;

  setHeartDisplay: (patch: Partial<Omit<HeartState, "id" | "name">>) => void;
  setVesselDisplay: (
    id: string,
    patch: Partial<Omit<VesselState, "id" | "name" | "parentVessel">>,
  ) => void;
  toggleSegmentMode: () => void;
  /** 色・不透明度だけを初期値に戻す(表示/非表示やセグメントモードは変更しない) */
  resetDisplayDefaults: () => void;

  setClippingAxis: (axis: ClippingAxis, patch: Partial<ClippingState[ClippingAxis]>) => void;
  resetClipping: () => void;

  setCamera: (camera: CameraState) => void;
  requestCameraReset: () => void;

  calibration: PatientFrameCalibration;
  /** 頭側の基準軸をシーンローカルの軸プリセット(±X/±Y/±Z)から設定する */
  setHeadAxis: (axis: [number, number, number]) => void;
  /** 現在のメインビューのカメラ位置方向を「AP正面」として記録する */
  setApAxisFromCurrentCamera: () => void;

  /**
   * インクリメントする nonce 付きのリクエストオブジェクト。CameraRig 側がこれの変化を
   * 検知してカメラをその角度へアニメーション移動させる(resetCameraSignal と同じ
   * 「シグナル駆動」パターン)。
   */
  cameraAngleRequest: CameraAngleRequest | null;
  requestCameraAngles: (raoLao: number, craCaud: number) => void;

  cine: CineState;
  setCineEnabled: (enabled: boolean) => void;
  playCine: () => void;
  pauseCine: () => void;
  setCineFps: (fps: CineFps) => void;
  setCineShowHeartOutline: (show: boolean) => void;
  setCineXrayMode: (v: boolean) => void;
  setCineXrayParam: <K extends keyof CineXrayParams>(key: K, value: CineXrayParams[K]) => void;
  setCineExporting: (exporting: boolean) => void;
  setCinePanelWidth: (width: number) => void;
  /** カーソル位置(ビューポート内の正規化座標、0〜1)を中心にズームする */
  zoomCineAtCursor: (cursorXNorm: number, cursorYNorm: number, zoomFactor: number) => void;
  /** ドラッグによるパン(dxNorm/dyNormはビューポート幅・高さに対する移動量の比率) */
  panCine: (dxNorm: number, dyNorm: number) => void;
  resetCineZoom: () => void;

  /** Phase 6: 血管上に疑似配置したオブジェクト(狭窄・石灰化・ステント等)の一覧 */
  objects: CardioObject[];
  addObject: (object: NewObjectInput) => void;
  updateObject: (id: string, patch: ObjectPatch) => void;
  removeObject: (id: string) => void;
  /**
   * 3Dビュー上でノードをクリックした際、オブジェクト追加フォームへ事前入力する一時的な
   * 位置(枝ID+その枝上の位置)。フォーム側で消費(addObject実行、またはキャンセル)
   * したら null に戻す。
   */
  pendingObjectPosition: { vesselId: VesselId; branchId: string; position: number } | null;
  setPendingObjectPosition: (v: { vesselId: VesselId; branchId: string; position: number } | null) => void;
  /**
   * オブジェクト追加フォームで位置・長さを微調整している間、3Dビューにライブプレビュー
   * (簡易円筒)を表示するための一時状態。まだstore.objectsには登録されていない
   * (=addObject実行前の)下書き状態を表す。
   */
  previewObject: { vesselId: VesselId; branchId: string; position: number; length: number } | null;
  setPreviewObject: (
    v: { vesselId: VesselId; branchId: string; position: number; length: number } | null,
  ) => void;
  /**
   * 登録済みオブジェクトの位置を「3Dビューでノードをクリックし直して変更」するモード。
   * nullでない間は、ModelLoader側のクリックハンドラがpendingObjectPositionの
   * 代わりにこのIDのオブジェクトを直接updateObjectで更新する。
   */
  editingObjectId: string | null;
  setEditingObjectId: (id: string | null) => void;
  /**
   * 新規オブジェクト追加のため、3Dビュー上でノードマーカーを表示してクリック待ちにしている
   * 血管。画面が常時うるさくならないよう、ノードマーカーは「オブジェクトを追加」フォームで
   * 明示的に位置選択を開始した間、またはeditingObjectIdが設定されている間だけ表示する。
   */
  pickingObjectVessel: VesselId | null;
  setPickingObjectVessel: (v: VesselId | null) => void;

  /**
   * 開発者向けデバッグ表示のトグル群。既定はすべて非表示/既定値にし、
   * サイドバー最下部の「デバッグ(開発者向け)」パネルから切り替える。
   */
  debugShowCenterlines: boolean;
  setDebugShowCenterlines: (v: boolean) => void;
  stentLatticeParams: StentLatticeParams;
  setStentLatticeParams: (patch: Partial<StentLatticeParams>) => void;
}

export interface CameraAngleRequest {
  raoLao: number;
  craCaud: number;
  nonce: number;
}

const CINE_PANEL_MIN_WIDTH = 260;
const CINE_PANEL_MAX_WIDTH = 900;

const TRUNK_VESSELS: Record<string, VesselState> = {
  RCA: { id: "RCA", name: "RCA (右冠動脈)", parentVessel: null, visible: true, color: "#3d8bfd", opacity: 1 },
  LAD: { id: "LAD", name: "LAD (左前下行枝)", parentVessel: null, visible: true, color: "#3ddc84", opacity: 1 },
  LCX: { id: "LCX", name: "LCX (左回旋枝)", parentVessel: null, visible: true, color: "#f7b731", opacity: 1 },
};

const DEFAULT_HEART_COLOR = "#b5474d";
const DEFAULT_HEART_OPACITY = 0.9;

const initialClipping: ClippingState = {
  x: { enabled: false, position: 0 },
  y: { enabled: false, position: 0 },
  z: { enabled: false, position: 0 },
};

/**
 * store.camera の初期値。heart-realistic.glb(2.6MB)の読み込み中はR3F CanvasのSuspense
 * (Canvasが暗黙に提供する)によりCameraRig自体がまだマウントされておらず、この初期値が
 * そのまま(数百ms〜数秒)表示され得る。単なる原点/単位クォータニオンにすると、
 * サイドパネルのCアーム角度表示がその間ずっと無意味な値(例: RAO 41°など)になって
 * しまうため、CameraRigが実際に設定するのと同じ「DEFAULT_CAMERA_POSITIONから原点を
 * 注視した姿勢」をあらかじめ計算しておく。
 *
 * ダミーオブジェクトは必ず Camera(または isCamera フラグを持つもの)にすること。
 * three.js の Object3D.lookAt() は isCamera / isLight のときだけ「自分の位置から
 * ターゲットを見る」向きになり、それ以外の Object3D では引数が入れ替わり真逆の
 * 姿勢になる(three.js の仕様。実機で180度ズレる不具合として発見し特定した)。
 */
function computeInitialCamera(): CameraState {
  const dummy = new PerspectiveCamera();
  dummy.position.set(...DEFAULT_CAMERA_POSITION);
  dummy.lookAt(0, 0, 0);
  return {
    position: { x: DEFAULT_CAMERA_POSITION[0], y: DEFAULT_CAMERA_POSITION[1], z: DEFAULT_CAMERA_POSITION[2] },
    quaternion: [dummy.quaternion.x, dummy.quaternion.y, dummy.quaternion.z, dummy.quaternion.w],
  };
}

const initialCamera: CameraState = computeInitialCamera();

export const DEFAULT_CINE_XRAY_PARAMS: CineXrayParams = {
  noiseIntensity: 0.15,
  blurAmount: 0.3,
  vignetteStrength: 0.5,
  contrast: 0.65,
  vesselAbsorption: 15,
  calcificationAbsorption: 35,
  stentAbsorption: 220,
  showBackgroundAnatomy: false,
  heartAbsorption: 1.0,
  vesselsOnly: false,
};

/** 既定では拍動なし(静止)で、再生ボタンを押した時だけ動き始める */
const initialCine: CineState = {
  enabled: false,
  panelWidth: 340,
  playing: false,
  playStartedAtMs: null,
  accumulatedSeconds: 0,
  fps: 30,
  showHeartOutline: false,
  xrayMode: false,
  xrayParams: DEFAULT_CINE_XRAY_PARAMS,
  exporting: false,
  zoom: DEFAULT_CINE_ZOOM,
};

export const useCardioStore = create<CardioStore>((set) => ({
  heart: { id: "HEART", name: "Heart", visible: true, color: DEFAULT_HEART_COLOR, opacity: DEFAULT_HEART_OPACITY },

  vessels: TRUNK_VESSELS,
  segmentMode: false,

  clipping: initialClipping,
  camera: initialCamera,
  resetCameraSignal: 0,

  setHeartDisplay: (patch) =>
    set((state) => ({ heart: { ...state.heart, ...patch } })),

  setVesselDisplay: (id, patch) =>
    set((state) => ({
      vessels: { ...state.vessels, [id]: { ...state.vessels[id], ...patch } },
    })),

  toggleSegmentMode: () =>
    set((state) => {
      const next = !state.segmentMode;
      return { segmentMode: next, vessels: next ? buildSegmentVesselStates() : TRUNK_VESSELS };
    }),

  resetDisplayDefaults: () =>
    set((state) => {
      const defaults = state.segmentMode ? buildSegmentVesselStates() : TRUNK_VESSELS;
      const vessels: Record<string, VesselState> = {};
      for (const [id, vessel] of Object.entries(state.vessels)) {
        const fallback = defaults[id];
        vessels[id] = fallback
          ? { ...vessel, color: fallback.color, opacity: fallback.opacity }
          : vessel;
      }
      return {
        heart: { ...state.heart, color: DEFAULT_HEART_COLOR, opacity: DEFAULT_HEART_OPACITY },
        vessels,
      };
    }),

  setClippingAxis: (axis, patch) =>
    set((state) => ({
      clipping: { ...state.clipping, [axis]: { ...state.clipping[axis], ...patch } },
    })),

  resetClipping: () => set({ clipping: initialClipping }),

  setCamera: (camera) => set({ camera }),

  requestCameraReset: () =>
    set((state) => ({ resetCameraSignal: state.resetCameraSignal + 1 })),

  calibration: DEFAULT_CALIBRATION,

  setHeadAxis: (axis) =>
    set((state) => ({ calibration: { ...state.calibration, headAxis: axis } })),

  setApAxisFromCurrentCamera: () =>
    set((state) => ({
      calibration: {
        ...state.calibration,
        apAxis: [state.camera.position.x, state.camera.position.y, state.camera.position.z],
      },
    })),

  cameraAngleRequest: null,

  requestCameraAngles: (raoLao, craCaud) =>
    set((state) => ({
      cameraAngleRequest: { raoLao, craCaud, nonce: (state.cameraAngleRequest?.nonce ?? 0) + 1 },
    })),

  cine: initialCine,

  // 拍動はメインビューにも常時適用されるため、シネパネルの表示/非表示は
  // playing 状態に一切影響しない(シネパネルを閉じてもメインビューは拍動し続ける)。
  setCineEnabled: (enabled) => set((state) => ({ cine: { ...state.cine, enabled } })),

  playCine: () =>
    set((state) => {
      if (state.cine.playing) return state;
      return { cine: { ...state.cine, playing: true, playStartedAtMs: performance.now() } };
    }),

  pauseCine: () => set((state) => ({ cine: pauseCineState(state.cine) })),

  setCineFps: (fps) => set((state) => ({ cine: { ...state.cine, fps } })),

  setCineShowHeartOutline: (showHeartOutline) =>
    set((state) => ({ cine: { ...state.cine, showHeartOutline } })),

  setCineXrayMode: (xrayMode) =>
    set((state) => ({ cine: { ...state.cine, xrayMode } })),

  setCineXrayParam: (key, value) =>
    set((state) => ({
      cine: { ...state.cine, xrayParams: { ...state.cine.xrayParams, [key]: value } },
    })),

  setCineExporting: (exporting) => set((state) => ({ cine: { ...state.cine, exporting } })),

  setCinePanelWidth: (width) =>
    set((state) => ({
      cine: {
        ...state.cine,
        panelWidth: Math.min(CINE_PANEL_MAX_WIDTH, Math.max(CINE_PANEL_MIN_WIDTH, width)),
      },
    })),

  zoomCineAtCursor: (cursorXNorm, cursorYNorm, zoomFactor) =>
    set((state) => ({
      cine: { ...state.cine, zoom: zoomAtCursor(state.cine.zoom, cursorXNorm, cursorYNorm, zoomFactor) },
    })),

  panCine: (dxNorm, dyNorm) =>
    set((state) => ({
      cine: { ...state.cine, zoom: dragPan(state.cine.zoom, dxNorm, dyNorm) },
    })),

  resetCineZoom: () => set((state) => ({ cine: { ...state.cine, zoom: DEFAULT_CINE_ZOOM } })),

  objects: [],

  addObject: (object) =>
    set((state) => ({
      objects: [...state.objects, { ...object, id: createObjectId() } as CardioObject],
    })),

  updateObject: (id, patch) =>
    set((state) => ({
      objects: state.objects.map((object) => (object.id === id ? ({ ...object, ...patch } as CardioObject) : object)),
    })),

  removeObject: (id) =>
    set((state) => ({
      objects: state.objects.filter((object) => object.id !== id),
    })),

  pendingObjectPosition: null,

  setPendingObjectPosition: (v) => set({ pendingObjectPosition: v }),

  previewObject: null,
  setPreviewObject: (v) => set({ previewObject: v }),

  editingObjectId: null,
  setEditingObjectId: (id) => set({ editingObjectId: id }),

  pickingObjectVessel: null,
  setPickingObjectVessel: (v) => set({ pickingObjectVessel: v }),

  debugShowCenterlines: false,
  setDebugShowCenterlines: (v) => set({ debugShowCenterlines: v }),

  stentLatticeParams: DEFAULT_STENT_LATTICE_PARAMS,
  setStentLatticeParams: (patch) =>
    set((state) => ({ stentLatticeParams: { ...state.stentLatticeParams, ...patch } })),
}));

function createObjectId(): string {
  return `object-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

/** playing 中なら現在時刻までの経過分を accumulatedSeconds に畳み込んで停止する */
function pauseCineState(cine: CineState): CineState {
  if (!cine.playing || cine.playStartedAtMs === null) return cine;
  const elapsed = (performance.now() - cine.playStartedAtMs) / 1000;
  return {
    ...cine,
    playing: false,
    playStartedAtMs: null,
    accumulatedSeconds: cine.accumulatedSeconds + elapsed,
  };
}
