import { useEffect, useMemo, useState } from "react";
import { Html, Line, useGLTF } from "@react-three/drei";
import { Box3, Vector3 } from "three";
import type { BufferGeometry, Mesh, MeshStandardMaterial } from "three";
import type { AnatomyDisplayState, VesselId, ModelSource } from "../../types/anatomy";
import type { StentObject } from "../../types/object";
import { useCardioStore } from "../../store/useCardioStore";
import { HeartModel } from "./HeartModel";
import { HeartbeatGroup } from "./HeartbeatGroup";
import { ObjectMeshes } from "./ObjectMeshes";
import { buildStentGeometry } from "./stentLatticeMesh";
import { VesselModel } from "./VesselModel";
import type { VesselGraph } from "./vesselGraph";
import { getBranch, getBranchesAtNode, getMainTrunk, getVesselGraph } from "./vesselGraph";
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
 * デバッグ用: 中心線グラフの全枝(本幹+側枝)を、実際の血管メッシュに重ねて可視化する
 * (オブジェクトのジオメトリ生成は一切行わない)。本幹判定ロジックが解剖学的に
 * 妥当な経路を選べているか、側枝が正しく分離されているかを目視確認するためのもので、
 * サイドバーの「デバッグ(開発者向け)」パネルから表示/非表示を切り替えられる
 * (既定は非表示、store.debugShowCenterlines参照)。
 * 本幹は白の太線、側枝は枝ごとに色を変えた細線で表示する。
 */
const SIDE_BRANCH_DEBUG_COLORS = ["#ff2d55", "#ffee00", "#00e5ff", "#ff9500", "#af52de", "#34c759", "#5ac8fa"];

function CenterlineDebugOverlay({ vesselId }: { vesselId: VesselId }) {
  const graph = useMemo(() => getVesselGraph(vesselId), [vesselId]);
  return (
    <>
      {graph.branches.map((branch, i) => {
        if (branch.points.length < 2) return null;
        const color = branch.isMainTrunk ? "#ffffff" : SIDE_BRANCH_DEBUG_COLORS[i % SIDE_BRANCH_DEBUG_COLORS.length];
        const points = branch.points.map((p) => p.position);
        return (
          <Line
            key={branch.id}
            points={points}
            color={color}
            lineWidth={branch.isMainTrunk ? 5 : 2}
          />
        );
      })}
    </>
  );
}

/**
 * ノードクリックで選んだ位置を、オブジェクトの(branchId, position)へ変換する。
 * 根(起始部)なら本幹のt=0。それ以外は、そのノードを端点に持つ枝のうち本幹を優先し
 * (本幹上の分岐点ならそのまま本幹上の位置として扱う)、無ければ最初に見つかった側枝を使う。
 * 側枝の場合、そのノードが枝の近位端(startNodeId)ならt=0、遠位端(endNodeId)ならt=1になる。
 */
function resolveNodeSelection(graph: VesselGraph, nodeId: string): { branchId: string; position: number } {
  if (nodeId === graph.rootNodeId) {
    return { branchId: getMainTrunk(graph).id, position: 0 };
  }
  const candidates = getBranchesAtNode(graph, nodeId);
  const branch = candidates.find((b) => b.isMainTrunk) ?? candidates[0];
  if (!branch) return { branchId: getMainTrunk(graph).id, position: 0 };
  return { branchId: branch.id, position: branch.startNodeId === nodeId ? 0 : 1 };
}

const NODE_MARKER_COLOR = "#4fd7ff";
const NODE_MARKER_HOVER_COLOR = "#ffee00";

/**
 * オブジェクト追加/位置変更モード中だけ表示する、中心線グラフのノード(起始部・分岐点・端点)の
 * クリック可能なマーカー。画面が常時うるさくならないよう、呼び出し側でモード中のみ描画する。
 */
function NodeMarkers({
  vesselId,
  graph,
  onSelect,
}: {
  vesselId: VesselId;
  graph: VesselGraph;
  onSelect: (vesselId: VesselId, nodeId: string) => void;
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const hoveredNode = graph.nodes.find((n) => n.id === hoveredNodeId);
  const hoveredLabel = hoveredNode
    ? getBranchesAtNode(graph, hoveredNode.id)
        .map((b) => b.label)
        .join(" / ")
    : null;

  return (
    <>
      {graph.nodes.map((node) => {
        const isHovered = hoveredNodeId === node.id;
        return (
          <mesh
            key={node.id}
            position={node.position}
            renderOrder={999}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(vesselId, node.id);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              setHoveredNodeId(node.id);
            }}
            onPointerOut={(e) => {
              e.stopPropagation();
              setHoveredNodeId((id) => (id === node.id ? null : id));
            }}
          >
            <sphereGeometry args={[isHovered ? 0.028 : 0.02, 12, 12]} />
            <meshBasicMaterial
              color={isHovered ? NODE_MARKER_HOVER_COLOR : NODE_MARKER_COLOR}
              transparent
              opacity={0.9}
              depthTest={false}
              depthWrite={false}
            />
          </mesh>
        );
      })}
      {hoveredNode && hoveredLabel && (
        <Html position={hoveredNode.position} style={{ pointerEvents: "none" }}>
          <div className="object-node-tooltip">{hoveredLabel} 分岐部</div>
        </Html>
      )}
    </>
  );
}

/**
 * GLTF/GLBから読み込んだノードを name (HEART/RCA/LAD/LCX) で引き当て、
 * store の表示状態(visible/color/opacity)をマテリアルへ反映する。
 * segmentMode が有効な場合は主幹メッシュ(RCA/LAD/LCX)を隠し、代わりに
 * 幹の長さ方向で機械的に分割したセグメントメッシュを個別に描画する。
 *
 * Phase 6: 血管ごとに中心線を抽出し、狭窄(stenosis)オブジェクトがあれば断面半径を
 * ガウス関数的に絞った変形済みジオメトリに差し替える(狭窄が無ければ元の
 * ジオメトリをそのまま使う)。石灰化・ステントは ObjectMeshes が別メッシュとして
 * 重ねて描画する。3Dビュー上でノードをクリックすると、その位置を
 * store.pendingObjectPosition に記録し、ObjectPanel の追加フォームに引き渡す。
 */
function GltfAnatomyModels({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  const heart = useCardioStore((s) => s.heart);
  const vessels = useCardioStore((s) => s.vessels);
  const segmentMode = useCardioStore((s) => s.segmentMode);
  const objects = useCardioStore((s) => s.objects);
  const setPendingObjectPosition = useCardioStore((s) => s.setPendingObjectPosition);
  const previewObject = useCardioStore((s) => s.previewObject);
  const editingObjectId = useCardioStore((s) => s.editingObjectId);
  const setEditingObjectId = useCardioStore((s) => s.setEditingObjectId);
  const updateObject = useCardioStore((s) => s.updateObject);
  const pickingObjectVessel = useCardioStore((s) => s.pickingObjectVessel);
  const setPickingObjectVessel = useCardioStore((s) => s.setPickingObjectVessel);
  const debugShowCenterlines = useCardioStore((s) => s.debugShowCenterlines);
  const [hovered, setHovered] = useState<{ id: string; point: Vector3 } | null>(null);

  const meshesByName = useMemo(() => {
    const map = new Map<string, Mesh>();
    scene.traverse((obj) => {
      if ((obj as Mesh).isMesh) map.set(obj.name, obj as Mesh);
    });
    return map;
  }, [scene]);

  // 心臓メッシュの重心(簡易近似)。石灰化の「向き」パラメータの心筋方向/心外膜方向の
  // 基準に使う(冠動脈は心外膜表面を走行するため、重心方向でも実用上十分な近似になる)。
  // 見つからない場合は原点にフォールバックする。
  const heartCentroid = useMemo(() => {
    const heartMesh = meshesByName.get("HEART");
    if (!heartMesh) return new Vector3(0, 0, 0);
    return new Box3().setFromObject(heartMesh).getCenter(new Vector3());
  }, [meshesByName]);

  // 中心線グラフ(本幹+側枝)は scripts/extract_centerlines.py が事前生成した
  // src/data/centerlines.json をそのまま使う。メッシュには依存しないため useMemo は不要。
  const graphs = useMemo(() => {
    const result = new Map<VesselId, VesselGraph>();
    for (const id of VESSEL_IDS) {
      result.set(id, getVesselGraph(id));
    }
    return result;
  }, []);

  useEffect(() => {
    applyDisplayState(meshesByName.get("HEART"), heart);
  }, [meshesByName, heart]);

  // 主幹メッシュの表示: セグメントモード中は元メッシュを隠し、置き換え用のJSXメッシュ側で
  // 描画する。それ以外は従来通り store の値を反映する(狭窄は血管ジオメトリを一切変形しない
  // ため、ここでの分岐は不要になった)。
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

  // 主幹ジオメトリをセグメント数に分割したもの。
  const segmentGeometries = useMemo(() => {
    const result = new Map<string, BufferGeometry[]>();
    for (const id of VESSEL_IDS) {
      const geometry = meshesByName.get(id)?.geometry;
      if (!geometry) continue;
      result.set(id, splitGeometryByLength(geometry, SEGMENT_DEFS[id].length));
    }
    return result;
  }, [meshesByName]);

  /**
   * ノードマーカーのクリックを、新規追加フォームへの位置事前入力(pendingObjectPosition)、
   * または編集中の既存オブジェクト(editingObjectId)の位置更新のどちらかに振り分ける。
   * 編集モード中は、クリック1回で即座にそのオブジェクトの位置を更新し編集モードを終了する
   * (「クリックし直して位置を変更」という単発操作として設計)。
   */
  function handleNodeSelect(vesselId: VesselId, nodeId: string) {
    const graph = graphs.get(vesselId);
    if (!graph) return;
    const { branchId, position } = resolveNodeSelection(graph, nodeId);
    if (editingObjectId) {
      updateObject(editingObjectId, { vesselId, branchId, position });
      setEditingObjectId(null);
    } else {
      setPendingObjectPosition({ vesselId, branchId, position });
      setPickingObjectVessel(null);
    }
  }

  // ノードマーカーを表示する血管: 新規追加のため明示的に選択開始した血管、または
  // 既存オブジェクトを位置変更中の場合はそのオブジェクトの血管(画面が常時うるさくならないよう、
  // どちらでもない間はマーカーを一切表示しない)。
  const editingObject = editingObjectId ? objects.find((o) => o.id === editingObjectId) : undefined;
  const nodePickerVesselId = pickingObjectVessel ?? editingObject?.vesselId ?? null;

  /**
   * オブジェクト追加フォームで位置・長さを微調整している間の配置プレビュー(簡易円筒)。
   * まだstore.objectsに登録されていない下書き状態を、実際のステント生成ロジック
   * (buildStentGeometry、中心線の中央値半径ベースで一様な円筒になる)を使って
   * その場で組み立てる。オブジェクトの種類によらず同じ簡易円筒で表示する(見た目の作り込みは
   * 「確定」後の本描画に任せる)。
   */
  const previewGeometry = useMemo(() => {
    if (!previewObject) return null;
    const graph = graphs.get(previewObject.vesselId);
    const branch = graph && getBranch(graph, previewObject.branchId);
    if (!branch) return null;
    const fakeStent: StentObject = {
      id: "preview",
      type: "stent",
      vesselId: previewObject.vesselId,
      branchId: previewObject.branchId,
      position: previewObject.position,
      length: previewObject.length,
      diameter: 3.0,
      visible: true,
    };
    return buildStentGeometry(branch.points, fakeStent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphs, previewObject?.vesselId, previewObject?.branchId, previewObject?.position, previewObject?.length]);

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

      {VESSEL_IDS.map((id) => {
        const graph = graphs.get(id);
        if (!graph || !vessels[id]?.visible) return null;
        return (
          <ObjectMeshes key={id} vesselId={id} graph={graph} objects={objects} heartCentroid={heartCentroid} />
        );
      })}

      {debugShowCenterlines &&
        VESSEL_IDS.map((id) => {
          if (!vessels[id]?.visible) return null;
          return <CenterlineDebugOverlay key={`centerline-debug-${id}`} vesselId={id} />;
        })}

      {nodePickerVesselId &&
        vessels[nodePickerVesselId]?.visible &&
        graphs.get(nodePickerVesselId) && (
          <NodeMarkers
            vesselId={nodePickerVesselId}
            graph={graphs.get(nodePickerVesselId)!}
            onSelect={handleNodeSelect}
          />
        )}

      {previewGeometry && previewObject && vessels[previewObject.vesselId]?.visible && (
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
