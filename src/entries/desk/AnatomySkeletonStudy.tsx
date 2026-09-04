"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ADULT_SKELETON_BONES,
  ANATOMY_SECTIONS,
  bonesForSection,
  scoreBoneAnswers,
  type AnatomyQuizSubmission,
  type AnatomySection,
  type AnatomySkeletonProps,
  type BoneEntry,
} from "../../anatomy";
import {
  createAnatomyAtlasScene,
  type AnatomyAtlasScene,
  type AtlasCameraPreset,
  type AtlasHit,
  type ProjectedAtlasPoint,
} from "../../anatomy/atlas-scene";
import type { WebMcpModelContext, WebMcpTool } from "../../types/webmcp";

type StudyMode = "study" | "test";
type NotebookLayout = "single" | "spread";
type AtlasState = "loading" | "ready" | "unavailable";
type CameraSnapshot = ReturnType<AnatomyAtlasScene["getCamera"]>;
type AtlasIdentity = ReturnType<AnatomyAtlasScene["getIdentity"]>;

const INITIAL_CAMERA: CameraSnapshot = { view: "anterior", position: [0, 0, 0], distance: 0 };

type TestScore = Readonly<{
  correct: number;
  total: number;
  unanswered: number;
}>;

type TestAttempt =
  | Readonly<{
      kind: "editing";
      answers: Readonly<Record<string, string>>;
      activeQuestionNumber: number | null;
      error: string | null;
    }>
  | Readonly<{
      kind: "submitting";
      answers: Readonly<Record<string, string>>;
      activeQuestionNumber: number | null;
    }>
  | Readonly<{
      kind: "scored";
      answers: Readonly<Record<string, string>>;
      activeQuestionNumber: number | null;
      score: TestScore;
    }>;

const ANATOMY_TOOL_NAMES = [
  "anatomy_context_read",
  "anatomy_navigate",
  "anatomy_test",
] as const;

type AnatomyToolName = typeof ANATOMY_TOOL_NAMES[number];

type ToolFailure = Readonly<{
  outcome: "error";
  command: AnatomyToolName;
  error: Readonly<{ code: string; message: string }>;
}>;

type AnatomyControllerActions = Readonly<{
  context: () => Readonly<Record<string, unknown>>;
  setMode: (mode: StudyMode) => Readonly<Record<string, unknown>>;
  setSection: (section: AnatomySection) => Readonly<Record<string, unknown>>;
  setSession: (input: Readonly<{ mode: StudyMode; section: AnatomySection }>) => Readonly<Record<string, unknown>>;
  setLayout: (layout: NotebookLayout) => void;
  setIsolation: (isolate: boolean) => void;
  focusStudyBone: (boneId: string, isolate: boolean | undefined) => Readonly<Record<string, unknown>> | null;
  focusTestQuestion: (questionNumber: number, isolate: boolean | undefined) => Readonly<Record<string, unknown>> | null;
  setAnswer: (questionNumber: number, answer: string) => Readonly<Record<string, unknown>> | null;
  submitTest: () => Promise<TestScore | null>;
  setCamera: (view: AtlasCameraPreset) => CameraSnapshot;
  ready: () => boolean;
}>;

type AnatomyController = {
  active: boolean;
  actions: AnatomyControllerActions | null;
};

type AnatomyToolBinding = {
  controller: AnatomyController | null;
  registered: Set<AnatomyToolName>;
  installing: Promise<void> | null;
};

const ANATOMY_TOOL_BINDINGS = new WeakMap<WebMcpModelContext, AnatomyToolBinding>();

const EMPTY_OBJECT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const SECTION_SCHEMA = {
  oneOf: ANATOMY_SECTIONS.map(({ id, shortLabel }) => ({ const: id, title: shortLabel })),
} as const;

const TOOL_DESCRIPTORS = [
  {
    name: "anatomy_context_read",
    description: "Read atlas integrity, camera, section, and progress. An unfinished test returns opaque question numbers and completion flags only.",
    inputSchema: EMPTY_OBJECT_SCHEMA,
    readOnly: true,
    untrustedContent: true,
  },
  {
    name: "anatomy_navigate",
    description: "Navigate the atlas in one call. Prefer one set_view call for setup: infer layout, mode, section, camera, and isolation from the user's request instead of issuing separate setup calls. Combining mode \"test\" with a section starts a fresh test; isolate false keeps the full model visible. Use focus for a verified source-mesh bone in Study mode or an opaque question number in Test mode. Section schema titles match the labels on the page.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: {
            action: { const: "set_view" },
            mode: { type: "string", enum: ["study", "test"] },
            section: SECTION_SCHEMA,
            camera: { type: "string", enum: ["anterior", "left", "right"] },
            layout: { type: "string", enum: ["single", "spread"] },
            isolate: { type: "boolean" },
          },
          required: ["action"],
          anyOf: [
            { required: ["mode"] },
            { required: ["section"] },
            { required: ["camera"] },
            { required: ["layout"] },
            { required: ["isolate"] },
          ],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            action: { const: "focus" },
            boneId: { type: "string", minLength: 1 },
            questionNumber: { type: "integer", minimum: 1, maximum: 64 },
            isolate: { type: "boolean" },
          },
          required: ["action"],
          oneOf: [{ required: ["boneId"] }, { required: ["questionNumber"] }],
          additionalProperties: false,
        },
      ],
    },
    readOnly: false,
    untrustedContent: false,
  },
  {
    name: "anatomy_test",
    description: "Interact with the fillable, scored anatomy test. Use action \"answer\" to set one answer by opaque question number (the acknowledgement never echoes the answer); use action \"submit\" to score and persist the active section test through the notebook's app-owned path.",
    inputSchema: {
      oneOf: [
        {
          type: "object",
          properties: {
            action: { const: "answer" },
            questionNumber: { type: "integer", minimum: 1, maximum: 64 },
            answer: { type: "string", maxLength: 160 },
          },
          required: ["action", "questionNumber", "answer"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { const: "submit" } },
          required: ["action"],
          additionalProperties: false,
        },
      ],
    },
    readOnly: false,
    untrustedContent: true,
  },
] as const satisfies readonly Readonly<{
  name: AnatomyToolName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  readOnly: boolean;
  untrustedContent: boolean;
}>[];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isStudyMode(value: unknown): value is StudyMode {
  return value === "study" || value === "test";
}

function isAnatomySection(value: unknown): value is AnatomySection {
  return ANATOMY_SECTIONS.some(({ id }) => id === value);
}

function isCameraPreset(value: unknown): value is AtlasCameraPreset {
  return value === "anterior" || value === "left" || value === "right";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function toolFailure(command: AnatomyToolName, code: string, message: string): ToolFailure {
  return { outcome: "error", command, error: { code, message } };
}

function inactiveTool(command: AnatomyToolName): ToolFailure {
  return toolFailure(command, "ANATOMY_NOT_ACTIVE", "Open the anatomy notebook page before using this tool.");
}

function invalidToolInput(command: AnatomyToolName): ToolFailure {
  return toolFailure(command, "INVALID_INPUT", "The tool input does not match the active anatomy mode.");
}

function executeAnatomyTool(
  controller: AnatomyController | null,
  command: AnatomyToolName,
  input: unknown,
): unknown | Promise<unknown> {
  if (controller === null || !controller.active || controller.actions === null) return inactiveTool(command);
  const actions = controller.actions;
  if (!actions.ready()) return toolFailure(command, "ATLAS_NOT_READY", "Wait for the verified atlas to finish loading.");

  if (command === "anatomy_context_read") {
    if (!isRecord(input) || !hasExactKeys(input, [], [])) return invalidToolInput(command);
    return actions.context();
  }

  if (command === "anatomy_navigate") {
    if (!isRecord(input)) return invalidToolInput(command);
    if (input.action === "set_view") {
      if (!hasExactKeys(input, ["action", "mode", "section", "camera", "layout", "isolate"], ["action"])) return invalidToolInput(command);
      const modeGiven = input.mode !== undefined;
      const sectionGiven = input.section !== undefined;
      const cameraGiven = input.camera !== undefined;
      const layoutGiven = input.layout !== undefined;
      const isolationGiven = input.isolate !== undefined;
      if (!modeGiven && !sectionGiven && !cameraGiven && !layoutGiven && !isolationGiven) return invalidToolInput(command);
      if (modeGiven && !isStudyMode(input.mode)) return invalidToolInput(command);
      if (sectionGiven && !isAnatomySection(input.section)) return invalidToolInput(command);
      if (cameraGiven && !isCameraPreset(input.camera)) return invalidToolInput(command);
      if (layoutGiven && input.layout !== "single" && input.layout !== "spread") return invalidToolInput(command);
      if (isolationGiven && typeof input.isolate !== "boolean") return invalidToolInput(command);
      if (modeGiven && isStudyMode(input.mode) && sectionGiven && isAnatomySection(input.section)) {
        actions.setSession({ mode: input.mode, section: input.section });
      } else if (modeGiven && isStudyMode(input.mode)) {
        actions.setMode(input.mode);
      } else if (sectionGiven && isAnatomySection(input.section)) {
        actions.setSection(input.section);
      }
      if (layoutGiven && (input.layout === "single" || input.layout === "spread")) actions.setLayout(input.layout);
      if (cameraGiven && isCameraPreset(input.camera)) actions.setCamera(input.camera);
      if (isolationGiven && typeof input.isolate === "boolean") actions.setIsolation(input.isolate);
      return actions.context();
    }
    if (input.action === "focus") {
      if (actions.context().mode === "test") {
        if (!hasExactKeys(input, ["action", "questionNumber", "isolate"], ["action", "questionNumber"]) ||
          !Number.isInteger(input.questionNumber) || !isOptionalBoolean(input.isolate)) return invalidToolInput(command);
        return actions.focusTestQuestion(Number(input.questionNumber), input.isolate) ?? invalidToolInput(command);
      }
      if (!hasExactKeys(input, ["action", "boneId", "isolate"], ["action", "boneId"]) || typeof input.boneId !== "string" ||
        input.boneId.length === 0 || !isOptionalBoolean(input.isolate)) return invalidToolInput(command);
      return actions.focusStudyBone(input.boneId, input.isolate) ?? toolFailure(command, "BONE_NOT_FOUND", "No verified bone matches that identifier.");
    }
    return invalidToolInput(command);
  }

  // anatomy_test
  if (!isRecord(input)) return invalidToolInput(command);
  if (input.action === "answer") {
    if (!hasExactKeys(input, ["action", "questionNumber", "answer"], ["action", "questionNumber", "answer"]) ||
      !Number.isInteger(input.questionNumber) || typeof input.answer !== "string" || input.answer.length > 160) return invalidToolInput(command);
    return actions.setAnswer(Number(input.questionNumber), input.answer) ?? invalidToolInput(command);
  }
  if (input.action === "submit") {
    if (!hasExactKeys(input, ["action"], ["action"])) return invalidToolInput(command);
    return actions.submitTest().then((score) => score === null
      ? toolFailure(command, "TEST_SUBMIT_FAILED", "The score was not saved. Keep this attempt open and try again.")
      : { score });
  }
  return invalidToolInput(command);
}

async function bindAnatomyTools(modelContext: WebMcpModelContext, controller: AnatomyController): Promise<void> {
  const binding = ANATOMY_TOOL_BINDINGS.get(modelContext) ?? {
    controller: null,
    registered: new Set<AnatomyToolName>(),
    installing: null,
  };
  binding.controller = controller;
  ANATOMY_TOOL_BINDINGS.set(modelContext, binding);
  if (binding.installing !== null) await binding.installing;
  const missing = TOOL_DESCRIPTORS.filter(({ name }) => !binding.registered.has(name));
  if (missing.length === 0) return;
  binding.installing = (async () => {
    for (const descriptor of missing) {
      const tool = {
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        outputSchema: { type: "object" },
        annotations: { readOnlyHint: descriptor.readOnly, untrustedContentHint: descriptor.untrustedContent },
        execute: (input: unknown): unknown | Promise<unknown> => executeAnatomyTool(binding.controller, descriptor.name, input),
      } satisfies WebMcpTool;
      await modelContext.registerTool(tool);
      binding.registered.add(descriptor.name);
    }
  })();
  try {
    await binding.installing;
  } finally {
    binding.installing = null;
  }
}

function unbindAnatomyTools(modelContext: WebMcpModelContext, controller: AnatomyController): void {
  const binding = ANATOMY_TOOL_BINDINGS.get(modelContext);
  if (binding?.controller === controller) binding.controller = null;
}

function sectionLabel(section: AnatomySection): string {
  return ANATOMY_SECTIONS.find(({ id }) => id === section)?.shortLabel ?? section;
}

function scoreLabel(score: Pick<AnatomyQuizSubmission, "correct" | "total"> | TestScore): string {
  const percent = Math.round((score.correct / score.total) * 100);
  return `${score.correct}/${score.total} · ${percent}%`;
}

function boneSnapshot(bone: BoneEntry): Readonly<Record<string, unknown>> {
  return {
    id: bone.id,
    label: bone.name,
    section: bone.section,
    mesh_parts: bone.sourceMeshCount,
    source_objects: [...bone.sourceObjects],
  };
}

function firstBone(section: AnatomySection): BoneEntry {
  const bone = bonesForSection(section)[0];
  if (bone === undefined) throw new Error(`The ${section} anatomy section has no verified bones.`);
  return bone;
}

function editingAttempt(activeQuestionNumber: number | null = 1): TestAttempt {
  return { kind: "editing", answers: {}, activeQuestionNumber, error: null };
}

function completedAnswerCount(attempt: TestAttempt, bones: readonly BoneEntry[]): number {
  return bones.reduce((count, bone) => count + ((attempt.answers[bone.id] ?? "").trim().length > 0 ? 1 : 0), 0);
}

function nextUnansweredQuestionIndex(
  bones: readonly BoneEntry[],
  answers: Readonly<Record<string, string>>,
  currentIndex: number,
): number | null {
  for (let offset = 1; offset <= bones.length; offset += 1) {
    const candidateIndex = (currentIndex + offset) % bones.length;
    const candidate = bones[candidateIndex];
    if (candidate !== undefined && (answers[candidate.id] ?? "").trim().length === 0) return candidateIndex;
  }
  return null;
}

function BoneSearch({
  bones,
  selectedBoneId,
  hoveredBoneId,
  disabled,
  onSelect,
  onHover,
}: Readonly<{
  bones: readonly BoneEntry[];
  selectedBoneId: string;
  hoveredBoneId: string | null;
  disabled: boolean;
  onSelect: (bone: BoneEntry) => void;
  onHover: (bone: BoneEntry | null) => void;
}>): React.JSX.Element {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized.length === 0
      ? bones
      : bones.filter((bone) => bone.name.toLocaleLowerCase().includes(normalized));
  }, [bones, query]);

  return (
    <div className="anatomy-bone-browser">
      <label>
        <span>Find a bone</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search this section"
          disabled={disabled}
        />
      </label>
      <div className="anatomy-bone-list" role="listbox" aria-label="Bones in selected section">
        {filtered.map((bone) => (
          <button
            key={bone.id}
            type="button"
            role="option"
            aria-selected={bone.id === selectedBoneId}
            data-hovered={bone.id === hoveredBoneId ? "true" : undefined}
            onPointerEnter={() => onHover(bone)}
            onPointerLeave={() => onHover(null)}
            onFocus={() => onHover(bone)}
            onBlur={() => onHover(null)}
            onClick={() => onSelect(bone)}
            disabled={disabled}
          >
            <span>{bone.name}</span>
            <small>{bone.side}</small>
          </button>
        ))}
      </div>
      <p>{filtered.length} of {bones.length} verified identities</p>
    </div>
  );
}

function BoneTest({
  bones,
  attempt,
  disabled,
  inputRefs,
  onAnswer,
  onFocusQuestion,
  onSubmit,
  onTryAgain,
}: Readonly<{
  bones: readonly BoneEntry[];
  attempt: TestAttempt;
  disabled: boolean;
  inputRefs: Readonly<{ current: Array<HTMLInputElement | null> }>;
  onAnswer: (questionNumber: number, answer: string) => void;
  onFocusQuestion: (questionNumber: number) => void;
  onSubmit: () => Promise<TestScore | null>;
  onTryAgain: () => void;
}>): React.JSX.Element {
  const answered = completedAnswerCount(attempt, bones);
  const locked = disabled || attempt.kind !== "editing";

  const handleAnswerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, currentIndex: number): void => {
    event.stopPropagation();
    if (event.key !== "Enter" || event.nativeEvent.isComposing || locked || attempt.kind !== "editing") return;
    event.preventDefault();
    const nextIndex = nextUnansweredQuestionIndex(bones, attempt.answers, currentIndex);
    if (nextIndex === null) {
      void onSubmit();
      return;
    }
    inputRefs.current[nextIndex]?.focus();
  };

  return (
    <form
      className="anatomy-test-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <div className="anatomy-test-progress" aria-live="polite">
        <strong>{answered}/{bones.length}</strong>
        <span>{attempt.kind === "scored" ? `Score ${scoreLabel(attempt.score)}` : "labels filled"}</span>
      </div>
      <div className="anatomy-test-fields">
        {bones.map((bone, index) => {
          const questionNumber = index + 1;
          return (
            <label key={`question-${questionNumber}`} data-active={attempt.activeQuestionNumber === questionNumber ? "true" : undefined}>
              <span>{String(questionNumber).padStart(2, "0")}</span>
              <input
                ref={(node) => { inputRefs.current[index] = node; }}
                aria-label={`Answer for question ${questionNumber}`}
                autoComplete="off"
                value={attempt.answers[bone.id] ?? ""}
                onFocus={() => onFocusQuestion(questionNumber)}
                onChange={(event) => onAnswer(questionNumber, event.target.value)}
                onKeyDown={(event) => handleAnswerKeyDown(event, index)}
                placeholder="Type bone name"
                maxLength={160}
                disabled={locked}
              />
            </label>
          );
        })}
      </div>
      {attempt.kind === "scored" ? (
        <button
          className="anatomy-submit-test"
          type="button"
          onClick={(event) => {
            event.preventDefault();
            onTryAgain();
          }}
          disabled={disabled}
        >Try again</button>
      ) : (
        <button className="anatomy-submit-test" type="submit" disabled={disabled || attempt.kind === "submitting"}>
          {attempt.kind === "submitting" ? "Saving score…" : "Submit score"}
        </button>
      )}
      {attempt.kind === "editing" && attempt.error !== null ? <p role="alert">{attempt.error}</p> : null}
    </form>
  );
}

export type AnatomySkeletonStudyProps = Readonly<{
  props: AnatomySkeletonProps;
  disabled?: boolean;
  webMcpEnabled?: boolean;
  layout?: NotebookLayout;
  onLayoutChange?: (layout: NotebookLayout) => void;
  onSubmit: (section: AnatomySection, answers: Readonly<Record<string, string>>) => Promise<boolean> | boolean;
}>;

export function AnatomySkeletonStudy({
  props,
  disabled = false,
  webMcpEnabled = true,
  layout = "single",
  onLayoutChange,
  onSubmit,
}: AnatomySkeletonStudyProps): React.JSX.Element {
  const initialBone = firstBone("thorax");
  const mountRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<HTMLButtonElement | null>(null);
  const testInputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const runtimeRef = useRef<AnatomyAtlasScene | null>(null);
  const identityRef = useRef<AtlasIdentity | null>(null);
  const modeRef = useRef<StudyMode>("study");
  const sectionRef = useRef<AnatomySection>("thorax");
  const selectedBoneIdRef = useRef(initialBone.id);
  const hoveredBoneIdRef = useRef<string | null>(null);
  const attemptRef = useRef<TestAttempt>(editingAttempt());
  const isolatedRef = useRef(false);
  const atlasStateRef = useRef<AtlasState>("loading");
  const cameraRef = useRef<CameraSnapshot>(INITIAL_CAMERA);
  const onSubmitRef = useRef(onSubmit);
  const layoutRef = useRef<NotebookLayout>(layout);
  const onLayoutChangeRef = useRef(onLayoutChange);
  const submissionGenerationRef = useRef(0);
  const controllerRef = useRef<AnatomyController>({ active: true, actions: null });

  const [mode, setModeState] = useState<StudyMode>("study");
  const [section, setSectionState] = useState<AnatomySection>("thorax");
  const [selectedBoneId, setSelectedBoneIdState] = useState(initialBone.id);
  const [hoveredBoneId, setHoveredBoneIdState] = useState<string | null>(null);
  const [attempt, setAttemptState] = useState<TestAttempt>(editingAttempt());
  const [isolated, setIsolatedState] = useState(false);
  const [atlasState, setAtlasState] = useState<AtlasState>("loading");
  const [camera, setCameraState] = useState<CameraSnapshot>(INITIAL_CAMERA);
  const [projection, setProjection] = useState<ProjectedAtlasPoint | null>(null);
  const [labelSide, setLabelSide] = useState<"left" | "right">("right");

  const sectionBones = useMemo(() => bonesForSection(section), [section]);
  const selectedBone = ADULT_SKELETON_BONES.find((bone) => bone.id === selectedBoneId) ?? initialBone;
  const hoveredBone = hoveredBoneId === null
    ? null
    : ADULT_SKELETON_BONES.find((bone) => bone.id === hoveredBoneId) ?? null;

  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  useEffect(() => {
    layoutRef.current = layout;
    onLayoutChangeRef.current = onLayoutChange;
  }, [layout, onLayoutChange]);

  const replaceAttempt = useCallback((next: TestAttempt): void => {
    attemptRef.current = next;
    setAttemptState(next);
  }, []);

  const focusTestInput = useCallback((questionNumber: number): void => {
    queueMicrotask(() => testInputRefs.current[questionNumber - 1]?.focus());
  }, []);

  const refreshProjection = useCallback((boneId?: string | null): void => {
    const runtime = runtimeRef.current;
    const targetBoneId = boneId ?? hoveredBoneIdRef.current ?? selectedBoneIdRef.current;
    const next = runtime === null || targetBoneId.length === 0 ? null : runtime.projectBone(targetBoneId);
    setProjection(next);
    const width = mountRef.current?.clientWidth ?? 0;
    setLabelSide(next !== null && width > 0 && next.x > width * 0.68 ? "left" : "right");
  }, []);

  const syncProjectionStyle = useCallback((): void => {
    const runtime = runtimeRef.current;
    const marker = markerRef.current;
    if (runtime === null || marker === null) return;
    const targetBoneId = hoveredBoneIdRef.current ?? selectedBoneIdRef.current;
    const next = runtime.projectBone(targetBoneId);
    marker.hidden = next === null || !next.visible;
    if (next === null) return;
    const width = mountRef.current?.clientWidth ?? 0;
    marker.dataset.labelSide = width > 0 && next.x > width * 0.68 ? "left" : "right";
    marker.style.left = `${next.x}px`;
    marker.style.top = `${next.y}px`;
  }, []);

  const applyIsolation = useCallback((boneId: string | null): void => {
    runtimeRef.current?.setIsolatedBone(boneId);
    const next = boneId !== null;
    isolatedRef.current = next;
    setIsolatedState(next);
    refreshProjection();
  }, [refreshProjection]);

  const selectBone = useCallback((bone: BoneEntry, focus: boolean, animateFocus = true): void => {
    selectedBoneIdRef.current = bone.id;
    setSelectedBoneIdState(bone.id);
    const runtime = runtimeRef.current;
    runtime?.setSelectedBone(bone.id);
    if (focus) runtime?.focusBone(bone.id, animateFocus);
    if (isolatedRef.current) runtime?.setIsolatedBone(bone.id);
    refreshProjection(bone.id);
  }, [refreshProjection]);

  const hoverBone = useCallback((bone: BoneEntry | null): void => {
    const boneId = bone?.id ?? null;
    if (hoveredBoneIdRef.current === boneId) return;
    hoveredBoneIdRef.current = boneId;
    setHoveredBoneIdState(boneId);
    runtimeRef.current?.setHoveredBone(boneId);
    refreshProjection(boneId ?? selectedBoneIdRef.current);
  }, [refreshProjection]);

  const replaceSection = useCallback((nextSection: AnatomySection): void => {
    submissionGenerationRef.current += 1;
    sectionRef.current = nextSection;
    setSectionState(nextSection);
    const bone = firstBone(nextSection);
    selectBone(bone, false);
    hoverBone(null);
    replaceAttempt(editingAttempt());
    if (modeRef.current === "test") focusTestInput(1);
  }, [focusTestInput, hoverBone, replaceAttempt, selectBone]);

  const replaceMode = useCallback((nextMode: StudyMode): void => {
    if (modeRef.current === nextMode) return;
    submissionGenerationRef.current += 1;
    modeRef.current = nextMode;
    setModeState(nextMode);
    hoverBone(null);
    if (nextMode === "test") {
      replaceAttempt(editingAttempt());
      selectBone(firstBone(sectionRef.current), false);
      focusTestInput(1);
    }
  }, [focusTestInput, hoverBone, replaceAttempt, selectBone]);

  const setCameraPreset = useCallback((view: AtlasCameraPreset): CameraSnapshot => {
    runtimeRef.current?.setCameraPreset(view);
    const next = runtimeRef.current?.getCamera() ?? cameraRef.current;
    cameraRef.current = next;
    setCameraState(next);
    refreshProjection();
    return next;
  }, [refreshProjection]);

  const resetView = useCallback((): void => {
    const defaultBone = firstBone(sectionRef.current);
    applyIsolation(null);
    hoverBone(null);
    selectBone(defaultBone, false);
    if (modeRef.current === "test") {
      replaceAttempt({ ...attemptRef.current, activeQuestionNumber: 1 });
    }
    setCameraPreset("anterior");
  }, [applyIsolation, hoverBone, replaceAttempt, selectBone, setCameraPreset]);

  const focusStudyBone = useCallback((
    boneId: string,
    isolateChoice: boolean | undefined,
  ): Readonly<Record<string, unknown>> | null => {
    const bone = ADULT_SKELETON_BONES.find((candidate) => candidate.id === boneId);
    if (bone === undefined || modeRef.current !== "study") return null;
    if (bone.section !== sectionRef.current) replaceSection(bone.section);
    selectBone(bone, true);
    if (isolateChoice !== undefined) applyIsolation(isolateChoice ? bone.id : null);
    return { focused_bone: boneSnapshot(bone), isolated: isolatedRef.current };
  }, [applyIsolation, replaceSection, selectBone]);

  const focusTestQuestion = useCallback((
    questionNumber: number,
    isolateChoice: boolean | undefined,
  ): Readonly<Record<string, unknown>> | null => {
    if (modeRef.current !== "test") return null;
    const bone = bonesForSection(sectionRef.current)[questionNumber - 1];
    if (bone === undefined) return null;
    const current = attemptRef.current;
    let next: TestAttempt;
    if (current.kind === "editing") next = { ...current, activeQuestionNumber: questionNumber };
    else if (current.kind === "submitting") next = { ...current, activeQuestionNumber: questionNumber };
    else next = { ...current, activeQuestionNumber: questionNumber };
    replaceAttempt(next);
    selectBone(bone, true);
    if (isolateChoice !== undefined) applyIsolation(isolateChoice ? bone.id : null);
    focusTestInput(questionNumber);
    return { focusedQuestionNumber: questionNumber, isolated: isolatedRef.current };
  }, [applyIsolation, focusTestInput, replaceAttempt, selectBone]);

  const setTestAnswer = useCallback((
    questionNumber: number,
    answer: string,
  ): Readonly<Record<string, unknown>> | null => {
    if (modeRef.current !== "test") return null;
    const bone = bonesForSection(sectionRef.current)[questionNumber - 1];
    const current = attemptRef.current;
    if (bone === undefined || current.kind !== "editing") return null;
    const next: TestAttempt = {
      kind: "editing",
      answers: { ...current.answers, [bone.id]: answer },
      activeQuestionNumber: questionNumber,
      error: null,
    };
    replaceAttempt(next);
    const bones = bonesForSection(sectionRef.current);
    return {
      questionNumber,
      completed: answer.trim().length > 0,
      answered: completedAnswerCount(next, bones),
      questionCount: bones.length,
    };
  }, [replaceAttempt]);

  const submitTest = useCallback(async (): Promise<TestScore | null> => {
    if (modeRef.current !== "test") return null;
    const current = attemptRef.current;
    if (current.kind === "submitting") return null;
    if (current.kind === "scored") return current.score;
    const activeSection = sectionRef.current;
    const generation = ++submissionGenerationRef.current;
    const score = scoreBoneAnswers(current.answers, bonesForSection(activeSection));
    replaceAttempt({
      kind: "submitting",
      answers: current.answers,
      activeQuestionNumber: current.activeQuestionNumber,
    });
    let persisted = false;
    try {
      persisted = await onSubmitRef.current(activeSection, current.answers);
    } catch {
      persisted = false;
    }
    if (submissionGenerationRef.current !== generation || modeRef.current !== "test" || sectionRef.current !== activeSection) {
      return null;
    }
    if (!persisted) {
      replaceAttempt({
        kind: "editing",
        answers: current.answers,
        activeQuestionNumber: current.activeQuestionNumber,
        error: "The score was not saved. Keep this attempt open and try again.",
      });
      return null;
    }
    const scored: TestAttempt = {
      kind: "scored",
      answers: current.answers,
      activeQuestionNumber: current.activeQuestionNumber,
      score,
    };
    replaceAttempt(scored);
    return score;
  }, [replaceAttempt]);

  const tryAgain = useCallback((): void => {
    submissionGenerationRef.current += 1;
    replaceAttempt(editingAttempt());
    selectBone(firstBone(sectionRef.current), false);
    applyIsolation(null);
    focusTestInput(1);
  }, [applyIsolation, focusTestInput, replaceAttempt, selectBone]);

  const contextSnapshot = useCallback((): Readonly<Record<string, unknown>> => {
    const currentMode = modeRef.current;
    const currentSection = sectionRef.current;
    const bones = bonesForSection(currentSection);
    const identity = identityRef.current;
    const selected = ADULT_SKELETON_BONES.find((bone) => bone.id === selectedBoneIdRef.current);
    const visibleSemanticMeshCount = isolatedRef.current
      ? selected?.sourceMeshCount ?? 0
      : identity?.semanticMeshCount ?? 0;
    const base = {
      mode: currentMode,
      section: currentSection,
      layout: layoutRef.current,
      logicalBoneCount: identity?.logicalBoneCount ?? props.logicalBoneCount,
      semanticMeshNodeCount: identity?.semanticMeshCount ?? props.semanticMeshCount,
      visibleSemanticMeshCount,
      integrity: {
        semantic_identity_verified: identity !== null,
        catalog_ids_match: identity?.logicalBoneCount === props.logicalBoneCount &&
          identity.semanticMeshCount === props.semanticMeshCount,
        upright: identity?.upright === true,
        normalized_dimensions: identity === null ? null : [...identity.normalizedDimensions],
        model_dimensions: identity === null ? null : {
          width: identity.normalizedDimensions[0],
          height: identity.normalizedDimensions[1],
          depth: identity.normalizedDimensions[2],
        },
      },
      camera: cameraRef.current,
      isolated: isolatedRef.current,
      available_tools: [...ANATOMY_TOOL_NAMES],
    };
    if (currentMode === "study") {
      const hovered = hoveredBoneIdRef.current === null
        ? undefined
        : ADULT_SKELETON_BONES.find((bone) => bone.id === hoveredBoneIdRef.current);
      return {
        ...base,
        selected_bone: selected === undefined ? null : boneSnapshot(selected),
        hovered_bone: hovered === undefined ? null : boneSnapshot(hovered),
      };
    }
    const currentAttempt = attemptRef.current;
    return {
      ...base,
      questionCount: bones.length,
      answered: completedAnswerCount(currentAttempt, bones),
      activeQuestionNumber: currentAttempt.activeQuestionNumber,
      questions: bones.map((bone, index) => ({
        questionNumber: index + 1,
        completed: (currentAttempt.answers[bone.id] ?? "").trim().length > 0,
      })),
      submitted: currentAttempt.kind === "scored",
      score: currentAttempt.kind === "scored" ? currentAttempt.score : null,
    };
  }, [props.logicalBoneCount, props.semanticMeshCount]);

  useEffect(() => {
    controllerRef.current.actions = {
      context: contextSnapshot,
      setMode: (nextMode) => {
        replaceMode(nextMode);
        return contextSnapshot();
      },
      setSection: (nextSection) => {
        replaceSection(nextSection);
        return contextSnapshot();
      },
      setSession: ({ mode: nextMode, section: nextSection }) => {
        replaceMode(nextMode);
        replaceSection(nextSection);
        selectBone(firstBone(nextSection), true, false);
        return contextSnapshot();
      },
      setLayout: (nextLayout) => {
        layoutRef.current = nextLayout;
        onLayoutChangeRef.current?.(nextLayout);
      },
      setIsolation: (nextIsolated) => {
        applyIsolation(nextIsolated ? selectedBoneIdRef.current : null);
      },
      focusStudyBone,
      focusTestQuestion,
      setAnswer: setTestAnswer,
      submitTest,
      setCamera: setCameraPreset,
      ready: () => atlasStateRef.current === "ready" && identityRef.current !== null,
    };
  }, [
    contextSnapshot,
    applyIsolation,
    focusStudyBone,
    focusTestQuestion,
    replaceMode,
    replaceSection,
    selectBone,
    setCameraPreset,
    setTestAnswer,
    submitTest,
  ]);

  useEffect(() => {
    if (!webMcpEnabled) return;
    const modelContext = document.modelContext;
    const controller = controllerRef.current;
    controller.active = true;
    if (modelContext !== undefined) void bindAnatomyTools(modelContext, controller).catch(() => undefined);
    return () => {
      controller.active = false;
      controller.actions = null;
      if (modelContext !== undefined) unbindAnatomyTools(modelContext, controller);
    };
  }, [webMcpEnabled]);

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    let active = true;
    delete mount.dataset.atlasError;
    atlasStateRef.current = "loading";
    setAtlasState("loading");
    const initialize = async (): Promise<void> => {
      try {
        const runtime = await createAnatomyAtlasScene(mount, {
          onHover: (hit: AtlasHit | null) => {
            if (!active || modeRef.current !== "study") return;
            const bone = hit === null
              ? null
              : ADULT_SKELETON_BONES.find((candidate) => candidate.id === hit.boneId) ?? null;
            hoverBone(bone);
          },
          onSelect: (hit: AtlasHit | null) => {
            if (!active || hit === null) return;
            const bone = ADULT_SKELETON_BONES.find((candidate) => candidate.id === hit.boneId);
            if (bone === undefined) return;
            if (modeRef.current === "study") {
              if (bone.section !== sectionRef.current) replaceSection(bone.section);
              selectBone(bone, false);
              return;
            }
            const questionNumber = bonesForSection(sectionRef.current).findIndex((candidate) => candidate.id === bone.id) + 1;
            if (questionNumber > 0) focusTestQuestion(questionNumber, undefined);
          },
          onCameraChange: (nextCamera: CameraSnapshot) => {
            if (!active) return;
            cameraRef.current = nextCamera;
            setCameraState((current) => current.view === nextCamera.view ? current : nextCamera);
            syncProjectionStyle();
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
          throw new Error("The atlas identity did not match the pinned anatomy catalogue.");
        }
        runtimeRef.current = runtime;
        identityRef.current = identity;
        runtime.setSelectedBone(selectedBoneIdRef.current);
        cameraRef.current = runtime.getCamera();
        setCameraState(cameraRef.current);
        atlasStateRef.current = "ready";
        setAtlasState("ready");
        refreshProjection();
      } catch (error: unknown) {
        if (!active) return;
        mount.dataset.atlasError = error instanceof Error ? error.message : "The anatomy atlas could not open.";
        runtimeRef.current = null;
        identityRef.current = null;
        atlasStateRef.current = "unavailable";
        setAtlasState("unavailable");
      }
    };
    void initialize();
    return () => {
      active = false;
      submissionGenerationRef.current += 1;
      const runtime = runtimeRef.current;
      runtimeRef.current = null;
      identityRef.current = null;
      runtime?.dispose();
      mount.replaceChildren();
    };
  }, [
    focusTestQuestion,
    hoverBone,
    props.logicalBoneCount,
    props.semanticMeshCount,
    refreshProjection,
    replaceSection,
    selectBone,
    syncProjectionStyle,
  ]);

  const markerBone = hoveredBone ?? selectedBone;
  const markerQuestionNumber = sectionBones.findIndex((bone) => bone.id === selectedBone.id) + 1;
  const markerPosition = projection ?? { x: 0, y: 0, visible: false };
  const latestScore = attempt.kind === "scored" ? attempt.score : props.latestSubmission;
  const interactionDisabled = disabled || atlasState !== "ready";

  return (
    <section
      className="anatomy-study-card"
      data-atlas-state={atlasState}
      data-logical-bones={props.logicalBoneCount}
      data-semantic-meshes={props.semanticMeshCount}
      data-anatomy-mode={mode}
      data-mode={mode}
      data-section={section}
      {...(mode === "study" ? { "data-selected-bone": selectedBone.id } : {})}
      aria-label="Interactive adult skeleton study"
    >
      <header className="anatomy-study-header">
        <div>
          <span className="anatomy-kicker">Anatomy Lab 01</span>
          <h3>Adult skeleton</h3>
        </div>
        <div className="anatomy-mode-switch" role="group" aria-label="Study mode">
          <button type="button" aria-pressed={mode === "study"} onClick={() => replaceMode("study")} disabled={interactionDisabled}>Study</button>
          <button type="button" aria-pressed={mode === "test"} onClick={() => replaceMode("test")} disabled={interactionDisabled}>Test</button>
        </div>
        <div className="anatomy-count"><strong>{props.logicalBoneCount}</strong><span>identities</span></div>
      </header>
      <nav className="anatomy-section-tabs" aria-label="Anatomy section">
        {ANATOMY_SECTIONS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            aria-pressed={candidate.id === section}
            onClick={() => replaceSection(candidate.id)}
            disabled={interactionDisabled}
          >
            {candidate.shortLabel}
          </button>
        ))}
      </nav>
      <div className="anatomy-study-layout">
        <div className="anatomy-model-stage" data-model-state={atlasState}>
          <div ref={mountRef} className="anatomy-model-canvas" aria-label="Draggable and zoomable 3D skeleton" />
          {atlasState === "loading" ? <div className="anatomy-model-message">Preparing the verified atlas…</div> : null}
          {atlasState === "unavailable" ? (
            <div className="anatomy-model-message anatomy-model-message--error" role="alert">
              <strong>Atlas unavailable</strong>
              <span>The pinned source-mesh atlas could not be verified. No labels or test answers were enabled.</span>
            </div>
          ) : null}
          {atlasState === "ready" ? (
            mode === "study" ? (
              <button
                ref={markerRef}
                type="button"
                className="anatomy-hotspot-label"
                data-label-side={labelSide}
                style={{ left: `${markerPosition.x}px`, top: `${markerPosition.y}px` }}
                hidden={!markerPosition.visible}
                onPointerEnter={() => hoverBone(markerBone)}
                onPointerLeave={() => hoverBone(null)}
                onClick={() => selectBone(markerBone, true)}
                disabled={interactionDisabled}
              >
                <span />{markerBone.name}
              </button>
            ) : markerQuestionNumber > 0 ? (
              <button
                ref={markerRef}
                type="button"
                className="anatomy-hotspot-label anatomy-hotspot-label--test"
                data-label-side={labelSide}
                style={{ left: `${markerPosition.x}px`, top: `${markerPosition.y}px` }}
                hidden={!markerPosition.visible}
                onClick={() => focusTestQuestion(markerQuestionNumber, undefined)}
                disabled={interactionDisabled}
              >
                <span>{markerQuestionNumber}</span>Question {markerQuestionNumber}
              </button>
            ) : null
          ) : null}
          <div className="anatomy-model-controls" role="group" aria-label="Skeleton camera and visibility controls">
            <span>Drag to orbit · wheel or pinch to zoom</span>
            <button
              type="button"
              onClick={resetView}
              disabled={interactionDisabled}
            >Reset view</button>
            <button
              type="button"
              onClick={() => runtimeRef.current?.focusBone(selectedBone.id)}
              disabled={interactionDisabled}
            >Focus</button>
            {isolated ? (
              <button type="button" onClick={() => applyIsolation(null)} disabled={interactionDisabled}>Show all</button>
            ) : (
              <button type="button" onClick={() => applyIsolation(selectedBone.id)} disabled={interactionDisabled}>Isolate</button>
            )}
            <button
              type="button"
              aria-pressed={camera.view === "anterior"}
              onClick={() => setCameraPreset("anterior")}
              disabled={interactionDisabled}
            >Anterior</button>
            <button
              type="button"
              aria-pressed={camera.view === "left"}
              onClick={() => setCameraPreset("left")}
              disabled={interactionDisabled}
            >Left</button>
            <button
              type="button"
              aria-pressed={camera.view === "right"}
              onClick={() => setCameraPreset("right")}
              disabled={interactionDisabled}
            >Right</button>
          </div>
          <a
            className="anatomy-attribution"
            href="https://github.com/Z-Anatomy/Models-of-human-anatomy"
            target="_blank"
            rel="noreferrer"
          >
            Z-Anatomy · CC BY-SA 4.0 · source-mesh identities
          </a>
        </div>
        {mode === "study" ? (
          <BoneSearch
            key={section}
            bones={sectionBones}
            selectedBoneId={selectedBone.id}
            hoveredBoneId={hoveredBoneId}
            disabled={interactionDisabled}
            onSelect={(bone) => selectBone(bone, true)}
            onHover={hoverBone}
          />
        ) : (
          <BoneTest
            bones={sectionBones}
            attempt={attempt}
            disabled={interactionDisabled}
            inputRefs={testInputRefs}
            onAnswer={(questionNumber, answer) => { setTestAnswer(questionNumber, answer); }}
            onFocusQuestion={(questionNumber) => { focusTestQuestion(questionNumber, undefined); }}
            onSubmit={submitTest}
            onTryAgain={tryAgain}
          />
        )}
      </div>
      <footer className="anatomy-study-footer">
        <div>
          <span>Current set</span>
          <strong>{sectionLabel(section)} · {sectionBones.length} identities</strong>
        </div>
        <span className="anatomy-map-status">
          {props.logicalBoneCount} identities · {props.semanticMeshCount} source meshes verified
          {webMcpEnabled ? ` · ${ANATOMY_TOOL_NAMES.length} agent controls` : " · judge demo controls isolated"}
        </span>
        {latestScore === undefined ? <span>No scored attempt yet</span> : (
          <div className="anatomy-score-pill"><span>Latest score</span><strong>{scoreLabel(latestScore)}</strong></div>
        )}
      </footer>
    </section>
  );
}
