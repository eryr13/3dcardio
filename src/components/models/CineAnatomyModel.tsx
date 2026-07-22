import { Fragment, useEffect, useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { BackSide, Box3, Mesh, MeshBasicMaterial, MultiplyBlending, NormalBlending, Vector3 } from "three";
import { useCardioStore } from "../../store/useCardioStore";
import type { VesselId, VesselState } from "../../types/anatomy";
import type { CalcificationObject, StenosisObject, StentObject } from "../../types/object";
import { computeAorticRootFrame } from "./aorticRootMesh";
import { ContrastFillTube, ContrastMaskTube } from "./ContrastFillTube";
import { HeartbeatGroup } from "./HeartbeatGroup";
import { useCalcificationGeometry, useStenosisPlaqueGeometry, useStentGeometry, useStentLatticeGeometry } from "./ObjectMeshes";
import { cineSceneBridge } from "./cineSceneBridge";
import type { LumenSubtractionProxyEntry } from "./cineSceneBridge";
import type { StentLatticeParams } from "./stentLatticeMesh";
import {
  CATHETER_RADIUS_RATIO,
  WIRE_RADIUS_RATIO,
  computeHeartScale,
  computeHeartWidth,
  useGuideCatheterGeometry,
  useGuideCatheterPath,
  useGuideWireGeometry,
} from "./useGuideDevicePath";
import type { CenterlinePoint } from "./vesselCenterline";
import type { VesselGraph } from "./vesselGraph";
import { getBranch, getMainTrunk, getVesselGraph } from "./vesselGraph";

/** メインビューと同じGLB。将来DICOM由来メッシュに差し替える際もここを変えるだけでよい。 */
export const REALISTIC_HEART_URL = "/models/heart-realistic.glb";

const VESSEL_IDS: VesselId[] = ["RCA", "LAD", "LCX"];

/**
 * 血管のX線風マテリアル。乗算ブレンディングは可換(描画順に依存しない)なので、
 * 投影方向で複数の血管が重なるほど自然に濃くなる。depthTest/depthWriteを切ると
 * 重なった血管がデプスバッファで隠れずに全て乗算に参加できる。
 */
function createVesselMaterial() {
  return new MeshBasicMaterial({
    color: "#4a4a4a",
    transparent: true,
    blending: MultiplyBlending,
    // three.js は MultiplyBlending に premultipliedAlpha を要求する(未設定だと警告が出る)。
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** オブジェクト(石灰化・ステント)のスキーマ表示用マテリアル。血管と同じ乗算ブレンディングだが、
 * 少し明るいグレーにして血管と見分けがつくようにする。 */
function createObjectSilhouetteMaterial(color: string) {
  return new MeshBasicMaterial({
    color,
    transparent: true,
    blending: MultiplyBlending,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
  });
}

/**
 * Phase 7: 造影剤フローで満たされた内腔チューブのスキーマ表示用マテリアル。乗算
 * ブレンディングでは色が暗いほど濃く写る(createVesselMaterialのグレーと同じ考え方)ため、
 * 血管本体(#4a4a4a)よりさらに暗い色にして、「造影剤が入っている区間」が実際に
 * 濃く写るX線と同じ向きでひと目でわかるようにする。
 */
function createContrastFillMaterial() {
  return new MeshBasicMaterial({
    color: "#141414",
    transparent: true,
    blending: MultiplyBlending,
    premultipliedAlpha: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** 心臓の輪郭を「内側を深度だけ塗って隠す」+「一回り拡大した裏面シェル」の2枚で表現する */
function createHeartOutlineMaterials() {
  const depthMask = new MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
  });
  const rim = new MeshBasicMaterial({
    color: "#8a8a8a",
    transparent: true,
    opacity: 0.25,
    blending: NormalBlending,
    side: BackSide,
    depthWrite: false,
    depthTest: true,
  });
  return { depthMask, rim };
}

function isTrunkVisibleInCine(vessels: Record<string, VesselState>, trunkId: VesselId): boolean {
  const trunk = vessels[trunkId];
  if (trunk) return trunk.visible;
  // セグメントモード中は主幹のエントリ自体が無いので、そのセグメントが1つでも
  // 表示されていれば主幹も表示する扱いにする(parentVesselで所属を辿れる)。
  return Object.values(vessels).some((v) => v.parentVessel === trunkId && v.visible);
}

/**
 * シネビュー(X線風平行投影)専用の解剖モデル。メインビューが使う useGLTF(url) の
 * キャッシュを共有しつつ scene.clone(true) で独立した階層を作る
 * (Object3Dは同時に1つの親しか持てないため、同じsceneをメインビューとシネビューの
 * 2つのCanvasに挿入することはできない)。clone(true) は geometry/material を参照共有
 * するため、ここで各メッシュの material は必ず新しいインスタンスに差し替える
 * (既存material をミューテートするとメインビューの表示まで壊れる)。
 */
export function CineAnatomyModel() {
  const { scene } = useGLTF(REALISTIC_HEART_URL);
  const vessels = useCardioStore((s) => s.vessels);
  const objects = useCardioStore((s) => s.objects);
  const showHeartOutline = useCardioStore((s) => s.cine.showHeartOutline);
  const xrayMode = useCardioStore((s) => s.cine.xrayMode);
  const xrayParams = useCardioStore((s) => s.cine.xrayParams);
  const stentLatticeParams = useCardioStore((s) => s.stentLatticeParams);
  const contrastFlowModeEnabled = useCardioStore((s) => s.contrast.enabled);
  const guideDevice = useCardioStore((s) => s.guideDevice);

  const built = useMemo(() => {
    const root = scene.clone(true);
    const meshesByName = new Map<string, Mesh>();
    root.traverse((obj) => {
      if ((obj as Mesh).isMesh) meshesByName.set(obj.name, obj as Mesh);
    });

    const graphs = new Map<VesselId, VesselGraph>();
    for (const id of VESSEL_IDS) {
      const mesh = meshesByName.get(id);
      if (!mesh) continue;
      graphs.set(id, getVesselGraph(id));
      mesh.material = createVesselMaterial();
    }

    const heartMesh = meshesByName.get("HEART");
    let outline: { depthMesh: Mesh; rimMesh: Mesh } | undefined;
    if (heartMesh) {
      // 心臓本体そのものは塗りつぶさない(実際の透視でも心臓は写らないか、うっすら輪郭が見える程度のため)
      heartMesh.visible = false;

      const { depthMask, rim } = createHeartOutlineMaterials();
      const depthMesh = new Mesh(heartMesh.geometry, depthMask);
      depthMesh.position.copy(heartMesh.position);
      depthMesh.quaternion.copy(heartMesh.quaternion);
      depthMesh.scale.copy(heartMesh.scale);

      const rimMesh = new Mesh(heartMesh.geometry, rim);
      rimMesh.position.copy(heartMesh.position);
      rimMesh.quaternion.copy(heartMesh.quaternion);
      rimMesh.scale.copy(heartMesh.scale).multiplyScalar(1.02);

      heartMesh.parent?.add(depthMesh);
      heartMesh.parent?.add(rimMesh);
      outline = { depthMesh, rimMesh };
    }

    return { root, meshesByName, graphs, outline };
  }, [scene]);

  // 心臓メッシュの重心(簡易近似)。石灰化の「向き」パラメータの心筋方向/心外膜方向の
  // 基準に使う(ModelLoader.tsxのメインビュー側と同じ考え方)。
  const heartCentroid = useMemo(() => {
    const heartMesh = built.meshesByName.get("HEART");
    if (!heartMesh) return new Vector3(0, 0, 0);
    return new Box3().setFromObject(heartMesh).getCenter(new Vector3());
  }, [built]);

  const contrastFillMaterial = useMemo(() => createContrastFillMaterial(), []);

  // Phase 9: ガイディングカテーテル・ガイドワイヤーの経路計算(メインビュー側の
  // GuideDeviceMeshes.tsxと同じ純粋関数・フックを再利用する)。配置情報(placement)の
  // storeへの書き戻しはメインビュー側だけが行う(シネビューは読み取り専用の描画のみ)。
  const heartScale = useMemo(() => computeHeartScale(built.meshesByName.get("HEART")), [built]);
  // メインビュー(ModelLoader.tsx)と同じ太さの大動脈基部フレームになるよう、こちらも
  // heartWidthを渡す(AorticRootFrame.ascendingRadius参照)。
  const heartWidth = useMemo(() => computeHeartWidth(built.meshesByName.get("HEART")), [built]);
  const guideGraph = built.graphs.get(guideDevice.targetVesselId);
  // 冠動脈入口部の実位置から逆算した大動脈基部フレーム(aorticRootMesh.ts)。
  // カテーテルが対側壁に当ててからエンゲージする経路(computeGuideCatheterPath参照)の
  // 基準に使う。
  const guideAorticRootFrame = useMemo(
    () => computeAorticRootFrame(heartCentroid, built.graphs, heartWidth),
    [heartCentroid, built, heartWidth],
  );
  const catheterPath = useGuideCatheterPath(
    guideGraph,
    heartCentroid,
    heartScale,
    guideDevice.targetVesselId,
    guideDevice.accessRoute,
    guideAorticRootFrame,
    built.meshesByName.get("HEART") ?? null,
  );
  const guideOstiumRadius = guideGraph ? getMainTrunk(guideGraph).points[0]?.radius ?? 0.03 : 0.03;
  const catheterRadius = guideOstiumRadius * CATHETER_RADIUS_RATIO;
  const wireRadius = guideOstiumRadius * WIRE_RADIUS_RATIO;
  const catheterProgress = Math.min(1, guideDevice.insertionPhase);
  const wireProgress = Math.max(0, guideDevice.insertionPhase - 1);
  const catheterGeometry = useGuideCatheterGeometry(catheterPath, catheterRadius, catheterProgress);
  const wireGeometry = useGuideWireGeometry(guideGraph, guideDevice.targetBranchId, wireRadius, wireProgress);
  const guideCatheterSilhouetteMaterial = useMemo(() => createObjectSilhouetteMaterial("#b8bcc2"), []);
  // ワイヤーはカテーテルより細い金属線で、実際の透視でもカテーテルの塗りつぶし本体より
  // くっきり暗い一本の線として見えるため、スキーマ表示でも同じ色を共有せず別マテリアルにする。
  const guideWireSilhouetteMaterial = useMemo(() => createObjectSilhouetteMaterial("#5b5f66"), []);

  useEffect(() => {
    const vesselMeshes: Partial<Record<VesselId, Mesh>> = {};
    for (const id of VESSEL_IDS) {
      const mesh = built.meshesByName.get(id);
      if (mesh) vesselMeshes[id] = mesh;
    }
    if (cineSceneBridge.current) {
      cineSceneBridge.current.vesselMeshes = vesselMeshes;
      cineSceneBridge.current.heartMesh = built.meshesByName.get("HEART") ?? null;
    }
  }, [built]);

  useEffect(() => {
    const vesselVisible: Partial<Record<VesselId, boolean>> = {};
    for (const id of VESSEL_IDS) {
      const mesh = built.meshesByName.get(id);
      const trunkVisible = isTrunkVisibleInCine(vessels, id);
      vesselVisible[id] = trunkVisible;
      // リアルX線モードでは塗りつぶしメッシュ自体は表示せず、CineVesselThicknessEffect が
      // 深度ピールで血管濃淡を描く(vesselVisible経由で表示/非表示トグルを反映させる)。
      if (mesh) mesh.visible = trunkVisible && !xrayMode;
    }
    if (cineSceneBridge.current) cineSceneBridge.current.vesselVisible = vesselVisible;
  }, [built, vessels, xrayMode]);

  // 造影剤フローモード(サイドバーのトグル)のON/OFFをCineVesselThicknessEffectへ伝える。
  // 血管アキュムレータの登録元(vesselMeshes、常時フル吸収)自体はモードに関わらず常に
  // 同じで、ONの間だけその上に濃度マスク(contrastMaskMeshes)を追加で掛け合わせる。
  useEffect(() => {
    if (cineSceneBridge.current) cineSceneBridge.current.contrastFlowModeEnabled = contrastFlowModeEnabled;
  }, [contrastFlowModeEnabled]);

  useEffect(() => {
    if (!built.outline) return;
    // リアルX線モード中は輪郭線ではなくCineVesselThicknessEffectの深度ピール陰影で
    // 心臓を表現するため、showHeartOutlineがONでも輪郭線は強制的に非表示にする
    // (スキーマ表示側の挙動は変更しない)。
    const visible = showHeartOutline && !xrayMode;
    built.outline.depthMesh.visible = visible;
    built.outline.rimMesh.visible = visible;
  }, [built, showHeartOutline, xrayMode]);

  // ステントのメッシュへの参照を集約し、CineVesselThicknessEffectがリアルX線モードで
  // 深度ピール密度表現に使う共有アキュムレータ(cineSceneBridge.stentProxies)へ反映する。
  // CineStentLatticeのrefコールバックから呼ばれる。石灰化とは別チャンネル(ブラー無し)
  // にすることで、金属の網目らしい鋭さを保つ。加算合成方式のため件数上限は無い。
  //
  // Phase 9: ガイディングカテーテル・ガイドワイヤーも金属/樹脂製で常時ブラー無しに
  // 写るべき対象のため、新しいテクスチャチャンネルを増やさず(GPU/ドライバの
  // テクスチャユニット数上限に以前実際に抵触した経緯があるため)、このステント用の
  // 共有アキュムレータへ別のMapから合流させて登録する。
  const stentMeshRefsById = useRef(new Map<string, { mesh: Mesh; absorption: number }>());
  const guideDeviceMeshRefsById = useRef(new Map<string, { mesh: Mesh; absorption: number }>());

  function syncStentProxies() {
    if (!cineSceneBridge.current) return;
    const merged = [...stentMeshRefsById.current.entries(), ...guideDeviceMeshRefsById.current.entries()];
    cineSceneBridge.current.stentProxies = merged.map(([id, entry]) => ({ id, mesh: entry.mesh, absorption: entry.absorption }));
  }

  function registerStentMesh(id: string, absorption: number) {
    return (mesh: Mesh | null) => {
      if (mesh) stentMeshRefsById.current.set(id, { mesh, absorption });
      else stentMeshRefsById.current.delete(id);
      syncStentProxies();
    };
  }

  function registerGuideDeviceMesh(id: string, absorption: number) {
    return (mesh: Mesh | null) => {
      if (mesh) guideDeviceMeshRefsById.current.set(id, { mesh, absorption });
      else guideDeviceMeshRefsById.current.delete(id);
      syncStentProxies();
    };
  }

  // 石灰化のメッシュへの参照を集約し、CineVesselThicknessEffectが専用アキュムレータ
  // (cineSceneBridge.calcificationProxies、ブラーあり)へ反映する。
  // CineCalcificationBumpのrefコールバックから呼ばれる。
  const calcificationMeshRefsById = useRef(new Map<string, { mesh: Mesh; absorption: number }>());

  function syncCalcificationProxies() {
    if (!cineSceneBridge.current) return;
    cineSceneBridge.current.calcificationProxies = Array.from(calcificationMeshRefsById.current.entries()).map(
      ([id, entry]) => ({ id, mesh: entry.mesh, absorption: entry.absorption }),
    );
  }

  function registerCalcificationMesh(id: string, absorption: number) {
    return (mesh: Mesh | null) => {
      if (mesh) calcificationMeshRefsById.current.set(id, { mesh, absorption });
      else calcificationMeshRefsById.current.delete(id);
      syncCalcificationProxies();
    };
  }

  // 内腔を狭める要素(狭窄の外径/内径チューブ、石灰化の内腔減算用シェル)のメッシュへの
  // 参照を集約し、CineVesselThicknessEffectが血管本体の共有アキュムレータへ符号付きで
  // 加算するのに使う(cineSceneBridge.lumenSubtractionProxies)。狭窄は1オブジェクトに
  // つきouter/innerの2キー、石灰化はnarrowingの1キーで登録する。造影剤フローモードOFF
  // (既定)の間だけ実際にCineVesselThicknessEffect側で使われる。
  const lumenSubtractionMeshRefsById = useRef(new Map<string, { mesh: Mesh; sign: 1 | -1; vesselId: VesselId }>());

  function syncLumenSubtractionProxies() {
    if (!cineSceneBridge.current) return;
    cineSceneBridge.current.lumenSubtractionProxies = Array.from(lumenSubtractionMeshRefsById.current.entries()).map(
      ([id, entry]): LumenSubtractionProxyEntry => ({ id, mesh: entry.mesh, sign: entry.sign, vesselId: entry.vesselId }),
    );
  }

  function registerLumenSubtractionMesh(id: string, sign: 1 | -1, vesselId: VesselId) {
    return (mesh: Mesh | null) => {
      if (mesh) lumenSubtractionMeshRefsById.current.set(id, { mesh, sign, vesselId });
      else lumenSubtractionMeshRefsById.current.delete(id);
      syncLumenSubtractionProxies();
    };
  }

  // Phase 7: 造影剤濃度マスク用チューブ(ContrastMaskTube)のメッシュへの参照を、
  // 造影剤フローモードON中だけCineVesselThicknessEffectが濃度マスクアキュムレータへの
  // 登録元として使う(cineSceneBridge.contrastMaskMeshes)。血管ごとに1つ(可変件数では
  // ない)なので、石灰化・ステントのようなMapベースの集約は不要。
  function registerContrastMaskMesh(vesselId: VesselId) {
    return (mesh: Mesh | null) => {
      if (!cineSceneBridge.current) return;
      if (mesh) cineSceneBridge.current.contrastMaskMeshes[vesselId] = mesh;
      else delete cineSceneBridge.current.contrastMaskMeshes[vesselId];
    };
  }

  // 石灰化・狭窄は造影剤の有無に左右されず常時描画対象になる(vessels/vesselVisibleの
  // 表示トグルとは無関係に、object.visibleだけで判定する)。Phase 7で造影剤フローを
  // 実装する際も、この判定条件に造影剤の有無を混ぜないこと。
  const visibleStenoses = objects.filter((o): o is StenosisObject => o.type === "stenosis" && o.visible);
  const visibleCalcifications = objects.filter(
    (o): o is CalcificationObject => o.type === "calcification" && o.visible,
  );
  const visibleStents = objects.filter((o): o is StentObject => o.type === "stent" && o.visible);

  return (
    <HeartbeatGroup
      onMount={(group) => {
        if (cineSceneBridge.current) cineSceneBridge.current.pulseGroup = group;
      }}
    >
      <primitive object={built.root} />

      {contrastFlowModeEnabled &&
        VESSEL_IDS.map((id) => {
          const graph = built.graphs.get(id);
          if (!graph) return null;
          return (
            <Fragment key={id}>
              {/* スキーマ表示用の見た目のオーバーレイ。xrayMode中は他の全オブジェクトの
                  スキーマ用メッシュと同様、表示自体を隠す(隠さないと、リアルX線モードの
                  ポストプロセス結果の上にこの乗算ブレンドの暗い塗りつぶしが重なり、
                  二重に暗くなってしまう不具合があった)。 */}
              <ContrastFillTube
                key={`contrast-fill-${id}`}
                vesselId={id}
                graph={graph}
                objects={objects}
                material={contrastFillMaterial}
                visible={isTrunkVisibleInCine(vessels, id) && !xrayMode}
              />
              {/* リアルX線モード専用の濃度マスク登録元。常時非表示、深度ピール用プロキシの
                  元ジオメトリとしてのみ使う(CineStentLatticeのlatticeGeometryと同じ扱い)。 */}
              <ContrastMaskTube
                key={`contrast-mask-${id}`}
                vesselId={id}
                graph={graph}
                objects={objects}
                material={contrastFillMaterial}
                visible={false}
                onRef={registerContrastMaskMesh(id)}
              />
            </Fragment>
          );
        })}

      {visibleStenoses.map((object) => {
        const graph = built.graphs.get(object.vesselId);
        const branch = graph && getBranch(graph, object.branchId);
        if (!branch) return null;
        return (
          <CineStenosisPlaque
            key={object.id}
            object={object}
            centerline={branch.points}
            xrayMode={xrayMode}
            onRefOuter={registerLumenSubtractionMesh(`${object.id}-outer`, -1, object.vesselId)}
            onRefInner={registerLumenSubtractionMesh(`${object.id}-inner`, 1, object.vesselId)}
          />
        );
      })}
      {visibleCalcifications.map((object) => {
        const graph = built.graphs.get(object.vesselId);
        const branch = graph && getBranch(graph, object.branchId);
        if (!branch) return null;
        return (
          <CineCalcificationBump
            key={object.id}
            object={object}
            centerline={branch.points}
            heartCentroid={heartCentroid}
            xrayMode={xrayMode}
            onRef={registerCalcificationMesh(object.id, xrayParams.calcificationAbsorption)}
            onRefNarrowing={registerLumenSubtractionMesh(`${object.id}-narrowing`, -1, object.vesselId)}
          />
        );
      })}
      {visibleStents.map((object) => {
        const graph = built.graphs.get(object.vesselId);
        const branch = graph && getBranch(graph, object.branchId);
        if (!branch) return null;
        return (
          <CineStentLattice
            key={object.id}
            object={object}
            centerline={branch.points}
            xrayMode={xrayMode}
            stentLatticeParams={stentLatticeParams}
            onRef={registerStentMesh(object.id, xrayParams.stentAbsorption)}
          />
        );
      })}
      {guideDevice.enabled && (
        <>
          {/* スキーマ表示用のシルエット。リアルX線モード中は他のオブジェクト同様に隠し、
              CineVesselThicknessEffectの深度ピール(ステント用の共有チャンネルに合流)で
              描画する。ジオメトリが無い(進行度0でまだ何も表示するものが無い)間は
              登録用メッシュ自体を描画しない——geometryが無い<mesh>をマウントすると
              既定の空ジオメトリが登録されてしまうため。 */}
          {guideDevice.showCatheter && catheterGeometry && (
            <>
              <mesh geometry={catheterGeometry} material={guideCatheterSilhouetteMaterial} visible={!xrayMode} />
              <mesh
                geometry={catheterGeometry}
                visible={false}
                ref={registerGuideDeviceMesh("guide-catheter", xrayParams.catheterAbsorption)}
              />
            </>
          )}
          {guideDevice.showWire && wireGeometry && (
            <>
              <mesh geometry={wireGeometry} material={guideWireSilhouetteMaterial} visible={!xrayMode} />
              <mesh
                geometry={wireGeometry}
                visible={false}
                ref={registerGuideDeviceMesh("guide-wire", xrayParams.wireAbsorption)}
              />
            </>
          )}
        </>
      )}
    </HeartbeatGroup>
  );
}

interface CineObjectMeshProps<T> {
  object: T;
  centerline: CenterlinePoint[];
  /** リアルX線モード中は色パス用メッシュを隠す(密度表現はCineVesselThicknessEffect側が担う) */
  xrayMode: boolean;
  onRef: (mesh: Mesh | null) => void;
}

/**
 * スキーマ表示は結合ジオメトリ(外側+内側成長分のシェル)をシルエットマテリアルで
 * 表示する(石灰化の高吸収を表す既存の「オブジェクト」チャンネルはこの同じジオメトリを
 * onRef経由で登録する)。加えて、内腔減算専用シェル(narrowing、常時非表示)を
 * onRefNarrowing経由で登録し、造影剤フローモードOFF(既定)の間、内側への張り出し分だけ
 * 血管の生厚みから差し引く。
 */
function CineCalcificationBump({
  object,
  centerline,
  heartCentroid,
  xrayMode,
  onRef,
  onRefNarrowing,
}: CineObjectMeshProps<CalcificationObject> & {
  heartCentroid: Vector3;
  onRefNarrowing: (mesh: Mesh | null) => void;
}) {
  const { visual, lumenNarrowing } = useCalcificationGeometry(centerline, object, heartCentroid);
  const material = useMemo(() => createObjectSilhouetteMaterial("#dcdcdc"), []);
  return (
    <>
      <mesh geometry={visual} material={material} visible={!xrayMode} ref={onRef} />
      <mesh geometry={lumenNarrowing} visible={false} ref={onRefNarrowing} />
    </>
  );
}

/**
 * スキーマ表示は結合ジオメトリ(外径+内径チューブ)をシルエットマテリアルで表示する
 * (石灰化・ステントと同じ扱い)。リアルX線モードでは、この結合ジオメトリではなく
 * outer/inner を独立したメッシュとして常時非表示のまま登録し、造影剤フローモードOFF
 * (既定)の間、CineVesselThicknessEffectが血管本体の共有アキュムレータへの加減算に使う
 * (mainImage側でのブラー処理は血管本体の生厚みに対して行われるため、outer/innerの
 * 描画用メッシュ自体はxrayMode中も一切visible=trueにしない)。
 */
function CineStenosisPlaque({
  object,
  centerline,
  xrayMode,
  onRefOuter,
  onRefInner,
}: {
  object: StenosisObject;
  centerline: CenterlinePoint[];
  xrayMode: boolean;
  onRefOuter: (mesh: Mesh | null) => void;
  onRefInner: (mesh: Mesh | null) => void;
}) {
  const { merged, outer, inner } = useStenosisPlaqueGeometry(centerline, object);
  const material = useMemo(() => createObjectSilhouetteMaterial("#e0d4b0"), []);
  return (
    <>
      <mesh geometry={merged} material={material} visible={!xrayMode} />
      <mesh geometry={outer} visible={false} ref={onRefOuter} />
      <mesh geometry={inner} visible={false} ref={onRefInner} />
    </>
  );
}

/**
 * スキーマ表示は従来通り土台円筒(solid tube)のシルエットのまま変更しない。リアルX線
 * モードだけは、ステントの網目(ストラット)構造がメインビューと全く同じ
 * buildStentLatticeGeometry で生成した薄い網目ジオメトリを深度ピールの元にすることで、
 * 「ストラット部分だけが高吸収体、網目の隙間は血管の濃度がそのまま見える」という
 * 実際の透視像に近い見え方になる(隙間では前面/背面とも深度ピールにヒットせず、
 * 厚み=0としてobjectDarknessが素通しになるため、追加のシェーダー分岐は不要)。
 * この網目ジオメトリのメッシュ自体は常時非表示にし、深度ピール用プロキシの元
 * (mesh.geometry+matrixWorld)としてのみ CineVesselThicknessEffect に登録する。
 */
function CineStentLattice({
  object,
  centerline,
  xrayMode,
  stentLatticeParams,
  onRef,
}: CineObjectMeshProps<StentObject> & { stentLatticeParams: StentLatticeParams }) {
  const solidGeometry = useStentGeometry(centerline, object);
  const latticeGeometry = useStentLatticeGeometry(centerline, object, stentLatticeParams);
  const material = useMemo(() => createObjectSilhouetteMaterial("#c8c8c8"), []);
  return (
    <>
      <mesh geometry={solidGeometry} material={material} visible={!xrayMode} />
      <mesh geometry={latticeGeometry} visible={false} ref={onRef} />
    </>
  );
}

useGLTF.preload(REALISTIC_HEART_URL);
