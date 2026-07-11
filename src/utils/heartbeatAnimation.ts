import type { CineState } from "../types/cine";

/**
 * 拍動アニメーションのパラメータ。実データに差し替える際はこの形をそのまま
 * 置き換える(あるいは computeHeartbeatTransform 自体を差し替える)想定のプレースホルダー。
 *
 * 単純なsin波での一様スケールだと「心臓がただ均一に伸縮しているだけ」に見えてしまうため、
 * 実際の心周期に寄せて以下の2点を近似している:
 * - 収縮期(systole)は速く、拡張期(diastole)はゆっくり戻る非対称な波形
 *   (心臓は収縮するときは急激、元に戻る(拡張する)ときは緩やかという非対称な動きをする)
 * - 長軸方向(心基部→心尖、モデルのローカルY軸)は短軸方向(X/Z)よりも大きく収縮する
 *   (実際の心臓は長軸短縮の寄与が大きい)。加えて収縮期にわずかな捻れ(twist)を与える。
 */
export interface HeartbeatParams {
  /** 心周期 [秒] */
  periodSeconds: number;
  /** 短軸方向(X/Z)の最大収縮率。1-amplitude まで縮む */
  amplitude: number;
  /** 長軸方向(Y)は短軸方向の何倍収縮するか */
  longitudinalAmplitudeFactor: number;
  /** 収縮期に加えるY軸まわりの最大捻れ角 [ラジアン] */
  twistAmplitude: number;
  /** 心周期のうち収縮期(急速な収縮)が占める割合。残りはゆっくりした拡張期 */
  systoleFraction: number;
}

export const DEFAULT_HEARTBEAT_PARAMS: HeartbeatParams = {
  periodSeconds: 0.5,
  amplitude: 0.05,
  longitudinalAmplitudeFactor: 1.6,
  twistAmplitude: 0.06,
  systoleFraction: 0.35,
};

/** 拍動アニメーションが1フレームでメッシュに適用すべき変換量 */
export interface HeartbeatTransform {
  scale: [number, number, number];
  /** Y軸まわりの捻れ角 [ラジアン] */
  twistY: number;
}

function smoothstep01(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * 心周期内の位相(0〜1)から「収縮の深さ」(0=弛緩しきった状態, 1=最も収縮した状態)を返す。
 * 収縮期(0〜systoleFraction)は smoothstep で素早く0→1、拡張期は残り区間でゆっくり1→0に戻す。
 */
function contractionEnvelope(phase01: number, systoleFraction: number): number {
  if (phase01 < systoleFraction) {
    return smoothstep01(phase01 / systoleFraction);
  }
  const relaxPhase = (phase01 - systoleFraction) / (1 - systoleFraction);
  return 1 - smoothstep01(relaxPhase);
}

/** 再生中だった経過秒数から、その瞬間にメッシュへ適用すべき拍動変換を返す */
export function computeHeartbeatTransform(
  elapsedActiveSeconds: number,
  params: HeartbeatParams = DEFAULT_HEARTBEAT_PARAMS,
): HeartbeatTransform {
  const cycleSeconds = ((elapsedActiveSeconds % params.periodSeconds) + params.periodSeconds) % params.periodSeconds;
  const phase01 = cycleSeconds / params.periodSeconds;
  const contraction = contractionEnvelope(phase01, params.systoleFraction);

  const radial = 1 - params.amplitude * contraction;
  const longitudinal = 1 - params.amplitude * params.longitudinalAmplitudeFactor * contraction;

  return {
    scale: [radial, longitudinal, radial],
    twistY: params.twistAmplitude * contraction,
  };
}

/**
 * 一時停止をまたいでも正しく計算できる「再生中だった経過秒数」。
 * 2つの独立した Canvas(それぞれ自前の THREE.Clock を持つ)が同じ store の値から
 * この純粋関数で同じ値を計算することで、内部クロックがズレていても位相が揃う。
 */
export function getElapsedActiveSeconds(cine: Pick<CineState, "playing" | "playStartedAtMs" | "accumulatedSeconds">): number {
  const live = cine.playing && cine.playStartedAtMs !== null ? (performance.now() - cine.playStartedAtMs) / 1000 : 0;
  return cine.accumulatedSeconds + live;
}
