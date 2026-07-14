import { useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import {
  BackSide,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  MultiplyBlending,
  NormalBlending,
} from "three";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId, VesselState } from "../../types/anatomy";
import type { CalcificationLesion, StenosisLesion, StentLesion } from "../../types/lesion";
import { getLesionsForVessel } from "../../types/lesion";
import { HeartbeatGroup } from "./HeartbeatGroup";
import { useCalcificationGeometry, useStentGeometry } from "./LesionMeshes";
import { cineSceneBridge } from "./cineSceneBridge";
import type { CenterlinePoint } from "./vesselCenterline";
import { applyStenosisDeformation, getVesselCenterline } from "./vesselCenterline";

/** メインビューと同じGLB。将来DICOM由来メッシュに差し替える際もここを変えるだけでよい。 */
export const REALISTIC_HEART_URL = "/models/heart-realistic.glb";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];

/**
 * 血管のX線風マテリアル。乗算ブレンディングは可換(描画順に依存しない)なので、
 * 投影方向で複数の血管が重なるほど自然に濃くなる。depthTest/depthWriteを切ると
 * 重なった血管がデプスバッファで隠れずに全て乗算に参加できる。
 */
function createVesselMaterial() {
  return new MeshBasicMaterial({
    color: "#4a4a4a",
    transparent: true,
    blending: MultiplyBlending,
    // three.js は MultiplyBlending に premultipliedAlpha を要求する(未設定だと警告が出る)。
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** 病変(石灰化・ステント)のスキーマ表示用マテリアル。血管と同じ乗算ブレンディングだが、
 * 少し明るいグレーにして血管と見分けがつくようにする。 */
function createLesionSilhouetteMaterial(color: string) {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    blending: MultiplyBlending,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** リアルX線モードの深度ピール吸収係数。「石灰化は血管よりさらに暗く」「ステントは金属特有の強いコントラスト」 */
const CALCIFICATION_ABSORPTION = 25;
const STENT_ABSORPTION = 45;

/** 心臓の輪郭を「内側を深度だけ塗って隠す」+「一回り拡大した裏面シェル」の2枚で表現する */
function createHeartOutlineMaterials() {
  const depthMask = new MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
  });
  const rim = new MeshBasicMaterial({
    color: "#8a8a8a",
    transparent: true,
    opacity: 0.25,
    blending: NormalBlending,
    side: BackSide,
    depthWrite: false,
    depthTest: true,
  });
  return { depthMask, rim };
}

/**
 * リアルX線モードの血管厚み積算(CineVesselThicknessEffect)で使う「近位度」を
 * 頂点属性 aProximity として焼き込んだジオメトリを作る。ローカルY座標が高いほど
 * 近位(心基部側)、低いほど遠位(心尖側)という vesselSegments.ts と同じ約束事で
 * 0〜1に正規化する。mesh.geometry は scene.clone(true) 由来でメインビューと参照を
 * 共有しているため、必ず複製してから属性を追加する(メインビューに影響させない)。
 */
function attachProximityAttribute(geometry: BufferGeometry): BufferGeometry {
  const cloned = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const position = cloned.getAttribute("position");
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const range = maxY - minY || 1;
  const proximity = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    proximity[i] = (position.getY(i) - minY) / range;
  }
  cloned.setAttribute("aProximity", new Float32BufferAttribute(proximity, 1));
  return cloned;
}

function isTrunkVisibleInCine(vessels: Record<string, VesselState>, trunkId: VesselId): boolean {
  const trunk = vessels[trunkId];
  if (trunk) return trunk.visible;
  // セグメントモード中は主幹のエントリ自体が無いので、そのセグメントが1つでも
  // 表示されていれば主幹も表示する扱いにする(parentVesselで所属を辿れる)。
  return Object.values(vessels).some((v) => v.parentVessel === trunkId && v.visible);
}

/**
 * シネビュー(X線風平行投影)専用の解剖モデル。メインビューが使う useGLTF(url) の
 * キャッシュを共有しつつ scene.clone(true) で独立した階層を作る
 * (Object3Dは同時に1つの親しか持てないため、同じsceneをメインビューとシネビューの
 * 2つのCanvasに挿入することはできない)。clone(true) は geometry/material を参照共有
 * するため、ここで各メッシュの material は必ず新しいインスタンスに差し替える
 * (既存material をミューテートするとメインビューの表示まで壊れる)。
 */
export function CineAnatomyModel() {
  const { scene } = useGLTF(REALISTIC_HEART_URL);
  const vessels = useCardioStore((s) => s.vessels);
  const lesions = useCardioStore((s) => s.lesions);
  const showHeartOutline = useCardioStore((s) => s.cine.showHeartOutline);
  const xrayMode = useCardioStore((s) => s.cine.xrayMode);

  const built = useMemo(() => {
    const root = scene.clone(true);
    const meshesByName = new Map<string, Mesh>();
    root.traverse((obj) => {
      if ((obj as Mesh).isMesh) meshesByName.set(obj.name, obj as Mesh);
    });

    const centerlines = new Map<VesselId, CenterlinePoint[]>();
    const originalGeometries = new Map<VesselId, BufferGeometry>();
    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      if (!mesh) continue;
      centerlines.set(id, getVesselCenterline(id));
      // 狭窄変形前の素のジオメトリを保持しておく(scene.clone(true)由来でメインビューと
      // 参照を共有しているが、ここでは読み取り専用に使い、変形結果は別途複製して割り当てる)。
      originalGeometries.set(id, mesh.geometry);
      mesh.material = createVesselMaterial();
    }

    const heartMesh = meshesByName.get("HEART");
    let outline: { depthMesh: Mesh; rimMesh: Mesh } | undefined;
    if (heartMesh) {
      // 心臓本体そのものは塗りつぶさない(実際の透視でも心臓は写らないか、うっすら輪郭が見える程度のため)
      heartMesh.visible = false;

      const { depthMask, rim } = createHeartOutlineMaterials();
      const depthMesh = new Mesh(heartMesh.geometry, depthMask);
      depthMesh.position.copy(heartMesh.position);
      depthMesh.quaternion.copy(heartMesh.quaternion);
      depthMesh.scale.copy(heartMesh.scale);

      const rimMesh = new Mesh(heartMesh.geometry, rim);
      rimMesh.position.copy(heartMesh.position);
      rimMesh.quaternion.copy(heartMesh.quaternion);
      rimMesh.scale.copy(heartMesh.scale).multiplyScalar(1.02);

      heartMesh.parent?.add(depthMesh);
      heartMesh.parent?.add(rimMesh);
      outline = { depthMesh, rimMesh };
    }

    return { root, meshesByName, centerlines, originalGeometries, outline };
  }, [scene]);

  // Phase 6: 狭窄病変に基づいてジオメトリを変形し、深度ピール用のaProximity属性を
  // 焼き直す。built(=scene.clone(true)由来のcine専用複製)のmesh.geometryだけを
  // 差し替えるため、メインビュー側には一切影響しない。
  useEffect(() => {
    for (const id of VESSEL_IDS) {
      const mesh = built.meshesByName.get(id);
      const centerline = built.centerlines.get(id);
      const originalGeometry = built.originalGeometries.get(id);
      if (!mesh || !centerline || !originalGeometry) continue;
      const stenoses = getLesionsForVessel(lesions, id).filter(
        (l): l is StenosisLesion => l.type === "stenosis",
      );
      const deformed = applyStenosisDeformation(originalGeometry, centerline, stenoses);
      mesh.geometry = attachProximityAttribute(deformed);
    }
  }, [built, lesions]);

  useEffect(() => {
    const vesselMeshes: Partial<Record<VesselId, Mesh>> = {};
    for (const id of VESSEL_IDS) {
      const mesh = built.meshesByName.get(id);
      if (mesh) vesselMeshes[id] = mesh;
    }
    if (cineSceneBridge.current) {
      cineSceneBridge.current.vesselMeshes = vesselMeshes;
      cineSceneBridge.current.heartMesh = built.meshesByName.get("HEART") ?? null;
    }
  }, [built]);

  useEffect(() => {
    const vesselVisible: Partial<Record<VesselId, boolean>> = {};
    for (const id of VESSEL_IDS) {
      const mesh = built.meshesByName.get(id);
      const trunkVisible = isTrunkVisibleInCine(vessels, id);
      vesselVisible[id] = trunkVisible;
      // リアルX線モードでは塗りつぶしメッシュ自体は表示せず、CineVesselThicknessEffect が
      // 深度ピールで血管濃淡を描く(vesselVisible経由で表示/非表示トグルを反映させる)。
      if (mesh) mesh.visible = trunkVisible && !xrayMode;
    }
    if (cineSceneBridge.current) cineSceneBridge.current.vesselVisible = vesselVisible;
  }, [built, vessels, xrayMode]);

  useEffect(() => {
    if (!built.outline) return;
    // リアルX線モード中は輪郭線ではなくCineVesselThicknessEffectの深度ピール陰影で
    // 心臓を表現するため、showHeartOutlineがONでも輪郭線は強制的に非表示にする
    // (スキーマ表示側の挙動は変更しない)。
    const visible = showHeartOutline && !xrayMode;
    built.outline.depthMesh.visible = visible;
    built.outline.rimMesh.visible = visible;
  }, [built, showHeartOutline, xrayMode]);

  // Phase 6: 石灰化・ステントの病変メッシュへの参照を集約し、CineVesselThicknessEffectが
  // リアルX線モードで深度ピール密度表現に使う固定プール(cineSceneBridge.lesionProxies)へ
  // 反映する。個々のCineCalcificationBump/CineStentLatticeのrefコールバックから呼ばれる。
  const lesionMeshRefsById = useRef(new Map<string, { mesh: Mesh; absorption: number }>());

  function syncLesionProxies() {
    if (!cineSceneBridge.current) return;
    cineSceneBridge.current.lesionProxies = Array.from(lesionMeshRefsById.current.entries())
      .slice(0, 6)
      .map(([id, entry]) => ({ id, mesh: entry.mesh, absorption: entry.absorption }));
  }

  function registerLesionMesh(id: string, absorption: number) {
    return (mesh: Mesh | null) => {
      if (mesh) lesionMeshRefsById.current.set(id, { mesh, absorption });
      else lesionMeshRefsById.current.delete(id);
      syncLesionProxies();
    };
  }

  const visibleCalcifications = lesions.filter(
    (l): l is CalcificationLesion => l.type === "calcification" && l.visible,
  );
  const visibleStents = lesions.filter((l): l is StentLesion => l.type === "stent" && l.visible);

  return (
    <HeartbeatGroup
      onMount={(group) => {
        if (cineSceneBridge.current) cineSceneBridge.current.pulseGroup = group;
      }}
    >
      <primitive object={built.root} />

      {visibleCalcifications.map((lesion) => {
        const centerline = built.centerlines.get(lesion.vesselId);
        if (!centerline) return null;
        return (
          <CineCalcificationBump
            key={lesion.id}
            lesion={lesion}
            centerline={centerline}
            xrayMode={xrayMode}
            onRef={registerLesionMesh(lesion.id, CALCIFICATION_ABSORPTION)}
          />
        );
      })}
      {visibleStents.map((lesion) => {
        const centerline = built.centerlines.get(lesion.vesselId);
        if (!centerline) return null;
        return (
          <CineStentLattice
            key={lesion.id}
            lesion={lesion}
            centerline={centerline}
            xrayMode={xrayMode}
            onRef={registerLesionMesh(lesion.id, STENT_ABSORPTION)}
          />
        );
      })}
    </HeartbeatGroup>
  );
}

interface CineLesionMeshProps<T> {
  lesion: T;
  centerline: CenterlinePoint[];
  /** リアルX線モード中は色パス用メッシュを隠す(密度表現はCineVesselThicknessEffect側が担う) */
  xrayMode: boolean;
  onRef: (mesh: Mesh | null) => void;
}

function CineCalcificationBump({ lesion, centerline, xrayMode, onRef }: CineLesionMeshProps<CalcificationLesion>) {
  const geometry = useCalcificationGeometry(centerline, lesion);
  const material = useMemo(() => createLesionSilhouetteMaterial("#dcdcdc"), []);
  return <mesh geometry={geometry} material={material} visible={!xrayMode} ref={onRef} />;
}

function CineStentLattice({ lesion, centerline, xrayMode, onRef }: CineLesionMeshProps<StentLesion>) {
  const geometry = useStentGeometry(centerline, lesion);
  const material = useMemo(() => createLesionSilhouetteMaterial("#c8c8c8"), []);
  return <mesh geometry={geometry} material={material} visible={!xrayMode} ref={onRef} />;
}

useGLTF.preload(REALISTIC_HEART_URL);
