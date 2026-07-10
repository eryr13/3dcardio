import { create } from "zustand";
import type {
  CameraState,
  ClippingAxis,
  ClippingState,
  HeartState,
  VesselState,
} from "../types/anatomy";
import { buildSegmentVesselStates } from "../components/models/vesselSegments";

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
}

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

const initialCamera: CameraState = {
  position: { x: 0, y: 0, z: 0 },
  quaternion: [0, 0, 0, 1],
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
}));
