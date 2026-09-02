import { z } from "zod";

import { createIsoInstant, type NotebookId } from "../domain";
import { PageStorageError, type PageStorage } from "../indexeddb/page-storage";
import { parseLearningActivity } from "../learning/activities";
import {
  PageCommandRegistry,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  addElement,
  assertSafeDiagramFrame,
  assertSafeVectorFrame,
  createActorId,
  createDocumentRevision,
  createMutationId,
  createPageRevision,
  createTextBlockId,
  derivePlainText,
  isSafeStructuredTextInput,
  layoutPage,
  resolveDiagramTemplate,
  stableBlockId,
  stableElementId,
  stablePageId,
  updateDiagramNodePositions,
  updateElementFrame,
  validateDiagramDocument,
  validatePageDocument,
  validateStructuredTextBlocks,
  validateVectorInkDocument,
  vectorInkFrame,
  VectorInkDocumentSchema,
  type DiagramElement,
  type PageDocument,
  type PageElement,
  type PageId,
  type PageReceiptSummary,
  type PageRecord,
  type PageRect,
  type PageVectorInkElement,
  type StructuredTextBlock,
  type TextElement,
  type VectorInkDocument,
} from "../page";
import type { WorkspaceController } from "../workspace/controller";
import type { NotebookCoverViewModel } from "../workspace/model";

const MAX_CONTENT_LENGTH = 40_000;
const MAX_RECEIPTS = 20;
const MAX_DEMO_PAGES = 8;
const TEXT_GUTTER = 12;
const MIN_TEXT_FRAME_HEIGHT = 64;

function safeText(maxLength: number): z.ZodType<string> {
  return z.string().min(1).max(maxLength).superRefine((value, context) => {
    if (!isSafeStructuredTextInput(value)) {
      context.addIssue({
        code: "custom",
        message: "Content cannot contain raw markup, executable content, URLs, or filesystem paths.",
      });
    }
  });
}

const NotebookReferenceSchema = z.string().trim().min(1).max(160);
const PageNumberSchema = z.number().int().positive().max(1_000);
const PercentageSchema = z.number().finite().min(0).max(100);
const ContentBlockSchema = z.object({
  kind: z.enum(["heading", "paragraph", "quote", "bullet", "numbered"]),
  text: safeText(MAX_CONTENT_LENGTH),
}).strict();

export const NotebookContentInputSchema = z.union([
  safeText(MAX_CONTENT_LENGTH),
  z.object({ kind: z.literal("plain"), text: safeText(MAX_CONTENT_LENGTH) }).strict(),
  z.object({
    kind: z.literal("blocks"),
    blocks: z.array(ContentBlockSchema).min(1).max(128),
  }).strict().superRefine((value, context) => {
    const total = value.blocks.reduce((sum, block) => sum + block.text.length, 0);
    if (total > MAX_CONTENT_LENGTH) {
      context.addIssue({ code: "custom", message: `Content cannot exceed ${MAX_CONTENT_LENGTH} characters.` });
    }
  }),
]);

const VectorCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({ kind: z.literal("line"), x: z.number().finite(), y: z.number().finite() }).strict(),
  z.object({
    kind: z.literal("cubic"), x1: z.number().finite(), y1: z.number().finite(),
    x2: z.number().finite(), y2: z.number().finite(), x: z.number().finite(), y: z.number().finite(),
  }).strict(),
  z.object({
    kind: z.literal("quad"), x1: z.number().finite(), y1: z.number().finite(),
    x: z.number().finite(), y: z.number().finite(),
  }).strict(),
  z.object({ kind: z.literal("close") }).strict(),
]);

const VectorColorSchema = z.enum(["ink", "red", "blue", "green", "gray"]).nullable();
const DrawingPathSchema = z.object({
  commands: z.array(VectorCommandSchema).min(2).max(20_000),
  stroke: VectorColorSchema.optional(),
  strokeWidth: z.number().finite().min(0.25).max(16).optional(),
  fill: VectorColorSchema.optional(),
  linecap: z.enum(["butt", "round", "square"]).optional(),
  linejoin: z.enum(["miter", "round", "bevel"]).optional(),
}).strict();

const DrawingStyleFields = {
  stroke: VectorColorSchema.optional(),
  strokeWidth: z.number().finite().min(0.25).max(16).optional(),
  fill: VectorColorSchema.optional(),
} as const;

const DrawingPrimitiveSchema = z.discriminatedUnion("shape", [
  z.object({
    shape: z.literal("line"),
    x1: z.number().finite(), y1: z.number().finite(),
    x2: z.number().finite(), y2: z.number().finite(),
    ...DrawingStyleFields,
  }).strict(),
  z.object({
    shape: z.literal("arrow"),
    x1: z.number().finite(), y1: z.number().finite(),
    x2: z.number().finite(), y2: z.number().finite(),
    ...DrawingStyleFields,
  }).strict(),
  z.object({
    shape: z.literal("rectangle"),
    x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().positive(), height: z.number().finite().positive(),
    ...DrawingStyleFields,
  }).strict(),
  z.object({
    shape: z.literal("ellipse"),
    cx: z.number().finite(), cy: z.number().finite(),
    rx: z.number().finite().positive(), ry: z.number().finite().positive(),
    ...DrawingStyleFields,
  }).strict(),
]);

const SemanticDiagramSchema = z.object({
  kind: z.literal("semantic-diagram"),
  label: safeText(120),
  layout: z.enum(["flow", "mind-map", "cycle"]).optional(),
  nodes: z.array(z.object({
    id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u),
    label: safeText(80),
    tone: z.enum(["neutral", "accent", "positive", "warning"]).optional(),
  }).strict()).min(1).max(12),
  edges: z.array(z.object({
    from: z.string().trim().min(1).max(64),
    to: z.string().trim().min(1).max(64),
    label: safeText(60).optional(),
  }).strict()).max(24),
}).strict();

const BoundedDrawingSchema = z.object({
  kind: z.literal("drawing"),
  label: safeText(120),
  description: safeText(500).optional(),
  viewBox: z.object({
    width: z.number().finite().min(1).max(4_096),
    height: z.number().finite().min(1).max(4_096),
  }).strict().optional(),
  shapes: z.array(DrawingPrimitiveSchema).min(1).max(256).optional(),
  paths: z.array(DrawingPathSchema).min(1).max(256).optional(),
}).strict().superRefine((value, context) => {
  if ((value.shapes?.length ?? 0) + (value.paths?.length ?? 0) === 0) {
    context.addIssue({ code: "custom", message: "A drawing needs at least one simple shape or path." });
  }
});

export const FigureInputSchema = z.discriminatedUnion("kind", [SemanticDiagramSchema, BoundedDrawingSchema]);

const ElementPlacementSchema = z.object({
  left: PercentageSchema,
  top: PercentageSchema,
  width: z.number().finite().positive().max(100),
  height: z.number().finite().positive().max(100),
}).strict().superRefine((value, context) => {
  if (value.left + value.width > 100) {
    context.addIssue({ code: "custom", message: "Placement must stay within the page width." });
  }
  if (value.top + value.height > 100) {
    context.addIssue({ code: "custom", message: "Placement must stay within the page height." });
  }
});
const DiagramNodePlacementSchema = z.object({
  id: z.string().trim().min(1).max(64),
  x: PercentageSchema,
  y: PercentageSchema,
}).strict();

export const NotebookReadInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent-guide") }).strict(),
  z.object({ kind: z.literal("current") }).strict(),
  z.object({ kind: z.literal("notebooks") }).strict(),
  z.object({ kind: z.literal("page"), notebook: NotebookReferenceSchema.optional(), page: PageNumberSchema }).strict(),
  z.object({ kind: z.literal("receipts") }).strict(),
]);

export const NotebookOpenInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shelf") }).strict(),
  z.object({ kind: z.literal("notebook"), notebook: NotebookReferenceSchema, page: PageNumberSchema.optional() }).strict(),
  z.object({ kind: z.literal("page"), page: PageNumberSchema }).strict(),
  z.object({ kind: z.literal("relative-page"), direction: z.enum(["previous", "next"]) }).strict(),
  z.object({ kind: z.literal("view.reset") }).strict(),
]);

export const NotebookApplyInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notebook.create"),
    title: z.string().trim().min(1).max(120),
    subject: z.string().trim().min(1).max(240).optional(),
    content: NotebookContentInputSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("text.write"),
    notebook: NotebookReferenceSchema.optional(),
    page: PageNumberSchema.optional(),
    mode: z.enum(["append", "replace-page", "replace-notebook"]).optional(),
    content: NotebookContentInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("figure.add"),
    notebook: NotebookReferenceSchema.optional(),
    page: PageNumberSchema.optional(),
    placement: ElementPlacementSchema.optional(),
    figure: FigureInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("figure.trace"),
    notebook: NotebookReferenceSchema.optional(),
    page: PageNumberSchema.optional(),
    placement: ElementPlacementSchema.optional(),
    replaceTarget: z.string().trim().min(1).max(120).optional(),
    label: safeText(120),
    description: safeText(500),
    sourceKind: z.enum(["user-supplied", "agent-generated", "agent-searched"]),
    sourceLabel: safeText(160),
    sourceFormat: z.enum(["png", "jpeg", "webp", "tiff", "pdf"]).optional(),
    document: VectorInkDocumentSchema,
  }).strict(),
  z.object({
    kind: z.literal("layout.arrange"),
    notebook: NotebookReferenceSchema.optional(),
    page: PageNumberSchema.optional(),
    target: z.string().trim().min(1).max(120),
    placement: ElementPlacementSchema,
  }).strict(),
  z.object({
    kind: z.literal("diagram.arrange"),
    notebook: NotebookReferenceSchema.optional(),
    page: PageNumberSchema.optional(),
    target: z.string().trim().min(1).max(120),
    nodes: z.array(DiagramNodePlacementSchema).min(1).max(12),
  }).strict().superRefine((value, context) => {
    const ids = new Set(value.nodes.map((node) => node.id));
    if (ids.size !== value.nodes.length) context.addIssue({ code: "custom", message: "Diagram node placements must use unique ids." });
  }),
  z.object({
    kind: z.literal("page.add"),
    notebook: NotebookReferenceSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("undo") }).strict(),
]);

export const NOTEBOOK_READ_INPUT_SCHEMA = z.toJSONSchema(NotebookReadInputSchema, { target: "draft-07", unrepresentable: "any" });
export const NOTEBOOK_OPEN_INPUT_SCHEMA = z.toJSONSchema(NotebookOpenInputSchema, { target: "draft-07", unrepresentable: "any" });
export const NOTEBOOK_APPLY_INPUT_SCHEMA = z.toJSONSchema(NotebookApplyInputSchema, { target: "draft-07", unrepresentable: "any" });

type NotebookContentInput = z.infer<typeof NotebookContentInputSchema>;
type NotebookReadInput = z.infer<typeof NotebookReadInputSchema>;
type NotebookOpenInput = z.infer<typeof NotebookOpenInputSchema>;
type NotebookApplyInput = z.infer<typeof NotebookApplyInputSchema>;
type BoundedDrawingInput = z.infer<typeof BoundedDrawingSchema>;
type ElementPlacementInput = z.infer<typeof ElementPlacementSchema>;

type NormalizedBlock = Readonly<{ kind: StructuredTextBlock["kind"]; text: string }>;
type ActiveNotebookBinding = Readonly<{
  token: symbol;
  notebookId: NotebookId;
  registry: PageCommandRegistry;
  resetView: () => void;
}>;
type TrackedReceipt = Readonly<{
  receipt: PageReceiptSummary;
  notebook: NotebookCoverViewModel;
  request: "text.write" | "figure.add" | "figure.trace" | "layout.arrange" | "diagram.arrange" | "page.add";
  pages: readonly number[];
}>;

export type NotebookKernelResult =
  | Readonly<{ ok: true; action: string; message: string; data?: unknown }>
  | Readonly<{ ok: false; code: string; message: string }>;

class NotebookKernelError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "NotebookKernelError";
  }
}

function success(action: string, message: string, data?: unknown): NotebookKernelResult {
  return data === undefined ? { ok: true, action, message } : { ok: true, action, message, data };
}

function failure(code: string, message: string): NotebookKernelResult {
  return { ok: false, code, message };
}

function errorResult(error: unknown): NotebookKernelResult {
  if (error instanceof NotebookKernelError) return failure(error.code, error.message);
  if (error instanceof PageStorageError) return failure(error.code.toUpperCase(), error.message);
  return failure("NOTEBOOK_OPERATION_FAILED", error instanceof Error ? error.message : "The notebook operation failed.");
}

function validationFailure(error: z.ZodError): NotebookKernelResult {
  return failure("INVALID_INPUT", error.issues.map((issue) => issue.message).join(" "));
}

function publicBlockKind(kind: StructuredTextBlock["kind"]): "heading" | "paragraph" | "quote" | "bullet" | "numbered" {
  switch (kind) {
    case "heading": return "heading";
    case "paragraph": return "paragraph";
    case "quote": return "quote";
    case "bullet-list-item": return "bullet";
    case "ordered-list-item": return "numbered";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function domainBlockKind(kind: "heading" | "paragraph" | "quote" | "bullet" | "numbered"): StructuredTextBlock["kind"] {
  switch (kind) {
    case "heading": return "heading";
    case "paragraph": return "paragraph";
    case "quote": return "quote";
    case "bullet": return "bullet-list-item";
    case "numbered": return "ordered-list-item";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function plainTextBlocks(text: string): NormalizedBlock[] {
  const sections = text.trim().split(/\n\s*\n/u).map((section) => section.trim()).filter(Boolean);
  const blocks: NormalizedBlock[] = [];
  for (const section of sections) {
    const lines = section.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 1 && /^#{1,3}\s+/u.test(lines[0]!)) {
      blocks.push({ kind: "heading", text: lines[0]!.replace(/^#{1,3}\s+/u, "") });
    } else if (lines.every((line) => /^[-*]\s+/u.test(line))) {
      blocks.push(...lines.map((line) => ({ kind: "bullet-list-item" as const, text: line.replace(/^[-*]\s+/u, "") })));
    } else if (lines.every((line) => /^\d+[.)]\s+/u.test(line))) {
      blocks.push(...lines.map((line) => ({ kind: "ordered-list-item" as const, text: line.replace(/^\d+[.)]\s+/u, "") })));
    } else if (lines.every((line) => /^>\s*/u.test(line))) {
      blocks.push({ kind: "quote", text: lines.map((line) => line.replace(/^>\s*/u, "")).join("\n") });
    } else {
      blocks.push({ kind: "paragraph", text: section });
    }
  }
  if (blocks.at(-1)?.kind === "heading") blocks.push({ kind: "paragraph", text: "" });
  return blocks;
}

function normalizeContent(input: NotebookContentInput): NormalizedBlock[] {
  if (typeof input === "string") return plainTextBlocks(input);
  if (input.kind === "plain") return plainTextBlocks(input.text);
  const blocks = input.blocks.map((block) => ({ kind: domainBlockKind(block.kind), text: block.text }));
  if (blocks.at(-1)?.kind === "heading") blocks.push({ kind: "paragraph", text: "" });
  return blocks;
}

function roundedPercentage(value: number): number {
  return Math.round(value * 10) / 10;
}

function semanticPlacement(page: PageRecord, frame: PageRect): Readonly<Record<string, number>> {
  const bounds = layoutPage(page).metrics.contentRect;
  return {
    left: roundedPercentage(((frame.x - bounds.x) / bounds.width) * 100),
    top: roundedPercentage(((frame.y - bounds.y) / bounds.height) * 100),
    width: roundedPercentage((frame.width / bounds.width) * 100),
    height: roundedPercentage((frame.height / bounds.height) * 100),
  };
}

function frameFromPlacement(page: PageRecord, placement: ElementPlacementInput): PageRect {
  const bounds = layoutPage(page).metrics.contentRect;
  return {
    x: bounds.x + bounds.width * (placement.left / 100),
    y: bounds.y + bounds.height * (placement.top / 100),
    width: bounds.width * (placement.width / 100),
    height: bounds.height * (placement.height / 100),
  };
}

function semanticElement(page: PageRecord, element: PageElement): Readonly<Record<string, unknown>> {
  const placement = semanticPlacement(page, element.frame);
  switch (element.kind) {
    case "text": return {
      kind: "text",
      label: element.label,
      placement,
      blocks: element.content.blocks.map((block) => ({
        kind: publicBlockKind(block.kind),
        text: block.runs.map((run) => run.text).join(""),
        marks: [...new Set(block.runs.flatMap((run) => run.marks))],
      })),
    };
    case "diagram": return {
      kind: "diagram",
      label: element.label,
      placement,
      layout: element.document.layout,
      nodes: element.document.nodes.map((node) => ({ id: node.id, label: node.label, ...(node.position === undefined ? {} : { position: node.position }) })),
      edges: element.document.edges,
    };
    case "vector-ink": return {
      kind: element.provenance?.tool === "trace-detailed-art" ? "trace" : "drawing",
      label: element.label,
      description: element.description,
      placement,
      ...(element.provenance === undefined ? {} : { provenance: element.provenance }),
    };
    case "shape": return { kind: "shape", shape: element.shape, label: element.label, placement };
    case "stroke": return { kind: "stroke", label: element.label, placement };
    case "annotation": return { kind: "annotation", annotation: element.annotation, label: element.label, placement, ...(element.text === undefined ? {} : { text: element.text }) };
    case "embedded-frame": {
      const activity = parseLearningActivity(element);
      if (activity?.kind === "calculus") {
        const feedbackByQuestion = new Map(
          activity.props.latestSubmission?.feedback.map((feedback) => [feedback.questionId, feedback]) ?? [],
        );
        return {
          kind: "activity",
          label: element.label,
          componentType: element.componentType,
          placement,
          title: activity.props.title,
          directions: activity.props.directions,
          score: activity.props.latestSubmission === undefined ? null : {
            correct: activity.props.latestSubmission.score,
            total: activity.props.latestSubmission.total,
          },
          questions: activity.props.questions.map((question) => {
            const feedback = feedbackByQuestion.get(question.id);
            return {
              id: question.id,
              prompt: question.prompt,
              answerLabel: question.answerLabel,
              response: activity.props.latestSubmission?.answers[question.id] ?? "",
              ...(feedback === undefined ? {} : { correct: feedback.correct, feedback: feedback.message }),
            };
          }),
        };
      }
      if (activity?.kind === "coloring") {
        return {
          kind: "activity",
          label: element.label,
          componentType: element.componentType,
          placement,
          scene: activity.props.scene,
          title: activity.props.title,
          prompt: activity.props.prompt,
          strokeCount: activity.props.strokes.length,
          controls: ["pen", "eraser", "color", "stroke-size", "undo", "clear"],
        };
      }
      return { kind: "activity", label: element.label, componentType: element.componentType, placement };
    }
    default: {
      const exhaustive: never = element;
      return exhaustive;
    }
  }
}

function semanticPage(page: PageRecord): Readonly<Record<string, unknown>> {
  return {
    page: page.number,
    plainText: page.elements.filter((element): element is TextElement => element.kind === "text")
      .map((element) => derivePlainText(element.content)).join("\n").trim(),
    content: page.elements.map((element) => semanticElement(page, element)),
  };
}

function uniqueCovers(covers: readonly NotebookCoverViewModel[]): readonly NotebookCoverViewModel[] {
  const unique = new Map<string, NotebookCoverViewModel>();
  for (const cover of covers) unique.set(cover.id, cover);
  return [...unique.values()];
}

function snapshotCovers(controller: WorkspaceController): readonly NotebookCoverViewModel[] {
  const snapshot = controller.getSnapshot();
  if (snapshot.status === "failed") return [snapshot.fallback.inbox, ...snapshot.fallback.notebooks];
  if (snapshot.status !== "ready") return [];
  return snapshot.view.kind === "notebook"
    ? [snapshot.view.notebook]
    : [snapshot.view.inbox, ...snapshot.view.notebooks];
}

function currentCover(controller: WorkspaceController): NotebookCoverViewModel | null {
  const snapshot = controller.getSnapshot();
  return snapshot.status === "ready" && snapshot.view.kind === "notebook" ? snapshot.view.notebook : null;
}

function availableTextFrames(page: PageRecord): readonly PageRect[] {
  const bounds = layoutPage(page).metrics.contentRect;
  const occupied = page.elements.map((element) => ({
    start: Math.max(element.frame.y - TEXT_GUTTER, bounds.y),
    end: Math.min(element.frame.y + element.frame.height + TEXT_GUTTER, bounds.y + bounds.height),
  })).filter((span) => span.end > span.start).sort((left, right) => left.start - right.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of occupied) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start > previous.end) merged.push({ ...span });
    else previous.end = Math.max(previous.end, span.end);
  }
  const frames: PageRect[] = [];
  let cursor = bounds.y;
  for (const span of merged) {
    if (span.start - cursor >= MIN_TEXT_FRAME_HEIGHT) frames.push({ x: bounds.x, y: cursor, width: bounds.width, height: span.start - cursor });
    cursor = Math.max(cursor, span.end);
  }
  const bottom = bounds.y + bounds.height;
  if (bottom - cursor >= MIN_TEXT_FRAME_HEIGHT) frames.push({ x: bounds.x, y: cursor, width: bounds.width, height: bottom - cursor });
  return frames;
}

function wrappedLines(text: string, charactersPerLine: number): number {
  if (text.length === 0) return 1;
  return text.split(/\r?\n/u).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)), 0);
}

function splitAtWord(text: string, maximum: number): Readonly<{ head: string; tail: string }> {
  if (text.length <= maximum) return { head: text, tail: "" };
  const prefix = text.slice(0, maximum + 1);
  const boundary = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
  const split = boundary > 0 ? boundary : maximum;
  return { head: text.slice(0, split).trimEnd(), tail: text.slice(split).trimStart() };
}

function takeBlocksForFrame(source: readonly NormalizedBlock[], frame: PageRect): Readonly<{
  blocks: readonly NormalizedBlock[];
  remaining: readonly NormalizedBlock[];
}> {
  const charactersPerLine = Math.max(12, Math.floor(frame.width / 10));
  let linesLeft = Math.max(1, Math.floor(frame.height / 28));
  const remaining = [...source];
  const accepted: NormalizedBlock[] = [];
  while (remaining.length > 0 && linesLeft > 0) {
    const next = remaining[0]!;
    const lines = wrappedLines(next.text, charactersPerLine);
    if (next.kind === "heading" && lines >= linesLeft && accepted.length > 0) break;
    if (lines <= linesLeft) {
      accepted.push(next);
      remaining.shift();
      linesLeft -= lines;
      continue;
    }
    const usableLines = linesLeft - (next.kind === "heading" ? 1 : 0);
    if (usableLines < 1) break;
    const split = splitAtWord(next.text, charactersPerLine * usableLines);
    if (split.head.length === 0) break;
    accepted.push({ kind: next.kind, text: split.head });
    remaining[0] = { kind: next.kind === "heading" ? "paragraph" : next.kind, text: split.tail };
    break;
  }
  if (accepted.at(-1)?.kind === "heading") accepted.push({ kind: "paragraph", text: "" });
  return { blocks: accepted, remaining };
}

function structuredBlocks(blocks: readonly NormalizedBlock[], requestId: string, elementIndex: number): readonly StructuredTextBlock[] {
  return validateStructuredTextBlocks(blocks.map((block, blockIndex) => ({
    id: createTextBlockId(stableBlockId(`${requestId}:${elementIndex}:${blockIndex}`)),
    kind: block.kind,
    runs: [{ text: block.text, marks: [] }],
  })));
}

function composeTextDocument(input: Readonly<{
  current: PageDocument;
  startPage: number;
  mode: "append" | "replace-page" | "replace-notebook";
  blocks: readonly NormalizedBlock[];
  requestId: string;
  at: PageRecord["updatedAt"];
}>): Readonly<{ document: PageDocument; affectedPageIds: readonly PageId[]; pages: readonly number[] }> {
  const original = input.current;
  const pages = original.pages.map((page) => {
    const clear = input.mode === "replace-notebook" || (input.mode === "replace-page" && page.number === input.startPage);
    return clear ? { ...page, elements: page.elements.filter((element) => element.kind !== "text") } : page;
  });
  const changedExisting = new Set<PageId>();
  for (const page of original.pages) {
    const clear = input.mode === "replace-notebook" || (input.mode === "replace-page" && page.number === input.startPage);
    if (clear && page.elements.some((element) => element.kind === "text")) changedExisting.add(page.id);
  }
  let remaining = [...input.blocks];
  const writtenPages = new Set<number>();
  let pageIndex = input.mode === "replace-notebook" ? 0 : input.startPage - 1;
  let elementIndex = 0;
  while (remaining.length > 0) {
    if (pageIndex >= pages.length) {
      if (pages.length >= MAX_DEMO_PAGES) throw new NotebookKernelError("CONTENT_TOO_LONG", `Content does not fit within the ${MAX_DEMO_PAGES}-page demo limit.`);
      const template = pages[0]!;
      const number = pages.length + 1;
      pages.push({
        version: 1,
        id: stablePageId(original.workbookId, number),
        workbookId: original.workbookId,
        number,
        revision: createPageRevision(1),
        size: template.size,
        paper: template.paper ?? "lined",
        elements: [],
        createdAt: input.at,
        updatedAt: input.at,
      });
    }
    let page = pages[pageIndex]!;
    for (const frame of availableTextFrames(page)) {
      if (remaining.length === 0) break;
      const selected = takeBlocksForFrame(remaining, frame);
      if (selected.blocks.length === 0) continue;
      const element: TextElement = {
        kind: "text",
        id: stableElementId("agent-text", `${input.requestId}:${elementIndex}`),
        label: selected.blocks.find((block) => block.text.trim().length > 0)?.text.trim().slice(0, 48) ?? "Notebook text",
        frame,
        content: { format: "rich_text", blocks: structuredBlocks(selected.blocks, input.requestId, elementIndex) },
      };
      page = { ...page, elements: [...page.elements, element] };
      remaining = [...selected.remaining];
      elementIndex += 1;
      writtenPages.add(page.number);
      if (page.number <= original.pages.length) changedExisting.add(page.id);
    }
    pages[pageIndex] = page;
    pageIndex += 1;
  }
  const finalizedPages = pages.map((page) => {
    if (!changedExisting.has(page.id)) return page;
    const before = original.pages.find((candidate) => candidate.id === page.id);
    return before === undefined ? page : { ...page, revision: createPageRevision(before.revision + 1), updatedAt: input.at };
  });
  const topologyChanged = finalizedPages.length !== original.pages.length;
  const document = validatePageDocument({
    ...original,
    documentRevision: topologyChanged ? createDocumentRevision(original.documentRevision + 1) : original.documentRevision,
    pageOrder: finalizedPages.map((page) => page.id),
    pages: finalizedPages,
  });
  const affectedPageIds = document.pages.filter((page) => {
    const before = original.pages.find((candidate) => candidate.id === page.id);
    return before === undefined || JSON.stringify(before) !== JSON.stringify(page);
  }).map((page) => page.id);
  if (affectedPageIds.length === 0) throw new NotebookKernelError("NO_OP", "The requested text already matches the notebook.");
  return { document, affectedPageIds, pages: [...writtenPages].sort((left, right) => left - right) };
}

function drawingDocument(input: BoundedDrawingInput): VectorInkDocument {
  const viewBox = input.viewBox ?? { width: 100, height: 100 };
  const primitivePaths = (input.shapes ?? []).flatMap<VectorInkDocument["paths"][number]>((shape) => {
    const paint = {
      stroke: shape.stroke === undefined ? "ink" as const : shape.stroke,
      strokeWidth: shape.strokeWidth ?? 2,
      fill: shape.fill ?? null,
      linecap: "round" as const,
      linejoin: "round" as const,
    };
    if (shape.shape === "line") {
      return [{ commands: [{ kind: "move" as const, x: shape.x1, y: shape.y1 }, { kind: "line" as const, x: shape.x2, y: shape.y2 }], paint }];
    }
    if (shape.shape === "arrow") {
      const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
      const head = Math.max(4, Math.min(14, Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) * 0.18));
      const left = angle + (Math.PI * 5) / 6;
      const right = angle - (Math.PI * 5) / 6;
      return [{
        commands: [
          { kind: "move" as const, x: shape.x1, y: shape.y1 },
          { kind: "line" as const, x: shape.x2, y: shape.y2 },
          { kind: "move" as const, x: shape.x2, y: shape.y2 },
          { kind: "line" as const, x: shape.x2 + Math.cos(left) * head, y: shape.y2 + Math.sin(left) * head },
          { kind: "move" as const, x: shape.x2, y: shape.y2 },
          { kind: "line" as const, x: shape.x2 + Math.cos(right) * head, y: shape.y2 + Math.sin(right) * head },
        ],
        paint: { ...paint, fill: null },
      }];
    }
    if (shape.shape === "rectangle") {
      return [{
        commands: [
          { kind: "move" as const, x: shape.x, y: shape.y },
          { kind: "line" as const, x: shape.x + shape.width, y: shape.y },
          { kind: "line" as const, x: shape.x + shape.width, y: shape.y + shape.height },
          { kind: "line" as const, x: shape.x, y: shape.y + shape.height },
          { kind: "close" as const },
        ],
        paint,
      }];
    }
    const factor = 0.5522847498307936;
    return [{
      commands: [
        { kind: "move" as const, x: shape.cx + shape.rx, y: shape.cy },
        { kind: "cubic" as const, x1: shape.cx + shape.rx, y1: shape.cy + factor * shape.ry, x2: shape.cx + factor * shape.rx, y2: shape.cy + shape.ry, x: shape.cx, y: shape.cy + shape.ry },
        { kind: "cubic" as const, x1: shape.cx - factor * shape.rx, y1: shape.cy + shape.ry, x2: shape.cx - shape.rx, y2: shape.cy + factor * shape.ry, x: shape.cx - shape.rx, y: shape.cy },
        { kind: "cubic" as const, x1: shape.cx - shape.rx, y1: shape.cy - factor * shape.ry, x2: shape.cx - factor * shape.rx, y2: shape.cy - shape.ry, x: shape.cx, y: shape.cy - shape.ry },
        { kind: "cubic" as const, x1: shape.cx + factor * shape.rx, y1: shape.cy - shape.ry, x2: shape.cx + shape.rx, y2: shape.cy - factor * shape.ry, x: shape.cx + shape.rx, y: shape.cy },
        { kind: "close" as const },
      ],
      paint,
    }];
  });
  return validateVectorInkDocument({
    version: 1,
    viewBox,
    paths: [...primitivePaths, ...(input.paths ?? []).map((path) => ({
      commands: path.commands,
      paint: {
        stroke: path.stroke === undefined ? "ink" : path.stroke,
        strokeWidth: path.strokeWidth ?? 2,
        fill: path.fill ?? null,
        linecap: path.linecap ?? "round",
        linejoin: path.linejoin ?? "round",
      },
    }))],
  });
}

let operationSequence = 0;
function nextInternalId(kind: string): string {
  operationSequence += 1;
  return `agent-kernel:${kind}:${Date.now().toString(36)}:${operationSequence.toString(36)}`;
}

export class DemoNotebookKernel {
  private active: ActiveNotebookBinding | null = null;
  private readonly pendingFocus = new Map<NotebookId, number>();
  private readonly receipts: TrackedReceipt[] = [];
  private operationTail: Promise<void> = Promise.resolve();

  public constructor(
    private readonly controller: WorkspaceController,
    private readonly pageStorage?: PageStorage,
  ) {}

  public bindActiveNotebook(binding: Readonly<{
    notebookId: NotebookId;
    registry: PageCommandRegistry;
    resetView: () => void;
  }>): () => void {
    const { notebookId, registry, resetView } = binding;
    const token = Symbol(notebookId);
    this.active = { token, notebookId, registry, resetView };
    const pendingPage = this.pendingFocus.get(notebookId);
    if (pendingPage !== undefined) {
      void registry.refresh().then(() => {
        if (this.active?.token !== token) return;
        const page = registry.getDocument().pages[pendingPage - 1];
        if (page !== undefined) registry.focusPage(page.id);
        this.pendingFocus.delete(notebookId);
      });
    }
    return () => {
      if (this.active?.token === token) this.active = null;
    };
  }

  public read(input: unknown): Promise<NotebookKernelResult> {
    const parsed = NotebookReadInputSchema.safeParse(input);
    return parsed.success ? this.afterPending(() => this.readNow(parsed.data)) : Promise.resolve(validationFailure(parsed.error));
  }

  public open(input: unknown): Promise<NotebookKernelResult> {
    const parsed = NotebookOpenInputSchema.safeParse(input);
    return parsed.success ? this.exclusive(() => this.openNow(parsed.data)) : Promise.resolve(validationFailure(parsed.error));
  }

  public apply(input: unknown): Promise<NotebookKernelResult> {
    const parsed = NotebookApplyInputSchema.safeParse(input);
    return parsed.success ? this.exclusive(() => this.applyNow(parsed.data)) : Promise.resolve(validationFailure(parsed.error));
  }

  private async afterPending(operation: () => Promise<NotebookKernelResult>): Promise<NotebookKernelResult> {
    await this.operationTail;
    try { return await operation(); } catch (error: unknown) { return errorResult(error); }
  }

  private exclusive(operation: () => Promise<NotebookKernelResult>): Promise<NotebookKernelResult> {
    const task = this.operationTail.then(async () => {
      try { return await operation(); } catch (error: unknown) { return errorResult(error); }
    });
    this.operationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async covers(): Promise<readonly NotebookCoverViewModel[]> {
    const listed = await this.controller.listNotebooks();
    if (!listed.ok) throw new NotebookKernelError("WORKSPACE_UNAVAILABLE", listed.issue.message);
    return uniqueCovers([...snapshotCovers(this.controller), ...listed.value]);
  }

  private async resolveNotebook(reference: string): Promise<NotebookCoverViewModel> {
    const covers = await this.covers();
    const byId = covers.find((cover) => cover.id === reference);
    if (byId !== undefined) return byId;
    const normalized = reference.trim().toLocaleLowerCase();
    const byTitle = covers.filter((cover) => cover.title.trim().toLocaleLowerCase() === normalized);
    if (byTitle.length === 1) return byTitle[0]!;
    if (byTitle.length > 1) throw new NotebookKernelError("AMBIGUOUS_NOTEBOOK", `More than one notebook is titled "${reference}". Use its id.`);
    throw new NotebookKernelError("NOTEBOOK_NOT_FOUND", `No available notebook matches "${reference}".`);
  }

  private currentNotebook(): NotebookCoverViewModel {
    const current = currentCover(this.controller);
    if (current === null) throw new NotebookKernelError("NOTEBOOK_NOT_OPEN", "Open a notebook before using this action.");
    return current;
  }

  private async targetNotebook(reference: string | undefined): Promise<NotebookCoverViewModel> {
    return reference === undefined ? this.currentNotebook() : this.resolveNotebook(reference);
  }

  private async readNow(input: NotebookReadInput): Promise<NotebookKernelResult> {
    switch (input.kind) {
      case "agent-guide":
        return success("notebook_read", "Agent-native notebook workflow guide.", {
          contractVersion: 1,
          tools: ["notebook_read", "notebook_open", "notebook_apply"],
          behavior: [
            "Read only when exact notebook state or labels are needed; open exact pages directly without narrating routine navigation.",
            "Use notebook_open with kind view.reset to center the open notebook, restore 100% zoom, and turn Pan off.",
            "Write formatted blocks first, then use percentage placement only when composing mixed text and figures on one page.",
            "Treat calculus practice and coloring pages as bounded activities. Read their prompts, saved responses, feedback, scene, and tool state from the page before changing nearby content.",
            "Use page.add for deterministic page advancement and diagram.arrange for node-level layout without creating another tool.",
          ],
          tracing: {
            skill: "trace-detailed-art",
            sourceKinds: ["user-supplied", "agent-generated", "agent-searched"],
            useWhen: "A user-supplied, agent-generated, or reusable agent-searched reference needs faithful editable ink.",
            workflow: [
              "Crop the intended figure tightly and exclude captions or page defects unless requested.",
              "Trace visible ink and visually compare the rendered SVG with the source at identical dimensions.",
              "Convert the validated SVG with svg_to_vector_ink.py, then call notebook_apply with kind figure.trace.",
            ],
            boundaries: [
              "Do not embed the source raster in the traced figure.",
              "Do not claim that traced paths understand depicted objects or hidden anatomy.",
              "For searched references, verify reuse rights before tracing; prefer public-domain or clearly reusable sources.",
              "Keep source crops and comparison artifacts outside the portable notebook document when reproducibility matters.",
            ],
          },
        });
      case "notebooks": {
        const covers = await this.covers();
        const notebooks = await Promise.all(covers.map(async (cover) => {
          const document = this.active?.notebookId === cover.id
            ? this.active.registry.getDocument()
            : await this.pageStorage?.getDocument(cover.id);
          return { id: cover.id, title: cover.title, subject: cover.subject, pages: document?.pages.length ?? 0 };
        }));
        return success("notebook_read", `${notebooks.length} notebooks available.`, { view: "shelf", notebooks });
      }
      case "receipts": {
        const recent = this.receipts.slice(-MAX_RECEIPTS).reverse().map((tracked, index) => ({
          latest: index === 0,
          action: tracked.request,
          notebook: { id: tracked.notebook.id, title: tracked.notebook.title },
          pages: tracked.pages,
          completedAt: tracked.receipt.completedAt,
          undo: tracked.receipt.undo.kind,
        }));
        return success("notebook_read", `${recent.length} recent agent changes.`, { receipts: recent });
      }
      case "current": {
        const snapshot = this.controller.getSnapshot();
        if (snapshot.status !== "ready") throw new NotebookKernelError("WORKSPACE_UNAVAILABLE", "The notebook desk is not ready.");
        if (snapshot.view.kind === "shelf") {
          const notebooks = await this.covers();
          return success("notebook_read", "The notebook shelf is open.", { view: "shelf", notebooks: notebooks.map(({ id, title, subject }) => ({ id, title, subject })) });
        }
        if (this.active?.notebookId === snapshot.view.notebook.id) await this.active.registry.refresh();
        const document = await this.documentFor(snapshot.view.notebook.id);
        return this.pageReadResult(snapshot.view.notebook, document, this.focusedPageNumber(snapshot.view.notebook.id, document));
      }
      case "page": {
        const notebook = await this.targetNotebook(input.notebook);
        return this.pageReadResult(notebook, await this.documentFor(notebook.id), input.page);
      }
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  private pageReadResult(notebook: NotebookCoverViewModel, document: PageDocument, pageNumber: number): NotebookKernelResult {
    const page = this.assertPage(document, pageNumber, notebook.title);
    return success("notebook_read", `Read ${notebook.title}, page ${pageNumber} of ${document.pages.length}.`, {
      view: "notebook",
      notebook: { id: notebook.id, title: notebook.title, subject: notebook.subject },
      pageCount: document.pages.length,
      ...semanticPage(page),
    });
  }

  private async openNow(input: NotebookOpenInput): Promise<NotebookKernelResult> {
    switch (input.kind) {
      case "shelf":
        this.controller.showShelf();
        this.active = null;
        return success("notebook_open", "Opened the notebook shelf.", { view: "shelf" });
      case "notebook": {
        const notebook = await this.resolveNotebook(input.notebook);
        const document = await this.documentFor(notebook.id);
        const page = input.page ?? 1;
        this.assertPage(document, page, notebook.title);
        await this.openNotebook(notebook, page);
        return success("notebook_open", `Opened ${notebook.title} to page ${page}.`, { notebook: { id: notebook.id, title: notebook.title }, page, pageCount: document.pages.length });
      }
      case "page": {
        const notebook = this.currentNotebook();
        const document = await this.documentFor(notebook.id);
        this.assertPage(document, input.page, notebook.title);
        await this.focusNotebookPage(notebook.id, input.page);
        return success("notebook_open", `Opened ${notebook.title} to page ${input.page}.`, { notebook: { id: notebook.id, title: notebook.title }, page: input.page, pageCount: document.pages.length });
      }
      case "relative-page": {
        const notebook = this.currentNotebook();
        if (this.active === null || this.active.notebookId !== notebook.id) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The active page session is not ready for relative navigation.");
        await this.active.registry.refresh();
        const current = this.active.registry.getSnapshot().focusedPageNumber;
        const page = input.direction === "next" ? current + 1 : current - 1;
        const document = this.active.registry.getDocument();
        const target = this.assertPage(document, page, notebook.title);
        this.active.registry.focusPage(target.id);
        return success("notebook_open", `Opened ${notebook.title} to page ${page}.`, { notebook: { id: notebook.id, title: notebook.title }, page, pageCount: document.pages.length });
      }
      case "view.reset": {
        if (this.active === null) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "Open a notebook before resetting its view.");
        this.active.resetView();
        return success("notebook_open", "Reset the notebook view.", {
          view: "reset",
          scale: 100,
          pan: { x: 0, y: 0 },
          panEnabled: false,
        });
      }
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  private async applyNow(input: NotebookApplyInput): Promise<NotebookKernelResult> {
    switch (input.kind) {
      case "notebook.create": return this.createNotebook(input);
      case "text.write": return this.writeText(input);
      case "figure.add": return this.addFigure(input);
      case "figure.trace": return this.traceFigure(input);
      case "layout.arrange": return this.arrangeElement(input);
      case "diagram.arrange": return this.arrangeDiagramNodes(input);
      case "page.add": return this.addPage(input);
      case "undo": return this.undoLatest();
      default: {
        const exhaustive: never = input;
        return exhaustive;
      }
    }
  }

  private async createNotebook(input: Extract<NotebookApplyInput, { kind: "notebook.create" }>): Promise<NotebookKernelResult> {
    const created = await this.controller.createNotebook({ title: input.title, subject: input.subject ?? "Notes" });
    if (!created.ok) throw new NotebookKernelError("NOTEBOOK_CREATE_FAILED", created.issue.message);
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    await this.pageStorage.ensureWorkbook(created.value.id);
    this.pendingFocus.set(created.value.id, 1);
    if (input.content !== undefined) {
      const written = await this.writeText({
        kind: "text.write",
        notebook: created.value.id,
        page: 1,
        mode: "replace-notebook",
        content: input.content,
      });
      if (!written.ok) return written;
      return success("notebook_apply", `Created ${created.value.title} and wrote its notes.`, {
        change: "notebook.create",
        notebook: { id: created.value.id, title: created.value.title, subject: created.value.subject },
        pages: (written.data as { pages?: readonly number[] } | undefined)?.pages ?? [1],
        undo: "content-available",
        persistence: "browser-session",
      });
    }
    await this.openNotebook(created.value, 1);
    return success("notebook_apply", `Created and opened ${created.value.title}.`, {
      change: "notebook.create",
      notebook: { id: created.value.id, title: created.value.title, subject: created.value.subject },
      persistence: "browser-session",
    });
  }

  private async writeText(input: Extract<NotebookApplyInput, { kind: "text.write" }>): Promise<NotebookKernelResult> {
    const notebook = await this.targetNotebook(input.notebook);
    const initial = await this.documentFor(notebook.id);
    const page = input.page ?? this.focusedPageNumber(notebook.id, initial);
    this.assertPage(initial, page, notebook.title);
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    const requestId = nextInternalId("text-write");
    const composed = composeTextDocument({
      current: initial,
      startPage: page,
      mode: input.mode ?? "append",
      blocks: normalizeContent(input.content),
      requestId,
      at: createIsoInstant(new Date().toISOString()),
    });
    const committed = await this.pageStorage.commit({
      workbookId: notebook.id,
      nextDocument: composed.document,
      pageIds: composed.affectedPageIds,
      expectedDocumentRevision: initial.documentRevision,
      expectedPageRevisions: Object.fromEntries(initial.pages.map((candidate) => [candidate.id, candidate.revision])),
      mutationId: createMutationId(requestId),
      actorId: createActorId("assistant:notebook-kernel"),
      source: "assistant",
      kind: "notebook_text_write",
    });
    this.trackReceipt({ receipt: committed.receipt, notebook, request: "text.write", pages: composed.pages });
    await this.openNotebook(notebook, composed.pages[0] ?? page);
    return success("notebook_apply", `Wrote ${composed.pages.length} page${composed.pages.length === 1 ? "" : "s"} in ${notebook.title}.`, {
      change: "text.write", notebook: { id: notebook.id, title: notebook.title }, mode: input.mode ?? "append", pages: composed.pages, undo: "available",
    });
  }

  private async addFigure(input: Extract<NotebookApplyInput, { kind: "figure.add" }>): Promise<NotebookKernelResult> {
    const notebook = await this.targetNotebook(input.notebook);
    const document = await this.documentFor(notebook.id);
    let pageNumber = input.page ?? this.focusedPageNumber(notebook.id, document);
    if (input.figure.kind === "semantic-diagram") {
      if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
      let nextDocument = document;
      let page = this.assertPage(document, pageNumber, notebook.title);
      if (page.elements.length > 0 && input.placement === undefined) {
        if (input.page !== undefined) throw new NotebookKernelError("SAFE_PLACEMENT_UNAVAILABLE", `Page ${pageNumber} already contains content. Omit page to place the diagram on a fresh page.`);
        if (document.pages.length >= MAX_DEMO_PAGES) throw new NotebookKernelError("PAGE_LIMIT", `The demo notebook already has ${MAX_DEMO_PAGES} pages.`);
        const number = document.pages.length + 1;
        const at = createIsoInstant(new Date().toISOString());
        page = {
          version: 1,
          id: stablePageId(document.workbookId, number),
          workbookId: document.workbookId,
          number,
          revision: createPageRevision(1),
          size: document.pages[0]!.size,
          paper: document.pages[0]!.paper ?? "lined",
          elements: [],
          createdAt: at,
          updatedAt: at,
        };
        pageNumber = number;
        nextDocument = validatePageDocument({
          ...document,
          documentRevision: createDocumentRevision(document.documentRevision + 1),
          pageOrder: [...document.pageOrder, page.id],
          pages: [...document.pages, page],
        });
      }
      const requestId = nextInternalId("figure-add");
      const template = resolveDiagramTemplate("relationship-map");
      const frame = input.placement === undefined
        ? {
            x: template.frame.x * (page.size.width / PAGE_WIDTH),
            y: template.frame.y * (page.size.height / PAGE_HEIGHT),
            width: template.frame.width * (page.size.width / PAGE_WIDTH),
            height: template.frame.height * (page.size.height / PAGE_HEIGHT),
          }
        : frameFromPlacement(page, input.placement);
      const elementId = stableElementId("agent-diagram", requestId);
      assertSafeDiagramFrame(page, frame, elementId);
      const diagram: DiagramElement = {
        kind: "diagram",
        id: elementId,
        label: input.figure.label,
        frame,
        engine: "native",
        engineVersion: 1,
        document: validateDiagramDocument({
          version: 1,
          layout: input.figure.layout ?? "flow",
          nodes: input.figure.nodes.map((node) => ({ id: node.id, label: node.label, ...(node.tone === undefined ? {} : { tone: node.tone }) })),
          edges: input.figure.edges.map((edge) => ({ from: edge.from, to: edge.to, ...(edge.label === undefined ? {} : { label: edge.label }) })),
        }),
      };
      const at = createIsoInstant(new Date().toISOString());
      const withDiagram = addElement(page, diagram, at);
      nextDocument = validatePageDocument({
        ...nextDocument,
        pages: nextDocument.pages.map((candidate) => candidate.id === page.id ? withDiagram : candidate),
      });
      const committed = await this.pageStorage.commit({
        workbookId: notebook.id,
        nextDocument,
        pageIds: [page.id],
        expectedDocumentRevision: document.documentRevision,
        expectedPageRevisions: page.number <= document.pages.length ? { [page.id]: document.pages[page.number - 1]!.revision } : {},
        mutationId: createMutationId(requestId),
        actorId: createActorId("assistant:notebook-kernel"),
        source: "assistant",
        kind: "notebook_figure_add",
      });
      this.trackReceipt({ receipt: committed.receipt, notebook, request: "figure.add", pages: [pageNumber] });
      await this.openNotebook(notebook, pageNumber);
      return success("notebook_apply", `Added ${input.figure.label} to ${notebook.title}, page ${pageNumber}.`, {
        change: "figure.add", figure: "semantic-diagram", notebook: { id: notebook.id, title: notebook.title }, page: pageNumber, undo: "available",
      });
    }
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    let nextDocument = document;
    let page = this.assertPage(document, pageNumber, notebook.title);
    if (page.elements.length > 0 && input.placement === undefined) {
      if (input.page !== undefined) throw new NotebookKernelError("SAFE_PLACEMENT_UNAVAILABLE", `Page ${pageNumber} already contains content. Omit page to place the drawing on a fresh page.`);
      if (document.pages.length >= MAX_DEMO_PAGES) throw new NotebookKernelError("PAGE_LIMIT", `The demo notebook already has ${MAX_DEMO_PAGES} pages.`);
      const number = document.pages.length + 1;
      const at = createIsoInstant(new Date().toISOString());
      page = {
        version: 1,
        id: stablePageId(document.workbookId, number),
        workbookId: document.workbookId,
        number,
        revision: createPageRevision(1),
        size: document.pages[0]!.size,
        paper: document.pages[0]!.paper ?? "lined",
        elements: [],
        createdAt: at,
        updatedAt: at,
      };
      pageNumber = number;
      nextDocument = validatePageDocument({
        ...document,
        documentRevision: createDocumentRevision(document.documentRevision + 1),
        pageOrder: [...document.pageOrder, page.id],
        pages: [...document.pages, page],
      });
    }
    const vectorDocument = drawingDocument(input.figure);
    const requestId = nextInternalId("figure-add");
    const element: PageVectorInkElement = {
      kind: "vector-ink",
      version: 1,
      id: stableElementId("agent-drawing", requestId),
      frame: vectorInkFrame(page, vectorDocument, input.placement === undefined ? undefined : frameFromPlacement(page, input.placement)),
      document: vectorDocument,
      label: input.figure.label,
      description: input.figure.description ?? input.figure.label,
    };
    const withDrawing = addElement(page, element, createIsoInstant(new Date().toISOString()));
    nextDocument = validatePageDocument({
      ...nextDocument,
      pages: nextDocument.pages.map((candidate) => candidate.id === page.id ? withDrawing : candidate),
    });
    const committed = await this.pageStorage.commit({
      workbookId: notebook.id,
      nextDocument,
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: page.number <= document.pages.length ? { [page.id]: document.pages[page.number - 1]!.revision } : {},
      mutationId: createMutationId(requestId),
      actorId: createActorId("assistant:notebook-kernel"),
      source: "assistant",
      kind: "notebook_figure_add",
    });
    this.trackReceipt({ receipt: committed.receipt, notebook, request: "figure.add", pages: [pageNumber] });
    await this.openNotebook(notebook, pageNumber);
    return success("notebook_apply", `Added ${input.figure.label} to ${notebook.title}, page ${pageNumber}.`, {
      change: "figure.add", figure: input.figure.kind, notebook: { id: notebook.id, title: notebook.title }, page: pageNumber, undo: "available",
    });
  }

  private async traceFigure(input: Extract<NotebookApplyInput, { kind: "figure.trace" }>): Promise<NotebookKernelResult> {
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    const notebook = await this.targetNotebook(input.notebook);
    const document = await this.documentFor(notebook.id);
    let pageNumber = input.page ?? this.focusedPageNumber(notebook.id, document);
    let nextDocument = document;
    let page = this.assertPage(document, pageNumber, notebook.title);
    const normalizedTarget = input.replaceTarget?.trim().toLocaleLowerCase();
    const replacementMatches = normalizedTarget === undefined
      ? []
      : page.elements.filter((element) => element.label.trim().toLocaleLowerCase() === normalizedTarget);
    if (replacementMatches.length > 1) throw new NotebookKernelError("AMBIGUOUS_ELEMENT", `More than one element on page ${pageNumber} is labeled "${input.replaceTarget}".`);
    const replacement = replacementMatches[0];
    if (input.replaceTarget !== undefined && replacement === undefined) throw new NotebookKernelError("ELEMENT_NOT_FOUND", `No element on page ${pageNumber} is labeled "${input.replaceTarget}".`);
    if (replacement !== undefined && replacement.kind !== "vector-ink") throw new NotebookKernelError("ELEMENT_NOT_REPLACEABLE", `${replacement.label} is not a page-native drawing or trace.`);
    if (page.elements.length > 0 && input.placement === undefined && replacement === undefined) {
      if (input.page !== undefined) throw new NotebookKernelError("SAFE_PLACEMENT_UNAVAILABLE", `Page ${pageNumber} already contains content. Provide placement or omit page to place the trace on a fresh page.`);
      if (document.pages.length >= MAX_DEMO_PAGES) throw new NotebookKernelError("PAGE_LIMIT", `The demo notebook already has ${MAX_DEMO_PAGES} pages.`);
      const number = document.pages.length + 1;
      const at = createIsoInstant(new Date().toISOString());
      page = {
        version: 1,
        id: stablePageId(document.workbookId, number),
        workbookId: document.workbookId,
        number,
        revision: createPageRevision(1),
        size: document.pages[0]!.size,
        paper: document.pages[0]!.paper ?? "lined",
        elements: [],
        createdAt: at,
        updatedAt: at,
      };
      pageNumber = number;
      nextDocument = validatePageDocument({
        ...document,
        documentRevision: createDocumentRevision(document.documentRevision + 1),
        pageOrder: [...document.pageOrder, page.id],
        pages: [...document.pages, page],
      });
    }
    const vectorDocument = validateVectorInkDocument(input.document);
    const requestId = nextInternalId("figure-trace");
    const elementId = replacement?.id ?? stableElementId("agent-trace", requestId);
    const requestedFrame = input.placement === undefined ? replacement?.frame : frameFromPlacement(page, input.placement);
    const frame = vectorInkFrame(page, vectorDocument, requestedFrame, elementId);
    assertSafeVectorFrame(page, frame, elementId);
    const element: PageVectorInkElement = {
      kind: "vector-ink",
      version: 1,
      id: elementId,
      frame,
      document: vectorDocument,
      label: input.label,
      description: input.description,
      provenance: {
        kind: input.sourceKind,
        sourceLabel: input.sourceLabel,
        ...(input.sourceFormat === undefined ? {} : { sourceFormat: input.sourceFormat }),
        tool: "trace-detailed-art",
        toolVersion: "1",
      },
    };
    const at = createIsoInstant(new Date().toISOString());
    const withTrace = replacement === undefined
      ? addElement(page, element, at)
      : validatePageDocument({
          ...nextDocument,
          pages: nextDocument.pages.map((candidate) => candidate.id === page.id
            ? { ...page, revision: createPageRevision(page.revision + 1), updatedAt: at, elements: page.elements.map((candidateElement) => candidateElement.id === replacement.id ? element : candidateElement) }
            : candidate),
        }).pages.find((candidate) => candidate.id === page.id)!;
    nextDocument = validatePageDocument({
      ...nextDocument,
      pages: nextDocument.pages.map((candidate) => candidate.id === page.id ? withTrace : candidate),
    });
    const committed = await this.pageStorage.commit({
      workbookId: notebook.id,
      nextDocument,
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: page.number <= document.pages.length ? { [page.id]: document.pages[page.number - 1]!.revision } : {},
      mutationId: createMutationId(requestId),
      actorId: createActorId("assistant:notebook-kernel"),
      source: "assistant",
      kind: "notebook_figure_trace",
    });
    this.trackReceipt({ receipt: committed.receipt, notebook, request: "figure.trace", pages: [pageNumber] });
    await this.openNotebook(notebook, pageNumber);
    return success("notebook_apply", `Placed traced figure ${input.label} on ${notebook.title}, page ${pageNumber}.`, {
      change: "figure.trace",
      figure: "vector-ink",
      sourceKind: input.sourceKind,
      replaced: replacement?.label,
      notebook: { id: notebook.id, title: notebook.title },
      page: pageNumber,
      editable: "path-geometry",
      undo: "available",
    });
  }

  private async arrangeElement(input: Extract<NotebookApplyInput, { kind: "layout.arrange" }>): Promise<NotebookKernelResult> {
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    const notebook = await this.targetNotebook(input.notebook);
    const document = await this.documentFor(notebook.id);
    const pageNumber = input.page ?? this.focusedPageNumber(notebook.id, document);
    const page = this.assertPage(document, pageNumber, notebook.title);
    const normalizedTarget = input.target.trim().toLocaleLowerCase();
    const matches = page.elements.filter((element) => element.label.trim().toLocaleLowerCase() === normalizedTarget);
    if (matches.length === 0) {
      throw new NotebookKernelError("ELEMENT_NOT_FOUND", `No element on page ${pageNumber} is labeled "${input.target}".`);
    }
    if (matches.length > 1) {
      throw new NotebookKernelError("AMBIGUOUS_ELEMENT", `More than one element on page ${pageNumber} is labeled "${input.target}".`);
    }
    const element = matches[0]!;
    if (element.kind === "annotation" || element.kind === "embedded-frame") {
      throw new NotebookKernelError("ELEMENT_NOT_ARRANGEABLE", `${element.label} cannot be independently arranged.`);
    }
    const frame = frameFromPlacement(page, input.placement);
    if (element.kind === "diagram") assertSafeDiagramFrame(page, frame, element.id);
    if (element.kind === "vector-ink") assertSafeVectorFrame(page, frame, element.id);
    const requestId = nextInternalId("layout-arrange");
    const at = createIsoInstant(new Date().toISOString());
    const updatedPage = updateElementFrame(page, element.id, frame, at);
    const nextDocument = validatePageDocument({
      ...document,
      pages: document.pages.map((candidate) => candidate.id === page.id ? updatedPage : candidate),
    });
    const committed = await this.pageStorage.commit({
      workbookId: notebook.id,
      nextDocument,
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId(requestId),
      actorId: createActorId("assistant:notebook-kernel"),
      source: "assistant",
      kind: "notebook_layout_arrange",
    });
    this.trackReceipt({ receipt: committed.receipt, notebook, request: "layout.arrange", pages: [pageNumber] });
    await this.openNotebook(notebook, pageNumber);
    return success("notebook_apply", `Arranged ${element.label} on ${notebook.title}, page ${pageNumber}.`, {
      change: "layout.arrange",
      target: element.label,
      notebook: { id: notebook.id, title: notebook.title },
      page: pageNumber,
      placement: input.placement,
      undo: "available",
    });
  }

  private async arrangeDiagramNodes(input: Extract<NotebookApplyInput, { kind: "diagram.arrange" }>): Promise<NotebookKernelResult> {
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    const notebook = await this.targetNotebook(input.notebook);
    const document = await this.documentFor(notebook.id);
    const pageNumber = input.page ?? this.focusedPageNumber(notebook.id, document);
    const page = this.assertPage(document, pageNumber, notebook.title);
    const normalizedTarget = input.target.trim().toLocaleLowerCase();
    const matches = page.elements.filter((element): element is DiagramElement =>
      element.kind === "diagram" && element.label.trim().toLocaleLowerCase() === normalizedTarget);
    if (matches.length === 0) throw new NotebookKernelError("DIAGRAM_NOT_FOUND", `No diagram on page ${pageNumber} is labeled "${input.target}".`);
    if (matches.length > 1) throw new NotebookKernelError("AMBIGUOUS_DIAGRAM", `More than one diagram on page ${pageNumber} is labeled "${input.target}".`);
    const diagram = matches[0]!;
    const requestId = nextInternalId("diagram-arrange");
    const at = createIsoInstant(new Date().toISOString());
    const updatedPage = updateDiagramNodePositions(
      page,
      diagram.id,
      input.nodes.map((node) => ({ id: node.id, position: { x: node.x, y: node.y } })),
      at,
    );
    const nextDocument = validatePageDocument({
      ...document,
      pages: document.pages.map((candidate) => candidate.id === page.id ? updatedPage : candidate),
    });
    const committed = await this.pageStorage.commit({
      workbookId: notebook.id,
      nextDocument,
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId(requestId),
      actorId: createActorId("assistant:notebook-kernel"),
      source: "assistant",
      kind: "notebook_diagram_arrange",
    });
    this.trackReceipt({ receipt: committed.receipt, notebook, request: "diagram.arrange", pages: [pageNumber] });
    await this.openNotebook(notebook, pageNumber);
    return success("notebook_apply", `Rearranged ${input.nodes.length} node${input.nodes.length === 1 ? "" : "s"} in ${diagram.label}.`, {
      change: "diagram.arrange",
      target: diagram.label,
      nodes: input.nodes.map(({ id, x, y }) => ({ id, x, y })),
      notebook: { id: notebook.id, title: notebook.title },
      page: pageNumber,
      undo: "available",
    });
  }

  private async addPage(input: Extract<NotebookApplyInput, { kind: "page.add" }>): Promise<NotebookKernelResult> {
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The notebook page store is not ready.");
    const notebook = await this.targetNotebook(input.notebook);
    const document = await this.documentFor(notebook.id);
    if (document.pages.length >= MAX_DEMO_PAGES) throw new NotebookKernelError("PAGE_LIMIT", `The demo notebook already has ${MAX_DEMO_PAGES} pages.`);
    const template = document.pages[0]!;
    const pageNumber = document.pages.length + 1;
    const at = createIsoInstant(new Date().toISOString());
    const page: PageRecord = {
      version: 1,
      id: stablePageId(document.workbookId, pageNumber),
      workbookId: document.workbookId,
      number: pageNumber,
      revision: createPageRevision(1),
      size: template.size,
      paper: template.paper ?? "lined",
      elements: [],
      createdAt: at,
      updatedAt: at,
    };
    const nextDocument = validatePageDocument({
      ...document,
      documentRevision: createDocumentRevision(document.documentRevision + 1),
      pageOrder: [...document.pageOrder, page.id],
      pages: [...document.pages, page],
    });
    const requestId = nextInternalId("page-add");
    const committed = await this.pageStorage.commit({
      workbookId: notebook.id,
      nextDocument,
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: {},
      mutationId: createMutationId(requestId),
      actorId: createActorId("assistant:notebook-kernel"),
      source: "assistant",
      kind: "notebook_page_add",
    });
    this.trackReceipt({ receipt: committed.receipt, notebook, request: "page.add", pages: [pageNumber] });
    await this.openNotebook(notebook, pageNumber);
    return success("notebook_apply", `Added and opened page ${pageNumber} in ${notebook.title}.`, {
      change: "page.add",
      notebook: { id: notebook.id, title: notebook.title },
      page: pageNumber,
      pageCount: nextDocument.pages.length,
      undo: "available",
    });
  }

  private async undoLatest(): Promise<NotebookKernelResult> {
    const tracked = this.receipts.at(-1);
    if (tracked === undefined) throw new NotebookKernelError("NOTHING_TO_UNDO", "There is no recent agent change to undo.");
    await this.openNotebook(tracked.notebook, tracked.pages[0] ?? 1);
    const registry = await this.registryFor(tracked.notebook.id);
    await registry.refresh();
    registry.setViewContext({ presentation: "single", visiblePageIds: tracked.receipt.affectedPageIds });
    const committed = await registry.executeExternal("page_undo", {
      mutationId: nextInternalId("undo"),
      receiptId: tracked.receipt.id,
    }, "webmcp");
    if (committed.outcome === "error") throw new NotebookKernelError(committed.error.code, committed.error.message);
    this.receipts.pop();
    const document = await this.documentFor(tracked.notebook.id);
    const page = Math.min(tracked.pages[0] ?? 1, document.pages.length);
    await this.openNotebook(tracked.notebook, page);
    await this.focusNotebookPage(tracked.notebook.id, page);
    return success("notebook_apply", `Undid the latest ${tracked.request} change in ${tracked.notebook.title}.`, {
      change: "undo", notebook: { id: tracked.notebook.id, title: tracked.notebook.title }, pages: tracked.pages,
    });
  }

  private trackReceipt(tracked: TrackedReceipt): void {
    this.receipts.push(tracked);
    if (this.receipts.length > MAX_RECEIPTS) this.receipts.splice(0, this.receipts.length - MAX_RECEIPTS);
  }

  private async openNotebook(notebook: NotebookCoverViewModel, page: number): Promise<void> {
    if (currentCover(this.controller)?.id !== notebook.id) {
      const opened = await this.controller.openNotebook(notebook.id);
      if (!opened.ok) throw new NotebookKernelError("NOTEBOOK_OPEN_FAILED", opened.issue.message);
    }
    await this.focusNotebookPage(notebook.id, page);
  }

  private async focusNotebookPage(notebookId: NotebookId, pageNumber: number): Promise<void> {
    if (this.active?.notebookId === notebookId) {
      await this.active.registry.refresh();
      const page = this.active.registry.getDocument().pages[pageNumber - 1];
      if (page !== undefined) this.active.registry.focusPage(page.id);
      return;
    }
    this.pendingFocus.set(notebookId, pageNumber);
  }

  private focusedPageNumber(notebookId: NotebookId, document: PageDocument): number {
    if (this.active?.notebookId === notebookId) return this.active.registry.getSnapshot().focusedPageNumber;
    return Math.min(this.pendingFocus.get(notebookId) ?? 1, document.pages.length);
  }

  private assertPage(document: PageDocument, pageNumber: number, notebookTitle: string): PageRecord {
    const page = document.pages[pageNumber - 1];
    if (page === undefined) throw new NotebookKernelError("PAGE_NOT_FOUND", `${notebookTitle} has no page ${pageNumber}.`);
    return page;
  }

  private async registryFor(notebookId: NotebookId): Promise<PageCommandRegistry> {
    if (this.active?.notebookId === notebookId) return this.active.registry;
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The requested notebook page session is not active yet.");
    return PageCommandRegistry.open(this.pageStorage, notebookId);
  }

  private async documentFor(notebookId: NotebookId): Promise<PageDocument> {
    if (this.active?.notebookId === notebookId) {
      await this.active.registry.refresh();
      return this.active.registry.getDocument();
    }
    if (this.pageStorage === undefined) throw new NotebookKernelError("PAGE_SESSION_UNAVAILABLE", "The requested notebook page session is not active yet.");
    return this.pageStorage.read(notebookId);
  }
}

export function createDemoNotebookKernel(controller: WorkspaceController, pageStorage?: PageStorage): DemoNotebookKernel {
  return new DemoNotebookKernel(controller, pageStorage);
}
