// 患者解剖座標系(LPS: X=Right→Left, Y=Anterior→Posterior, Z=Feet→Head)と
// シーンローカル座標系の対応関係を表すキャリブレーション。
//
// 回転(3自由度)は以下の2つのシーンローカル単位ベクトルだけで過不足なく決まる:
// - headAxis: 患者の頭側を指すおおよその単位ベクトル(2自由度)。プリセットボタンで
//             選ぶ「だいたいの頭側」の下書きで、apAxisと直交していなくてもよい
//             (utils/cArmAngles.ts の deriveCalibrationBasis がapAxisを優先して
//             headAxisの方を直交化するため)。
// - apAxis:   患者の正面(AP視点でカメラが位置する側)を指す単位ベクトル(1自由度)。
//             「この視点をAP正面として設定」ボタンを押した瞬間のカメラ方向が
//             そのまま入るため、この値は動かさず常にraoLao=0・craCaud=0の基準になる。
// 残りの左右軸は rightAxis = normalize(cross(apAxis, headAxis)) で導出できる
// (患者LPS座標系で Anterior × Head = Right の関係が成り立つため)。
//
// 将来DICOM由来の実メッシュに差し替える際は、このオブジェクトを実データの
// patient orientationに合わせて差し替える(または機械的に算出する)だけで対応できる。
export interface PatientFrameCalibration {
  headAxis: [number, number, number];
  apAxis: [number, number, number];
}

/**
 * 保存前に正規化・直交化は行わなくてよい(utils/cArmAngles.ts の
 * deriveCalibrationBasis() が都度、正規化+直交化を行う)。
 *
 * heart-realistic.glb はGLB出力時にY-upへ揃えてあるため、頭側の既定値は +Y。
 * apAxis の既定値は store/useCardioStore.ts の DEFAULT_CAMERA_POSITION
 * ([4, 2.5, 5])方向(メインビューの初期視点 = 実質的な「まず見える正面」)と
 * 意図的に一致させてある(store側の初期カメラ姿勢もこの値から計算しているため、
 * 起動直後・GLB読み込み中でもCアーム角度表示が0°/0°になる)。
 */
export const DEFAULT_CALIBRATION: PatientFrameCalibration = {
  headAxis: [0, 1, 0],
  apAxis: [4, 2.5, 5],
};
