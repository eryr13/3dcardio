import { create } from "zustand";
import { PerspectiveCamera } from "three";
import type {
  AorticRootState,
  CameraState,
  ClippingAxis,
  ClippingState,
  HeartState,
  ValveId,
  ValveState,
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
import type { ContrastState } from "../types/contrast";
import type { ContrastFlowParams } from "../utils/contrastFlow";
import { DEFAULT_CONTRAST_FLOW_PARAMS } from "../utils/contrastFlow";
import type { PerfusionMode, PerfusionState } from "../types/perfusion";
import type { GuideCatheterPlacement } from "../components/models/guideDeviceMesh";
import type { GuideAccessRoute, GuideDeviceState } from "../types/guideDevice";
import { getMainTrunk, getVesselGraph } from "../components/models/vesselGraph";

/**
 * メインビューの初期カメラ位置。CameraRig.tsx が実際にマウントした際もこの値を使う
 * (このファイルからimportする、二重定義しない)。
 */
export const DEFAULT_CAMERA_POSITION: [number, number, number] = [7.2, 4.5, 9];

interface CardioStore {
  heart: HeartState;
  /**
   * 大動脈基部(バルサルバ洞)・上行大動脈の表示状態。心臓モデルには含まれていない
   * ため、aorticRootMesh.tsが冠動脈入口部の位置から手続き的に生成した形状を表示する
   * (AorticRootOverlay参照)。既定は非表示(ガイディングカテーテルのエンゲージ位置を
   * 確認したいときに任意でONにする補助表示のため)。
   */
  aorticRoot: AorticRootState;
  /**
   * 4つの弁(大動脈弁・肺動脈弁・僧帽弁・三尖弁)の表示状態。心臓モデルには弁の
   * ラベル情報が含まれていないため、大動脈基部と同様、冠動脈入口部の位置から
   * 逆算した推定位置に円盤を表示する(heartValveMesh.ts、ValveOverlay参照)。
   * 大動脈基部が接続すべき位置(大動脈弁の直上)を視覚的に確認しやすくするための
   * 補助表示。既定は非表示。
   */
  valves: Record<ValveId, ValveState>;
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
  setAorticRootDisplay: (patch: Partial<Omit<AorticRootState, "id" | "name">>) => void;
  setValveDisplay: (id: ValveId, patch: Partial<Omit<ValveState, "id" | "name">>) => void;
  /** 4つの弁の表示/非表示をまとめて切り替える(サイドバーの「まとめて表示/非表示」トグル用)。 */
  setAllValvesVisible: (visible: boolean) => void;
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
  /** ONの間、3Dビュー上で心臓メッシュをクリックすると、その点のワールド座標と
   * 大動脈基部フレーム基準の相対座標をコンソールへ出力する(ModelLoader.tsx参照)。
   * 弁の位置など、実データの無い構造をユーザー自身の目視識別で校正するための
   * デバッグ機能。 */
  debugCoordinatePicker: boolean;
  setDebugCoordinatePicker: (v: boolean) => void;
  stentLatticeParams: StentLatticeParams;
  setStentLatticeParams: (patch: Partial<StentLatticeParams>) => void;

  /**
   * Phase 7: 造影剤フローの再生状態。cine(拍動再生)とは独立したタイムラインで、
   * 「造影剤を注入」ボタンを押すたびにaccumulatedSeconds=0から再生し直す。
   */
  contrast: ContrastState;
  /**
   * 造影剤フローモードのON/OFF。既定(false)ではシネのリアルX線モードは
   * Phase 7実装前と同じ、常時フル吸収の血管描画になる。
   */
  setContrastEnabled: (enabled: boolean) => void;
  /** 現在の状態に関わらず、時刻0からplaying=trueで再生し直す(注入ボタン用)。 */
  injectContrast: () => void;
  playContrast: () => void;
  pauseContrast: () => void;
  /** 完全に停止し、時刻0(造影剤なし)に戻す。 */
  resetContrast: () => void;
  /** タイムラインスクラバー用。指定秒数の位置へ移動する(再生中ならそこから再生を継続)。 */
  seekContrast: (seconds: number) => void;
  setContrastParam: <K extends keyof ContrastFlowParams>(key: K, value: ContrastFlowParams[K]) => void;
  setContrastPlaybackSpeed: (multiplier: number) => void;

  /**
   * Phase 8: 心筋灌流領域・虚血表示のモード。造影剤フローモード(contrast)とは独立で、
   * こちらは「今の狭窄・石灰化の配置が、どの心筋領域にどれだけ血流制限を及ぼしているか」を
   * 常時反映する静的な表示(注入・再生の操作を必要としない)。
   */
  perfusion: PerfusionState;
  setPerfusionMode: (mode: PerfusionMode) => void;

  /** Phase 9: ガイドワイヤー・ガイディングカテーテルのデモ表示。 */
  guideDevice: GuideDeviceState;
  setGuideDeviceEnabled: (enabled: boolean) => void;
  setGuideDeviceShowCatheter: (show: boolean) => void;
  setGuideDeviceShowWire: (show: boolean) => void;
  /** 対象血管を変えると、その血管の本幹をワイヤーの目標枝に既定で戻し、進行度もリセットする。 */
  setGuideDeviceTargetVessel: (vesselId: VesselId) => void;
  setGuideDeviceTargetBranch: (branchId: string) => void;
  setGuideDeviceInsertionPhase: (phase: number) => void;
  setGuideDevicePlaying: (playing: boolean) => void;
  setGuideDeviceInsertionDuration: (seconds: number) => void;
  setGuideDeviceAccessRoute: (route: GuideAccessRoute) => void;
  setGuideDeviceShowDebugPath: (show: boolean) => void;
  setGuideDeviceShowStressHeatmap: (show: boolean) => void;
  /**
   * カテーテル・ワイヤーの現在の配置(先端位置・向き等)。Phase 10のバックアップ力
   * 簡易評価が参照しやすいよう、GuideDeviceMeshes.tsx/CineAnatomyModel.tsxが
   * ジオメトリを再計算するたびにここへ書き戻す(このデータはvesselIdやprogressから
   * 一意に決まる副産物であり、store自身が導出するものではない)。
   */
  guideDevicePlacement: GuideCatheterPlacement | null;
  setGuideDevicePlacement: (placement: GuideCatheterPlacement | null) => void;
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

const DEFAULT_AORTIC_ROOT_COLOR = "#d98a8a";
const DEFAULT_AORTIC_ROOT_OPACITY = 0.45;

/** 弁の既定の色・不透明度(色は要望通り大動脈弁=赤・肺動脈弁=青・僧帽弁=緑・
 * 三尖弁=黄だが、冠動脈(RCA=青・LAD=緑・LCX=黄)と同時表示した際に見分けやすい
 * よう、少しトーンを変えている)。 */
const DEFAULT_VALVE_OPACITY = 0.6;
const initialValves: Record<ValveId, ValveState> = {
  AORTIC: { id: "AORTIC", name: "大動脈弁 (aortic valve)", visible: false, color: "#e0453f", opacity: DEFAULT_VALVE_OPACITY },
  PULMONARY: {
    id: "PULMONARY",
    name: "肺動脈弁 (pulmonary valve)",
    visible: false,
    color: "#3d6fe0",
    opacity: DEFAULT_VALVE_OPACITY,
  },
  MITRAL: { id: "MITRAL", name: "僧帽弁 (mitral valve)", visible: false, color: "#3fbf6e", opacity: DEFAULT_VALVE_OPACITY },
  TRICUSPID: {
    id: "TRICUSPID",
    name: "三尖弁 (tricuspid valve)",
    visible: false,
    color: "#e0c23d",
    opacity: DEFAULT_VALVE_OPACITY,
  },
};

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
  calcificationAbsorption: 3,
  stentAbsorption: 220,
  catheterAbsorption: 30,
  wireAbsorption: 250,
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

/**
 * 既定(enabled=false)では造影剤フローモード自体がOFFで、シネのリアルX線モードは
 * Phase 7実装前と同じ常時フル吸収の血管描画になる。モードON中は未注入(濃度0)状態から
 * 始まり、注入ボタンを押すまでシネビューの血管は何も見えない。
 */
const initialContrast: ContrastState = {
  enabled: false,
  playing: false,
  playStartedAtMs: null,
  accumulatedSeconds: 0,
  playbackSpeedMultiplier: 1,
  params: DEFAULT_CONTRAST_FLOW_PARAMS,
};

const initialPerfusion: PerfusionState = {
  mode: "off",
};

/** 既定はRCA本幹への挿入(RCA-mainという命名規則はscripts/extract_centerlines.py参照)。 */
/** 以前は固定3秒だったが、体感が速すぎるとのフィードバックにより既定値を遅くした。GUIのスライダーで調整可能。 */
const DEFAULT_INSERTION_DURATION_SECONDS = 10;

const initialGuideDevice: GuideDeviceState = {
  enabled: false,
  showCatheter: true,
  showWire: true,
  targetVesselId: "RCA",
  accessRoute: "radial",
  targetBranchId: "RCA-main",
  insertionPhase: 0,
  playing: false,
  insertionDurationSeconds: DEFAULT_INSERTION_DURATION_SECONDS,
  showCatheterDebugPath: false,
  showStressHeatmap: false,
};

export const useCardioStore = create<CardioStore>((set) => ({
  heart: { id: "HEART", name: "Heart", visible: true, color: DEFAULT_HEART_COLOR, opacity: DEFAULT_HEART_OPACITY },
  aorticRoot: {
    id: "AORTIC_ROOT",
    name: "大動脈基部 (バルサルバ洞・上行大動脈)",
    visible: false,
    color: DEFAULT_AORTIC_ROOT_COLOR,
    opacity: DEFAULT_AORTIC_ROOT_OPACITY,
  },
  valves: initialValves,

  vessels: TRUNK_VESSELS,
  segmentMode: false,

  clipping: initialClipping,
  camera: initialCamera,
  resetCameraSignal: 0,

  setHeartDisplay: (patch) =>
    set((state) => ({ heart: { ...state.heart, ...patch } })),

  setAorticRootDisplay: (patch) =>
    set((state) => ({ aorticRoot: { ...state.aorticRoot, ...patch } })),

  setValveDisplay: (id, patch) =>
    set((state) => ({ valves: { ...state.valves, [id]: { ...state.valves[id], ...patch } } })),

  setAllValvesVisible: (visible) =>
    set((state) => {
      const valves = { ...state.valves };
      for (const id of Object.keys(valves) as ValveId[]) {
        valves[id] = { ...valves[id], visible };
      }
      return { valves };
    }),

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
      const valves = { ...state.valves };
      for (const id of Object.keys(valves) as ValveId[]) {
        valves[id] = { ...valves[id], color: initialValves[id].color, opacity: initialValves[id].opacity };
      }
      return {
        heart: { ...state.heart, color: DEFAULT_HEART_COLOR, opacity: DEFAULT_HEART_OPACITY },
        aorticRoot: { ...state.aorticRoot, color: DEFAULT_AORTIC_ROOT_COLOR, opacity: DEFAULT_AORTIC_ROOT_OPACITY },
        vessels,
        valves,
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
  debugCoordinatePicker: false,
  setDebugCoordinatePicker: (v) => set({ debugCoordinatePicker: v }),

  stentLatticeParams: DEFAULT_STENT_LATTICE_PARAMS,
  setStentLatticeParams: (patch) =>
    set((state) => ({ stentLatticeParams: { ...state.stentLatticeParams, ...patch } })),

  contrast: initialContrast,

  setContrastEnabled: (enabled) =>
    set((state) => ({
      // ONにする際は常に未注入(濃度0)の状態から始める(前回OFFにする直前の再生位置を
      // 引き継がない、「モードに入るたびに注入前から」という単純な挙動にする)。
      contrast: enabled
        ? { ...state.contrast, enabled, playing: false, playStartedAtMs: null, accumulatedSeconds: 0 }
        : { ...state.contrast, enabled },
    })),

  injectContrast: () =>
    set((state) => ({
      contrast: { ...state.contrast, playing: true, playStartedAtMs: performance.now(), accumulatedSeconds: 0 },
    })),

  playContrast: () =>
    set((state) => {
      if (state.contrast.playing) return state;
      return { contrast: { ...state.contrast, playing: true, playStartedAtMs: performance.now() } };
    }),

  pauseContrast: () => set((state) => ({ contrast: pauseContrastState(state.contrast) })),

  resetContrast: () =>
    set((state) => ({
      contrast: { ...state.contrast, playing: false, playStartedAtMs: null, accumulatedSeconds: 0 },
    })),

  seekContrast: (seconds) =>
    set((state) => {
      const accumulatedSeconds = Math.max(0, seconds);
      return {
        contrast: {
          ...state.contrast,
          accumulatedSeconds,
          playStartedAtMs: state.contrast.playing ? performance.now() : null,
        },
      };
    }),

  setContrastParam: (key, value) =>
    set((state) => ({
      contrast: { ...state.contrast, params: { ...state.contrast.params, [key]: value } },
    })),

  setContrastPlaybackSpeed: (multiplier) =>
    set((state) => ({ contrast: { ...state.contrast, playbackSpeedMultiplier: Math.max(0.05, multiplier) } })),

  perfusion: initialPerfusion,
  setPerfusionMode: (mode) => set((state) => ({ perfusion: { ...state.perfusion, mode } })),

  guideDevice: initialGuideDevice,

  setGuideDeviceEnabled: (enabled) => set((state) => ({ guideDevice: { ...state.guideDevice, enabled } })),

  setGuideDeviceShowCatheter: (show) =>
    set((state) => ({ guideDevice: { ...state.guideDevice, showCatheter: show } })),

  setGuideDeviceShowWire: (show) => set((state) => ({ guideDevice: { ...state.guideDevice, showWire: show } })),

  setGuideDeviceShowDebugPath: (show) =>
    set((state) => ({ guideDevice: { ...state.guideDevice, showCatheterDebugPath: show } })),

  setGuideDeviceShowStressHeatmap: (show) =>
    set((state) => ({ guideDevice: { ...state.guideDevice, showStressHeatmap: show } })),

  setGuideDeviceTargetVessel: (vesselId) =>
    set((state) => ({
      guideDevice: {
        ...state.guideDevice,
        targetVesselId: vesselId,
        targetBranchId: getMainTrunk(getVesselGraph(vesselId)).id,
        insertionPhase: 0,
        playing: false,
      },
    })),

  setGuideDeviceTargetBranch: (branchId) =>
    set((state) => ({
      guideDevice: { ...state.guideDevice, targetBranchId: branchId, insertionPhase: 0, playing: false },
    })),

  setGuideDeviceInsertionPhase: (phase) =>
    set((state) => ({ guideDevice: { ...state.guideDevice, insertionPhase: Math.max(0, Math.min(2, phase)) } })),

  setGuideDevicePlaying: (playing) => set((state) => ({ guideDevice: { ...state.guideDevice, playing } })),

  setGuideDeviceInsertionDuration: (seconds) =>
    set((state) => ({ guideDevice: { ...state.guideDevice, insertionDurationSeconds: Math.max(2, Math.min(30, seconds)) } })),

  setGuideDeviceAccessRoute: (route) => set((state) => ({ guideDevice: { ...state.guideDevice, accessRoute: route } })),

  guideDevicePlacement: null,
  setGuideDevicePlacement: (placement) => set({ guideDevicePlacement: placement }),
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

/** pauseCineStateと同じ考え方(cineのplayingとplaybackSpeedMultiplierが独立している点のみ異なる)。 */
function pauseContrastState(contrast: ContrastState): ContrastState {
  if (!contrast.playing || contrast.playStartedAtMs === null) return contrast;
  const elapsed = ((performance.now() - contrast.playStartedAtMs) / 1000) * contrast.playbackSpeedMultiplier;
  return {
    ...contrast,
    playing: false,
    playStartedAtMs: null,
    accumulatedSeconds: contrast.accumulatedSeconds + elapsed,
  };
}
