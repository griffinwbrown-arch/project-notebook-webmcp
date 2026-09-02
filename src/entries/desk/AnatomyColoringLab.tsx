"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  COLORING_BRUSH_MODES,
  COLORING_LABS,
  COLORING_PALETTE,
  bonesForSection,
  coloringCompletion,
  createColoringBaseFillLookup,
  scoreBoneAnswers,
  type AnatomyPaintEdit,
  type AnatomyColoringProps,
  type AnatomyQuizSubmission,
  type BoneEntry,
  type ColoringBrushMode,
  type ColoringColorId,
  type ColoringLabelMode,
  type SurfacePaintBrush,
  type SurfacePaintStroke,
} from "../../anatomy";
import {
  createAnatomyAtlasScene,
  type AnatomyAtlasScene,
  type AtlasCameraPreset,
} from "../../anatomy/atlas-scene";

type AtlasState = "loading" | "ready" | "unavailable";
type RecallScore = Readonly<{ correct: number; total: number; unanswered: number }>;
type BoneColorStyle = React.CSSProperties & Readonly<{ "--bone-color": string }>;
type PaintSnapshot = Readonly<{
  baseFills: AnatomyColoringProps["baseFills"];
  surfaceStrokes: readonly SurfacePaintStroke[];
}>;
type PendingPaintState = Readonly<{
  edit: AnatomyPaintEdit;
  before: PaintSnapshot;
  optimistic: PaintSnapshot;
  propsLanded: boolean;
  saveResolved: boolean;
}>;

const colorById = new Map(COLORING_PALETTE.map((color) => [color.id, color]));

const SURFACE_BRUSH_SETTINGS = {
  sweep: { radiusBps: 450, hardnessBps: 6_600, sizeLabel: "Surface brush" },
  eraser: { radiusBps: 420, hardnessBps: 6_000, sizeLabel: "Local feathered eraser" },
} as const satisfies Readonly<Record<ColoringBrushMode, Readonly<{
  radiusBps: number;
  hardnessBps: number;
  sizeLabel: string;
}>>>;

function colorNumber(colorId: ColoringColorId): number {
  const color = colorById.get(colorId);
  if (color === undefined) throw new Error(`Unknown anatomy color ${colorId}.`);
  return Number.parseInt(color.hex.slice(1), 16);
}

function renderColors(baseFills: readonly (readonly [string, ColoringColorId])[]): Readonly<Record<string, number>> {
  return Object.fromEntries(baseFills.map(([boneId, colorId]) => [boneId, colorNumber(colorId)]));
}

function surfaceBrush(mode: ColoringBrushMode, colorId: ColoringColorId): SurfacePaintBrush {
  const settings = SURFACE_BRUSH_SETTINGS[mode];
  return mode === "eraser"
    ? { kind: "erase", radiusBps: settings.radiusBps, hardnessBps: settings.hardnessBps }
    : { kind: "paint", colorId, radiusBps: settings.radiusBps, hardnessBps: settings.hardnessBps };
}

function boneColorStyle(color: string): BoneColorStyle {
  return { "--bone-color": color };
}

function paintSnapshotsEqual(left: PaintSnapshot, right: PaintSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function strokeMatchesEdit(stroke: SurfacePaintStroke, edit: Extract<AnatomyPaintEdit, { kind: "surface-stroke" }>): boolean {
  return stroke.boneId === edit.boneId &&
    JSON.stringify(stroke.brush) === JSON.stringify(edit.brush) &&
    JSON.stringify(stroke.anchors) === JSON.stringify(edit.anchors);
}

function propsReflectPendingPaint(incoming: PaintSnapshot, pending: PendingPaintState): boolean {
  switch (pending.edit.kind) {
    case "surface-stroke": {
      if (JSON.stringify(incoming.baseFills) !== JSON.stringify(pending.optimistic.baseFills)) return false;
      if (incoming.surfaceStrokes.length !== pending.before.surfaceStrokes.length + 1) return false;
      const beforeIds = new Set(pending.before.surfaceStrokes.map((stroke) => stroke.id));
      if (!pending.before.surfaceStrokes.every((stroke) => incoming.surfaceStrokes.some((next) => next.id === stroke.id))) {
        return false;
      }
      const added = incoming.surfaceStrokes.filter((stroke) => !beforeIds.has(stroke.id));
      return added.length === 1 && added[0] !== undefined && strokeMatchesEdit(added[0], pending.edit);
    }
    case "clear-bone":
    case "clear-section":
      return paintSnapshotsEqual(incoming, pending.optimistic);
    default: {
      const exhaustive: never = pending.edit;
      return exhaustive;
    }
  }
}

function scoreLabel(score: RecallScore | AnatomyQuizSubmission): string {
  return `${score.correct}/${score.total} · ${Math.round((score.correct / score.total) * 100)}%`;
}

function nextUnansweredIndex(
  bones: readonly BoneEntry[],
  answers: Readonly<Record<string, string>>,
  currentIndex: number,
): number | null {
  for (let offset = 1; offset <= bones.length; offset += 1) {
    const index = (currentIndex + offset) % bones.length;
    const bone = bones[index];
    if (bone !== undefined && (answers[bone.id] ?? "").trim().length === 0) return index;
  }
  return null;
}

export type AnatomyColoringLabProps = Readonly<{
  props: AnatomyColoringProps;
  disabled?: boolean;
  onPaint: (edit: AnatomyPaintEdit) => Promise<boolean> | boolean;
  onSubmit: (answers: Readonly<Record<string, string>>) => Promise<boolean> | boolean;
}>;

export function AnatomyColoringLab({
  props,
  disabled = false,
  onPaint,
  onSubmit,
}: AnatomyColoringLabProps): React.JSX.Element {
  const bones = useMemo(() => bonesForSection(props.section), [props.section]);
  const lab = COLORING_LABS.find((candidate) => candidate.section === props.section);
  if (lab === undefined) throw new Error(`No coloring lab is registered for ${props.section}.`);

  const firstBone = bones[0];
  if (firstBone === undefined) throw new Error(`The ${props.section} coloring lab has no verified bones.`);

  const mountRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLButtonElement | null>(null);
  const runtimeRef = useRef<AnatomyAtlasScene | null>(null);
  const baseFillsRef = useRef(props.baseFills);
  const surfaceStrokesRef = useRef(props.surfaceStrokes);
  const persistedPaintRef = useRef<PaintSnapshot>({
    baseFills: props.baseFills,
    surfaceStrokes: props.surfaceStrokes,
  });
  const pendingPaintRef = useRef<PendingPaintState | null>(null);
  const brushRef = useRef<SurfacePaintBrush>(surfaceBrush("sweep", "carmine"));
  const selectedBoneRef = useRef(firstBone);
  const onPaintRef = useRef(onPaint);
  const onSubmitRef = useRef(onSubmit);
  const answersRef = useRef<Readonly<Record<string, string>>>({});
  const inputRefs = useRef(new Map<number, HTMLInputElement>());
  const savingStrokeRef = useRef(false);
  const workspaceBoneIdRef = useRef<string | null>(null);
  const labelModeRef = useRef<ColoringLabelMode>("guided");

  const [atlasState, setAtlasState] = useState<AtlasState>("loading");
  const [interactionMode, setInteractionModeState] = useState<"paint" | "orbit">("orbit");
  const [brushMode, setBrushModeState] = useState<ColoringBrushMode>("sweep");
  const [activeColorId, setActiveColorIdState] = useState<ColoringColorId>("carmine");
  const [labelMode, setLabelMode] = useState<ColoringLabelMode>("guided");
  const [selectedBone, setSelectedBone] = useState(firstBone);
  const [workspaceBoneId, setWorkspaceBoneId] = useState<string | null>(null);
  const [hoveredBoneId, setHoveredBoneId] = useState<string | null>(null);
  const initialCompletion = coloringCompletion({
    section: props.section,
    baseFills: props.baseFills,
    surfaceStrokes: props.surfaceStrokes,
  });
  const [startedBoneCount, setStartedBoneCount] = useState(initialCompletion.completedBoneCount);
  const [surfaceStrokeCount, setSurfaceStrokeCount] = useState(initialCompletion.surfaceStrokeCount);
  const [surfaceAnchorCount, setSurfaceAnchorCount] = useState(initialCompletion.surfaceAnchorCount);
  const [cameraView, setCameraView] = useState<AtlasCameraPreset | "custom">("custom");
  const [savingStroke, setSavingStroke] = useState(false);
  const [paintFeedback, setPaintFeedback] = useState("Drag on the bone.");
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [recallScore, setRecallScore] = useState<RecallScore | null>(null);
  const [recallError, setRecallError] = useState<string | null>(null);

  useEffect(() => {
    onPaintRef.current = onPaint;
    onSubmitRef.current = onSubmit;
  }, [onPaint, onSubmit]);

  useEffect(() => {
    labelModeRef.current = labelMode;
  }, [labelMode]);

  const syncMarker = useCallback((boneId = selectedBoneRef.current.id): void => {
    const runtime = runtimeRef.current;
    const marker = markerRef.current;
    if (runtime === null || marker === null) return;
    const projection = runtime.projectBone(boneId);
    marker.hidden = projection === null || !projection.visible;
    if (projection === null) return;
    const width = mountRef.current?.clientWidth ?? 0;
    marker.dataset.labelSide = width > 0 && projection.x > width * 0.68 ? "left" : "right";
    marker.style.left = `${projection.x}px`;
    marker.style.top = `${projection.y}px`;
  }, []);

  const selectBone = useCallback((bone: BoneEntry, focus = false): void => {
    selectedBoneRef.current = bone;
    setSelectedBone(bone);
    if (focus) runtimeRef.current?.focusBone(bone.id);
    syncMarker(bone.id);
  }, [syncMarker]);

  const openBoneWorkspace = useCallback((bone: BoneEntry, focusInput = false): void => {
    const runtime = runtimeRef.current;
    workspaceBoneIdRef.current = bone.id;
    setWorkspaceBoneId(bone.id);
    setHoveredBoneId(null);
    selectBone(bone);
    if (runtime !== null) {
      runtime.setVisibleSection(props.section);
      runtime.setIsolatedBone(bone.id);
      runtime.setSelectedBone(null);
      runtime.setHoveredBone(null);
      runtime.focusBone(bone.id);
    }
    setInteractionModeState("paint");
    if (focusInput) {
      const questionNumber = bones.findIndex((candidate) => candidate.id === bone.id) + 1;
      requestAnimationFrame(() => inputRefs.current.get(questionNumber)?.focus());
    }
  }, [bones, props.section, selectBone]);

  const closeBoneWorkspace = useCallback((): void => {
    const runtime = runtimeRef.current;
    workspaceBoneIdRef.current = null;
    setWorkspaceBoneId(null);
    setHoveredBoneId(null);
    selectBone(firstBone);
    setInteractionModeState("orbit");
    if (runtime === null) return;
    runtime.setHoveredBone(null);
    runtime.setSelectedBone(null);
    runtime.setVisibleSection(props.section);
    runtime.setCameraPreset("anterior", false);
    runtime.fitSection(props.section);
  }, [firstBone, props.section, selectBone]);

  const showPaintState = useCallback((
    baseFills: AnatomyColoringProps["baseFills"],
    surfaceStrokes: readonly SurfacePaintStroke[],
  ): void => {
    const completion = coloringCompletion({ section: props.section, baseFills, surfaceStrokes });
    baseFillsRef.current = baseFills;
    surfaceStrokesRef.current = surfaceStrokes;
    const runtime = runtimeRef.current;
    runtime?.setBoneColors(renderColors(baseFills));
    runtime?.setSurfaceStrokes(surfaceStrokes);
    setStartedBoneCount(completion.completedBoneCount);
    setSurfaceStrokeCount(completion.surfaceStrokeCount);
    setSurfaceAnchorCount(completion.surfaceAnchorCount);
  }, [props.section]);

  const finishPaintSave = useCallback((): void => {
    savingStrokeRef.current = false;
    setSavingStroke(false);
  }, []);

  useEffect(() => {
    const incoming: PaintSnapshot = {
      baseFills: props.baseFills,
      surfaceStrokes: props.surfaceStrokes,
    };
    const pending = pendingPaintRef.current;
    if (pending !== null) {
      if (!propsReflectPendingPaint(incoming, pending)) return;
      persistedPaintRef.current = incoming;
      showPaintState(incoming.baseFills, incoming.surfaceStrokes);
      if (pending.saveResolved) {
        pendingPaintRef.current = null;
        finishPaintSave();
      } else {
        pendingPaintRef.current = { ...pending, propsLanded: true };
      }
      return;
    }
    persistedPaintRef.current = incoming;
    showPaintState(incoming.baseFills, incoming.surfaceStrokes);
  }, [finishPaintSave, props.baseFills, props.surfaceStrokes, showPaintState]);

  const replayPersistedPaint = useCallback((): void => {
    const persisted = pendingPaintRef.current?.before ?? persistedPaintRef.current;
    pendingPaintRef.current = null;
    runtimeRef.current?.clearSurfacePreview();
    showPaintState(persisted.baseFills, persisted.surfaceStrokes);
  }, [showPaintState]);

  const persistPaintEdit = useCallback((input: Readonly<{
    edit: AnatomyPaintEdit;
    optimisticBaseFills: AnatomyColoringProps["baseFills"];
    optimisticSurfaceStrokes: readonly SurfacePaintStroke[];
    successMessage: string;
  }>): void => {
    if (savingStrokeRef.current) return;
    const before = persistedPaintRef.current;
    pendingPaintRef.current = {
      edit: input.edit,
      before,
      optimistic: {
        baseFills: input.optimisticBaseFills,
        surfaceStrokes: input.optimisticSurfaceStrokes,
      },
      propsLanded: false,
      saveResolved: false,
    };
    try {
      showPaintState(input.optimisticBaseFills, input.optimisticSurfaceStrokes);
    } catch {
      replayPersistedPaint();
      setPaintFeedback("Paint sample could not be verified. Saved paint restored.");
      finishPaintSave();
      return;
    }
    savingStrokeRef.current = true;
    setSavingStroke(true);
    setPaintFeedback("Saving surface paint…");
    void Promise.resolve(onPaintRef.current(input.edit)).then((saved) => {
      if (!saved) {
        replayPersistedPaint();
        setPaintFeedback("Save failed. Saved paint restored.");
        finishPaintSave();
        return;
      }
      setPaintFeedback(input.successMessage);
      const pending = pendingPaintRef.current;
      if (pending === null || pending.propsLanded) {
        pendingPaintRef.current = null;
        finishPaintSave();
      } else {
        pendingPaintRef.current = { ...pending, saveResolved: true };
      }
    }).catch(() => {
      replayPersistedPaint();
      setPaintFeedback("Save failed. Saved paint restored.");
      finishPaintSave();
    });
  }, [finishPaintSave, replayPersistedPaint, showPaintState]);

  const finishSurfaceStroke = useCallback((stroke: SurfacePaintStroke): void => {
    if (
      savingStrokeRef.current ||
      stroke.anchors.length === 0 ||
      workspaceBoneIdRef.current !== stroke.boneId
    ) {
      replayPersistedPaint();
      return;
    }
    const optimisticSurfaceStrokes = [...surfaceStrokesRef.current, stroke];
    persistPaintEdit({
      edit: {
        kind: "surface-stroke",
        boneId: stroke.boneId,
        brush: stroke.brush,
        anchors: stroke.anchors,
      },
      optimisticBaseFills: baseFillsRef.current,
      optimisticSurfaceStrokes,
      successMessage: `${stroke.anchors.length} surface ${stroke.anchors.length === 1 ? "sample" : "samples"} saved.`,
    });
  }, [persistPaintEdit, replayPersistedPaint]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    let active = true;
    delete mount.dataset.atlasError;
    setAtlasState("loading");
    const initialize = async (): Promise<void> => {
      try {
        const runtime = await createAnatomyAtlasScene(mount, {
          initialInteractionMode: "orbit",
          initialSection: props.section,
          onHover: (hit) => {
            if (!active) return;
            if (workspaceBoneIdRef.current !== null) {
              setHoveredBoneId(null);
              runtimeRef.current?.setHoveredBone(null);
              syncMarker();
              return;
            }
            setHoveredBoneId(hit?.boneId ?? null);
            if (hit !== null) syncMarker(hit.boneId);
            else syncMarker();
          },
          onSelect: (hit) => {
            if (!active || hit === null) return;
            const bone = bones.find((candidate) => candidate.id === hit.boneId);
            if (bone !== undefined) openBoneWorkspace(bone, labelModeRef.current === "recall");
          },
          onSurfaceStrokeCommit: finishSurfaceStroke,
          onCameraChange: (camera) => {
            if (!active) return;
            setCameraView((current) => current === camera.view ? current : camera.view);
            syncMarker();
          },
        });
        if (!active) {
          runtime.dispose();
          return;
        }
        const identity = runtime.getIdentity();
        if (identity.logicalBoneCount !== props.logicalBoneCount ||
          identity.semanticMeshCount !== props.semanticMeshCount || !identity.upright) {
          runtime.dispose();
          throw new Error("The coloring atlas identity did not match the pinned anatomy catalogue.");
        }
        runtimeRef.current = runtime;
        runtime.setBoneColors(renderColors(baseFillsRef.current));
        runtime.setSurfaceStrokes(surfaceStrokesRef.current);
        runtime.setSurfaceBrush(brushRef.current);
        setCameraView(runtime.getCamera().view);
        setAtlasState("ready");
        syncMarker();
      } catch (error: unknown) {
        if (!active) return;
        mount.dataset.atlasError = error instanceof Error ? error.message : "The anatomy atlas could not open.";
        runtimeRef.current = null;
        setAtlasState("unavailable");
      }
    };
    void initialize();
    return () => {
      active = false;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      runtime?.dispose();
      mount.replaceChildren();
    };
  }, [
    bones,
    finishSurfaceStroke,
    openBoneWorkspace,
    props.logicalBoneCount,
    props.section,
    props.semanticMeshCount,
    selectBone,
    syncMarker,
  ]);

  const interactionDisabled = disabled || atlasState !== "ready";
  const brushDisabled = interactionDisabled || savingStroke;

  useEffect(() => {
    runtimeRef.current?.setInteractionMode(brushDisabled ? "orbit" : interactionMode);
  }, [brushDisabled, interactionMode]);

  const setBrushMode = (mode: ColoringBrushMode): void => {
    setBrushModeState(mode);
    brushRef.current = surfaceBrush(mode, activeColorId);
    runtimeRef.current?.setSurfaceBrush(brushRef.current);
    setInteractionModeState("paint");
    setPaintFeedback("Drag on the bone.");
  };

  const setActiveColor = (colorId: ColoringColorId): void => {
    setActiveColorIdState(colorId);
    const mode = brushMode === "eraser" ? "sweep" : brushMode;
    setBrushModeState(mode);
    brushRef.current = surfaceBrush(mode, colorId);
    runtimeRef.current?.setSurfaceBrush(brushRef.current);
    setInteractionModeState("paint");
    const color = colorById.get(colorId);
    setPaintFeedback(`${color?.label ?? colorId} selected.`);
  };

  const setSectionView = (view: AtlasCameraPreset): void => {
    const runtime = runtimeRef.current;
    if (runtime === null) return;
    runtime.setCameraPreset(view, false);
    const isolatedBoneId = workspaceBoneIdRef.current;
    if (isolatedBoneId === null) runtime.fitSection(props.section);
    else runtime.focusBone(isolatedBoneId);
  };

  const resetView = (): void => {
    const runtime = runtimeRef.current;
    if (runtime === null) return;
    const isolatedBoneId = workspaceBoneIdRef.current;
    runtime.setVisibleSection(props.section);
    if (isolatedBoneId === null) selectBone(firstBone);
    else runtime.setIsolatedBone(isolatedBoneId);
    setSectionView("anterior");
  };

  const clearColors = (): void => {
    const isolatedBoneId = workspaceBoneIdRef.current;
    if (savingStrokeRef.current) return;
    if (isolatedBoneId === null) {
      if (baseFillsRef.current.length === 0 && surfaceStrokesRef.current.length === 0) return;
      persistPaintEdit({
        edit: { kind: "clear-section" },
        optimisticBaseFills: [],
        optimisticSurfaceStrokes: [],
        successMessage: "Section paint cleared.",
      });
      return;
    }
    const hasBaseFill = baseFillsRef.current.some(([boneId]) => boneId === isolatedBoneId);
    const hasSurfaceStroke = surfaceStrokesRef.current.some((stroke) => stroke.boneId === isolatedBoneId);
    if (!hasBaseFill && !hasSurfaceStroke) return;
    persistPaintEdit({
      edit: { kind: "clear-bone", boneId: isolatedBoneId },
      optimisticBaseFills: baseFillsRef.current.filter(([boneId]) => boneId !== isolatedBoneId),
      optimisticSurfaceStrokes: surfaceStrokesRef.current.filter((stroke) => stroke.boneId !== isolatedBoneId),
      successMessage: "Bone paint cleared. Other bones were kept.",
    });
  };

  const setAnswer = (questionNumber: number, answer: string): void => {
    const bone = bones[questionNumber - 1];
    if (bone === undefined || recallScore !== null) return;
    const next = { ...answersRef.current, [bone.id]: answer };
    answersRef.current = next;
    setAnswers(next);
    selectBone(bone);
    setRecallError(null);
  };

  const focusQuestion = (questionNumber: number): void => {
    const bone = bones[questionNumber - 1];
    if (bone === undefined) return;
    openBoneWorkspace(bone, true);
  };

  const moveWorkspace = (direction: -1 | 1): void => {
    const currentIndex = bones.findIndex((bone) => bone.id === selectedBone.id);
    const nextIndex = (currentIndex + direction + bones.length) % bones.length;
    const nextBone = bones[nextIndex];
    if (nextBone !== undefined) openBoneWorkspace(nextBone, labelMode === "recall");
  };

  const submitRecall = useCallback(async (): Promise<void> => {
    if (submitting || recallScore !== null) return;
    setSubmitting(true);
    const score = scoreBoneAnswers(answersRef.current, bones);
    let saved = false;
    try {
      saved = await onSubmitRef.current(answersRef.current);
    } catch {
      saved = false;
    }
    setSubmitting(false);
    if (!saved) {
      setRecallError("The label score was not saved. Your answers are still here.");
      return;
    }
    setRecallScore(score);
    setRecallError(null);
  }, [bones, recallScore, submitting]);

  const restartRecall = (): void => {
    answersRef.current = {};
    setAnswers({});
    setRecallScore(null);
    setRecallError(null);
    focusQuestion(1);
  };

  const activeBone = hoveredBoneId === null
    ? selectedBone
    : bones.find((bone) => bone.id === hoveredBoneId) ?? selectedBone;
  const activeQuestionNumber = bones.findIndex((bone) => bone.id === activeBone.id) + 1;
  const selectedQuestionNumber = bones.findIndex((bone) => bone.id === selectedBone.id) + 1;
  const baseFillLookup = createColoringBaseFillLookup({ section: props.section, baseFills: props.baseFills });
  const latestSurfaceColorByBone = new Map<string, ColoringColorId>();
  for (const stroke of props.surfaceStrokes) {
    if (stroke.brush.kind === "paint") latestSurfaceColorByBone.set(stroke.boneId, stroke.brush.colorId);
  }
  const latestScore = recallScore ?? props.latestSubmission;
  const concealRecallAnswer = labelMode === "recall" && recallScore === null;
  const workspaceIdentity = workspaceBoneId === null
    ? "section"
    : concealRecallAnswer ? `question-${selectedQuestionNumber}` : workspaceBoneId;
  const workspaceLabel = concealRecallAnswer
    ? `Question ${selectedQuestionNumber} bone workspace`
    : `Bone workspace for ${selectedBone.name}`;
  const hasWorkspacePaint = workspaceBoneId !== null && (
    baseFillLookup.has(workspaceBoneId) || props.surfaceStrokes.some((stroke) => stroke.boneId === workspaceBoneId)
  );
  const currentBrushSettings = SURFACE_BRUSH_SETTINGS[brushMode];
  const currentBrushAction = brushMode === "eraser" ? "erase" : "paint";

  return (
    <section
      className="anatomy-coloring-card"
      data-atlas-state={atlasState}
      data-section={props.section}
      data-colored-bones={startedBoneCount}
      data-started-bones={startedBoneCount}
      data-surface-strokes={surfaceStrokeCount}
      data-surface-anchors={surfaceAnchorCount}
      data-paint-state={savingStroke ? "saving" : "idle"}
      data-label-mode={labelMode}
      data-brush-mode={brushMode}
      data-interaction-mode={interactionMode}
      data-workspace-bone={workspaceIdentity}
      aria-label={`${lab.label} 3D coloring lab`}
    >
      <header className="anatomy-coloring-header">
        <div>
          <span className="anatomy-kicker">Anatomy Coloring · Lab {String(COLORING_LABS.findIndex((candidate) => candidate.section === props.section) + 2).padStart(2, "0")}</span>
          <h3>{lab.label}</h3>
        </div>
        <div className="anatomy-mode-switch" role="group" aria-label="Coloring label mode">
          <button type="button" aria-pressed={labelMode === "guided"} onClick={() => setLabelMode("guided")}>Labels on</button>
          <button type="button" aria-pressed={labelMode === "recall"} onClick={() => { setLabelMode("recall"); openBoneWorkspace(selectedBone, true); }}>Label yourself</button>
        </div>
        <div className="anatomy-color-progress" aria-label={`${startedBoneCount} of ${bones.length} bones started`}>
          <strong>{startedBoneCount}/{bones.length}</strong>
          <span style={{ width: `${(startedBoneCount / bones.length) * 100}%` }} />
        </div>
      </header>

      <div className="anatomy-coloring-layout">
        <div
          className="anatomy-model-stage anatomy-coloring-stage"
          data-model-state={atlasState}
          data-workspace={workspaceBoneId === null ? "section" : "bone"}
        >
          <div ref={mountRef} className="anatomy-model-canvas" aria-label={`Paintable 3D ${lab.label} skeleton section`} />
          {atlasState === "loading" ? <div className="anatomy-model-message">Fitting the verified {lab.shortLabel.toLocaleLowerCase()} section…</div> : null}
          {atlasState === "unavailable" ? (
            <div className="anatomy-model-message anatomy-model-message--error" role="alert">
              <strong>Coloring atlas unavailable</strong>
              <span>The pinned source-mesh atlas could not be verified. Painting and labels remain disabled.</span>
            </div>
          ) : null}
          <button
            ref={markerRef}
            type="button"
            className="anatomy-hotspot-label anatomy-coloring-hotspot"
            hidden
            onClick={() => openBoneWorkspace(activeBone, labelMode === "recall")}
            disabled={interactionDisabled}
          >
            <span />{labelMode === "guided" ? activeBone.name : `Question ${activeQuestionNumber}`}
          </button>
          {workspaceBoneId === null ? null : (
            <div className="anatomy-bone-workspace" aria-label={workspaceLabel}>
              <div>
                <span>Bone workspace</span>
                <strong>{concealRecallAnswer ? `Question ${selectedQuestionNumber}` : selectedBone.name}</strong>
              </div>
              <button type="button" onClick={() => moveWorkspace(-1)} disabled={interactionDisabled} aria-label="Previous bone">‹</button>
              <button type="button" onClick={() => moveWorkspace(1)} disabled={interactionDisabled} aria-label="Next bone">›</button>
              <button type="button" onClick={closeBoneWorkspace} disabled={interactionDisabled}>Back to section</button>
            </div>
          )}
          <div className="anatomy-paint-mode" role="group" aria-label="3D coloring interaction">
            <button
              type="button"
              aria-pressed={interactionMode === "paint"}
              onClick={() => setInteractionModeState("paint")}
              disabled={brushDisabled || workspaceBoneId === null}
            >Paint</button>
            <button type="button" aria-pressed={interactionMode === "orbit"} onClick={() => setInteractionModeState("orbit")} disabled={interactionDisabled}>Orbit</button>
          </div>
          <div className="anatomy-model-controls anatomy-coloring-camera" role="group" aria-label="Coloring camera controls">
            <span>{workspaceBoneId === null
              ? "Click a bone to open its paint workspace"
              : interactionMode === "paint" ? "Drag to paint this bone's surface" : "Drag to inspect · choose Paint to resume"}</span>
            <button type="button" onClick={resetView} disabled={interactionDisabled}>Reset view</button>
            <button type="button" aria-pressed={cameraView === "anterior"} onClick={() => setSectionView("anterior")} disabled={interactionDisabled}>Anterior</button>
            <button type="button" aria-pressed={cameraView === "left"} onClick={() => setSectionView("left")} disabled={interactionDisabled}>Left</button>
            <button type="button" aria-pressed={cameraView === "right"} onClick={() => setSectionView("right")} disabled={interactionDisabled}>Right</button>
          </div>
          <a className="anatomy-attribution" href="https://github.com/Z-Anatomy/Models-of-human-anatomy" target="_blank" rel="noreferrer">
            Z-Anatomy · CC BY-SA 4.0 · source-mesh identities
          </a>
        </div>

        <aside className="anatomy-coloring-panel" aria-label="Coloring tools and bone index">
          <div className="anatomy-brush-toolbar" role="group" aria-label="Anatomy brush">
            {COLORING_BRUSH_MODES.map((brush) => (
              <button
                key={brush.id}
                type="button"
                aria-pressed={brushMode === brush.id}
                title={brush.description}
                onClick={() => setBrushMode(brush.id)}
                disabled={brushDisabled || workspaceBoneId === null}
              >{brush.label}</button>
            ))}
            <div className="anatomy-brush-feedback" data-action={currentBrushAction} aria-live="polite">
              <strong>{currentBrushSettings.sizeLabel}</strong>
              <span>{savingStroke ? "Saving…" : paintFeedback}</span>
            </div>
          </div>
          <div className="anatomy-palette" role="group" aria-label="Bone colors">
            {COLORING_PALETTE.map((color) => (
              <button
                key={color.id}
                type="button"
                aria-label={color.label}
                aria-pressed={brushMode !== "eraser" && activeColorId === color.id}
                style={boneColorStyle(color.hex)}
                onClick={() => setActiveColor(color.id)}
                disabled={brushDisabled || workspaceBoneId === null}
              />
            ))}
            <button
              type="button"
              className="anatomy-clear-colors"
              onClick={clearColors}
              disabled={brushDisabled || (workspaceBoneId === null
                ? props.baseFills.length === 0 && props.surfaceStrokes.length === 0
                : !hasWorkspacePaint)}
            >{workspaceBoneId === null ? "Clear section" : "Clear bone"}</button>
          </div>

          {labelMode === "guided" ? (
            <div className="anatomy-coloring-bone-list" role="listbox" aria-label={`${lab.label} bones`}>
              {(workspaceBoneId === null ? bones : [selectedBone]).map((bone) => {
                const colorId = latestSurfaceColorByBone.get(bone.id) ?? baseFillLookup.get(bone.id);
                const color = colorId === undefined ? null : colorById.get(colorId);
                return (
                  <button
                    key={bone.id}
                    type="button"
                    role="option"
                    aria-selected={selectedBone.id === bone.id}
                    onPointerEnter={() => {
                      if (workspaceBoneIdRef.current !== null) return;
                      setHoveredBoneId(bone.id);
                      runtimeRef.current?.setHoveredBone(bone.id);
                      syncMarker(bone.id);
                    }}
                    onPointerLeave={() => { setHoveredBoneId(null); runtimeRef.current?.setHoveredBone(null); syncMarker(); }}
                    onClick={() => openBoneWorkspace(bone)}
                    disabled={interactionDisabled}
                  >
                    <span className="anatomy-bone-swatch" style={{ background: color?.hex ?? "transparent" }} />
                    <span>{bone.name}</span>
                    <small>{bone.side}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <form className="anatomy-coloring-recall" onSubmit={(event) => { event.preventDefault(); void submitRecall(); }}>
              <div className="anatomy-test-progress" aria-live="polite">
                <strong>{recallScore === null ? Object.values(answers).filter((answer) => answer.trim().length > 0).length : recallScore.correct}/{bones.length}</strong>
                <span>{recallScore === null ? "labels filled" : `Score ${scoreLabel(recallScore)}`}</span>
              </div>
              <div className="anatomy-test-fields">
                {[selectedBone].map((bone) => {
                  const index = bones.findIndex((candidate) => candidate.id === bone.id);
                  const questionNumber = index + 1;
                  return (
                    <label key={bone.id} data-active={selectedBone.id === bone.id ? "true" : undefined}>
                      <span>{String(questionNumber).padStart(2, "0")}</span>
                      <input
                        ref={(input) => {
                          if (input === null) inputRefs.current.delete(questionNumber);
                          else inputRefs.current.set(questionNumber, input);
                        }}
                        aria-label={`Coloring answer for question ${questionNumber}`}
                        autoComplete="off"
                        maxLength={160}
                        value={answers[bone.id] ?? ""}
                        onFocus={() => openBoneWorkspace(bone)}
                        onChange={(event) => setAnswer(questionNumber, event.target.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          const nextIndex = nextUnansweredIndex(bones, answersRef.current, index);
                          if (nextIndex === null) void submitRecall();
                          else focusQuestion(nextIndex + 1);
                        }}
                        placeholder="Type bone name"
                        disabled={interactionDisabled || submitting || recallScore !== null}
                      />
                    </label>
                  );
                })}
              </div>
              {recallScore === null ? (
                <button className="anatomy-submit-test" type="submit" disabled={interactionDisabled || submitting}>
                  {submitting ? "Saving score…" : "Check labels"}
                </button>
              ) : (
                <button className="anatomy-submit-test" type="button" onClick={restartRecall} disabled={interactionDisabled}>Try again</button>
              )}
              {recallError === null ? null : <p role="alert">{recallError}</p>}
            </form>
          )}
        </aside>
      </div>

      <footer className="anatomy-coloring-footer">
        <span>{surfaceStrokeCount} surface {surfaceStrokeCount === 1 ? "stroke" : "strokes"} · {surfaceAnchorCount} anchors</span>
        <strong>{savingStroke
          ? "Saving stroke…"
          : workspaceBoneId === null
            ? "Choose a bone to begin"
            : concealRecallAnswer
              ? `Question ${selectedQuestionNumber} isolated for brush work`
              : `${selectedBone.name} isolated for brush work`}</strong>
        {latestScore === undefined || latestScore === null ? <span>No label score yet</span> : <span>Latest {scoreLabel(latestScore)}</span>}
      </footer>
    </section>
  );
}
