import { BufferGeometry, Vector3 } from "three";
import type { StenosisObject } from "../../types/object";
import type { CenterlinePoint } from "./vesselCenterline";
import { sampleCenterline } from "./vesselCenterline";
import { buildTubeFromPoints, mergeIndexedGeometries } from "./stentLatticeMesh";

/** プラークの色。石灰化(黄, #e8c400)・ステント(灰, #9098a0)と区別できる、脂質性プラークを想起させるクリーム色 */
export const STENOSIS_PLAQUE_COLOR = "#d8c9a3";

const RADIAL_SEGMENTS = 20;
const SMOOTHING_PASSES = 24;

/**
 * 厚みプロファイルの裾の絞り具合。profile(s)=exp(-PROFILE_STEEPNESS*s^2) で、
 * 区間端(|s|=1、s=(t-position)/(length/2))において概ね0(exp(-4.5)≈0.011)に
 * なるよう選んだ値。旧来のガウス(σ=length/4相当)は区間端でまだ約13.5%の厚みが
 * 残ってしまい、チューブの切断面に段差が見えていたため、より急峻にしている。
 */
const PROFILE_STEEPNESS = 4.5;

/** 血管壁とちょうど同じ半径だとz-fightingしうるため、ごくわずかに内側に収める。 */
const OUTER_RADIUS_MARGIN = 0.995;

/** 狭窄率99%でも内腔半径が0(縮退ジオメトリ)にならないよう設ける下限(局所血管半径に対する比率)。 */
const MIN_LUMEN_RADIUS_RATIO = 0.02;

function narrowingProfile(s: number): number {
  return Math.exp(-PROFILE_STEEPNESS * s * s);
}

export interface StenosisPlaqueGeometries {
  /** メインビュー・シネスキーマ表示用: 外径チューブ+内径チューブを結合した1枚のジオメトリ */
  merged: BufferGeometry;
  /** シネX線モードの深度ピール減算用: 外径(血管壁に接する側)チューブ単体 */
  outer: BufferGeometry;
  /** シネX線モードの深度ピール減算用: 内径(狭窄後の内腔)チューブ単体 */
  inner: BufferGeometry;
}

/**
 * 狭窄を「血管ジオメトリそのものの変形」ではなく、血管の内側に付着する肉厚を持つ管
 * (内腔が狭まった中空チューブ)として生成する。ステントの土台円筒
 * (buildStentGeometry)と全く同じ sampleCenterline + buildTubeFromPoints の組み合わせを
 * 流用し、位置・長さ・向きの計算ロジックを共有する。
 *
 * three.jsに「内腔付き管」の標準ジオメトリは無いため、外径(血管壁に接する)チューブと
 * 内径(狭窄後の内腔)チューブを別々に生成し、視覚表示用にはこの2枚を1つのジオメトリへ
 * 結合する(merged)。シネX線モードの深度ピール減算には外径・内径を独立したメッシュとして
 * 個別に登録する必要があるため、結合前のジオメトリもそれぞれ返す(CineVesselThicknessEffect
 * 側で「外径は符号反転、内径は通常符号」で同じ血管アキュムレータに加算し、
 * 血管の生厚みからプラーク自身の厚みぶんを差し引く仕組みに使う)。
 *
 * 区間中央(object.position)を最も厚く、両端に向かってガウス関数的に厚みが0へ滑らかに
 * 収束するプロファイルを使う(「指定した狭窄率」は区間中央=最狭窄部における値として扱う)。
 * 血管半径は固定値を使わず、各サンプル点ごとに sampleCenterline から実際に取得した
 * 局所半径を使う(区間内で血管が自然にテーパーしていれば、プラーク厚みもそれに追従する)。
 */
export function buildStenosisPlaqueGeometry(
  centerline: CenterlinePoint[],
  object: StenosisObject,
): StenosisPlaqueGeometries {
  const half = Math.max(object.length / 2, 0.005);
  const tStart = Math.max(0, object.position - half);
  const tEnd = Math.min(1, object.position + half);
  const segmentCount = Math.max(16, Math.min(64, Math.round(object.length * 200)));

  const points: Vector3[] = [];
  const outerRadii: number[] = [];
  const innerRadii: number[] = [];
  for (let i = 0; i <= segmentCount; i++) {
    const t = tStart + ((tEnd - tStart) * i) / segmentCount;
    const sample = sampleCenterline(centerline, t);
    points.push(sample.point);

    const vesselRadius = sample.radius;
    const s = (t - object.position) / half;
    const profile = narrowingProfile(s);
    const thickness = vesselRadius * (object.severity / 100) * profile;

    outerRadii.push(vesselRadius * OUTER_RADIUS_MARGIN);
    innerRadii.push(Math.max(vesselRadius * MIN_LUMEN_RADIUS_RATIO, vesselRadius - thickness));
  }

  const outer = buildTubeFromPoints(points, outerRadii, RADIAL_SEGMENTS, SMOOTHING_PASSES);
  const inner = buildTubeFromPoints(points, innerRadii, RADIAL_SEGMENTS, SMOOTHING_PASSES);
  const merged = mergeIndexedGeometries([outer, inner]);
  return { merged, outer, inner };
}
