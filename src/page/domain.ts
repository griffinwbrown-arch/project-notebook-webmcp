import { z } from "zod";

import {
  createIsoInstant,
  createNotebookId,
  type IsoInstant,
  type JsonValue,
  type NotebookId,
} from "../domain";
import {
  validateVectorInkDocument,
  validateVectorInkProvenance,
  type VectorInkDocument,
  type VectorInkProvenance,
} from "./vector-ink";
import {
  validateVectorInkReplacementHistory,
  type VectorInkReplacementRecord,
} from "./vector-ink-replacement";
import type { DiagramTemplateInput } from "./diagram-templates";

export type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type WorkbookId = NotebookId;
export type PageId = Brand<string, "PageId">;
export type ElementId = Brand<string, "ElementId">;
export type TextBlockId = Brand<string, "TextBlockId">;
export type ActorId = Brand<string, "ActorId">;
export type MutationId = Brand<string, "MutationId">;
export type PageReceiptId = Brand<string, "PageReceiptId">;
export type PageScrapId = Brand<string, "PageScrapId">;
export type PageRevision = Brand<number, "PageRevision">;
export type DocumentRevision = Brand<number, "DocumentRevision">;

export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
export type PagePaper = "lined" | "grid" | "blank";
export type PageSizePreset = "letter" | "a4";
export const PAGE_SIZE_PRESETS: Readonly<Record<PageSizePreset, Readonly<{ width: number; height: number }>>> = {
  letter: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
  a4: { width: 794, height: 1123 },
};
export const PAGE_CONTENT_RECT = {
  x: 72,
  y: 64,
  width: 672,
  height: 928,
} as const;
export const DIAGRAM_MIN_FRAME = { width: 320, height: 240 } as const;
export const MIN_TEXT_WIDTH = 160;
export const MIN_TEXT_HEIGHT = 32;

export type PageRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RichTextMark = "bold" | "italic" | "underline" | "code";
export type RichTextRun = Readonly<{
  text: string;
  marks: readonly RichTextMark[];
}>;
export type StructuredTextBlock = Readonly<{
  id: TextBlockId;
  kind: "paragraph" | "heading" | "quote" | "bullet-list-item" | "ordered-list-item";
  runs: readonly RichTextRun[];
}>;
export type RichTextBlock = StructuredTextBlock;
export type RichText = Readonly<{
  format: "rich_text";
  blocks: readonly RichTextBlock[];
}>;
export type StrokePoint = Readonly<{
  x: number;
  y: number;
  pressure?: number;
}>;

export type ElementProvenance = Readonly<{
  source: "phase2-note" | "phase2-canvas";
  sourceId: string;
}>;

type ElementBase = Readonly<{
  id: ElementId;
  label: string;
  frame: PageRect;
  keepHere?: boolean;
  provenance?: ElementProvenance | VectorInkProvenance;
}>;

export type TextElement = ElementBase & Readonly<{
  kind: "text";
  content: RichText;
}>;
export type StrokeElement = ElementBase & Readonly<{
  kind: "stroke";
  points: readonly StrokePoint[];
  color: string;
  width: number;
}>;
export type ShapeElement = ElementBase & Readonly<{
  kind: "shape";
  shape: "rectangle" | "ellipse" | "arrow";
  fill: string | null;
  stroke: string;
}>;
export type AnnotationAnchor =
  | Readonly<{
      kind: "text-range";
      elementId: ElementId;
      blockId: TextBlockId;
      start: number;
      end: number;
    }>
  | Readonly<{ kind: "element"; elementId: ElementId }>;
export type AnnotationElement = ElementBase & Readonly<{
  kind: "annotation";
  annotation: "highlight" | "circle" | "arrow" | "label";
  anchor: AnnotationAnchor;
  /** Present on new arrows. Omitted only for persisted legacy arrows. */
  sourceElementId?: ElementId;
  reviewKind?: "explanation" | "replacement";
  text?: string;
}>;
export type EmbeddedFrameElement = ElementBase & Readonly<{
  kind: "embedded-frame";
  componentType: string;
  componentVersion: number;
  props: JsonValue;
}>;

export type DiagramTemplate = DiagramTemplateInput;
export const DIAGRAM_MAX_NODES = 12;
export const DIAGRAM_MAX_EDGES = 24;
export const DIAGRAM_NODE_ID_MAX_LENGTH = 64;
export const DIAGRAM_NODE_LABEL_MAX_LENGTH = 80;
export const DIAGRAM_EDGE_LABEL_MAX_LENGTH = 60;

export type DiagramLayout = "flow" | "mind-map" | "cycle";
export type DiagramNodeTone = "neutral" | "accent" | "positive" | "warning";
export type DiagramNodePosition = Readonly<{ x: number; y: number }>;
export type DiagramNode = Readonly<{
  id: string;
  label: string;
  tone?: DiagramNodeTone;
  position?: DiagramNodePosition;
}>;
export type DiagramEdge = Readonly<{
  from: string;
  to: string;
  label?: string;
}>;
export type DiagramDocument = Readonly<{
  version: 1;
  layout: DiagramLayout;
  nodes: readonly DiagramNode[];
  edges: readonly DiagramEdge[];
}>;
export type DiagramElement = ElementBase & Readonly<{
  kind: "diagram";
  engine: "native";
  engineVersion: 1;
  document: DiagramDocument;
}>;

export type PageVectorInkElement = ElementBase & Readonly<{
  kind: "vector-ink";
  version: 1;
  description: string;
  document: VectorInkDocument;
  provenance?: VectorInkProvenance;
  replacementHistory?: readonly VectorInkReplacementRecord[];
}>;
export type VectorInkElement = PageVectorInkElement;

export type PageElement =
  | TextElement
  | StrokeElement
  | ShapeElement
  | AnnotationElement
  | DiagramElement
  | PageVectorInkElement
  | EmbeddedFrameElement;

export type PageRecord = Readonly<{
  version: 1;
  id: PageId;
  workbookId: WorkbookId;
  number: number;
  revision: PageRevision;
  size: Readonly<{ width: number; height: number }>;
  paper?: PagePaper;
  elements: readonly PageElement[];
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}>;

export type PageDocument = Readonly<{
  version: 1;
  workbookId: WorkbookId;
  documentRevision: DocumentRevision;
  pageOrder: readonly PageId[];
  pages: readonly PageRecord[];
}>;

export type PageSelector =
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "page"; pageId: PageId }>
  | Readonly<{ kind: "number"; pageNumber: number }>
  | Readonly<{ kind: "phrase"; value: string }>;

export type PageCandidate = Readonly<{
  pageId: PageId;
  pageNumber: number;
  preview: string;
  revision: PageRevision;
}>;

export type PageTargetResolution =
  | Readonly<{ status: "resolved"; page: PageRecord }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "ambiguous"; candidates: readonly PageCandidate[] }>;

export class PageDomainError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_PAGE"
      | "ELEMENT_NOT_FOUND"
      | "AMBIGUOUS_TARGET"
      | "LAYOUT_VIOLATION",
    message: string,
  ) {
    super(message);
    this.name = "PageDomainError";
  }
}

const IdentifierSchema = z.string().trim().min(1);
const PositiveRevisionSchema = z.number().int().safe().positive();

function identifier<Name extends string>(value: string, name: Name): Brand<string, Name> {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new PageDomainError("INVALID_PAGE", `${name} must not be empty.`);
  }
  return parsed.data as Brand<string, Name>;
}

export const createPageId = (value: string): PageId => identifier(value, "PageId");
export const createElementId = (value: string): ElementId => identifier(value, "ElementId");
export const createTextBlockId = (value: string): TextBlockId => identifier(value, "TextBlockId");
export const createActorId = (value: string): ActorId => identifier(value, "ActorId");
export const createMutationId = (value: string): MutationId => identifier(value, "MutationId");
export const createPageReceiptId = (value: string): PageReceiptId => identifier(value, "PageReceiptId");
export const createPageScrapId = (value: string): PageScrapId => identifier(value, "PageScrapId");

export function createPageRevision(value: number): PageRevision {
  return PositiveRevisionSchema.parse(value) as PageRevision;
}

export function createDocumentRevision(value: number): DocumentRevision {
  return PositiveRevisionSchema.parse(value) as DocumentRevision;
}

export function stablePageId(workbookId: WorkbookId, number: number): PageId {
  return createPageId(`phase3:${workbookId}:page:${number}`);
}

export function stableElementId(kind: string, sourceId: string): ElementId {
  return createElementId(`phase3:${kind}:${sourceId}`);
}

export function stableBlockId(sourceId: string): TextBlockId {
  return createTextBlockId(`phase3:block:${sourceId}`);
}

export function richTextFromPlainText(
  text: string,
  blockId: TextBlockId,
  kind: RichTextBlock["kind"] = "paragraph",
): RichText {
  return {
    format: "rich_text",
    blocks: [{ id: blockId, kind, runs: [{ text, marks: [] }] }],
  };
}

export function derivePlainText(content: RichText): string {
  return content.blocks
    .map((block) => block.runs.map((run) => run.text).join(""))
    .join("\n");
}

export function derivePagePlainText(page: PageRecord): string {
  return page.elements
    .filter((element): element is TextElement => element.kind === "text")
    .map((element) => derivePlainText(element.content))
    .join("\n")
    .trim();
}

export function createEmptyPage(
  workbookId: WorkbookId,
  number: number,
  at: IsoInstant,
  presentation: Readonly<{ paper?: PagePaper; size?: Readonly<{ width: number; height: number }> }> = {},
): PageRecord {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new PageDomainError("INVALID_PAGE", "Page number must be a positive integer.");
  }
  return {
    version: 1,
    id: stablePageId(workbookId, number),
    workbookId: createNotebookId(workbookId),
    number,
    revision: createPageRevision(1),
    size: presentation.size ?? PAGE_SIZE_PRESETS.letter,
    paper: presentation.paper ?? "lined",
    elements: [],
    createdAt: createIsoInstant(at),
    updatedAt: createIsoInstant(at),
  };
}

export function createEmptyPageDocument(
  workbookId: WorkbookId,
  at: IsoInstant,
  presentation: Readonly<{ paper?: PagePaper; size?: Readonly<{ width: number; height: number }> }> = {},
): PageDocument {
  const page = createEmptyPage(workbookId, 1, at, presentation);
  return {
    version: 1,
    workbookId,
    documentRevision: createDocumentRevision(1),
    pageOrder: [page.id],
    pages: [page],
  };
}

function finiteRect(rect: PageRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 && rect.height > 0;
}

export function rectsOverlap(left: PageRect, right: PageRect): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}

export function isInsidePage(
  rect: PageRect,
  size: Readonly<{ width: number; height: number }> = PAGE_SIZE_PRESETS.letter,
): boolean {
  return finiteRect(rect) && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= size.width && rect.y + rect.height <= size.height;
}

function findElement(page: PageRecord, id: ElementId): PageElement {
  const element = page.elements.find((candidate) => candidate.id === id);
  if (element === undefined) {
    throw new PageDomainError("ELEMENT_NOT_FOUND", `Element ${id} was not found.`);
  }
  return element;
}

function validateTextElement(element: TextElement): void {
  if (element.frame.width < MIN_TEXT_WIDTH || element.frame.height < MIN_TEXT_HEIGHT) {
    throw new PageDomainError("LAYOUT_VIOLATION", "Readable text cannot be shrunk below its minimum size.");
  }
  if (element.content.format !== "rich_text") throw new PageDomainError("INVALID_PAGE", "The text format is unsupported.");
  validateStructuredTextBlocks(element.content.blocks);
}

const STRUCTURED_TEXT_KINDS = new Set<StructuredTextBlock["kind"]>([
  "paragraph",
  "heading",
  "quote",
  "bullet-list-item",
  "ordered-list-item",
]);
const STRUCTURED_TEXT_MARKS = new Set<RichTextMark>(["bold", "italic", "underline", "code"]);
const UNSAFE_STRUCTURED_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|<\/?[a-z][^>]*>|\b(?:javascript|data|file):|https?:\/\/|(?:^|\s)(?:[a-z]:[\\/]|\\\\|\/(?:[\w.-]+\/)+)|\b(?:eval|Function)\s*\(|=>\s*\{|\b(?:import|export)\s+(?:\{|\*)/iu;

export function isSafeStructuredTextInput(text: string): boolean {
  return !UNSAFE_STRUCTURED_TEXT.test(text);
}

export function validateStructuredTextBlocks(blocks: readonly StructuredTextBlock[]): readonly StructuredTextBlock[] {
  if (blocks.length === 0 || blocks.length > 128) {
    throw new PageDomainError("INVALID_PAGE", "Structured text needs between 1 and 128 blocks.");
  }
  const ids = new Set<string>();
  let totalTextLength = 0;
  for (const block of blocks) {
    if (!STRUCTURED_TEXT_KINDS.has(block.kind)) throw new PageDomainError("INVALID_PAGE", "The structured text block kind is unsupported.");
    if (block.id.trim().length === 0 || block.id.length > 240 || ids.has(block.id)) {
      throw new PageDomainError("INVALID_PAGE", "Structured text block ids must be unique and bounded.");
    }
    ids.add(block.id);
    if (block.runs.length === 0 || block.runs.length > 256) {
      throw new PageDomainError("INVALID_PAGE", "Each structured text block needs a bounded run set.");
    }
    for (const run of block.runs) {
      totalTextLength += run.text.length;
      if (totalTextLength > 20_000) throw new PageDomainError("INVALID_PAGE", "Structured text is oversized.");
      const marks = new Set<RichTextMark>();
      for (const mark of run.marks) {
        if (!STRUCTURED_TEXT_MARKS.has(mark) || marks.has(mark)) {
          throw new PageDomainError("INVALID_PAGE", "Structured text marks must be supported and unique per run.");
        }
        marks.add(mark);
      }
    }
  }
  if (blocks.at(-1)?.kind === "heading") {
    throw new PageDomainError("LAYOUT_VIOLATION", "A heading must stay with following text.");
  }
  return blocks;
}

function validateAnnotation(page: PageRecord, annotation: AnnotationElement): void {
  const target = findElement(page, annotation.anchor.elementId);
  if (annotation.annotation === "arrow" && annotation.sourceElementId !== undefined) {
    if (annotation.sourceElementId === annotation.anchor.elementId) {
      throw new PageDomainError("INVALID_PAGE", "An arrow must connect two different page elements.");
    }
    findElement(page, annotation.sourceElementId);
  }
  if (annotation.anchor.kind === "text-range") {
    const anchor = annotation.anchor;
    if (target.kind !== "text") {
      throw new PageDomainError("INVALID_PAGE", "A text-range annotation must target text.");
    }
    const block = target.content.blocks.find((candidate) => candidate.id === anchor.blockId);
    if (block === undefined) {
      throw new PageDomainError("INVALID_PAGE", "The annotation text block was not found.");
    }
    const length = block.runs.reduce((total, run) => total + run.text.length, 0);
    if (anchor.start < 0 || anchor.end <= anchor.start || anchor.end > length) {
      throw new PageDomainError("INVALID_PAGE", "The annotation text range is invalid.");
    }
  }
  if (annotation.reviewKind !== undefined) {
    if (annotation.annotation !== "label" || annotation.text === undefined || annotation.text.trim().length === 0) {
      throw new PageDomainError("INVALID_PAGE", "A review callout needs visible text and a label relationship.");
    }
    const scale = page.size.width / PAGE_WIDTH;
    const contentRect: PageRect = {
      x: PAGE_CONTENT_RECT.x * scale,
      y: PAGE_CONTENT_RECT.y * scale,
      width: page.size.width - PAGE_CONTENT_RECT.x * scale * 2,
      height: page.size.height - PAGE_CONTENT_RECT.y * scale * 2,
    };
    if (annotation.frame.width < 160 || annotation.frame.height < 64 ||
      annotation.frame.x < contentRect.x || annotation.frame.y < contentRect.y ||
      annotation.frame.x + annotation.frame.width > contentRect.x + contentRect.width ||
      annotation.frame.y + annotation.frame.height > contentRect.y + contentRect.height) {
      throw new PageDomainError("LAYOUT_VIOLATION", "A review callout must remain readable inside the page content area.");
    }
    const collision = page.elements.some((candidate) =>
      candidate.id !== annotation.id &&
      (candidate.kind !== "annotation" || candidate.reviewKind !== undefined) &&
      rectsOverlap(annotation.frame, candidate.frame),
    );
    if (collision) {
      throw new PageDomainError("LAYOUT_VIOLATION", "A review callout cannot cover page content.");
    }
  }
}

type UnknownRecord = Readonly<Record<string, unknown>>;

function unknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactString(value: unknown, maximum = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function exactOptionalString(value: unknown, maximum = 500): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maximum);
}

function isFinitePageRect(value: unknown): value is PageRect {
  return unknownRecord(value) && hasOnlyKeys(value, new Set(["x", "y", "width", "height"])) &&
    typeof value.x === "number" && typeof value.y === "number" && typeof value.width === "number" && typeof value.height === "number" &&
    finiteRect({ x: value.x, y: value.y, width: value.width, height: value.height });
}

function isElementProvenance(value: unknown): value is ElementProvenance {
  return unknownRecord(value) && hasOnlyKeys(value, new Set(["source", "sourceId"])) &&
    (value.source === "phase2-note" || value.source === "phase2-canvas") && exactString(value.sourceId, 500);
}

function isVectorProvenance(value: unknown): value is VectorInkProvenance {
  try {
    validateVectorInkProvenance(value as VectorInkProvenance);
    return true;
  } catch {
    return false;
  }
}

function hasElementBase(value: UnknownRecord): boolean {
  return exactString(value.id, 500) && exactString(value.label, 500) && isFinitePageRect(value.frame) &&
    (value.keepHere === undefined || typeof value.keepHere === "boolean") &&
    (value.provenance === undefined || isElementProvenance(value.provenance) || isVectorProvenance(value.provenance));
}

function isStructuredTextRun(value: unknown): value is RichTextRun {
  return unknownRecord(value) && hasOnlyKeys(value, new Set(["text", "marks"])) && typeof value.text === "string" &&
    Array.isArray(value.marks) && value.marks.every((mark) => typeof mark === "string" && STRUCTURED_TEXT_MARKS.has(mark as RichTextMark));
}

function parseStructuredTextBlock(value: unknown): StructuredTextBlock {
  if (!unknownRecord(value) || !hasOnlyKeys(value, new Set(["id", "kind", "runs"])) ||
    !exactString(value.id, 240) || typeof value.kind !== "string" || !STRUCTURED_TEXT_KINDS.has(value.kind as StructuredTextBlock["kind"]) ||
    !Array.isArray(value.runs) || !value.runs.every(isStructuredTextRun)) {
    throw new PageDomainError("INVALID_PAGE", "A persisted structured text block is malformed.");
  }
  return {
    id: createTextBlockId(value.id),
    kind: value.kind as StructuredTextBlock["kind"],
    runs: value.runs.map((run) => ({ text: run.text, marks: [...run.marks] })),
  };
}

function isStrokePoint(value: unknown): value is StrokePoint {
  return unknownRecord(value) && hasOnlyKeys(value, new Set(["x", "y", "pressure"])) &&
    typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y) &&
    (value.pressure === undefined || (typeof value.pressure === "number" && Number.isFinite(value.pressure)));
}

function isAnnotationAnchor(value: unknown): value is AnnotationAnchor {
  if (!unknownRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "element") {
    return hasOnlyKeys(value, new Set(["kind", "elementId"])) && exactString(value.elementId, 500);
  }
  return value.kind === "text-range" && hasOnlyKeys(value, new Set(["kind", "elementId", "blockId", "start", "end"])) &&
    exactString(value.elementId, 500) && exactString(value.blockId, 240) && Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 2_048 && value.every((item) => isJsonValue(item, depth + 1));
  if (!unknownRecord(value) || Object.keys(value).length > 2_048) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

const DIAGRAM_LAYOUTS = ["flow", "mind-map", "cycle"] as const;
const DIAGRAM_NODE_TONES = ["neutral", "accent", "positive", "warning"] as const;
const UNSAFE_DIAGRAM_TEXT = /[\u0000-\u001F\u007F]|<\/?[a-z][^>]*>|\b(?:https?|data|javascript|file):|\bwww\./iu;
const DiagramNodeIdSchema = z.string()
  .min(1)
  .max(DIAGRAM_NODE_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/u)
  .refine((value) => value.trim() === value);

function diagramTextSchema(maximum: number): z.ZodString {
  return z.string()
    .min(1)
    .max(maximum)
    .refine((value) => value.trim() === value && !UNSAFE_DIAGRAM_TEXT.test(value));
}

const DiagramNodeSchema = z.strictObject({
  id: DiagramNodeIdSchema,
  label: diagramTextSchema(DIAGRAM_NODE_LABEL_MAX_LENGTH),
  tone: z.enum(DIAGRAM_NODE_TONES).optional(),
  position: z.strictObject({
    x: z.number().finite().min(0).max(100),
    y: z.number().finite().min(0).max(100),
  }).optional(),
});
const DiagramEdgeSchema = z.strictObject({
  from: DiagramNodeIdSchema,
  to: DiagramNodeIdSchema,
  label: diagramTextSchema(DIAGRAM_EDGE_LABEL_MAX_LENGTH).optional(),
});
const DiagramDocumentSchema = z.strictObject({
  version: z.literal(1),
  layout: z.enum(DIAGRAM_LAYOUTS),
  nodes: z.array(DiagramNodeSchema).min(1).max(DIAGRAM_MAX_NODES),
  edges: z.array(DiagramEdgeSchema).max(DIAGRAM_MAX_EDGES),
}).superRefine((document, context) => {
  const nodeIds = new Set<string>();
  for (const [index, node] of document.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      context.addIssue({
        code: "custom",
        message: "Diagram node ids must be unique.",
        path: ["nodes", index, "id"],
      });
    }
    nodeIds.add(node.id);
  }

  const connections = new Set<string>();
  for (const [index, edge] of document.edges.entries()) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      context.addIssue({
        code: "custom",
        message: "Diagram edges must reference existing nodes.",
        path: ["edges", index],
      });
    }
    if (edge.from === edge.to) {
      context.addIssue({
        code: "custom",
        message: "Diagram edges must connect different nodes.",
        path: ["edges", index],
      });
    }
    const connection = `${edge.from}\u0000${edge.to}`;
    if (connections.has(connection)) {
      context.addIssue({
        code: "custom",
        message: "Diagram edges must be unique.",
        path: ["edges", index],
      });
    }
    connections.add(connection);
  }
});

export function validateDiagramDocument(value: unknown): DiagramDocument {
  const result = DiagramDocumentSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0]?.message ?? "The diagram document is malformed.";
    throw new PageDomainError("INVALID_PAGE", issue);
  }
  return {
    version: 1,
    layout: result.data.layout,
    nodes: result.data.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      ...(node.tone === undefined ? {} : { tone: node.tone }),
      ...(node.position === undefined ? {} : { position: node.position }),
    })),
    edges: result.data.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      ...(edge.label === undefined ? {} : { label: edge.label }),
    })),
  };
}

const ELEMENT_BASE_KEYS = ["kind", "id", "label", "frame", "keepHere", "provenance"] as const;

export function parsePageElement(value: unknown): PageElement {
  if (!unknownRecord(value) || typeof value.kind !== "string" || !hasElementBase(value)) {
    throw new PageDomainError("INVALID_PAGE", "A persisted page element is malformed.");
  }
  const keysFor = (...variant: readonly string[]): ReadonlySet<string> => new Set([...ELEMENT_BASE_KEYS, ...variant]);
  if (value.kind === "text") {
    if (!hasOnlyKeys(value, keysFor("content")) || !unknownRecord(value.content) ||
      !hasOnlyKeys(value.content, new Set(["format", "blocks"])) || value.content.format !== "rich_text" || !Array.isArray(value.content.blocks)) {
      throw new PageDomainError("INVALID_PAGE", "A persisted text element is malformed.");
    }
    const blocks = value.content.blocks.map(parseStructuredTextBlock);
    validateStructuredTextBlocks(blocks);
    return {
      kind: "text",
      id: createElementId(value.id as string),
      label: value.label as string,
      frame: value.frame as PageRect,
      ...(value.keepHere === undefined ? {} : { keepHere: value.keepHere as boolean }),
      ...(value.provenance === undefined ? {} : { provenance: value.provenance as ElementProvenance | VectorInkProvenance }),
      content: { format: "rich_text", blocks },
    };
  }
  if (value.kind === "stroke") {
    if (!hasOnlyKeys(value, keysFor("points", "color", "width")) || !Array.isArray(value.points) || !value.points.every(isStrokePoint) ||
      !exactString(value.color, 100) || typeof value.width !== "number" || !Number.isFinite(value.width) || value.width <= 0) {
      throw new PageDomainError("INVALID_PAGE", "A persisted stroke element is malformed.");
    }
    return value as StrokeElement;
  }
  if (value.kind === "shape") {
    if (!hasOnlyKeys(value, keysFor("shape", "fill", "stroke")) || !["rectangle", "ellipse", "arrow"].includes(String(value.shape)) ||
      !(value.fill === null || typeof value.fill === "string") || !exactString(value.stroke, 100)) {
      throw new PageDomainError("INVALID_PAGE", "A persisted shape element is malformed.");
    }
    return value as ShapeElement;
  }
  if (value.kind === "annotation") {
    if (!hasOnlyKeys(value, keysFor("annotation", "anchor", "sourceElementId", "reviewKind", "text")) ||
      !["highlight", "circle", "arrow", "label"].includes(String(value.annotation)) || !isAnnotationAnchor(value.anchor) ||
      !exactOptionalString(value.sourceElementId, 500) || (value.reviewKind !== undefined && value.reviewKind !== "explanation" && value.reviewKind !== "replacement") ||
      !exactOptionalString(value.text, 20_000)) {
      throw new PageDomainError("INVALID_PAGE", "A persisted annotation element is malformed.");
    }
    return value as AnnotationElement;
  }
  if (value.kind === "embedded-frame") {
    if (!hasOnlyKeys(value, keysFor("componentType", "componentVersion", "props")) || !exactString(value.componentType, 120) ||
      !Number.isSafeInteger(value.componentVersion) || Number(value.componentVersion) < 1 || !isJsonValue(value.props)) {
      throw new PageDomainError("INVALID_PAGE", "A persisted embedded frame is malformed.");
    }
    return value as EmbeddedFrameElement;
  }
  if (value.kind === "diagram") {
    if (!hasOnlyKeys(value, keysFor("engine", "engineVersion", "document")) || value.engine !== "native" || value.engineVersion !== 1) {
      throw new PageDomainError("INVALID_PAGE", "A persisted diagram is malformed.");
    }
    validateDiagramDocument(value.document);
    return value as DiagramElement;
  }
  if (value.kind === "vector-ink") {
    if (!hasOnlyKeys(value, keysFor("version", "description", "document", "replacementHistory")) || value.version !== 1 ||
      !exactString(value.description, 500) || !Array.isArray(value.replacementHistory ?? [])) {
      throw new PageDomainError("INVALID_PAGE", "A persisted vector ink element is malformed.");
    }
    try {
      validateVectorInkDocument(value.document as VectorInkDocument);
      if (value.replacementHistory !== undefined) validateVectorInkReplacementHistory(value.replacementHistory as readonly VectorInkReplacementRecord[]);
    } catch (error) {
      throw new PageDomainError("INVALID_PAGE", error instanceof Error ? error.message : "A persisted vector ink element is malformed.");
    }
    return value as PageVectorInkElement;
  }
  throw new PageDomainError("INVALID_PAGE", `The persisted page element kind ${value.kind} is unsupported.`);
}

export function parsePageElements(value: unknown): readonly PageElement[] {
  if (!Array.isArray(value) || value.length > 1_024) throw new PageDomainError("INVALID_PAGE", "The persisted page element set is malformed or oversized.");
  return value.map(parsePageElement);
}

export function diagramMinimumFrame(page: Pick<PageRecord, "size">): Readonly<{ width: number; height: number }> {
  return {
    width: DIAGRAM_MIN_FRAME.width * (page.size.width / PAGE_WIDTH),
    height: DIAGRAM_MIN_FRAME.height * (page.size.height / PAGE_HEIGHT),
  };
}

function validateDiagram(page: PageRecord, element: DiagramElement): void {
  if (element.engine !== "native" || element.engineVersion !== 1) {
    throw new PageDomainError("INVALID_PAGE", "The diagram engine or version is unsupported.");
  }
  const minimum = diagramMinimumFrame(page);
  if (element.frame.width < minimum.width - 1e-6 || element.frame.height < minimum.height - 1e-6) {
    throw new PageDomainError("LAYOUT_VIOLATION", "A diagram section must remain large enough to edit.");
  }
  validateDiagramDocument(element.document);
}

function validateVectorInkElement(element: PageVectorInkElement): void {
  if (element.version !== 1) {
    throw new PageDomainError("INVALID_PAGE", "The vector ink version is unsupported.");
  }
  if (element.frame.width < 96 || element.frame.height < 48) {
    throw new PageDomainError("LAYOUT_VIOLATION", "A vector ink figure must remain at least 96 by 48.");
  }
  if (element.description.trim().length === 0 || element.description.length > 500) {
    throw new PageDomainError("INVALID_PAGE", "A vector ink figure needs a bounded description.");
  }
  try {
    validateVectorInkDocument(element.document);
    if (element.provenance !== undefined) validateVectorInkProvenance(element.provenance);
    if (element.replacementHistory !== undefined) validateVectorInkReplacementHistory(element.replacementHistory);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The vector ink document is invalid.";
    throw new PageDomainError("INVALID_PAGE", message);
  }
}

export function validatePage(page: PageRecord): PageRecord {
  const supportedSize = Object.values(PAGE_SIZE_PRESETS).some((size) =>
    size.width === page.size.width && size.height === page.size.height);
  if (page.version !== 1 || !supportedSize || (page.paper !== undefined && !["lined", "grid", "blank"].includes(page.paper))) {
    throw new PageDomainError("INVALID_PAGE", "The page format or size is unsupported.");
  }
  const ids = new Set<string>();
  const vectorInkCount = page.elements.filter((element) => element.kind === "vector-ink").length;
  if (vectorInkCount > 24) {
    throw new PageDomainError("LAYOUT_VIOLATION", "A page cannot contain more than 24 vector ink figures.");
  }
  for (const element of page.elements) {
    if (ids.has(element.id)) {
      throw new PageDomainError("INVALID_PAGE", "Element ids must be unique within a page.");
    }
    ids.add(element.id);
    if (!isInsidePage(element.frame, page.size)) {
      throw new PageDomainError("LAYOUT_VIOLATION", "Elements must remain inside the finite page.");
    }
    if (element.kind === "text") {
      validateTextElement(element);
    }
    if (element.kind === "stroke" && element.points.length < 2) {
      throw new PageDomainError("INVALID_PAGE", "A stroke needs at least two points.");
    }
    if (element.kind === "diagram") validateDiagram(page, element);
    if (element.kind === "vector-ink") validateVectorInkElement(element);
  }
  for (const element of page.elements) {
    if (element.kind === "annotation") {
      validateAnnotation(page, element);
      continue;
    }
    if (element.kind === "vector-ink") {
      const collision = page.elements.some(
        (candidate) => candidate.id !== element.id && candidate.kind !== "annotation" && rectsOverlap(element.frame, candidate.frame),
      );
      if (collision) {
        throw new PageDomainError("LAYOUT_VIOLATION", "Vector ink cannot overlap non-annotation page content.");
      }
      continue;
    }
    if (element.kind !== "text" && element.kind !== "stroke") {
      const collision = page.elements.some(
        (candidate) => candidate.kind === "text" && rectsOverlap(element.frame, candidate.frame),
      );
      if (collision) {
        throw new PageDomainError("LAYOUT_VIOLATION", "Placed elements cannot obscure readable text.");
      }
    }
  }
  const readableText = page.elements.filter(
    (element): element is TextElement => element.kind === "text",
  );
  for (let index = 0; index < readableText.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < readableText.length; nextIndex += 1) {
      if (rectsOverlap(readableText[index]!.frame, readableText[nextIndex]!.frame)) {
        throw new PageDomainError("LAYOUT_VIOLATION", "Readable text elements must not overlap.");
      }
    }
  }
  return page;
}

export function validatePageDocument(document: PageDocument): PageDocument {
  if (document.pageOrder.length === 0 || document.pages.length !== document.pageOrder.length) {
    throw new PageDomainError("INVALID_PAGE", "A workbook must contain a finite ordered page set.");
  }
  const pageIds = new Set(document.pages.map((page) => page.id));
  if (pageIds.size !== document.pages.length || document.pageOrder.some((id, index) => !pageIds.has(id) || id !== document.pages[index]?.id)) {
    throw new PageDomainError("INVALID_PAGE", "Page order must name each page exactly once.");
  }
  document.pages.forEach((page, index) => {
    if (page.workbookId !== document.workbookId || page.number !== index + 1) {
      throw new PageDomainError("INVALID_PAGE", "Page identity and order must remain stable.");
    }
    validatePage(page);
  });
  return document;
}

export function resolvePageTarget(
  document: PageDocument,
  selector: PageSelector,
  currentPageId?: PageId,
): PageTargetResolution {
  let matches: readonly PageRecord[];
  if (selector.kind === "current") {
    const current = document.pages.find((page) => page.id === currentPageId) ?? document.pages[0];
    return current === undefined ? { status: "not_found" } : { status: "resolved", page: current };
  }
  if (selector.kind === "page") {
    matches = document.pages.filter((page) => page.id === selector.pageId);
  } else if (selector.kind === "number") {
    matches = document.pages.filter((page) => page.number === selector.pageNumber);
  } else {
    const phrase = selector.value.trim().toLocaleLowerCase();
    matches = phrase.length === 0 ? [] : document.pages.filter((page) =>
      derivePagePlainText(page).toLocaleLowerCase().includes(phrase) ||
      page.elements.some((element) => element.label.toLocaleLowerCase() === phrase),
    );
  }
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length === 1) return { status: "resolved", page: matches[0]! };
  return {
    status: "ambiguous",
    candidates: matches.map((page) => ({
      pageId: page.id,
      pageNumber: page.number,
      preview: derivePagePlainText(page).slice(0, 120),
      revision: page.revision,
    })),
  };
}

export function replacePage(document: PageDocument, nextPage: PageRecord): PageDocument {
  validatePage(nextPage);
  const index = document.pages.findIndex((page) => page.id === nextPage.id);
  if (index < 0) throw new PageDomainError("INVALID_PAGE", "The page does not belong to the workbook.");
  const pages = [...document.pages];
  pages[index] = nextPage;
  return validatePageDocument({ ...document, pages });
}

export function addElement(
  page: PageRecord,
  element: PageElement,
  at: IsoInstant,
): PageRecord {
  const next = {
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: [...page.elements, element],
    updatedAt: createIsoInstant(at),
  };
  return validatePage(next);
}

export function setStructuredText(
  page: PageRecord,
  elementId: ElementId,
  blocks: readonly StructuredTextBlock[],
  at: IsoInstant,
): PageRecord {
  const element = findElement(page, elementId);
  if (element.kind !== "text") throw new PageDomainError("INVALID_PAGE", "Structured text can update only a text element.");
  const validatedBlocks = validateStructuredTextBlocks(blocks);
  const nextElement: TextElement = {
    ...element,
    content: {
      format: "rich_text",
      blocks: validatedBlocks.map((block) => ({
        id: createTextBlockId(block.id),
        kind: block.kind,
        runs: block.runs.map((run) => ({ text: run.text, marks: [...run.marks] })),
      })),
    },
  };
  return validatePage({
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: page.elements.map((candidate) => candidate.id === elementId ? nextElement : candidate),
    updatedAt: createIsoInstant(at),
  });
}

export function updateElementFrame(
  page: PageRecord,
  elementId: ElementId,
  frame: PageRect,
  at: IsoInstant,
): PageRecord {
  const element = findElement(page, elementId);
  const nextElement: PageElement = element.kind === "stroke"
    ? {
        ...element,
        frame,
        points: element.points.map((point) => ({
          ...point,
          x: frame.x + (point.x - element.frame.x) * (frame.width / element.frame.width),
          y: frame.y + (point.y - element.frame.y) * (frame.height / element.frame.height),
        })),
      }
    : { ...element, frame };
  const next = {
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: page.elements.map((candidate) => candidate.id === elementId ? nextElement : candidate),
    updatedAt: createIsoInstant(at),
  };
  return validatePage(next);
}

export function updateDiagramNodePositions(
  page: PageRecord,
  elementId: ElementId,
  positions: readonly Readonly<{ id: string; position: DiagramNodePosition }>[],
  at: IsoInstant,
): PageRecord {
  const element = findElement(page, elementId);
  if (element.kind !== "diagram") throw new PageDomainError("INVALID_PAGE", "Node positions can update only a diagram element.");
  const updates = new Map(positions.map((entry) => [entry.id, entry.position]));
  if (updates.size !== positions.length) throw new PageDomainError("INVALID_PAGE", "Diagram node position updates must be unique.");
  const knownIds = new Set(element.document.nodes.map((node) => node.id));
  for (const id of updates.keys()) {
    if (!knownIds.has(id)) throw new PageDomainError("ELEMENT_NOT_FOUND", `The diagram node ${id} was not found.`);
  }
  const document = validateDiagramDocument({
    ...element.document,
    nodes: element.document.nodes.map((node) => {
      const position = updates.get(node.id);
      return position === undefined ? node : { ...node, position };
    }),
  });
  return validatePage({
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: page.elements.map((candidate) => candidate.id === elementId ? { ...element, document } : candidate),
    updatedAt: createIsoInstant(at),
  });
}

function flattenRuns(block: RichTextBlock): Array<{ character: string; marks: readonly RichTextMark[] }> {
  // Text ranges are specified in JavaScript's UTF-16 code units. Splitting this way
  // keeps a surrogate pair together under a range such as start=1, end=3.
  return block.runs.flatMap((run) => run.text.split("").map((character) => ({ character, marks: run.marks })));
}

function compactRuns(characters: readonly { character: string; marks: readonly RichTextMark[] }[]): RichTextRun[] {
  const runs: Array<{ text: string; marks: readonly RichTextMark[] }> = [];
  for (const item of characters) {
    const last = runs.at(-1);
    if (last !== undefined && last.marks.join("|") === item.marks.join("|")) {
      last.text += item.character;
    } else {
      runs.push({ text: item.character, marks: [...item.marks] });
    }
  }
  return runs.length === 0 ? [{ text: "", marks: [] }] : runs;
}

export function formatTextRange(
  page: PageRecord,
  elementId: ElementId,
  blockId: TextBlockId,
  start: number,
  end: number,
  marks: readonly RichTextMark[],
  at: IsoInstant,
): PageRecord {
  const element = findElement(page, elementId);
  if (element.kind !== "text") throw new PageDomainError("INVALID_PAGE", "Formatting requires a text element.");
  const blocks = element.content.blocks.map((block) => {
    if (block.id !== blockId) return block;
    const characters = flattenRuns(block);
    if (start < 0 || end <= start || end > characters.length) {
      throw new PageDomainError("INVALID_PAGE", "The formatting range is invalid.");
    }
    return {
      ...block,
      runs: compactRuns(characters.map((item, index) =>
        index >= start && index < end ? { ...item, marks: [...new Set([...item.marks, ...marks])] } : item,
      )),
    };
  });
  if (!blocks.some((block) => block.id === blockId)) {
    throw new PageDomainError("ELEMENT_NOT_FOUND", `Text block ${blockId} was not found.`);
  }
  const nextElement: TextElement = { ...element, content: { format: "rich_text", blocks } };
  return validatePage({
    ...page,
    revision: createPageRevision(page.revision + 1),
    elements: page.elements.map((candidate) => candidate.id === elementId ? nextElement : candidate),
    updatedAt: createIsoInstant(at),
  });
}

export function appendPage(document: PageDocument, at: IsoInstant): PageDocument {
  const base = document.pages[0];
  const page = createEmptyPage(document.workbookId, document.pages.length + 1, at, {
    paper: base?.paper ?? "lined",
    size: base?.size ?? PAGE_SIZE_PRESETS.letter,
  });
  return validatePageDocument({
    ...document,
    documentRevision: createDocumentRevision(document.documentRevision + 1),
    pageOrder: [...document.pageOrder, page.id],
    pages: [...document.pages, page],
  });
}

export function updatePagePresentation(
  page: PageRecord,
  input: Readonly<{ paper?: PagePaper; sizePreset?: PageSizePreset }>,
  at: IsoInstant,
): PageRecord {
  if (input.paper === undefined && input.sizePreset === undefined) {
    throw new PageDomainError("INVALID_PAGE", "Choose a paper style or page size.");
  }
  const size = input.sizePreset === undefined ? page.size : PAGE_SIZE_PRESETS[input.sizePreset];
  const sx = size.width / page.size.width;
  const sy = size.height / page.size.height;
  const scaleFrame = (frame: PageRect): PageRect => ({
    x: frame.x * sx,
    y: frame.y * sy,
    width: frame.width * sx,
    height: frame.height * sy,
  });
  const elements = page.elements.map((element): PageElement => {
    if (element.kind !== "stroke") return { ...element, frame: scaleFrame(element.frame) };
    return {
      ...element,
      frame: scaleFrame(element.frame),
      points: element.points.map((point) => ({
        ...point,
        x: point.x * sx,
        y: point.y * sy,
      })),
    };
  });
  return validatePage({
    ...page,
    revision: createPageRevision(page.revision + 1),
    size,
    paper: input.paper ?? page.paper ?? "lined",
    elements,
    updatedAt: createIsoInstant(at),
  });
}

export type ContinueTextResult = Readonly<{
  document: PageDocument;
  sourcePage: PageRecord;
  destinationPage: PageRecord;
}>;

type TextSplit = Readonly<{
  left: RichTextRun[];
  right: RichTextRun[];
}>;

function splitRunsAtUtf16(
  runs: readonly RichTextRun[],
  splitAt: number,
): TextSplit {
  const left: RichTextRun[] = [];
  const right: RichTextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    if (splitAt <= runStart) {
      right.push({ text: run.text, marks: [...run.marks] });
    } else if (splitAt >= runEnd) {
      left.push({ text: run.text, marks: [...run.marks] });
    } else {
      const localOffset = splitAt - runStart;
      left.push({ text: run.text.slice(0, localOffset), marks: [...run.marks] });
      right.push({ text: run.text.slice(localOffset), marks: [...run.marks] });
    }
  }
  return { left, right };
}

function compactNonEmptyRuns(runs: readonly RichTextRun[]): RichTextRun[] {
  const result: RichTextRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const previous = result.at(-1);
    if (previous && previous.marks.join("|") === run.marks.join("|")) {
      result[result.length - 1] = { ...previous, text: `${previous.text}${run.text}` };
    } else {
      result.push({ text: run.text, marks: [...run.marks] });
    }
  }
  return result.length > 0 ? result : [{ text: "", marks: [] }];
}

export function continueText(
  document: PageDocument,
  pageId: PageId,
  elementId: ElementId,
  blockId: TextBlockId,
  splitAt: number,
  at: IsoInstant,
): ContinueTextResult {
  const source = document.pages.find((page) => page.id === pageId);
  if (source === undefined) throw new PageDomainError("INVALID_PAGE", "The source page was not found.");
  const element = findElement(source, elementId);
  if (element.kind !== "text") throw new PageDomainError("INVALID_PAGE", "Only text can continue to the next page.");
  const block = element.content.blocks.find((candidate) => candidate.id === blockId);
  if (block === undefined) throw new PageDomainError("ELEMENT_NOT_FOUND", "The source text block was not found.");
  if (block.kind === "heading") {
    throw new PageDomainError("LAYOUT_VIOLATION", "A heading is indivisible and cannot be split.");
  }
  const text = block.runs.map((run) => run.text).join("");
  if (splitAt <= 0 || splitAt >= text.length || !/\s/.test(text[splitAt - 1] ?? "")) {
    throw new PageDomainError("LAYOUT_VIOLATION", "Text must continue at a word boundary.");
  }
  const splitRuns = splitRunsAtUtf16(block.runs, splitAt);
  const sourceRuns = compactNonEmptyRuns(splitRuns.left.map((run, index) =>
    index === 0 ? { ...run, text: run.text.trimStart() } : run,
  ).map((run, index, all) => index === all.length - 1 ? { ...run, text: run.text.trimEnd() } : run));
  const destinationRuns = compactNonEmptyRuns(splitRuns.right.map((run, index) =>
    index === 0 ? { ...run, text: run.text.trimStart() } : run,
  ).map((run, index, all) => index === all.length - 1 ? { ...run, text: run.text.trimEnd() } : run));
  let nextDocument = document;
  let destination = document.pages[source.number];
  if (destination === undefined) {
    nextDocument = appendPage(document, at);
    destination = nextDocument.pages[source.number]!;
  }
  const sourceElement: TextElement = {
    ...element,
    content: {
      format: "rich_text",
      blocks: element.content.blocks.map((candidate) => candidate.id === block.id
        ? { ...candidate, runs: sourceRuns }
        : candidate),
    },
  };
  const sourcePage = validatePage({
    ...source,
    revision: createPageRevision(source.revision + 1),
    elements: source.elements.map((candidate) => candidate.id === elementId ? sourceElement : candidate),
    updatedAt: createIsoInstant(at),
  });
  const destinationElement: TextElement = {
    kind: "text",
    id: stableElementId("continuation", `${elementId}:${destination.id}`),
    label: `${element.label} continued`,
    frame: { ...element.frame, y: PAGE_CONTENT_RECT.y },
    content: {
      format: "rich_text",
      blocks: [{
        ...block,
        id: stableBlockId(`${blockId}:${destination.id}`),
        runs: destinationRuns,
      }],
    },
  };
  const destinationPage = addElement(destination, destinationElement, at);
  const pages = nextDocument.pages.map((page) =>
    page.id === sourcePage.id ? sourcePage : page.id === destinationPage.id ? destinationPage : page,
  );
  nextDocument = validatePageDocument({ ...nextDocument, pages });
  return { document: nextDocument, sourcePage, destinationPage };
}
