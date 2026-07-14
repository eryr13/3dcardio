import { Effect, BlendFunction } from "postprocessing";
import {
  AddEquation,
  BackSide,
  Camera,
  CustomBlending,
  FrontSide,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OneFactor,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  Uniform,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { VesselId } from "../../types/anatomy";
import { cineSceneBridge } from "../models/cineSceneBridge";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];
/**
 * 深度ピール用レンダーターゲットの解像度。NDC空間(-1〜1)をそのままサンプリングするため
 * 本編Canvasの実ピクセルサイズとは無関係に固定できる(アスペクト比の不一致は起きない)。
 */
const PEEL_RESOLUTION = 512;

/**
 * このシェーダーが同時にバインドするsampler2Dユニフォームの総数
 * (入力バッファ1 + 血管アキュムレータ1 + 心臓アキュムレータ1 + オブジェクトアキュムレータ1)。
 * WebGL2はフラグメントシェーダーにつき最低16テクスチャイメージユニットを保証するのみで、
 * これを超えるとGPU/ドライバによってはシェーダープログラムのリンクに失敗し、画面が
 * 真っ黒になる(=何もレンダーされない)可能性がある。
 *
 * 以前は血管3本・心臓・オブジェクト6スロットそれぞれに専用のfront/backテクスチャを
 * 個別に持たせており(計21ユニット)、実機で「MAX_TEXTURE_IMAGE_UNITS(16)を超過して
 * シェーダーのリンクに失敗し画面が真っ黒になる」不具合が実際に発生することを確認した。
 * このため、同じグループ(血管・心臓・オブジェクト)内の全オブジェクトを「1枚の共有
 * レンダーターゲットに加算合成(additive blending)で描き込む」アキュムレータ方式に
 * 変更し、グループ内のオブジェクト数に関係なくテクスチャ数を固定(グループ数と同じ3枚)に
 * した。将来オブジェクトスロットを増やしてもこの数は変わらないため、同種の不具合が
 * 再発することは構造的に無い。
 */
const REQUIRED_TEXTURE_UNITS = 1 + 3;

/**
 * アキュムレータへの加算/減算を担う頂点/フラグメントシェーダー。血管・心臓・
 * オブジェクトのいずれも同じこのシェーダーを共有する。
 *
 * 以前は血管だけ、頂点属性aProximity(ローカルY座標から求めた「近位度」)による
 * テーパー(末梢ほど薄くする)を掛けていたが、これが実機検証で重大な不具合の原因と
 * 判明したため廃止した: 視線方向に沿って走る(=画面上で大きく短縮して見える)血管
 * では、深度ピールの前面ヒットと背面ヒットが血管の大きく離れた位置(=近位度が
 * 大きく異なる頂点)から来ることがあり、前面用と背面用で異なるテーパー値を
 * 掛けてから差分を取ると「back*taper_back - front*taper_front」が実際の厚みより
 * 大幅に過小評価される(酷い場合はほぼ消える)ことを確認した。実際のX線透視では
 * 視線方向に長く続く血管ほど造影剤の厚みが増して濃く写るべきであり、この
 * テーパーは物理的にも正しくなかった。
 */
const GENERIC_ACCUM_VERTEX_SHADER = /* glsl */ `
varying float vViewZ;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewZ = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * uWeightは通常1.0(心臓用、常に単一の定数吸収係数を後段で掛けるため)だが、
 * オブジェクト用にはそのオブジェクト自身の吸収係数を都度設定する。石灰化・ステントなど
 * 吸収係数が異なるオブジェクトが同じ共有アキュムレータに混在しても、加算する前に
 * 各オブジェクト自身の吸収係数を掛けておくことで、最終的な合計値がそのまま
 * Beer-Lambert則の吸光度(optical depth)の合計になる。
 */
const GENERIC_ACCUM_FRAGMENT_SHADER = /* glsl */ `
uniform float uSign;
uniform float uWeight;
varying float vViewZ;
void main() {
  gl_FragColor = vec4(uSign * vViewZ * uWeight, 0.0, 0.0, 0.0);
}
`;

const THICKNESS_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uVesselAccum;
uniform float uAbsorption;
uniform float uBlurRadius;

uniform sampler2D uHeartAccum;
uniform float uHeartAbsorption;

uniform sampler2D uObjectAccum;

// 血管の輪郭をわずかに「にじませる」ための軽量なぼかし(周囲8方向+中心の加重平均)。
// TiltShift2等の画面全体のブラー効果ではなく、血管の太さ情報そのものに対して
// 掛けることで、細い線が全体ブラーで消えてしまう問題を避けている。
float blurredThickness(vec2 uv) {
  if (uBlurRadius < 0.0001) return max(0.0, texture2D(uVesselAccum, uv).r);
  float sum = max(0.0, texture2D(uVesselAccum, uv).r) * 3.0;
  float weight = 3.0;
  const int SAMPLES = 8;
  for (int i = 0; i < SAMPLES; i++) {
    float angle = 6.28318530718 * (float(i) / float(SAMPLES));
    vec2 offset = vec2(cos(angle), sin(angle)) * uBlurRadius;
    sum += max(0.0, texture2D(uVesselAccum, uv + offset).r);
    weight += 1.0;
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

// 心臓・血管・オブジェクト(石灰化/ステント)のいずれも「同じ物理量(X線減弱係数)」として
// 扱い、それぞれの光学的厚み(厚み×吸収係数)を単純加算してから最後に1回だけ
// exp(-合計)を掛けるBeer-Lambert則そのものの合成にする。心臓の厚みは実際の心臓
// メッシュを血管と全く同じ深度ピールで積算した生の値をそのまま使う(疑似的な
// ぼかし・位置ずらしの後処理は行わない。以前あった「広がり」「中心位置」パラメータは
// 心臓メッシュとは無関係な後処理で、これがぼかし半径次第で心臓の光学的厚みを
// 際限なく増大させ、血管ごと埋もれさせてしまう不具合の原因だったため廃止した)。
// 心臓の陰影を血管の上に重なる不透明な層として別合成すると、心臓が厚い角度
// (例: 頭側から見下ろす角度)で血管のコントラストごと薄れてしまう(実際のX線透視では
// そのようなことは起こらない、造影剤は心筋よりX線吸収が桁違いに高いため、心臓が
// 厚くてもその上に血管が常にはっきり描出される)。加算合成なら、心臓の光学的厚みが
// どれだけ大きくなっても血管自身の光学的厚み(vesselThickness×uAbsorption)は独立に
// 上乗せされ続けるため、血管吸収係数を心筋吸収係数より十分大きく設定しておけば、
// 血管のコントラストがカメラ角度によって埋もれることは構造的に起こらない。
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 toned = inputColor.rgb * lungBrighten(uv);

  float vesselOpticalDepth = blurredThickness(uv) * uAbsorption;
  float heartOpticalDepth = max(0.0, texture2D(uHeartAccum, uv).r) * uHeartAbsorption;
  // オブジェクトアキュムレータは各オブジェクト自身の吸収係数を既に加算前に掛けてあるため、
  // ここではそのまま光学的厚みとして合計に加える(ブラーは掛けない=石灰化のくっきりした
  // 高吸収感、ステントの細線らしさを保つ)。
  float objectOpticalDepth = max(0.0, texture2D(uObjectAccum, uv).r);

  float totalOpticalDepth = vesselOpticalDepth + heartOpticalDepth + objectOpticalDepth;
  vec3 color = toned * exp(-totalOpticalDepth);
  outputColor = vec4(color, inputColor.a);
}
`;

/**
 * 加算ブレンド専用マテリアル。THREE.AdditiveBlendingは(dst.rgb*1 + src.rgb*1)の
 * プリセットしか無く符号付きの値(前面パスで-viewZを書きたい)を素直に扱えないため、
 * CustomBlending + AddEquation + src/dst共にOneFactorで「dst = dst + src」を明示的に
 * 組み立てる(srcが負の値ならそのまま減算になる)。
 *
 * sideは元の実装通りFrontSide/BackSideを渡し、前面・背面それぞれの深度だけを
 * 個別に書き込む(カリングで分離する)。depthTest/depthWriteは明示的にオフにする
 * ——同じ共有ターゲットに複数のオブジェクト(血管なら3本、オブジェクトなら任意件数)を
 * クリアせずに重ねて加算していく設計のため、深度バッファをONにすると後から描く
 * オブジェクトが先に描いたオブジェクトの深度に負けて描かれなくなってしまう
 * (異なるオブジェクト同士は深度で比較すべきではなく、単純に厚みを合算したい)。
 */
function createAccumMaterial(
  vertexShader: string,
  fragmentShader: string,
  side: typeof FrontSide | typeof BackSide,
  uniforms: Record<string, Uniform>,
): ShaderMaterial {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    side,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneFactor,
  });
}

/**
 * FloatType(32bit浮動小数点)ではなくHalfFloatType(16bit)を使う。フル32bit
 * float は「レンダーターゲットとして描画できる」ことと「LinearFilterで
 * サンプリングできる」ことの両方に別々の拡張(EXT_color_buffer_float /
 * OES_texture_float_linear)を要求し、特にWindows/ANGLE環境ではこの組み合わせを
 * ドライバが完全にはサポートしないことがあり、対応していないと深度ピールの
 * レンダーターゲットが正しく描画されず画面に何も映らなくなる。HalfFloatは
 * より広く安定してサポートされており、ここで扱う値(視点からの距離の差分)の
 * 精度としても十分。
 */
function createPeelTarget(): WebGLRenderTarget {
  const target = new WebGLRenderTarget(PEEL_RESOLUTION, PEEL_RESOLUTION, {
    type: HalfFloatType,
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
  heartAbsorption?: number;
  heartEnabled?: boolean;
}

/**
 * 血管3幹(RCA/LAD/LCX)・心臓本体・石灰化/ステントオブジェクトそれぞれについて、閉じた
 * メッシュの前面深度と背面深度の差分(=視線が通過する厚み)を、グループ単位で共有する
 * 1枚のレンダーターゲットに加算ブレンドで積算していくポストプロセスエフェクト。
 *
 * 本来のボリュームレイマーチングではなく、閉じたメッシュの前後面深度差から厚みを
 * 近似する軽量な depth peeling 手法(1オブジェクトにつき前後1層のみ)。
 *
 * 各オブジェクトを「専用の非表示シーンに置いたプロキシメッシュ」として個別にレンダーし、
 * 背面パスは+viewZ、前面パスは-viewZを同じグループ共有ターゲットに加算ブレンドで
 * 書き込む。これにより、オブジェクト同士が深度的に隠し合う(=厚みを過小評価する)ことを
 * 防ぎつつ、グループごとに必要なテクスチャはオブジェクト数によらず1枚で済む
 * (以前はオブジェクトごとに専用のfront/backテクスチャを持たせており、GPU/ドライバの
 * MAX_TEXTURE_IMAGE_UNITSを超過してシェーダーのリンクに失敗する不具合があった)。
 * プロキシは元メッシュのgeometryを共有しつつmatrixWorldだけ毎フレームコピーするため、
 * メインの描画シーン階層(拍動アニメーション等)には一切手を加えない。
 *
 * 心臓は血管と全く同じ厚み積算の仕組み(実在の心臓メッシュを深度ピール)をそのまま
 * 再利用しており、疑似的なぼかし・位置ずらしの後処理は行わない。心臓・血管・
 * オブジェクトの吸収係数はいずれも同じBeer-Lambert則の物理量として扱い、最終的な濃淡は
 * 全ての光学的厚みを加算してから1回だけexp(-合計)を掛けて求める(mainImage参照)。
 * これにより、心臓の陰影がどれだけ濃くなっても血管自身のコントラストが埋もれることはなく、
 * カメラ角度を変えれば心臓の実際の形状・向き・厚みに応じて陰影の形も正しく変化する。
 */
export class CineVesselThicknessEffect extends Effect {
  private readonly vesselAccumBackMaterial: ShaderMaterial;
  private readonly vesselAccumFrontMaterial: ShaderMaterial;
  private readonly heartAccumBackMaterial: ShaderMaterial;
  private readonly heartAccumFrontMaterial: ShaderMaterial;
  private readonly objectAccumBackMaterial: ShaderMaterial;
  private readonly objectAccumFrontMaterial: ShaderMaterial;
  private readonly peelScene: Scene;
  private readonly proxies: Partial<Record<VesselId, Mesh>> = {};
  private readonly proxySourceGeometry: Partial<Record<VesselId, unknown>> = {};
  private readonly vesselAccumTarget: WebGLRenderTarget;
  private heartProxy: Mesh | null = null;
  private heartProxySourceGeometry: unknown = null;
  private readonly heartAccumTarget: WebGLRenderTarget;
  private readonly objectProxies: (Mesh | null)[] = [];
  private readonly objectProxySourceGeometry: (unknown | null)[] = [];
  private readonly objectAccumTarget: WebGLRenderTarget;
  /**
   * 狭窄プラーク(外径/内径チューブ)のプロキシ。血管本体と全く同じ
   * vesselAccumBackMaterial/vesselAccumFrontMaterialを共有するが、uSignを
   * エントリごとに(通常の血管は+1固定、外径チューブは-1、内径チューブは+1に)
   * 都度設定してから描画することで、専用のテクスチャチャンネルを増やさずに
   * 「血管の生厚み - プラーク厚み」を同じ共有アキュムレータ内で計算する。
   */
  private readonly plaqueProxies: (Mesh | null)[] = [];
  private readonly plaqueProxySourceGeometry: (unknown | null)[] = [];
  private viewCamera: Camera | null = null;
  /**
   * false の間は心臓の陰影を深度ピールごと丸ごとスキップし、冠動脈のみを表示する
   * (「冠動脈のみ表示」オプション用。オフの間はレンダーコストも節約できる)。
   */
  public heartEnabled: boolean;
  /** GPU側のテクスチャユニット数診断を初回updateで1回だけ行うためのフラグ */
  private diagnosticsLogged = false;

  constructor({
    absorption = 10,
    blurRadius = 0.004,
    heartAbsorption = 1.0,
    heartEnabled = true,
  }: CineVesselThicknessEffectOptions = {}) {
    const uniforms = new Map<string, Uniform>([
      ["uVesselAccum", new Uniform(null)],
      ["uAbsorption", new Uniform(absorption)],
      ["uBlurRadius", new Uniform(blurRadius)],
      ["uHeartAccum", new Uniform(null)],
      ["uHeartAbsorption", new Uniform(heartAbsorption)],
      ["uObjectAccum", new Uniform(null)],
    ]);
    super("CineVesselThicknessEffect", THICKNESS_FRAGMENT_SHADER, {
      blendFunction: BlendFunction.SET,
      uniforms,
    });

    this.vesselAccumBackMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, BackSide, {
      uSign: new Uniform(1),
      uWeight: new Uniform(1),
    });
    this.vesselAccumFrontMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, FrontSide, {
      uSign: new Uniform(-1),
      uWeight: new Uniform(1),
    });
    this.heartAccumBackMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, BackSide, {
      uSign: new Uniform(1),
      uWeight: new Uniform(1),
    });
    this.heartAccumFrontMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, FrontSide, {
      uSign: new Uniform(-1),
      uWeight: new Uniform(1),
    });
    this.objectAccumBackMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, BackSide, {
      uSign: new Uniform(1),
      uWeight: new Uniform(1),
    });
    this.objectAccumFrontMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, FrontSide, {
      uSign: new Uniform(-1),
      uWeight: new Uniform(1),
    });
    this.peelScene = new Scene();
    this.vesselAccumTarget = createPeelTarget();
    this.heartAccumTarget = createPeelTarget();
    this.objectAccumTarget = createPeelTarget();
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

  get heartAbsorption(): number {
    return this.uniforms.get("uHeartAbsorption")!.value as number;
  }

  set heartAbsorption(value: number) {
    this.uniforms.get("uHeartAbsorption")!.value = value;
  }

  private ensureProxy(id: VesselId, sourceMesh: Mesh): Mesh {
    const existing = this.proxies[id];
    if (existing && this.proxySourceGeometry[id] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.vesselAccumBackMaterial);
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
    const proxy = new Mesh(sourceMesh.geometry, this.heartAccumBackMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.heartProxy = proxy;
    this.heartProxySourceGeometry = sourceMesh.geometry;
    return proxy;
  }

  /**
   * 石灰化・ステントオブジェクトのプロキシ。血管・心臓と同じ「元メッシュのgeometryを
   * 共有しつつmatrixWorldだけ毎フレームコピーする」パターン。表示トグル・追加/削除に
   * 応じて毎フレーム件数が変わり得るため、必要な数だけ動的に生成・破棄する
   * (固定スロット数を持たない=物体数が増えてもテクスチャ数は増えない設計)。
   */
  private ensureObjectProxy(index: number, sourceMesh: Mesh): Mesh {
    const existing = this.objectProxies[index];
    if (existing && this.objectProxySourceGeometry[index] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.objectAccumBackMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.objectProxies[index] = proxy;
    this.objectProxySourceGeometry[index] = sourceMesh.geometry;
    return proxy;
  }

  /**
   * 狭窄プラーク(外径/内径チューブ)のプロキシ。material は vesselAccumBackMaterial を
   * 仮に割り当てておくが、実際の描画直前に update() 側で back/front それぞれの
   * material に差し替え、uSign もエントリごとに設定し直す。
   */
  private ensurePlaqueProxy(index: number, sourceMesh: Mesh): Mesh {
    const existing = this.plaqueProxies[index];
    if (existing && this.plaqueProxySourceGeometry[index] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.vesselAccumBackMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.plaqueProxies[index] = proxy;
    this.plaqueProxySourceGeometry[index] = sourceMesh.geometry;
    return proxy;
  }

  /**
   * peelSceneには血管3本+心臓+オブジェクトのプロキシが常駐しているため、1回のレンダーパスで
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
    for (const proxy of this.objectProxies) {
      if (proxy) proxy.visible = proxy === active;
    }
    for (const proxy of this.plaqueProxies) {
      if (proxy) proxy.visible = proxy === active;
    }
  }

  override update(renderer: WebGLRenderer): void {
    if (!this.diagnosticsLogged) {
      this.diagnosticsLogged = true;
      const gl = renderer.getContext();
      const maxTextureImageUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
      if (maxTextureImageUnits < REQUIRED_TEXTURE_UNITS) {
        // eslint-disable-next-line no-console
        console.error(
          `CineVesselThicknessEffect: このGPU/ドライバのMAX_TEXTURE_IMAGE_UNITS(${maxTextureImageUnits})が` +
            `シェーダーが要求するテクスチャユニット数(${REQUIRED_TEXTURE_UNITS})に対して不足しています。` +
            "リアルX線モードのシェーダーがリンクできず、画面に何も描画されない可能性があります。",
        );
      }
    }

    const handle = cineSceneBridge.current;
    const camera = this.viewCamera;
    if (!handle || !camera) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    // renderer.autoClear=true だと render() を呼ぶたびに現在のレンダーターゲットが
    // 自動的にクリアされてしまい、複数のオブジェクトを同じ共有ターゲットに加算合成
    // していく今回の方式と根本的に相容れない(2回目以降のrender()呼び出しで
    // 前のオブジェクトの積算結果が毎回消えてしまう)。ここでは明示的にfalseにし、
    // 各共有ターゲットの先頭で行う手動clear()だけでクリアを制御する。
    renderer.autoClear = false;

    // 血管: 3本まとめて1枚の共有ターゲットに加算合成する。ターゲットは血管ループの
    // 最初に1回だけクリアし、各血管の背面(+viewZ)・前面(-viewZ)パスをその上に
    // 加算ブレンドで重ね書きする(クリアを毎回行うと前の血管の積算結果が消えてしまう)。
    renderer.setRenderTarget(this.vesselAccumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);

    let anyVesselVisible = false;
    for (const id of VESSEL_IDS) {
      const sourceMesh = handle.vesselMeshes[id];
      const visible = handle.vesselVisible[id] !== false && !!sourceMesh;
      if (!visible || !sourceMesh) continue;
      anyVesselVisible = true;

      const proxy = this.ensureProxy(id, sourceMesh);
      proxy.matrixWorld.copy(sourceMesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.vesselAccumTarget);
      // uSignは狭窄プラークのループ(下)で一時的に反転させることがあるため、
      // 通常の血管では常に明示的に既定値(+1/-1)へ戻してから描画する。
      (this.vesselAccumBackMaterial.uniforms.uSign as Uniform).value = 1;
      (this.vesselAccumFrontMaterial.uniforms.uSign as Uniform).value = -1;
      proxy.material = this.vesselAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.vesselAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    }

    // 狭窄プラーク: 専用のテクスチャチャンネルを増やさず、血管と同じ共有ターゲットに
    // 「外径チューブは符号反転(-1/+1)・内径チューブは通常符号(+1/-1)」で追加描画する。
    // 加算合成の結果、この2枚の差(外径厚み-内径厚み=プラーク自身の厚み)がちょうど
    // 血管の生厚みから差し引かれる形になり、プラークは造影剤の吸収に一切寄与しない
    // (プラーク自体の吸収係数を別途持たない=非石灰化プラークがX線的にほぼ見えない
    // という実際の臨床所見と一致する)。
    handle.stenosisPlaqueProxies.forEach((entry, index) => {
      anyVesselVisible = true;

      const proxy = this.ensurePlaqueProxy(index, entry.mesh);
      proxy.matrixWorld.copy(entry.mesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.vesselAccumTarget);
      (this.vesselAccumBackMaterial.uniforms.uSign as Uniform).value = entry.sign;
      (this.vesselAccumFrontMaterial.uniforms.uSign as Uniform).value = -entry.sign;
      proxy.material = this.vesselAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.vesselAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    });
    for (let i = handle.stenosisPlaqueProxies.length; i < this.plaqueProxies.length; i++) {
      const stale = this.plaqueProxies[i];
      if (stale) {
        this.peelScene.remove(stale);
        this.plaqueProxies[i] = null;
        this.plaqueProxySourceGeometry[i] = null;
      }
    }

    this.uniforms.get("uVesselAccum")!.value = anyVesselVisible ? this.vesselAccumTarget.texture : null;

    const heartMesh = handle.heartMesh;
    if (heartMesh && this.heartEnabled) {
      const heartProxy = this.ensureHeartProxy(heartMesh);
      heartProxy.matrixWorld.copy(heartMesh.matrixWorld);
      this.activateOnlyProxy(heartProxy);

      renderer.setRenderTarget(this.heartAccumTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, true, true);
      heartProxy.material = this.heartAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      heartProxy.material = this.heartAccumFrontMaterial;
      renderer.render(this.peelScene, camera);

      this.uniforms.get("uHeartAccum")!.value = this.heartAccumTarget.texture;
    } else {
      this.uniforms.get("uHeartAccum")!.value = null;
    }

    // 石灰化・ステントオブジェクト: 件数に関わらず1枚の共有ターゲットに加算合成する。
    // オブジェクトごとに吸収係数が異なるため、加算する前に自身の吸収係数を掛けてから
    // 加算する(uWeight)ことで、合計値がそのままBeer-Lambert則の吸光度になる。
    renderer.setRenderTarget(this.objectAccumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);

    let anyObjectVisible = false;
    handle.objectProxies.forEach((entry, index) => {
      if (!entry) return;
      anyObjectVisible = true;

      const proxy = this.ensureObjectProxy(index, entry.mesh);
      proxy.matrixWorld.copy(entry.mesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.objectAccumTarget);
      (this.objectAccumBackMaterial.uniforms.uWeight as Uniform).value = entry.absorption;
      (this.objectAccumFrontMaterial.uniforms.uWeight as Uniform).value = entry.absorption;
      proxy.material = this.objectAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.objectAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    });
    // 今回のフレームで使われなかった過去のプロキシは残しておくとpeelSceneに古い
    // ジオメトリが居座り続けてしまうため、件数が減った分は破棄する。
    for (let i = handle.objectProxies.length; i < this.objectProxies.length; i++) {
      const stale = this.objectProxies[i];
      if (stale) {
        this.peelScene.remove(stale);
        this.objectProxies[i] = null;
        this.objectProxySourceGeometry[i] = null;
      }
    }
    this.uniforms.get("uObjectAccum")!.value = anyObjectVisible ? this.objectAccumTarget.texture : null;

    // 全パス終了後は全プロキシを再びvisible=trueに戻しておく(次フレームの
    // activateOnlyProxy呼び出し前に他コードが誤って全滅表示のpeelSceneを参照しても
    // 影響が出ないようにするための後始末。実際の描画はupdate()内で完結するため必須ではないが、
    // 念のため一貫した状態に保つ)。
    for (const id of VESSEL_IDS) {
      const proxy = this.proxies[id];
      if (proxy) proxy.visible = true;
    }
    if (this.heartProxy) this.heartProxy.visible = true;
    for (const proxy of this.objectProxies) {
      if (proxy) proxy.visible = true;
    }
    for (const proxy of this.plaqueProxies) {
      if (proxy) proxy.visible = true;
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  override dispose(): void {
    this.vesselAccumTarget.dispose();
    this.heartAccumTarget.dispose();
    this.objectAccumTarget.dispose();
    this.vesselAccumBackMaterial.dispose();
    this.vesselAccumFrontMaterial.dispose();
    this.heartAccumBackMaterial.dispose();
    this.heartAccumFrontMaterial.dispose();
    this.objectAccumBackMaterial.dispose();
    this.objectAccumFrontMaterial.dispose();
    super.dispose();
  }
}
