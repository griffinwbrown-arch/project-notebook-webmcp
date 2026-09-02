import {
  ADULT_SKELETON_BONES,
  ANATOMY_CATALOG_VERSION,
  VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  type AnatomySection,
  type BoneEntry,
} from "./catalog";
import {
  COLORING_PALETTE,
  MAX_SURFACE_PAINT_ANCHORS,
  MAX_SURFACE_PAINT_ANCHORS_PER_STROKE,
  MAX_SURFACE_PAINT_STROKES,
  SURFACE_BARYCENTRIC_QUANTIZATION,
  SURFACE_BRUSH_BASIS_POINTS,
  SURFACE_PRESSURE_QUANTIZATION,
  quantizeSurfaceBarycentric,
  quantizeSurfacePressure,
  type ColoringColorId,
  type SurfacePaintAnchor,
  type SurfacePaintBrush,
  type SurfacePaintStroke,
} from "./coloring-domain";

const ATLAS_ASSET_URL = "/assets/anatomy/authority-atlas-206.glb";
const NORMALIZED_ATLAS_HEIGHT = 3.62;
const CAMERA_DISTANCE = 6.9;
const CAMERA_NEAR_PLANE = 0.01;
const ORBIT_MIN_DISTANCE = 0.38;
const CAMERA_ANIMATION_MS = 620;
const MOTION_LOD_TARGET_INDEX_RATIO = 0.17;
const MOTION_LOD_MAX_RELATIVE_ERROR = 0.01;
const EXACT_COMPOSITION_CHUNK_COUNT = 6;
const SURFACE_STAMP_SPACING_RATIO = 0.35;
const SURFACE_NEUTRAL_COLOR = 0xeee9dd;

type AtlasCameraView = AtlasCameraPreset | "custom";
type AtlasBatch = import("three").BatchedMesh;
type AtlasEncoder = typeof import("meshoptimizer/encoder").MeshoptEncoder;
type AtlasMesh = import("three").Mesh;
type AtlasRoot = import("three").Object3D;
type AtlasSimplifier = typeof import("meshoptimizer/simplifier").MeshoptSimplifier;
type AtlasVector = import("three").Vector3;
type AtlasBatchState = Readonly<{
  batch: AtlasBatch;
  geometryCount: number;
  indexCount: number;
  instanceByMesh: Map<AtlasMesh, number>;
  sourceMeshByInstance: Map<number, AtlasMesh>;
  surfaceTargetByMesh: Map<AtlasMesh, AtlasSurfaceTarget>;
}>;
type MotionGeometryState = Readonly<{
  geometryBySource: Map<import("three").BufferGeometry, import("three").BufferGeometry>;
  maximumRelativeError: number;
}>;
type ExactGeometryState = Readonly<{
  geometryBySource: Map<import("three").BufferGeometry, import("three").BufferGeometry>;
  sourceToReorderedVertexBySource: Map<import("three").BufferGeometry, Uint32Array>;
  reorderedGeometryCount: number;
}>;
type ReorderedGeometryResult = Readonly<{
  geometry: import("three").BufferGeometry;
  sourceToReorderedVertex: Uint32Array;
}>;
type AtlasSurfaceTarget = Readonly<{
  boneId: string;
  sourceMesh: AtlasMesh;
  sourceObject: string;
  sourceToBatchVertex: Uint32Array;
  vertexCount: number;
  vertexStart: number;
}>;
type AtlasSurfaceAdjacency = Readonly<{
  neighbors: readonly Uint32Array[];
  worldPositions: Float32Array;
  weldedVertexCount: number;
}>;
type AtlasSurfacePointerSample = Readonly<{
  clientX: number;
  clientY: number;
  pressure: number;
}>;
type AtlasSurfaceStrokeDraft = {
  readonly id: string;
  readonly boneId: string;
  readonly brush: SurfacePaintBrush;
  readonly anchors: SurfacePaintAnchor[];
  lastWorldPoint: readonly [number, number, number] | null;
};
type ExactCompositionState = {
  readonly revision: number;
  readonly activeChunkIndexes: readonly number[];
  readonly cameraSignature: string;
  readonly phaseDurations: number[];
  readyToPresent: boolean;
  nextActiveChunk: number;
};
type AtlasCameraMotion = Readonly<{
  startedAt: number;
  duration: number;
  fromPosition: AtlasVector;
  toPosition: AtlasVector;
  fromTarget: AtlasVector;
  toTarget: AtlasVector;
}>;

export type AtlasCameraPreset = "anterior" | "left" | "right";
export type AtlasInteractionMode = "orbit" | "paint";
export type AtlasPaintPhase = "start" | "move";

export type AtlasHit = Readonly<{
  boneId: string;
  label: string;
  section: AnatomySection;
  sourceObject: string;
  faceIndex: number;
  barycentric: readonly [number, number, number];
  pressure: number;
  boneScale: number;
  worldPoint: readonly [number, number, number];
}>;

export type ProjectedAtlasPoint = Readonly<{
  x: number;
  y: number;
  visible: boolean;
}>;

type AtlasCameraSnapshot = Readonly<{
  view: AtlasCameraPreset | "custom";
  position: readonly [number, number, number];
  distance: number;
}>;

export interface AnatomyAtlasScene {
  readonly canvas: HTMLCanvasElement;
  focusBone(boneId: string, animate?: boolean): void;
  fitSection(section: AnatomySection, animate?: boolean): void;
  setIsolatedBone(boneId: string | null): void;
  setVisibleSection(section: AnatomySection | null): void;
  setCameraPreset(preset: AtlasCameraPreset, animate?: boolean): void;
  setInteractionMode(mode: AtlasInteractionMode): void;
  setSurfaceBrush(brush: SurfacePaintBrush): void;
  setSurfaceStrokes(strokes: readonly SurfacePaintStroke[]): void;
  clearSurfacePreview(): void;
  setBoneColors(colors: Readonly<Record<string, number>>): void;
  setBoneColor(boneId: string, color: number | null): void;
  setSelectedBone(boneId: string | null): void;
  setHoveredBone(boneId: string | null): void;
  projectBone(boneId: string): ProjectedAtlasPoint | null;
  requestRender(): void;
  getIdentity(): Readonly<{
    logicalBoneCount: number;
    semanticMeshCount: number;
    upright: true;
    normalizedDimensions: readonly [number, number, number];
  }>;
  getCamera(): AtlasCameraSnapshot;
  dispose(): void;
}

export async function createAnatomyAtlasScene(
  host: HTMLElement,
  options: Readonly<{
    onHover: (hit: AtlasHit | null) => void;
    onSelect: (hit: AtlasHit | null) => void;
    onPaint?: (hit: AtlasHit, phase: AtlasPaintPhase) => void;
    onPaintEnd?: () => void;
    onSurfaceStrokeCommit?: (stroke: SurfacePaintStroke) => void;
    onCameraChange?: (camera: AtlasCameraSnapshot) => void;
    initialInteractionMode?: AtlasInteractionMode;
    initialSection?: AnatomySection;
  }>,
): Promise<AnatomyAtlasScene> {
  const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
    import("three"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);
  const motionSimplifierPromise: Promise<AtlasSimplifier | null> = options.initialSection === undefined
    ? import("meshoptimizer/simplifier").then(async ({ MeshoptSimplifier }) => {
        if (!MeshoptSimplifier.supported) return null;
        await MeshoptSimplifier.ready;
        return MeshoptSimplifier;
      }).catch(() => null)
    : Promise.resolve(null);
  const exactEncoderPromise: Promise<AtlasEncoder | null> = import("meshoptimizer/encoder").then(
    async ({ MeshoptEncoder }) => {
      if (!MeshoptEncoder.supported) return null;
      await MeshoptEncoder.ready;
      return MeshoptEncoder;
    },
  ).catch(() => null);

  const catalogById = new Map(ADULT_SKELETON_BONES.map((bone) => [bone.id, bone]));
  if (
    catalogById.size !== VERIFIED_ATLAS_LOGICAL_BONE_COUNT ||
    ADULT_SKELETON_BONES.length !== VERIFIED_ATLAS_LOGICAL_BONE_COUNT
  ) {
    throw new Error("The anatomy catalogue does not contain 206 unique logical bones.");
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(31, 1, CAMERA_NEAR_PLANE, 30);
  camera.position.set(0, 0.08, CAMERA_DISTANCE);

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 0);

  const canvas = renderer.domElement;
  canvas.className = "anatomy-model-canvas";
  canvas.tabIndex = 0;
  canvas.style.display = "block";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  canvas.style.width = "100%";
  canvas.style.cursor = "grab";
  canvas.setAttribute(
    "aria-label",
    "Interactive 3D skeleton. Drag to orbit and use the wheel or a pinch gesture to zoom.",
  );
  host.append(canvas);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = true;
  controls.panSpeed = 0.55;
  controls.rotateSpeed = 0.56;
  controls.zoomSpeed = 0.72;
  controls.minDistance = ORBIT_MIN_DISTANCE;
  controls.maxDistance = 14;
  controls.target.set(0, 0, 0);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(2, 2);
  const atlasMeshes: AtlasMesh[] = [];
  const visibleMeshes: AtlasMesh[] = [];
  const visibleMeshSet = new Set<AtlasMesh>();
  const meshesByBoneId = new Map<string, AtlasMesh[]>();
  const recordByMesh = new Map<import("three").Object3D, BoneEntry>();
  const boneColors = new Map<string, number>();
  const boneScaleById = new Map<string, number>();
  const geometries = new Set<import("three").BufferGeometry>();
  const materials = new Set<import("three").Material>();
  const textures = new Set<import("three").Texture>();
  const appearanceColor = new THREE.Color();
  const surfacePaintEnabled = options.initialSection !== undefined;
  const sourceMeshByName = new Map<string, AtlasMesh>();
  const sourceObjectByMesh = new Map<AtlasMesh, string>();
  const sourceNodeNames = new Set<string>();
  const surfaceAdjacencyByMesh = new Map<AtlasMesh, AtlasSurfaceAdjacency>();
  let surfaceBrush: SurfacePaintBrush | null = null;
  let persistedSurfaceStrokes: readonly SurfacePaintStroke[] = [];
  let surfaceStrokeDraft: AtlasSurfaceStrokeDraft | null = null;
  let pendingSurfacePointer: AtlasSurfacePointerSample | null = null;
  let surfaceDirtyVertexStart = Number.POSITIVE_INFINITY;
  let surfaceDirtyVertexEnd = -1;
  const surfacePaintedVertices = new Set<number>();

  const matcapTexture = createMatcapTexture();
  const normalMaterial = new THREE.MeshMatcapMaterial({
    color: 0xffffff,
    matcap: matcapTexture,
    side: THREE.FrontSide,
    vertexColors: true,
  });
  trackMaterial(normalMaterial);

  const exactPresentationTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    generateMipmaps: false,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearFilter,
    stencilBuffer: false,
    type: THREE.UnsignedByteType,
  });
  exactPresentationTarget.samples = 0;
  exactPresentationTarget.texture.colorSpace = THREE.NoColorSpace;
  const presentationScene = new THREE.Scene();
  const presentationCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const presentationGeometry = new THREE.PlaneGeometry(2, 2);
  const presentationMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: { atlasTexture: { value: exactPresentationTarget.texture } },
    vertexShader: [
      "varying vec2 vUv;",
      "void main() {",
      "  vUv = uv;",
      "  gl_Position = vec4(position.xy, 0.0, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "uniform sampler2D atlasTexture;",
      "varying vec2 vUv;",
      "void main() {",
      "  gl_FragColor = texture2D(atlasTexture, vUv);",
      "  #include <tonemapping_fragment>",
      "  #include <colorspace_fragment>",
      "}",
    ].join("\n"),
  });
  presentationMaterial.toneMapped = false;
  presentationMaterial.blending = THREE.NoBlending;
  const presentationQuad = new THREE.Mesh(presentationGeometry, presentationMaterial);
  presentationQuad.frustumCulled = false;
  presentationScene.add(presentationQuad);
  geometries.add(presentationGeometry);
  trackMaterial(presentationMaterial);

  let atlasRoot: AtlasRoot | null = null;
  let exactAtlas: AtlasBatchState | null = null;
  let motionAtlas: AtlasBatchState | null = null;
  let exactCompositionChunks: readonly (readonly AtlasMesh[])[] = [];
  let exactComposition: ExactCompositionState | null = null;
  let exactCompositionRevision = 0;
  let exactPresentationSettled = false;
  let displayedFrameAvailable = false;
  let resolveInitialPresentation: (() => void) | null = null;
  const initialPresentationPromise = new Promise<void>((resolve) => {
    resolveInitialPresentation = resolve;
  });
  let disposed = false;
  let documentVisible = document.visibilityState !== "hidden";
  let frameId: number | null = null;
  let cameraMotion: AtlasCameraMotion | null = null;
  let cameraView: AtlasCameraView = "anterior";
  let selectedBoneId: string | null = null;
  let hoveredBoneId: string | null = null;
  let isolatedBoneId: string | null = null;
  let visibleSection: AnatomySection | null = options.initialSection ?? null;
  let interactionMode: AtlasInteractionMode = options.initialInteractionMode ?? "orbit";
  let paintingPointerId: number | null = null;
  let normalizedDimensions: readonly [number, number, number] = [0, 0, 0];
  let latestPointer: Readonly<{ x: number; y: number }> | null = null;
  let pointerDown: Readonly<{ x: number; y: number }> | null = null;
  let pointerRaycastPending = false;
  let controlsInputActive = false;
  let lastCameraSignature = "";
  let renderedWidth = 0;
  let renderedHeight = 0;
  let renderedPixelRatio = 0;

  controls.enabled = interactionMode === "orbit";
  canvas.dataset.interactionMode = interactionMode;
  canvas.dataset.surfacePaint = surfacePaintEnabled ? "enabled" : "disabled";
  canvas.dataset.surfacePaintStrokes = "0";
  canvas.dataset.surfacePaintAnchors = "0";
  canvas.dataset.surfacePaintPreviewAnchors = "0";

  const resizeObserver = new ResizeObserver(() => resizeRenderer());
  resizeObserver.observe(host);

  const handlePointerEnter = (event: PointerEvent): void => {
    latestPointer = { x: event.clientX, y: event.clientY };
    if (!controlsInputActive) pointerRaycastPending = true;
    requestRender();
  };
  const handlePointerMove = (event: PointerEvent): void => {
    latestPointer = { x: event.clientX, y: event.clientY };
    if (interactionMode === "paint" && paintingPointerId === event.pointerId) {
      const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
      const latestEvent = coalesced.at(-1) ?? event;
      pendingSurfacePointer = {
        clientX: latestEvent.clientX,
        clientY: latestEvent.clientY,
        pressure: pointerPressure(latestEvent),
      };
    } else if (!controlsInputActive) {
      pointerRaycastPending = true;
    }
    requestRender();
  };
  const handlePointerLeave = (): void => {
    latestPointer = null;
    pointerRaycastPending = false;
    if (hoveredBoneId !== null) {
      hoveredBoneId = null;
      applyMeshAppearance();
      options.onHover(null);
    }
    canvas.style.cursor = interactionMode === "paint" ? "crosshair" : "grab";
    requestRender();
  };
  const handlePointerDown = (event: PointerEvent): void => {
    if (interactionMode === "paint") {
      paintingPointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = "crosshair";
      pendingSurfacePointer = null;
      paintAt(event.clientX, event.clientY, "start", pointerPressure(event));
      event.preventDefault();
      return;
    }
    pointerDown = { x: event.clientX, y: event.clientY };
    canvas.style.cursor = "grabbing";
  };
  const handlePointerUp = (event: PointerEvent): void => {
    if (interactionMode === "paint" && paintingPointerId === event.pointerId) {
      if (pendingSurfacePointer !== null) flushPendingSurfacePointer();
      paintAt(event.clientX, event.clientY, "move", pointerPressure(event));
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      paintingPointerId = null;
      finishSurfaceStroke();
      canvas.style.cursor = hoveredBoneId === null ? "crosshair" : "cell";
      options.onPaintEnd?.();
      return;
    }
    const start = pointerDown;
    pointerDown = null;
    canvas.style.cursor = hoveredBoneId === null ? "grab" : "pointer";
    if (start === null || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
    const hit = raycastAt(event.clientX, event.clientY);
    if (hit === null) return;
    setSelectedBone(hit.boneId);
    options.onSelect(hit);
  };
  const handlePointerCancel = (): void => {
    if (paintingPointerId !== null) {
      paintingPointerId = null;
      cancelSurfaceStroke();
      options.onPaintEnd?.();
    }
    pointerDown = null;
    canvas.style.cursor = interactionMode === "paint"
      ? hoveredBoneId === null ? "crosshair" : "cell"
      : hoveredBoneId === null ? "grab" : "pointer";
  };
  const handleControlsStart = (): void => {
    controlsInputActive = true;
    cameraMotion = null;
    invalidateExactComposition();
    clearPointerHitForCameraMotion();
    requestRender();
  };
  const handleControlsChange = (): void => {
    if (controlsInputActive) cameraView = "custom";
    publishCameraSnapshot();
    requestRender();
  };
  const handleControlsEnd = (): void => {
    controlsInputActive = false;
    publishCameraSnapshot();
    requestRender();
  };
  const handleVisibilityChange = (): void => {
    documentVisible = document.visibilityState !== "hidden";
    if (!documentVisible && frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    if (documentVisible) {
      resizeRenderer();
      requestRender();
    }
  };

  canvas.addEventListener("pointerenter", handlePointerEnter);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerleave", handlePointerLeave);
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerCancel);
  controls.addEventListener("start", handleControlsStart);
  controls.addEventListener("change", handleControlsChange);
  controls.addEventListener("end", handleControlsEnd);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  const api: AnatomyAtlasScene = {
    canvas,
    focusBone,
    fitSection,
    setIsolatedBone,
    setVisibleSection,
    setCameraPreset,
    setInteractionMode,
    setSurfaceBrush,
    setSurfaceStrokes,
    clearSurfacePreview,
    setBoneColors,
    setBoneColor,
    setSelectedBone,
    setHoveredBone,
    projectBone,
    requestRender,
    getIdentity: () => ({
      logicalBoneCount: meshesByBoneId.size,
      semanticMeshCount: atlasMeshes.length,
      upright: true,
      normalizedDimensions,
    }),
    getCamera: cameraSnapshot,
    dispose,
  };

  try {
    resizeRenderer();
    const [gltf, motionSimplifier, exactEncoder] = await Promise.all([
      new GLTFLoader().loadAsync(ATLAS_ASSET_URL),
      motionSimplifierPromise,
      exactEncoderPromise,
    ]);
    if (disposed) throw new Error("The anatomy atlas scene was disposed while loading.");
    atlasRoot = gltf.scene;
    prepareAndVerifyAtlas(atlasRoot);
    normalizedDimensions = normalizeUpright(atlasRoot);
    const exactGeometryState = createExactReorderedGeometries(exactEncoder);
    exactAtlas = createBatchedAtlas({
      name: "verified-anatomy-atlas-source-batch",
      geometryBySource: exactGeometryState.geometryBySource,
      sourceToReorderedVertexBySource: exactGeometryState.sourceToReorderedVertexBySource,
    });
    exactCompositionChunks = createExactCompositionChunks();
    scene.add(exactAtlas.batch);
    let motionGeometryState: MotionGeometryState | null = null;
    if (motionSimplifier !== null && exactEncoder !== null) {
      motionGeometryState = createMotionGeometries(motionSimplifier, exactEncoder);
      motionAtlas = createBatchedAtlas({
        name: "verified-anatomy-atlas-motion-batch",
        geometryBySource: motionGeometryState.geometryBySource,
        sourceToReorderedVertexBySource: null,
      });
      scene.add(motionAtlas.batch);
    }
    exactAtlas.batch.visible = false;
    if (motionAtlas !== null) motionAtlas.batch.visible = false;
    if (surfacePaintEnabled) rebuildSurfaceColors();
    refreshVisibility();
    applyMeshAppearance();
    if (visibleSection === null) setCameraPreset("anterior", false);
    else fitSection(visibleSection, false);
    canvas.dataset.atlasUpright = "true";
    canvas.dataset.logicalBones = String(meshesByBoneId.size);
    canvas.dataset.semanticMeshes = String(atlasMeshes.length);
    canvas.dataset.atlasDimensions = normalizedDimensions.map((value) => value.toFixed(5)).join(",");
    canvas.dataset.atlasRenderer = "batched";
    canvas.dataset.atlasBatchGeometries = String(exactAtlas.geometryCount);
    canvas.dataset.atlasBatchInstances = String(exactAtlas.batch.instanceCount);
    canvas.dataset.atlasExactIndexCount = String(exactAtlas.indexCount);
    canvas.dataset.atlasExactReordered = exactGeometryState.reorderedGeometryCount > 0 ? "true" : "fallback";
    canvas.dataset.atlasExactReorderedGeometries = String(exactGeometryState.reorderedGeometryCount);
    canvas.dataset.atlasExactCompositionChunks = String(exactCompositionChunks.length);
    canvas.dataset.atlasExactCompositionState = "dirty";
    canvas.dataset.atlasMotionIndexCount = String(motionAtlas?.indexCount ?? exactAtlas.indexCount);
    canvas.dataset.atlasMotionIndexRatio = ((motionAtlas?.indexCount ?? exactAtlas.indexCount) / exactAtlas.indexCount)
      .toFixed(5);
    canvas.dataset.atlasMotionTargetIndexRatio = MOTION_LOD_TARGET_INDEX_RATIO.toFixed(5);
    canvas.dataset.atlasMotionErrorBound = MOTION_LOD_MAX_RELATIVE_ERROR.toFixed(5);
    canvas.dataset.atlasMotionMaximumError = (motionGeometryState?.maximumRelativeError ?? 0).toFixed(6);
    canvas.dataset.atlasMotionLod = motionAtlas === null ? "source-only" : "enabled";
    publishCameraSnapshot();
    requestRender();
    await initialPresentationPromise;
    if (disposed) throw new Error("The anatomy atlas scene was disposed before its first exact presentation.");
    return api;
  } catch (error: unknown) {
    dispose();
    throw error;
  }

  function prepareAndVerifyAtlas(root: AtlasRoot): void {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      trackMeshMaterials(object.material);
      const position = object.geometry.getAttribute("position");
      if (position === undefined || position.count === 0) {
        throw new Error(`Atlas mesh ${object.name || "(unnamed)"} has no real geometry.`);
      }

      const boneId = inheritedUserData(object, "boneId");
      const label = inheritedUserData(object, "anatomyLabel");
      const section = inheritedUserData(object, "anatomySection");
      const catalogVersion = inheritedUserData(object, "catalogVersion");
      if (typeof boneId !== "string") {
        throw new Error(`Atlas mesh ${object.name || "(unnamed)"} has no source-owned bone ID.`);
      }
      const record = catalogById.get(boneId);
      if (record === undefined) throw new Error(`Atlas mesh ${object.name} references unknown bone ID ${boneId}.`);
      if (label !== record.name || section !== record.section || catalogVersion !== ANATOMY_CATALOG_VERSION) {
        throw new Error(`Atlas mesh ${object.name} does not exactly match catalogue bone ${boneId}.`);
      }
      if (object.name.length === 0 || sourceNodeNames.has(object.name)) {
        throw new Error(`Atlas mesh ${object.name || "(unnamed)"} has no unique source-object identity.`);
      }

      atlasMeshes.push(object);
      recordByMesh.set(object, record);
      sourceNodeNames.add(object.name);
      const parts = meshesByBoneId.get(boneId) ?? [];
      parts.push(object);
      meshesByBoneId.set(boneId, parts);
    });

    if (atlasMeshes.length !== VERIFIED_ATLAS_SEMANTIC_MESH_COUNT) {
      throw new Error(`Expected 208 semantic source meshes, found ${atlasMeshes.length}.`);
    }
    if (meshesByBoneId.size !== VERIFIED_ATLAS_LOGICAL_BONE_COUNT) {
      throw new Error(`Expected 206 source-owned bone IDs, found ${meshesByBoneId.size}.`);
    }
    for (const record of ADULT_SKELETON_BONES) {
      const parts = meshesByBoneId.get(record.id) ?? [];
      const partCount = parts.length;
      if (partCount !== record.sourceMeshCount) {
        throw new Error(
          `Atlas part-count mismatch for ${record.id}: expected ${record.sourceMeshCount}, found ${partCount}.`,
        );
      }
      if (record.sourceObjects.length !== parts.length) {
        throw new Error(`Atlas source-object mapping for ${record.id} does not match its semantic mesh count.`);
      }
      for (let index = 0; index < parts.length; index += 1) {
        const mesh = parts[index];
        const sourceObject = record.sourceObjects[index];
        if (mesh === undefined || sourceObject === undefined || sourceMeshByName.has(sourceObject)) {
          throw new Error(`Atlas source-object mapping for ${record.id} is incomplete or duplicated.`);
        }
        sourceObjectByMesh.set(mesh, sourceObject);
        sourceMeshByName.set(sourceObject, mesh);
      }
    }
    for (const mesh of atlasMeshes) {
      mesh.material = normalMaterial;
      mesh.visible = false;
    }
  }

  function createExactReorderedGeometries(encoder: AtlasEncoder | null): ExactGeometryState {
    const geometryBySource = new Map<import("three").BufferGeometry, import("three").BufferGeometry>();
    const sourceToReorderedVertexBySource = new Map<import("three").BufferGeometry, Uint32Array>();
    const uniqueSourceGeometries = new Set(atlasMeshes.map((mesh) => mesh.geometry));

    for (const source of uniqueSourceGeometries) {
      const index = source.getIndex();
      const position = source.getAttribute("position");
      const hasMorphTargets = Object.values(source.morphAttributes).some(
        (attributes) => attributes !== undefined && attributes.length > 0,
      );
      const hasPartialDrawRange = source.drawRange.start !== 0 ||
        (Number.isFinite(source.drawRange.count) && source.drawRange.count !== index?.count);
      if (
        index === null ||
        index.itemSize !== 1 ||
        index.count === 0 ||
        index.count % 3 !== 0 ||
        position === undefined ||
        position.count === 0 ||
        hasMorphTargets ||
        source.morphTargetsRelative ||
        source.groups.length > 0 ||
        hasPartialDrawRange
      ) {
        throw new Error(
          "Every verified exact atlas geometry must be a full-range indexed triangle list without groups or morph targets.",
        );
      }

      for (const attribute of Object.values(source.attributes)) {
        if (attribute instanceof THREE.InterleavedBufferAttribute || attribute.count !== position.count) {
          throw new Error(
            "Every verified exact atlas vertex stream must be non-interleaved and aligned to its position stream.",
          );
        }
      }

      const reorderedIndices = new Uint32Array(index.count);
      for (let offset = 0; offset < index.count; offset += 1) {
        const vertexIndex = index.getX(offset);
        if (!Number.isSafeInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= position.count) {
          throw new Error("A verified exact atlas geometry contains an out-of-range triangle index.");
        }
        reorderedIndices[offset] = vertexIndex;
      }

      if (encoder === null) {
        const identity = new Uint32Array(position.count);
        for (let vertex = 0; vertex < position.count; vertex += 1) identity[vertex] = vertex;
        geometryBySource.set(source, source);
        sourceToReorderedVertexBySource.set(source, identity);
      } else {
        const reordered = createGpuReorderedGeometry(
          source,
          reorderedIndices,
          encoder,
          "exact-reordered",
        );
        geometryBySource.set(source, reordered.geometry);
        sourceToReorderedVertexBySource.set(source, reordered.sourceToReorderedVertex);
      }
    }

    return {
      geometryBySource,
      sourceToReorderedVertexBySource,
      reorderedGeometryCount: encoder === null ? 0 : geometryBySource.size,
    };
  }

  function createGpuReorderedGeometry(
    source: import("three").BufferGeometry,
    indices: Uint32Array,
    encoder: AtlasEncoder,
    nameSuffix: "exact-reordered" | "motion-reordered",
  ): ReorderedGeometryResult {
    const position = source.getAttribute("position");
    if (position === undefined) throw new Error("A GPU-reordered atlas geometry has no position stream.");
    const sourceIndexCount = indices.length;
    const [remap, uniqueVertexCount] = encoder.reorderMesh(indices, true, false);
    if (
      indices.length !== sourceIndexCount ||
      uniqueVertexCount <= 0 ||
      uniqueVertexCount > position.count ||
      remap.length > position.count
    ) {
      throw new Error("The atlas geometry reorder returned an invalid vertex mapping.");
    }

    const reorderedGeometry = source.clone();
    reorderedGeometry.name = `${source.name || "atlas-source-geometry"}-${nameSuffix}`;
    for (const [name, attribute] of Object.entries(source.attributes)) {
      if (attribute instanceof THREE.InterleavedBufferAttribute) {
        reorderedGeometry.dispose();
        throw new Error("The atlas geometry reorder cannot copy an interleaved vertex stream.");
      }
      reorderedGeometry.setAttribute(
        name,
        createExactReorderedAttribute(attribute, remap, uniqueVertexCount),
      );
    }
    reorderedGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometries.add(reorderedGeometry);
    return {
      geometry: reorderedGeometry,
      sourceToReorderedVertex: remap,
    };
  }

  function createExactReorderedAttribute(
    source: import("three").BufferAttribute,
    remap: Uint32Array,
    uniqueVertexCount: number,
  ): import("three").BufferAttribute {
    const targetArray = source.array.slice(0, uniqueVertexCount * source.itemSize);
    const target = new THREE.BufferAttribute(targetArray, source.itemSize, source.normalized);
    target.name = source.name;
    target.gpuType = source.gpuType;
    target.setUsage(source.usage);

    const sourceBytes = new Uint8Array(source.array.buffer, source.array.byteOffset, source.array.byteLength);
    const targetBytes = new Uint8Array(target.array.buffer, target.array.byteOffset, target.array.byteLength);
    const vertexByteLength = source.itemSize * source.array.BYTES_PER_ELEMENT;
    for (let sourceVertex = 0; sourceVertex < remap.length; sourceVertex += 1) {
      const targetVertex = remap[sourceVertex];
      if (targetVertex === undefined || targetVertex === 0xffffffff) continue;
      if (targetVertex >= uniqueVertexCount) {
        throw new Error("The exact atlas vertex mapping refers outside the reordered attribute.");
      }
      const sourceOffset = sourceVertex * vertexByteLength;
      const targetOffset = targetVertex * vertexByteLength;
      targetBytes.set(sourceBytes.subarray(sourceOffset, sourceOffset + vertexByteLength), targetOffset);
    }
    return target;
  }

  function createMotionGeometries(simplifier: AtlasSimplifier, encoder: AtlasEncoder): MotionGeometryState {
    const geometryBySource = new Map<import("three").BufferGeometry, import("three").BufferGeometry>();
    let maximumRelativeError = 0;
    for (const source of new Set(atlasMeshes.map((mesh) => mesh.geometry))) {
      const position = source.getAttribute("position");
      const index = source.getIndex();
      if (position === undefined || position.itemSize < 3 || index === null || index.count % 3 !== 0) {
        throw new Error("Every verified motion geometry must contain indexed source triangles and XYZ positions.");
      }

      const sourceIndices = new Uint32Array(index.count);
      for (let offset = 0; offset < index.count; offset += 1) sourceIndices[offset] = index.getX(offset);
      const sourcePositions = new Float32Array(position.count * 3);
      for (let vertex = 0; vertex < position.count; vertex += 1) {
        const offset = vertex * 3;
        sourcePositions[offset] = position.getX(vertex);
        sourcePositions[offset + 1] = position.getY(vertex);
        sourcePositions[offset + 2] = position.getZ(vertex);
      }

      const targetIndexCount = Math.max(
        3,
        Math.floor((index.count * MOTION_LOD_TARGET_INDEX_RATIO) / 3) * 3,
      );
      const [motionIndices, relativeError] = simplifier.simplify(
        sourceIndices,
        sourcePositions,
        3,
        targetIndexCount,
        MOTION_LOD_MAX_RELATIVE_ERROR,
        ["LockBorder"],
      );
      if (
        motionIndices.length === 0 ||
        motionIndices.length % 3 !== 0 ||
        motionIndices.length > index.count ||
        !Number.isFinite(relativeError) ||
        relativeError > MOTION_LOD_MAX_RELATIVE_ERROR + Number.EPSILON
      ) {
        throw new Error("The verified atlas motion simplifier returned an invalid bounded index buffer.");
      }

      const motionGeometry = createGpuReorderedGeometry(
        source,
        motionIndices,
        encoder,
        "motion-reordered",
      );
      geometryBySource.set(source, motionGeometry.geometry);
      maximumRelativeError = Math.max(maximumRelativeError, relativeError);
    }
    return { geometryBySource, maximumRelativeError };
  }

  function createBatchedAtlas(configuration: Readonly<{
    name: string;
    geometryBySource: ReadonlyMap<import("three").BufferGeometry, import("three").BufferGeometry> | null;
    sourceToReorderedVertexBySource: ReadonlyMap<import("three").BufferGeometry, Uint32Array> | null;
  }>): AtlasBatchState {
    type GeometryVariant = Readonly<{
      kind: "direct" | "reflected";
      mesh: AtlasMesh;
      source: import("three").BufferGeometry;
      geometry: import("three").BufferGeometry;
    }>;

    const mirrorX = new THREE.Matrix4().makeScale(-1, 1, 1);
    const variants: GeometryVariant[] = atlasMeshes.map((mesh) => {
      const source = mesh.geometry;
      const prepared = configuration.geometryBySource?.get(source) ?? source;
      const reflected = mesh.matrixWorld.determinant() < 0;
      const geometry = prepared.clone();
      if (reflected) {
        geometry.applyMatrix4(mirrorX);
        reverseTriangleWinding(geometry);
      }
      const position = geometry.getAttribute("position");
      if (position === undefined || position.count === 0) {
        geometry.dispose();
        throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no batchable position stream.`);
      }
      const color = new THREE.Uint8BufferAttribute(new Uint8Array(position.count * 3).fill(255), 3, true);
      color.name = "surface-color";
      color.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("color", color);
      geometries.add(geometry);
      return { kind: reflected ? "reflected" : "direct", mesh, source, geometry };
    });
    variants.sort(
      (left, right) => Number(left.geometry.hasAttribute("uv")) - Number(right.geometry.hasAttribute("uv")),
    );

    const referenceGeometry = variants[0]?.geometry;
    if (referenceGeometry === undefined || referenceGeometry.hasAttribute("uv")) {
      throw new Error("The verified atlas has no position-and-normal geometry for batch initialization.");
    }

    let maximumVertexCount = 0;
    let maximumIndexCount = 0;
    for (const { geometry } of variants) {
      const position = geometry.getAttribute("position");
      const normal = geometry.getAttribute("normal");
      const index = geometry.getIndex();
      if (position === undefined || normal === undefined || normal.count !== position.count || index === null) {
        throw new Error("Every verified atlas batch geometry must have indexed position and normal data.");
      }
      maximumVertexCount += position.count;
      maximumIndexCount += index.count;
    }

    const batch = new THREE.BatchedMesh(
      atlasMeshes.length,
      maximumVertexCount,
      maximumIndexCount,
      normalMaterial,
    );
    batch.name = configuration.name;
    batch.perObjectFrustumCulled = false;
    batch.sortObjects = false;

    const geometryIdByMesh = new Map<AtlasMesh, number>();
    const surfaceTargetByMesh = new Map<AtlasMesh, AtlasSurfaceTarget>();
    let nextVertexStart = 0;
    for (const variant of variants) {
      const geometryId = batch.addGeometry(variant.geometry);
      geometryIdByMesh.set(variant.mesh, geometryId);
      const position = variant.geometry.getAttribute("position");
      if (position === undefined) {
        batch.dispose();
        throw new Error(`Atlas mesh ${variant.mesh.name || "(unnamed)"} lost its batch position stream.`);
      }
      const sourceToBatchVertex = configuration.sourceToReorderedVertexBySource?.get(variant.source);
      const record = recordByMesh.get(variant.mesh);
      if (sourceToBatchVertex !== undefined && record !== undefined) {
        surfaceTargetByMesh.set(variant.mesh, {
          boneId: record.id,
          sourceMesh: variant.mesh,
          sourceObject: sourceObjectForMesh(variant.mesh),
          sourceToBatchVertex,
          vertexCount: position.count,
          vertexStart: nextVertexStart,
        });
      }
      nextVertexStart += position.count;
    }

    const instanceMatrix = new THREE.Matrix4();
    const instanceByMesh = new Map<AtlasMesh, number>();
    const sourceMeshByInstance = new Map<number, AtlasMesh>();
    for (const mesh of atlasMeshes) {
      const reflected = mesh.matrixWorld.determinant() < 0;
      const geometryId = geometryIdByMesh.get(mesh);
      if (geometryId === undefined) {
        batch.dispose();
        throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no verified batch geometry.`);
      }
      const instanceId = batch.addInstance(geometryId);
      instanceMatrix.copy(mesh.matrixWorld);
      if (reflected) instanceMatrix.multiply(mirrorX);
      batch.setMatrixAt(instanceId, instanceMatrix);
      instanceByMesh.set(mesh, instanceId);
      sourceMeshByInstance.set(instanceId, mesh);
    }

    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    return {
      batch,
      geometryCount: variants.length,
      indexCount: maximumIndexCount,
      instanceByMesh,
      sourceMeshByInstance,
      surfaceTargetByMesh,
    };
  }

  function createExactCompositionChunks(): readonly (readonly AtlasMesh[])[] {
    const chunks = Array.from({ length: EXACT_COMPOSITION_CHUNK_COUNT }, () => [] as AtlasMesh[]);
    const indexLoads = Array.from({ length: EXACT_COMPOSITION_CHUNK_COUNT }, () => 0);
    const largestFirst = [...atlasMeshes].sort((left, right) => {
      const leftCount = left.geometry.getIndex()?.count ?? 0;
      const rightCount = right.geometry.getIndex()?.count ?? 0;
      return rightCount - leftCount;
    });

    for (const mesh of largestFirst) {
      const indexCount = mesh.geometry.getIndex()?.count;
      if (indexCount === undefined || indexCount <= 0) {
        throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no exact composition triangles.`);
      }
      let lightestChunkIndex = 0;
      for (let chunkIndex = 1; chunkIndex < indexLoads.length; chunkIndex += 1) {
        const candidateLoad = indexLoads[chunkIndex];
        const lightestLoad = indexLoads[lightestChunkIndex];
        if (candidateLoad === undefined || lightestLoad === undefined) {
          throw new Error("The exact atlas composition chunks are incomplete.");
        }
        if (candidateLoad < lightestLoad) lightestChunkIndex = chunkIndex;
      }
      const chunk = chunks[lightestChunkIndex];
      const currentLoad = indexLoads[lightestChunkIndex];
      if (chunk === undefined || currentLoad === undefined) {
        throw new Error("The exact atlas composition chunk assignment is invalid.");
      }
      chunk.push(mesh);
      indexLoads[lightestChunkIndex] = currentLoad + indexCount;
    }

    if (chunks.reduce((count, chunk) => count + chunk.length, 0) !== atlasMeshes.length) {
      throw new Error("The exact atlas composition did not retain all 208 source-mesh identities.");
    }
    return chunks;
  }

  function reverseTriangleWinding(geometry: import("three").BufferGeometry): void {
    const index = geometry.getIndex();
    if (index === null || index.count % 3 !== 0) {
      throw new Error("A reflected atlas geometry has invalid triangle indices.");
    }
    for (let offset = 0; offset < index.count; offset += 3) {
      const second = index.getX(offset + 1);
      index.setX(offset + 1, index.getX(offset + 2));
      index.setX(offset + 2, second);
    }
    index.needsUpdate = true;
  }

  function normalizeUpright(root: AtlasRoot): readonly [number, number, number] {
    root.updateMatrixWorld(true);
    let bounds = new THREE.Box3().setFromObject(root);
    let size = bounds.getSize(new THREE.Vector3());
    if (size.x > size.y && size.x > size.z) root.rotation.z += Math.PI / 2;
    else if (size.z > size.y && size.z > size.x) root.rotation.x -= Math.PI / 2;
    root.updateMatrixWorld(true);

    if (atlasAppearsUpsideDown()) {
      root.rotation.z += Math.PI;
      root.updateMatrixWorld(true);
    }

    bounds = new THREE.Box3().setFromObject(root);
    size = bounds.getSize(new THREE.Vector3());
    if (!Number.isFinite(size.y) || size.y <= 0) throw new Error("The atlas has invalid geometry bounds.");
    root.scale.multiplyScalar(NORMALIZED_ATLAS_HEIGHT / size.y);
    root.updateMatrixWorld(true);
    const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    root.position.sub(center);
    root.updateMatrixWorld(true);

    const normalized = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    if (!(normalized.y > normalized.x && normalized.y > normalized.z)) {
      throw new Error("The atlas could not be normalized to an upright orientation.");
    }
    return [normalized.x, normalized.y, normalized.z];
  }

  function atlasAppearsUpsideDown(): boolean {
    const skullCenters = atlasMeshes
      .filter((mesh) => recordByMesh.get(mesh)?.section === "skull")
      .map(meshWorldCenter);
    const footCenters = atlasMeshes
      .filter((mesh) => /calcaneus|talus|metatarsal|foot-digit/.test(recordByMesh.get(mesh)?.id ?? ""))
      .map(meshWorldCenter);
    if (skullCenters.length === 0 || footCenters.length === 0) return false;
    return averageY(skullCenters) < averageY(footCenters);
  }

  function createMatcapTexture(): import("three").CanvasTexture {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 64;
    textureCanvas.height = 64;
    const context = textureCanvas.getContext("2d");
    if (context === null) throw new Error("The anatomy atlas could not create its shading texture.");
    const gradient = context.createRadialGradient(21, 17, 2, 32, 32, 43);
    gradient.addColorStop(0, "#fffdf5");
    gradient.addColorStop(0.38, "#dce8e2");
    gradient.addColorStop(0.72, "#78968e");
    gradient.addColorStop(1, "#1b2c29");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  function focusBone(boneId: string, animate = true): void {
    const bounds = boneBounds(boneId);
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const focusedMinimumDistance = Math.max(0.0002, radius * 2.2);
    camera.near = Math.max(0.00002, radius * 0.02);
    camera.updateProjectionMatrix();
    controls.minDistance = focusedMinimumDistance;
    fitBounds(bounds, animate, 1.15, focusedMinimumDistance, 4.7);
  }

  function fitSection(section: AnatomySection, animate = true): void {
    restoreDefaultCameraRange();
    const fittedView = cameraView;
    const bounds = new THREE.Box3().makeEmpty();
    for (const mesh of atlasMeshes) {
      if (recordByMesh.get(mesh)?.section === section) bounds.expandByObject(mesh, true);
    }
    if (bounds.isEmpty()) throw new Error(`The verified atlas section ${section} has no geometry bounds.`);
    fitBounds(bounds, animate, 1.28, 0.72, 5.8);
    cameraView = fittedView;
  }

  function fitBounds(
    bounds: import("three").Box3,
    animate: boolean,
    padding: number,
    minimumDistance: number,
    maximumDistance: number,
  ): void {
    const center = bounds.getCenter(new THREE.Vector3());
    const direction = camera.position.clone().sub(controls.target);
    if (!Number.isFinite(direction.lengthSq()) || direction.lengthSq() < 0.0001) direction.set(0, 0, 1);
    else direction.normalize();
    const fittingUp = Math.abs(direction.dot(camera.up)) > 0.98
      ? new THREE.Vector3(0, 0, 1)
      : camera.up;
    const right = new THREE.Vector3().crossVectors(fittingUp, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    let halfWidth = 0;
    let halfHeight = 0;
    let halfDepth = 0;
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const offset = new THREE.Vector3(x, y, z).sub(center);
          halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
          halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
          halfDepth = Math.max(halfDepth, Math.abs(offset.dot(direction)));
        }
      }
    }
    const verticalRadius = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const horizontalRadius = Math.atan(Math.tan(verticalRadius) * camera.aspect);
    const fittedDistance = Math.max(
      halfWidth / Math.tan(horizontalRadius),
      halfHeight / Math.tan(verticalRadius),
    ) + halfDepth;
    const distance = THREE.MathUtils.clamp(
      fittedDistance * padding,
      minimumDistance,
      maximumDistance,
    );
    cameraView = "custom";
    setCameraPose(center.clone().add(direction.multiplyScalar(distance)), center, animate);
  }

  function setIsolatedBone(boneId: string | null): void {
    if (boneId !== null) requireBoneMeshes(boneId);
    if (boneId !== isolatedBoneId) {
      if (surfaceStrokeDraft !== null) cancelSurfaceStroke();
      surfaceAdjacencyByMesh.clear();
      canvas.dataset.surfacePaintAdjacencyVertices = "0";
    }
    isolatedBoneId = boneId;
    refreshVisibility();
    if (hoveredBoneId !== null && hoveredBoneId !== isolatedBoneId && isolatedBoneId !== null) {
      hoveredBoneId = null;
      options.onHover(null);
    }
    applyMeshAppearance();
    requestRender();
  }

  function setVisibleSection(section: AnatomySection | null): void {
    if (surfaceStrokeDraft !== null) cancelSurfaceStroke();
    surfaceAdjacencyByMesh.clear();
    visibleSection = section;
    isolatedBoneId = null;
    refreshVisibility();
    if (hoveredBoneId !== null && !boneIsVisible(hoveredBoneId)) {
      hoveredBoneId = null;
      options.onHover(null);
    }
    applyMeshAppearance();
    requestRender();
  }

  function setCameraPreset(preset: AtlasCameraPreset, animate = true): void {
    restoreDefaultCameraRange();
    cameraView = preset;
    const target = new THREE.Vector3(0, 0, 0);
    const position = preset === "anterior"
      ? new THREE.Vector3(0, 0.08, CAMERA_DISTANCE)
      : preset === "left"
        ? new THREE.Vector3(-CAMERA_DISTANCE, 0.08, 0)
        : new THREE.Vector3(CAMERA_DISTANCE, 0.08, 0);
    setCameraPose(position, target, animate);
  }

  function restoreDefaultCameraRange(): void {
    controls.minDistance = ORBIT_MIN_DISTANCE;
    if (camera.near === CAMERA_NEAR_PLANE) return;
    camera.near = CAMERA_NEAR_PLANE;
    camera.updateProjectionMatrix();
  }

  function setInteractionMode(mode: AtlasInteractionMode): void {
    if (mode !== "paint" && surfaceStrokeDraft !== null) cancelSurfaceStroke();
    interactionMode = mode;
    controls.enabled = mode === "orbit";
    pointerDown = null;
    paintingPointerId = null;
    pendingSurfacePointer = null;
    canvas.dataset.interactionMode = mode;
    canvas.style.cursor = mode === "paint"
      ? hoveredBoneId === null ? "crosshair" : "cell"
      : hoveredBoneId === null ? "grab" : "pointer";
    requestRender();
  }

  function setSurfaceBrush(brush: SurfacePaintBrush): void {
    requireSurfacePaintEnabled();
    if (
      !Number.isSafeInteger(brush.radiusBps) || brush.radiusBps <= 0 ||
      brush.radiusBps > SURFACE_BRUSH_BASIS_POINTS ||
      !Number.isSafeInteger(brush.hardnessBps) || brush.hardnessBps < 0 ||
      brush.hardnessBps > SURFACE_BRUSH_BASIS_POINTS
    ) {
      throw new Error("The surface brush radius and hardness must be bounded basis-point integers.");
    }
    if (brush.kind === "paint" && !COLORING_PALETTE.some((entry) => entry.id === brush.colorId)) {
      throw new Error(`Unknown anatomy surface-paint color: ${brush.colorId}.`);
    }
    surfaceBrush = brush;
    canvas.dataset.surfacePaintBrush = brush.kind;
    canvas.dataset.surfacePaintRadiusBps = String(brush.radiusBps);
    canvas.dataset.surfacePaintHardnessBps = String(brush.hardnessBps);
  }

  function setSurfaceStrokes(strokes: readonly SurfacePaintStroke[]): void {
    requireSurfacePaintEnabled();
    validateSurfaceStrokes(strokes);
    persistedSurfaceStrokes = strokes;
    surfaceStrokeDraft = null;
    pendingSurfacePointer = null;
    rebuildSurfaceColors();
    publishSurfaceStrokeTelemetry();
    requestRender();
  }

  function clearSurfacePreview(): void {
    if (!surfacePaintEnabled || exactAtlas === null) return;
    surfaceStrokeDraft = null;
    pendingSurfacePointer = null;
    rebuildSurfaceColors();
    publishSurfaceStrokeTelemetry();
    requestRender();
  }

  function setBoneColors(colors: Readonly<Record<string, number>>): void {
    boneColors.clear();
    for (const [boneId, color] of Object.entries(colors)) {
      requireBoneMeshes(boneId);
      if (!Number.isSafeInteger(color) || color < 0 || color > 0xffffff) {
        throw new Error(`The paint color for ${boneId} is outside the supported RGB range.`);
      }
      boneColors.set(boneId, color);
    }
    if (surfacePaintEnabled) rebuildSurfaceColors();
    applyMeshAppearance();
    canvas.dataset.coloredBones = String(boneColors.size);
    requestRender();
  }

  function setBoneColor(boneId: string, color: number | null): void {
    const meshes = requireBoneMeshes(boneId);
    if (color !== null && (!Number.isSafeInteger(color) || color < 0 || color > 0xffffff)) {
      throw new Error(`The paint color for ${boneId} is outside the supported RGB range.`);
    }
    if (color === null) boneColors.delete(boneId);
    else boneColors.set(boneId, color);
    if (surfacePaintEnabled) {
      rebuildSurfaceColors();
      applyMeshAppearance();
      canvas.dataset.coloredBones = String(boneColors.size);
      requestRender();
      return;
    }
    invalidateExactComposition();
    for (const mesh of meshes) setBatchMeshColor(mesh, appearanceColorForBone(boneId));
    canvas.dataset.coloredBones = String(boneColors.size);
    requestRender();
  }

  function setSelectedBone(boneId: string | null): void {
    if (boneId !== null) requireBoneMeshes(boneId);
    selectedBoneId = boneId;
    applyMeshAppearance();
    requestRender();
  }

  function setHoveredBone(boneId: string | null): void {
    if (boneId !== null) requireBoneMeshes(boneId);
    hoveredBoneId = boneId;
    applyMeshAppearance();
    requestRender();
  }

  function projectBone(boneId: string): ProjectedAtlasPoint | null {
    const meshes = meshesByBoneId.get(boneId);
    if (meshes === undefined) return null;
    const point = boneBounds(boneId).getCenter(new THREE.Vector3());
    camera.updateMatrixWorld(true);
    const cameraDirection = camera.getWorldDirection(new THREE.Vector3());
    const inFront = point.clone().sub(camera.position).dot(cameraDirection) > 0;
    const projected = point.clone().project(camera);
    const rect = canvas.getBoundingClientRect();
    const inClipSpace =
      projected.x >= -1 && projected.x <= 1 &&
      projected.y >= -1 && projected.y <= 1 &&
      projected.z >= -1 && projected.z <= 1;
    return {
      x: (projected.x * 0.5 + 0.5) * rect.width,
      y: (-projected.y * 0.5 + 0.5) * rect.height,
      visible: inFront && inClipSpace && meshes.some((mesh) => visibleMeshSet.has(mesh)),
    };
  }

  function requestRender(): void {
    if (disposed || !documentVisible || frameId !== null) return;
    frameId = requestAnimationFrame(renderFrame);
  }

  function renderFrame(now: number): void {
    frameId = null;
    if (disposed || !documentVisible) return;
    const cameraStillMoving = updateCameraMotion(now);
    const controlsChanged = controls.update();
    if (exactAtlas === null) {
      renderer.autoClear = true;
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
      return;
    }
    if (pendingSurfacePointer !== null) flushPendingSurfacePointer();
    if (pointerRaycastPending) updatePointerHit();
    flushSurfaceColorUpload();
    const cameraIsMoving = cameraStillMoving || controlsChanged || controlsInputActive;
    let exactCompositionContinues = false;
    if (cameraIsMoving && motionAtlas !== null) {
      renderMotionFrame();
    } else if (motionAtlas === null) {
      renderSourceDirectFrame();
    } else if (!displayedFrameAvailable) {
      renderMotionFrame();
      exactCompositionContinues = true;
    } else {
      exactCompositionContinues = renderExactCompositionSlice();
    }
    publishCameraSnapshot();
    if (cameraIsMoving || exactCompositionContinues) requestRender();
  }

  function renderMotionFrame(): void {
    const source = exactAtlas;
    const motion = motionAtlas;
    if (source === null || motion === null) throw new Error("The atlas motion frame is unavailable.");
    source.batch.visible = false;
    motion.batch.visible = true;
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    canvas.dataset.atlasDrawCalls = String(renderer.info.render.calls);
    canvas.dataset.atlasRenderQuality = "motion";
    canvas.dataset.atlasExactCompositionState = "motion";
    displayedFrameAvailable = true;
  }

  function renderSourceDirectFrame(): void {
    const source = exactAtlas;
    if (source === null) throw new Error("The exact atlas frame is unavailable.");
    setExactBatchVisibilityForChunk(null);
    source.batch.visible = true;
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
    canvas.dataset.atlasDrawCalls = String(renderer.info.render.calls);
    canvas.dataset.atlasRenderQuality = "source";
    canvas.dataset.atlasExactCompositionState = "settled";
    canvas.dataset.atlasExactCompositionActiveChunks = "1";
    exactComposition = null;
    exactPresentationSettled = true;
    displayedFrameAvailable = true;
    publishInitialPresentation();
  }

  function renderExactCompositionSlice(): boolean {
    const source = exactAtlas;
    if (source === null) throw new Error("The exact atlas composition is unavailable.");
    if (exactPresentationSettled && exactComposition === null) return false;

    if (exactComposition === null) {
      const activeChunkIndexes = exactCompositionChunks
        .map((chunk, chunkIndex) => chunk.some((mesh) => visibleMeshSet.has(mesh)) ? chunkIndex : -1)
        .filter((chunkIndex) => chunkIndex >= 0);
      if (activeChunkIndexes.length === 0) {
        throw new Error("The exact atlas composition has no visible source meshes.");
      }
      exactComposition = {
        revision: exactCompositionRevision,
        activeChunkIndexes,
        cameraSignature: exactCompositionCameraSignature(),
        phaseDurations: [],
        readyToPresent: false,
        nextActiveChunk: 0,
      };
      canvas.dataset.atlasExactCompositionState = "composing";
      canvas.dataset.atlasExactCompositionActiveChunks = String(activeChunkIndexes.length);
    }

    const composition = exactComposition;
    if (
      composition.revision !== exactCompositionRevision ||
      composition.cameraSignature !== exactCompositionCameraSignature()
    ) {
      exactComposition = null;
      return true;
    }
    if (composition.readyToPresent) {
      presentExactComposition(composition);
      return false;
    }
    const chunkIndex = composition.activeChunkIndexes[composition.nextActiveChunk];
    if (chunkIndex === undefined) throw new Error("The exact atlas composition chunk is missing.");

    const phaseStartedAt = performance.now();
    setExactBatchVisibilityForChunk(chunkIndex);
    source.batch.visible = true;
    if (motionAtlas !== null) motionAtlas.batch.visible = false;
    renderer.setRenderTarget(exactPresentationTarget);
    renderer.autoClear = false;
    if (composition.nextActiveChunk === 0) renderer.clear(true, true, true);
    renderer.render(scene, camera);
    renderer.getContext().finish();
    composition.phaseDurations.push(performance.now() - phaseStartedAt);
    canvas.dataset.atlasExactCompositionPhaseDurations = composition.phaseDurations
      .map((duration) => duration.toFixed(2))
      .join(",");
    composition.nextActiveChunk += 1;
    if (composition.nextActiveChunk < composition.activeChunkIndexes.length) return true;
    composition.readyToPresent = true;
    canvas.dataset.atlasExactCompositionState = "ready";
    return true;
  }

  function presentExactComposition(composition: ExactCompositionState): void {
    if (
      composition.revision !== exactCompositionRevision ||
      composition.cameraSignature !== exactCompositionCameraSignature()
    ) {
      exactComposition = null;
      return;
    }
    const source = exactAtlas;
    if (source === null) throw new Error("The exact atlas presentation is unavailable.");
    const presentationStartedAt = performance.now();
    renderer.setRenderTarget(null);
    renderer.autoClear = true;
    setExactBatchVisibilityForChunk(null);
    source.batch.visible = false;
    renderer.render(presentationScene, presentationCamera);
    renderer.getContext().finish();
    canvas.dataset.atlasExactPresentationDuration = (performance.now() - presentationStartedAt).toFixed(2);
    canvas.dataset.atlasDrawCalls = String(renderer.info.render.calls);
    canvas.dataset.atlasRenderQuality = "source";
    canvas.dataset.atlasExactCompositionState = "settled";
    exactComposition = null;
    exactPresentationSettled = true;
    displayedFrameAvailable = true;
    publishInitialPresentation();
  }

  function publishInitialPresentation(): void {
    canvas.dataset.atlasReady = "true";
    const resolve = resolveInitialPresentation;
    if (resolve === null) return;
    resolveInitialPresentation = null;
    resolve();
  }

  function setExactBatchVisibilityForChunk(chunkIndex: number | null): void {
    const source = exactAtlas;
    if (source === null) throw new Error("The exact atlas batch is unavailable for composition.");
    const includedMeshes = chunkIndex === null ? null : exactCompositionChunks[chunkIndex];
    if (chunkIndex !== null && includedMeshes === undefined) {
      throw new Error("The requested exact atlas composition chunk does not exist.");
    }
    const includedMeshSet = includedMeshes === null ? null : new Set(includedMeshes);
    for (const mesh of atlasMeshes) {
      const instanceId = source.instanceByMesh.get(mesh);
      if (instanceId === undefined) {
        throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no exact composition instance.`);
      }
      source.batch.setVisibleAt(instanceId, visibleMeshSet.has(mesh) && (includedMeshSet?.has(mesh) ?? true));
    }
  }

  function exactCompositionCameraSignature(): string {
    camera.updateMatrixWorld(true);
    return [
      ...camera.matrixWorld.elements,
      ...camera.projectionMatrix.elements,
    ].map((value) => value.toFixed(7)).join(",");
  }

  function invalidateExactComposition(): void {
    exactCompositionRevision += 1;
    exactComposition = null;
    exactPresentationSettled = false;
    canvas.dataset.atlasExactCompositionState = "dirty";
  }

  function updatePointerHit(): void {
    pointerRaycastPending = false;
    if (latestPointer === null) return;
    const hit = raycastAt(latestPointer.x, latestPointer.y);
    const nextBoneId = hit?.boneId ?? null;
    const changed = nextBoneId !== hoveredBoneId;
    if (changed) {
      hoveredBoneId = nextBoneId;
      applyMeshAppearance();
      canvas.style.cursor = interactionMode === "paint"
        ? nextBoneId === null ? "crosshair" : "cell"
        : nextBoneId === null ? "grab" : "pointer";
    }
    if (changed || hit !== null) options.onHover(hit);
  }

  function paintAt(clientX: number, clientY: number, phase: AtlasPaintPhase, pressure = 1): void {
    const hit = raycastAt(clientX, clientY, pressure);
    if (hit === null) return;
    if (surfacePaintEnabled && surfaceBrush !== null) {
      previewSurfaceHit(hit, phase);
      if (options.onSurfaceStrokeCommit === undefined) options.onPaint?.(hit, phase);
      return;
    }
    options.onPaint?.(hit, phase);
  }

  function raycastAt(clientX: number, clientY: number, pressure = 1): AtlasHit | null {
    const rect = canvas.getBoundingClientRect();
    if (
      rect.width <= 0 || rect.height <= 0 ||
      clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom
    ) return null;
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const source = exactAtlas;
    if (source === null) return null;
    const intersection = raycaster.intersectObjects(visibleMeshes, false)[0];
    if (intersection === undefined) return null;
    const sourceMesh = intersection.object;
    if (!(sourceMesh instanceof THREE.Mesh)) return null;
    const record = recordByMesh.get(sourceMesh);
    const faceIndex = intersection.faceIndex;
    const index = sourceMesh.geometry.getIndex();
    const position = sourceMesh.geometry.getAttribute("position");
    if (record === undefined || faceIndex === undefined || faceIndex === null || index === null || position === undefined) {
      return null;
    }
    const indexOffset = faceIndex * 3;
    if (indexOffset < 0 || indexOffset + 2 >= index.count) return null;
    const vertexA = index.getX(indexOffset);
    const vertexB = index.getX(indexOffset + 1);
    const vertexC = index.getX(indexOffset + 2);
    const localPoint = sourceMesh.worldToLocal(intersection.point.clone());
    const barycentric = THREE.Triangle.getBarycoord(
      localPoint,
      new THREE.Vector3().fromBufferAttribute(position, vertexA),
      new THREE.Vector3().fromBufferAttribute(position, vertexB),
      new THREE.Vector3().fromBufferAttribute(position, vertexC),
      new THREE.Vector3(),
    );
    if (barycentric === null) return null;
    const barycentricTotal = Math.max(0, barycentric.x) + Math.max(0, barycentric.y) + Math.max(0, barycentric.z);
    if (!(barycentricTotal > 0)) return null;
    const normalizedBarycentric: readonly [number, number, number] = [
      Math.max(0, barycentric.x) / barycentricTotal,
      Math.max(0, barycentric.y) / barycentricTotal,
      Math.max(0, barycentric.z) / barycentricTotal,
    ];
    return {
      boneId: record.id,
      label: record.name,
      section: record.section,
      sourceObject: sourceObjectForMesh(sourceMesh),
      faceIndex,
      barycentric: normalizedBarycentric,
      pressure: clampUnitPressure(pressure),
      boneScale: boneScale(record.id),
      worldPoint: [intersection.point.x, intersection.point.y, intersection.point.z],
    };
  }

  function pointerPressure(event: PointerEvent): number {
    if (event.pointerType === "mouse" || event.pressure <= 0) return 1;
    return clampUnitPressure(event.pressure);
  }

  function clampUnitPressure(pressure: number): number {
    if (!Number.isFinite(pressure)) return 1;
    return Math.min(1, Math.max(0, pressure));
  }

  function flushPendingSurfacePointer(): void {
    const sample = pendingSurfacePointer;
    pendingSurfacePointer = null;
    if (sample === null) return;
    paintAt(sample.clientX, sample.clientY, "move", sample.pressure);
  }

  function previewSurfaceHit(hit: AtlasHit, phase: AtlasPaintPhase): void {
    const brush = surfaceBrush;
    if (brush === null || exactAtlas === null) return;
    if (isolatedBoneId === null || hit.boneId !== isolatedBoneId) return;

    if (phase === "start" || surfaceStrokeDraft === null) {
      surfaceStrokeDraft = {
        id: crypto.randomUUID(),
        boneId: hit.boneId,
        brush,
        anchors: [],
        lastWorldPoint: null,
      };
    }
    const draft = surfaceStrokeDraft;
    if (draft.boneId !== hit.boneId) return;
    if (draft.anchors.length >= MAX_SURFACE_PAINT_ANCHORS_PER_STROKE) return;

    const radius = hit.boneScale * draft.brush.radiusBps / SURFACE_BRUSH_BASIS_POINTS;
    const previousPoint = draft.lastWorldPoint;
    if (
      previousPoint !== null &&
      Math.hypot(
        hit.worldPoint[0] - previousPoint[0],
        hit.worldPoint[1] - previousPoint[1],
        hit.worldPoint[2] - previousPoint[2],
      ) < radius * SURFACE_STAMP_SPACING_RATIO
    ) return;

    const anchor: SurfacePaintAnchor = {
      sourceObject: hit.sourceObject,
      faceIndex: hit.faceIndex,
      barycentric: quantizeSurfaceBarycentric(hit.barycentric),
      pressure: quantizeSurfacePressure(hit.pressure),
    };
    const changedVertices = applySurfaceAnchor({ boneId: hit.boneId, brush: draft.brush, anchor });
    if (changedVertices === 0) return;
    draft.anchors.push(anchor);
    draft.lastWorldPoint = hit.worldPoint;
    canvas.dataset.surfacePaintPreviewAnchors = String(draft.anchors.length);
    canvas.dataset.surfacePaintLastStampVertices = String(changedVertices);
    canvas.dataset.surfacePaintPaintedVertices = String(surfacePaintedVertices.size);
    invalidateExactComposition();
    requestRender();
  }

  function finishSurfaceStroke(): void {
    const draft = surfaceStrokeDraft;
    surfaceStrokeDraft = null;
    pendingSurfacePointer = null;
    canvas.dataset.surfacePaintPreviewAnchors = "0";
    if (draft === null || draft.anchors.length === 0) return;
    const stroke: SurfacePaintStroke = {
      id: draft.id,
      boneId: draft.boneId,
      brush: draft.brush,
      anchors: [...draft.anchors],
    };
    options.onSurfaceStrokeCommit?.(stroke);
  }

  function cancelSurfaceStroke(): void {
    const hadPreview = surfaceStrokeDraft !== null;
    if (paintingPointerId !== null && canvas.hasPointerCapture(paintingPointerId)) {
      canvas.releasePointerCapture(paintingPointerId);
    }
    paintingPointerId = null;
    surfaceStrokeDraft = null;
    pendingSurfacePointer = null;
    canvas.dataset.surfacePaintPreviewAnchors = "0";
    if (hadPreview) rebuildSurfaceColors();
    requestRender();
  }

  function requireSurfacePaintEnabled(): void {
    if (!surfacePaintEnabled) throw new Error("Surface painting is available only inside an anatomy coloring lab.");
  }

  function validateSurfaceStrokes(strokes: readonly SurfacePaintStroke[]): void {
    if (strokes.length > MAX_SURFACE_PAINT_STROKES) {
      throw new Error(`Surface painting supports at most ${MAX_SURFACE_PAINT_STROKES} strokes per lab.`);
    }
    let anchorCount = 0;
    for (const stroke of strokes) {
      requireBoneMeshes(stroke.boneId);
      if (stroke.anchors.length === 0 || stroke.anchors.length > MAX_SURFACE_PAINT_ANCHORS_PER_STROKE) {
        throw new Error("A surface stroke has an invalid number of anchors.");
      }
      anchorCount += stroke.anchors.length;
      if (anchorCount > MAX_SURFACE_PAINT_ANCHORS) {
        throw new Error(`Surface painting supports at most ${MAX_SURFACE_PAINT_ANCHORS} anchors per lab.`);
      }
      validateSurfaceBrush(stroke.brush);
      for (const anchor of stroke.anchors) requireSurfaceAnchorTarget(stroke.boneId, anchor);
    }
  }

  function validateSurfaceBrush(brush: SurfacePaintBrush): void {
    if (
      !Number.isSafeInteger(brush.radiusBps) || brush.radiusBps <= 0 ||
      brush.radiusBps > SURFACE_BRUSH_BASIS_POINTS ||
      !Number.isSafeInteger(brush.hardnessBps) || brush.hardnessBps < 0 ||
      brush.hardnessBps > SURFACE_BRUSH_BASIS_POINTS
    ) throw new Error("A surface stroke contains an invalid brush.");
    if (brush.kind === "paint" && !COLORING_PALETTE.some((entry) => entry.id === brush.colorId)) {
      throw new Error(`A surface stroke contains unknown color ${brush.colorId}.`);
    }
  }

  function requireSurfaceAnchorTarget(boneId: string, anchor: SurfacePaintAnchor): AtlasSurfaceTarget {
    const sourceMesh = sourceMeshByName.get(anchor.sourceObject);
    const target = sourceMesh === undefined ? undefined : exactAtlas?.surfaceTargetByMesh.get(sourceMesh);
    if (sourceMesh === undefined || target === undefined || target.boneId !== boneId) {
      throw new Error(`Surface anchor ${anchor.sourceObject} does not belong to verified bone ${boneId}.`);
    }
    if (
      !Number.isSafeInteger(anchor.faceIndex) || anchor.faceIndex < 0 ||
      !Number.isSafeInteger(anchor.barycentric[0]) || anchor.barycentric[0] < 0 ||
      !Number.isSafeInteger(anchor.barycentric[1]) || anchor.barycentric[1] < 0 ||
      anchor.barycentric[0] + anchor.barycentric[1] > SURFACE_BARYCENTRIC_QUANTIZATION ||
      !Number.isSafeInteger(anchor.pressure) || anchor.pressure < 0 ||
      anchor.pressure > SURFACE_PRESSURE_QUANTIZATION
    ) throw new Error("A surface anchor contains invalid quantized coordinates.");
    requireSurfaceFaceVertices(sourceMesh, anchor.faceIndex);
    return target;
  }

  function rebuildSurfaceColors(): void {
    const source = exactAtlas;
    if (!surfacePaintEnabled || source === null) return;
    const colorAttribute = requireSurfaceColorAttribute(source);
    surfacePaintedVertices.clear();
    for (const target of source.surfaceTargetByMesh.values()) {
      const base = surfaceBaseColor(target.boneId);
      for (let vertex = 0; vertex < target.vertexCount; vertex += 1) {
        colorAttribute.setXYZ(target.vertexStart + vertex, base.r, base.g, base.b);
      }
    }
    for (const stroke of persistedSurfaceStrokes) {
      for (const anchor of stroke.anchors) {
        applySurfaceAnchor({ boneId: stroke.boneId, brush: stroke.brush, anchor });
      }
    }
    surfaceDirtyVertexStart = 0;
    surfaceDirtyVertexEnd = colorAttribute.count - 1;
    canvas.dataset.surfacePaintPaintedVertices = String(surfacePaintedVertices.size);
    invalidateExactComposition();
  }

  function applySurfaceAnchor(input: Readonly<{
    boneId: string;
    brush: SurfacePaintBrush;
    anchor: SurfacePaintAnchor;
  }>): number {
    const source = exactAtlas;
    if (source === null) return 0;
    const target = requireSurfaceAnchorTarget(input.boneId, input.anchor);
    const sourceMesh = target.sourceMesh;
    const faceVertices = requireSurfaceFaceVertices(sourceMesh, input.anchor.faceIndex);
    const adjacency = surfaceAdjacency(sourceMesh);
    const barycentricB = input.anchor.barycentric[0] / SURFACE_BARYCENTRIC_QUANTIZATION;
    const barycentricC = input.anchor.barycentric[1] / SURFACE_BARYCENTRIC_QUANTIZATION;
    const barycentricA = 1 - barycentricB - barycentricC;
    const worldPoint = new THREE.Vector3();
    for (const [vertex, weight] of [
      [faceVertices[0], barycentricA],
      [faceVertices[1], barycentricB],
      [faceVertices[2], barycentricC],
    ] satisfies readonly (readonly [number, number])[]) {
      const offset = vertex * 3;
      worldPoint.x += (adjacency.worldPositions[offset] ?? 0) * weight;
      worldPoint.y += (adjacency.worldPositions[offset + 1] ?? 0) * weight;
      worldPoint.z += (adjacency.worldPositions[offset + 2] ?? 0) * weight;
    }

    const pressure = input.anchor.pressure / SURFACE_PRESSURE_QUANTIZATION;
    const nominalRadius = boneScale(input.boneId) * input.brush.radiusBps / SURFACE_BRUSH_BASIS_POINTS;
    const radius = nominalRadius * (0.3 + 0.7 * pressure);
    if (!(radius > 0)) return 0;
    const hardness = input.brush.hardnessBps / SURFACE_BRUSH_BASIS_POINTS;
    const colorAttribute = requireSurfaceColorAttribute(source);
    const baseColor = surfaceBaseColor(input.boneId);
    const targetColor = input.brush.kind === "erase"
      ? baseColor
      : surfacePaletteColor(input.brush.colorId);
    const distances = new Map<number, number>();
    const heapVertices: number[] = [];
    const heapDistances: number[] = [];
    for (const vertex of faceVertices) {
      const distance = surfaceVertexDistance(adjacency, vertex, worldPoint);
      if (distance < (distances.get(vertex) ?? Number.POSITIVE_INFINITY)) {
        distances.set(vertex, distance);
        surfaceHeapPush(heapVertices, heapDistances, vertex, distance);
      }
    }

    let changedVertices = 0;
    while (heapVertices.length > 0) {
      const next = surfaceHeapPop(heapVertices, heapDistances);
      if (next === null || next.distance > radius) break;
      if (next.distance !== distances.get(next.vertex)) continue;
      const mappedVertex = target.sourceToBatchVertex[next.vertex];
      if (mappedVertex !== undefined && mappedVertex !== 0xffffffff && mappedVertex < target.vertexCount) {
        const globalVertex = target.vertexStart + mappedVertex;
        const falloff = surfaceBrushFalloff(next.distance / radius, hardness) * pressure;
        if (falloff > 0) {
          const red = THREE.MathUtils.lerp(colorAttribute.getX(globalVertex), targetColor.r, falloff);
          const green = THREE.MathUtils.lerp(colorAttribute.getY(globalVertex), targetColor.g, falloff);
          const blue = THREE.MathUtils.lerp(colorAttribute.getZ(globalVertex), targetColor.b, falloff);
          colorAttribute.setXYZ(globalVertex, red, green, blue);
          updateSurfacePaintedVertex(globalVertex, baseColor, colorAttribute);
          queueSurfaceColorUpload(globalVertex);
          changedVertices += 1;
        }
      }

      const fromOffset = next.vertex * 3;
      for (const neighbor of adjacency.neighbors[next.vertex] ?? []) {
        const toOffset = neighbor * 3;
        const edgeLength = Math.hypot(
          (adjacency.worldPositions[toOffset] ?? 0) - (adjacency.worldPositions[fromOffset] ?? 0),
          (adjacency.worldPositions[toOffset + 1] ?? 0) - (adjacency.worldPositions[fromOffset + 1] ?? 0),
          (adjacency.worldPositions[toOffset + 2] ?? 0) - (adjacency.worldPositions[fromOffset + 2] ?? 0),
        );
        const candidate = next.distance + edgeLength;
        if (candidate <= radius && candidate < (distances.get(neighbor) ?? Number.POSITIVE_INFINITY)) {
          distances.set(neighbor, candidate);
          surfaceHeapPush(heapVertices, heapDistances, neighbor, candidate);
        }
      }
    }
    return changedVertices;
  }

  function surfaceAdjacency(sourceMesh: AtlasMesh): AtlasSurfaceAdjacency {
    const cached = surfaceAdjacencyByMesh.get(sourceMesh);
    if (cached !== undefined) return cached;
    const position = sourceMesh.geometry.getAttribute("position");
    const index = sourceMesh.geometry.getIndex();
    if (position === undefined || index === null) {
      throw new Error(`Surface source ${sourceMesh.name} has no indexed topology.`);
    }
    const neighborSets = Array.from({ length: position.count }, () => new Set<number>());
    for (let offset = 0; offset < index.count; offset += 3) {
      const a = index.getX(offset);
      const b = index.getX(offset + 1);
      const c = index.getX(offset + 2);
      neighborSets[a]?.add(b);
      neighborSets[a]?.add(c);
      neighborSets[b]?.add(a);
      neighborSets[b]?.add(c);
      neighborSets[c]?.add(a);
      neighborSets[c]?.add(b);
    }
    const verticesByPosition = new Map<string, number[]>();
    for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
      const key = `${position.getX(vertexIndex)},${position.getY(vertexIndex)},${position.getZ(vertexIndex)}`;
      const colocated = verticesByPosition.get(key) ?? [];
      colocated.push(vertexIndex);
      verticesByPosition.set(key, colocated);
    }
    let weldedVertexCount = 0;
    for (const colocated of verticesByPosition.values()) {
      const first = colocated[0];
      if (first === undefined || colocated.length < 2) continue;
      weldedVertexCount += colocated.length - 1;
      for (let indexValue = 1; indexValue < colocated.length; indexValue += 1) {
        const duplicate = colocated[indexValue];
        if (duplicate === undefined) continue;
        neighborSets[first]?.add(duplicate);
        neighborSets[duplicate]?.add(first);
      }
    }
    const worldPositions = new Float32Array(position.count * 3);
    const vertex = new THREE.Vector3();
    for (let indexValue = 0; indexValue < position.count; indexValue += 1) {
      vertex.fromBufferAttribute(position, indexValue).applyMatrix4(sourceMesh.matrixWorld);
      const offset = indexValue * 3;
      worldPositions[offset] = vertex.x;
      worldPositions[offset + 1] = vertex.y;
      worldPositions[offset + 2] = vertex.z;
    }
    const adjacency = {
      neighbors: neighborSets.map((neighbors) => Uint32Array.from(neighbors)),
      worldPositions,
      weldedVertexCount,
    } satisfies AtlasSurfaceAdjacency;
    surfaceAdjacencyByMesh.set(sourceMesh, adjacency);
    canvas.dataset.surfacePaintAdjacencyVertices = String(position.count);
    canvas.dataset.surfacePaintWeldedVertices = String(weldedVertexCount);
    return adjacency;
  }

  function requireSurfaceFaceVertices(sourceMesh: AtlasMesh, faceIndex: number): readonly [number, number, number] {
    const index = sourceMesh.geometry.getIndex();
    const position = sourceMesh.geometry.getAttribute("position");
    const offset = faceIndex * 3;
    if (
      index === null || position === undefined || !Number.isSafeInteger(faceIndex) || faceIndex < 0 ||
      offset + 2 >= index.count
    ) throw new Error(`Surface anchor face ${faceIndex} is outside ${sourceMesh.name}.`);
    const a = index.getX(offset);
    const b = index.getX(offset + 1);
    const c = index.getX(offset + 2);
    if (a >= position.count || b >= position.count || c >= position.count) {
      throw new Error(`Surface anchor face ${faceIndex} has invalid vertices in ${sourceMesh.name}.`);
    }
    return [a, b, c];
  }

  function surfaceVertexDistance(
    adjacency: AtlasSurfaceAdjacency,
    vertex: number,
    point: import("three").Vector3,
  ): number {
    const offset = vertex * 3;
    return Math.hypot(
      (adjacency.worldPositions[offset] ?? 0) - point.x,
      (adjacency.worldPositions[offset + 1] ?? 0) - point.y,
      (adjacency.worldPositions[offset + 2] ?? 0) - point.z,
    );
  }

  function surfaceHeapPush(vertices: number[], distances: number[], vertex: number, distance: number): void {
    let index = vertices.length;
    vertices.push(vertex);
    distances.push(distance);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentDistance = distances[parent];
      if (parentDistance === undefined || parentDistance <= distance) break;
      vertices[index] = vertices[parent] ?? vertex;
      distances[index] = parentDistance;
      index = parent;
    }
    vertices[index] = vertex;
    distances[index] = distance;
  }

  function surfaceHeapPop(
    vertices: number[],
    distances: number[],
  ): Readonly<{ vertex: number; distance: number }> | null {
    const vertex = vertices[0];
    const distance = distances[0];
    const finalVertex = vertices.pop();
    const finalDistance = distances.pop();
    if (vertex === undefined || distance === undefined || finalVertex === undefined || finalDistance === undefined) {
      return null;
    }
    if (vertices.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= vertices.length) break;
        const leftDistance = distances[left] ?? Number.POSITIVE_INFINITY;
        const rightDistance = distances[right] ?? Number.POSITIVE_INFINITY;
        const child = right < vertices.length && rightDistance < leftDistance ? right : left;
        const childDistance = distances[child] ?? Number.POSITIVE_INFINITY;
        if (finalDistance <= childDistance) break;
        vertices[index] = vertices[child] ?? finalVertex;
        distances[index] = childDistance;
        index = child;
      }
      vertices[index] = finalVertex;
      distances[index] = finalDistance;
    }
    return { vertex, distance };
  }

  function surfaceBrushFalloff(distanceRatio: number, hardness: number): number {
    if (distanceRatio >= 1) return 0;
    if (distanceRatio <= hardness || hardness >= 0.9999) return 1;
    const feather = (distanceRatio - hardness) / (1 - hardness);
    const smooth = feather * feather * (3 - 2 * feather);
    return 1 - smooth;
  }

  function requireSurfaceColorAttribute(source: AtlasBatchState): import("three").BufferAttribute {
    const color = source.batch.geometry.getAttribute("color");
    if (
      color === undefined || color instanceof THREE.InterleavedBufferAttribute || color.itemSize !== 3 ||
      !color.normalized || !(color.array instanceof Uint8Array)
    ) {
      throw new Error("The exact anatomy batch has no normalized RGB surface-color stream.");
    }
    return color;
  }

  function surfaceBaseColor(boneId: string): import("three").Color {
    return new THREE.Color().setHex(boneColors.get(boneId) ?? SURFACE_NEUTRAL_COLOR);
  }

  function surfacePaletteColor(colorId: ColoringColorId): import("three").Color {
    const paletteColor = COLORING_PALETTE.find((entry) => entry.id === colorId);
    if (paletteColor === undefined) throw new Error(`Unknown anatomy surface-paint color: ${colorId}.`);
    return new THREE.Color(paletteColor.hex);
  }

  function updateSurfacePaintedVertex(
    globalVertex: number,
    base: import("three").Color,
    color: import("three").BufferAttribute,
  ): void {
    const differs =
      Math.abs(color.getX(globalVertex) - base.r) > 1 / 255 ||
      Math.abs(color.getY(globalVertex) - base.g) > 1 / 255 ||
      Math.abs(color.getZ(globalVertex) - base.b) > 1 / 255;
    if (differs) surfacePaintedVertices.add(globalVertex);
    else surfacePaintedVertices.delete(globalVertex);
  }

  function queueSurfaceColorUpload(globalVertex: number): void {
    surfaceDirtyVertexStart = Math.min(surfaceDirtyVertexStart, globalVertex);
    surfaceDirtyVertexEnd = Math.max(surfaceDirtyVertexEnd, globalVertex);
  }

  function flushSurfaceColorUpload(): void {
    const source = exactAtlas;
    if (source === null || surfaceDirtyVertexEnd < surfaceDirtyVertexStart) return;
    const color = requireSurfaceColorAttribute(source);
    const vertexCount = surfaceDirtyVertexEnd - surfaceDirtyVertexStart + 1;
    color.clearUpdateRanges();
    color.addUpdateRange(surfaceDirtyVertexStart * 3, vertexCount * 3);
    color.needsUpdate = true;
    canvas.dataset.surfacePaintUploadVertices = String(vertexCount);
    surfaceDirtyVertexStart = Number.POSITIVE_INFINITY;
    surfaceDirtyVertexEnd = -1;
  }

  function publishSurfaceStrokeTelemetry(): void {
    canvas.dataset.surfacePaintStrokes = String(persistedSurfaceStrokes.length);
    canvas.dataset.surfacePaintAnchors = String(
      persistedSurfaceStrokes.reduce((count, stroke) => count + stroke.anchors.length, 0),
    );
    canvas.dataset.surfacePaintPaintedVertices = String(surfacePaintedVertices.size);
  }

  function boneScale(boneId: string): number {
    const cached = boneScaleById.get(boneId);
    if (cached !== undefined) return cached;
    const diameter = boneBounds(boneId).getBoundingSphere(new THREE.Sphere()).radius * 2;
    if (!(diameter > 0) || !Number.isFinite(diameter)) {
      throw new Error(`Verified atlas bone ${boneId} has no finite surface-paint scale.`);
    }
    boneScaleById.set(boneId, diameter);
    return diameter;
  }

  function clearPointerHitForCameraMotion(): void {
    pointerRaycastPending = false;
    if (hoveredBoneId === null) return;
    hoveredBoneId = null;
    applyMeshAppearance();
    options.onHover(null);
    canvas.style.cursor = interactionMode === "paint" ? "crosshair" : "grab";
  }

  function setCameraPose(position: AtlasVector, target: AtlasVector, animate: boolean): void {
    invalidateExactComposition();
    displayedFrameAvailable = false;
    clearPointerHitForCameraMotion();
    if (!animate) {
      cameraMotion = null;
      camera.position.copy(position);
      controls.target.copy(target);
      controls.update();
      publishCameraSnapshot();
      requestRender();
      return;
    }
    cameraMotion = {
      startedAt: performance.now(),
      duration: CAMERA_ANIMATION_MS,
      fromPosition: camera.position.clone(),
      toPosition: position.clone(),
      fromTarget: controls.target.clone(),
      toTarget: target.clone(),
    };
    requestRender();
  }

  function updateCameraMotion(now: number): boolean {
    const motion = cameraMotion;
    if (motion === null) return false;
    const progress = Math.min(1, Math.max(0, (now - motion.startedAt) / motion.duration));
    const eased = 1 - Math.pow(1 - progress, 4);
    camera.position.lerpVectors(motion.fromPosition, motion.toPosition, eased);
    controls.target.lerpVectors(motion.fromTarget, motion.toTarget, eased);
    if (progress >= 1) {
      cameraMotion = null;
    }
    return progress < 1;
  }

  function cameraSnapshot(): AtlasCameraSnapshot {
    return {
      view: cameraView,
      position: [camera.position.x, camera.position.y, camera.position.z],
      distance: camera.position.distanceTo(controls.target),
    };
  }

  function publishCameraSnapshot(force = false): void {
    const snapshot = cameraSnapshot();
    const signature = [
      snapshot.view,
      ...snapshot.position.map((value) => value.toFixed(5)),
      snapshot.distance.toFixed(5),
    ].join("|");
    if (!force && signature === lastCameraSignature) return;
    lastCameraSignature = signature;
    canvas.dataset.cameraView = snapshot.view;
    canvas.dataset.cameraPosition = snapshot.position.map((value) => value.toFixed(5)).join(",");
    canvas.dataset.cameraDistance = snapshot.distance.toFixed(5);
    options.onCameraChange?.(snapshot);
  }

  function refreshVisibility(): void {
    const source = exactAtlas;
    if (source === null) throw new Error("The verified source atlas batch is not ready.");
    visibleMeshes.length = 0;
    visibleMeshSet.clear();
    for (const mesh of atlasMeshes) {
      const record = recordByMesh.get(mesh);
      const visible = record !== undefined &&
        (visibleSection === null || record.section === visibleSection) &&
        (isolatedBoneId === null || record.id === isolatedBoneId);
      const sourceInstanceId = source.instanceByMesh.get(mesh);
      if (sourceInstanceId === undefined) {
        throw new Error(`Atlas mesh ${mesh.name} has no verified source batch instance.`);
      }
      mesh.visible = false;
      source.batch.setVisibleAt(sourceInstanceId, visible);
      if (motionAtlas !== null) {
        const motionInstanceId = motionAtlas.instanceByMesh.get(mesh);
        if (motionInstanceId === undefined) {
          throw new Error(`Atlas mesh ${mesh.name} has no verified motion batch instance.`);
        }
        motionAtlas.batch.setVisibleAt(motionInstanceId, visible);
      }
      if (visible) {
        visibleMeshes.push(mesh);
        visibleMeshSet.add(mesh);
      }
    }
    canvas.dataset.visibleSection = visibleSection ?? "all";
    canvas.dataset.visibleSemanticMeshes = String(visibleMeshes.length);
    invalidateExactComposition();
  }

  function applyMeshAppearance(): void {
    invalidateExactComposition();
    for (const mesh of atlasMeshes) {
      const boneId = recordByMesh.get(mesh)?.id;
      setBatchMeshColor(mesh, boneId === undefined ? 0xeee9dd : appearanceColorForBone(boneId));
    }
  }

  function appearanceColorForBone(boneId: string): number {
    if (surfacePaintEnabled) return 0xffffff;
    if (boneId === selectedBoneId) return 0xf2c66d;
    if (boneId === hoveredBoneId) return 0x6ee7d8;
    return boneColors.get(boneId) ?? 0xeee9dd;
  }

  function setBatchMeshColor(mesh: AtlasMesh, color: number): void {
    const source = exactAtlas;
    const sourceInstanceId = source?.instanceByMesh.get(mesh);
    if (source === null || sourceInstanceId === undefined) {
      throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no verified source batch color target.`);
    }
    source.batch.setColorAt(sourceInstanceId, appearanceColor.setHex(color));
    if (motionAtlas !== null) {
      const motionInstanceId = motionAtlas.instanceByMesh.get(mesh);
      if (motionInstanceId === undefined) {
        throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no verified motion batch color target.`);
      }
      motionAtlas.batch.setColorAt(motionInstanceId, appearanceColor);
    }
  }

  function boneIsVisible(boneId: string): boolean {
    return requireBoneMeshes(boneId).some((mesh) => visibleMeshSet.has(mesh));
  }

  function requireBoneMeshes(boneId: string): readonly AtlasMesh[] {
    const meshes = meshesByBoneId.get(boneId);
    if (meshes === undefined) throw new Error(`No verified atlas bone has ID ${boneId}.`);
    return meshes;
  }

  function sourceObjectForMesh(mesh: AtlasMesh): string {
    const sourceObject = sourceObjectByMesh.get(mesh);
    if (sourceObject === undefined) {
      throw new Error(`Atlas mesh ${mesh.name || "(unnamed)"} has no verified catalogue source object.`);
    }
    return sourceObject;
  }

  function boneBounds(boneId: string): import("three").Box3 {
    const bounds = new THREE.Box3();
    bounds.makeEmpty();
    for (const mesh of requireBoneMeshes(boneId)) bounds.expandByObject(mesh, true);
    if (bounds.isEmpty()) throw new Error(`Verified atlas bone ${boneId} has empty geometry bounds.`);
    return bounds;
  }

  function meshWorldCenter(mesh: AtlasMesh): AtlasVector {
    return new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  }

  function averageY(points: readonly AtlasVector[]): number {
    return points.reduce((sum, point) => sum + point.y, 0) / points.length;
  }

  function inheritedUserData(object: import("three").Object3D, key: string): unknown {
    let current: import("three").Object3D | null = object;
    while (current !== null) {
      if (Object.prototype.hasOwnProperty.call(current.userData, key)) {
        const value: unknown = Reflect.get(current.userData, key);
        return value;
      }
      current = current.parent;
    }
    return undefined;
  }

  function resizeRenderer(): void {
    if (disposed) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    if (width === renderedWidth && height === renderedHeight && pixelRatio === renderedPixelRatio) return;
    renderedWidth = width;
    renderedHeight = height;
    renderedPixelRatio = pixelRatio;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    exactPresentationTarget.setSize(
      Math.max(1, Math.round(width * pixelRatio)),
      Math.max(1, Math.round(height * pixelRatio)),
    );
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    displayedFrameAvailable = false;
    invalidateExactComposition();
    if (latestPointer !== null) pointerRaycastPending = true;
    publishCameraSnapshot(true);
    requestRender();
  }

  function trackMeshMaterials(material: import("three").Material | import("three").Material[]): void {
    if (Array.isArray(material)) {
      for (const item of material) trackMaterial(item);
      return;
    }
    trackMaterial(material);
  }

  function trackMaterial(material: import("three").Material): void {
    materials.add(material);
    for (const key of Object.keys(material)) {
      const value: unknown = Reflect.get(material, key);
      if (value instanceof THREE.Texture) textures.add(value);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    canvas.removeEventListener("pointerenter", handlePointerEnter);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerleave", handlePointerLeave);
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointerup", handlePointerUp);
    canvas.removeEventListener("pointercancel", handlePointerCancel);
    controls.removeEventListener("start", handleControlsStart);
    controls.removeEventListener("change", handleControlsChange);
    controls.removeEventListener("end", handleControlsEnd);
    controls.dispose();

    atlasRoot?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      trackMeshMaterials(object.material);
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    exactAtlas?.batch.dispose();
    motionAtlas?.batch.dispose();
    renderer.setRenderTarget(null);
    exactPresentationTarget.dispose();
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();

    scene.clear();
    renderer.renderLists.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.removeAttribute("data-atlas-ready");
    canvas.removeAttribute("data-atlas-upright");
    canvas.removeAttribute("data-logical-bones");
    canvas.removeAttribute("data-semantic-meshes");
    canvas.removeAttribute("data-atlas-dimensions");
    canvas.removeAttribute("data-atlas-renderer");
    canvas.removeAttribute("data-atlas-draw-calls");
    canvas.removeAttribute("data-atlas-batch-geometries");
    canvas.removeAttribute("data-atlas-batch-instances");
    canvas.removeAttribute("data-atlas-exact-index-count");
    canvas.removeAttribute("data-atlas-exact-reordered");
    canvas.removeAttribute("data-atlas-exact-reordered-geometries");
    canvas.removeAttribute("data-atlas-exact-composition-chunks");
    canvas.removeAttribute("data-atlas-exact-composition-active-chunks");
    canvas.removeAttribute("data-atlas-exact-composition-state");
    canvas.removeAttribute("data-atlas-exact-composition-phase-durations");
    canvas.removeAttribute("data-atlas-exact-presentation-duration");
    canvas.removeAttribute("data-atlas-motion-index-count");
    canvas.removeAttribute("data-atlas-motion-index-ratio");
    canvas.removeAttribute("data-atlas-motion-target-index-ratio");
    canvas.removeAttribute("data-atlas-motion-error-bound");
    canvas.removeAttribute("data-atlas-motion-maximum-error");
    canvas.removeAttribute("data-atlas-motion-lod");
    canvas.removeAttribute("data-atlas-render-quality");
    canvas.removeAttribute("data-interaction-mode");
    canvas.removeAttribute("data-visible-section");
    canvas.removeAttribute("data-visible-semantic-meshes");
    canvas.removeAttribute("data-colored-bones");
    canvas.removeAttribute("data-surface-paint");
    canvas.removeAttribute("data-surface-paint-strokes");
    canvas.removeAttribute("data-surface-paint-anchors");
    canvas.removeAttribute("data-surface-paint-preview-anchors");
    canvas.removeAttribute("data-surface-paint-brush");
    canvas.removeAttribute("data-surface-paint-radius-bps");
    canvas.removeAttribute("data-surface-paint-hardness-bps");
    canvas.removeAttribute("data-surface-paint-painted-vertices");
    canvas.removeAttribute("data-surface-paint-last-stamp-vertices");
    canvas.removeAttribute("data-surface-paint-adjacency-vertices");
    canvas.removeAttribute("data-surface-paint-welded-vertices");
    canvas.removeAttribute("data-surface-paint-upload-vertices");
    canvas.remove();
    atlasMeshes.length = 0;
    visibleMeshes.length = 0;
    visibleMeshSet.clear();
    meshesByBoneId.clear();
    recordByMesh.clear();
    sourceMeshByName.clear();
    sourceObjectByMesh.clear();
    sourceNodeNames.clear();
    surfaceAdjacencyByMesh.clear();
    surfacePaintedVertices.clear();
    boneScaleById.clear();
    exactAtlas?.instanceByMesh.clear();
    exactAtlas?.sourceMeshByInstance.clear();
    motionAtlas?.instanceByMesh.clear();
    motionAtlas?.sourceMeshByInstance.clear();
    exactAtlas?.surfaceTargetByMesh.clear();
    motionAtlas?.surfaceTargetByMesh.clear();
    exactAtlas = null;
    motionAtlas = null;
    exactComposition = null;
    exactCompositionChunks = [];
    boneColors.clear();
    persistedSurfaceStrokes = [];
    surfaceStrokeDraft = null;
    pendingSurfacePointer = null;
  }
}
