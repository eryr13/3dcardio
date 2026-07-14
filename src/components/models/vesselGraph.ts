import { Vector3 } from "three";
import type { VesselId } from "../../types/anatomy";
import centerlineGraphDataset from "../../data/centerlines.json";
import type { CenterlinePoint } from "./vesselCenterline";

export interface CenterlineNode {
  id: string;
  position: Vector3;
  kind: "origin" | "branch" | "endpoint";
}

export interface CenterlineEdge {
  id: string;
  startNodeId: string;
  endNodeId: string;
  points: { position: Vector3; radius: number }[];
}

/** 本幹または側枝1本分の、弧長で再パラメータ化された名前付き経路。既存のCenterlinePoint[]と同じ形。 */
export interface CenterlineBranch {
  id: string;
  label: string;
  isMainTrunk: boolean;
  startNodeId: string;
  endNodeId: string;
  /**
   * この枝が通過するノード(両端+途中の分岐点)の正規化位置。本幹は複数の分岐点を
   * 「通過点」として1本の経路に吸収しているため、両端だけでなく途中の分岐点も
   * ここに含まれる(位置の微調整UIが、途中の分岐点でも枝の選択肢を提示できるようにするため)。
   */
  waypoints: { nodeId: string; t: number }[];
  points: CenterlinePoint[];
}

export interface VesselGraph {
  nodes: CenterlineNode[];
  edges: CenterlineEdge[];
  branches: CenterlineBranch[];
  rootNodeId: string;
}

interface RawPoint {
  position: [number, number, number];
  radius: number;
}

interface RawCenterlinePoint extends RawPoint {
  t: number;
}

interface RawNode {
  id: string;
  position: [number, number, number];
  kind: "origin" | "branch" | "endpoint";
}

interface RawEdge {
  id: string;
  startNodeId: string;
  endNodeId: string;
  points: RawPoint[];
}

interface RawBranch {
  id: string;
  label: string;
  isMainTrunk: boolean;
  startNodeId: string;
  endNodeId: string;
  waypoints: { nodeId: string; t: number }[];
  points: RawCenterlinePoint[];
}

interface RawVesselGraph {
  nodes: RawNode[];
  edges: RawEdge[];
  branches: RawBranch[];
  rootNodeId: string;
}

const RAW_DATASET = centerlineGraphDataset as unknown as Record<VesselId, RawVesselGraph>;

const graphCache = new Map<VesselId, VesselGraph>();

function toVector3([x, y, z]: [number, number, number]): Vector3 {
  return new Vector3(x, y, z);
}

/**
 * 血管ごとの中心線グラフを取得する。scripts/extract_centerlines.py が生成した
 * src/data/centerlines.json (nodes/edges/branchesの3階層構造)を読み込むだけで、
 * 実行時の計算は行わない。詳細は同スクリプトのdocstring、および vesselCenterline.ts
 * の getVesselCenterline のコメント参照。
 */
export function getVesselGraph(vesselId: VesselId): VesselGraph {
  const cached = graphCache.get(vesselId);
  if (cached) return cached;

  const raw = RAW_DATASET[vesselId];
  const graph: VesselGraph = {
    rootNodeId: raw.rootNodeId,
    nodes: raw.nodes.map((n) => ({ id: n.id, position: toVector3(n.position), kind: n.kind })),
    edges: raw.edges.map((e) => ({
      id: e.id,
      startNodeId: e.startNodeId,
      endNodeId: e.endNodeId,
      points: e.points.map((p) => ({ position: toVector3(p.position), radius: p.radius })),
    })),
    branches: raw.branches.map((b) => ({
      id: b.id,
      label: b.label,
      isMainTrunk: b.isMainTrunk,
      startNodeId: b.startNodeId,
      endNodeId: b.endNodeId,
      waypoints: b.waypoints,
      points: b.points.map((p) => ({ position: toVector3(p.position), radius: p.radius, t: p.t })),
    })),
  };
  graphCache.set(vesselId, graph);
  return graph;
}

export function getBranch(graph: VesselGraph, branchId: string): CenterlineBranch | undefined {
  return graph.branches.find((b) => b.id === branchId);
}

export function getMainTrunk(graph: VesselGraph): CenterlineBranch {
  const trunk = graph.branches.find((b) => b.isMainTrunk);
  if (!trunk) throw new Error("vessel graph has no main trunk branch");
  return trunk;
}

/** 指定ノードを起点(startNodeId)または終点(endNodeId)とする枝の一覧(ノードクリックUIの分岐選択に使う)。 */
export function getBranchesAtNode(graph: VesselGraph, nodeId: string): CenterlineBranch[] {
  return graph.branches.filter((b) => b.startNodeId === nodeId || b.endNodeId === nodeId);
}
