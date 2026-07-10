# 3D Cardio Viewer (Phase 1)

心臓・冠動脈の3Dモデルをブラウザ上で操作しながら血管構造を理解するための教育・解析ツール。
Phase 1 では「3Dビューアの基本操作」のみを実装している(実解剖メッシュ表示・断面表示・カメラ操作・レイアウトの土台)。

## セットアップ

```bash
npm install
npm run dev
```

`http://localhost:5173`(使用中の場合は別ポート)をブラウザで開く。

その他のコマンド:

```bash
npm run build   # 型チェック + 本番ビルド
npm run lint    # oxlint
npm run preview # ビルド成果物のプレビュー
```

## Phase 1 の機能

- 実解剖3Dモデル(`public/models/heart-realistic.glb`。出典・ライセンスは下記「3Dモデルの出典」参照)
  - 心臓壁メッシュ(`name="HEART"`)
  - 冠動脈メッシュ3本(`name="RCA" | "LAD" | "LCX"`)
  - `ModelSource` を `{ type: "placeholder" }` に切り替えれば、従来の幾何学プレースホルダー(楕円体+チューブ)にも戻せる
- カメラ操作: ドラッグで回転・パン・ホイールでズーム(OrbitControls)、「視点をリセット」ボタン
- 断面表示: サイドパネルのX/Y/Z軸チェックボックス+スライダーでクリッピング平面を移動
- レイアウト: 左サイドパネル(カメラ操作・断面表示・表示オブジェクトの一覧/表示切替) + 中央3Dビューア

## 3Dモデルの出典

`public/models/heart-realistic.glb` は [BodyParts3D/Anatomography](http://lifesciencedb.jp/bp3d/)
(ライフサイエンス統合データベースセンター, DBCLS 提供)の実測解剖データ
(Rel. 3.0, 2011-09-15, ポリゴン削減版)から、心臓壁(FMA7274)と右冠動脈幹+辺縁枝+後下行枝
(FMA3802 / FMA3818 / FMA3840nsn)、左前下行枝(FMA3862nsn)、左回旋枝(FMA3895)のSTLファイルを
[GitHubミラー](https://github.com/Kevin-Mattheus-Moerman/BodyParts3D)から取得し、共通座標系を保った
まま結合・Y-upへの軸変換・スケール調整・心臓壁のみ簡略化(約33万→約4.5万三角形)した上で、
`HEART`/`RCA`/`LAD`/`LCX`という名前を付けて単一のGLBとしてエクスポートしたもの。

ライセンスは **Creative Commons Attribution-Share Alike 2.1 Japan**。利用時は
"BodyParts3D, (c) The Database Center for Life Science licensed under CC Attribution-Share Alike 2.1 Japan"
の表記が必要(詳細: http://dbarchive.biosciencedbc.jp/en/bodyparts3d/lic.html)。GLB生成に使ったスクリプトは
このリポジトリには含めていない(STLの一時ダウンロードのみに使う一回限りのビルドスクリプトのため)。

## セグメント単位の色分け(β)

サイドパネルの「セグメント単位で色分け(β)」をONにすると、RCA/LAD/LCXの各メッシュを幹の
長さ方向に沿って3分割し(近位/中間/遠位)、区間ごとに色・不透明度を個別設定できる。3D表示上で
血管にカーソルを合わせるとセグメント名がツールチップ表示される。

**区切り位置は幹の長さに沿った機械的な等分割であり、実際のAHA分類(#1〜#15など)の解剖学的
ランドマークとは一致しない。** セグメント名の番号(#1, #6, #11 など)はAHA分類の番号に寄せた
仮のラベルであり、臨床的な精度は保証しない。正確なセグメント境界が必要な場合は、実際の解剖学的
ランドマークに基づいてメッシュを分割し直す必要がある。

サイドパネルの「色・不透明度をリセット」ボタンで、心臓・冠動脈(セグメントモード時はセグメント
単位)の色と不透明度を初期値に戻せる。表示/非表示やクリッピング設定はリセット対象外。

## フォルダ構成

```
src/
├── main.tsx, App.tsx, App.css, index.css   # エントリポイントと全体レイアウト
├── types/
│   └── anatomy.ts          # 血管ID・表示状態・クリッピング状態・カメラ状態などの型
├── store/
│   └── useCardioStore.ts   # zustandストア(心臓/血管の表示状態、断面位置、カメラ姿勢)
├── components/
│   ├── viewer/
│   │   ├── Scene.tsx            # <Canvas>、ライト、各コンポーネントの配置
│   │   ├── CameraRig.tsx        # OrbitControls、視点リセット、カメラ姿勢のstore同期
│   │   └── ClippingPlanes.tsx   # store上のクリッピング状態をrendererに適用
│   ├── models/
│   │   ├── ModelLoader.tsx      # モデル読み込みの差し替え可能なエントリポイント
│   │   ├── HeartModel.tsx       # 心臓プレースホルダー(楕円体)
│   │   ├── VesselModel.tsx      # 血管プレースホルダー(チューブ、id/color/opacity対応)
│   │   └── vesselPaths.ts       # RCA/LAD/LCXの仮の経路(制御点)定義
│   └── ui/
│       ├── SidePanel.tsx        # サイドパネル全体のレイアウト
│       ├── ViewControls.tsx     # 視点リセットボタン
│       ├── ClippingControls.tsx # X/Y/Z断面スライダー
│       └── AnatomyLegend.tsx    # 心臓/血管の表示・非表示トグル(色分けはPhase 2)
└── utils/
    └── cArmAngles.ts        # カメラ姿勢→C-arm角度(LAO/RAO, CRA/CAUD)変換の将来用スタブ
```

## 将来の拡張に向けた設計メモ

- **心臓・血管オブジェクトの独立性**: 心臓(`HeartState`)と各血管(`VesselState`)は
  `useCardioStore` 内でそれぞれ独立したエントリとして管理しており、`visible` /
  `color` / `opacity` を個別に持つ。血管をセグメント分割する場合も同じ形の
  state を増やすだけで対応できる。
- **モデル読み込みの差し替え**: `components/models/ModelLoader.tsx` の
  `AnatomyModels` が唯一の読み込みエントリポイント。デフォルトは
  `{ type: "gltf", url: "/models/heart-realistic.glb" }` で実解剖メッシュを
  読み込み、ノード名(`HEART`/`RCA`/`LAD`/`LCX`)を頼りに store の表示状態
  (`visible`/`color`/`opacity`)をマテリアルへ反映している。`{ type:
  "placeholder" }` を渡せば従来の幾何学プレースホルダーにも戻せる。DICOM由来の
  実メッシュに差し替える場合も、同じ命名規則のGLB/GLTFを用意して `url` を
  変えるだけでよい。
- **カメラ→C-arm角度変換**: `CameraRig` はカメラの `position` /
  `quaternion` を操作のたびに `useCardioStore` に同期している。
  `utils/cArmAngles.ts` に変換関数のスタブを用意してあるので、患者座標系が
  導入され次第、実装を追加すればPCI向けのLAO/RAO・CRA/CAUD表示に接続できる。
- **断面表示**: `ClippingPlanes.tsx` は `renderer.clippingPlanes`
  (グローバルクリッピング)を使っており、心臓・血管どちらのメッシュにも
  自動的に適用される。将来メッシュを差し替えても変更不要。
