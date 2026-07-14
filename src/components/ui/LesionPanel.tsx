import { useEffect, useMemo, useState } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId } from "../../types/anatomy";
import type { Lesion, LesionType } from "../../types/lesion";
import type { CenterlineBranch, VesselGraph } from "../models/vesselGraph";
import { getBranch, getBranchesAtNode, getVesselGraph } from "../models/vesselGraph";

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

interface ForkChoice {
  nodeId: string;
  options: CenterlineBranch[];
}

interface ForkResult extends ForkChoice {
  snapPercent: number;
}

/**
 * position(現在値、%)からdelta(%)だけ微調整しようとした際、経路上で最初に出会う
 * 「他の枝へ分岐できるノード」を探す。無ければ null を返し、呼び出し側はそのまま
 * deltaぶん移動する(端点で行き止まりならクランプする)。
 *
 * 本幹は複数の分岐点を「通過点」として1本の経路に吸収しているため、枝の両端
 * (position 0/100)だけでなく、経路の途中にある分岐点(branch.waypoints)も
 * チェックする必要がある。
 */
function findForkOnNudge(
  graph: VesselGraph,
  branch: CenterlineBranch,
  currentPercent: number,
  delta: number,
): ForkResult | null {
  const next = currentPercent + delta;
  const forward = delta > 0;

  if (next >= 0 && next <= 100) {
    // 通常の移動: 現在地(除く)と移動先(含む)の間にある分岐点を、近い順にチェックする。
    const candidates = branch.waypoints
      .map((wp) => ({ ...wp, percent: wp.t * 100 }))
      .filter((wp) =>
        forward
          ? wp.percent > currentPercent && wp.percent <= next
          : wp.percent < currentPercent && wp.percent >= next,
      )
      .sort((a, b) => (forward ? a.percent - b.percent : b.percent - a.percent));
    for (const wp of candidates) {
      const options = getBranchesAtNode(graph, wp.nodeId).filter((b) => b.id !== branch.id);
      if (options.length > 0) return { nodeId: wp.nodeId, options, snapPercent: wp.percent };
    }
    return null;
  }

  // 枝の端を超えようとした場合(既にその端にいる状態からさらに進もうとした場合を含む)は、
  // その端のノードに他の枝が無いか確認する。
  const boundaryNodeId = next < 0 ? branch.startNodeId : branch.endNodeId;
  const options = getBranchesAtNode(graph, boundaryNodeId).filter((b) => b.id !== branch.id);
  return options.length > 0 ? { nodeId: boundaryNodeId, options, snapPercent: next < 0 ? 0 : 100 } : null;
}

/**
 * Phase 6: 血管上に疑似配置する病変(狭窄・石灰化・ステント)の追加フォームと一覧。
 *
 * 配置フロー: 「位置を選択」ボタンで3Dビュー上に中心線グラフのノード(起始部・分岐点・
 * 端点)をクリック可能なマーカーとして表示させ、ユーザーがいずれかをクリックすると
 * その枝(本幹/側枝)と位置が確定する。以後は「近位側/遠位側」ボタンでその枝に沿って
 * 位置を微調整でき、枝の端(次の分岐点)に達すると分岐先の候補を選ぶボタンが現れる。
 * 位置が決まったらプレビュー(半透明の簡易円筒、store.previewLesion経由でModelLoaderが
 * 描画)で確認し、「病変を追加」で確定する。
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
  const pickingLesionVessel = useCardioStore((s) => s.pickingLesionVessel);
  const setPickingLesionVessel = useCardioStore((s) => s.setPickingLesionVessel);

  const [type, setType] = useState<LesionType>("stenosis");
  const [vesselId, setVesselId] = useState<VesselId>("RCA");
  const [branchId, setBranchId] = useState<string | null>(null);
  const [positionPercent, setPositionPercent] = useState(50);
  const [lengthPercent, setLengthPercent] = useState(8);
  const [severity, setSeverity] = useState(70);
  const [diameter, setDiameter] = useState(3);
  const [forkChoice, setForkChoice] = useState<ForkChoice | null>(null);

  const graph = useMemo(() => getVesselGraph(vesselId), [vesselId]);
  const currentBranch = branchId ? getBranch(graph, branchId) : undefined;

  // 3Dビューでノードをクリックして位置が渡されたら、フォームへ事前入力する。
  useEffect(() => {
    if (!pendingLesionPosition) return;
    setVesselId(pendingLesionPosition.vesselId);
    setBranchId(pendingLesionPosition.branchId);
    setPositionPercent(Math.round(pendingLesionPosition.position * 100));
    setForkChoice(null);
  }, [pendingLesionPosition]);

  // 枝が決まっている間、3Dビューにライブプレビュー(簡易円筒)を表示する。
  // まだ枝が決まっていない(ノードを選んでいない)間はプレビューを出さない。
  useEffect(() => {
    if (!branchId) {
      setPreviewLesion(null);
      return;
    }
    setPreviewLesion({
      vesselId,
      branchId,
      position: positionPercent / 100,
      length: Math.max(lengthPercent, 1) / 100,
    });
    return () => setPreviewLesion(null);
  }, [vesselId, branchId, positionPercent, lengthPercent, setPreviewLesion]);

  function handleVesselChange(next: VesselId) {
    setVesselId(next);
    setBranchId(null);
    setForkChoice(null);
    if (pickingLesionVessel) setPickingLesionVessel(next);
  }

  function startPicking() {
    setForkChoice(null);
    setPickingLesionVessel(vesselId);
  }

  function nudgePosition(delta: number) {
    if (!currentBranch) return;
    const fork = findForkOnNudge(graph, currentBranch, positionPercent, delta);
    if (fork) {
      setPositionPercent(fork.snapPercent);
      setForkChoice(fork);
      return;
    }
    setPositionPercent(Math.min(100, Math.max(0, positionPercent + delta)));
  }

  function chooseFork(nextBranch: CenterlineBranch) {
    setBranchId(nextBranch.id);
    setPositionPercent(nextBranch.startNodeId === forkChoice?.nodeId ? 0 : 100);
    setForkChoice(null);
  }

  function handleAdd() {
    if (!branchId) return;
    const base = {
      vesselId,
      branchId,
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
    setBranchId(null);
    setForkChoice(null);
  }

  return (
    <section className="panel-section">
      <h2>病変(β)</h2>
      <p className="panel-note">
        「位置を選択」ボタンで3Dビュー上にノード(分岐点・端点)を表示し、いずれかを
        クリックして起点を決めてください。決まったら下のボタンで枝に沿って微調整し、
        プレビュー(水色の半透明な円筒)で確認してから「病変を追加」で確定します。
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
          <select value={vesselId} onChange={(e) => handleVesselChange(e.target.value as VesselId)}>
            {VESSEL_IDS.map((id) => (
              <option key={id} value={id}>
                {VESSEL_LABELS[id]}
              </option>
            ))}
          </select>
        </label>

        {!branchId && (
          <>
            <p className="panel-note lesion-click-hint">
              👉 「位置を選択」を押してから、3Dビューで{VESSEL_LABELS[vesselId]}のノードをクリックしてください。
            </p>
            <button type="button" onClick={startPicking}>
              {pickingLesionVessel === vesselId ? "🎯 ノードをクリックしてください…" : "📍 位置を選択"}
            </button>
          </>
        )}

        {branchId && currentBranch && !forkChoice && (
          <>
            <p className="panel-note lesion-segment-hint">枝: {currentBranch.label}</p>
            <div className="lesion-fine-tune-row">
              <button type="button" onClick={() => nudgePosition(-FINE_TUNE_STEP_PERCENT)}>
                ◀ 近位側へ
              </button>
              <span className="opacity-value">{positionPercent}%</span>
              <button type="button" onClick={() => nudgePosition(FINE_TUNE_STEP_PERCENT)}>
                遠位側へ ▶
              </button>
            </div>
            <button type="button" onClick={startPicking}>
              🎯 位置を選び直す
            </button>
          </>
        )}

        {forkChoice && (
          <div className="lesion-fork-choice">
            <p className="panel-note">分岐点です。進む先を選んでください:</p>
            {forkChoice.options.map((option) => (
              <button key={option.id} type="button" onClick={() => chooseFork(option)}>
                {option.label}
              </button>
            ))}
          </div>
        )}

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
        <button type="button" onClick={handleAdd} disabled={!branchId}>
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
  const [forkChoice, setForkChoice] = useState<ForkChoice | null>(null);
  const graph = useMemo(() => getVesselGraph(lesion.vesselId), [lesion.vesselId]);
  const branch = getBranch(graph, lesion.branchId);

  function nudge(delta: number) {
    if (!branch) return;
    const fork = findForkOnNudge(graph, branch, lesion.position * 100, delta);
    if (fork) {
      onUpdate({ position: fork.snapPercent / 100 });
      setForkChoice(fork);
      return;
    }
    onUpdate({ position: Math.min(1, Math.max(0, (lesion.position * 100 + delta) / 100)) });
  }

  function chooseFork(nextBranch: CenterlineBranch) {
    onUpdate({ branchId: nextBranch.id, position: nextBranch.startNodeId === forkChoice?.nodeId ? 0 : 1 });
    setForkChoice(null);
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
        <span className="lesion-position-display">
          {branch?.label ?? lesion.branchId} 位置 {Math.round(lesion.position * 100)}%
        </span>
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
      {forkChoice && (
        <div className="lesion-fork-choice">
          <p className="panel-note">分岐点です。進む先を選んでください:</p>
          {forkChoice.options.map((option) => (
            <button key={option.id} type="button" onClick={() => chooseFork(option)}>
              {option.label}
            </button>
          ))}
        </div>
      )}
      {isEditing && (
        <p className="panel-note lesion-click-hint">
          👉 3Dビューで{VESSEL_LABELS[lesion.vesselId]}のノードをクリックして新しい位置を指定してください。
        </p>
      )}
    </li>
  );
}
