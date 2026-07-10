export interface CArmAngles {
  /** 正: RAO(右前斜位), 負: LAO(左前斜位) [度] */
  raoLao: number;
  /** 正: CRA(頭側), 負: CAUD(尾側) [度] */
  craCaud: number;
}

/**
 * カメラのクォータニオンからC-arm角度(LAO/RAO, CRA/CAUD)へ変換するためのスタブ。
 *
 * 実装には、シーンのワールド座標系と患者座標系(体軸/前後軸/左右軸)の対応関係を
 * 決める必要がある。実際の患者座標系(DICOM由来)が導入されるフェーズで
 * 中身を実装する想定で、呼び出し口だけ先に用意している。
 */
export function cameraQuaternionToCArmAngles(
  _quaternion: [number, number, number, number],
): CArmAngles {
  // TODO: 患者座標系との対応付けが決まり次第実装する。
  return { raoLao: 0, craCaud: 0 };
}
