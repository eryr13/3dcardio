import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { BufferGeometry, Color } from "three";
import type { Material, Mesh } from "three";
import type { VesselId } from "../../types/anatomy";
import type { CardioObject } from "../../types/object";
import { useCardioStore } from "../../store/useCardioStore";
import { computeArrivalTables, getElapsedContrastSeconds } from "../../utils/contrastFlow";
import type { ArrivalTables, ContrastFlowParams } from "../../utils/contrastFlow";
import { buildContrastFillGeometry, buildContrastMaskGeometry } from "./contrastFillMesh";
import type { VesselGraph } from "./vesselGraph";

/** 空ジオメトリの共有センチネル。「造影剤なし」の間、meshに割り当てて表示コストをゼロにする。 */
const EMPTY_GEOMETRY = new BufferGeometry();

type GeometryBuilder = (
  graph: VesselGraph,
  objects: CardioObject[],
  vesselId: VesselId,
  arrivalTables: ArrivalTables,
  elapsedSeconds: number,
  flowParams: ContrastFlowParams,
  baseColor?: Color,
) => BufferGeometry | null;

interface ContrastTubeProps {
  vesselId: VesselId;
  graph: VesselGraph;
  objects: CardioObject[];
  material: Material;
  /** 呼び出し側の表示条件(血管自体の表示トグル、シネのxrayMode等)。造影剤が無い区間は
   *  このtrueの間もmesh.visibleは自動的にfalseになる。 */
  visible: boolean;
  /** シネのリアルX線モードで深度ピール用プロキシとして登録するためのコールバック(省略可)。 */
  onRef?: (mesh: Mesh | null) => void;
  /**
   * メインビュー用: 血管本体の色をベースに濃度で明度・彩度を変えた頂点カラーを焼き込む
   * (contrastFillMesh.tsのcontrastFillColor参照)。省略時(シネスキーマ/X線マスク用途、
   * どちらも血管の識別色とは無関係にグレースケールで表現する)は頂点カラーを付与しない。
   */
  baseColor?: string;
}

/**
 * 造影剤フロー(Phase 7)関連のチューブメッシュ共通ロジック。中心線グラフの到達時刻
 * テーブル(utils/contrastFlow.ts)はobjects/paramsが変わらない限り再計算せずuseMemoで
 * 保持し、ジオメトリ本体だけをcine.fpsで間引いた頻度で再構築する(HeartbeatGroup.tsxと
 * 同じuseFrame+fps間引きのパターン)。meshインスタンス自体は再生成せず、geometry
 * プロパティだけを差し替える。buildGeometryを差し替えるだけで、見た目用の
 * ContrastFillTube(半径=血管半径×内腔比率×濃度)と、シネX線用の濃度マスクの
 * ContrastMaskTube(半径=血管半径×内腔比率のみ、濃度は頂点属性)の両方に使い回せる。
 */
function useContrastTube(
  { vesselId, graph, objects, visible, onRef, baseColor }: Omit<ContrastTubeProps, "material">,
  buildGeometry: GeometryBuilder,
) {
  const meshRef = useRef<Mesh>(null);
  const lastAppliedAtRef = useRef(-Infinity);
  const hasContentRef = useRef(false);
  const contrastParams = useCardioStore((s) => s.contrast.params);

  const arrivalTables = useMemo(
    () => computeArrivalTables(graph, objects, vesselId, contrastParams),
    [graph, objects, vesselId, contrastParams],
  );

  const baseColorObj = useMemo(() => (baseColor ? new Color(baseColor) : undefined), [baseColor]);

  useEffect(() => {
    const mesh = meshRef.current;
    onRef?.(mesh);
    return () => {
      onRef?.(null);
      if (mesh && mesh.geometry !== EMPTY_GEOMETRY) mesh.geometry.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const { contrast, cine } = useCardioStore.getState();
    const elapsed = getElapsedContrastSeconds(contrast);
    const minInterval = 1 / cine.fps;

    if (Math.abs(elapsed - lastAppliedAtRef.current) >= minInterval) {
      lastAppliedAtRef.current = elapsed;
      const nextGeometry = buildGeometry(graph, objects, vesselId, arrivalTables, elapsed, contrastParams, baseColorObj);
      const oldGeometry = mesh.geometry;
      mesh.geometry = nextGeometry ?? EMPTY_GEOMETRY;
      hasContentRef.current = nextGeometry !== null;
      if (oldGeometry !== EMPTY_GEOMETRY) oldGeometry.dispose();
    }

    mesh.visible = visible && hasContentRef.current;
  });

  return meshRef;
}

/**
 * 見た目用の造影剤充填チューブ(3Dビュー・シネスキーマ表示のオーバーレイ)。半径に
 * 血管半径×内腔比率×濃度を直接反映するため、濃度が上がるにつれて視覚的に「太く
 * くっきり」なる。シネのリアルX線モードの光学的厚み計算にはこちらを使わない
 * (ContrastMaskTune参照——濃度をマスクとしてではなく厚みとして扱うと、血管本体
 * より濃く見えてしまう不具合の原因だったため、xray用は分離した)。
 */
export function ContrastFillTube(props: ContrastTubeProps) {
  const meshRef = useContrastTube(props, buildContrastFillGeometry);
  return <mesh ref={meshRef} geometry={EMPTY_GEOMETRY} material={props.material} visible={false} frustumCulled={false} />;
}

/**
 * シネのリアルX線モード専用: 血管本体の光学的厚み(常に生の血管メッシュから計算する、
 * 造影剤フローモードOFF時と全く同じもの)に掛け合わせる濃度マスク用チューブ。
 * 半径は内腔比率(狭窄・石灰化)までしか縮めず、濃度は頂点属性(aScalar)として
 * 埋め込む。CineVesselThicknessEffect側でMAXブレンドの単一パスとして描画し、
 * 「その画素を覆うどれかのチューブ表面が持つ最大濃度」を取り出す。
 */
export function ContrastMaskTube(props: ContrastTubeProps) {
  const meshRef = useContrastTube(props, buildContrastMaskGeometry);
  return <mesh ref={meshRef} geometry={EMPTY_GEOMETRY} material={props.material} visible={false} frustumCulled={false} />;
}
