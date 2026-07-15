import { Effect, BlendFunction } from "postprocessing";
import {
  AddEquation,
  BackSide,
  Camera,
  CustomBlending,
  DoubleSide,
  FrontSide,
  HalfFloatType,
  LinearFilter,
  MaxEquation,
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
 * ステントのストラットは血管半径に対して非常に細いため、512では(特にシネビューを
 * ズームした際に)バイリニアフィルタで信号が薄まり、鋭い線ではなく淡くぼやけた
 * 網目に見えてしまっていた(実機検証で確認)。1024に上げて細い構造の再現性を上げる。
 */
const PEEL_RESOLUTION = 1024;

/**
 * このシェーダーが同時にバインドするsampler2Dユニフォームの総数
 * (入力バッファ1 + 血管アキュムレータ1 + 心臓アキュムレータ1 + ステントアキュムレータ1 +
 * 石灰化アキュムレータ1)。造影剤濃度マスクは最終合成シェーダー(このシェーダー)では
 * 使わず、血管ごとの厚み加算パス(GENERIC_ACCUM_FRAGMENT_SHADER、別のシェーダー
 * プログラム)側でサンプリングするため、ここには数えない(下のupdate()内コメント参照)。
 * WebGL2はフラグメントシェーダーにつき最低16テクスチャイメージユニットを保証するのみで、
 * これを超えるとGPU/ドライバによってはシェーダープログラムのリンクに失敗し、画面が
 * 真っ黒になる(=何もレンダーされない)可能性がある。
 *
 * 以前は血管3本・心臓・オブジェクト6スロットそれぞれに専用のfront/backテクスチャを
 * 個別に持たせており(計21ユニット)、実機で「MAX_TEXTURE_IMAGE_UNITS(16)を超過して
 * シェーダーのリンクに失敗し画面が真っ黒になる」不具合が実際に発生することを確認した。
 * このため、同じグループ(血管・心臓・ステント・石灰化)内の全オブジェクトを「1枚の共有
 * レンダーターゲットに加算合成(additive blending)で描き込む」アキュムレータ方式に
 * 変更し、グループ内のオブジェクト数に関係なくテクスチャ数を固定(グループ数と同じ4枚)に
 * した。将来オブジェクトスロットを増やしてもこの数は変わらないため、同種の不具合が
 * 再発することは構造的に無い。
 */
const REQUIRED_TEXTURE_UNITS = 1 + 4;

/**
 * 造影剤フローモード専用の濃度マスク描画シェーダー。深度ピールの前後面差分(厚み)は
 * 一切扱わず、頂点属性aScalar(0〜1の濃度)をそのままフラグメント出力に流すだけの
 * 単純な1パス描画。MaxEquationブレンド(下のensureContrastMaskProxy参照)と組み合わせる
 * ことで、同じ血管の複数の枝のチューブが重なる画素でも「そこを覆うどれかの枝が持つ
 * 最大濃度」が素直に得られる(加算だと重なった分だけ値が積み上がってしまい、血管本体
 * より濃く見えすぎる不具合の原因になるため、意図的に加算ではなくMaxを使う)。
 * 血管ごとに専用ターゲットへ都度クリア→単独描画するため(update()参照)、このMaxは
 * あくまで「同じ血管の枝同士」の重なりを解決するものであり、別の血管の濃度と混ざる
 * ことはない。
 */
const CONTRAST_MASK_VERTEX_SHADER = /* glsl */ `
attribute float aScalar;
varying float vScalar;
void main() {
  vScalar = aScalar;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CONTRAST_MASK_FRAGMENT_SHADER = /* glsl */ `
varying float vScalar;
void main() {
  gl_FragColor = vec4(clamp(vScalar, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

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
 *
 * ステントのように吸収係数を非常に大きくすると、viewZ×uWeightがHalfFloat
 * レンダーターゲット(有効範囲は概ね±65504)の表現範囲を超え、加算ブレンドの
 * 蓄積次第で±Infinityになりうる(実機検証で確認: 吸収係数を上げるとシネビュー
 * 全体が真っ黒になる不具合があった)。exp(-30)は既に無視できるほど0に近いため、
 * 書き込み時点でこの範囲に収めても見た目には一切影響しない。
 *
 * uUseConcentrationMask/uConcentrationMaskは造影剤フローモード専用: trueの間、
 * このピクセルを描画している「今accumulate中の1血管」自身の濃度マスク
 * (update()が血管ごとに専用ターゲットへ描き直したもの)をgl_FragCoord経由で
 * 画面空間サンプリングし、書き込む値に掛け合わせる。以前はこれを「3血管分を
 * 1枚に合成したマスクを、3血管合計後の厚みに一括で掛ける」形にしていたが、
 * それだと視線方向に濃度の異なる血管同士が重なった際、造影ありの血管の高い濃度に
 * 造影なしの血管が便乗して写ってしまう不具合があった(mainImage側の合成後ではなく、
 * ここで血管ごとに個別にマスクすることで、重なりが起きても各血管は自分自身の
 * 濃度でしか寄与しないことを保証する)。心臓・ステント・石灰化・内腔減算シェルの
 * 描画では常にfalseのまま(それぞれ専用の理由でマスク対象外、update()参照)。
 */
const GENERIC_ACCUM_FRAGMENT_SHADER = /* glsl */ `
uniform float uSign;
uniform float uWeight;
uniform sampler2D uConcentrationMask;
uniform bool uUseConcentrationMask;
varying float vViewZ;
void main() {
  float concentration = 1.0;
  if (uUseConcentrationMask) {
    vec2 maskUv = gl_FragCoord.xy / ${PEEL_RESOLUTION.toFixed(1)};
    concentration = clamp(texture2D(uConcentrationMask, maskUv).r, 0.0, 1.0);
  }
  float value = clamp(uSign * vViewZ * uWeight * concentration, -5000.0, 5000.0);
  gl_FragColor = vec4(value, 0.0, 0.0, 0.0);
}
`;

const THICKNESS_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uVesselAccum;
uniform float uAbsorption;
uniform float uBlurRadius;

uniform sampler2D uHeartAccum;
uniform float uHeartAbsorption;

uniform sampler2D uStentAccum;

uniform sampler2D uCalcificationAccum;

// 軽量なぼかし(周囲8方向+中心の加重平均)。TiltShift2等の画面全体のブラー効果では
// なく、特定のアキュムレータの厚み情報そのものに対して掛けることで、細い構造が
// 全体ブラーで消えてしまう問題を避けている。血管の輪郭のにじみと、石灰化の
// 不整形な塊の縁を滑らかにする(ジオメトリの分割数由来のポリゴンエッジを目立たなく
// する)のに使う。ステントの網目(ストラット)は金属特有の鋭さを保つため、この関数を
// 一切通さず生の値を使う(mainImage参照)。
float blurredSample(sampler2D tex, vec2 uv, float blurRadius) {
  if (blurRadius < 0.0001) return max(0.0, texture2D(tex, uv).r);
  float sum = max(0.0, texture2D(tex, uv).r) * 3.0;
  float weight = 3.0;
  const int SAMPLES = 8;
  for (int i = 0; i < SAMPLES; i++) {
    float angle = 6.28318530718 * (float(i) / float(SAMPLES));
    vec2 offset = vec2(cos(angle), sin(angle)) * blurRadius;
    sum += max(0.0, texture2D(tex, uv + offset).r);
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

// 心臓・血管・石灰化・ステントのいずれも「同じ物理量(X線減弱係数)」として扱い、
// それぞれの光学的厚み(厚み×吸収係数)を単純加算してから最後に1回だけ
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

  // 造影剤フローモード中の濃度マスクは、ここではなく血管ごとの厚み加算パス
  // (GENERIC_ACCUM_FRAGMENT_SHADER、update()参照)で既に血管ごとに個別へ掛け込み
  // 済みなので、uVesselAccum自体が「各血管が自分自身の濃度で重み付けされた後の
  // 合計」になっている。濃度1.0の区間はそのままモードOFF時と全く同じ光学的厚みになる。
  float vesselOpticalDepth = blurredSample(uVesselAccum, uv, uBlurRadius) * uAbsorption;
  float heartOpticalDepth = max(0.0, texture2D(uHeartAccum, uv).r) * uHeartAbsorption;
  // ステントは吸収係数を既に加算前に掛けてあるため、そのまま光学的厚みとして扱う。
  // ブラーは一切掛けない(=金属の網目らしい、細く鋭いストラットの線を保つ)。
  float stentOpticalDepth = max(0.0, texture2D(uStentAccum, uv).r);
  // 石灰化も吸収係数を既に加算前に掛けてあるが、こちらは血管と同じ軽いブラーを
  // 通す(=不整形な塊のポリゴンエッジをなめらかにし、血管に重なる自然な濃い陰影に見せる)。
  float calcificationOpticalDepth = blurredSample(uCalcificationAccum, uv, uBlurRadius);

  // exp(-30)は既に無視できるほど0に近いため、上限でクランプしても見た目には
  // 影響しない(Infinity/NaNが万一紛れ込んでも画面全体が壊れないための安全策)。
  float totalOpticalDepth = min(vesselOpticalDepth + heartOpticalDepth + stentOpticalDepth + calcificationOpticalDepth, 30.0);
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
    // uConcentrationMask/uUseConcentrationMaskは全アキュムレータ材質が共通で持つ
    // (GENERIC_ACCUM_FRAGMENT_SHADER参照)が、既定はfalse/null(マスクなし=常時
    // 満額寄与)。血管本体のupdate()ループだけが血管ごとに都度trueへ切り替える。
    uniforms: {
      uConcentrationMask: new Uniform(null),
      uUseConcentrationMask: new Uniform(false),
      ...uniforms,
    },
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
  private readonly stentAccumBackMaterial: ShaderMaterial;
  private readonly stentAccumFrontMaterial: ShaderMaterial;
  private readonly peelScene: Scene;
  private readonly proxies: Partial<Record<VesselId, Mesh>> = {};
  private readonly proxySourceGeometry: Partial<Record<VesselId, unknown>> = {};
  private readonly vesselAccumTarget: WebGLRenderTarget;
  private heartProxy: Mesh | null = null;
  private heartProxySourceGeometry: unknown = null;
  private readonly heartAccumTarget: WebGLRenderTarget;
  private readonly stentProxies: (Mesh | null)[] = [];
  private readonly stentProxySourceGeometry: (unknown | null)[] = [];
  private readonly stentAccumTarget: WebGLRenderTarget;
  private readonly calcificationAccumBackMaterial: ShaderMaterial;
  private readonly calcificationAccumFrontMaterial: ShaderMaterial;
  private readonly calcificationProxies: (Mesh | null)[] = [];
  private readonly calcificationProxySourceGeometry: (unknown | null)[] = [];
  private readonly calcificationAccumTarget: WebGLRenderTarget;
  /**
   * 内腔を狭める要素(狭窄プラークの外径/内径チューブ、石灰化の内腔減算用シェル)の
   * プロキシ。血管本体と全く同じvesselAccumBackMaterial/vesselAccumFrontMaterialを
   * 共有するが、uSignをエントリごとに(通常の血管は+1固定、減算したい面は-1、
   * 加算したい面は+1に)都度設定してから描画することで、専用のテクスチャチャンネルを
   * 増やさずに「血管の生厚み - 内腔方向への張り出し厚み」を同じ共有アキュムレータ内で
   * 計算する。狭窄・石灰化による構造的な狭窄は造影剤の有無とは無関係な解剖学的事実の
   * ため、造影剤フローモードのON/OFFに関わらず常時使われる(update()参照。濃度マスクは
   * 血管本体のみに掛かり、このプロキシには掛からない)。
   */
  private readonly lumenSubtractionProxies: (Mesh | null)[] = [];
  private readonly lumenSubtractionProxySourceGeometry: (unknown | null)[] = [];
  /**
   * 造影剤フローモードの濃度マスク描画用マテリアル。深度ピールの前後面差分ではなく
   * MaxEquationブレンドの単一パスで、頂点属性aScalar(濃度)をそのまま出力する。
   */
  private readonly contrastMaskMaterial: ShaderMaterial;
  private readonly contrastMaskProxies: Partial<Record<VesselId, Mesh>> = {};
  private readonly contrastMaskProxySourceGeometry: Partial<Record<VesselId, unknown>> = {};
  private readonly contrastMaskAccumTarget: WebGLRenderTarget;
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
      ["uStentAccum", new Uniform(null)],
      ["uCalcificationAccum", new Uniform(null)],
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
    this.stentAccumBackMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, BackSide, {
      uSign: new Uniform(1),
      uWeight: new Uniform(1),
    });
    this.stentAccumFrontMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, FrontSide, {
      uSign: new Uniform(-1),
      uWeight: new Uniform(1),
    });
    this.calcificationAccumBackMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, BackSide, {
      uSign: new Uniform(1),
      uWeight: new Uniform(1),
    });
    this.calcificationAccumFrontMaterial = createAccumMaterial(GENERIC_ACCUM_VERTEX_SHADER, GENERIC_ACCUM_FRAGMENT_SHADER, FrontSide, {
      uSign: new Uniform(-1),
      uWeight: new Uniform(1),
    });
    this.contrastMaskMaterial = new ShaderMaterial({
      vertexShader: CONTRAST_MASK_VERTEX_SHADER,
      fragmentShader: CONTRAST_MASK_FRAGMENT_SHADER,
      side: DoubleSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    });
    this.peelScene = new Scene();
    this.vesselAccumTarget = createPeelTarget();
    this.heartAccumTarget = createPeelTarget();
    this.stentAccumTarget = createPeelTarget();
    this.calcificationAccumTarget = createPeelTarget();
    this.contrastMaskAccumTarget = createPeelTarget();
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
  private ensureStentProxy(index: number, sourceMesh: Mesh): Mesh {
    const existing = this.stentProxies[index];
    if (existing && this.stentProxySourceGeometry[index] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.stentAccumBackMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.stentProxies[index] = proxy;
    this.stentProxySourceGeometry[index] = sourceMesh.geometry;
    return proxy;
  }

  /**
   * 石灰化オブジェクトのプロキシ。ステントと同じパターンだが、専用のアキュムレータ
   * (mainImage側で軽くブラーがかかる)に積算するため別のマテリアル/配列を使う。
   */
  private ensureCalcificationProxy(index: number, sourceMesh: Mesh): Mesh {
    const existing = this.calcificationProxies[index];
    if (existing && this.calcificationProxySourceGeometry[index] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.calcificationAccumBackMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.calcificationProxies[index] = proxy;
    this.calcificationProxySourceGeometry[index] = sourceMesh.geometry;
    return proxy;
  }

  /**
   * 内腔を狭める要素(狭窄の外径/内径チューブ、石灰化の内腔減算用シェル)のプロキシ。
   * material は vesselAccumBackMaterial を仮に割り当てておくが、実際の描画直前に
   * update() 側で back/front それぞれの material に差し替え、uSign もエントリごとに
   * 設定し直す。
   */
  private ensureLumenSubtractionProxy(index: number, sourceMesh: Mesh): Mesh {
    const existing = this.lumenSubtractionProxies[index];
    if (existing && this.lumenSubtractionProxySourceGeometry[index] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.vesselAccumBackMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.lumenSubtractionProxies[index] = proxy;
    this.lumenSubtractionProxySourceGeometry[index] = sourceMesh.geometry;
    return proxy;
  }

  /**
   * 造影剤フローモードの濃度マスクプロキシ。血管と同じ「元メッシュのgeometryを共有しつつ
   * matrixWorldだけ毎フレームコピーする」パターンだが、マテリアルはcontrastMaskMaterial
   * (MaxEquationブレンドの単一パス)固定。
   */
  private ensureContrastMaskProxy(id: VesselId, sourceMesh: Mesh): Mesh {
    const existing = this.contrastMaskProxies[id];
    if (existing && this.contrastMaskProxySourceGeometry[id] === sourceMesh.geometry) {
      return existing;
    }
    if (existing) this.peelScene.remove(existing);
    const proxy = new Mesh(sourceMesh.geometry, this.contrastMaskMaterial);
    proxy.frustumCulled = false;
    proxy.matrixAutoUpdate = false;
    proxy.matrixWorldAutoUpdate = false;
    this.peelScene.add(proxy);
    this.contrastMaskProxies[id] = proxy;
    this.contrastMaskProxySourceGeometry[id] = sourceMesh.geometry;
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
    for (const proxy of this.stentProxies) {
      if (proxy) proxy.visible = proxy === active;
    }
    for (const proxy of this.calcificationProxies) {
      if (proxy) proxy.visible = proxy === active;
    }
    for (const proxy of this.lumenSubtractionProxies) {
      if (proxy) proxy.visible = proxy === active;
    }
    for (const id of VESSEL_IDS) {
      const proxy = this.contrastMaskProxies[id];
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
    //
    // 造影剤フローモードのON/OFFに関わらず、常に素の血管メッシュ(handle.vesselMeshes)を
    // 使う——Phase 7実装前と全く同じ「常時フル吸収で末梢まで濃く描出する」計算をベースに
    // 固定することで、造影剤フローモードONで濃度1.0(完全に満たされた状態)になった区間が
    // OFF時と完全に一致することを保証する。濃度による見た目の変化は、この血管自身の
    // 厚み加算パスの中で、この血管「自身」の濃度マスクを掛け合わせる形で適用する(下記)。
    renderer.setRenderTarget(this.vesselAccumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);

    let anyVesselVisible = false;
    for (const id of VESSEL_IDS) {
      const sourceMesh = handle.vesselMeshes[id];
      const visible = handle.vesselVisible[id] !== false && !!sourceMesh;
      if (!visible || !sourceMesh) continue;
      anyVesselVisible = true;

      // 造影剤フローモード中は、この血管「自身」の濃度マスクをcontrastMaskAccumTarget
      // へ都度クリア→単独描画し直してから、この血管の厚み加算パスにだけサンプリング
      // させる(GENERIC_ACCUM_FRAGMENT_SHADER参照)。血管ごとに独立してマスクすることで、
      // 視線方向に濃度の異なる血管同士が重なっても互いの濃度が混ざらない——以前は
      // 3血管分の濃度マスクをMaxEquationで1枚に合成してから、その1枚を3血管合計後の
      // 厚みに一括で掛けていたため、造影ありの血管と重なった造影なしの血管がその
      // 「他人の」高い濃度に便乗して写ってしまう不具合があった(狭窄より末梢の
      // 未造影LADが、視線方向で重なるRCAの濃度1.0に便乗して縦線状に写る、等)。
      const maskMesh = handle.contrastMaskMeshes[id];
      const useConcentrationMask = handle.contrastFlowModeEnabled && !!maskMesh;
      if (useConcentrationMask && maskMesh) {
        renderer.setRenderTarget(this.contrastMaskAccumTarget);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        const maskProxy = this.ensureContrastMaskProxy(id, maskMesh);
        maskProxy.matrixWorld.copy(maskMesh.matrixWorld);
        this.activateOnlyProxy(maskProxy);
        renderer.setRenderTarget(this.contrastMaskAccumTarget);
        maskProxy.material = this.contrastMaskMaterial;
        renderer.render(this.peelScene, camera);
      }

      const proxy = this.ensureProxy(id, sourceMesh);
      proxy.matrixWorld.copy(sourceMesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.vesselAccumTarget);
      // uSign/uUseConcentrationMaskは内腔減算のループ(下)で一時的に変更することが
      // あるため、通常の血管では常に明示的に既定値へ戻してから描画する。
      (this.vesselAccumBackMaterial.uniforms.uSign as Uniform).value = 1;
      (this.vesselAccumFrontMaterial.uniforms.uSign as Uniform).value = -1;
      (this.vesselAccumBackMaterial.uniforms.uUseConcentrationMask as Uniform).value = useConcentrationMask;
      (this.vesselAccumFrontMaterial.uniforms.uUseConcentrationMask as Uniform).value = useConcentrationMask;
      (this.vesselAccumBackMaterial.uniforms.uConcentrationMask as Uniform).value = useConcentrationMask
        ? this.contrastMaskAccumTarget.texture
        : null;
      (this.vesselAccumFrontMaterial.uniforms.uConcentrationMask as Uniform).value = useConcentrationMask
        ? this.contrastMaskAccumTarget.texture
        : null;
      proxy.material = this.vesselAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.vesselAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    }

    // 内腔を狭める要素(狭窄の外径/内径チューブ、石灰化の内腔減算用シェル): 専用の
    // テクスチャチャンネルを増やさず、血管と同じ共有ターゲットにentry.signで符号付けして
    // 追加描画する。狭窄は外径チューブ(-1)+内径チューブ(+1)の2エントリで、その差
    // (外径厚み-内径厚み=プラーク自身の厚み)がちょうど血管の生厚みから差し引かれる。
    // 石灰化は内腔減算専用シェル(-1)の1エントリで、血管本来の半径と内腔半径の差
    // (内側への張り出し量)だけが差し引かれる。狭窄・石灰化による構造的な狭窄は
    // 造影剤の有無とは無関係な解剖学的事実のため、モードのON/OFFに関わらず常時適用する
    // (濃度マスクは掛けない——上の血管ループでこれらのマテリアルに濃度マスクを
    // 設定済みのため、ここで明示的にfalseへ戻さないと直前の血管のマスクが残ってしまう)。
    handle.lumenSubtractionProxies.forEach((entry, index) => {
      anyVesselVisible = true;

      const proxy = this.ensureLumenSubtractionProxy(index, entry.mesh);
      proxy.matrixWorld.copy(entry.mesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.vesselAccumTarget);
      (this.vesselAccumBackMaterial.uniforms.uSign as Uniform).value = entry.sign;
      (this.vesselAccumFrontMaterial.uniforms.uSign as Uniform).value = -entry.sign;
      (this.vesselAccumBackMaterial.uniforms.uUseConcentrationMask as Uniform).value = false;
      (this.vesselAccumFrontMaterial.uniforms.uUseConcentrationMask as Uniform).value = false;
      proxy.material = this.vesselAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.vesselAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    });
    for (let i = handle.lumenSubtractionProxies.length; i < this.lumenSubtractionProxies.length; i++) {
      const stale = this.lumenSubtractionProxies[i];
      if (stale) {
        this.peelScene.remove(stale);
        this.lumenSubtractionProxies[i] = null;
        this.lumenSubtractionProxySourceGeometry[i] = null;
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

    // ステント: 件数に関わらず1枚の共有ターゲットに加算合成する。オブジェクトごとに
    // 吸収係数が異なるため、加算する前に自身の吸収係数を掛けてから加算する(uWeight)
    // ことで、合計値がそのままBeer-Lambert則の吸光度になる。石灰化とは別チャンネル
    // (mainImageでブラーを掛けない)にすることで、金属の網目らしい鋭さを保つ。
    renderer.setRenderTarget(this.stentAccumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);

    let anyStentVisible = false;
    handle.stentProxies.forEach((entry, index) => {
      if (!entry) return;
      anyStentVisible = true;

      const proxy = this.ensureStentProxy(index, entry.mesh);
      proxy.matrixWorld.copy(entry.mesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.stentAccumTarget);
      (this.stentAccumBackMaterial.uniforms.uWeight as Uniform).value = entry.absorption;
      (this.stentAccumFrontMaterial.uniforms.uWeight as Uniform).value = entry.absorption;
      proxy.material = this.stentAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.stentAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    });
    // 今回のフレームで使われなかった過去のプロキシは残しておくとpeelSceneに古い
    // ジオメトリが居座り続けてしまうため、件数が減った分は破棄する。
    for (let i = handle.stentProxies.length; i < this.stentProxies.length; i++) {
      const stale = this.stentProxies[i];
      if (stale) {
        this.peelScene.remove(stale);
        this.stentProxies[i] = null;
        this.stentProxySourceGeometry[i] = null;
      }
    }
    this.uniforms.get("uStentAccum")!.value = anyStentVisible ? this.stentAccumTarget.texture : null;

    // 石灰化: ステントと同じ「件数に関わらず1枚の共有ターゲットに加算合成」だが、
    // mainImage側で軽くブラーを掛ける専用チャンネルに積算する(不整形な塊の
    // ポリゴンエッジをなめらかにするため)。
    renderer.setRenderTarget(this.calcificationAccumTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);

    let anyCalcificationVisible = false;
    handle.calcificationProxies.forEach((entry, index) => {
      if (!entry) return;
      anyCalcificationVisible = true;

      const proxy = this.ensureCalcificationProxy(index, entry.mesh);
      proxy.matrixWorld.copy(entry.mesh.matrixWorld);
      this.activateOnlyProxy(proxy);

      renderer.setRenderTarget(this.calcificationAccumTarget);
      (this.calcificationAccumBackMaterial.uniforms.uWeight as Uniform).value = entry.absorption;
      (this.calcificationAccumFrontMaterial.uniforms.uWeight as Uniform).value = entry.absorption;
      proxy.material = this.calcificationAccumBackMaterial;
      renderer.render(this.peelScene, camera);
      proxy.material = this.calcificationAccumFrontMaterial;
      renderer.render(this.peelScene, camera);
    });
    for (let i = handle.calcificationProxies.length; i < this.calcificationProxies.length; i++) {
      const stale = this.calcificationProxies[i];
      if (stale) {
        this.peelScene.remove(stale);
        this.calcificationProxies[i] = null;
        this.calcificationProxySourceGeometry[i] = null;
      }
    }
    this.uniforms.get("uCalcificationAccum")!.value = anyCalcificationVisible ? this.calcificationAccumTarget.texture : null;

    // 全パス終了後は全プロキシを再びvisible=trueに戻しておく(次フレームの
    // activateOnlyProxy呼び出し前に他コードが誤って全滅表示のpeelSceneを参照しても
    // 影響が出ないようにするための後始末。実際の描画はupdate()内で完結するため必須ではないが、
    // 念のため一貫した状態に保つ)。
    for (const id of VESSEL_IDS) {
      const proxy = this.proxies[id];
      if (proxy) proxy.visible = true;
    }
    if (this.heartProxy) this.heartProxy.visible = true;
    for (const proxy of this.stentProxies) {
      if (proxy) proxy.visible = true;
    }
    for (const proxy of this.calcificationProxies) {
      if (proxy) proxy.visible = true;
    }
    for (const proxy of this.lumenSubtractionProxies) {
      if (proxy) proxy.visible = true;
    }
    for (const id of VESSEL_IDS) {
      const proxy = this.contrastMaskProxies[id];
      if (proxy) proxy.visible = true;
    }

    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  override dispose(): void {
    this.vesselAccumTarget.dispose();
    this.heartAccumTarget.dispose();
    this.stentAccumTarget.dispose();
    this.calcificationAccumTarget.dispose();
    this.contrastMaskAccumTarget.dispose();
    this.contrastMaskMaterial.dispose();
    this.vesselAccumBackMaterial.dispose();
    this.vesselAccumFrontMaterial.dispose();
    this.heartAccumBackMaterial.dispose();
    this.heartAccumFrontMaterial.dispose();
    this.stentAccumBackMaterial.dispose();
    this.stentAccumFrontMaterial.dispose();
    this.calcificationAccumBackMaterial.dispose();
    this.calcificationAccumFrontMaterial.dispose();
    super.dispose();
  }
}
