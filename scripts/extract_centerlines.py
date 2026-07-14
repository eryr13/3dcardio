"""
血管(RCA/LAD/LCX)の中心線をpublic/models/heart-realistic.glbのメッシュ形状から直接抽出し、
public/models/centerlines.jsonとして出力するオフライン前処理スクリプト。

## 背景
これまでWebアプリ側(src/components/models/vesselCenterline.ts)は、メッシュ頂点を
ローカルY座標でビン分割し、各ビンの頂点重心を中心線点とする「Yビン方式」の
ヒューリスティックを使っていた。この方式は血管がY軸方向におおむね直進していることを
前提とするため、RCAのように房室溝に沿って心臓表面を大きく回り込む血管では、
同一Yスライスに血管の往路・復路など空間的に無関係な頂点が混在し、それらの平均が
血管の存在しない空間に出現するという致命的な破綻が実機検証で確認された。

## このスクリプトの方式
血管の走行方向に一切依存しない、3次元形状ベースのスケルトン化を採用する。
1. メッシュをボクセル化し、内部を充填する(表面殻ではなく実体のボクセル集合にする)
2. skimage.morphology.skeletonize で1ボクセル幅の骨格を抽出
3. 骨格ボクセルを26近傍グラフ化し、次数1のノード(端点)・次数3以上のノード(分岐点)を検出
4. 近位端点(ワールドY座標が最大の端点)を起点とし、そこから最も物理長が長くなる
   端点までの最短経路を「本幹」として採用する(側枝は自然に経路から除外される)
5. 本幹経路を弧長ベースで等間隔に再サンプリングし、各点の半径をボクセルマスクの
   距離変換(distance_transform_edt)から推定する
6. 座標変換は一切行わない(GLBから直接ロードしたメッシュそのものをボクセル化しているため、
   血管メッシュの実際の描画座標と中心線データの座標系は自動的に一致する)

## 実行方法
このリポジトリ直下に用意した .venv-centerline (numpy/scipy/scikit-image/trimesh/networkx)
を有効化してから実行する:
    source .venv-centerline/Scripts/activate  # Windows Git Bash
    python scripts/extract_centerlines.py
"""

import json
import time

import networkx as nx
import numpy as np
import trimesh
from scipy import ndimage
from skimage.morphology import skeletonize

GLB_PATH = "public/models/heart-realistic.glb"
OUTPUT_PATH = "src/data/centerlines.json"
VESSEL_IDS = ["RCA", "LAD", "LCX"]
TARGET_VOXEL_RESOLUTION = 220  # 最長辺方向のボクセル数の目安
OUTPUT_SAMPLES = 100  # sampleCenterline側が期待する既存のsamples=100に合わせる


def build_skeleton_graph(skeleton: np.ndarray) -> nx.Graph:
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
                dist = np.sqrt(dx * dx + dy * dy + dz * dz)
                graph.add_edge(i, j, weight=dist)
    return graph, coords


def extract_main_trunk(graph: nx.Graph, coords: np.ndarray, world_points: np.ndarray) -> list[int]:
    """
    次数1のノード(端点)のうち、ワールドY座標が最大のものを近位端点として採用し、
    そこから物理距離が最長になる端点までの最短経路を本幹とする。
    (最も枝が長い経路 = 本幹、という血管樹解析での一般的な発見的手法。
    側枝は近位端点から見れば本幹より短い経路になるため、自然に除外される。)
    """
    # 骨格が複数の連結成分に分かれることがある(ボクセル化・充填の精度限界による細切れ)ため、
    # 最大の連結成分だけを使う。
    components = list(nx.connected_components(graph))
    largest = max(components, key=len)
    sub = graph.subgraph(largest).copy()

    degrees = dict(sub.degree())
    endpoints = [n for n, d in degrees.items() if d == 1]
    if len(endpoints) < 2:
        # 稀に閉ループ状になり端点が出ない場合は、最も離れた2点を両端とみなす。
        nodes = list(sub.nodes())
        endpoints = [nodes[0], nodes[-1]]

    proximal = max(endpoints, key=lambda n: world_points[n][1])

    lengths = nx.single_source_dijkstra_path_length(sub, proximal, weight="weight")
    distal = max((n for n in endpoints if n != proximal), key=lambda n: lengths.get(n, -1))

    path = nx.dijkstra_path(sub, proximal, distal, weight="weight")
    return path


def resample_by_arc_length(points: np.ndarray, radii: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """点列を弧長ベースで n 点に等間隔再サンプリングし、正規化弧長 t も返す。"""
    deltas = np.linalg.norm(np.diff(points, axis=0), axis=1)
    cumulative = np.concatenate([[0], np.cumsum(deltas)])
    total = cumulative[-1] if cumulative[-1] > 0 else 1.0
    targets = np.linspace(0, total, n)

    resampled_points = np.empty((n, 3))
    resampled_radii = np.empty(n)
    for axis in range(3):
        resampled_points[:, axis] = np.interp(targets, cumulative, points[:, axis])
    resampled_radii = np.interp(targets, cumulative, radii)
    t = targets / total
    return resampled_points, resampled_radii, t


def process_vessel(scene: trimesh.Scene, vessel_id: str) -> list[dict]:
    print(f"--- {vessel_id} ---")
    t_start = time.time()
    geometry_key = scene.graph[vessel_id][1]
    mesh = scene.geometry[geometry_key]
    print(f"  vertices={len(mesh.vertices)} watertight={mesh.is_watertight} extents={mesh.extents}")

    pitch = mesh.extents.max() / TARGET_VOXEL_RESOLUTION
    voxel_grid = mesh.voxelized(pitch).fill()
    filled = voxel_grid.matrix
    print(f"  pitch={pitch:.5f} grid_shape={filled.shape} filled_voxels={filled.sum()}")

    skeleton = skeletonize(filled)
    print(f"  skeleton_voxels={skeleton.sum()}")

    graph, coords = build_skeleton_graph(skeleton)
    world_points = voxel_grid.indices_to_points(coords)

    path_node_indices = extract_main_trunk(graph, coords, world_points)
    path_points = world_points[path_node_indices]
    print(f"  main_trunk_voxels={len(path_node_indices)}")

    # 半径推定: 充填済みボクセルマスクの距離変換(ボクセル単位)をワールド単位に換算し、
    # 中心線の各ボクセル位置でサンプリングする。
    distance_voxels = ndimage.distance_transform_edt(filled)
    path_coords = coords[path_node_indices]
    radii_voxels = distance_voxels[path_coords[:, 0], path_coords[:, 1], path_coords[:, 2]]
    radii_world = radii_voxels * pitch

    resampled_points, resampled_radii, t = resample_by_arc_length(path_points, radii_world, OUTPUT_SAMPLES)

    # 近位(t=0)がワールドY最大側になるよう向きを揃える(既存のCenterlinePoint.tの規約に合わせる)。
    if resampled_points[0][1] < resampled_points[-1][1]:
        resampled_points = resampled_points[::-1]
        resampled_radii = resampled_radii[::-1]

    elapsed = time.time() - t_start
    print(f"  done in {elapsed:.1f}s, radius range=[{resampled_radii.min():.4f}, {resampled_radii.max():.4f}]")

    return [
        {
            "position": resampled_points[i].tolist(),
            "radius": float(resampled_radii[i]),
            "t": float(t[i]),
        }
        for i in range(OUTPUT_SAMPLES)
    ]


def main():
    scene = trimesh.load(GLB_PATH)
    result = {vessel_id: process_vessel(scene, vessel_id) for vessel_id in VESSEL_IDS}
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f)
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
