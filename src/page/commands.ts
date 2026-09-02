import { z } from "zod";

import type { JsonValue } from "../domain";
import {
  ANATOMY_EXAM_PREP_TEMPLATE,
  ANATOMY_COLORING_COMPONENT_VERSION,
  AnatomyColoringPropsSchema,
  AnatomySectionSchema,
  AnatomySkeletonPropsSchema,
  AnatomySurfacePaintAnchorSchema,
  AnatomySurfacePaintBrushSchema,
  COLORING_PALETTE,
  MAX_SURFACE_PAINT_ANCHORS_PER_STROKE,
  applyAnatomyPaintEdit,
  applyAnatomyComposition,
  bonesForSection,
  coloringCompletion,
  createAnatomyCompositionProposal,
  parseAnatomyComponent,
  scoreBoneAnswers,
  surfacePaintStateFingerprint,
  verifyAnatomyComposition,
  type AnatomyPaintEdit,
  type AnatomyCompositionProposal,
  type AnatomyCompositionVerification,
  type AnatomyColoringProps,
  type AnatomySection,
  type AnatomySkeletonProps,
} from "../anatomy";
import type { WebMcpModelContext } from "../types/webmcp";
import {
  CalculusPracticePropsSchema,
  ColoringEditSchema,
  applyColoringEdit,
  parseLearningActivity,
  scoreCalculusPractice,
  updateLearningActivity,
  type ColoringEdit,
} from "../learning/activities";
import {
  PageStorageError,
  type PageStorage,
  type PageCommitResult,
  type PageReceipt,
} from "../indexeddb/page-storage";
import {
  PAGE_CONTENT_RECT,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  addElement,
  appendPage,
  continueText,
  createActorId,
  createDocumentRevision,
  createElementId,
  createMutationId,
  createPageId,
  createPageRevision,
  createPageScrapId,
  createTextBlockId,
  derivePagePlainText,
  formatTextRange,
  isSafeStructuredTextInput,
  richTextFromPlainText,
  setStructuredText,
  stableBlockId,
  stableElementId,
  updateDiagramNodePositions,
  updateElementFrame,
  updatePagePresentation,
  validatePage,
  validatePageDocument,
  validateDiagramDocument,
  validateStructuredTextBlocks,
  type ActorId,
  type AnnotationElement,
  type AnnotationAnchor,
  type DiagramElement,
  type DiagramDocument,
  type EmbeddedFrameElement,
  type DiagramTemplate,
  type ElementId,
  type PageCandidate,
  type PageDocument,
  type PageElement,
  type PageId,
  type PagePaper,
  type PageRecord,
  type PageRect,
  type PageSizePreset,
  type PageVectorInkElement,
  type RichTextMark,
  type StructuredTextBlock,
  type ShapeElement,
  type StrokeElement,
  type TextBlockId,
  type TextElement,
  type WorkbookId,
} from "./domain";
import {
  ElementTargetSchema,
  PageCandidateError,
  PageIdSchema,
  PageTargetError,
  TargetResolveSchema,
  pageFor,
  resolveAnnotationTarget,
  resolvePageCommandTarget,
  resolveTextTarget,
  targetFromAnchor,
  type ResolvedPageCommandTarget,
  type ResolvedAnnotationTarget,
  type TextRangeCandidate,
} from "./command-targets";
import { layoutPage, visiblePageIds as resolveVisiblePageIds, type PagePresentation } from "./layout";
import { DIAGRAM_TEMPLATE_INPUTS, resolveDiagramTemplate } from "./diagram-templates";
import { findReviewCalloutFrame, reviewCalloutHeight, REVIEW_CALLOUT_MIN_WIDTH } from "./review-callout";
import {
  assertSafeDiagramFrame,
  assertSafeVectorFrame,
  PagePlacementError,
  shapeFrame,
  vectorInkFrame,
} from "./placement";
import {
  VectorInkDocumentSchema,
  VectorInkProvenanceSchema,
  validateVectorInkDocument,
  validateVectorInkProvenance,
  type VectorInkDocument,
  type VectorInkProvenance,
} from "./vector-ink";
import {
  applyVectorInkReplacement,
  assertVectorInkReplacementProposalCurrent,
  createVectorInkReplacementProposal,
  resolveVectorInkReplacementTarget,
  VectorInkReplacementError,
  type VectorInkReplacementProposal,
} from "./vector-ink-replacement";

export type PageCommandSource = "manual" | "webmcp";
export type PageCommandName =
  | "page_context_read"
  | "page_composition_propose"
  | "page_composition_apply"
  | "page_composition_verify"
  | "page_anatomy_coloring_read"
  | "page_anatomy_paint_apply"
  | "page_anatomy_quiz_submit"
  | "page_calc_practice_submit"
  | "page_coloring_edit"
  | "page_target_resolve"
  | "page_text_insert"
  | "page_structured_text_set"
  | "page_text_format"
  | "page_stroke_add"
  | "page_shape_add"
  | "page_vector_ink_add"
  | "page_vector_ink_replace_propose"
  | "page_vector_ink_replace_apply"
  | "page_diagram_add"
  | "page_diagram_frame_set"
  | "page_diagram_nodes_set"
  | "page_annotation_add"
  | "page_review_callout_add"
  | "page_element_frame_set"
  | "page_element_move"
  | "page_element_resize"
  | "page_advance"
  | "page_text_continue"
  | "page_rework_apply"
  | "page_scrap_restore"
  | "page_presentation_set"
  | "page_writer_claim"
  | "page_writer_release"
  | "page_undo";

export type PageElementContext = Readonly<{
  id: ElementId;
  kind: PageElement["kind"];
  label: string;
  frame: PageRect;
  plainText?: string;
  blockIds?: readonly TextBlockId[];
  relationship?:
    | Readonly<{
        kind: "review-callout";
        sourceElementId: ElementId;
        target: AnnotationAnchor;
        reviewKind: "explanation" | "replacement";
      }>
    | Readonly<{
        kind: "arrow";
        sourceElementId: ElementId | null;
        target: AnnotationAnchor;
      }>
    | Readonly<{
        kind: "mark";
        target: AnnotationAnchor;
      }>
  description?: string;
}>;

export type VisiblePageContext = Readonly<{
  pageId: PageId;
  pageNumber: number;
  pageRevision: number;
  plainText: string;
  elements: readonly PageElementContext[];
}>;

export type PageViewContext = Readonly<{
  presentation: PagePresentation;
  visiblePageIds: readonly PageId[];
}>;

export type PageContext = Readonly<{
  workbookId: WorkbookId;
  documentRevision: number;
  pageCount: number;
  focusedPageId: PageId;
  focusedPageNumber: number;
  previousPageId: PageId | null;
  nextPageId: PageId | null;
  pageRevision: number;
  paper: PagePaper;
  pageSize: Readonly<{ width: number; height: number }>;
  plainText: string;
  elements: readonly PageElementContext[];
  presentation: PagePresentation;
  visiblePageIds: readonly PageId[];
  visiblePages: readonly VisiblePageContext[];
  recentReceiptId: string | null;
}>;

export type PageReceiptSummary = Pick<
  PageReceipt,
  | "id"
  | "workbookId"
  | "mutationId"
  | "actorId"
  | "source"
  | "kind"
  | "completedAt"
  | "affectedPageIds"
  | "resultingDocumentRevision"
  | "resultingPageRevisions"
  | "undo"
>;

export type PageCommandSuccess = Readonly<{
  outcome: "success";
  command: PageCommandName;
  output: Readonly<{
    context: PageContext;
    receipt?: PageReceiptSummary;
    resolution?: ResolvedPageCommandTarget;
    replacementProposal?: Readonly<{
      proposalId: string;
      pageId: PageId;
      elementId: ElementId;
    }>;
    proposal?: AnatomyCompositionProposal;
    verification?: AnatomyCompositionVerification;
  }>;
}>;
export type { ResolvedPageCommandTarget, TextRangeCandidate } from "./command-targets";
export type PageCommandFailure = Readonly<{
  outcome: "error";
  command: string;
  error: Readonly<{
    code:
      | "UNKNOWN_COMMAND"
      | "INPUT_VALIDATION_ERROR"
      | "TARGET_NOT_FOUND"
      | "TARGET_AMBIGUOUS"
      | "REVISION_CONFLICT"
      | "PAGE_BUSY"
      | "PAGE_NOT_VISIBLE"
      | "NO_OP"
      | "SAFE_PLACEMENT_UNAVAILABLE"
      | "TARGET_NOT_VECTOR_INK"
      | "STALE_REPLACEMENT"
      | "VECTOR_INK_NO_OP"
      | "REPLACEMENT_REVIEW_IN_PROGRESS"
      | "REPLACEMENT_REVIEW_NOT_FOUND"
      | "STALE_UNDO"
      | "COMMAND_ERROR";
    message: string;
    candidates?: readonly (PageCandidate | TextRangeCandidate)[];
  }>;
}>;
export type PageCommandResult = PageCommandSuccess | PageCommandFailure;

export type PageCommandDescriptor = Readonly<{
  name: PageCommandName;
  description: string;
  readOnly: boolean;
  untrustedContent: boolean;
  exposure: Readonly<Record<PageCommandSource, boolean>>;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
}>;

type CommandDefinition = Readonly<{
  name: PageCommandName;
  description: string;
  readOnly: boolean;
  exposure?: Readonly<Partial<Record<PageCommandSource, boolean>>>;
  schema: z.ZodType;
  run: (input: never, source: PageCommandSource) => Promise<PageCommandSuccess["output"]>;
}>;

export type PageVectorInkReplacementReviewState =
  | Readonly<{ kind: "closed" }>
  | Readonly<{
      kind: "reviewing" | "applying";
      proposal: VectorInkReplacementProposal;
      target: Readonly<{
        pageId: PageId;
        pageNumber: number;
        elementId: ElementId;
        label: string;
        description: string;
        frame: PageRect;
        priorDocument: VectorInkDocument;
      }>;
    }>
  | Readonly<{
      kind: "apply-error";
      proposal: VectorInkReplacementProposal;
      target: Readonly<{
        pageId: PageId;
        pageNumber: number;
        elementId: ElementId;
        label: string;
        description: string;
        frame: PageRect;
        priorDocument: VectorInkDocument;
      }>;
      message: string;
    }>;

const VectorInkDocumentInputSchema = VectorInkDocumentSchema.superRefine((value, context) => {
  try {
    validateVectorInkDocument(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid vector ink document",
    });
  }
});
const VectorInkProvenanceInputSchema = VectorInkProvenanceSchema.superRefine((value, context) => {
  try {
    validateVectorInkProvenance(value);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : "Invalid vector ink provenance",
    });
  }
});
const MutationSchema = z.object({
  mutationId: z.string().trim().min(1).max(180),
  actorId: z.string().trim().min(1).max(180).optional(),
  claimId: z.string().trim().min(1).max(180).optional(),
}).strict();
const PageMutationSchema = MutationSchema.extend({
  pageId: PageIdSchema.optional(),
  expectedRevision: z.number().int().positive(),
});
const AnatomyPaintEditSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("surface-stroke"),
    boneId: z.string().trim().min(1).max(200),
    brush: AnatomySurfacePaintBrushSchema,
    anchors: z.array(AnatomySurfacePaintAnchorSchema).min(1).max(MAX_SURFACE_PAINT_ANCHORS_PER_STROKE),
  }).strict(),
  z.object({
    kind: z.literal("clear-bone"),
    boneId: z.string().trim().min(1).max(200),
  }).strict(),
  z.object({ kind: z.literal("clear-section") }).strict(),
]);
const FrameSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
}).strict();
const MarksSchema = z.array(z.enum(["bold", "italic", "underline", "code"]));
const StructuredTextRunSchema = z.object({
  text: z.string(),
  marks: MarksSchema.max(4),
}).strict().superRefine((run, context) => {
  if (new Set(run.marks).size !== run.marks.length) context.addIssue({ code: "custom", message: "Marks must be unique within a text run." });
  if (!isSafeStructuredTextInput(run.text)) context.addIssue({ code: "custom", message: "Structured text cannot contain raw markup, executable content, URLs, or filesystem paths." });
});
const StructuredTextBlockSchema = z.object({
  id: z.string().trim().min(1).max(240),
  kind: z.enum(["paragraph", "heading", "quote", "bullet-list-item", "ordered-list-item"]),
  runs: z.array(StructuredTextRunSchema).min(1).max(256),
}).strict();
const StructuredTextBlocksSchema = z.array(StructuredTextBlockSchema).min(1).max(128).superRefine((blocks, context) => {
  try {
    validateStructuredTextBlocks(blocks.map((block) => ({
      id: createTextBlockId(block.id),
      kind: block.kind,
      runs: block.runs,
    })));
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid structured text." });
  }
});
const DiagramDocumentInputSchema = z.custom<DiagramDocument>((value) => {
  try {
    validateDiagramDocument(value);
    return true;
  } catch {
    return false;
  }
}, "The semantic diagram is malformed.");
function actorFor(source: PageCommandSource, rawActorId?: string): ActorId {
  return createActorId(rawActorId ?? (source === "manual" ? "person:desk" : "assistant:webmcp"));
}

function sourceForStorage(source: PageCommandSource): "person" | "assistant" {
  return source === "manual" ? "person" : "assistant";
}

function elementContext(element: PageElement): PageElementContext {
  const relationship = element.kind !== "annotation"
    ? undefined
    : element.reviewKind !== undefined
      ? {
          kind: "review-callout" as const,
          sourceElementId: element.id,
          target: element.anchor,
          reviewKind: element.reviewKind,
        }
      : element.annotation === "arrow"
        ? {
            kind: "arrow" as const,
            sourceElementId: element.sourceElementId ?? null,
            target: element.anchor,
          }
        : { kind: "mark" as const, target: element.anchor };
  const anatomyComponent = element.kind === "embedded-frame" ? parseAnatomyComponent(element) : null;
  const anatomyColoringCompletion = anatomyComponent?.kind === "coloring" ? coloringCompletion({
    section: anatomyComponent.props.section,
    baseFills: anatomyComponent.props.baseFills,
    surfaceStrokes: anatomyComponent.props.surfaceStrokes,
  }) : null;
  const anatomyDescription = anatomyComponent?.kind === "skeleton"
    ? "Interactive source-mesh atlas with 206 registered bones, study labels, and scored test mode."
    : anatomyComponent?.kind === "coloring" && anatomyColoringCompletion !== null
      ? `${anatomyComponent.props.section} 3D coloring lab with ${anatomyColoringCompletion.completedBoneCount} worked bones and ${anatomyColoringCompletion.surfaceStrokeCount} local surface strokes.`
    : undefined;
  const learningActivity = element.kind === "embedded-frame" ? parseLearningActivity(element) : null;
  const learningDescription = learningActivity?.kind === "calculus"
    ? `${learningActivity.props.title} with ${learningActivity.props.questions.length} scored response fields${learningActivity.props.latestSubmission === undefined ? "." : `; latest score ${learningActivity.props.latestSubmission.score} of ${learningActivity.props.latestSubmission.total}.`}`
    : learningActivity?.kind === "coloring"
      ? `${learningActivity.props.title} coloring page with ${learningActivity.props.strokes.length} saved drawing strokes and pen, eraser, Undo, and Clear controls.`
      : undefined;
  return {
    id: element.id,
    kind: element.kind,
    label: element.label,
    frame: element.frame,
    ...(element.kind === "text" ? {
      plainText: element.content.blocks.map((block) => block.runs.map((run) => run.text).join("")).join("\n"),
      blockIds: element.content.blocks.map((block) => block.id),
    } : {}),
    ...(element.kind === "vector-ink" ? { description: element.description } : {}),
    ...(anatomyDescription === undefined ? {} : { description: anatomyDescription }),
    ...(learningDescription === undefined ? {} : { description: learningDescription }),
    ...(relationship === undefined ? {} : { relationship }),
  };
}

function contextFor(
  document: PageDocument,
  pageId: PageId,
  receipt: PageReceipt | null,
  view?: PageViewContext,
): PageContext {
  const index = document.pageOrder.indexOf(pageId);
  const page = document.pages[index] ?? document.pages[0];
  if (page === undefined) throw new Error("The workbook has no readable page.");
  const visiblePageIds = (view?.visiblePageIds ?? [page.id]).filter((id) => document.pageOrder.includes(id));
  const normalizedVisiblePageIds = visiblePageIds.length === 0 ? [page.id] : visiblePageIds;
  const visiblePages = normalizedVisiblePageIds.flatMap((id) => {
    const visiblePage = document.pages.find((candidate) => candidate.id === id);
    return visiblePage === undefined ? [] : [{
      pageId: visiblePage.id,
      pageNumber: visiblePage.number,
      pageRevision: visiblePage.revision,
      plainText: derivePagePlainText(visiblePage),
      elements: visiblePage.elements.map(elementContext),
    }];
  });
  return {
    workbookId: document.workbookId,
    documentRevision: document.documentRevision,
    pageCount: document.pages.length,
    focusedPageId: page.id,
    focusedPageNumber: page.number,
    previousPageId: document.pageOrder[index - 1] ?? null,
    nextPageId: document.pageOrder[index + 1] ?? null,
    pageRevision: page.revision,
    paper: page.paper ?? "lined",
    pageSize: page.size,
    plainText: derivePagePlainText(page),
    elements: page.elements.map(elementContext),
    presentation: view?.presentation ?? "single",
    visiblePageIds: normalizedVisiblePageIds,
    visiblePages,
    recentReceiptId: receipt?.id ?? null,
  };
}

function annotationFrame(
  page: PageRecord,
  target: ResolvedAnnotationTarget,
  annotation: AnnotationElement["annotation"],
  sourceElementId?: ElementId,
): PageRect {
  const snapshot = layoutPage(page);
  const range = target.frame;
  const contentRight = snapshot.metrics.contentRect.x + snapshot.metrics.contentRect.width;
  const contentBottom = snapshot.metrics.contentRect.y + snapshot.metrics.contentRect.height;
  const clamp = (frame: PageRect): PageRect => ({
    x: Math.max(0, Math.min(frame.x, snapshot.pageSize.width - frame.width)),
    y: Math.max(0, Math.min(frame.y, snapshot.pageSize.height - frame.height)),
    width: frame.width,
    height: frame.height,
  });

  if (annotation === "circle") {
    return clamp({ x: range.x - 8, y: range.y - 8, width: range.width + 16, height: range.height + 16 });
  }
  if (annotation === "arrow") {
    if (sourceElementId !== undefined) {
      const source = page.elements.find((element) => element.id === sourceElementId);
      if (source === undefined) throw new Error("The arrow source page object was not found.");
      const left = Math.min(source.frame.x, range.x);
      const top = Math.min(source.frame.y, range.y);
      const right = Math.max(source.frame.x + source.frame.width, range.x + range.width);
      const bottom = Math.max(source.frame.y + source.frame.height, range.y + range.height);
      return clamp({ x: left, y: top, width: right - left, height: bottom - top });
    }
    return clamp({ x: range.x, y: range.y + range.height + 4, width: range.width, height: 8 });
  }
  if (annotation === "label") {
    const width = 160;
    const height = 52;
    const candidates: PageRect[] = [
      { x: target.containerFrame.x + target.containerFrame.width + 12, y: target.containerFrame.y, width, height },
      { x: target.containerFrame.x, y: target.containerFrame.y + target.containerFrame.height + 12, width, height },
      { x: target.containerFrame.x - width - 12, y: target.containerFrame.y, width, height },
      { x: target.containerFrame.x, y: target.containerFrame.y - height - 12, width, height },
    ];
    const readableFrames = page.elements
      .filter((element): element is TextElement => element.kind === "text")
      .map((element) => element.frame);
    const fits = (frame: PageRect): boolean => frame.x >= snapshot.metrics.contentRect.x &&
      frame.y >= snapshot.metrics.contentRect.y &&
      frame.x + frame.width <= contentRight &&
      frame.y + frame.height <= contentBottom &&
      readableFrames.every((readable) => frame.x + frame.width <= readable.x ||
        frame.x >= readable.x + readable.width ||
        frame.y + frame.height <= readable.y ||
        frame.y >= readable.y + readable.height);
    const placement = candidates.find(fits);
    if (placement === undefined) throw new Error("No readable label position is available on this page.");
    return placement;
  }
  return clamp(range);
}

function reconcileAnnotationFrames(page: PageRecord): PageRecord {
  const elements = page.elements.map((element): PageElement => {
    if (element.kind !== "annotation" || element.reviewKind !== undefined || element.annotation === "label") {
      return element;
    }
    return {
      ...element,
      frame: annotationFrame(page, targetFromAnchor(page, element.anchor), element.annotation, element.sourceElementId),
    };
  });
  return validatePage({ ...page, elements });
}

function updateElementAndAnchors(page: PageRecord, elementId: ElementId, frame: PageRect): PageRecord {
  const target = page.elements.find((element) => element.id === elementId);
  if (target === undefined) throw new Error(`Element ${elementId} was not found.`);
  if (target.kind === "annotation" && target.reviewKind !== undefined && target.text !== undefined &&
    (frame.width < REVIEW_CALLOUT_MIN_WIDTH || frame.height < reviewCalloutHeight(target.text, frame.width))) {
    throw new PagePlacementError("The review callout is too small for its visible text.");
  }
  return updateElementFrame(page, elementId, frame, now());
}

function framesEqual(left: PageRect, right: PageRect): boolean {
  return left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function anatomyPropsJson(props: AnatomySkeletonProps | AnatomyColoringProps): JsonValue {
  const identity = {
    kind: props.kind,
    assetId: props.assetId,
    catalogVersion: props.catalogVersion,
    atlasVersion: props.atlasVersion,
    logicalBoneCount: props.logicalBoneCount,
    semanticMeshCount: props.semanticMeshCount,
  };
  if (props.kind === "anatomy-skeleton") {
    return props.latestSubmission === undefined
      ? identity
      : { ...identity, latestSubmission: props.latestSubmission };
  }
  const coloring = {
    ...identity,
    section: props.section,
    paletteVersion: props.paletteVersion,
    baseFills: props.baseFills.map(([boneId, colorId]) => [boneId, colorId]),
    surfaceStrokes: props.surfaceStrokes.map((stroke) => ({
      id: stroke.id,
      boneId: stroke.boneId,
      brush: stroke.brush.kind === "paint"
        ? {
            kind: stroke.brush.kind,
            colorId: stroke.brush.colorId,
            radiusBps: stroke.brush.radiusBps,
            hardnessBps: stroke.brush.hardnessBps,
          }
        : {
            kind: stroke.brush.kind,
            radiusBps: stroke.brush.radiusBps,
            hardnessBps: stroke.brush.hardnessBps,
          },
      anchors: stroke.anchors.map((anchor) => ({
        sourceObject: anchor.sourceObject,
        faceIndex: anchor.faceIndex,
        barycentric: [anchor.barycentric[0], anchor.barycentric[1]],
        pressure: anchor.pressure,
      })),
    })),
  };
  return props.latestSubmission === undefined
    ? coloring
    : { ...coloring, latestSubmission: props.latestSubmission };
}

function updateAnatomyElement(
  page: PageRecord,
  elementId: ElementId,
  props: AnatomySkeletonProps | AnatomyColoringProps,
): PageRecord {
  const target = page.elements.find((element) => element.id === elementId);
  const component = target?.kind === "embedded-frame" ? parseAnatomyComponent(target) : null;
  const matchingKind = component?.kind === "skeleton"
    ? props.kind === "anatomy-skeleton"
    : component?.kind === "coloring" && props.kind === "anatomy-coloring-lab";
  if (target?.kind !== "embedded-frame" || component === null || !matchingKind) {
    throw new PagePlacementError("The anatomy activity was not found on this page.");
  }
  const nextElement: EmbeddedFrameElement = {
    ...target,
    componentVersion: props.kind === "anatomy-coloring-lab"
      ? ANATOMY_COLORING_COMPONENT_VERSION
      : target.componentVersion,
    props: anatomyPropsJson(props),
  };
  return validatePage({
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: page.elements.map((element) => element.id === elementId ? nextElement : element),
    updatedAt: now(),
  });
}

function assertElementCanBeArranged(element: PageElement): void {
  if (element.kind === "embedded-frame") {
    throw new PagePlacementError("Embedded frames need a reviewed component registry before they can be arranged.");
  }
  if (element.kind === "annotation" && element.annotation !== "label") {
    throw new PagePlacementError("This anchored ink mark moves with its exact source element.");
  }
}

export class PageCommandRegistry {
  private document: PageDocument;
  private currentPageId: PageId;
  private viewContext: PageViewContext;
  private recentReceipt: PageReceipt | null = null;
  private snapshot: PageContext;
  private readonly listeners = new Set<() => void>();
  private readonly definitions: ReadonlyMap<PageCommandName, CommandDefinition>;
  private replacementReview: PageVectorInkReplacementReviewState = { kind: "closed" };
  private lastAppliedReplacement: Readonly<{
    proposalId: string;
    mutationId: string;
    output: PageCommandSuccess["output"];
  }> | null = null;
  private lastAppliedArrangement: Readonly<{
    mutationId: string;
    input: string;
    output: PageCommandSuccess["output"];
  }> | null = null;

  private constructor(
    private readonly storage: PageStorage,
    document: PageDocument,
  ) {
    this.document = document;
    this.currentPageId = document.pageOrder[0]!;
    this.viewContext = { presentation: "single", visiblePageIds: [this.currentPageId] };
    this.snapshot = contextFor(document, this.currentPageId, null, this.viewContext);
    this.definitions = new Map(this.createDefinitions().map((definition) => [definition.name, definition]));
  }

  public static async open(storage: PageStorage, workbookId: WorkbookId): Promise<PageCommandRegistry> {
    return new PageCommandRegistry(storage, await storage.ensureWorkbook(workbookId));
  }

  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  public getSnapshot = (): PageContext => this.snapshot;

  public getDocument = (): PageDocument => this.document;

  public getVectorInkReplacementReviewSnapshot = (): PageVectorInkReplacementReviewState => this.replacementReview;

  public discardVectorInkReplacementProposal(proposalId: string): boolean {
    if (this.replacementReview.kind === "closed" || this.replacementReview.kind === "applying" ||
      this.replacementReview.proposal.proposalId !== proposalId) return false;
    this.replacementReview = { kind: "closed" };
    this.publish();
    return true;
  }

  public setViewContext(view: PageViewContext): void {
    const visiblePageIds = view.visiblePageIds.filter((pageId) => this.document.pageOrder.includes(pageId));
    const next: PageViewContext = {
      presentation: view.presentation,
      visiblePageIds: visiblePageIds.length === 0 ? [this.currentPageId] : visiblePageIds,
    };
    if (next.presentation === this.viewContext.presentation &&
      next.visiblePageIds.length === this.viewContext.visiblePageIds.length &&
      next.visiblePageIds.every((pageId, index) => pageId === this.viewContext.visiblePageIds[index])) return;
    this.viewContext = next;
    this.snapshot = contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext);
    this.publish();
  }

  public focusPage(pageId: PageId): void {
    if (this.document.pageOrder.includes(pageId)) {
      this.currentPageId = pageId;
      this.viewContext = {
        ...this.viewContext,
        visiblePageIds: resolveVisiblePageIds(this.document, pageId, this.viewContext.presentation),
      };
      this.snapshot = contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext);
      this.publish();
    }
  }

  public describe(source?: PageCommandSource): PageCommandDescriptor[] {
    return [...this.definitions.values()]
      .filter((definition) => source === undefined || (definition.exposure?.[source] ?? true))
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        readOnly: definition.readOnly,
        untrustedContent: true,
        exposure: {
          manual: definition.exposure?.manual ?? true,
          webmcp: definition.exposure?.webmcp ?? true,
        },
        inputSchema: z.toJSONSchema(definition.schema, { target: "draft-07", unrepresentable: "any" }),
        outputSchema: { type: "object" },
      }));
  }

  public executeManual(name: PageCommandName, input: unknown): Promise<PageCommandResult> {
    return this.execute(name, input, "manual");
  }

  public executeExternal(name: string, input: unknown, source: Exclude<PageCommandSource, "manual">): Promise<PageCommandResult> {
    const known = [...this.definitions.keys()].find((candidate) => candidate === name);
    const definition = known === undefined ? undefined : this.definitions.get(known);
    if (known === undefined || definition === undefined || !(definition.exposure?.[source] ?? true)) {
      return Promise.resolve({ outcome: "error", command: name, error: { code: "UNKNOWN_COMMAND", message: `Unknown command ${name}.` } });
    }
    return this.execute(known, input, source);
  }

  public async refresh(): Promise<void> {
    this.document = await this.storage.read(this.document.workbookId);
    if (!this.document.pageOrder.includes(this.currentPageId)) this.currentPageId = this.document.pageOrder[0]!;
    this.viewContext = {
      ...this.viewContext,
      visiblePageIds: resolveVisiblePageIds(this.document, this.currentPageId, this.viewContext.presentation),
    };
    this.snapshot = contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext);
    this.publish();
  }

  private async execute(name: PageCommandName, input: unknown, source: PageCommandSource): Promise<PageCommandResult> {
    const definition = this.definitions.get(name);
    if (definition === undefined) return { outcome: "error", command: name, error: { code: "UNKNOWN_COMMAND", message: `Unknown command ${name}.` } };
    if (name !== "page_vector_ink_replace_apply") this.lastAppliedReplacement = null;
    if (name !== "page_element_frame_set") this.lastAppliedArrangement = null;
    const parsed = definition.schema.safeParse(input);
    if (!parsed.success) return { outcome: "error", command: name, error: { code: "INPUT_VALIDATION_ERROR", message: parsed.error.issues.map((issue) => issue.message).join(" ") } };
    try {
      if (source !== "manual" && !definition.readOnly && typeof parsed.data === "object" && parsed.data !== null && "pageId" in parsed.data && typeof parsed.data.pageId === "string") {
        await this.refresh();
        assertPageVisible(createPageId(parsed.data.pageId), this.viewContext.visiblePageIds);
      }
      return { outcome: "success", command: name, output: await definition.run(parsed.data as never, source) };
    } catch (error: unknown) {
      return { outcome: "error", command: name, error: commandError(error) };
    }
  }

  private createDefinitions(): CommandDefinition[] {
    const pageContext = {
      name: "page_context_read" as const,
      description: "Read the visible notebook page, semantic elements, plain-text context, stable ids, and revisions.",
      readOnly: true,
      schema: z.object({ pageId: PageIdSchema.optional() }).strict(),
      run: async (input: { pageId?: string }) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        return { context: contextFor(this.document, page.id, this.recentReceipt, this.viewContext) };
      },
    };
    const compositionPropose = {
      name: "page_composition_propose" as const,
      description: "Propose one bounded, versioned notebook composition without changing the notebook.",
      readOnly: true,
      schema: z.object({ template: z.literal(ANATOMY_EXAM_PREP_TEMPLATE) }).strict(),
      run: async () => {
        await this.refresh();
        return { proposal: createAnatomyCompositionProposal(this.document), context: this.getSnapshot() };
      },
    };
    const compositionApply = {
      name: "page_composition_apply" as const,
      description: "Atomically apply one fresh, bounded notebook composition with one receipt and exact Undo.",
      readOnly: false,
      schema: MutationSchema.extend({
        template: z.literal(ANATOMY_EXAM_PREP_TEMPLATE),
        proposalId: z.string().trim().min(1).max(500),
        expectedDocumentRevision: z.number().int().positive(),
      }).strict(),
      run: async (input: z.infer<typeof MutationSchema> & {
        template: typeof ANATOMY_EXAM_PREP_TEMPLATE;
        proposalId: string;
        expectedDocumentRevision: number;
      }, source: PageCommandSource) => {
        await this.refresh();
        const firstPage = this.document.pages[0];
        if (firstPage === undefined) throw new Error("The notebook has no first page.");
        const applied = applyAnatomyComposition({
          document: this.document,
          proposalId: input.proposalId,
          expectedDocumentRevision: input.expectedDocumentRevision,
          at: now(),
        });
        const expectedPageRevisions: Record<string, ReturnType<typeof createPageRevision>> = {};
        for (const pageId of applied.changedPageIds) {
          const existing = this.document.pages.find((page) => page.id === pageId);
          if (existing !== undefined) expectedPageRevisions[pageId] = existing.revision;
        }
        const committed = await this.storage.commit({
          workbookId: this.document.workbookId,
          nextDocument: applied.document,
          pageIds: applied.changedPageIds,
          expectedDocumentRevision: this.document.documentRevision,
          expectedPageRevisions,
          mutationId: createMutationId(input.mutationId),
          actorId: actorFor(source, input.actorId),
          source: sourceForStorage(source),
          kind: "page_composition_apply",
          ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
        });
        return this.acceptCommit(committed, applied.focusPageId);
      },
    };
    const compositionVerify = {
      name: "page_composition_verify" as const,
      description: "Verify page 1 study and test plus six section-owned 3D coloring labs, their component registry, source-mesh contract, and attribution.",
      readOnly: true,
      schema: z.object({ template: z.literal(ANATOMY_EXAM_PREP_TEMPLATE) }).strict(),
      run: async () => {
        await this.refresh();
        return { verification: verifyAnatomyComposition(this.document), context: this.getSnapshot() };
      },
    };
    const anatomyColoringRead = {
      name: "page_anatomy_coloring_read" as const,
      description: "Read bounded base-fill and local surface-paint completion for the visible 3D coloring lab. Answer labels remain hidden until a score is submitted.",
      readOnly: true,
      schema: z.object({ pageId: PageIdSchema.optional() }).strict(),
      run: async (input: { pageId?: string }) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertPageVisible(page.id, this.viewContext.visiblePageIds);
        const component = page.elements.flatMap((element) => {
          if (element.kind !== "embedded-frame") return [];
          const parsed = parseAnatomyComponent(element);
          return parsed?.kind === "coloring" ? [{ element, props: parsed.props }] : [];
        })[0];
        if (component === undefined) throw new Error("The selected page does not contain a 3D anatomy coloring lab.");
        const completion = coloringCompletion({
          section: component.props.section,
          baseFills: component.props.baseFills,
          surfaceStrokes: component.props.surfaceStrokes,
        });
        const baseFillByBone = new Map(component.props.baseFills);
        const surfaceStrokeCountByBone = new Map<string, number>();
        for (const stroke of component.props.surfaceStrokes) {
          surfaceStrokeCountByBone.set(stroke.boneId, (surfaceStrokeCountByBone.get(stroke.boneId) ?? 0) + 1);
        }
        const answersReleased = component.props.latestSubmission !== undefined;
        const bones = bonesForSection(component.props.section).map((bone, index) => ({
          questionNumber: index + 1,
          hasBaseFill: baseFillByBone.has(bone.id),
          surfaceStrokeCount: surfaceStrokeCountByBone.get(bone.id) ?? 0,
          ...(answersReleased ? {
            id: bone.id,
            label: bone.name,
            baseColorId: baseFillByBone.get(bone.id) ?? null,
          } : {}),
        }));
        return {
          pageId: page.id,
          pageRevision: page.revision,
          elementId: component.element.id,
          section: component.props.section,
          colored: completion.completedBoneCount,
          total: bonesForSection(component.props.section).length,
          answersReleased,
          baseFilledBoneCount: completion.baseFilledBoneCount,
          surfacePaintedBoneCount: completion.surfacePaintedBoneCount,
          completedBoneCount: completion.completedBoneCount,
          surfaceStrokeCount: completion.surfaceStrokeCount,
          surfaceAnchorCount: completion.surfaceAnchorCount,
          surfaceSampleCount: completion.surfaceAnchorCount,
          surfaceStateFingerprint: surfacePaintStateFingerprint({
            section: component.props.section,
            surfaceStrokes: component.props.surfaceStrokes,
          }),
          palette: COLORING_PALETTE.map((color) => ({ id: color.id, label: color.label, hex: color.hex })),
          bones,
          ...(answersReleased ? {
            baseFills: component.props.baseFills,
            surfaceStrokes: component.props.surfaceStrokes,
          } : {}),
        };
      },
    };
    const anatomyPaintApply = {
      name: "page_anatomy_paint_apply" as const,
      description: "Append one exact local surface stroke, clear one bone, or clear the visible anatomy section. Surface strokes persist the mutation id for exact replay and Undo.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        elementId: z.string().trim().min(1).max(500),
        edit: AnatomyPaintEditSchema,
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        elementId: string;
        edit: AnatomyPaintEdit;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertPageVisible(page.id, this.viewContext.visiblePageIds);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target?.kind !== "embedded-frame") throw new Error("The anatomy coloring lab was not found.");
        const component = parseAnatomyComponent(target);
        if (component?.kind !== "coloring") throw new Error("Only a 3D coloring lab can accept a paint stroke.");
        const next = applyAnatomyPaintEdit({
          section: component.props.section,
          baseFills: component.props.baseFills,
          surfaceStrokes: component.props.surfaceStrokes,
          edit: input.edit,
          mutationId: input.mutationId,
        });
        const props = AnatomyColoringPropsSchema.parse({ ...component.props, ...next });
        return this.commitPage(page, updateAnatomyElement(page, elementId, props), input, source, "page_anatomy_paint_apply");
      },
    };
    const anatomyQuizSubmit = {
      name: "page_anatomy_quiz_submit" as const,
      description: "Score and persist one human anatomy quiz submission from the authoritative adult-bone catalogue.",
      readOnly: false,
      exposure: { manual: true, webmcp: false },
      schema: PageMutationSchema.extend({
        elementId: z.string().trim().min(1).max(500),
        section: AnatomySectionSchema,
        answers: z.record(z.string().trim().min(1).max(200), z.string().max(160)),
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        elementId: string;
        section: AnatomySection;
        answers: Record<string, string>;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target?.kind !== "embedded-frame") throw new Error("The anatomy study activity was not found.");
        const component = parseAnatomyComponent(target);
        if (component === null) throw new Error("The anatomy study activity is invalid.");
        if (component.kind === "coloring" && component.props.section !== input.section) {
          throw new Error("The label test section does not match this coloring lab.");
        }
        const bones = bonesForSection(input.section);
        const allowedIds = new Set(bones.map((bone) => bone.id));
        if (Object.keys(input.answers).some((boneId) => !allowedIds.has(boneId))) {
          throw new Error("The quiz submission contains a bone outside the selected section.");
        }
        const result = scoreBoneAnswers(input.answers, bones);
        const nextProps = {
          ...component.props,
          latestSubmission: {
            attemptId: input.mutationId,
            section: input.section,
            ...result,
            submittedAt: now(),
          },
        };
        const props = component.kind === "skeleton"
          ? AnatomySkeletonPropsSchema.parse(nextProps)
          : AnatomyColoringPropsSchema.parse(nextProps);
        return this.commitPage(page, updateAnatomyElement(page, elementId, props), input, source, "page_anatomy_quiz_submit");
      },
    };
    const calculusPracticeSubmit = {
      name: "page_calc_practice_submit" as const,
      description: "Score and save one bounded Calculus I practice attempt, including per-question feedback.",
      readOnly: false,
      exposure: { manual: true, webmcp: false },
      schema: PageMutationSchema.extend({
        elementId: z.string().trim().min(1).max(500),
        answers: z.record(z.string().trim().min(1).max(80), z.string().max(1_000)),
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        elementId: string;
        answers: Record<string, string>;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target?.kind !== "embedded-frame") throw new Error("The calculus practice set was not found.");
        const activity = parseLearningActivity(target);
        if (activity?.kind !== "calculus") throw new Error("Only a calculus practice set can score these answers.");
        const latestSubmission = scoreCalculusPractice(activity.props, input.answers, input.mutationId, now());
        const props = CalculusPracticePropsSchema.parse({ ...activity.props, latestSubmission });
        return this.commitPage(page, updateLearningActivity(page, elementId, props, now()), input, source, "page_calc_practice_submit");
      },
    };
    const coloringEdit = {
      name: "page_coloring_edit" as const,
      description: "Append, undo, or clear a bounded stroke on one coloring-book page. Each completed stroke is one reversible edit.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        elementId: z.string().trim().min(1).max(500),
        edit: ColoringEditSchema,
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        elementId: string;
        edit: ColoringEdit;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target?.kind !== "embedded-frame") throw new Error("The coloring page was not found.");
        const activity = parseLearningActivity(target);
        if (activity?.kind !== "coloring") throw new Error("Only a coloring-book page can accept drawing strokes.");
        const props = applyColoringEdit(activity.props, input.edit);
        return this.commitPage(page, updateLearningActivity(page, elementId, props, now()), input, source, "page_coloring_edit");
      },
    };
    const targetResolve = {
      name: "page_target_resolve" as const,
      description: "Resolve a stable page, element, phrase, or text range without changing page focus.",
      readOnly: true,
      schema: z.object({ target: TargetResolveSchema }).strict(),
      run: async (input: { target: z.infer<typeof TargetResolveSchema> }) => {
        await this.refresh();
        const context = contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext);
        return { context, resolution: resolvePageCommandTarget(this.document, this.currentPageId, input.target) };
      },
    };
    const textInsert = {
      name: "page_text_insert" as const,
      description: "Insert structured formatted text on one finite page.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        text: z.string().min(1).max(20_000),
        label: z.string().trim().min(1).max(120).optional(),
        blockKind: z.enum(["paragraph", "heading", "quote"]).optional(),
        marks: MarksSchema.optional(),
        frame: FrameSchema.optional(),
      }),
      run: async (input: z.infer<typeof PageMutationSchema> & { text: string; label?: string; blockKind?: "paragraph" | "heading" | "quote"; marks?: RichTextMark[]; frame?: PageRect }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const id = stableElementId("mutation", input.mutationId);
        const existingText = page.elements.filter((element): element is TextElement => element.kind === "text");
        const y = Math.max(PAGE_CONTENT_RECT.y + 28, ...existingText.map((element) => element.frame.y + element.frame.height + 20));
        const initialContent = richTextFromPlainText(input.text, stableBlockId(input.mutationId), input.blockKind ?? "paragraph");
        const content = input.blockKind === "heading" ? {
          ...initialContent,
          blocks: [
            ...initialContent.blocks,
            { id: stableBlockId(`${input.mutationId}:body`), kind: "paragraph" as const, runs: [{ text: "", marks: [] }] },
          ],
        } : initialContent;
        const marked = input.marks === undefined || input.marks.length === 0 ? content : {
          ...content,
          blocks: content.blocks.map((block) => ({ ...block, runs: block.runs.map((run) => ({ ...run, marks: input.marks! })) })),
        };
        const element: TextElement = {
          kind: "text",
          id,
          label: input.label ?? input.text.slice(0, 48),
          frame: input.frame ?? { x: 96, y, width: 520, height: input.blockKind === "heading" ? 96 : 150 },
          content: marked,
        };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_text_insert");
      },
    };
    const structuredTextSet = {
      name: "page_structured_text_set" as const,
      description: "Replace one existing text element with a complete bounded structured block set through the canonical page command path.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        elementId: z.string().trim().min(1).max(500),
        blocks: StructuredTextBlocksSchema,
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        elementId: string;
        blocks: z.infer<typeof StructuredTextBlocksSchema>;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertPageVisible(page.id, this.viewContext.visiblePageIds);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const blocks: readonly StructuredTextBlock[] = input.blocks.map((block) => ({
          id: createTextBlockId(block.id),
          kind: block.kind,
          runs: block.runs.map((run) => ({ text: run.text, marks: [...run.marks] })),
        }));
        const nextPage = setStructuredText(page, elementId, blocks, now());
        assertStructuredTextFits(nextPage, elementId);
        return this.commitPage(page, nextPage, input, source, "page_structured_text_set");
      },
    };
    const textFormat = {
      name: "page_text_format" as const,
      description: "Format a uniquely resolved phrase, text range, or text element.",
      readOnly: false,
      schema: PageMutationSchema.extend({ target: ElementTargetSchema, start: z.number().int().nonnegative().optional(), end: z.number().int().positive().optional(), marks: MarksSchema.min(1) }),
      run: async (input: z.infer<typeof PageMutationSchema> & { target: z.infer<typeof ElementTargetSchema>; start?: number; end?: number; marks: RichTextMark[] }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const target = resolveTextTarget(page, input.target);
        const start = input.start ?? target.start;
        const end = input.end ?? target.end;
        return this.commitPage(page, formatTextRange(page, target.element.id, target.blockId, start, end, input.marks, now()), input, source, "page_text_format");
      },
    };
    const shapeAdd = {
      name: "page_shape_add" as const,
      description: "Place a basic rectangle, ellipse, or arrow without obscuring readable text.",
      readOnly: false,
      schema: PageMutationSchema.extend({ elementId: z.string().min(1).optional(), shape: z.enum(["rectangle", "ellipse", "arrow"]), label: z.string().min(1).max(120).optional(), frame: FrameSchema.optional(), fill: z.string().nullable().optional(), stroke: z.string().optional() }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId?: string; shape: ShapeElement["shape"]; label?: string; frame?: PageRect; fill?: string | null; stroke?: string }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const element: ShapeElement = { kind: "shape", id: input.elementId === undefined ? stableElementId("mutation", input.mutationId) : createElementId(input.elementId), label: input.label ?? input.shape, frame: shapeFrame(page, input.frame), shape: input.shape, fill: input.fill ?? null, stroke: input.stroke ?? "green" };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_shape_add");
      },
    };
    const vectorInkAdd = {
      name: "page_vector_ink_add" as const,
      description: "Add one bounded, editable vector figure without obscuring readable page content.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        frame: FrameSchema.optional(),
        document: VectorInkDocumentInputSchema,
        label: z.string().trim().min(1).max(120),
        description: z.string().trim().min(1).max(500),
        provenance: VectorInkProvenanceInputSchema.optional(),
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        frame?: PageRect;
        document: VectorInkDocument;
        label: string;
        description: string;
        provenance?: VectorInkProvenance;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const element: PageVectorInkElement = {
          kind: "vector-ink",
          version: 1,
          id: stableElementId("vector-ink", input.mutationId),
          label: input.label,
          description: input.description,
          frame: vectorInkFrame(page, input.document, input.frame),
          document: input.document,
          ...(input.provenance === undefined ? {} : { provenance: input.provenance }),
        };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_vector_ink_add");
      },
    };
    const vectorInkReplacePropose = {
      name: "page_vector_ink_replace_propose" as const,
      description: "Stage one exact typed vector document replacement for app-owned human review without changing the page.",
      readOnly: false,
      exposure: { manual: false, webmcp: true },
      schema: z.object({
        pageId: PageIdSchema.optional(),
        targetElementId: z.string().trim().min(1),
        expectedRevision: z.number().int().positive(),
        document: VectorInkDocumentInputSchema,
        provenance: VectorInkProvenanceInputSchema,
      }).strict(),
      run: async (input: {
        pageId?: string;
        targetElementId: string;
        expectedRevision: number;
        document: VectorInkDocument;
        provenance: VectorInkProvenance;
      }) => {
        if (this.replacementReview.kind !== "closed") {
          throw new ReplacementReviewError("REPLACEMENT_REVIEW_IN_PROGRESS", "Finish or cancel the current vector replacement review first.");
        }
        const freshDocument = await this.storage.read(this.document.workbookId);
        if (JSON.stringify(freshDocument) !== JSON.stringify(this.document)) {
          throw new VectorInkReplacementError("STALE_REPLACEMENT", "The visible page changed before replacement review. Refresh it and propose again.");
        }
        const proposal = await createVectorInkReplacementProposal({
          document: freshDocument,
          proposalId: `phase9:proposal:${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`,
          elementId: input.targetElementId,
          ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
          expectedPageRevision: input.expectedRevision,
          newDocument: input.document,
          newProvenance: input.provenance,
        });
        const target = resolveVectorInkReplacementTarget({
          document: freshDocument,
          pageId: proposal.pageId,
          elementId: proposal.elementId,
        });
        this.lastAppliedReplacement = null;
        this.replacementReview = {
          kind: "reviewing",
          proposal,
          target: {
            pageId: target.page.id,
            pageNumber: target.page.number,
            elementId: target.element.id,
            label: target.element.label,
            description: target.element.description,
            frame: target.element.frame,
            priorDocument: target.element.document,
          },
        };
        this.publish();
        return {
          context: contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext),
          replacementProposal: {
            proposalId: proposal.proposalId,
            pageId: target.page.id,
            elementId: target.element.id,
          },
        };
      },
    };
    const vectorInkReplaceApply = {
      name: "page_vector_ink_replace_apply" as const,
      description: "Apply the exact typed vector replacement currently shown in the app-owned review.",
      readOnly: false,
      exposure: { manual: true, webmcp: false },
      schema: MutationSchema.extend({ proposalId: z.string().trim().min(1) }).strict(),
      run: async (input: z.infer<typeof MutationSchema> & { proposalId: string }, source: PageCommandSource) => {
        if (this.lastAppliedReplacement?.proposalId === input.proposalId &&
          this.lastAppliedReplacement.mutationId === input.mutationId) return this.lastAppliedReplacement.output;
        if (this.replacementReview.kind === "closed" || this.replacementReview.proposal.proposalId !== input.proposalId) {
          throw new ReplacementReviewError("REPLACEMENT_REVIEW_NOT_FOUND", "That vector replacement proposal is no longer available for review.");
        }
        if (this.replacementReview.kind === "applying") {
          throw new ReplacementReviewError("REPLACEMENT_REVIEW_IN_PROGRESS", "The vector replacement is already being applied.");
        }
        const proposal = this.replacementReview.proposal;
        const target = this.replacementReview.target;
        this.replacementReview = { kind: "applying", proposal, target };
        this.publish();
        try {
          const freshDocument = await this.storage.read(this.document.workbookId);
          const current = await assertVectorInkReplacementProposalCurrent({ document: freshDocument, proposal });
          const nextPage = validatePage(applyVectorInkReplacement({
            current,
            nextRevision: createPageRevision(current.page.revision + 1),
            updatedAt: now(),
          }));
          const nextDocument = validatePageDocument({
            ...freshDocument,
            pages: freshDocument.pages.map((page) => page.id === nextPage.id ? nextPage : page),
          });
          const committed = await this.storage.commit({
            workbookId: freshDocument.workbookId,
            nextDocument,
            pageIds: [nextPage.id],
            expectedDocumentRevision: freshDocument.documentRevision,
            expectedPageRevisions: { [nextPage.id]: current.page.revision },
            mutationId: createMutationId(input.mutationId),
            actorId: actorFor(source, input.actorId),
            source: sourceForStorage(source),
            kind: "page_vector_ink_replace_apply",
            ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
          });
          this.replacementReview = { kind: "closed" };
          const output = this.acceptCommit(committed, nextPage.id);
          this.lastAppliedReplacement = { proposalId: input.proposalId, mutationId: input.mutationId, output };
          return output;
        } catch (error: unknown) {
          this.replacementReview = {
            kind: "apply-error",
            proposal,
            target,
            message: error instanceof Error ? error.message : "The vector replacement could not be applied.",
          };
          this.publish();
          throw error;
        }
      },
    };
    const diagramAdd = {
      name: "page_diagram_add" as const,
      description: "Add one bounded app-owned semantic diagram using a built-in template.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        template: z.enum(DIAGRAM_TEMPLATE_INPUTS).optional(),
        document: DiagramDocumentInputSchema.optional(),
        label: z.string().trim().min(1).max(120).optional(),
        frame: FrameSchema.optional(),
      }).refine((input) => (input.template === undefined) !== (input.document === undefined), {
        message: "Provide one diagram template or one semantic diagram document.",
      }),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        template?: DiagramTemplate;
        document?: DiagramDocument;
        label?: string;
        frame?: PageRect;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const definition = input.template === undefined ? resolveDiagramTemplate("relationship-map") : resolveDiagramTemplate(input.template);
        const document = input.document === undefined ? definition.document : validateDiagramDocument(input.document);
        const elementId = stableElementId("diagram", input.mutationId);
        const frame = input.frame ?? {
          x: definition.frame.x * (page.size.width / PAGE_WIDTH),
          y: definition.frame.y * (page.size.height / PAGE_HEIGHT),
          width: definition.frame.width * (page.size.width / PAGE_WIDTH),
          height: definition.frame.height * (page.size.height / PAGE_HEIGHT),
        };
        assertSafeDiagramFrame(page, frame, elementId);
        const element: DiagramElement = {
          kind: "diagram",
          id: elementId,
          label: input.label ?? definition.label,
          frame,
          engine: "native",
          engineVersion: 1,
          document,
        };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_diagram_add");
      },
    };
    const diagramFrameSet = {
      name: "page_diagram_frame_set" as const,
      description: "Place or resize one bounded diagram section without obscuring page content.",
      readOnly: false,
      exposure: { manual: true, webmcp: false },
      schema: PageMutationSchema.extend({ elementId: z.string().trim().min(1), frame: FrameSchema }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId: string; frame: PageRect }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target?.kind !== "diagram") throw new PagePlacementError("Only a diagram section can be arranged here.");
        assertSafeDiagramFrame(page, input.frame, elementId);
        if (target.frame.x === input.frame.x && target.frame.y === input.frame.y && target.frame.width === input.frame.width && target.frame.height === input.frame.height) {
          throw new PagePlacementError("The diagram is already at that placement.");
        }
        return this.commitPage(page, updateElementAndAnchors(page, elementId, input.frame), input, source, "page_diagram_frame_set");
      },
    };
    const diagramNodesSet = {
      name: "page_diagram_nodes_set" as const,
      description: "Persist one or more direct node placements in an app-owned diagram.",
      readOnly: false,
      exposure: { manual: true, webmcp: false },
      schema: PageMutationSchema.extend({
        elementId: z.string().trim().min(1),
        positions: z.array(z.object({
          id: z.string().trim().min(1).max(64),
          x: z.number().finite().min(0).max(100),
          y: z.number().finite().min(0).max(100),
        }).strict()).min(1).max(12),
      }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId: string; positions: readonly { id: string; x: number; y: number }[] }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const next = updateDiagramNodePositions(
          page,
          elementId,
          input.positions.map((position) => ({ id: position.id, position: { x: position.x, y: position.y } })),
          now(),
        );
        return this.commitPage(page, next, input, source, "page_diagram_nodes_set");
      },
    };
    const strokeAdd = {
      name: "page_stroke_add" as const,
      description: "Add one completed freehand stroke as a single meaningful edit.",
      readOnly: false,
      schema: PageMutationSchema.extend({ elementId: z.string().min(1).optional(), points: z.array(z.object({ x: z.number().finite(), y: z.number().finite(), pressure: z.number().min(0).max(1).optional() }).strict()).min(2), color: z.string().optional(), width: z.number().positive().max(24).optional() }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId?: string; points: StrokeElement["points"]; color?: string; width?: number }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const xs = input.points.map((point) => point.x);
        const ys = input.points.map((point) => point.y);
        const element: StrokeElement = { kind: "stroke", id: input.elementId === undefined ? stableElementId("mutation", input.mutationId) : createElementId(input.elementId), label: "Freehand stroke", frame: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(1, Math.max(...xs) - Math.min(...xs)), height: Math.max(1, Math.max(...ys) - Math.min(...ys)) }, points: input.points, color: input.color ?? "black", width: input.width ?? 2 };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_stroke_add");
      },
    };
    const annotationAdd = {
      name: "page_annotation_add" as const,
      description: "Highlight, circle, point to, or label one uniquely resolved text range or element.",
      readOnly: false,
      schema: PageMutationSchema.extend({ target: ElementTargetSchema, annotation: z.enum(["highlight", "circle", "arrow", "label"]), sourceElementId: z.string().min(1).optional(), text: z.string().max(500).optional() }),
      run: async (input: z.infer<typeof PageMutationSchema> & { target: z.infer<typeof ElementTargetSchema>; annotation: AnnotationElement["annotation"]; sourceElementId?: string; text?: string }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const target = resolveAnnotationTarget(page, input.target);
        if (input.annotation === "arrow" && input.sourceElementId === undefined) {
          throw new Error("An arrow needs a named source page object.");
        }
        const sourceElementId = input.sourceElementId === undefined ? undefined : createElementId(input.sourceElementId);
        const frame = annotationFrame(page, target, input.annotation, sourceElementId);
        const element: AnnotationElement = input.annotation === "arrow"
          ? { kind: "annotation", id: stableElementId("mutation", input.mutationId), label: input.text ?? "arrow annotation", frame, annotation: "arrow", anchor: target.anchor, sourceElementId: sourceElementId! }
          : { kind: "annotation", id: stableElementId("mutation", input.mutationId), label: input.text ?? `${input.annotation} annotation`, frame, annotation: input.annotation, anchor: target.anchor, ...(input.text === undefined ? {} : { text: input.text }) };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_annotation_add");
      },
    };
    const reviewCalloutAdd = {
      name: "page_review_callout_add" as const,
      description: "Add one readable explanation or replacement callout to one exact text range, ink stroke, shape, or page object.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        target: ElementTargetSchema,
        reviewKind: z.enum(["explanation", "replacement"]),
        text: z.string().trim().min(1).max(180),
      }),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        target: z.infer<typeof ElementTargetSchema>;
        reviewKind: "explanation" | "replacement";
        text: string;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const target = resolveAnnotationTarget(page, input.target);
        const targetElement = page.elements.find((element) => element.id === target.anchor.elementId);
        if (targetElement?.kind === "annotation") {
          throw new PagePlacementError("A review callout must target source content, not another annotation.");
        }
        const frame = findReviewCalloutFrame(page, target.containerFrame, input.text);
        if (frame === null) {
          throw new PagePlacementError("No safe review callout position is available on this page.");
        }
        const element: AnnotationElement = {
          kind: "annotation",
          id: stableElementId("mutation", input.mutationId),
          label: input.reviewKind === "replacement" ? "Suggested replacement" : "Review note",
          frame,
          annotation: "label",
          anchor: target.anchor,
          reviewKind: input.reviewKind,
          text: input.text,
        };
        return this.commitPage(page, addElement(page, element, now()), input, source, "page_review_callout_add");
      },
    };
    const elementFrameSet = {
      name: "page_element_frame_set" as const,
      description: "Apply one reviewed move and resize to one exact app-owned page element.",
      readOnly: false,
      exposure: { manual: true, webmcp: false },
      schema: PageMutationSchema.extend({ elementId: z.string().trim().min(1), frame: FrameSchema }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId: string; frame: PageRect }, source: PageCommandSource) => {
        const serializedInput = JSON.stringify(input);
        if (this.lastAppliedArrangement?.mutationId === input.mutationId) {
          if (this.lastAppliedArrangement.input === serializedInput) return this.lastAppliedArrangement.output;
          throw new PageStorageError("mutation_reuse", "The mutation id was already used for a different placement.");
        }
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target === undefined) throw new PageTargetError("TARGET_NOT_FOUND", `Element ${elementId} was not found on the target page.`);
        assertElementCanBeArranged(target);
        if (framesEqual(target.frame, input.frame)) {
          throw new PagePlacementError("The element is already at that placement.");
        }
        if (target.kind === "diagram") assertSafeDiagramFrame(page, input.frame, elementId);
        if (target.kind === "vector-ink") assertSafeVectorFrame(page, input.frame, elementId);
        let nextPage: PageRecord;
        try {
          nextPage = updateElementAndAnchors(page, elementId, input.frame);
        } catch (error: unknown) {
          if (error instanceof PagePlacementError) throw error;
          throw new PagePlacementError(error instanceof Error ? error.message : "The element placement is unsafe.");
        }
        const output = await this.commitPage(page, nextPage, input, source, "page_element_frame_set");
        this.lastAppliedArrangement = { mutationId: input.mutationId, input: serializedInput, output };
        return output;
      },
    };
    const moveOrResize = (name: "page_element_move" | "page_element_resize") => ({
      name,
      description: name === "page_element_move" ? "Move an element while keeping anchored annotations attached." : "Resize an element within hard page and readability limits.",
      readOnly: false,
      schema: PageMutationSchema.extend({ elementId: z.string().min(1), frame: FrameSchema }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId: string; frame: PageRect }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const target = page.elements.find((element) => element.id === elementId);
        if (target === undefined) throw new PageTargetError("TARGET_NOT_FOUND", `Element ${elementId} was not found on the target page.`);
        if (framesEqual(target.frame, input.frame)) throw new PagePlacementError("The element is already at that placement.");
        if (target?.kind === "diagram") {
          throw new PagePlacementError("Use the diagram arrangement controls to move or resize a diagram section.");
        }
        if (target?.kind === "vector-ink") {
          try {
            assertSafeVectorFrame(page, input.frame, elementId);
          } catch (error: unknown) {
            if (error instanceof PagePlacementError) throw error;
            throw new PagePlacementError(error instanceof Error ? error.message : "The vector figure placement is unsafe.");
          }
        }
        let next: PageRecord;
        try {
          next = updateElementAndAnchors(page, elementId, input.frame);
        } catch (error: unknown) {
          if (target?.kind === "vector-ink" && !(error instanceof PagePlacementError)) {
            throw new PagePlacementError(error instanceof Error ? error.message : "The vector figure placement is unsafe.");
          }
          throw error;
        }
        return this.commitPage(page, next, input, source, name);
      },
    });
    const advance = {
      name: "page_advance" as const,
      description: "Advance to the next finite page, creating exactly one page when needed.",
      readOnly: false,
      schema: MutationSchema.extend({ expectedDocumentRevision: z.number().int().positive() }),
      run: async (input: z.infer<typeof MutationSchema> & { expectedDocumentRevision: number }, source: PageCommandSource) => {
        await this.refresh();
        if (this.document.documentRevision !== input.expectedDocumentRevision) throw new PageStorageError("revision_conflict", "The workbook revision is stale.");
        const index = this.document.pageOrder.indexOf(this.currentPageId);
        const existing = this.document.pageOrder[index + 1];
        if (existing !== undefined) {
          this.focusPage(existing);
          return { context: this.getSnapshot() };
        }
        const next = appendPage(this.document, now());
        const newPage = next.pages.at(-1)!;
        const committed = await this.storage.commit({ workbookId: this.document.workbookId, nextDocument: next, pageIds: [newPage.id], expectedDocumentRevision: createDocumentRevision(input.expectedDocumentRevision), expectedPageRevisions: {}, mutationId: createMutationId(input.mutationId), actorId: actorFor(source, input.actorId), source: sourceForStorage(source), kind: "page_advance" });
        return this.acceptCommit(committed, newPage.id);
      },
    };
    const textContinue = {
      name: "page_text_continue" as const,
      description: "Continue text onto the next finite page at a valid word boundary.",
      readOnly: false,
      schema: PageMutationSchema.extend({ elementId: z.string().min(1), blockId: z.string().min(1), splitAt: z.number().int().positive(), expectedDocumentRevision: z.number().int().positive() }),
      run: async (input: z.infer<typeof PageMutationSchema> & { elementId: string; blockId: string; splitAt: number; expectedDocumentRevision: number }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        if (this.document.documentRevision !== input.expectedDocumentRevision) throw new PageStorageError("revision_conflict", "The workbook revision is stale.");
        const result = continueText(this.document, page.id, createElementId(input.elementId), createTextBlockId(input.blockId), input.splitAt, now());
        const destinationBefore = this.document.pages.find((candidate) => candidate.number === page.number + 1);
        const expected = destinationBefore === undefined ? { [page.id]: page.revision } : { [page.id]: page.revision, [destinationBefore.id]: destinationBefore.revision };
        const committed = await this.storage.commit({ workbookId: this.document.workbookId, nextDocument: result.document, pageIds: [page.id, result.destinationPage.id], expectedDocumentRevision: createDocumentRevision(input.expectedDocumentRevision), expectedPageRevisions: expected, mutationId: createMutationId(input.mutationId), actorId: actorFor(source, input.actorId), source: sourceForStorage(source), kind: "page_text_continue", ...(input.claimId === undefined ? {} : { claimId: input.claimId }) });
        return this.acceptCommit(committed, result.destinationPage.id);
      },
    };
    const reworkApply = {
      name: "page_rework_apply" as const,
      description: "Apply one reviewed substantial structured-text reorganization only after atomically preserving the full prior workbook in Scrap.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        scrapId: z.string().trim().min(1).max(500),
        reason: z.string().trim().min(1).max(500),
        elementId: z.string().trim().min(1).max(500),
        blocks: StructuredTextBlocksSchema,
      }).strict(),
      run: async (input: z.infer<typeof PageMutationSchema> & {
        scrapId: string;
        reason: string;
        elementId: string;
        blocks: z.infer<typeof StructuredTextBlocksSchema>;
      }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertPageVisible(page.id, this.viewContext.visiblePageIds);
        assertRevision(page, input.expectedRevision);
        const elementId = createElementId(input.elementId);
        const nextPage = setStructuredText(page, elementId, input.blocks.map((block) => ({
          id: createTextBlockId(block.id),
          kind: block.kind,
          runs: block.runs.map((run) => ({ text: run.text, marks: [...run.marks] })),
        })), now());
        assertStructuredTextFits(nextPage, elementId);
        const nextDocument = validatePageDocument({
          ...this.document,
          pages: this.document.pages.map((candidate) => candidate.id === page.id ? nextPage : candidate),
        });
        const committed = await this.storage.applyRework({
          workbookId: this.document.workbookId,
          nextDocument,
          pageIds: [page.id],
          expectedDocumentRevision: this.document.documentRevision,
          expectedPageRevisions: { [page.id]: page.revision },
          mutationId: createMutationId(input.mutationId),
          actorId: actorFor(source, input.actorId),
          source: sourceForStorage(source),
          kind: "page_rework_apply",
          scrapId: createPageScrapId(input.scrapId),
          reason: input.reason,
          ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
        });
        return this.acceptCommit(committed, page.id);
      },
    };
    const scrapRestore = {
      name: "page_scrap_restore" as const,
      description: "Restore one durable Scrap only while the workbook still matches its exact post-rework guard.",
      readOnly: false,
      schema: MutationSchema.extend({ scrapId: z.string().trim().min(1).max(500) }).strict(),
      run: async (input: z.infer<typeof MutationSchema> & { scrapId: string }, source: PageCommandSource) => {
        const committed = await this.storage.restoreScrap({
          workbookId: this.document.workbookId,
          scrapId: createPageScrapId(input.scrapId),
          mutationId: createMutationId(input.mutationId),
          actorId: actorFor(source, input.actorId),
          source: sourceForStorage(source),
          visiblePageIds: this.viewContext.visiblePageIds,
          ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
        });
        return this.acceptCommit(committed, this.currentPageId);
      },
    };
    const writerClaim = {
      name: "page_writer_claim" as const,
      description: "Claim one page for a multi-step agent turn while other pages remain independently writable.",
      readOnly: false,
      schema: z.object({
        pageId: PageIdSchema.optional(),
        actorId: z.string().trim().min(1).optional(),
        claimId: z.string().trim().min(1),
        ttlMs: z.number().int().positive().max(300_000).optional(),
      }).strict(),
      run: async (input: { pageId?: string; actorId?: string; claimId: string; ttlMs?: number }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        await this.storage.claimPage({
          workbookId: this.document.workbookId,
          pageId: page.id,
          actorId: actorFor(source, input.actorId),
          claimId: input.claimId,
          ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
        });
        return { context: contextFor(this.document, page.id, this.recentReceipt, this.viewContext) };
      },
    };
    const presentationSet = {
      name: "page_presentation_set" as const,
      description: "Set the page paper style or supported base size and keep page geometry proportional.",
      readOnly: false,
      schema: PageMutationSchema.extend({
        paper: z.enum(["lined", "grid", "blank"]).optional(),
        sizePreset: z.enum(["letter", "a4"]).optional(),
      }).refine((input) => input.paper !== undefined || input.sizePreset !== undefined, {
        message: "Choose a paper style or page size.",
      }),
      run: async (input: z.infer<typeof PageMutationSchema> & { paper?: PagePaper; sizePreset?: PageSizePreset }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        assertRevision(page, input.expectedRevision);
        return this.commitPage(page, updatePagePresentation(page, input, now()), input, source, "page_presentation_set");
      },
    };
    const writerRelease = {
      name: "page_writer_release" as const,
      description: "Release a page writer claim held by the same actor and claim id.",
      readOnly: false,
      schema: z.object({
        pageId: PageIdSchema.optional(),
        actorId: z.string().trim().min(1).optional(),
        claimId: z.string().trim().min(1),
      }).strict(),
      run: async (input: { pageId?: string; actorId?: string; claimId: string }, source: PageCommandSource) => {
        await this.refresh();
        const page = pageFor(this.document, input.pageId, this.currentPageId);
        await this.storage.releasePageWriter({
          pageId: page.id,
          actorId: actorFor(source, input.actorId),
          claimId: input.claimId,
        });
        return { context: contextFor(this.document, page.id, this.recentReceipt, this.viewContext) };
      },
    };
    const undo = {
      name: "page_undo" as const,
      description: "Undo one exact meaningful page edit using its semantic receipt.",
      readOnly: false,
      schema: MutationSchema.extend({ receiptId: z.string().min(1) }),
      run: async (input: z.infer<typeof MutationSchema> & { receiptId: string }, source: PageCommandSource) => {
        const committed = await this.storage.undo({ workbookId: this.document.workbookId, receiptId: input.receiptId as PageReceipt["id"], mutationId: createMutationId(input.mutationId), actorId: actorFor(source, input.actorId), source: sourceForStorage(source), visiblePageIds: this.viewContext.visiblePageIds, ...(input.claimId === undefined ? {} : { claimId: input.claimId }) });
        return this.acceptCommit(committed, this.currentPageId);
      },
    };
    return [pageContext as CommandDefinition, compositionPropose as unknown as CommandDefinition, compositionApply as unknown as CommandDefinition, compositionVerify as unknown as CommandDefinition, anatomyColoringRead as unknown as CommandDefinition, anatomyPaintApply as unknown as CommandDefinition, anatomyQuizSubmit as unknown as CommandDefinition, calculusPracticeSubmit as unknown as CommandDefinition, coloringEdit as unknown as CommandDefinition, targetResolve as unknown as CommandDefinition, textInsert as unknown as CommandDefinition, structuredTextSet as unknown as CommandDefinition, textFormat as unknown as CommandDefinition, strokeAdd as unknown as CommandDefinition, shapeAdd as unknown as CommandDefinition, vectorInkAdd as unknown as CommandDefinition, vectorInkReplacePropose as unknown as CommandDefinition, vectorInkReplaceApply as unknown as CommandDefinition, diagramAdd as unknown as CommandDefinition, diagramFrameSet as unknown as CommandDefinition, diagramNodesSet as unknown as CommandDefinition, annotationAdd as unknown as CommandDefinition, reviewCalloutAdd as unknown as CommandDefinition, elementFrameSet as unknown as CommandDefinition, moveOrResize("page_element_move") as unknown as CommandDefinition, moveOrResize("page_element_resize") as unknown as CommandDefinition, advance as unknown as CommandDefinition, textContinue as unknown as CommandDefinition, reworkApply as unknown as CommandDefinition, scrapRestore as unknown as CommandDefinition, presentationSet as unknown as CommandDefinition, writerClaim as unknown as CommandDefinition, writerRelease as unknown as CommandDefinition, undo as unknown as CommandDefinition];
  }

  private async commitPage(page: PageRecord, nextPage: PageRecord, input: { mutationId: string; actorId?: string | undefined; claimId?: string | undefined }, source: PageCommandSource, kind: PageCommandName): Promise<PageCommandSuccess["output"]> {
    const reconciledPage = reconcileAnnotationFrames(nextPage);
    const nextDocument = validatePageDocument({ ...this.document, pages: this.document.pages.map((candidate) => candidate.id === page.id ? reconciledPage : candidate) });
    const committed = await this.storage.commit({ workbookId: this.document.workbookId, nextDocument, pageIds: [page.id], expectedDocumentRevision: this.document.documentRevision, expectedPageRevisions: { [page.id]: page.revision }, mutationId: createMutationId(input.mutationId), actorId: actorFor(source, input.actorId), source: sourceForStorage(source), kind, ...(input.claimId === undefined ? {} : { claimId: input.claimId }) });
    return this.acceptCommit(committed, this.currentPageId);
  }

  private acceptCommit(committed: PageCommitResult, pageId: PageId): PageCommandSuccess["output"] {
    this.document = committed.document;
    this.currentPageId = pageId;
    this.viewContext = {
      ...this.viewContext,
      visiblePageIds: resolveVisiblePageIds(this.document, pageId, this.viewContext.presentation),
    };
    this.recentReceipt = committed.receipt;
    this.snapshot = contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext);
    this.publish();
    return {
      context: contextFor(this.document, this.currentPageId, this.recentReceipt, this.viewContext),
      receipt: summarizeReceipt(committed.receipt),
    };
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

function summarizeReceipt(receipt: PageReceipt): PageReceiptSummary {
  return {
    id: receipt.id,
    workbookId: receipt.workbookId,
    mutationId: receipt.mutationId,
    actorId: receipt.actorId,
    source: receipt.source,
    kind: receipt.kind,
    completedAt: receipt.completedAt,
    affectedPageIds: receipt.affectedPageIds,
    resultingDocumentRevision: receipt.resultingDocumentRevision,
    resultingPageRevisions: receipt.resultingPageRevisions,
    undo: receipt.undo,
  };
}

class ReplacementReviewError extends Error {
  public constructor(
    public readonly code: "REPLACEMENT_REVIEW_IN_PROGRESS" | "REPLACEMENT_REVIEW_NOT_FOUND",
    message: string,
  ) {
    super(message);
  }
}

function assertRevision(page: PageRecord, expected: number): void {
  if (page.revision !== expected) throw new PageStorageError("revision_conflict", `Page ${page.id} changed from revision ${expected} to ${page.revision}.`);
}

function assertPageVisible(pageId: PageId, visiblePageIds: readonly PageId[]): void {
  if (!visiblePageIds.includes(pageId)) {
    throw new PageTargetError("PAGE_NOT_VISIBLE", `Page ${pageId} is not actually visible in the current notebook view.`);
  }
}

function assertStructuredTextFits(page: PageRecord, elementId: ElementId): void {
  const element = page.elements.find((candidate) => candidate.id === elementId);
  if (element?.kind !== "text") throw new PagePlacementError("The structured text target is unavailable.");
  const lastLine = layoutPage(page).elements.get(elementId)?.textLines.at(-1);
  if (lastLine !== undefined && lastLine.rect.y + lastLine.rect.height > element.frame.y + element.frame.height + 1e-6) {
    throw new PagePlacementError("The structured text does not fit its finite page frame. Continue it onto another page first.");
  }
}

function now(): PageRecord["updatedAt"] {
  return new Date().toISOString() as PageRecord["updatedAt"];
}

function commandError(error: unknown): PageCommandFailure["error"] {
  if (error instanceof ReplacementReviewError) return { code: error.code, message: error.message };
  if (error instanceof VectorInkReplacementError) {
    if (error.code === "TARGET_NOT_FOUND") return { code: "TARGET_NOT_FOUND", message: error.message };
    if (error.code === "AMBIGUOUS_TARGET") return { code: "TARGET_AMBIGUOUS", message: error.message };
    if (error.code === "NON_VECTOR_TARGET") return { code: "TARGET_NOT_VECTOR_INK", message: error.message };
    if (error.code === "STALE_REPLACEMENT") return { code: "STALE_REPLACEMENT", message: error.message };
    if (error.code === "NO_OP_REPLACEMENT") return { code: "VECTOR_INK_NO_OP", message: error.message };
  }
  if (error instanceof PageCandidateError) return { code: "TARGET_AMBIGUOUS", message: error.message, candidates: error.candidates };
  if (error instanceof PageTargetError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.candidates === undefined ? {} : { candidates: error.candidates }),
    };
  }
  if (error instanceof PagePlacementError) {
    return { code: "SAFE_PLACEMENT_UNAVAILABLE", message: error.message };
  }
  if (error instanceof PageStorageError) {
    if (error.code === "revision_conflict") return { code: "REVISION_CONFLICT", message: error.message };
    if (error.code === "page_busy") return { code: "PAGE_BUSY", message: error.message };
    if (error.code === "page_not_visible") return { code: "PAGE_NOT_VISIBLE", message: error.message };
    if (error.code === "stale_undo" || error.code === "already_undone") return { code: "STALE_UNDO", message: error.message };
    if (error.code === "no_op") return { code: "NO_OP", message: error.message };
  }
  return { code: "COMMAND_ERROR", message: error instanceof Error ? error.message : "The page command failed." };
}

type WebMcpRegistryBinding = {
  registry: PageCommandRegistry;
  active: boolean;
  registered: Set<string>;
  installing: Promise<void> | null;
};
const installedContexts = new WeakMap<WebMcpModelContext, WebMcpRegistryBinding>();

export function deactivatePageWebMcpTools(
  registry: PageCommandRegistry,
  modelContext: WebMcpModelContext | null | undefined,
): void {
  if (modelContext === null || modelContext === undefined) return;
  const binding = installedContexts.get(modelContext);
  if (binding?.registry === registry) binding.active = false;
}

export async function registerPageWebMcpTools(
  registry: PageCommandRegistry,
  modelContext: WebMcpModelContext | null | undefined,
): Promise<Readonly<{ status: "registered" | "unsupported" | "already_registered" | "error"; toolNames: readonly string[]; message?: string }>> {
  if (modelContext === null || modelContext === undefined) return { status: "unsupported", toolNames: [] };
  const descriptors = registry.describe("webmcp");
  const existing = installedContexts.get(modelContext);
  const binding: WebMcpRegistryBinding = existing ?? {
    registry,
    active: true,
    registered: new Set<string>(),
    installing: null,
  };
  binding.registry = registry;
  binding.active = true;
  if (existing === undefined) installedContexts.set(modelContext, binding);
  try {
    if (binding.installing !== null) await binding.installing;
    const missing = descriptors.filter(({ name }) => !binding.registered.has(name));
    if (missing.length > 0) {
      binding.installing = (async () => {
        for (const descriptor of missing) {
          await modelContext.registerTool({
            name: descriptor.name,
            description: descriptor.description,
            inputSchema: descriptor.inputSchema,
            outputSchema: descriptor.outputSchema,
            annotations: { readOnlyHint: descriptor.readOnly, untrustedContentHint: descriptor.untrustedContent },
            execute: async (input: unknown) => {
              if (!binding.active) {
                return {
                  outcome: "error",
                  command: descriptor.name,
                  error: { code: "PAGE_NOT_VISIBLE", message: "Open a notebook page before using this page tool." },
                } satisfies PageCommandFailure;
              }
              const result = await binding.registry.executeExternal(descriptor.name, input, "webmcp");
              if (result.outcome === "error") return result;
              return result.output;
            },
          });
          binding.registered.add(descriptor.name);
        }
      })();
      try {
        await binding.installing;
      } finally {
        binding.installing = null;
      }
    }
    return {
      status: existing === undefined ? "registered" : "already_registered",
      toolNames: descriptors.map(({ name }) => name),
    };
  } catch (error: unknown) {
    return {
      status: "error",
      toolNames: [...binding.registered],
      message: error instanceof Error ? error.message : "Page tool registration failed.",
    };
  }
}

export async function createPageCommandRegistry(
  storage: PageStorage,
  workbookId: WorkbookId,
): Promise<PageCommandRegistry> {
  return PageCommandRegistry.open(storage, workbookId);
}
