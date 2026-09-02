import { describe, expect, it } from "vitest";

import {
  createEmptyPage,
  createEmptyPageDocument,
  createElementId,
  createPageId,
  createTextBlockId,
  richTextFromPlainText,
  type PageRecord,
  type TextElement,
} from "../../../src/page/domain";
import { createIsoInstant, createNotebookId } from "../../../src/domain";
import {
  layoutPage,
  textRangeRects,
  visiblePageIds,
  type PagePresentation,
} from "../../../src/page/layout";

const at = createIsoInstant("2026-08-26T12:00:00.000Z");

function pageWithText(text: string, pageNumber = 1): PageRecord {
  const page = createEmptyPage(createNotebookId("layout-workbook"), pageNumber, at);
  const element: TextElement = {
    kind: "text",
    id: createElementId(`text-${pageNumber}`),
    label: `Text ${pageNumber}`,
    frame: { x: 72, y: 64, width: 220, height: 400 },
    content: richTextFromPlainText(text, createTextBlockId(`block-${pageNumber}`)),
  };
  return { ...page, elements: [element] };
}

describe("page layout", () => {
  it("advances a two-page spread one page at a time", () => {
    const workbookId = createNotebookId("spread-workbook");
    const document = createEmptyPageDocument(workbookId, at);
    const second = createEmptyPage(workbookId, 2, at);
    const third = createEmptyPage(workbookId, 3, at);
    const fourth = createEmptyPage(workbookId, 4, at);
    const pages = [document.pages[0]!, second, third, fourth];
    const spreadDocument = { ...document, pageOrder: pages.map((page) => page.id), pages };

    expect(visiblePageIds(spreadDocument, pages[0]!.id, "spread")).toEqual([pages[0]!.id, second.id]);
    expect(visiblePageIds(spreadDocument, second.id, "spread")).toEqual([second.id, third.id]);
    expect(visiblePageIds(spreadDocument, third.id, "spread")).toEqual([third.id, fourth.id]);
    expect(visiblePageIds(spreadDocument, fourth.id, "spread")).toEqual([third.id, fourth.id]);
  });

  it("returns only the focused page for single-page presentation", () => {
    const document = createEmptyPageDocument(createNotebookId("single-workbook"), at);
    const presentation: PagePresentation = "single";

    expect(visiblePageIds(document, document.pages[0]!.id, presentation)).toEqual([document.pages[0]!.id]);
  });

  it("places text baselines on the ruled paper rhythm", () => {
    const page = pageWithText("A short line of notebook text.");
    const snapshot = layoutPage(page);
    const textLayout = snapshot.elements.get(createElementId("text-1"));
    const firstLine = textLayout?.textLines[0];

    expect(firstLine).toBeDefined();
    expect((firstLine?.baseline ?? 0) - snapshot.metrics.firstBaselineY).toBe(0);
    expect((firstLine?.rect.y ?? 0) + (firstLine?.rect.height ?? 0)).toBe(firstLine?.baseline);
    expect(snapshot.metrics.paper).toBe("lined");
  });

  it("returns one rectangle per rendered line for a wrapped text range", () => {
    const page = pageWithText("one two three four five six seven eight nine ten eleven twelve");
    const snapshot = layoutPage(page);
    const element = page.elements[0]!;
    if (element.kind !== "text") throw new Error("fixture must be text");
    const block = element.content.blocks[0]!;
    const rects = textRangeRects(snapshot, {
      kind: "text-range",
      elementId: element.id,
      blockId: block.id,
      start: 4,
      end: 54,
    });

    expect(snapshot.elements.get(element.id)?.textLines.length).toBeGreaterThan(1);
    expect(rects.length).toBeGreaterThan(1);
    expect(rects.every((rect) => rect.x >= snapshot.metrics.contentRect.x)).toBe(true);
    expect(rects.every((rect) => rect.x + rect.width <= snapshot.metrics.contentRect.x + snapshot.metrics.contentRect.width)).toBe(true);
  });

  it("uses glyph advances instead of character-count proportions for ranges", () => {
    const page = pageWithText("iW");
    const snapshot = layoutPage(page);
    const element = page.elements[0]!;
    if (element.kind !== "text") throw new Error("fixture must be text");
    const block = element.content.blocks[0]!;
    const line = snapshot.elements.get(element.id)?.textLines.at(0);
    const rects = textRangeRects(snapshot, {
      kind: "text-range",
      elementId: element.id,
      blockId: block.id,
      start: 1,
      end: 2,
    });
    const rect = rects.at(0);
    if (line === undefined || rect === undefined) throw new Error("The fixture must produce one rendered line and range.");

    expect(rect.x - line.rect.x).toBeLessThan(20);
    expect(rect.width).toBeGreaterThan(9);
    expect(rect.width).toBeLessThan(22);
  });

  it("falls back to the first page when the focused page is not present", () => {
    const document = createEmptyPageDocument(createNotebookId("fallback-workbook"), at);
    expect(visiblePageIds(document, createPageId("missing-page"), "single")).toEqual([document.pages[0]!.id]);
  });
});
