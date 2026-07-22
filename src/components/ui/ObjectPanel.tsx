import { useEffect, useMemo, useState } from "react";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId } from "../../types/anatomy";
import type { CardioObject, ObjectType } from "../../types/object";
import type { CenterlineBranch, VesselGraph } from "../models/vesselGraph";
import { getBranch, getBranchesAtNode, getVesselGraph } from "../models/vesselGraph";
import { CollapsibleSection } from "./CollapsibleSection";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];
const VESSEL_LABELS: Record<VesselId, string> = { RCA: "RCA", LAD: "LAD", LCX: "LCX" };
const TYPE_LABELS: Record<ObjectType, string> = {
  stenosis: "狭窄",
  calcification: "石灰化",
  stent: "ステント",
};
const TYPE_ICONS: Record<ObjectType, string> = {
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
 * Phase 6: 血管上に疑似配置するオブジェクト(狭窄・石灰化・ステント等)の追加フォームと一覧。
 *
 * 配置フロー: 「位置を選択」ボタンで3Dビュー上に中心線グラフのノード(起始部・分岐点・
 * 端点)をクリック可能なマーカーとして表示させ、ユーザーがいずれかをクリックすると
 * その枝(本幹/側枝)と位置が確定する。以後は「近位側/遠位側」ボタンでその枝に沿って
 * 位置を微調整でき、枝の端(次の分岐点)に達すると分岐先の候補を選ぶボタンが現れる。
 * 位置が決まったらプレビュー(半透明の簡易円筒、store.previewObject経由でModelLoaderが
 * 描画)で確認し、「オブジェクトを追加」で確定する。
 */
export function ObjectPanel() {
  const objects = useCardioStore((s) => s.objects);
  const addObject = useCardioStore((s) => s.addObject);
  const updateObject = useCardioStore((s) => s.updateObject);
  const removeObject = useCardioStore((s) => s.removeObject);
  const pendingObjectPosition = useCardioStore((s) => s.pendingObjectPosition);
  const setPendingObjectPosition = useCardioStore((s) => s.setPendingObjectPosition);
  const setPreviewObject = useCardioStore((s) => s.setPreviewObject);
  const editingObjectId = useCardioStore((s) => s.editingObjectId);
  const setEditingObjectId = useCardioStore((s) => s.setEditingObjectId);
  const pickingObjectVessel = useCardioStore((s) => s.pickingObjectVessel);
  const setPickingObjectVessel = useCardioStore((s) => s.setPickingObjectVessel);

  const [type, setType] = useState<ObjectType>("stenosis");
  const [vesselId, setVesselId] = useState<VesselId>("RCA");
  const [branchId, setBranchId] = useState<string | null>(null);
  const [positionPercent, setPositionPercent] = useState(50);
  const [lengthPercent, setLengthPercent] = useState(8);
  const [severity, setSeverity] = useState(70);
  const [thickness, setThickness] = useState(40);
  const [angleSpan, setAngleSpan] = useState(120);
  const [orientation, setOrientation] = useState(0);
  const [diameter, setDiameter] = useState(3);
  const [forkChoice, setForkChoice] = useState<ForkChoice | null>(null);

  const graph = useMemo(() => getVesselGraph(vesselId), [vesselId]);
  const currentBranch = branchId ? getBranch(graph, branchId) : undefined;

  // 3Dビューでノードをクリックして位置が渡されたら、フォームへ事前入力する。
  useEffect(() => {
    if (!pendingObjectPosition) return;
    setVesselId(pendingObjectPosition.vesselId);
    setBranchId(pendingObjectPosition.branchId);
    setPositionPercent(Math.round(pendingObjectPosition.position * 100));
    setForkChoice(null);
  }, [pendingObjectPosition]);

  // 枝が決まっている間、3Dビューにライブプレビュー(簡易円筒)を表示する。
  // まだ枝が決まっていない(ノードを選んでいない)間はプレビューを出さない。
  useEffect(() => {
    if (!branchId) {
      setPreviewObject(null);
      return;
    }
    setPreviewObject({
      vesselId,
      branchId,
      position: positionPercent / 100,
      length: Math.max(lengthPercent, 1) / 100,
    });
    return () => setPreviewObject(null);
  }, [vesselId, branchId, positionPercent, lengthPercent, setPreviewObject]);

  function handleVesselChange(next: VesselId) {
    setVesselId(next);
    setBranchId(null);
    setForkChoice(null);
    if (pickingObjectVessel) setPickingObjectVessel(next);
  }

  function startPicking() {
    setForkChoice(null);
    setPickingObjectVessel(vesselId);
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
      addObject({ ...base, type: "stenosis", severity });
    } else if (type === "calcification") {
      addObject({ ...base, type: "calcification", thickness, angleSpan, orientation });
    } else {
      addObject({ ...base, type: "stent", diameter });
    }
    setPendingObjectPosition(null);
    setBranchId(null);
    setForkChoice(null);
  }

  return (
    <CollapsibleSection title="オブジェクト(β)" defaultOpen>
      <h3 className="panel-subheading">追加</h3>
      <p className="panel-note">
        「位置を選択」ボタンで3Dビュー上にノード(分岐点・端点)を表示し、いずれかを
        クリックして起点を決めてください。決まったら下のボタンで枝に沿って微調整し、
        プレビュー(水色の半透明な円筒)で確認してから「オブジェクトを追加」で確定します。
      </p>

      <div className="object-form">
        <label className="object-form-row">
          種類
          <select value={type} onChange={(e) => setType(e.target.value as ObjectType)}>
            <option value="stenosis">狭窄</option>
            <option value="calcification">石灰化プラーク</option>
            <option value="stent">ステント</option>
          </select>
        </label>
        <label className="object-form-row">
          追加先の血管
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
            <p className="panel-note object-click-hint">
              👉 「位置を選択」を押してから、3Dビューで{VESSEL_LABELS[vesselId]}のノードをクリックしてください。
            </p>
            <button type="button" onClick={startPicking}>
              {pickingObjectVessel === vesselId ? "🎯 ノードをクリックしてください…" : "📍 位置を選択"}
            </button>
          </>
        )}

        {branchId && currentBranch && !forkChoice && (
          <>
            <p className="panel-note object-segment-hint">枝: {currentBranch.label}</p>
            <div className="object-fine-tune-row">
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
          <div className="object-fork-choice">
            <p className="panel-note">分岐点です。進む先を選んでください:</p>
            {forkChoice.options.map((option) => (
              <button key={option.id} type="button" onClick={() => chooseFork(option)}>
                {option.label}
              </button>
            ))}
          </div>
        )}

        <label className="object-form-row">
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
        {type === "stenosis" && (
          <label className="object-form-row">
            狭窄率
            <input
              type="range"
              min={0}
              max={99}
              step={1}
              value={severity}
              onChange={(e) => setSeverity(Number(e.target.value))}
            />
            <span className="opacity-value">{severity}%</span>
          </label>
        )}
        {type === "calcification" && (
          <>
            <label className="object-form-row">
              厚み(血管半径比)
              <input
                type="range"
                min={0}
                max={150}
                step={5}
                value={thickness}
                onChange={(e) => setThickness(Number(e.target.value))}
              />
              <span className="opacity-value">{thickness}%</span>
            </label>
            <label className="object-form-row">
              角度(円周方向の広がり)
              <input
                type="range"
                min={0}
                max={360}
                step={5}
                value={angleSpan}
                onChange={(e) => setAngleSpan(Number(e.target.value))}
              />
              <span className="opacity-value">{angleSpan}°</span>
            </label>
            <label className="object-form-row">
              向き(0=心筋側、180=心外膜側)
              <input
                type="range"
                min={0}
                max={360}
                step={5}
                value={orientation}
                onChange={(e) => setOrientation(Number(e.target.value))}
              />
              <span className="opacity-value">{orientation}°</span>
            </label>
          </>
        )}
        {type === "stent" && (
          <label className="object-form-row">
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
          オブジェクトを追加
        </button>
      </div>

      {objects.length > 0 && (
        <>
          <hr className="panel-divider" />
          <h3 className="panel-subheading">登録済み ({objects.length})</h3>
          <ul className="object-list">
            {objects.map((object) => (
              <ObjectListItem
                key={object.id}
                object={object}
                isEditing={editingObjectId === object.id}
                onUpdate={(patch) => updateObject(object.id, patch)}
                onRemove={() => {
                  if (editingObjectId === object.id) setEditingObjectId(null);
                  removeObject(object.id);
                }}
                onStartReposition={() => setEditingObjectId(object.id)}
                onCancelReposition={() => setEditingObjectId(null)}
              />
            ))}
          </ul>
        </>
      )}
    </CollapsibleSection>
  );
}

function ObjectListItem({
  object,
  isEditing,
  onUpdate,
  onRemove,
  onStartReposition,
  onCancelReposition,
}: {
  object: CardioObject;
  isEditing: boolean;
  onUpdate: (patch: Partial<CardioObject>) => void;
  onRemove: () => void;
  onStartReposition: () => void;
  onCancelReposition: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [forkChoice, setForkChoice] = useState<ForkChoice | null>(null);
  const graph = useMemo(() => getVesselGraph(object.vesselId), [object.vesselId]);
  const branch = getBranch(graph, object.branchId);

  function nudge(delta: number) {
    if (!branch) return;
    const fork = findForkOnNudge(graph, branch, object.position * 100, delta);
    if (fork) {
      onUpdate({ position: fork.snapPercent / 100 });
      setForkChoice(fork);
      return;
    }
    onUpdate({ position: Math.min(1, Math.max(0, (object.position * 100 + delta) / 100)) });
  }

  function chooseFork(nextBranch: CenterlineBranch) {
    onUpdate({ branchId: nextBranch.id, position: nextBranch.startNodeId === forkChoice?.nodeId ? 0 : 1 });
    setForkChoice(null);
  }

  return (
    <li className={`object-item${isEditing ? " object-item-editing" : ""}`}>
      <div className="object-item-summary" onClick={() => setExpanded((v) => !v)}>
        <span className="object-item-chevron" aria-hidden="true">
          {expanded ? "▼" : "▶"}
        </span>
        <span className="object-type-icon" aria-hidden="true">
          {TYPE_ICONS[object.type]}
        </span>
        <span className="object-item-title">
          {VESSEL_LABELS[object.vesselId]} - {TYPE_LABELS[object.type]}
        </span>
        <span className="object-position-display">
          {branch?.label ?? object.branchId} {Math.round(object.position * 100)}%
        </span>
        <label className="object-visible-toggle" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={object.visible}
            onChange={(e) => onUpdate({ visible: e.target.checked })}
          />
          表示
        </label>
        <button
          type="button"
          className="object-remove-button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="削除"
        >
          削除
        </button>
      </div>

      {expanded && (
        <div className="object-item-details">
          <div className="object-item-controls">
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
          </div>

          <label className="object-item-size-row">
            長さ
            <input
              type="range"
              min={2}
              max={30}
              step={1}
              value={Math.round(object.length * 100)}
              onChange={(e) => onUpdate({ length: Number(e.target.value) / 100 })}
            />
            <span className="opacity-value">{Math.round(object.length * 100)}%</span>
          </label>

          {object.type === "stenosis" && (
            <label className="object-item-size-row">
              重症度
              <input
                type="range"
                min={0}
                max={99}
                step={1}
                value={object.severity}
                onChange={(e) => onUpdate({ severity: Number(e.target.value) })}
              />
              <span className="opacity-value">{object.severity}%</span>
            </label>
          )}
          {object.type === "calcification" && (
            <>
              <label className="object-item-size-row">
                厚み
                <input
                  type="range"
                  min={0}
                  max={150}
                  step={5}
                  value={object.thickness}
                  onChange={(e) => onUpdate({ thickness: Number(e.target.value) })}
                />
                <span className="opacity-value">{object.thickness}%</span>
              </label>
              <label className="object-item-size-row">
                角度
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={object.angleSpan}
                  onChange={(e) => onUpdate({ angleSpan: Number(e.target.value) })}
                />
                <span className="opacity-value">{object.angleSpan}°</span>
              </label>
              <label className="object-item-size-row">
                向き
                <input
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={object.orientation}
                  onChange={(e) => onUpdate({ orientation: Number(e.target.value) })}
                />
                <span className="opacity-value">{object.orientation}°</span>
              </label>
            </>
          )}
          {object.type === "stent" && (
            <label className="object-item-size-row">
              径
              <input
                type="number"
                min={1}
                max={6}
                step={0.25}
                value={object.diameter}
                onChange={(e) => onUpdate({ diameter: Number(e.target.value) })}
              />
              mm
            </label>
          )}

          {forkChoice && (
            <div className="object-fork-choice">
              <p className="panel-note">分岐点です。進む先を選んでください:</p>
              {forkChoice.options.map((option) => (
                <button key={option.id} type="button" onClick={() => chooseFork(option)}>
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {isEditing && (
            <p className="panel-note object-click-hint">
              👉 3Dビューで{VESSEL_LABELS[object.vesselId]}のノードをクリックして新しい位置を指定してください。
            </p>
          )}
        </div>
      )}
    </li>
  );
}
