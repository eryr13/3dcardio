import { useMemo } from "react";
import type { VesselId } from "../../types/anatomy";
import type { CalcificationObject, CardioObject, StentObject } from "../../types/object";
import { getObjectsForVessel } from "../../types/object";
import { buildCalcificationMesh } from "./calcificationMesh";
import { buildStentGeometry } from "./stentLatticeMesh";
import type { CenterlinePoint } from "./vesselCenterline";
import type { VesselGraph } from "./vesselGraph";
import { getBranch } from "./vesselGraph";

/** 種類ごとに固定した表示色。狭窄(stenosis)は血管ジオメトリ自体の変形で表現するため色を持たない。 */
export const CALCIFICATION_COLOR = "#e8c400";
export const STENT_COLOR = "#9098a0";

/**
 * 石灰化プラークのジオメトリをメモ化するフック。メインビュー・シネビューの
 * どちらも同じ形状データを使い、マテリアルだけ描画側で変えられるようにするため
 * ジオメトリ生成をコンポーネントから切り離してある。
 */
export function useCalcificationGeometry(centerline: CenterlinePoint[], object: CalcificationObject) {
  return useMemo(
    () => buildCalcificationMesh(centerline, object),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [centerline, object.id, object.position, object.length, object.severity],
  );
}

/** ステントの土台円筒ジオメトリをメモ化するフック(用途は useCalcificationGeometry と同じ)。 */
export function useStentGeometry(centerline: CenterlinePoint[], object: StentObject) {
  return useMemo(
    () => buildStentGeometry(centerline, object),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [centerline, object.id, object.position, object.length, object.diameter],
  );
}

/**
 * ステントのマテリアル。ジオメトリ生成(useStentGeometry/buildStentGeometry、土台円筒)
 * とは意図的に別関数へ分離してある。今後ダイヤモンドカット状のストラット(網目構造)
 * メッシュに差し替える際は、この2つをそれぞれ独立に置き換えられる。
 */
function StentMaterial() {
  return <meshStandardMaterial color={STENT_COLOR} metalness={0.75} roughness={0.3} />;
}

interface ObjectMeshesProps {
  vesselId: VesselId;
  graph: VesselGraph;
  objects: CardioObject[];
}

/**
 * 血管1本分のオブジェクトメッシュ(石灰化・ステント)を、メインビュー向けの写実的な
 * マテリアルでまとめて描画する。狭窄(stenosis)は血管ジオメトリ自体の変形
 * (vesselCenterline.applyStenosisDeformation)で表現するため、ここでは追加
 * メッシュを生成しない。シネビュー側は同じ `useCalcificationGeometry` /
 * `useStentGeometry` フックを使い、X線風の別マテリアルで独自に描画する
 * (CineAnatomyModel.tsx 参照)。各オブジェクトは branchId で指定された枝の中心線
 * (本幹または側枝)を使って描画するため、存在しない枝を参照するオブジェクトは無視する。
 */
export function ObjectMeshes({ vesselId, graph, objects }: ObjectMeshesProps) {
  const vesselObjects = useMemo(() => getObjectsForVessel(objects, vesselId), [objects, vesselId]);

  return (
    <>
      {vesselObjects
        .filter((o): o is CalcificationObject => o.type === "calcification" && o.visible)
        .map((object) => {
          const branch = getBranch(graph, object.branchId);
          if (!branch) return null;
          return <CalcificationBump key={object.id} object={object} centerline={branch.points} />;
        })}
      {vesselObjects
        .filter((o): o is StentObject => o.type === "stent" && o.visible)
        .map((object) => {
          const branch = getBranch(graph, object.branchId);
          if (!branch) return null;
          return <StentLattice key={object.id} object={object} centerline={branch.points} />;
        })}
    </>
  );
}

function CalcificationBump({ object, centerline }: { object: CalcificationObject; centerline: CenterlinePoint[] }) {
  const geometry = useCalcificationGeometry(centerline, object);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color={CALCIFICATION_COLOR} roughness={0.6} metalness={0.05} />
    </mesh>
  );
}

/**
 * 土台円筒(buildStentGeometry)にステント正式色のマテリアルを乗せて表示する。
 * ダイヤモンドカットのストラット(網目構造)メッシュはまだ未実装(土台円筒のみ)。
 */
function StentLattice({ object, centerline }: { object: StentObject; centerline: CenterlinePoint[] }) {
  const geometry = useStentGeometry(centerline, object);
  return (
    <mesh geometry={geometry}>
      <StentMaterial />
    </mesh>
  );
}
