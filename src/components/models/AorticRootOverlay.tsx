import { useMemo } from "react";
import { DoubleSide, MeshStandardMaterial } from "three";
import type { Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import { useCardioStore } from "../../store/useCardioStore";
import { buildAorticRootGeometry } from "./aorticRootMesh";
import type { VesselGraph } from "./vesselGraph";

interface AorticRootOverlayProps {
  heartCentroid: Vector3;
  graphs: Map<VesselId, VesselGraph>;
}

/**
 * 大動脈基部(バルサルバ洞)・上行大動脈の補助表示(AnatomyLegendの「心臓」の下にある
 * トグルで表示/非表示を切り替える)。ガイディングカテーテルが冠動脈入口部にどう
 * エンゲージしているかを理解しやすくするための、半透明の補助メッシュ。
 * 位置・向き・サイズは冠動脈入口部の実位置から幾何学的に逆算する(heartScaleのような
 * 心臓全体のスケールには依存しない)。経路の構築自体はaorticRootMesh.ts(純粋関数)に
 * 委ね、ここではstoreの表示設定を読んでマテリアルを付けて描画するだけ
 * (GuideDeviceMeshesと同じ役割分担)。
 */
export function AorticRootOverlay({ heartCentroid, graphs }: AorticRootOverlayProps) {
  const display = useCardioStore((s) => s.aorticRoot);

  const geometry = useMemo(() => buildAorticRootGeometry(heartCentroid, graphs), [heartCentroid, graphs]);

  const material = useMemo(
    () =>
      new MeshStandardMaterial({
        color: display.color,
        transparent: display.opacity < 1,
        opacity: display.opacity,
        depthWrite: display.opacity >= 1,
        roughness: 0.5,
        metalness: 0.05,
        // 洞の三つ葉断面ローフト(aorticRootMesh.ts)は巻き順を厳密に保証していないため、
        // 両面描画にして裏返った面が透けて消えないようにする。
        side: DoubleSide,
      }),
    [display.color, display.opacity],
  );

  if (!display.visible || !geometry) return null;

  return <mesh geometry={geometry} material={material} />;
}
