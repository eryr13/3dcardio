import { Effect, BlendFunction } from "postprocessing";
import {
  BackSide,
  Camera,
  FloatType,
  FrontSide,
  LinearFilter,
  Mesh,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Uniform,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { VesselId } from "../../types/anatomy";
import { cineSceneBridge } from "../models/cineSceneBridge";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];
/**
 * 深度ピール用レンダーターゲットの解像度。NDC空間(-1〜1)をそのままサンプリングするため
 * 本編Canvasの実ピクセルサイズとは無関係に固定できる(アスペクト比の不一致は起きない)。
 * 3本 x 前面/背面 = 6回/フレームのレンダーなので、低めの固定解像度で十分軽量にできる。
 */
const PEEL_RESOLUTION = 512;

/** 心臓の陰影のBeer-Lambert吸収係数。血管と違いスライダー化はせず、代わりに
 * uHeartIntensity(頭打ちキャップ)で見た目の濃さを調整する(血管との視覚的分離のため)。 */
const HEART_ABSORPTION = 6.0;

/**
 * Phase 6: 石灰化・ステント病変のリアルX線密度表現に使う固定スロット数。
 * WebGL1/GLSL ES 1.00 のuniform配列は動的インデックスアクセスに制約があるため、
 * 血管(uFront0..2)・心臓と同じ「番号付きuniformを明示的に並べる」方式を踏襲し、
 * 配列ではなく固定本数のuniformセットにしている。7個目以降の病変は密度表現の対象外
 * (狭窄によるジオメトリ変形自体はスロット数と無関係に常に反映される)。
 */
const LESION_SLOT_COUNT = 6;

const DEPTH_VERTEX_SHADER = /* glsl */ `
attribute float aProximity;
varying float vViewZ;
varying float vProximity;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mvPosition.z;
  vProximity = aProximity;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const DEPTH_FRAGMENT_SHADER = /* glsl */ `
varying float vViewZ;
varying float vProximity;
void main() {
  gl_FragColor = vec4(vViewZ, vProximity, 0.0, 1.0);
}
`;

// 心臓用は近位度(aProximity)を持たないシンプルな深度書き込みシェーダー
// (血管シェーダーと共有すると不要な頂点属性をジオメトリに要求してしまうため分けている)。
const HEART_DEPTH_VERTEX_SHADER = /* glsl */ `
varying float vViewZ;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const HEART_DEPTH_FRAGMENT_SHADER = /* glsl */ `
varying float vViewZ;
void main() {
  gl_FragColor = vec4(vViewZ, 0.0, 0.0, 1.0);
}
`;

const THICKNESS_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uFront0;
uniform sampler2D uBack0;
uniform sampler2D uFront1;
uniform sampler2D uBack1;
uniform sampler2D uFront2;
uniform sampler2D uBack2;
uniform float uAbsorption;
uniform float uBlurRadius;

uniform sampler2D uHeartFront;
uniform sampler2D uHeartBack;
uniform float uHeartIntensity;
uniform float uHeartBlurRadius;
uniform vec2 uHeartOffset;

uniform sampler2D uLesion0Front; uniform sampler2D uLesion0Back; uniform float uLesion0Absorption;
uniform sampler2D uLesion1Front; uniform sampler2D uLesion1Back; uniform float uLesion1Absorption;
uniform sampler2D uLesion2Front; uniform sampler2D uLesion2Back; uniform float uLesion2Absorption;
uniform sampler2D uLesion3Front; uniform sampler2D uLesion3Back; uniform float uLesion3Absorption;
uniform sampler2D uLesion4Front; uniform sampler2D uLesion4Back; uniform float uLesion4Absorption;
uniform sampler2D uLesion5Front; uniform sampler2D uLesion5Back; uniform float uLesion5Absorption;

float trunkThickness(sampler2D frontTex, sampler2D backTex, vec2 uv) {
  vec4 f = texture2D(frontTex, uv);
  vec4 b = texture2D(backTex, uv);
  float hit = min(f.a, b.a);
  float thickness = max(0.0, b.r - f.r) * hit;
  // 近位(aProximity=1)ほど太く濃く、遠位(=0)でも完全には消えないよう下限を設ける
  // (実際の造影剤希釈による先細りの近似)。
  float taper = mix(0.35, 1.0, f.g);
  return thickness * taper;
}

float totalThickness(vec2 uv) {
  return trunkThickness(uFront0, uBack0, uv)
    + trunkThickness(uFront1, uBack1, uv)
    + trunkThickness(uFront2, uBack2, uv);
}

// 血管の輪郭をわずかに「にじませる」ための軽量なぼかし(周囲8方向+中心の加重平均)。
// TiltShift2等の画面全体のブラー効果ではなく、血管の太さ情報そのものに対して
// 掛けることで、細い線が全体ブラーで消えてしまう問題を避けている。
float blurredThickness(vec2 uv) {
  if (uBlurRadius < 0.0001) return totalThickness(uv);
  float sum = totalThickness(uv) * 3.0;
  float weight = 3.0;
  const int SAMPLES = 8;
  for (int i = 0; i < SAMPLES; i++) {
    float angle = 6.28318530718 * (float(i) / float(SAMPLES));
    vec2 offset = vec2(cos(angle), sin(angle)) * uBlurRadius;
    sum += totalThickness(uv + offset);
    weight += 1.0;
  }
  return sum / weight;
}

float heartThickness(vec2 uv) {
  vec4 f = texture2D(uHeartFront, uv);
  vec4 b = texture2D(uHeartBack, uv);
  float hit = min(f.a, b.a);
  return max(0.0, b.r - f.r) * hit;
}

// 心臓は「輪郭ではなく滲んだ塊」に見えるよう、血管より広い半径・多いサンプル数
// (半径r・2rの2重リング、それぞれ8方向)でぼかす。3D形状そのものが中心ほど厚いため、
// 追加のグラデーション生成ロジックなしで「中心が濃く外周が薄い」見た目が自然に出る。
float blurredHeartThickness(vec2 uv) {
  if (uHeartBlurRadius < 0.0001) return heartThickness(uv);
  float sum = heartThickness(uv) * 3.0;
  float weight = 3.0;
  const int SAMPLES = 8;
  for (int ring = 1; ring <= 2; ring++) {
    float radius = uHeartBlurRadius * float(ring);
    for (int i = 0; i < SAMPLES; i++) {
      float angle = 6.28318530718 * (float(i) / float(SAMPLES));
      vec2 offset = vec2(cos(angle), sin(angle)) * radius;
      sum += heartThickness(uv + offset);
      weight += 1.0;
    }
  }
  return sum / weight;
}

// カメラが常に心臓中心を注視するため、心臓はほぼ常に画面中央に投影される。これを利用し、
// 3D位置計算をせず画面UV空間の中心からの距離だけで肺野(明)/縦隔(暗)の帯を近似する。
float lungBrighten(vec2 uv) {
  float dist = distance(uv, vec2(0.5));
  float t = smoothstep(0.12, 0.42, dist);
  return mix(1.0, 1.35, t);
}

// 石灰化・ステント病変(スロット単位)の厚み→濃淡。血管・心臓と同じBeer-Lambert式だが、
// にじみ(ブラー)は掛けない(石灰化のくっきりした高吸収感、ステントの細線らしさを保つため)。
float lesionDarkness(sampler2D frontTex, sampler2D backTex, float absorption, vec2 uv) {
  vec4 f = texture2D(frontTex, uv);
  vec4 b = texture2D(backTex, uv);
  float hit = min(f.a, b.a);
  float thickness = max(0.0, b.r - f.r) * hit;
  return 1.0 - exp(-thickness * absorption);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 toned = inputColor.rgb * lungBrighten(uv);

  float vesselThicknessTotal = blurredThickness(uv);
  float vesselDarkness = 1.0 - exp(-vesselThicknessTotal * uAbsorption);

  float heartThicknessTotal = blurredHeartThickness(uv + uHeartOffset);
  float heartDarkness = (1.0 - exp(-heartThicknessTotal * ${HEART_ABSORPTION.toFixed(1)})) * uHeartIntensity;

  vec3 color = toned * (1.0 - heartDarkness) * (1.0 - vesselDarkness);
  color *= (1.0 - lesionDarkness(uLesion0Front, uLesion0Back, uLesion0Absorption, uv));
  color *= (1.0 - lesionDarkness(uLesion1Front, uLesion1Back, uLesion1Absorption, uv));
  color *= (1.0 - lesionDarkness(uLesion2Front, uLesion2Back, uLesion2Absorption, uv));
  color *= (1.0 - lesionDarkness(uLesion3Front, uLesion3Back, uLesion3Absorption, uv));
  color *= (1.0 - lesionDarkness(uLesion4Front, uLesion4Back, uLesion4Absorption, uv));
  color *= (1.0 - lesionDarkness(uLesion5Front, uLesion5Back, uLesion5Absorption, uv));
  outputColor = vec4(color, inputColor.a);
}
`;

function createDepthMaterial(
  vertexShader: string,
  fragmentShader: string,
  side: typeof FrontSide | typeof BackSide,
): ShaderMaterial {
  return new ShaderMaterial({ vertexShader, fragmentShader, side });
}

function createPeelTarget(): WebGLRenderTarget {
  const target = new WebGLRenderTarget(PEEL_RESOLUTION, PEEL_RESOLUTION, {
    type: FloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
  });
  return target;
}

interface CineVesselThicknessEffectOptions {
  absorption?: number;
  blurRadius?: number;
  heartIntensity?: number;
  heartBlurRadius?: number;
  heartOffsetX?: number;
  heartOffsetY?: number;
  heartEnabled?: boolean;
}

/**
 * 血管3幹(RCA/LAD/LCX)と心臓本体それぞれについて、閉じたメッシュの前面深度と背面深度を
 * 別々のレンダーターゲットに描き、その差分(=視線が通過する厚み)をBeer-Lambert則風に
 * 濃淡へ変換するポストプロセスエフェクト。
 *
 * 本来のボリュームレイマーチングではなく、閉じたメッシュの前後面深度差から厚みを
 * 近似する軽量な depth peeling 手法(1オブジェクトにつき前後1層のみ)。
 *
 * 各オブジェクトを「専用の非表示シーンに置いたプロキシメッシュ」として個別にレンダーする
 * ことで、オブジェクト同士がお互いを深度的に隠してしまう(=厚みを過小評価する)のを防ぐ。
 * プロキシは元メッシュのgeometryを共有しつつmatrixWorldだけ毎フレームコピーするため、
 * メインの描画シーン階層(拍動アニメーション等)には一切手を加えない。
 *
 * 心臓は血管と同じ厚み積算の仕組みを再利用しつつ、(1) 血管より広いぼかし半径、
 * (2) uHeartIntensityによる濃さの頭打ちキャップ、の2点で「境界の曖昧な陰影」として
 * 血管とは視覚的に区別できるように調整している。
 */
export class CineVesselThicknessEffect extends Effect {
  private readonly frontMaterial: ShaderMaterial;
  private readonly backMaterial: ShaderMaterial;
  private readonly heartFrontMaterial: ShaderMaterial;
  private readonly heartBackMaterial: ShaderMaterial;
  private readonly peelScene: Scene;
  private readonly proxies: Partial<Record<VesselId, Mesh>> = {};
  private readonly proxySourceGeometry: Partial<Record<VesselId, unknown>> = {};
  private readonly frontTargets: Record<VesselId, WebGLRenderTarget>;
  private readonly backTargets: Record<VesselId, WebGLRenderTarget>;
  private heartProxy: Mesh | null = null;
  private heartProxySourceGeometry: unknown = null;
  private readonly heartFrontTarget: WebGLRenderTarget;
  private readonly heartBackTarget: WebGLRenderTarget;
  /** 石灰化・ステント病変用の汎用深度書き込みマテリアル(心臓用シェーダーを共有、aProximity不要のため) */
  private readonly lesionFrontMaterial: ShaderMaterial;
  private readonly lesionBackMaterial: ShaderMaterial;
  private readonly lesionProxies: (Mesh | null)[] = new Array(LESION_SLOT_COUNT).fill(null);
  private readonly lesionProxySourceGeometry: (unknown | null)[] = new Array(LESION_SLOT_COUNT).fill(null);
  private readonly lesionFrontTargets: WebGLRenderTarget[];
  private readonly lesionBackTargets: WebGLRenderTarget[];
  private viewCamera: Camera | null = null;
  /**
   * false の間は心臓の陰影を深度ピールごと丸ごとスキップし、冠動脈のみを表示する
   * (「冠動脈のみ表示」オプション用。オフの間はレンダーコストも節約できる)。
   */
  public heartEnabled: boolean;

  constructor({
    absorption = 10,
    blurRadius = 0.004,
    heartIntensity = 0.4,
    heartBlurRadius = 0.02,
    heartOffsetX = 0,
    heartOffsetY = 0,
    heartEnabled = true,
  }: CineVesselThicknessEffectOptions = {}) {
    const uniforms = new Map<string, Uniform>([
      ["uFront0", new Uniform(null)],
      ["uBack0", new Uniform(null)],
      ["uFront1", new Uniform(null)],
      ["uBack1", new Uniform(null)],
      ["uFront2", new Uniform(null)],
      ["uBack2", new Uniform(null)],
      ["uAbsorption", new Uniform(absorption)],
      ["uBlurRadius", new Uniform(blurRadius)],
      ["uHeartFront", new Uniform(null)],
      ["uHeartBack", new Uniform(null)],
      ["uHeartIntensity", new Uniform(heartIntensity)],
      ["uHeartBlurRadius", new Uniform(heartBlurRadius)],
      ["uHeartOffset", new Uniform(new Vector2(heartOffsetX, heartOffsetY))],
    ]);
    for (let slot = 0; slot < LESION_SLOT_COUNT; slot++) {
      uniforms.set(`uLesion${slot}Front`, new Uniform(null));
      uniforms.set(`uLesion${slot}Back`, new Uniform(null));
      uniforms.set(`uLesion${slot}Absorption`, new Uniform(0));
    }
    super("CineVesselThicknessEffect", THICKNESS_FRAGMENT_SHADER, {
      blendFunction: BlendFunction.SET,
      uniforms,
    });

    this.frontMaterial = createDepthMaterial(DEPTH_VERTEX_SHADER, DEPTH_FRAGMENT_SHADER, FrontSide);
    this.backMaterial = createDepthMaterial(DEPTH_VERTEX_SHADER, DEPTH_FRAGMENT_SHADER, BackSide);
    this.heartFrontMaterial = createDepthMaterial(HEART_DEPTH_VERTEX_SHADER, HEART_DEPTH_FRAGMENT_SHADER, FrontSide);
    this.heartBackMaterial = createDepthMaterial(HEART_DEPTH_VERTEX_SHADER, HEART_DEPTH_FRAGMENT_SHADER, BackSide);
    this.lesionFrontMaterial = createDepthMaterial(HEART_DEPTH_VERTEX_SHADER, HEART_DEPTH_FRAGMENT_SHADER, FrontSide);
    this.lesionBackMaterial = createDepthMaterial(HEART_DEPTH_VERTEX_SHADER, HEART_DEPTH_FRAGMENT_SHADER, BackSide);
    this.peelScene = new Scene();
    this.frontTargets = { RCA: createPeelTarget(), LAD: createPeelTarget(), LCX: createPeelTarget() };
    this.backTargets = { RCA: createPeelTarget(), LAD: createPeelTarget(), LCX: createPeelTarget() };
    this.heartFrontTarget = createPeelTarget();
    this.heartBackTarget = createPeelTarget();
    this.lesionFrontTargets = Array.from({ length: LESION_SLOT_COUNT }, () => createPeelTarget());
    this.lesionBackTargets = Array.from({ length: LESION_SLOT_COUNT }, () => createPeelTarget());
    this.heartEnabled = heartEnabled;
  }

  /**
   * @react-three/postprocessing の wrapEffect() が現在のR3Fデフォルトカメラを自動的に
   * `camera` propとしてこのインスタンスへ渡してくる(BrightnessContrastEffect.brightness
   * 等と同じ、ライブラリ側の慣習)。深度ピールをメインビューと同じ視点から行うために使う。
   */
  set camera(value: Camera) {
    this.viewCamera = value;
  }

  get absorption(): number {
    return this.uniforms.get("uAbsorption")!.value as number;
  }

  set absorption(value: number) {
    this.uniforms.get("uAbsorption")!.value = value;
  }

  get blurRadius(): number {
    return this.uniforms.get("uBlurRadius")!.value as number;
  }

  set blurRadius(value: number) {
    this.uniforms.get("uBlurRadius")!.value = value;
  }

  get heartIntensity(): number {
    return this.uniforms.get("uHeartIntensity")!.value as number;
  }

  set heartIntensity(value: number) {
    this.uniforms.get("uHeartIntensity")!.value = value;
  }

  get heartBlurRadius(): number {
    return this.uniforms.get("uHeartBlurRadius")!.value as number;
  }

  set heartBlurRadius(value: number) {
    this.uniforms.get("uHeartBlurRadius")!.value = value;
  }

  get heartOffsetX(): number {
    return (this.uniforms.get("uHeartOffset")!.value as Vector2).x;
  }

  set heartOffsetX(value: number) {
    (this.uniforms.get("uHeartOffset")!.value as Vector2).x = value;
  }

  get heartOffsetY(): number {
    return (this.uniforms.get("uHeartOffset")!.value as Vector2).y;
  }

  set heartOffsetY(value: number) {
    (this.uniforms.get("uHeartOffset")!.value as Vector2).y = value;
  }

  private ensureProxy(id: VesselId, sourceMesh: Mesh): Mesh {
    const existing = this.proxies[id];
    if (existing && this.proxySourceGeometry[id] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.frontMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.proxies[id] = proxy;
    this.proxySourceGeometry[id] = sourceMesh.geometry;
    return proxy;
  }

  private ensureHeartProxy(sourceMesh: Mesh): Mesh {
    if (this.heartProxy && this.heartProxySourceGeometry === sourceMesh.geometry) {
      return this.heartProxy;
    }
    if (this.heartProxy) this.peelScene.remove(this.heartProxy);
    const proxy = new Mesh(sourceMesh.geometry, this.heartFrontMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.heartProxy = proxy;
    this.heartProxySourceGeometry = sourceMesh.geometry;
    return proxy;
  }

  /**
   * Phase 6: 石灰化・ステント病変(スロット単位)のプロキシ。血管・心臓と同じ
   * 「元メッシュのgeometryを共有しつつmatrixWorldだけ毎フレームコピーする」パターン。
   * スロットに入る病変は表示トグル・追加/削除に応じて毎フレーム入れ替わり得るため、
   * geometry参照が変わったときだけ再生成する。
   */
  private ensureLesionSlotProxy(slot: number, sourceMesh: Mesh): Mesh {
    const existing = this.lesionProxies[slot];
    if (existing && this.lesionProxySourceGeometry[slot] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.lesionFrontMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.lesionProxies[slot] = proxy;
    this.lesionProxySourceGeometry[slot] = sourceMesh.geometry;
    return proxy;
  }

  /**
   * peelSceneには血管3本+心臓+病変プールのプロキシが常駐しているため、1回のレンダーパスで
   * 「今measureしたい1つ」以外が写り込むと深度が汚染される(特に心臓は他の全プロキシより
   * 大きく、混入すると血管の厚みが大きく狂う)。パスの直前に対象以外を全てvisible=falseに
   * することで、常に1オブジェクトだけがpeelSceneに実質存在する状態を保証する。
   */
  private activateOnlyProxy(active: Mesh): void {
    for (const id of VESSEL_IDS) {
      const proxy = this.proxies[id];
      if (proxy) proxy.visible = proxy === active;
    }
    if (this.heartProxy) this.heartProxy.visible = this.heartProxy === active;
    for (const proxy of this.lesionProxies) {
      if (proxy) proxy.visible = proxy === active;
    }
  }

  override update(renderer: WebGLRenderer): void {
    const handle = cineSceneBridge.current;
    const camera = this.viewCamera;
    if (!handle || !camera) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    const uniformIndexById: Record<VesselId, number> = { RCA: 0, LAD: 1, LCX: 2 };

    for (const id of VESSEL_IDS) {
      const sourceMesh = handle.vesselMeshes[id];
      const visible = handle.vesselVisible[id] !== false && !!sourceMesh;
      const index = uniformIndexById[id];
      const frontUniform = this.uniforms.get(`uFront${index}`)!;
      const backUniform = this.uniforms.get(`uBack${index}`)!;

      if (!visible || !sourceMesh) {
        frontUniform.value = null;
        backUniform.value = null;
        continue;
      }

      const proxy = this.ensureProxy(id, sourceMesh);
      proxy.matrixWorld.copy(sourceMesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      proxy.material = this.frontMaterial;
      renderer.setRenderTarget(this.frontTargets[id]);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(this.peelScene, camera);

      proxy.material = this.backMaterial;
      renderer.setRenderTarget(this.backTargets[id]);
      renderer.clear(true, true, true);
      renderer.render(this.peelScene, camera);

      frontUniform.value = this.frontTargets[id].texture;
      backUniform.value = this.backTargets[id].texture;
    }

    const heartUniformFront = this.uniforms.get("uHeartFront")!;
    const heartUniformBack = this.uniforms.get("uHeartBack")!;
    const heartMesh = handle.heartMesh;
    if (heartMesh && this.heartEnabled) {
      const heartProxy = this.ensureHeartProxy(heartMesh);
      heartProxy.matrixWorld.copy(heartMesh.matrixWorld);
      this.activateOnlyProxy(heartProxy);

      heartProxy.material = this.heartFrontMaterial;
      renderer.setRenderTarget(this.heartFrontTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(this.peelScene, camera);

      heartProxy.material = this.heartBackMaterial;
      renderer.setRenderTarget(this.heartBackTarget);
      renderer.clear(true, true, true);
      renderer.render(this.peelScene, camera);

      heartUniformFront.value = this.heartFrontTarget.texture;
      heartUniformBack.value = this.heartBackTarget.texture;
    } else {
      heartUniformFront.value = null;
      heartUniformBack.value = null;
    }

    // Phase 6: 石灰化・ステント病変プール(固定6スロット)。handle.lesionProxiesは
    // CineAnatomyModel側で表示トグルOFFの病変を除外・6件までに切り詰め済み。
    for (let slot = 0; slot < LESION_SLOT_COUNT; slot++) {
      const entry = handle.lesionProxies[slot];
      const frontUniform = this.uniforms.get(`uLesion${slot}Front`)!;
      const backUniform = this.uniforms.get(`uLesion${slot}Back`)!;
      const absorptionUniform = this.uniforms.get(`uLesion${slot}Absorption`)!;

      if (!entry) {
        frontUniform.value = null;
        backUniform.value = null;
        continue;
      }

      const proxy = this.ensureLesionSlotProxy(slot, entry.mesh);
      proxy.matrixWorld.copy(entry.mesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      proxy.material = this.lesionFrontMaterial;
      renderer.setRenderTarget(this.lesionFrontTargets[slot]);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      renderer.render(this.peelScene, camera);

      proxy.material = this.lesionBackMaterial;
      renderer.setRenderTarget(this.lesionBackTargets[slot]);
      renderer.clear(true, true, true);
      renderer.render(this.peelScene, camera);

      frontUniform.value = this.lesionFrontTargets[slot].texture;
      backUniform.value = this.lesionBackTargets[slot].texture;
      absorptionUniform.value = entry.absorption;
    }

    // 全パス終了後は全プロキシを再びvisible=trueに戻しておく(次フレームの
    // activateOnlyProxy呼び出し前に他コードが誤って全滅表示のpeelSceneを参照しても
    // 影響が出ないようにするための後始末。実際の描画はupdate()内で完結するため必須ではないが、
    // 念のため一貫した状態に保つ)。
    for (const id of VESSEL_IDS) {
      const proxy = this.proxies[id];
      if (proxy) proxy.visible = true;
    }
    if (this.heartProxy) this.heartProxy.visible = true;
    for (const proxy of this.lesionProxies) {
      if (proxy) proxy.visible = true;
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  override dispose(): void {
    for (const id of VESSEL_IDS) {
      this.frontTargets[id].dispose();
      this.backTargets[id].dispose();
    }
    this.heartFrontTarget.dispose();
    this.heartBackTarget.dispose();
    for (let slot = 0; slot < LESION_SLOT_COUNT; slot++) {
      this.lesionFrontTargets[slot].dispose();
      this.lesionBackTargets[slot].dispose();
    }
    this.frontMaterial.dispose();
    this.backMaterial.dispose();
    this.heartFrontMaterial.dispose();
    this.heartBackMaterial.dispose();
    this.lesionFrontMaterial.dispose();
    this.lesionBackMaterial.dispose();
    super.dispose();
  }
}
