// Phase 10: ガイディングカテーテルの応力(バックアップ力)可視化。
//
// カテーテルを Euler-Bernoulli弾性梁として扱い、既に「大動脈壁との接触問題」として
// 導出済みの実際の経路形状(guideDeviceMesh.tsのpressAgainstOuterWall等)を、
// その梁の平衡状態の形状とみなして力学量を逆算する。
//
// 曲率 κ(s) → 曲げモーメント M(s) = EI・κ(s)(局所的な曲げ応力に相当)
// → 分布接触反力(バックアップ力/単位長) q(s) = d²M/ds² = EI・d²κ/ds²
//
// q(s)は「血管壁がカテーテルをその形状に曲げるために及ぼしている反力」そのもの——
// 曲率が一定の区間(単純な湾曲)ではq(s)≈0(壁からの継続的な押し付けは不要)、
// 曲率が急に変化する区間(壁に当たり始める・対側壁で反転する等)でq(s)が大きくなる。
// これが「どこでバックアップを取っているか」の直接的な力学的定義になる。
//
// 【正直な限界】
// - EI(曲げ剛性)は実カテーテルの材料物性データが無いため1に正規化している。
//   結果は「同じ経路の中でどこが相対的に最もバックアップが強いか」を示す相対値であり、
//   実際のN・mm単位の力ではない。
// - κ(s)はcomputeCurvatureVectors(guideDeviceMesh.ts)が返す「unitIn-unitOutの大きさ」、
//   すなわち符号なしのスカラー量である。J字カーブの反転点(対側壁バックアップ→反転)では
//   符号付き曲率は滑らかにゼロを横切るが、その「大きさ」は一旦0に近づいてから再び増える
//   V字型の挙動になり、これを2回微分すると見かけ上鋭いピークになりうる。この反転点は
//   元々「意図的な対側壁接触点」として設計されているため方向性としては妥当だが、これは
//   真の反力そのものではなく、曲率を絶対値として扱っていることに起因するピークの
//   可能性がある(guideCatheterStress.test.tsの該当テスト参照)。
// - q(s)を得るには曲率(それ自体が位置の2階微分相当)をさらに2回微分する必要があり、
//   素朴な差分ではサンプリング密度依存のノイズが増幅されて見せかけの折れ・ピークが
//   生じる(本セッションで繰り返し確認した問題)。smoothScalarField(近傍平均の反復)を
//   各微分の前後に挟むカスケードで安定化している。

import { Color, Vector3 } from "three";
import { computeCurvatureVectors } from "./guideDeviceMesh";

export interface GuideCatheterBackupForceProfile {
  /** 入力pointsと同じ長さ・添字対応。0〜1に正規化した相対的なバックアップ力の目安
   * (0=その経路の中で最も反力が小さい点、1=最も大きい点)。 */
  normalized: number[];
  /** 正規化前の |q(s)| = |d²κ/ds²|。EI=1と仮定した相対値であり単位はない。 */
  raw: number[];
  /** rawの最大値(正規化に使った値、0除算判定・デバッグ用に保持)。 */
  maxAbsRaw: number;
}

/** pointsの各点までの累積弧長(s[0]=0)。fullSplinePointsは近似的にしか弧長一様でない
 * (guideDeviceMesh.tsの大動脈外側経路は論理t値で一様、心筋・内腔干渉補正が個々の点を
 * 変位させるため)ため、添字ベースではなく実際の点間距離を積算した真の弧長を使う。 */
function computeArcLengths(points: Vector3[]): number[] {
  const s = [0];
  for (let i = 1; i < points.length; i++) {
    s.push(s[i - 1] + points[i - 1].distanceTo(points[i]));
  }
  return s;
}

/** 3点近傍平均の反復平滑化(guideDeviceMesh.tsのsmoothVectorFieldのスカラー版、
 * 同じ凸結合を繰り返す)。境界(先頭・末尾)は元の値のまま動かさない
 * (computeCurvatureVectorsの端点規約=0に合わせる)。 */
function smoothScalarField(values: number[], passes: number): number[] {
  let current = values.slice();
  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice();
    for (let i = 1; i < current.length - 1; i++) {
      next[i] = (current[i - 1] + current[i] + current[i + 1]) / 3;
    }
    current = next;
  }
  return current;
}

/**
 * 弧長sに対する非一様間隔対応の3点中心差分(1階微分)。
 * f'(s_i) ≈ -h1/(h0(h0+h1))·f[i-1] + (h1-h0)/(h0·h1)·f[i] + h0/(h1(h0+h1))·f[i+1]
 * (h0=s[i]-s[i-1], h1=s[i+1]-s[i])。等間隔(h0=h1)の場合は通常の中心差分
 * (f[i+1]-f[i-1])/(2h)に一致する。
 *
 * q(s)=EI・d²κ/ds²は、専用の2階微分公式を1回適用するのではなく、この1階微分関数を
 * 「平滑化を挟みながら2回」適用するカスケードで求める(computeGuideCatheterBackupForceProfile
 * 参照)——曲率自体の平滑化(smoothVectorField)と同じ「素朴な差分の前後に近傍平均を挟む」
 * という、本セッションで実証済みの安定化手法を、そのままもう一段重ねる形にするため。
 * 両端は値を定義できないため0のままにする。
 */
function differentiateAlongArcLength(values: number[], arcLengths: number[]): number[] {
  const derivative = values.map(() => 0);
  for (let i = 1; i < values.length - 1; i++) {
    const h0 = arcLengths[i] - arcLengths[i - 1];
    const h1 = arcLengths[i + 1] - arcLengths[i];
    if (h0 < 1e-9 || h1 < 1e-9) continue;
    derivative[i] =
      (-h1 / (h0 * (h0 + h1))) * values[i - 1] + ((h1 - h0) / (h0 * h1)) * values[i] + (h0 / (h1 * (h0 + h1))) * values[i + 1];
  }
  return derivative;
}

/** κの平滑化(1段目)の反復回数。曲率自体の点ごとの離散化ノイズを均す。 */
const STRESS_KAPPA_SMOOTHING_PASSES = 8;
/** dκ/dsの平滑化(2段目)の反復回数。1階微分で増幅されたノイズを均してから2階微分に進む。 */
const STRESS_DKAPPA_SMOOTHING_PASSES = 8;
/** d²κ/ds²の平滑化(3段目、最終)の反復回数。2階微分は最もノイズを増幅しやすいため、
 * 色に変換する前に最後にもう一段均す。 */
const STRESS_FINAL_SMOOTHING_PASSES = 4;

/**
 * カテーテルの密な経路点列から、Euler-Bernoulli梁理論に基づく分布接触反力
 * (バックアップ力の目安)q(s)のプロファイルを計算する。
 *
 * カスケード: 曲率κ(生)→平滑化→1階微分(dκ/ds)→平滑化→1階微分(d²κ/ds²)→平滑化→|・|→正規化。
 */
export function computeGuideCatheterBackupForceProfile(points: Vector3[]): GuideCatheterBackupForceProfile {
  if (points.length < 5) {
    const zeros = points.map(() => 0);
    return { normalized: zeros, raw: zeros.slice(), maxAbsRaw: 0 };
  }

  const arcLengths = computeArcLengths(points);
  const kappaRaw = computeCurvatureVectors(points).map((v) => v.length());
  const kappaSmoothed = smoothScalarField(kappaRaw, STRESS_KAPPA_SMOOTHING_PASSES);
  const dKappaDs = differentiateAlongArcLength(kappaSmoothed, arcLengths);
  const dKappaDsSmoothed = smoothScalarField(dKappaDs, STRESS_DKAPPA_SMOOTHING_PASSES);
  const d2KappaDs2 = differentiateAlongArcLength(dKappaDsSmoothed, arcLengths);
  const qSmoothed = smoothScalarField(d2KappaDs2, STRESS_FINAL_SMOOTHING_PASSES);

  const raw = qSmoothed.map((v) => Math.abs(v));
  const maxAbsRaw = raw.reduce((m, v) => Math.max(m, v), 0);
  const normalized = maxAbsRaw < 1e-12 ? raw.map(() => 0) : raw.map((v) => v / maxAbsRaw);
  return { normalized, raw, maxAbsRaw };
}

/**
 * 正規化されたバックアップ力(0〜1)を色に変換する。既存のischemiaColor
 * (heartPerfusion.ts)と同じHSL補間の技法だが、意味(充足度ではなく反力)が異なる
 * ため独立した関数として用意する。
 *
 * 低反力(0)は現在のカテーテル単色マテリアル(#3a3d42、ニュートラルなグレー)に
 * 近い色にし、高反力(1)へ向けて暖色(オレンジ〜赤)にHSL補間する——バックアップは
 * 経路の一部でだけ起こる局所的な現象なので、常に全体を塗る灌流ヒートマップ的な配色より
 * 「普段は既存のカテーテルと同じグレー、反力が強い場所だけ暖色に光る」方が
 * 「どこでバックアップを取っているか」を直感的に示せる。
 */
// 色相は固定(暖色の赤〜オレンジ、8°)し、彩度・明度だけをt(正規化した反力)で
// 補間する——色相自体を補間すると、途中(中間のt)で意図しない緑・黄色を経由してしまい
// 「グレーから赤へ」という単純な配色の意図が崩れるため(ischemiaColorの色相補間は
// 「正常な緑→梗塞の赤茶色」という別の意味を持つ2色相間の補間なので問題にならないが、
// 今回は「無彩色→単一の暖色」を狙っているため色相は固定するのが正しい)。
const BACKUP_FORCE_HUE_DEG = 8; // 赤
const BACKUP_FORCE_SATURATION_LOW = 0.03; // ほぼ無彩色(既存カテーテル色#3a3d42に近づける)
const BACKUP_FORCE_SATURATION_HIGH = 0.85;
const BACKUP_FORCE_LIGHTNESS_LOW = 0.26; // #3a3d42相当の暗いグレー
const BACKUP_FORCE_LIGHTNESS_HIGH = 0.5;

export function guideCatheterBackupForceColor(normalizedForce: number): Color {
  const t = Math.max(0, Math.min(1, normalizedForce));
  const saturation = BACKUP_FORCE_SATURATION_LOW + (BACKUP_FORCE_SATURATION_HIGH - BACKUP_FORCE_SATURATION_LOW) * t;
  const lightness = BACKUP_FORCE_LIGHTNESS_LOW + (BACKUP_FORCE_LIGHTNESS_HIGH - BACKUP_FORCE_LIGHTNESS_LOW) * t;
  return new Color().setHSL(BACKUP_FORCE_HUE_DEG / 360, saturation, lightness);
}

/** profileの各点を色に変換する(buildGuideCatheterGeometryのpointColors引数にそのまま渡せる)。 */
export function buildGuideCatheterBackupForceColors(profile: GuideCatheterBackupForceProfile): Color[] {
  return profile.normalized.map((v) => guideCatheterBackupForceColor(v));
}
