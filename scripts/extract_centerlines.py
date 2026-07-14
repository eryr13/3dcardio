"""
血管(RCA/LAD/LCX)の中心線グラフをpublic/models/heart-realistic.glbのメッシュ形状から
直接抽出し、src/data/centerlines.jsonとして出力するオフライン前処理スクリプト。

## 方式
1. メッシュをボクセル化して内部を充填し、skimage.morphology.skeletonize で
   1ボクセル幅の骨格を抽出する(血管の走行方向に一切依存しない3D形状ベースの手法)
2. 骨格ボクセルを26近傍グラフ化し、ノイズによる微小な枝(スパー)を除去する
3. 次数1(端点)・次数3以上(分岐点)のノードを「臨界ノード」とし、臨界ノード間を
   結ぶ生の枝(edge)へグラフを圧縮する
4. 起始部(ワールドY最大の端点)を根とし、各分岐点で「進入方向との角度(直進性)を
   主基準、隣接候補との相対的な太さを副基準」とした組み合わせスコアで本幹側の
   子枝を選び、本幹を1本の連続経路として抽出する。本幹から外れた側枝も同じ基準で
   再帰的に1本の経路へ単純化し、「{血管}側枝N」として発見順に命名する
5. 座標変換は一切行わない(GLBから直接ロードしたメッシュそのものをボクセル化して
   いるため、血管メッシュの実際の描画座標と中心線データの座標系は自動的に一致する)

## 出力形式(血管ごと)
- nodes: 臨界ノード(起始部・分岐点・端点)の一覧
- edges: 臨界ノード間を結ぶ生の枝(骨格そのまま、Phase 8等で木構造が必要な場合用)
- branches: 本幹・側枝を弧長で再パラメータ化した名前付き経路(病変配置・描画で使う)

## 実行方法
    source .venv-centerline/Scripts/activate  # Windows Git Bash
    python scripts/extract_centerlines.py
"""

import json
import time
from collections import deque

import networkx as nx
import numpy as np
import trimesh
from scipy import ndimage
from skimage.morphology import skeletonize

GLB_PATH = "public/models/heart-realistic.glb"
OUTPUT_PATH = "src/data/centerlines.json"
VESSEL_IDS = ["RCA", "LAD", "LCX"]
TARGET_VOXEL_RESOLUTION = 220  # 最長辺方向のボクセル数の目安
OUTPUT_SAMPLES = 40  # 名前付き経路(branch)ごとの再サンプリング点数
MIN_SPUR_HOPS = 15  # この近傍ホップ数未満の端点スパーはノイズとして除去
MIN_MERGE_HOPS = 15  # 分岐点同士を結ぶ、この近傍ホップ数未満の内部枝はノードを統合する
MIN_BRANCH_LENGTH_RATIO = 0.06  # 血管全体のボクセル対角長に対する比率未満の側枝は出力しない
ANGLE_WEIGHT = 0.7
RADIUS_WEIGHT = 0.3
DEBUG_SCORING = False


def build_skeleton_graph(skeleton: np.ndarray) -> tuple[nx.Graph, np.ndarray]:
    """26近傍で隣接する骨格ボクセル同士をエッジで結んだグラフを作る。"""
    coords = np.argwhere(skeleton)
    index_of = {tuple(c): i for i, c in enumerate(coords)}
    graph = nx.Graph()
    graph.add_nodes_from(range(len(coords)))
    offsets = [
        (dx, dy, dz)
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        for dz in (-1, 0, 1)
        if not (dx == 0 and dy == 0 and dz == 0)
    ]
    for i, c in enumerate(coords):
        c = tuple(c)
        for dx, dy, dz in offsets:
            neighbor = (c[0] + dx, c[1] + dy, c[2] + dz)
            j = index_of.get(neighbor)
            if j is not None and j > i:
                graph.add_edge(i, j)
    return graph, coords


def prune_short_spurs(graph: nx.Graph, min_hops: int) -> None:
    """
    端点(次数1)から分岐点まで辿り、ホップ数がmin_hops未満のスパーを除去する。
    骨格化・充填の精度限界による微小なノイズ枝を、実際の側枝と区別するための前処理。
    1回の除去で新たな短いスパーが生まれうる(分岐点の次数が下がるため)ため収束するまで繰り返す。
    """
    changed = True
    while changed:
        changed = False
        degrees = dict(graph.degree())
        leaves = [n for n, d in degrees.items() if d == 1]
        for leaf in leaves:
            if leaf not in graph:
                continue
            path = [leaf]
            prev, curr = None, leaf
            while True:
                neighbors = [x for x in graph.neighbors(curr) if x != prev]
                if graph.degree(curr) != 2 and curr != leaf:
                    break
                if not neighbors:
                    break
                nxt = neighbors[0]
                prev, curr = curr, nxt
                path.append(curr)
                if graph.degree(curr) != 2:
                    break
            if len(path) - 1 < min_hops and curr != leaf and graph.degree(curr) >= 3:
                graph.remove_nodes_from(path[:-1])
                changed = True


def merge_short_internal_edges(graph: nx.Graph, min_hops: int) -> nx.Graph:
    """
    2つの分岐点(次数3以上)同士を直接結ぶ、ホップ数がmin_hops未満の内部枝を統合する。
    骨格化の精度限界により、本来1つであるべき分岐点が至近距離に複数のノイズ的な
    分岐点として現れることがある(実機検証で確認: 単純な端点スパー除去だけでは
    ノード数がほとんど減らず、分岐点が密集したまま側枝が20本以上に水増しされていた)。
    このような「分岐点同士を結ぶ短い橋」を1つのノードへ縮約することで、
    本来のバラバラした位置情報を保ったまま、分岐点の密集を実際の解剖学的な
    分岐点の数に近づける。
    """
    changed = True
    while changed:
        changed = False
        critical, raw_edges = collapse_to_topology(graph)
        degrees = dict(graph.degree())
        for e in raw_edges:
            a, b = e["start"], e["end"]
            if a == b:
                continue
            if degrees.get(a, 0) >= 3 and degrees.get(b, 0) >= 3 and (len(e["path"]) - 1) < min_hops:
                graph = nx.contracted_nodes(graph, a, b, self_loops=False)
                changed = True
                break
    return graph


def collapse_to_topology(graph: nx.Graph) -> tuple[set[int], list[dict]]:
    """次数1・次数3以上の「臨界ノード」を検出し、その間を結ぶ生の枝へ圧縮する。"""
    degrees = dict(graph.degree())
    critical = {n for n, d in degrees.items() if d != 2}
    if not critical:
        nodes = list(graph.nodes())
        critical = {nodes[0], nodes[-1]}

    visited_directed: set[tuple[int, int]] = set()
    raw_edges: list[dict] = []
    for c in critical:
        for n in graph.neighbors(c):
            if (c, n) in visited_directed:
                continue
            path = [c, n]
            prev, curr = c, n
            while curr not in critical:
                neighbors = [x for x in graph.neighbors(curr) if x != prev]
                if not neighbors:
                    break
                nxt = neighbors[0]
                prev, curr = curr, nxt
                path.append(curr)
            visited_directed.add((c, n))
            if len(path) >= 2:
                visited_directed.add((path[-1], path[-2]))
            raw_edges.append({"start": c, "end": curr, "path": path})
    return critical, raw_edges


def build_tree(critical: set[int], raw_edges: list[dict], root: int) -> dict[int, list[tuple[int, int]]]:
    """根からのBFSで、各臨界ノードの子(edge_index, child_node)一覧を作る(閉路は自然に無視される)。"""
    adjacency: dict[int, list[tuple[int, int]]] = {c: [] for c in critical}
    for i, e in enumerate(raw_edges):
        adjacency[e["start"]].append((i, e["end"]))
        adjacency[e["end"]].append((i, e["start"]))

    tree_children: dict[int, list[tuple[int, int]]] = {}
    visited = {root}
    queue = deque([root])
    while queue:
        node = queue.popleft()
        for edge_idx, other in adjacency[node]:
            if other in visited:
                continue
            visited.add(other)
            tree_children.setdefault(node, []).append((edge_idx, other))
            queue.append(other)
    return tree_children


def edge_arc_length(edge: dict, world_points: np.ndarray) -> float:
    pts = world_points[edge["path"]]
    if len(pts) < 2:
        return 0.0
    return float(np.linalg.norm(np.diff(pts, axis=0), axis=1).sum())


def compute_subtree_lengths(
    root: int, tree_children: dict[int, list[tuple[int, int]]], raw_edges: list[dict], world_points: np.ndarray
) -> dict[int, float]:
    """
    各ノードについて、そこから下流(子孫方向)へ辿れる最長経路の長さを求める(木のDP、葉は0)。
    分岐点での「継続方向」判定に、局所的な角度だけでなく「この先どれだけ長く続くか」を
    考慮するために使う(角度だけの貪欲法は、局所的には尤もらしいが実際には行き止まりに
    近い方向を選んでしまうことがあった。実機検証で確認: RCAである分岐点で角度スコアの
    高い側を選んだ結果、本幹が心臓の房室溝沿いに続く長い経路ではなく短い枝で
    途切れてしまっていた)。
    """
    lengths: dict[int, float] = {}

    def visit(node: int) -> float:
        if node in lengths:
            return lengths[node]
        best = 0.0
        for edge_idx, child in tree_children.get(node, []):
            total = edge_arc_length(raw_edges[edge_idx], world_points) + visit(child)
            best = max(best, total)
        lengths[node] = best
        return best

    visit(root)
    return lengths


def oriented_points(
    edge: dict, from_node: int, world_points: np.ndarray, radii_world: np.ndarray
) -> tuple[list[np.ndarray], list[float]]:
    """生の枝の点列を、指定したノードを起点とする向きに揃えて返す。"""
    path = edge["path"] if edge["start"] == from_node else list(reversed(edge["path"]))
    points = [world_points[i] for i in path]
    radii = [float(radii_world[i]) for i in path]
    return points, radii


def compute_direction(points: list[np.ndarray], at_start: bool, n: int = 5) -> np.ndarray:
    """枝の始点付近(at_start=True)または終点付近の接線方向(単位ベクトル)を推定する。"""
    m = min(n, len(points) - 1)
    if m <= 0:
        return np.array([0.0, -1.0, 0.0])
    v = (points[m] - points[0]) if at_start else (points[-1] - points[-1 - m])
    norm = np.linalg.norm(v)
    return v / norm if norm > 1e-9 else np.array([0.0, -1.0, 0.0])


TIE_TOLERANCE_RATIO = 0.1  # 到達可能長がこの比率以内で並んでいる候補同士は角度・太さでタイブレークする


def score_children(
    incoming_dir: np.ndarray | None,
    children: list[tuple[int, int]],
    raw_edges: list[dict],
    current_node: int,
    world_points: np.ndarray,
    radii_world: np.ndarray,
    subtree_lengths: dict[int, float],
) -> list[tuple[int, int, float]]:
    """
    各子枝について、まず「そこから下流へどれだけ長く続くか(到達可能長)」を主基準とし、
    上位候補同士の到達可能長がTIE_TOLERANCE_RATIO以内で拮抗している場合に限り、
    進入方向との直進性(角度)・兄弟枝と比較した相対的な太さで順位を細かく決める。

    局所的な角度・太さだけの貪欲法は、見た目の直進性が高い側を選んでも実際には
    数ボクセルで途切れる行き止まりだった、というケースを本幹選定で誤ることが
    実機検証で確認された(RCAである分岐点で角度スコア0.96の側を選んだ結果、本幹が
    房室溝沿いに続く物理的に4倍以上長い経路ではなく短い枝で終わっていた)。
    「この先どれだけ長く続くか」を主基準にすることでこれを避け、角度・太さは
    到達可能長がほぼ同点の場合の細かい判定にのみ使う。
    """
    reach = []
    dirs = []
    radii_start = []
    for edge_idx, child_node in children:
        pts, rad = oriented_points(raw_edges[edge_idx], current_node, world_points, radii_world)
        edge_len = edge_arc_length(raw_edges[edge_idx], world_points)
        reach.append(edge_len + subtree_lengths.get(child_node, 0.0))
        dirs.append(compute_direction(pts, at_start=True))
        radii_start.append(rad[0])

    max_reach = max(reach) if reach else 1.0
    max_reach = max_reach if max_reach > 1e-9 else 1.0
    max_r = max(radii_start) if radii_start else 1.0
    max_r = max_r if max_r > 1e-9 else 1.0

    scored = []
    for (edge_idx, child_node), direction, r0, rc in zip(children, dirs, radii_start, reach):
        angle_score = 1.0 if incoming_dir is None else float(np.dot(incoming_dir, direction))
        radius_score = r0 / max_r
        reach_score = rc / max_reach
        tie_break = ANGLE_WEIGHT * ((angle_score + 1) / 2) + RADIUS_WEIGHT * radius_score
        # 到達可能長を粗い段階(TIE_TOLERANCE_RATIO刻み)に量子化して主基準にし、
        # 同じ段階内でのみ角度・太さのタイブレークが効くようにする。
        reach_tier = round(reach_score / TIE_TOLERANCE_RATIO)
        combined = reach_tier + tie_break * 1e-3
        scored.append((edge_idx, child_node, combined))
    scored.sort(key=lambda x: x[2], reverse=True)
    return scored


def walk_branch(
    start_node: int,
    incoming_dir: np.ndarray | None,
    tree_children: dict[int, list[tuple[int, int]]],
    raw_edges: list[dict],
    world_points: np.ndarray,
    radii_world: np.ndarray,
    subtree_lengths: dict[int, float],
) -> tuple[list[np.ndarray], list[float], list[int], list[float], list[tuple[int, np.ndarray, int, int]]]:
    """
    start_nodeから、各分岐点で最良スコアの子を選びながら1本の連続経路を辿る。
    選ばれなかった子は side_starts として返し、呼び出し側が別の名前付き経路として
    再帰的に処理する(側枝自身がさらに分岐する場合も同じ基準で単純化される)。

    node_pathに含まれる各ノードの累積弧長(waypoint_lengths)も一緒に返す。本幹は
    複数の分岐点を「通過点」として1本の連続経路に吸収するため、両端だけでなく
    経路の途中にある分岐点の位置も記録しておかないと、Webアプリ側で
    「本幹上を微調整していて分岐点に達したら側枝を選べるようにする」UIが
    途中の分岐点を検出できなくなる。
    """
    points = [world_points[start_node]]
    radii = [float(radii_world[start_node])]
    node_path = [start_node]
    waypoint_lengths = [0.0]
    side_starts: list[tuple[int, np.ndarray, int, int]] = []

    current = start_node
    current_incoming = incoming_dir
    cumulative = 0.0
    while True:
        children = tree_children.get(current, [])
        if not children:
            break
        if len(children) == 1:
            chosen_edge_idx, chosen_child = children[0]
        else:
            scored = score_children(
                current_incoming, children, raw_edges, current, world_points, radii_world, subtree_lengths
            )
            chosen_edge_idx, chosen_child, _ = scored[0]
            if DEBUG_SCORING:
                print(f"    branch@{current} incoming={current_incoming} candidates={scored}")
            for edge_idx, child_node, _ in scored[1:]:
                side_starts.append((current, current_incoming, edge_idx, child_node))

        pts, rad = oriented_points(raw_edges[chosen_edge_idx], current, world_points, radii_world)
        cumulative += edge_arc_length(raw_edges[chosen_edge_idx], world_points)
        points.extend(pts[1:])
        radii.extend(rad[1:])
        current_incoming = compute_direction(pts, at_start=False)
        current = chosen_child
        node_path.append(current)
        waypoint_lengths.append(cumulative)

    return points, radii, node_path, waypoint_lengths, side_starts


def resample_by_arc_length(
    points: np.ndarray, radii: np.ndarray, n: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """点列を弧長ベースで n 点に等間隔再サンプリングし、正規化弧長 t も返す。"""
    if len(points) == 1:
        points = np.vstack([points, points])
        radii = np.concatenate([radii, radii])
    deltas = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cumulative = np.concatenate([[0], np.cumsum(deltas)])
    total = cumulative[-1] if cumulative[-1] > 0 else 1.0
    targets = np.linspace(0, total, n)

    resampled_points = np.empty((n, 3))
    for axis in range(3):
        resampled_points[:, axis] = np.interp(targets, cumulative, points[:, axis])
    resampled_radii = np.interp(targets, cumulative, radii)
    t = targets / total
    return resampled_points, resampled_radii, t


def decompose_branches(
    root: int,
    tree_children: dict[int, list[tuple[int, int]]],
    raw_edges: list[dict],
    world_points: np.ndarray,
    radii_world: np.ndarray,
    vessel_id: str,
    node_id_of: dict[int, str],
    min_branch_length: float,
) -> list[dict]:
    branches = []

    def make_branch(
        branch_id: str,
        label: str,
        is_trunk: bool,
        node_path: list[int],
        waypoint_lengths: list[float],
        pts: list,
        rad: list,
    ) -> dict | None:
        pts_arr = np.array(pts)
        rad_arr = np.array(rad)
        total_length = float(np.linalg.norm(np.diff(pts_arr, axis=0), axis=1).sum()) if len(pts_arr) > 1 else 0.0
        if not is_trunk and total_length < min_branch_length:
            return None
        resampled_points, resampled_radii, t = resample_by_arc_length(pts_arr, rad_arr, OUTPUT_SAMPLES)
        norm = total_length if total_length > 0 else 1.0
        return {
            "id": branch_id,
            "label": label,
            "isMainTrunk": is_trunk,
            "startNodeId": node_id_of[node_path[0]],
            "endNodeId": node_id_of[node_path[-1]],
            "length": total_length,
            # 経路上のノード(両端+途中の分岐点)ごとの正規化位置。「本幹を微調整していて
            # 途中の分岐点に達したら側枝を選べるようにする」UIが、両端だけでなく
            # 途中の分岐点も検出できるようにするため。
            "waypoints": [
                {"nodeId": node_id_of[n], "t": wl / norm} for n, wl in zip(node_path, waypoint_lengths)
            ],
            "points": [
                {"position": resampled_points[i].tolist(), "radius": float(resampled_radii[i]), "t": float(t[i])}
                for i in range(OUTPUT_SAMPLES)
            ],
        }

    subtree_lengths = compute_subtree_lengths(root, tree_children, raw_edges, world_points)

    pts, rad, node_path, waypoint_lengths, sides = walk_branch(
        root, None, tree_children, raw_edges, world_points, radii_world, subtree_lengths
    )
    trunk = make_branch(f"{vessel_id}-main", f"{vessel_id}本幹", True, node_path, waypoint_lengths, pts, rad)
    branches.append(trunk)

    queue = deque(sides)
    side_index = 1
    while queue:
        parent_node, incoming, edge_idx, child_node = queue.popleft()
        pts0, rad0 = oriented_points(raw_edges[edge_idx], parent_node, world_points, radii_world)
        edge0_len = edge_arc_length(raw_edges[edge_idx], world_points)
        sub_incoming = compute_direction(pts0, at_start=False)
        pts, rad, node_path, sub_waypoint_lengths, sides = walk_branch(
            child_node, sub_incoming, tree_children, raw_edges, world_points, radii_world, subtree_lengths
        )
        full_pts = pts0 + pts[1:]
        full_rad = rad0 + rad[1:]
        full_node_path = [parent_node] + node_path
        full_waypoint_lengths = [0.0] + [edge0_len + wl for wl in sub_waypoint_lengths]
        label = f"{vessel_id}側枝{side_index}"
        branch = make_branch(
            f"{vessel_id}-side{side_index}", label, False, full_node_path, full_waypoint_lengths, full_pts, full_rad
        )
        if branch is not None:
            branches.append(branch)
            side_index += 1
        queue.extend(sides)

    return branches


def process_vessel(scene: trimesh.Scene, vessel_id: str) -> dict:
    print(f"--- {vessel_id} ---")
    t_start = time.time()
    geometry_key = scene.graph[vessel_id][1]
    mesh = scene.geometry[geometry_key]
    print(f"  vertices={len(mesh.vertices)} extents={mesh.extents}")

    pitch = mesh.extents.max() / TARGET_VOXEL_RESOLUTION
    voxel_grid = mesh.voxelized(pitch).fill()
    filled = voxel_grid.matrix
    print(f"  pitch={pitch:.5f} grid_shape={filled.shape} filled_voxels={filled.sum()}")

    skeleton = skeletonize(filled)
    graph, coords = build_skeleton_graph(skeleton)
    components = list(nx.connected_components(graph))
    largest = max(components, key=len)
    graph = graph.subgraph(largest).copy()
    print(f"  skeleton_voxels={skeleton.sum()} largest_component={len(largest)}")

    prune_short_spurs(graph, MIN_SPUR_HOPS)
    graph = merge_short_internal_edges(graph, MIN_MERGE_HOPS)
    prune_short_spurs(graph, MIN_SPUR_HOPS)
    print(f"  after cleanup: {graph.number_of_nodes()} voxels")

    distance_voxels = ndimage.distance_transform_edt(filled)
    radii_world = distance_voxels[coords[:, 0], coords[:, 1], coords[:, 2]] * pitch
    world_points = voxel_grid.indices_to_points(coords)

    critical, raw_edges = collapse_to_topology(graph)
    print(f"  critical_nodes={len(critical)} raw_edges={len(raw_edges)}")

    degrees = {n: graph.degree(n) for n in critical}
    endpoints = [n for n in critical if degrees[n] == 1]
    root = max(endpoints, key=lambda n: world_points[n][1])

    node_id_of = {n: f"{vessel_id}-n{i}" for i, n in enumerate(sorted(critical))}
    kind_of = {n: ("origin" if n == root else ("endpoint" if degrees[n] == 1 else "branch")) for n in critical}

    min_branch_length = float(np.linalg.norm(np.array(filled.shape) * pitch)) * MIN_BRANCH_LENGTH_RATIO

    tree_children = build_tree(critical, raw_edges, root)
    branches = decompose_branches(
        root, tree_children, raw_edges, world_points, radii_world, vessel_id, node_id_of, min_branch_length
    )

    nodes_out = [
        {"id": node_id_of[n], "position": world_points[n].tolist(), "kind": kind_of[n]} for n in critical
    ]
    edges_out = []
    for i, e in enumerate(raw_edges):
        points = [world_points[idx] for idx in e["path"]]
        radii = [float(radii_world[idx]) for idx in e["path"]]
        edges_out.append(
            {
                "id": f"{vessel_id}-e{i}",
                "startNodeId": node_id_of[e["start"]],
                "endNodeId": node_id_of[e["end"]],
                "points": [{"position": p.tolist(), "radius": r} for p, r in zip(points, radii)],
            }
        )

    elapsed = time.time() - t_start
    print(f"  branches={[b['label'] for b in branches]} done in {elapsed:.1f}s")

    return {"nodes": nodes_out, "edges": edges_out, "branches": branches, "rootNodeId": node_id_of[root]}


def main():
    scene = trimesh.load(GLB_PATH)
    result = {vessel_id: process_vessel(scene, vessel_id) for vessel_id in VESSEL_IDS}
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
