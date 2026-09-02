import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import {
  createEmptyPage,
  createEmptyPageDocument,
  createElementId,
  createPageId,
  createTextBlockId,
  richTextFromPlainText,
  type PageDocument,
  type PageRecord,
  type ShapeElement,
  type TextElement,
} from "../../../src/page";
import { layoutPage, textRangeRects, visiblePageIds } from "../../../src/page/layout";

const at = createIsoInstant("2026-08-30T12:00:00.000Z");

function emptyDocument(): PageDocument {
  const document = createEmptyPageDocument(createNotebookId("layout-edge"), at);
  return { ...document, pageOrder: [], pages: [] };
}

function textPage(text: string, frame: TextElement["frame"]): PageRecord {
  const page = createEmptyPage(createNotebookId("layout-edge"), 1, at);
  return {
    ...page,
    elements: [{
      kind: "text",
      id: createElementId("empty-text"),
      label: "Empty text",
      frame,
      content: richTextFromPlainText(text, createTextBlockId("empty-block")),
    }],
  };
}

describe("page layout boundary cases", () => {
  it("returns no visible pages for an empty document and one page for a single-page spread", () => {
    expect(visiblePageIds(emptyDocument(), createPageId("missing-page"), "single")).toEqual([]);

    const single = createEmptyPageDocument(createNotebookId("single-spread"), at);
    expect(visiblePageIds(single, single.pages[0]!.id, "spread")).toEqual([single.pages[0]!.id]);
  });

  it("clamps an oversized non-text frame to the exact finite page bounds", () => {
    const page = createEmptyPage(createNotebookId("clamp-edge"), 1, at);
    const shape: ShapeElement = {
      kind: "shape",
      id: createElementId("oversized-shape"),
      label: "Oversized",
      frame: { x: -40, y: -20, width: 1_000, height: 2_000 },
      shape: "rectangle",
      fill: null,
      stroke: "ink",
    };

    const element = layoutPage({ ...page, elements: [shape] }).elements.get(shape.id);
    expect(element).toMatchObject({
      frame: { x: 0, y: 0, width: 816, height: 1056 },
      textLines: [],
    });
  });

  it("lays out an empty text block at the exact content origin", () => {
    const page = textPage("", { x: 0, y: 0, width: 200, height: 100 });
    const snapshot = layoutPage(page);
    const element = snapshot.elements.get(createElementId("empty-text"));
    const line = element?.textLines[0];

    expect(snapshot.metrics.contentRect).toEqual({ x: 72, y: 64, width: 672, height: 928 });
    expect(snapshot.metrics.firstBaselineY).toBe(107.68);
    expect(line).toMatchObject({
      start: 0,
      end: 0,
      baseline: 107.68,
      advances: [],
    });
    expect(line?.rect).toMatchObject({ x: 72, width: 128, height: 43.68 });
    expect(line?.rect.y).toBeCloseTo(64);

    const blockId = createTextBlockId("empty-block");
    expect(textRangeRects(snapshot, {
      kind: "text-range",
      elementId: createElementId("empty-text"),
      blockId,
      start: 0,
      end: 1,
    })).toEqual([]);
  });

  it("uses blank-paper metrics and the exact scaled A4 content coordinates", () => {
    const base = createEmptyPage(createNotebookId("a4-layout"), 1, at, {
      paper: "blank",
      size: { width: 794, height: 1123 },
    });
    const snapshot = layoutPage(base);

    expect(snapshot.metrics).toMatchObject({
      paper: "blank",
      pageSize: { width: 794, height: 1123 },
      pageBounds: { x: 0, y: 0, width: 794, height: 1123 },
      contentRect: {
        x: 70.05882352941177,
        y: 62.27450980392157,
        width: 653.8823529411765,
        height: 998.4509803921569,
      },
      ruleSpacing: 45.53823529411765,
      firstBaselineY: 107.81274509803922,
      fontSize: 27.32294117647059,
    });
  });
});
