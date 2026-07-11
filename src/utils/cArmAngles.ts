import { Quaternion, Vector3 } from "three";
import type { PatientFrameCalibration } from "../types/cArmCalibration";

export interface CArmAngles {
  /** 正: RAO(右前斜位), 負: LAO(左前斜位) [度] */
  raoLao: number;
  /** 正: CRA(頭側), 負: CAUD(尾側) [度] */
  craCaud: number;
}

/** キャリブレーションから導出した患者座標系の正規直交基底(シーンローカル座標で表現) */
export interface CalibrationBasis {
  right: Vector3;
  ap: Vector3;
  head: Vector3;
}

/**
 * PatientFrameCalibration(headAxis, apAxis)から、患者座標系の正規直交基底を導出する。
 *
 * apAxis を優先(正規化するだけ)し、headAxis の方を ap に対して直交化する
 * (Gram-Schmidt。head を優先すると逆になる)。この優先順位が重要な理由:
 * 「この視点をAP正面として設定」ボタンは、押した瞬間のカメラ方向をそのまま
 * apAxis として保存するだけなので、その視点で raoLao=0 かつ craCaud=0 に
 * ならないと「基準ゼロ点」として機能しない。craCaud=asin(V・head) は
 * V=ap のとき ap・head=0 である必要があるため、ap を動かさずに head 側を
 * 直交化しないと成立しない。headAxis軸プリセット(±X/±Y/±Z)はあくまで
 * 「だいたいの頭側」を与える下書きで、最終的な精度は常にAP基準ボタンで決まる。
 *
 * - ap:   apAxisを正規化しただけのもの(常にこの値が raoLao=0, craCaud=0 の基準になる)
 * - head: headAxisをapに対して直交化してから正規化したもの
 * - right: ap × head を正規化したもの
 *   (患者LPS座標系(X:R→L, Y:A→P, Z:F→H)では Anterior × Head = Right の関係が成り立つ。
 *    これはRAO/LAOの回転方向・符号の基準になる)
 */
export function deriveCalibrationBasis(calibration: PatientFrameCalibration): CalibrationBasis {
  const ap = new Vector3(...calibration.apAxis).normalize();
  const headRaw = new Vector3(...calibration.headAxis);
  const head = headRaw.clone().addScaledVector(ap, -headRaw.dot(ap)).normalize();
  const right = new Vector3().crossVectors(ap, head).normalize();
  return { right, ap, head };
}

/**
 * カメラ方向ベクトル(シーン原点からカメラ位置への単位ベクトル。シネビューの投影方向と同じ)を
 * 患者座標系のCアーム角度(LAO/RAO, CRA/CAUD)に変換する。
 *
 * 前提・符号の定義:
 * - 患者座標系はDICOM標準のLPS(X:Right→Left, Y:Anterior→Posterior, Z:Feet→Head)。
 * - raoLao=0, craCaud=0 (AP正面) は、カメラ方向ベクトルが calibration の apAxis と
 *   一致する状態(DICOM標準でも Primary/Secondary Angle = 0/0 のとき患者は検出器の方を
 *   向くと定義されており、この対応づけと一致する)。
 * - raoLao: 正=RAO(右前斜位。カメラが患者の右側 = rightAxis 方向へ回転), 負=LAO(左前斜位)。
 * - craCaud: 正=CRA(頭側。カメラが患者の頭側 = headAxis 方向へ回転), 負=CAUD(尾側)。
 *
 * 変換式(DICOM標準のPrimary/Secondary Angleの定義「経度的な回転+頭側への緯度的な回転」、
 * および文献での secondary angle = asin(頭側成分) という式と同じ構造):
 *   craCaud = asin( V・head )
 *   raoLao  = atan2( V・right, V・ap )
 */
export function cameraDirectionToCArmAngles(direction: Vector3, calibration: PatientFrameCalibration): CArmAngles {
  const { right, ap, head } = deriveCalibrationBasis(calibration);
  const v = direction.clone().normalize();

  const craCaudRad = Math.asin(clamp(v.dot(head), -1, 1));
  const raoLaoRad = Math.atan2(v.dot(right), v.dot(ap));

  return {
    raoLao: radToDeg(raoLaoRad),
    craCaud: radToDeg(craCaudRad),
  };
}

/**
 * cameraDirectionToCArmAngles の逆変換。指定したCアーム角度に対応する、
 * シーンローカル座標でのカメラ方向単位ベクトルを返す(カメラの逆算移動に使う)。
 *
 *   V = sin(raoLao)*cos(craCaud) * right
 *     + cos(raoLao)*cos(craCaud) * ap
 *     + sin(craCaud)             * head
 */
export function cArmAnglesToCameraDirection(angles: CArmAngles, calibration: PatientFrameCalibration): Vector3 {
  const { right, ap, head } = deriveCalibrationBasis(calibration);
  const raoLaoRad = degToRad(angles.raoLao);
  const craCaudRad = degToRad(angles.craCaud);

  const cosCraCaud = Math.cos(craCaudRad);
  return new Vector3()
    .addScaledVector(right, Math.sin(raoLaoRad) * cosCraCaud)
    .addScaledVector(ap, Math.cos(raoLaoRad) * cosCraCaud)
    .addScaledVector(head, Math.sin(craCaudRad))
    .normalize();
}

/**
 * カメラのクォータニオン(常にシーン原点(心臓中心)を注視している前提)から、
 * カメラ方向ベクトルを求めてCアーム角度に変換する便宜関数。
 * three.jsのカメラは既定でローカル-Z方向を向くため、-Zをクォータニオンで回転させると
 * 「カメラが向いている方向」になるが、原点を注視している場合これは
 * 「カメラ位置→原点」の向きなので、符号を反転させると「原点→カメラ位置」
 * (= このモジュールで定義するカメラ方向ベクトル)になる。
 */
export function cameraQuaternionToCArmAngles(
  quaternion: [number, number, number, number],
  calibration: PatientFrameCalibration,
): CArmAngles {
  const q = new Quaternion(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  const forward = new Vector3(0, 0, -1).applyQuaternion(q);
  const direction = forward.multiplyScalar(-1);
  return cameraDirectionToCArmAngles(direction, calibration);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
