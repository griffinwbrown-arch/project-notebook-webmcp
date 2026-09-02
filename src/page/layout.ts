import {
  PAGE_CONTENT_RECT,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type AnnotationAnchor,
  type ElementId,
  type PageDocument,
  type PageElement,
  type PageId,
  type PagePaper,
  type PageRecord,
  type PageRect,
  type RichTextBlock,
  type RichTextMark,
  type TextBlockId,
} from "./domain";

export const NOTEBOOK_TEXT_SCALE = 1.56;

export type PagePresentation = "single" | "spread";

export type PaperMetrics = Readonly<{
  paper: PagePaper;
  pageSize: Readonly<{ width: number; height: number }>;
  pageBounds: PageRect;
  contentRect: PageRect;
  ruleSpacing: number;
  firstBaselineY: number;
  marginX: number;
  contentWidth: number;
  lineHeight: number;
  fontSize: number;
}>;

export type TextLineLayout = Readonly<{
  elementId: ElementId;
  blockId: TextBlockId;
  start: number;
  end: number;
  baseline: number;
  rect: PageRect;
  advances: readonly TextGlyphAdvance[];
}>;

export type TextGlyphAdvance = Readonly<{
  start: number;
  end: number;
  x: number;
  width: number;
}>;

export type ElementLayout = Readonly<{
  elementId: ElementId;
  kind: PageElement["kind"];
  frame: PageRect;
  textLines: readonly TextLineLayout[];
}>;

export type PageLayoutSnapshot = Readonly<{
  pageId: PageId;
  revision: PageRecord["revision"];
  pageSize: Readonly<{ width: number; height: number }>;
  paper: PagePaper;
  metrics: PaperMetrics;
  elements: ReadonlyMap<ElementId, ElementLayout>;
  textLines: readonly TextLineLayout[];
}>;

type CharacterSpan = Readonly<{
  text: string;
  start: number;
  end: number;
  width: number;
}>;

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function scaledPageRect(page: PageRecord): PageRect {
  const scale = finitePositive(page.size.width / PAGE_WIDTH, 1);
  const marginX = PAGE_CONTENT_RECT.x * scale;
  const top = PAGE_CONTENT_RECT.y * scale;
  const bottom = PAGE_CONTENT_RECT.y * scale;
  return {
    x: marginX,
    y: top,
    width: Math.max(1, page.size.width - marginX * 2),
    height: Math.max(1, page.size.height - top - bottom),
  };
}

function paperMetrics(page: PageRecord): PaperMetrics {
  const pageBounds: PageRect = {
    x: 0,
    y: 0,
    width: finitePositive(page.size.width, PAGE_WIDTH),
    height: finitePositive(page.size.height, PAGE_HEIGHT),
  };
  const contentRect = scaledPageRect({ ...page, size: pageBounds });
  const scale = pageBounds.width / PAGE_WIDTH;
  const paper = page.paper ?? "lined";
  const ruleSpacing = (paper === "blank" ? 30 : 28) * scale * NOTEBOOK_TEXT_SCALE;
  const fontSize = (paper === "blank" ? 18 : 19) * scale * NOTEBOOK_TEXT_SCALE;
  const firstBaselineY = contentRect.y + ruleSpacing;
  return {
    paper,
    pageSize: { width: pageBounds.width, height: pageBounds.height },
    pageBounds,
    contentRect,
    ruleSpacing,
    firstBaselineY,
    marginX: contentRect.x,
    contentWidth: contentRect.width,
    lineHeight: ruleSpacing,
    fontSize,
  };
}

function clampRect(rect: PageRect, bounds: PageRect): PageRect {
  const width = Math.min(finitePositive(rect.width, 1), bounds.width);
  const height = Math.min(finitePositive(rect.height, 1), bounds.height);
  return {
    x: Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.width - width)),
    y: Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.height - height)),
    width,
    height,
  };
}

function markWidth(mark: RichTextMark): number {
  if (mark === "code") return 11;
  if (mark === "bold") return 10.8;
  if (mark === "italic") return 10.3;
  return 10.2;
}

function characterWidth(character: string, marks: readonly RichTextMark[], scale: number): number {
  if (/\s/.test(character)) return 5 * scale;
  if (/[ilI.,'`:;]/.test(character)) return 4.7 * scale;
  if (/[MW@#%&]/.test(character)) return 13.5 * scale;
  const base = marks.length === 0 ? 10.2 : Math.max(...marks.map(markWidth));
  return base * scale;
}

function characters(block: RichTextBlock, scale: number): CharacterSpan[] {
  const spans: CharacterSpan[] = [];
  let offset = 0;
  for (const run of block.runs) {
    for (const character of run.text) {
      const end = offset + character.length;
      spans.push({
        text: character,
        start: offset,
        end,
        width: characterWidth(character, run.marks, scale),
      });
      offset = end;
    }
  }
  return spans;
}

function baselineFor(frameY: number, metrics: PaperMetrics): number {
  const startY = Math.max(frameY, metrics.contentRect.y);
  const offset = Math.max(0, Math.ceil((startY - metrics.firstBaselineY) / metrics.ruleSpacing));
  return metrics.firstBaselineY + offset * metrics.ruleSpacing;
}

function lineAt(
  elementId: ElementId,
  blockId: TextBlockId,
  start: number,
  end: number,
  baseline: number,
  frame: PageRect,
  metrics: PaperMetrics,
  spans: readonly CharacterSpan[],
): TextLineLayout {
  const x = Math.max(frame.x, metrics.contentRect.x);
  const right = Math.min(frame.x + frame.width, metrics.contentRect.x + metrics.contentRect.width);
  const width = Math.max(1, right - x);
  let advanceX = x;
  const advances: TextGlyphAdvance[] = [];
  for (const span of spans) {
    if (span.start < start || span.end > end) continue;
    advances.push({ start: span.start, end: span.end, x: advanceX, width: span.width });
    advanceX += span.width;
  }
  return {
    elementId,
    blockId,
    start,
    end,
    baseline,
    rect: { x, y: baseline - metrics.lineHeight, width, height: metrics.lineHeight },
    advances,
  };
}

function wrapBlock(
  elementId: ElementId,
  block: RichTextBlock,
  frame: PageRect,
  metrics: PaperMetrics,
  firstBaseline: number,
): readonly TextLineLayout[] {
  const spans = characters(block, (metrics.pageSize.width / PAGE_WIDTH) * NOTEBOOK_TEXT_SCALE);
  const maxWidth = Math.max(1, Math.min(frame.width, metrics.contentRect.width));
  if (spans.length === 0) {
    return [lineAt(elementId, block.id, 0, 0, firstBaseline, frame, metrics, spans)];
  }

  const lines: TextLineLayout[] = [];
  let lineStart = 0;
  let lineWidth = 0;
  let lastBreak = -1;
  let index = 0;
  let baseline = firstBaseline;

  while (index < spans.length) {
    const span = spans[index]!;
    if (span.text === "\n") {
      lines.push(lineAt(elementId, block.id, lineStart, span.start, baseline, frame, metrics, spans));
      lineStart = span.end;
      lineWidth = 0;
      lastBreak = -1;
      baseline += metrics.lineHeight;
      index += 1;
      continue;
    }

    if (lineWidth + span.width > maxWidth && index > 0 && span.start > lineStart) {
      const breakAt = lastBreak > lineStart ? lastBreak : span.start;
      lines.push(lineAt(elementId, block.id, lineStart, breakAt, baseline, frame, metrics, spans));
      baseline += metrics.lineHeight;
      lineStart = breakAt;
      lineWidth = 0;
      lastBreak = -1;
      while (index < spans.length && spans[index]!.start < lineStart) index += 1;
      continue;
    }

    lineWidth += span.width;
    if (/\s/.test(span.text)) lastBreak = span.end;
    index += 1;
  }

  lines.push(lineAt(elementId, block.id, lineStart, spans.at(-1)!.end, baseline, frame, metrics, spans));
  return lines;
}

function layoutElement(element: PageElement, metrics: PaperMetrics): ElementLayout {
  const frame = clampRect(element.frame, metrics.pageBounds);
  if (element.kind !== "text") {
    return { elementId: element.id, kind: element.kind, frame, textLines: [] };
  }

  const textLines: TextLineLayout[] = [];
  let baseline = baselineFor(frame.y, metrics);
  for (const block of element.content.blocks) {
    const blockLines = wrapBlock(element.id, block, frame, metrics, baseline);
    textLines.push(...blockLines);
    baseline = (blockLines.at(-1)?.baseline ?? baseline) + metrics.lineHeight;
  }
  return { elementId: element.id, kind: element.kind, frame, textLines };
}

export function layoutPage(page: PageRecord): PageLayoutSnapshot {
  const metrics = paperMetrics(page);
  const elements = new Map<ElementId, ElementLayout>();
  const textLines: TextLineLayout[] = [];
  for (const element of page.elements) {
    const elementLayout = layoutElement(element, metrics);
    elements.set(element.id, elementLayout);
    textLines.push(...elementLayout.textLines);
  }
  return {
    pageId: page.id,
    revision: page.revision,
    pageSize: metrics.pageSize,
    paper: metrics.paper,
    metrics,
    elements,
    textLines,
  };
}

export function textRangeRects(
  snapshot: PageLayoutSnapshot,
  anchor: Extract<AnnotationAnchor, { kind: "text-range" }>,
): readonly PageRect[] {
  const element = snapshot.elements.get(anchor.elementId);
  if (element === undefined) return [];
  return element.textLines
    .filter((line) => line.blockId === anchor.blockId && line.end > anchor.start && line.start < anchor.end)
    .map((line) => {
      const start = Math.max(line.start, anchor.start);
      const end = Math.min(line.end, anchor.end);
      const x = textOffsetX(line, start);
      const right = textOffsetX(line, end);
      return {
        x,
        y: line.rect.y,
        width: Math.max(1, right - x),
        height: line.rect.height,
      } satisfies PageRect;
    });
}

function textOffsetX(line: TextLineLayout, offset: number): number {
  const first = line.advances.at(0);
  if (first === undefined) return line.rect.x;
  if (offset <= first.start) return first.x;
  for (const advance of line.advances) {
    if (offset <= advance.end) {
      const fraction = (offset - advance.start) / Math.max(1, advance.end - advance.start);
      return advance.x + advance.width * Math.max(0, Math.min(1, fraction));
    }
  }
  const last = line.advances.at(-1);
  return last === undefined ? line.rect.x : last.x + last.width;
}

export function visiblePageIds(
  document: PageDocument,
  focusedPageId: PageId,
  presentation: PagePresentation,
): readonly PageId[] {
  if (document.pageOrder.length === 0) return [];
  const focusedIndex = Math.max(0, document.pageOrder.indexOf(focusedPageId));
  if (presentation === "single") return [document.pageOrder[focusedIndex]!];

  let start = focusedIndex;
  if (start + 1 >= document.pageOrder.length && focusedIndex > 0) start = focusedIndex - 1;
  return document.pageOrder.slice(start, start + 2);
}
