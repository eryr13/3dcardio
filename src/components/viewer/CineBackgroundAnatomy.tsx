import { useMemo } from "react";
import { CanvasTexture, DoubleSide } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import { useModelBoundingSphereRadius } from "./cineCameraUtils";

/** 中心が白、外周に向かって透明になる柔らかい放射グラデーション。輪郭の無いダミー影に使う */
function buildSoftGradientTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.6, "rgba(255,255,255,0.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

/**
 * 横隔膜・脊椎のごく低コントラストなダミーシルエット(低優先度オプション)。
 * 解剖学的に正確な形状ではなく、実際のアンギオ画像にうっすら写り込む背景構造の
 * 「らしさ」を出すための静的なグラデーション形状。心臓と同じワールド座標系に
 * 配置しているため、カメラ(=C-arm角度)が回っても患者と一緒に自然に回転する。
 */
export function CineBackgroundAnatomy() {
  const show = useCardioStore((s) => s.cine.xrayParams.showBackgroundAnatomy);
  const radius = useModelBoundingSphereRadius();
  const texture = useMemo(() => buildSoftGradientTexture(), []);

  if (!show) return null;

  return (
    <group renderOrder={-10}>
      {/* 脊椎: 心臓の後方にうっすら見える縦長の帯 */}
      <mesh position={[0, 0, -radius * 1.3]} scale={[radius * 0.8, radius * 3.5, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={texture}
          color="#888888"
          transparent
          opacity={0.1}
          depthWrite={false}
          depthTest={false}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>
      {/* 横隔膜: 心臓の下方にうっすら見える横長のドーム状シルエット */}
      <mesh position={[0, -radius * 1.2, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[radius * 3.2, radius * 2.2, 1]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial
          map={texture}
          color="#888888"
          transparent
          opacity={0.08}
          depthWrite={false}
          depthTest={false}
          side={DoubleSide}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
