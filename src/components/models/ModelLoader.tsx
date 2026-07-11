import { useEffect, useMemo, useState } from "react";
import { Html, useGLTF } from "@react-three/drei";
import type { BufferGeometry, Mesh, MeshStandardMaterial, Vector3 } from "three";
import type { AnatomyDisplayState, VesselId, ModelSource } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import { HeartModel } from "./HeartModel";
import { HeartbeatGroup } from "./HeartbeatGroup";
import { VesselModel } from "./VesselModel";
import { SEGMENT_DEFS, splitGeometryByLength } from "./vesselSegments";

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
    <HeartbeatGroup>
      <group name="AnatomyRoot">
        <HeartModel />
        {VESSEL_IDS.map((id) => (
          <VesselModel key={id} id={id} />
        ))}
      </group>
    </HeartbeatGroup>
  );
}

/**
 * GLTF/GLBから読み込んだノードを name (HEART/RCA/LAD/LCX) で引き当て、
 * store の表示状態(visible/color/opacity)をマテリアルへ反映する。
 * segmentMode が有効な場合は主幹メッシュ(RCA/LAD/LCX)を隠し、代わりに
 * 幹の長さ方向で機械的に分割したセグメントメッシュを個別に描画する。
 */
function GltfAnatomyModels({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);
  const segmentMode = useCardioStore((s) => s.segmentMode);
  const [hovered, setHovered] = useState<{ id: string; point: Vector3 } | null>(null);

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

  // 主幹メッシュの表示: segmentMode がOFFの時だけ store の値をそのまま反映し、
  // ONの時は常に隠してセグメントメッシュ側に描画を委ねる。
  useEffect(() => {
    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      if (!mesh) continue;
      if (segmentMode) {
        mesh.visible = false;
      } else {
        applyDisplayState(mesh, vessels[id]);
      }
    }
  }, [meshesByName, vessels, segmentMode]);

  // 主幹ジオメトリをセグメント数に分割したものをキャッシュ(トグルのたびに再計算しない)。
  const segmentGeometries = useMemo(() => {
    const result = new Map<string, BufferGeometry[]>();
    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      if (!mesh) continue;
      result.set(id, splitGeometryByLength(mesh.geometry, SEGMENT_DEFS[id].length));
    }
    return result;
  }, [meshesByName]);

  return (
    <HeartbeatGroup>
      <primitive object={scene} />
      {segmentMode &&
        VESSEL_IDS.flatMap((trunkId) => {
          const geometries = segmentGeometries.get(trunkId);
          if (!geometries) return [];
          return SEGMENT_DEFS[trunkId].map((def, i) => {
            const state = vessels[def.id];
            if (!state) return null;
            return (
              <mesh
                key={def.id}
                geometry={geometries[i]}
                visible={state.visible}
                castShadow
                receiveShadow
                onPointerOver={(e) => {
                  e.stopPropagation();
                  setHovered({ id: def.id, point: e.point });
                }}
                onPointerMove={(e) => {
                  e.stopPropagation();
                  setHovered({ id: def.id, point: e.point });
                }}
                onPointerOut={(e) => {
                  e.stopPropagation();
                  setHovered((h) => (h?.id === def.id ? null : h));
                }}
              >
                <meshStandardMaterial
                  color={state.color}
                  transparent={state.opacity < 1}
                  opacity={state.opacity}
                  depthWrite={state.opacity >= 1}
                  roughness={0.4}
                  metalness={0.1}
                  // transparent/opacity の変更を確実に再描画へ反映させるため、
                  // 各コミット後に needsUpdate を明示する(ModelLoader の
                  // applyDisplayState と同じ理由。R3F の宣言的プロパティ更新
                  // だけでは three.js 側に反映されないケースがあるため)。
                  onUpdate={(material) => {
                    material.needsUpdate = true;
                  }}
                />
              </mesh>
            );
          });
        })}
      {segmentMode && hovered && vessels[hovered.id] && (
        <Html position={hovered.point} style={{ pointerEvents: "none" }}>
          <div className="segment-tooltip">{vessels[hovered.id].name}</div>
        </Html>
      )}
    </HeartbeatGroup>
  );
}

function applyDisplayState(mesh: Mesh | undefined, state: AnatomyDisplayState) {
  if (!mesh) return;
  mesh.visible = state.visible;
  const material = mesh.material as MeshStandardMaterial;
  material.color.set(state.color);
  material.transparent = state.opacity < 1;
  material.opacity = state.opacity;
  // 半透明時は他の半透明メッシュとの深度書き込み競合を避ける(標準的な透明描画の作法)。
  material.depthWrite = state.opacity >= 1;
  // GLTFLoader 由来のマテリアルは transparent/opacity をランタイムで変更しても
  // needsUpdate を明示しないと再描画に反映されないため必須。
  material.needsUpdate = true;
}

useGLTF.preload(REALISTIC_HEART_URL);
