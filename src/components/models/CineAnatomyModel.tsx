import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { BackSide, Mesh, MeshBasicMaterial, MultiplyBlending, NormalBlending } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId, VesselState } from "../../types/anatomy";
import { HeartbeatGroup } from "./HeartbeatGroup";
import { cineSceneBridge } from "./cineSceneBridge";

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
  const showHeartOutline = useCardioStore((s) => s.cine.showHeartOutline);

  const built = useMemo(() => {
    const root = scene.clone(true);
    const meshesByName = new Map<string, Mesh>();
    root.traverse((obj) => {
      if ((obj as Mesh).isMesh) meshesByName.set(obj.name, obj as Mesh);
    });

    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      if (!mesh) continue;
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

    return { root, meshesByName, outline };
  }, [scene]);

  useEffect(() => {
    for (const id of VESSEL_IDS) {
      const mesh = built.meshesByName.get(id);
      if (mesh) mesh.visible = isTrunkVisibleInCine(vessels, id);
    }
  }, [built, vessels]);

  useEffect(() => {
    if (!built.outline) return;
    built.outline.depthMesh.visible = showHeartOutline;
    built.outline.rimMesh.visible = showHeartOutline;
  }, [built, showHeartOutline]);

  return (
    <HeartbeatGroup
      onMount={(group) => {
        if (cineSceneBridge.current) cineSceneBridge.current.pulseGroup = group;
      }}
    >
      <primitive object={built.root} />
    </HeartbeatGroup>
  );
}

useGLTF.preload(REALISTIC_HEART_URL);
