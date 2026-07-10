import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import type { Mesh, MeshStandardMaterial } from "three";
import type { AnatomyDisplayState, ModelSource, VesselId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import { HeartModel } from "./HeartModel";
import { VesselModel } from "./VesselModel";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];

/**
 * BodyParts3D(DBCLS, CC BY-SA 2.1 Japan)由来の実メッシュ。心臓壁(FMA7274)と
 * 右冠動脈(FMA3802+3818+3840nsn)/左前下行枝(FMA3862nsn)/左回旋枝(FMA3895)を
 * HEART/RCA/LAD/LCXという名前でまとめた単一GLB。詳細は public/models/README.md 参照。
 */
const REALISTIC_HEART_URL = "/models/heart-realistic.glb";

interface AnatomyModelsProps {
  source?: ModelSource;
}

/**
 * 心臓・血管モデルの読み込みエントリポイント。
 * source を切り替えるだけでプレースホルダー生成と実メッシュ(GLTF/GLB)読み込みを
 * 差し替えられるようにするための唯一の分岐点。Scene 側はこのコンポーネントの
 * 内部実装を意識しなくてよい。
 */
export function AnatomyModels({ source = { type: "gltf", url: REALISTIC_HEART_URL } }: AnatomyModelsProps) {
  if (source.type === "gltf") {
    return <GltfAnatomyModels url={source.url} />;
  }

  return (
    <group name="AnatomyRoot">
      <HeartModel />
      {VESSEL_IDS.map((id) => (
        <VesselModel key={id} id={id} />
      ))}
    </group>
  );
}

/**
 * GLTF/GLBから読み込んだノードを name (HEART/RCA/LAD/LCX) で引き当て、
 * store の表示状態(visible/color/opacity)をマテリアルへ反映する。
 */
function GltfAnatomyModels({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);

  const meshesByName = useMemo(() => {
    const map = new Map<string, Mesh>();
    scene.traverse((obj) => {
      if ((obj as Mesh).isMesh) map.set(obj.name, obj as Mesh);
    });
    return map;
  }, [scene]);

  useEffect(() => {
    applyDisplayState(meshesByName.get("HEART"), heart);
  }, [meshesByName, heart]);

  useEffect(() => {
    for (const id of VESSEL_IDS) {
      applyDisplayState(meshesByName.get(id), vessels[id]);
    }
  }, [meshesByName, vessels]);

  return <primitive object={scene} />;
}

function applyDisplayState(mesh: Mesh | undefined, state: AnatomyDisplayState) {
  if (!mesh) return;
  mesh.visible = state.visible;
  const material = mesh.material as MeshStandardMaterial;
  material.color.set(state.color);
  material.transparent = state.opacity < 1;
  material.opacity = state.opacity;
}

useGLTF.preload(REALISTIC_HEART_URL);
