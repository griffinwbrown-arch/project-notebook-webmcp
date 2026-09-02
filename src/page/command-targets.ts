import { z } from "zod";

import {
  createPageId,
  derivePagePlainText,
  resolvePageTarget,
  type AnnotationAnchor,
  type ElementId,
  type PageCandidate,
  type PageDocument,
  type PageElement,
  type PageId,
  type PageRecord,
  type PageRect,
  type TextBlockId,
  type TextElement,
} from "./domain";
import { layoutPage, textRangeRects } from "./layout";

export type ResolvedPageCommandTarget =
  | Readonly<{ kind: "page"; pageId: PageId; pageNumber: number }>
  | Readonly<{
    kind: "element";
    pageId: PageId;
    pageNumber: number;
    elementId: ElementId;
    elementKind: PageElement["kind"];
    label: string;
    frame: PageRect;
  }>
  | Readonly<{
    kind: "text-range";
    pageId: PageId;
    pageNumber: number;
    elementId: ElementId;
    blockId: TextBlockId;
    start: number;
    end: number;
    label: string;
    preview: string;
    boxes: readonly PageRect[];
  }>;

export type TextRangeCandidate = Readonly<{
  kind: "text-range";
  elementId: ElementId;
  blockId: TextBlockId;
  label: string;
  start: number;
  end: number;
}>;

export const PageIdSchema = z.string().trim().min(1).max(500);

const ElementIdTargetSchema = z.object({ kind: z.literal("element"), elementId: z.string().min(1) }).strict();
const PhraseTargetSchema = z.object({ kind: z.literal("phrase"), phrase: z.string().trim().min(1) }).strict();
const TextRangeTargetSchema = z.object({
  kind: z.literal("text-range"),
  elementId: z.string().min(1),
  blockId: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).strict();
export const ElementTargetSchema = z.union([
  ElementIdTargetSchema,
  PhraseTargetSchema,
  TextRangeTargetSchema,
]);
export const TargetResolveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({ kind: z.literal("page"), pageId: PageIdSchema }).strict(),
  z.object({ kind: z.literal("number"), pageNumber: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("phrase"), value: z.string().trim().min(1), pageId: PageIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("element"), elementId: z.string().min(1), pageId: PageIdSchema.optional() }).strict(),
  z.object({
    kind: z.literal("text-range"),
    elementId: z.string().min(1),
    blockId: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    pageId: PageIdSchema.optional(),
  }).strict(),
]);

export type TargetResolveInput = z.infer<typeof TargetResolveSchema>;
export type ElementTargetInput = z.infer<typeof ElementTargetSchema>;

export type ResolvedTextTarget = Readonly<{
  element: TextElement;
  blockId: TextBlockId;
  start: number;
  end: number;
}>;

export type ResolvedAnnotationTarget = Readonly<{
  anchor: AnnotationAnchor;
  frame: PageRect;
  containerFrame: PageRect;
}>;

export class PageTargetError extends Error {
  public constructor(
    public readonly code: "TARGET_NOT_FOUND" | "TARGET_AMBIGUOUS" | "PAGE_NOT_VISIBLE",
    message: string,
    public readonly candidates?: readonly TextRangeCandidate[],
  ) {
    super(message);
  }
}

export class PageCandidateError extends Error {
  public constructor(public readonly candidates: readonly PageCandidate[]) {
    super("Several pages matched that target.");
  }
}

export function pageFor(document: PageDocument, rawPageId: string | undefined, currentPageId: PageId): PageRecord {
  const id = rawPageId === undefined ? currentPageId : createPageId(rawPageId);
  const page = document.pages.find((candidate) => candidate.id === id);
  if (page === undefined) throw new Error(`Page ${id} was not found.`);
  return page;
}

export function phraseTextTargets(page: PageRecord, phraseValue: string): ResolvedTextTarget[] {
  const phrase = phraseValue.toLocaleLowerCase();
  const matches: ResolvedTextTarget[] = [];
  for (const element of page.elements) {
    if (element.kind !== "text") continue;
    for (const block of element.content.blocks) {
      const text = block.runs.map((run) => run.text).join("");
      let offset = text.toLocaleLowerCase().indexOf(phrase);
      while (offset >= 0) {
        matches.push({ element, blockId: block.id, start: offset, end: offset + phraseValue.length });
        offset = text.toLocaleLowerCase().indexOf(phrase, offset + 1);
      }
    }
  }
  return matches;
}

export function resolveTextTarget(page: PageRecord, target: ElementTargetInput): ResolvedTextTarget {
  if (target.kind === "text-range") {
    const element = page.elements.find((candidate) => candidate.id === target.elementId);
    if (element?.kind !== "text") throw new Error("The selected target is not readable text.");
    const block = element.content.blocks.find((candidate) => candidate.id === target.blockId);
    if (block === undefined) throw new Error("The selected text block was not found.");
    const length = block.runs.reduce((sum, run) => sum + run.text.length, 0);
    if (target.start < 0 || target.end <= target.start || target.end > length) {
      throw new Error("The selected text range is invalid.");
    }
    return { element, blockId: block.id, start: target.start, end: target.end };
  }
  if (target.kind === "element") {
    const element = page.elements.find((candidate) => candidate.id === target.elementId);
    if (element?.kind !== "text") throw new Error("The selected target is not readable text.");
    const block = element.content.blocks[0];
    if (block === undefined) throw new Error("The selected text has no block.");
    const length = block.runs.reduce((sum, run) => sum + run.text.length, 0);
    return { element, blockId: block.id, start: 0, end: length };
  }
  const matches = phraseTextTargets(page, target.phrase);
  if (matches.length === 0) throw new PageTargetError("TARGET_NOT_FOUND", "No visible text matched that phrase.");
  if (matches.length > 1) {
    throw new PageTargetError(
      "TARGET_AMBIGUOUS",
      "Several visible text ranges matched that phrase.",
      matches.map((match) => ({
        kind: "text-range",
        elementId: match.element.id,
        blockId: match.blockId,
        label: match.element.label,
        start: match.start,
        end: match.end,
      })),
    );
  }
  return matches[0]!;
}

export function textTargetResolution(page: PageRecord, target: ResolvedTextTarget): ResolvedPageCommandTarget {
  const block = target.element.content.blocks.find((candidate) => candidate.id === target.blockId)!;
  const text = block.runs.map((run) => run.text).join("");
  const boxes = textRangeRects(layoutPage(page), {
    kind: "text-range",
    elementId: target.element.id,
    blockId: target.blockId,
    start: target.start,
    end: target.end,
  });
  return {
    kind: "text-range",
    pageId: page.id,
    pageNumber: page.number,
    elementId: target.element.id,
    blockId: target.blockId,
    start: target.start,
    end: target.end,
    label: target.element.label,
    preview: text.slice(target.start, target.end),
    boxes,
  };
}

function textTargetFrame(page: PageRecord, target: ResolvedTextTarget): PageRect {
  const rects = textRangeRects(layoutPage(page), {
    kind: "text-range",
    elementId: target.element.id,
    blockId: target.blockId,
    start: target.start,
    end: target.end,
  });
  if (rects.length === 0) throw new Error("The selected text range has no page layout.");
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function resolveAnnotationTarget(page: PageRecord, target: ElementTargetInput): ResolvedAnnotationTarget {
  if (target.kind === "element") {
    const element = page.elements.find((candidate) => candidate.id === target.elementId);
    if (element === undefined) throw new Error("The selected page object was not found.");
    return { anchor: { kind: "element", elementId: element.id }, frame: element.frame, containerFrame: element.frame };
  }
  const text = resolveTextTarget(page, target);
  return {
    anchor: { kind: "text-range", elementId: text.element.id, blockId: text.blockId, start: text.start, end: text.end },
    frame: textTargetFrame(page, text),
    containerFrame: text.element.frame,
  };
}

export function targetFromAnchor(page: PageRecord, anchor: AnnotationAnchor): ResolvedAnnotationTarget {
  if (anchor.kind === "element") {
    return resolveAnnotationTarget(page, { kind: "element", elementId: anchor.elementId });
  }
  return resolveAnnotationTarget(page, {
    kind: "text-range",
    elementId: anchor.elementId,
    blockId: anchor.blockId,
    start: anchor.start,
    end: anchor.end,
  });
}

export function resolvePageCommandTarget(
  document: PageDocument,
  currentPageId: PageId,
  target: TargetResolveInput,
): ResolvedPageCommandTarget {
  if (target.kind === "current" || target.kind === "page" || target.kind === "number") {
    const selector = target.kind === "page" ? { ...target, pageId: createPageId(target.pageId) } : target;
    const resolution = resolvePageTarget(document, selector, currentPageId);
    if (resolution.status === "not_found") throw new PageTargetError("TARGET_NOT_FOUND", "No page matched that target.");
    if (resolution.status === "ambiguous") throw new PageCandidateError(resolution.candidates);
    return { kind: "page", pageId: resolution.page.id, pageNumber: resolution.page.number };
  }
  const candidatePages = target.pageId === undefined
    ? document.pages
    : [pageFor(document, target.pageId, currentPageId)];
  if (target.kind === "phrase") {
    const matches = candidatePages.flatMap((page) => phraseTextTargets(page, target.value).map((match) => ({ page, target: match })));
    if (matches.length === 0) throw new PageTargetError("TARGET_NOT_FOUND", "No visible text matched that phrase.");
    if (matches.length > 1) {
      throw new PageTargetError("TARGET_AMBIGUOUS", "Several visible text ranges matched that phrase.", matches.map(({ page, target: match }) => ({
        kind: "text-range",
        pageId: page.id,
        pageNumber: page.number,
        elementId: match.element.id,
        blockId: match.blockId,
        label: match.element.label,
        start: match.start,
        end: match.end,
      })));
    }
    const match = matches[0]!;
    return textTargetResolution(match.page, match.target);
  }
  const elementMatches = candidatePages.flatMap((page) => {
    const element = page.elements.find((candidate) => candidate.id === target.elementId);
    return element === undefined ? [] : [{ page, element }];
  });
  if (elementMatches.length === 0) throw new PageTargetError("TARGET_NOT_FOUND", "No element matched that stable id.");
  if (elementMatches.length > 1) {
    throw new PageCandidateError(elementMatches.map(({ page }) => ({
      pageId: page.id,
      pageNumber: page.number,
      preview: derivePagePlainText(page).slice(0, 120),
      revision: page.revision,
    })));
  }
  const match = elementMatches[0]!;
  if (target.kind === "text-range") {
    const resolvedTarget = resolveTextTarget(match.page, {
      kind: "text-range",
      elementId: target.elementId,
      blockId: target.blockId,
      start: target.start,
      end: target.end,
    });
    return textTargetResolution(match.page, resolvedTarget);
  }
  return {
    kind: "element",
    pageId: match.page.id,
    pageNumber: match.page.number,
    elementId: match.element.id,
    elementKind: match.element.kind,
    label: match.element.label,
    frame: match.element.frame,
  };
}
