import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import { computeHeartbeatTransform, getElapsedActiveSeconds } from "../../utils/heartbeatAnimation";

interface HeartbeatGroupProps {
  children: React.ReactNode;
  /** マウント時に自身の <group> を渡すコールバック(書き出し処理からscaleを直接操作するために使う) */
  onMount?: (group: Group) => void;
}

/**
 * 心臓・血管全体に周期的な拍動スケールを適用する共通ラッパー。
 * メインビュー(ModelLoader.tsx)とシネビュー(CineAnatomyModel.tsx)の両方でこれを使うことで、
 * 2つの独立した Canvas(それぞれ自前の THREE.Clock を持つ)でも store 由来の同じ経過秒数から
 * 同じ scale を計算するため、常に同位相で拍動する。
 * cine.exporting が true の間は自動更新を止め、書き出しループが scale を直接制御できるようにする。
 */
export function HeartbeatGroup({ children, onMount }: HeartbeatGroupProps) {
  const groupRef = useRef<Group>(null);
  const lastAppliedAtRef = useRef(0);

  useEffect(() => {
    if (groupRef.current) onMount?.(groupRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const { cine } = useCardioStore.getState();
    if (cine.exporting) return;

    const elapsed = getElapsedActiveSeconds(cine);
    // fps に応じて更新を間引き、シネ再生のコマ落ち感を演出する
    const minInterval = 1 / cine.fps;
    if (elapsed - lastAppliedAtRef.current < minInterval) return;
    lastAppliedAtRef.current = elapsed;

    const transform = computeHeartbeatTransform(elapsed);
    group.scale.set(...transform.scale);
    group.rotation.y = transform.twistY;
  });

  return <group ref={groupRef}>{children}</group>;
}
