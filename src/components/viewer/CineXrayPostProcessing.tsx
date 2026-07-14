import { useEffect, useRef } from "react";
import { EffectComposer, Noise, Vignette, BrightnessContrast } from "@react-three/postprocessing";
import { wrapEffect } from "@react-three/postprocessing";
import { BlendFunction, type EffectComposer as EffectComposerImpl } from "postprocessing";
import { useCardioStore } from "../../store/useCardioStore";
import { cineSceneBridge } from "../models/cineSceneBridge";
import { CineVesselThicknessEffect } from "./CineVesselThicknessEffect";

const VesselThickness = wrapEffect(CineVesselThicknessEffect);

/** blurAmount(0〜1のUIパラメータ)を血管厚みテクスチャをサンプリングするUV半径に変換する係数 */
const BLUR_RADIUS_SCALE = 0.012;

/**
 * リアルX線モードのGPUポストプロセスパイプライン。
 * 血管厚み+ブラー(CineVesselThicknessEffect、自作GLSLはこの1つのみ。血管の太さ情報自体を
 * ぼかすことで、画面全体ブラーだと細い血管線が消えてしまう問題を避けている)
 * → ノイズ(量子モトル) → ビネット(周辺減光) → コントラスト の順で
 * @react-three/postprocessing の <EffectComposer> に積む。
 * composer への参照は cineSceneBridge 経由でGIF/PNG書き出し(cineExport.ts)にも渡す。
 */
export function CineXrayPostProcessing() {
  const params = useCardioStore((s) => s.cine.xrayParams);
  // 3Dビューで心臓メッシュを非表示にした場合、シネX線モードの心陰影も連動して
  // 消えるようにする(以前は「冠動脈のみ表示」トグルだけで判定しており、3Dビューの
  // 心臓表示状態と無関係だった)。
  const heartMeshVisible = useCardioStore((s) => s.heart.visible);
  const composerRef = useRef<EffectComposerImpl>(null);

  useEffect(() => {
    if (cineSceneBridge.current) cineSceneBridge.current.composer = composerRef.current;
    return () => {
      if (cineSceneBridge.current) cineSceneBridge.current.composer = null;
    };
  }, []);

  return (
    <EffectComposer ref={composerRef} multisampling={0} autoClear>
      <VesselThickness
        absorption={params.vesselAbsorption}
        blurRadius={params.blurAmount * BLUR_RADIUS_SCALE}
        heartAbsorption={params.heartAbsorption}
        heartEnabled={heartMeshVisible && !params.vesselsOnly}
      />
      <Noise premultiply blendFunction={BlendFunction.OVERLAY} opacity={params.noiseIntensity} />
      <Vignette offset={0.35} darkness={params.vignetteStrength} />
      <BrightnessContrast contrast={params.contrast * 2 - 1} brightness={0.1} />
    </EffectComposer>
  );
}
