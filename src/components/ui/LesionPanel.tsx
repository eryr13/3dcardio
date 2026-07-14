import { useEffect, useState } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId } from "../../types/anatomy";
import type { Lesion, LesionType } from "../../types/lesion";
import { SEGMENT_DEFS } from "../models/vesselSegments";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];
const VESSEL_LABELS: Record<VesselId, string> = { RCA: "RCA", LAD: "LAD", LCX: "LCX" };
const TYPE_LABELS: Record<LesionType, string> = {
  stenosis: "狭窄",
  calcification: "石灰化",
  stent: "ステント",
};
const TYPE_ICONS: Record<LesionType, string> = {
  stenosis: "⏳",
  calcification: "◆",
  stent: "▦",
};

/** 微調整ボタン1回あたりの移動量(位置パーセントの1%刻み)。 */
const FINE_TUNE_STEP_PERCENT = 1;

/** position(0〜1)から、参考情報として表示するセグメント名を逆引きする。
 * vesselSegments.ts の splitGeometryByLength と同じ「近位=t小さい方から等分割」の
 * 約束事で算出しているため、実際のセグメント境界とは機械的に一致する。 */
function segmentLabelForPosition(vesselId: VesselId, position: number): string {
  const defs = SEGMENT_DEFS[vesselId];
  const idx = Math.min(defs.length - 1, Math.max(0, Math.floor(position * defs.length)));
  return defs[idx].name;
}

/**
 * Phase 6: 血管上に疑似配置する病変(狭窄・石灰化・ステント)の追加フォームと一覧。
 *
 * 配置フロー: 3Dビュー上で血管をクリックして大まかな位置を決め(中心線上の最近傍点に
 * 自動スナップされる)、必要なら「近位側/遠位側」ボタンで微調整しながら3Dビュー上の
 * ライブプレビュー(半透明の簡易円筒、store.previewLesion経由でModelLoaderが描画)で
 * 位置を確認し、「病変を追加」で確定する。position(%)の直接入力は目安表示のみとし、
 * 基本操作にはしない(分岐部付近でのposition→3D座標変換のズレを、クリック操作で
 * 目視確認しながら回避するための設計)。
 */
export function LesionPanel() {
  const lesions = useCardioStore((s) => s.lesions);
  const addLesion = useCardioStore((s) => s.addLesion);
  const updateLesion = useCardioStore((s) => s.updateLesion);
  const removeLesion = useCardioStore((s) => s.removeLesion);
  const pendingLesionPosition = useCardioStore((s) => s.pendingLesionPosition);
  const setPendingLesionPosition = useCardioStore((s) => s.setPendingLesionPosition);
  const setPreviewLesion = useCardioStore((s) => s.setPreviewLesion);
  const editingLesionId = useCardioStore((s) => s.editingLesionId);
  const setEditingLesionId = useCardioStore((s) => s.setEditingLesionId);

  const [type, setType] = useState<LesionType>("stenosis");
  const [vesselId, setVesselId] = useState<VesselId>("RCA");
  const [positionPercent, setPositionPercent] = useState(50);
  const [lengthPercent, setLengthPercent] = useState(8);
  const [severity, setSeverity] = useState(70);
  const [diameter, setDiameter] = useState(3);

  // 3Dビュー上のクリックで位置が渡されたら、フォームへ事前入力する。
  useEffect(() => {
    if (!pendingLesionPosition) return;
    setVesselId(pendingLesionPosition.vesselId);
    setPositionPercent(Math.round(pendingLesionPosition.position * 100));
  }, [pendingLesionPosition]);

  // 位置・長さ・対象血管を変更している間、3Dビューにライブプレビュー(簡易円筒)を表示する。
  // パネルを離れる(アンマウントされる)ときはプレビューを消す。
  useEffect(() => {
    setPreviewLesion({ vesselId, position: positionPercent / 100, length: Math.max(lengthPercent, 1) / 100 });
    return () => setPreviewLesion(null);
  }, [vesselId, positionPercent, lengthPercent, setPreviewLesion]);

  function nudgePosition(delta: number) {
    setPositionPercent((p) => Math.min(100, Math.max(0, p + delta)));
  }

  function handleAdd() {
    const base = {
      vesselId,
      position: positionPercent / 100,
      length: Math.max(lengthPercent, 1) / 100,
      visible: true,
    };
    if (type === "stenosis") {
      addLesion({ ...base, type: "stenosis", severity });
    } else if (type === "calcification") {
      addLesion({ ...base, type: "calcification", severity });
    } else {
      addLesion({ ...base, type: "stent", diameter });
    }
    setPendingLesionPosition(null);
  }

  return (
    <section className="panel-section">
      <h2>病変(β)</h2>
      <p className="panel-note">
        3Dビューで血管をクリックして位置を指定し、必要なら下のボタンで微調整してから
        「病変を追加」で確定してください。プレビュー(水色の半透明な円筒)で配置予定の場所を
        確認できます。
      </p>

      <div className="lesion-form">
        <label className="lesion-form-row">
          種類
          <select value={type} onChange={(e) => setType(e.target.value as LesionType)}>
            <option value="stenosis">狭窄</option>
            <option value="calcification">石灰化プラーク</option>
            <option value="stent">ステント</option>
          </select>
        </label>
        <label className="lesion-form-row">
          対象血管
          <select value={vesselId} onChange={(e) => setVesselId(e.target.value as VesselId)}>
            {VESSEL_IDS.map((id) => (
              <option key={id} value={id}>
                {VESSEL_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <p className="panel-note lesion-click-hint">
          👉 3Dビューで{VESSEL_LABELS[vesselId]}をクリックして位置を指定してください。
        </p>
        <div className="lesion-fine-tune-row">
          <button type="button" onClick={() => nudgePosition(-FINE_TUNE_STEP_PERCENT)}>
            ◀ 近位側へ
          </button>
          <span className="opacity-value">{positionPercent}%</span>
          <button type="button" onClick={() => nudgePosition(FINE_TUNE_STEP_PERCENT)}>
            遠位側へ ▶
          </button>
        </div>
        <p className="panel-note lesion-segment-hint">
          目安: {segmentLabelForPosition(vesselId, positionPercent / 100)}
        </p>
        <label className="lesion-form-row">
          長さ(血管全長比)
          <input
            type="range"
            min={2}
            max={30}
            step={1}
            value={lengthPercent}
            onChange={(e) => setLengthPercent(Number(e.target.value))}
          />
          <span className="opacity-value">{lengthPercent}%</span>
        </label>
        {(type === "stenosis" || type === "calcification") && (
          <label className="lesion-form-row">
            {type === "stenosis" ? "狭窄率" : "石灰化の強さ"}
            <input
              type="range"
              min={0}
              max={type === "stenosis" ? 99 : 100}
              step={1}
              value={severity}
              onChange={(e) => setSeverity(Number(e.target.value))}
            />
            <span className="opacity-value">{severity}%</span>
          </label>
        )}
        {type === "stent" && (
          <label className="lesion-form-row">
            公称径(mm目安)
            <input
              type="number"
              min={1}
              max={6}
              step={0.25}
              value={diameter}
              onChange={(e) => setDiameter(Number(e.target.value))}
            />
          </label>
        )}
        <button type="button" onClick={handleAdd}>
          病変を追加
        </button>
      </div>

      {lesions.length > 0 && (
        <ul className="lesion-list">
          {lesions.map((lesion) => (
            <LesionListItem
              key={lesion.id}
              lesion={lesion}
              isEditing={editingLesionId === lesion.id}
              onUpdate={(patch) => updateLesion(lesion.id, patch)}
              onRemove={() => {
                if (editingLesionId === lesion.id) setEditingLesionId(null);
                removeLesion(lesion.id);
              }}
              onStartReposition={() => setEditingLesionId(lesion.id)}
              onCancelReposition={() => setEditingLesionId(null)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function LesionListItem({
  lesion,
  isEditing,
  onUpdate,
  onRemove,
  onStartReposition,
  onCancelReposition,
}: {
  lesion: Lesion;
  isEditing: boolean;
  onUpdate: (patch: Partial<Lesion>) => void;
  onRemove: () => void;
  onStartReposition: () => void;
  onCancelReposition: () => void;
}) {
  function nudge(delta: number) {
    onUpdate({ position: Math.min(1, Math.max(0, lesion.position + delta / 100)) });
  }

  return (
    <li className={`lesion-item${isEditing ? " lesion-item-editing" : ""}`}>
      <div className="lesion-item-header">
        <span className="lesion-type-icon" aria-hidden="true">
          {TYPE_ICONS[lesion.type]}
        </span>
        <span className="lesion-item-title">
          {VESSEL_LABELS[lesion.vesselId]} - {TYPE_LABELS[lesion.type]}
        </span>
        <label className="lesion-visible-toggle">
          <input
            type="checkbox"
            checked={lesion.visible}
            onChange={(e) => onUpdate({ visible: e.target.checked })}
          />
          表示
        </label>
        <button type="button" className="lesion-remove-button" onClick={onRemove} aria-label="削除">
          削除
        </button>
      </div>
      <div className="lesion-item-controls">
        <span className="lesion-position-display">位置 {Math.round(lesion.position * 100)}%</span>
        <button type="button" onClick={() => nudge(-FINE_TUNE_STEP_PERCENT)} aria-label="近位側へ">
          ◀
        </button>
        <button type="button" onClick={() => nudge(FINE_TUNE_STEP_PERCENT)} aria-label="遠位側へ">
          ▶
        </button>
        {isEditing ? (
          <button type="button" onClick={onCancelReposition}>
            キャンセル
          </button>
        ) : (
          <button type="button" onClick={onStartReposition}>
            🎯 位置を変更
          </button>
        )}
        {(lesion.type === "stenosis" || lesion.type === "calcification") && (
          <label>
            重症度
            <input
              type="number"
              min={0}
              max={lesion.type === "stenosis" ? 99 : 100}
              value={lesion.severity}
              onChange={(e) => onUpdate({ severity: Number(e.target.value) })}
            />
            %
          </label>
        )}
        {lesion.type === "stent" && (
          <label>
            径
            <input
              type="number"
              min={1}
              max={6}
              step={0.25}
              value={lesion.diameter}
              onChange={(e) => onUpdate({ diameter: Number(e.target.value) })}
            />
            mm
          </label>
        )}
      </div>
      {isEditing && (
        <p className="panel-note lesion-click-hint">
          👉 3Dビューで{VESSEL_LABELS[lesion.vesselId]}をクリックして新しい位置を指定してください。
        </p>
      )}
    </li>
  );
}
