import { create } from "zustand";
import type {
  CameraState,
  ClippingAxis,
  ClippingState,
  HeartState,
  VesselId,
  VesselState,
} from "../types/anatomy";

interface CardioStore {
  heart: HeartState;
  vessels: Record<VesselId, VesselState>;
  clipping: ClippingState;
  camera: CameraState;
  /** インクリメントするたびに CameraRig 側で視点リセットを実行させるための信号 */
  resetCameraSignal: number;

  setHeartDisplay: (patch: Partial<Omit<HeartState, "id" | "name">>) => void;
  setVesselDisplay: (
    id: VesselId,
    patch: Partial<Omit<VesselState, "id" | "name">>,
  ) => void;

  setClippingAxis: (axis: ClippingAxis, patch: Partial<ClippingState[ClippingAxis]>) => void;
  resetClipping: () => void;

  setCamera: (camera: CameraState) => void;
  requestCameraReset: () => void;
}

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
  heart: { id: "HEART", name: "Heart", visible: true, color: "#b5474d", opacity: 0.9 },

  vessels: {
    RCA: { id: "RCA", name: "RCA (右冠動脈)", visible: true, color: "#3d8bfd", opacity: 1 },
    LAD: { id: "LAD", name: "LAD (左前下行枝)", visible: true, color: "#3ddc84", opacity: 1 },
    LCX: { id: "LCX", name: "LCX (左回旋枝)", visible: true, color: "#f7b731", opacity: 1 },
  },

  clipping: initialClipping,
  camera: initialCamera,
  resetCameraSignal: 0,

  setHeartDisplay: (patch) =>
    set((state) => ({ heart: { ...state.heart, ...patch } })),

  setVesselDisplay: (id, patch) =>
    set((state) => ({
      vessels: { ...state.vessels, [id]: { ...state.vessels[id], ...patch } },
    })),

  setClippingAxis: (axis, patch) =>
    set((state) => ({
      clipping: { ...state.clipping, [axis]: { ...state.clipping[axis], ...patch } },
    })),

  resetClipping: () => set({ clipping: initialClipping }),

  setCamera: (camera) => set({ camera }),

  requestCameraReset: () =>
    set((state) => ({ resetCameraSignal: state.resetCameraSignal + 1 })),
}));
