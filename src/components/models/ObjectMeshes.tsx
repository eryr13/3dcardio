import { useMemo } from "react";
import type { VesselId } from "../../types/anatomy";
import type { CalcificationObject, CardioObject, StenosisObject, StentObject } from "../../types/object";
import { getObjectsForVessel } from "../../types/object";
import { useCardioStore } from "../../store/useCardioStore";
import { buildCalcificationMesh } from "./calcificationMesh";
import { buildStentGeometry, buildStentLatticeGeometry } from "./stentLatticeMesh";
import type { StentLatticeParams } from "./stentLatticeMesh";
import { buildStenosisPlaqueGeometry, STENOSIS_PLAQUE_COLOR } from "./stenosisPlaqueMesh";
import type { CenterlinePoint } from "./vesselCenterline";
import type { VesselGraph } from "./vesselGraph";
import { getBranch } from "./vesselGraph";

/** 種類ごとに固定した表示色。 */
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

/**
 * ステントの土台円筒ジオメトリをメモ化するフック。シネビュー(CineAnatomyModel.tsx)は
 * 現状この土台円筒のままX線風マテリアルで表示し続ける(網目ラティスはメインビューのみ)。
 */
export function useStentGeometry(centerline: CenterlinePoint[], object: StentObject) {
  return useMemo(
    () => buildStentGeometry(centerline, object),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [centerline, object.id, object.position, object.length, object.diameter],
  );
}

/**
 * ステントのダイヤモンドカット状ラティス(網目状ストラット)ジオメトリをメモ化するフック。
 * 網目の密度・太さはデバッグパネルから調整できる `stentLatticeParams` に依存するため、
 * それも依存配列に含める。
 */
export function useStentLatticeGeometry(
  centerline: CenterlinePoint[],
  object: StentObject,
  params: StentLatticeParams,
) {
  return useMemo(
    () => buildStentLatticeGeometry(centerline, object, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      centerline,
      object.id,
      object.position,
      object.length,
      object.diameter,
      params.strutCount,
      params.crossingsPerWire,
      params.strutRadiusRatio,
    ],
  );
}

/**
 * ステントのマテリアル。ジオメトリ生成(useStentLatticeGeometry/buildStentLatticeGeometry)
 * とは意図的に別関数へ分離してある。
 */
function StentMaterial() {
  return <meshStandardMaterial color={STENT_COLOR} metalness={0.75} roughness={0.3} />;
}

/**
 * 狭窄プラークのジオメトリ(外径チューブ+内径チューブを結合したもの)をメモ化するフック。
 * メインビュー・シネビューのどちらも同じ形状データを使う。
 */
export function useStenosisPlaqueGeometry(centerline: CenterlinePoint[], object: StenosisObject) {
  return useMemo(
    () => buildStenosisPlaqueGeometry(centerline, object),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [centerline, object.id, object.position, object.length, object.severity],
  );
}

interface ObjectMeshesProps {
  vesselId: VesselId;
  graph: VesselGraph;
  objects: CardioObject[];
}

/**
 * 血管1本分のオブジェクトメッシュ(狭窄プラーク・石灰化・ステント)を、メインビュー向けの
 * 写実的なマテリアルでまとめて描画する。血管ジオメトリ自体は一切変形しない(狭窄も
 * ステント・石灰化と同じく、undeformedな血管の内側に重ねる別メッシュとして表現する)。
 * シネビュー側は同じ `useStenosisPlaqueGeometry` / `useCalcificationGeometry` /
 * `useStentGeometry` フックを使い、X線風の別マテリアルで独自に描画する
 * (CineAnatomyModel.tsx 参照)。各オブジェクトは branchId で指定された枝の中心線
 * (本幹または側枝)を使って描画するため、存在しない枝を参照するオブジェクトは無視する。
 */
export function ObjectMeshes({ vesselId, graph, objects }: ObjectMeshesProps) {
  const vesselObjects = useMemo(() => getObjectsForVessel(objects, vesselId), [objects, vesselId]);

  return (
    <>
      {vesselObjects
        .filter((o): o is StenosisObject => o.type === "stenosis" && o.visible)
        .map((object) => {
          const branch = getBranch(graph, object.branchId);
          if (!branch) return null;
          return <StenosisPlaque key={object.id} object={object} centerline={branch.points} />;
        })}
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

/**
 * 狭窄プラークの結合ジオメトリ(外径+内径チューブ)に脂質性プラーク色のマテリアルを
 * 乗せて表示する。血管を半透明にすると、この内側に付着したプラークが透けて見える。
 */
function StenosisPlaque({ object, centerline }: { object: StenosisObject; centerline: CenterlinePoint[] }) {
  const { merged } = useStenosisPlaqueGeometry(centerline, object);
  return (
    <mesh geometry={merged}>
      <meshStandardMaterial color={STENOSIS_PLAQUE_COLOR} roughness={0.7} metalness={0.02} />
    </mesh>
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
 * ステントの網目(ストラット)ラティスジオメトリに金属マテリアルを乗せて表示する。
 * 土台円筒(buildStentGeometry)自体はレンダリングせず、位置・向き・半径の計算基準
 * としてのみ buildStentLatticeGeometry の内部で使う。
 */
function StentLattice({ object, centerline }: { object: StentObject; centerline: CenterlinePoint[] }) {
  const stentLatticeParams = useCardioStore((s) => s.stentLatticeParams);
  const geometry = useStentLatticeGeometry(centerline, object, stentLatticeParams);
  return (
    <mesh geometry={geometry}>
      <StentMaterial />
    </mesh>
  );
}
