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
        heartIntensity={params.heartShadowIntensity}
        heartBlurRadius={params.heartShadowSpread}
        heartOffsetX={params.heartShadowOffsetX}
        heartOffsetY={params.heartShadowOffsetY}
        heartEnabled={!params.vesselsOnly}
      />
      <Noise premultiply blendFunction={BlendFunction.OVERLAY} opacity={params.noiseIntensity} />
      <Vignette offset={0.35} darkness={params.vignetteStrength} />
      <BrightnessContrast contrast={params.contrast * 2 - 1} brightness={0.1} />
    </EffectComposer>
  );
}
