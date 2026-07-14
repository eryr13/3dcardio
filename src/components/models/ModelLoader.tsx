import { useEffect, useMemo, useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import { Html, Line, useGLTF } from "@react-three/drei";
import { Vector3 } from "three";
import type { BufferGeometry, Mesh, MeshStandardMaterial } from "three";
import type { AnatomyDisplayState, VesselId, ModelSource } from "../../types/anatomy";
import type { StenosisLesion, StentLesion } from "../../types/lesion";
import { getLesionsForVessel } from "../../types/lesion";
import { useCardioStore } from "../../store/useCardioStore";
import { HeartModel } from "./HeartModel";
import { HeartbeatGroup } from "./HeartbeatGroup";
import { LesionMeshes } from "./LesionMeshes";
import { buildStentGeometry } from "./stentLatticeMesh";
import { VesselModel } from "./VesselModel";
import type { CenterlinePoint } from "./vesselCenterline";
import { applyStenosisDeformation, getVesselCenterline } from "./vesselCenterline";
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
 * デバッグ用: 病変配置ロジックが参照している中心線データそのものを、実際の血管メッシュに
 * 重ねて可視化する(病変・ステントのジオメトリ生成は一切行わない)。血管メッシュ側と
 * 中心線データ側で座標変換の不整合(scale/rotation/position offsetの適用漏れ)が
 * 無いかを目視確認するための一時的なコード。
 */
const DEBUG_SHOW_CENTERLINES = true;
const CENTERLINE_DEBUG_COLORS: Record<VesselId, string> = {
  RCA: "#ff2d55",
  LAD: "#ffee00",
  LCX: "#00e5ff",
};

function CenterlineDebugOverlay({
  vesselId,
  centerline,
}: {
  vesselId: VesselId;
  centerline: CenterlinePoint[];
}) {
  if (centerline.length < 2) return null;
  const color = CENTERLINE_DEBUG_COLORS[vesselId];
  const points = centerline.map((p) => p.position);
  return (
    <>
      <Line points={points} color={color} lineWidth={3} />
      {centerline.map((p, i) => (
        <mesh key={i} position={p.position}>
          <sphereGeometry args={[Math.max(p.radius * 0.3, 0.0015), 6, 6]} />
          <meshBasicMaterial color={color} />
        </mesh>
      ))}
    </>
  );
}

/** 中心線上で最もローカル座標が近い点のtを返す(3Dビュー上でのクリック位置→病変位置の変換に使う)。 */
function nearestCenterlineT(centerline: CenterlinePoint[], localPoint: Vector3): number {
  let best = 0;
  let bestDistSq = Infinity;
  for (const p of centerline) {
    const d = p.position.distanceToSquared(localPoint);
    if (d < bestDistSq) {
      bestDistSq = d;
      best = p.t;
    }
  }
  return best;
}

/**
 * GLTF/GLBから読み込んだノードを name (HEART/RCA/LAD/LCX) で引き当て、
 * store の表示状態(visible/color/opacity)をマテリアルへ反映する。
 * segmentMode が有効な場合は主幹メッシュ(RCA/LAD/LCX)を隠し、代わりに
 * 幹の長さ方向で機械的に分割したセグメントメッシュを個別に描画する。
 *
 * Phase 6: 血管ごとに中心線を抽出し、狭窄(stenosis)病変があれば断面半径を
 * ガウス関数的に絞った変形済みジオメトリに差し替える(狭窄が無ければ元の
 * ジオメトリをそのまま使う)。石灰化・ステントは LesionMeshes が別メッシュとして
 * 重ねて描画する。3Dビュー上で血管をクリックすると、その位置を
 * store.pendingLesionPosition に記録し、LesionPanel の追加フォームに引き渡す。
 */
function GltfAnatomyModels({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);
  const segmentMode = useCardioStore((s) => s.segmentMode);
  const lesions = useCardioStore((s) => s.lesions);
  const setPendingLesionPosition = useCardioStore((s) => s.setPendingLesionPosition);
  const previewLesion = useCardioStore((s) => s.previewLesion);
  const editingLesionId = useCardioStore((s) => s.editingLesionId);
  const setEditingLesionId = useCardioStore((s) => s.setEditingLesionId);
  const updateLesion = useCardioStore((s) => s.updateLesion);
  const [hovered, setHovered] = useState<{ id: string; point: Vector3 } | null>(null);

  const meshesByName = useMemo(() => {
    const map = new Map<string, Mesh>();
    scene.traverse((obj) => {
      if ((obj as Mesh).isMesh) map.set(obj.name, obj as Mesh);
    });
    return map;
  }, [scene]);

  // 中心線は scripts/extract_centerlines.py が事前生成した src/data/centerlines.json
  // (血管メッシュのボクセル化+スケルトン化による抽出、詳細は vesselCenterline.ts 参照)を
  // そのまま使う。メッシュには依存しないため useMemo は不要。
  const centerlines = useMemo(() => {
    const result = new Map<VesselId, CenterlinePoint[]>();
    for (const id of VESSEL_IDS) {
      result.set(id, getVesselCenterline(id));
    }
    return result;
  }, []);

  // 狭窄病変に基づく変形済みジオメトリ。病変が無い血管は applyStenosisDeformation が
  // 元のジオメトリ参照をそのまま返すため、以降の処理でも「変形なし」を安全に判定できる。
  const deformedGeometries = useMemo(() => {
    const result = new Map<VesselId, BufferGeometry>();
    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      const centerline = centerlines.get(id);
      if (!mesh || !centerline) continue;
      const stenoses = getLesionsForVessel(lesions, id).filter(
        (l): l is StenosisLesion => l.type === "stenosis",
      );
      result.set(id, applyStenosisDeformation(mesh.geometry, centerline, stenoses));
    }
    return result;
  }, [meshesByName, centerlines, lesions]);

  useEffect(() => {
    applyDisplayState(meshesByName.get("HEART"), heart);
  }, [meshesByName, heart]);

  // 主幹メッシュの表示: セグメントモード、または狭窄変形が入っている場合は元メッシュを
  // 隠し、置き換え用のJSXメッシュ側で描画する。それ以外は従来通り store の値を反映する。
  useEffect(() => {
    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      if (!mesh) continue;
      const isDeformed = deformedGeometries.get(id) !== mesh.geometry;
      if (segmentMode || isDeformed) {
        mesh.visible = false;
      } else {
        applyDisplayState(mesh, vessels[id]);
      }
    }
  }, [meshesByName, vessels, segmentMode, deformedGeometries]);

  // 主幹ジオメトリ(狭窄変形済み、無ければ元ジオメトリ)をセグメント数に分割したもの。
  const segmentGeometries = useMemo(() => {
    const result = new Map<string, BufferGeometry[]>();
    for (const id of VESSEL_IDS) {
      const geometry = deformedGeometries.get(id) ?? meshesByName.get(id)?.geometry;
      if (!geometry) continue;
      result.set(id, splitGeometryByLength(geometry, SEGMENT_DEFS[id].length));
    }
    return result;
  }, [meshesByName, deformedGeometries]);

  /**
   * 3Dビュー上のクリックを、新規追加フォームへの位置事前入力(pendingLesionPosition)、
   * または編集中の既存病変(editingLesionId)の位置更新のどちらかに振り分ける。
   * 編集モード中は、クリック1回で即座にその病変の位置を更新し編集モードを終了する
   * (「クリックし直して位置を変更」という単発操作として設計)。
   */
  function placeLesionFromPoint(vesselId: VesselId, mesh: Mesh, worldPoint: Vector3) {
    const centerline = centerlines.get(vesselId);
    if (!centerline) return;
    const localPoint = mesh.worldToLocal(worldPoint.clone());
    const t = nearestCenterlineT(centerline, localPoint);
    if (editingLesionId) {
      updateLesion(editingLesionId, { vesselId, position: t });
      setEditingLesionId(null);
    } else {
      setPendingLesionPosition({ vesselId, position: t });
    }
  }

  function placeLesionFromClick(vesselId: VesselId, e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    placeLesionFromPoint(vesselId, e.object as Mesh, e.point);
  }

  /**
   * <primitive object={scene}> はHEART/RCA/LAD/LCXをまとめて1つのオブジェクトツリーとして
   * 扱うため、このonClickは(名前が一致する子孫を持つ祖先として)ツリー内で最も手前の
   * 交差1件だけを e.object として受け取る。three.jsのraycastは既定でvisible=falseの
   * オブジェクトを除外しないため、心臓の表示をOFFにしていても、視点から見て血管より
   * 手前にある(無効化されていない)心臓メッシュがヒットしてしまい、血管がクリックできない
   * 不具合があった(実機検証で確認: 心臓非表示のままLAD/RCA/LCXをクリックしても
   * e.object.name が "HEART" になっていた)。e.intersections(交差全件、手前から順)を
   * 走査し、実際にvisibleな血管メッシュが見つかるまでスキップすることで回避する。
   */
  function handlePrimitiveClick(e: ThreeEvent<MouseEvent>) {
    const hit = e.intersections.find(
      (i) => i.object.visible && VESSEL_IDS.includes(i.object.name as VesselId),
    );
    if (!hit) return;
    e.stopPropagation();
    placeLesionFromPoint(hit.object.name as VesselId, hit.object as Mesh, hit.point);
  }

  /**
   * 病変追加フォームで位置・長さを微調整している間の配置プレビュー(簡易円筒)。
   * まだstore.lesionsに登録されていない下書き状態を、実際のステント生成ロジック
   * (buildStentGeometry、中心線の中央値半径ベースで一様な円筒になる)を使って
   * その場で組み立てる。病変タイプによらず同じ簡易円筒で表示する(見た目の作り込みは
   * 「確定」後の本描画に任せる)。
   */
  const previewGeometry = useMemo(() => {
    if (!previewLesion) return null;
    const centerline = centerlines.get(previewLesion.vesselId);
    if (!centerline) return null;
    const fakeStent: StentLesion = {
      id: "preview",
      type: "stent",
      vesselId: previewLesion.vesselId,
      position: previewLesion.position,
      length: previewLesion.length,
      diameter: 3.0,
      visible: true,
    };
    return buildStentGeometry(centerline, fakeStent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerlines, previewLesion?.vesselId, previewLesion?.position, previewLesion?.length]);

  return (
    <HeartbeatGroup>
      <primitive object={scene} onClick={handlePrimitiveClick} />

      {/* 狭窄変形が入っている主幹の置き換えメッシュ(セグメントモードOFF時のみ) */}
      {!segmentMode &&
        VESSEL_IDS.map((id) => {
          const mesh = meshesByName.get(id);
          const deformed = deformedGeometries.get(id);
          if (!mesh || !deformed || deformed === mesh.geometry) return null;
          const state = vessels[id];
          if (!state) return null;
          return (
            <mesh
              key={id}
              name={id}
              geometry={deformed}
              visible={state.visible}
              castShadow
              receiveShadow
              onClick={(e) => placeLesionFromClick(id, e)}
            >
              <meshStandardMaterial
                color={state.color}
                transparent={state.opacity < 1}
                opacity={state.opacity}
                depthWrite={state.opacity >= 1}
                roughness={0.4}
                metalness={0.1}
                onUpdate={(material) => {
                  material.needsUpdate = true;
                }}
              />
            </mesh>
          );
        })}

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
                onClick={(e) => placeLesionFromClick(trunkId, e)}
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

      {VESSEL_IDS.map((id) => {
        const centerline = centerlines.get(id);
        if (!centerline || !vessels[id]?.visible) return null;
        return <LesionMeshes key={id} vesselId={id} centerline={centerline} lesions={lesions} />;
      })}

      {DEBUG_SHOW_CENTERLINES &&
        VESSEL_IDS.map((id) => {
          const centerline = centerlines.get(id);
          if (!centerline || !vessels[id]?.visible) return null;
          return <CenterlineDebugOverlay key={`centerline-debug-${id}`} vesselId={id} centerline={centerline} />;
        })}

      {previewGeometry && previewLesion && vessels[previewLesion.vesselId]?.visible && (
        <mesh geometry={previewGeometry}>
          <meshStandardMaterial color="#4fd7ff" transparent opacity={0.5} metalness={0} roughness={0.6} />
        </mesh>
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
