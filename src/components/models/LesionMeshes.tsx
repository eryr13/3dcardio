import { useMemo } from "react";
import type { VesselId } from "../../types/anatomy";
import type { CalcificationLesion, Lesion, StentLesion } from "../../types/lesion";
import { getLesionsForVessel } from "../../types/lesion";
import { buildCalcificationMesh } from "./calcificationMesh";
import { buildStentGeometry } from "./stentLatticeMesh";
import type { CenterlinePoint } from "./vesselCenterline";

/**
 * 石灰化プラークのジオメトリをメモ化するフック。メインビュー・シネビューの
 * どちらも同じ形状データを使い、マテリアルだけ描画側で変えられるようにするため
 * ジオメトリ生成をコンポーネントから切り離してある。
 */
export function useCalcificationGeometry(centerline: CenterlinePoint[], lesion: CalcificationLesion) {
  return useMemo(
    () => buildCalcificationMesh(centerline, lesion),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [centerline, lesion.id, lesion.position, lesion.length, lesion.severity],
  );
}

/** ステントの土台円筒ジオメトリをメモ化するフック(用途は useCalcificationGeometry と同じ)。 */
export function useStentGeometry(centerline: CenterlinePoint[], lesion: StentLesion) {
  return useMemo(
    () => buildStentGeometry(centerline, lesion),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [centerline, lesion.id, lesion.position, lesion.length, lesion.diameter],
  );
}

interface LesionMeshesProps {
  vesselId: VesselId;
  centerline: CenterlinePoint[];
  lesions: Lesion[];
}

/**
 * 血管1本分の病変メッシュ(石灰化・ステント)を、メインビュー向けの写実的な
 * マテリアルでまとめて描画する。狭窄(stenosis)は血管ジオメトリ自体の変形
 * (vesselCenterline.applyStenosisDeformation)で表現するため、ここでは追加
 * メッシュを生成しない。シネビュー側は同じ `useCalcificationGeometry` /
 * `useStentGeometry` フックを使い、X線風の別マテリアルで独自に描画する
 * (CineAnatomyModel.tsx 参照)。
 */
export function LesionMeshes({ vesselId, centerline, lesions }: LesionMeshesProps) {
  const vesselLesions = useMemo(() => getLesionsForVessel(lesions, vesselId), [lesions, vesselId]);

  if (centerline.length === 0) return null;

  return (
    <>
      {vesselLesions
        .filter((l): l is CalcificationLesion => l.type === "calcification" && l.visible)
        .map((lesion) => (
          <CalcificationBump key={lesion.id} lesion={lesion} centerline={centerline} />
        ))}
      {vesselLesions
        .filter((l): l is StentLesion => l.type === "stent" && l.visible)
        .map((lesion) => (
          <StentLattice key={lesion.id} lesion={lesion} centerline={centerline} />
        ))}
    </>
  );
}

function CalcificationBump({ lesion, centerline }: { lesion: CalcificationLesion; centerline: CenterlinePoint[] }) {
  const geometry = useCalcificationGeometry(centerline, lesion);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#f2e9c9" roughness={0.6} metalness={0.05} />
    </mesh>
  );
}

/**
 * ステップ2診断用: 修正済み中心線データ(連続性フィルタ後)からbuildStentGeometryで
 * 生成した土台円筒を、目立つ単色(赤の半透明)で表示する。向き・サイズ・血管との
 * 重なりを目視確認するための暫定マテリアルで、ダイヤモンドパターンはまだ適用しない。
 */
function StentLattice({ lesion, centerline }: { lesion: StentLesion; centerline: CenterlinePoint[] }) {
  const geometry = useStentGeometry(centerline, lesion);
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#ff3b30" transparent opacity={0.55} metalness={0} roughness={0.8} />
    </mesh>
  );
}
