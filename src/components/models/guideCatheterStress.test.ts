import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  computeGuideCatheterBackupForceProfile,
  guideCatheterBackupForceColor,
} from "./guideCatheterStress";

/** 直線上の等間隔な点列(弧長一様サンプリング)。 */
function makeStraightLine(count: number, spacing = 0.05): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i < count; i++) points.push(new Vector3(i * spacing, 0, 0));
  return points;
}

/** 半径radius・角度sweepRadiansの円弧上の点列。angleFractionsで各点の弧に沿った
 * 位置(0〜1)を指定できる(既定は弧長一様=角度一様サンプリング)。 */
function makeArc(radius: number, sweepRadians: number, count: number, angleFractions?: number[]): Vector3[] {
  const fractions = angleFractions ?? Array.from({ length: count }, (_, i) => i / (count - 1));
  return fractions.map((f) => {
    const angle = f * sweepRadians;
    return new Vector3(radius * Math.sin(angle), radius * (1 - Math.cos(angle)), 0);
  });
}

/** 円弧と同じ半径・掃引角だが、弧長方向に偏った(非一様な)サンプリング位置を使う。
 * 指数1.35は、実アプリのfullSplinePoints(大動脈側の外側経路が論理t値で一様、
 * その後の心筋・内腔干渉補正で個々の点が変位する)で実測される非一様さと同程度の
 * 密度比(最密区間と最疎区間の間隔比でおよそ4〜6倍程度)になるよう選んだもの
 * ——数百倍という極端な密度比は、微分の打ち切り誤差そのものが支配的になり
 * どんな微分スキームでも耐えられない領域のため、この関数の頑健性を測る現実的な
 * テストにならない。 */
function makeNonUniformArc(radius: number, sweepRadians: number, count: number): Vector3[] {
  const fractions = Array.from({ length: count }, (_, i) => (i / (count - 1)) ** 1.35);
  return makeArc(radius, sweepRadians, count, fractions);
}

/** 直線→急な円弧(局所的な折れ)→直線、接線を一致させて接続した点列。 */
function makeLocalizedBend(): { points: Vector3[]; bendStartIndex: number; bendEndIndex: number } {
  const straightCount = 30;
  const arcCount = 24;
  const spacing = 0.05;
  const radius = 0.25; // 直線部より大幅に小さい局所的な急カーブ

  const lead = makeStraightLine(straightCount, spacing);
  const leadEnd = lead[lead.length - 1];

  // leadEndからx方向へ進み、半径radiusでy方向へ90度曲がる円弧(接線はx軸から始まる)。
  const arc = makeArc(radius, Math.PI / 2, arcCount).map((p) => p.clone().add(leadEnd));
  const arcEnd = arc[arc.length - 1];
  // 円弧終端の接線方向は+y(角度90度の位置での接線)なので、続く直線もその方向へ進める。
  const tail = makeStraightLine(straightCount, spacing).map((p) => new Vector3(arcEnd.x, arcEnd.y + p.x, arcEnd.z));

  const points = [...lead, ...arc.slice(1), ...tail.slice(1)];
  return { points, bendStartIndex: straightCount - 1, bendEndIndex: straightCount - 1 + arcCount - 1 };
}

/** 曲率の向きが反転するS字カーブ(J字フックの反転点を模す): 円弧→逆向きの円弧、
 * 接線を一致させて接続。 */
function makeSCurve(): Vector3[] {
  const radius = 0.3;
  const count = 24;
  const first = makeArc(radius, Math.PI / 2, count); // 上向きに曲がる
  const firstEnd = first[first.length - 1];
  const firstTangentAngle = Math.PI / 2; // 弧の終端での接線の向き

  // 2本目の弧は firstEnd から、同じ接線方向で始まり、逆向きに曲がる。
  const second: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const f = i / (count - 1);
    const angle = f * (Math.PI / 2);
    // ローカル座標(弧自身の開始接線がx軸)で逆向きに曲げてから、firstTangentAngleぶん回転して接続する。
    const localX = radius * Math.sin(angle);
    const localY = -radius * (1 - Math.cos(angle));
    const cos = Math.cos(firstTangentAngle);
    const sin = Math.sin(firstTangentAngle);
    const rotatedX = localX * cos - localY * sin;
    const rotatedY = localX * sin + localY * cos;
    second.push(new Vector3(firstEnd.x + rotatedX, firstEnd.y + rotatedY, 0));
  }
  return [...first, ...second.slice(1)];
}

describe("computeGuideCatheterBackupForceProfile", () => {
  it("returns all-zero (well within tolerance) for a straight line (zero curvature everywhere)", () => {
    const points = makeStraightLine(60);
    const profile = computeGuideCatheterBackupForceProfile(points);
    for (const v of profile.normalized) expect(v).toBeLessThan(1e-6);
    expect(profile.maxAbsRaw).toBeLessThan(1e-6);
  });

  it("stays near zero in the interior of a constant-curvature arc (uniform arc-length sampling)", () => {
    const points = makeArc(2, Math.PI / 2, 80);
    const profile = computeGuideCatheterBackupForceProfile(points);
    // Exclude a margin near both ends: computeCurvatureVectors defines endpoints as exactly
    // zero curvature, and the smoothing passes propagate that boundary transient inward a bit.
    const margin = 15;
    const interior = profile.raw.slice(margin, profile.raw.length - margin);
    const maxInterior = Math.max(...interior);
    expect(maxInterior).toBeLessThan(0.05);
  });

  it("stays near zero in the interior of the SAME arc resampled non-uniformly in arc length (regression: arc-length-aware, not index-based, differencing)", () => {
    const points = makeNonUniformArc(2, Math.PI / 2, 80);
    const profile = computeGuideCatheterBackupForceProfile(points);
    const margin = 15;
    const interior = profile.raw.slice(margin, profile.raw.length - margin);
    const maxInterior = Math.max(...interior);
    // A naive index-based (not arc-length-based) second derivative would see the changing sample
    // density itself as a curvature change and spike here; the arc-length-aware formulation should
    // stay just as flat as the uniformly-sampled version above.
    expect(maxInterior).toBeLessThan(0.05);
  });

  it("shows a clear localized peak at a sharp, localized bend (straight -> tight arc -> straight)", () => {
    const { points, bendStartIndex, bendEndIndex } = makeLocalizedBend();
    const profile = computeGuideCatheterBackupForceProfile(points);

    // Background level: well inside the straight sections, away from the bend and from the
    // array boundaries.
    const leadBackground = profile.raw.slice(5, bendStartIndex - 5);
    const tailBackground = profile.raw.slice(bendEndIndex + 5, points.length - 5);
    const background = Math.max(0, ...leadBackground, ...tailBackground);

    // Peak: within a window around the two curvature-discontinuity points (start/end of the arc).
    const peakWindow = profile.raw.slice(bendStartIndex - 5, bendEndIndex + 5);
    const peak = Math.max(...peakWindow);

    expect(peak).toBeGreaterThan(background * 3);
    expect(Math.max(...profile.normalized)).toBeGreaterThan(0.5);
  });

  it("produces a finite, several-samples-wide peak (not a single-sample spike) at a curvature sign reversal (S-curve, models the J-hook contralateral-wall reversal point)", () => {
    // Known limitation (see guideCatheterStress.ts header comment): curvature here is an unsigned
    // magnitude, so a sign reversal shows up as the magnitude dipping toward zero and rising again,
    // which can produce a sharp-looking peak once differentiated twice. This test only characterizes
    // that the peak stays finite and spans multiple samples (i.e. the smoothing cascade is doing its
    // job) -- it deliberately does NOT assert a specific magnitude, since a sharp reaction there is
    // directionally plausible anyway (this is exactly where the catheter is designed to contact the
    // contralateral wall and reverse).
    const points = makeSCurve();
    const profile = computeGuideCatheterBackupForceProfile(points);

    for (const v of profile.raw) expect(Number.isFinite(v)).toBe(true);
    for (const v of profile.normalized) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    const peakIndex = profile.normalized.indexOf(Math.max(...profile.normalized));
    // The peak should not be an isolated single-sample delta: at least one immediate neighbor
    // should still carry a meaningfully elevated value (evidence the smoothing cascade spread it
    // over multiple samples rather than leaving a one-point artifact).
    const neighborValues = [profile.normalized[peakIndex - 1], profile.normalized[peakIndex + 1]].filter(
      (v): v is number => v !== undefined,
    );
    expect(Math.max(...neighborValues)).toBeGreaterThan(0.1);
  });

  it("maintains shape invariants: same length as input, normalized values in [0,1], finite maxAbsRaw", () => {
    const points = makeLocalizedBend().points;
    const profile = computeGuideCatheterBackupForceProfile(points);
    expect(profile.normalized.length).toBe(points.length);
    expect(profile.raw.length).toBe(points.length);
    for (const v of profile.normalized) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Number.isFinite(profile.maxAbsRaw)).toBe(true);
    expect(profile.maxAbsRaw).toBeGreaterThanOrEqual(0);
  });

  it("handles degenerate (too-short) input without throwing, returning all-zero profiles", () => {
    const points = [new Vector3(0, 0, 0), new Vector3(1, 0, 0)];
    const profile = computeGuideCatheterBackupForceProfile(points);
    expect(profile.normalized).toEqual([0, 0]);
    expect(profile.raw).toEqual([0, 0]);
    expect(profile.maxAbsRaw).toBe(0);
  });
});

describe("guideCatheterBackupForceColor", () => {
  it("maps 0 to a near-neutral (low-saturation) color and 1 to a saturated warm color", () => {
    const low = guideCatheterBackupForceColor(0);
    const high = guideCatheterBackupForceColor(1);
    const lowHsl = { h: 0, s: 0, l: 0 };
    const highHsl = { h: 0, s: 0, l: 0 };
    low.getHSL(lowHsl);
    high.getHSL(highHsl);
    expect(lowHsl.s).toBeLessThan(0.1);
    expect(highHsl.s).toBeGreaterThan(0.7);
    expect(highHsl.l).toBeGreaterThan(lowHsl.l);
  });

  it("clamps out-of-range input", () => {
    const belowZero = guideCatheterBackupForceColor(-5);
    const atZero = guideCatheterBackupForceColor(0);
    const aboveOne = guideCatheterBackupForceColor(5);
    const atOne = guideCatheterBackupForceColor(1);
    expect(belowZero.equals(atZero)).toBe(true);
    expect(aboveOne.equals(atOne)).toBe(true);
  });
});
