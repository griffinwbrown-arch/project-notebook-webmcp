import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import {
  PAGE_CONTENT_RECT,
  addElement,
  appendPage,
  continueText,
  createElementId,
  createEmptyPageDocument,
  createTextBlockId,
  derivePagePlainText,
  formatTextRange,
  resolvePageTarget,
  richTextFromPlainText,
  stableElementId,
  updateElementFrame,
  updatePagePresentation,
  validatePage,
  validatePageDocument,
  type AnnotationElement,
  type RichTextBlock,
  type ShapeElement,
  type StrokeElement,
  type TextElement,
} from "../../../src/page";

const at = createIsoInstant("2026-08-26T12:00:00.000Z");
const later = createIsoInstant("2026-08-26T12:01:00.000Z");
const workbookId = createNotebookId("phase3-domain");

function textElement(text = "Project kickoff Friday"): TextElement {
  return {
    kind: "text",
    id: createElementId("text-1"),
    label: "Kickoff note",
    frame: { x: 96, y: 100, width: 520, height: 160 },
    content: richTextFromPlainText(text, createTextBlockId("block-1")),
  };
}

describe("Phase 3 page domain", () => {
  it("keeps structured rich text authoritative and derives plain text", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const page = addElement(document.pages[0]!, textElement(), later);

    expect(page.elements[0]).toMatchObject({
      kind: "text",
      content: { format: "rich_text" },
    });
    expect(derivePagePlainText(page)).toBe("Project kickoff Friday");
    expect(page.revision).toBe(2);
  });

  it("persists a user-managed paper style and page size while keeping geometry proportional", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const inserted = addElement(document.pages[0]!, textElement(), later);
    const presented = updatePagePresentation(inserted, { paper: "grid", sizePreset: "a4" }, later);
    expect(presented.paper).toBe("grid");
    expect(presented.size).toEqual({ width: 794, height: 1123 });
    expect(presented.elements[0]?.frame.width).toBeCloseTo(520 * (794 / 816), 5);
    const nextDocument = appendPage({ ...document, pages: [presented] }, later);
    expect(nextDocument.pages[1]).toMatchObject({ paper: "grid", size: { width: 794, height: 1123 } });
  });

  it("formats an exact text range as one page revision", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const inserted = addElement(document.pages[0]!, textElement(), later);
    const formatted = formatTextRange(
      inserted,
      createElementId("text-1"),
      createTextBlockId("block-1"),
      0,
      7,
      ["bold"],
      later,
    );

    expect(formatted.revision).toBe(3);
    const formattedElement = formatted.elements[0];
    expect(formattedElement?.kind).toBe("text");
    if (formattedElement?.kind === "text") {
      expect(formattedElement.content.blocks[0]?.runs[0]).toEqual({
        text: "Project",
        marks: ["bold"],
      });
    }
  });

  it("rejects geometry that obscures readable text", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const inserted = addElement(document.pages[0]!, textElement(), later);
    const shape: ShapeElement = {
      kind: "shape",
      id: createElementId("shape-1"),
      label: "Status circle",
      frame: { x: 120, y: 120, width: 100, height: 100 },
      shape: "ellipse",
      fill: null,
      stroke: "#2d463b",
    };

    expect(() => addElement(inserted, shape, later)).toThrow(/obscure readable text/i);
  });

  it("allows a narrow freehand mark to coexist with readable text", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const inserted = addElement(document.pages[0]!, textElement(), later);
    const stroke: StrokeElement = {
      kind: "stroke",
      id: createElementId("stroke-over-text"),
      label: "Freehand mark",
      frame: { x: 120, y: 140, width: 120, height: 12 },
      points: [{ x: 120, y: 146 }, { x: 240, y: 146 }],
      color: "black",
      width: 2,
    };

    expect(addElement(inserted, stroke, later).elements).toHaveLength(2);
  });

  it("accepts a valid text-range annotation that follows its target", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const inserted = addElement(document.pages[0]!, textElement(), later);
    const annotation: AnnotationElement = {
      kind: "annotation",
      id: createElementId("annotation-1"),
      label: "Friday highlight",
      frame: { x: 94, y: 164, width: 260, height: 30 },
      annotation: "highlight",
      anchor: {
        kind: "text-range",
        elementId: createElementId("text-1"),
        blockId: createTextBlockId("block-1"),
        start: 16,
        end: 22,
      },
    };

    expect(addElement(inserted, annotation, later).elements).toHaveLength(2);
  });

  it("fails closed when a phrase resolves to several pages", () => {
    let document = createEmptyPageDocument(workbookId, at);
    document = appendPage(document, later);
    const pages = document.pages.map((page, index) =>
      addElement(page, {
        ...textElement("Repeated phrase"),
        id: stableElementId("repeated", String(index)),
        frame: { ...PAGE_CONTENT_RECT, height: 120 },
      }, later),
    );
    document = { ...document, pages };

    const result = resolvePageTarget(document, { kind: "phrase", value: "repeated phrase" });
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.candidates).toHaveLength(2);
  });

  it("continues text at a word boundary onto one finite next page", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const insertedPage = addElement(
      document.pages[0]!,
      textElement("First paragraph continues here"),
      later,
    );
    const insertedDocument = { ...document, pages: [insertedPage] };
    const result = continueText(
      insertedDocument,
      insertedPage.id,
      createElementId("text-1"),
      createTextBlockId("block-1"),
      16,
      later,
    );

    expect(result.document.pageOrder).toHaveLength(2);
    expect(derivePagePlainText(result.sourcePage)).toBe("First paragraph");
    expect(derivePagePlainText(result.destinationPage)).toBe("continues here");
    expect(result.document.documentRevision).toBe(2);
  });

  it("rejects an orphan heading and out-of-page placement", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const orphan: TextElement = {
      ...textElement("Heading"),
      content: richTextFromPlainText(
        "Heading",
        createTextBlockId("heading"),
        "heading",
      ),
    };
    expect(() => validatePage({ ...document.pages[0]!, elements: [orphan] })).toThrow(/heading/i);
    expect(() => validatePage({
      ...document.pages[0]!,
      elements: [{ ...textElement(), frame: { x: 700, y: 100, width: 300, height: 100 } }],
    })).toThrow(/inside/i);
  });

  it("requires page order to match the finite page sequence positionally", () => {
    let document = createEmptyPageDocument(workbookId, at);
    document = appendPage(document, later);
    expect(() => validatePageDocument({
      ...document,
      pageOrder: [document.pageOrder[1]!, document.pageOrder[0]!],
    })).toThrow(/order/i);
  });

  it("rejects readable text elements that overlap each other", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const first = addElement(document.pages[0]!, textElement("First"), later);
    const second = {
      ...textElement("Second"),
      id: createElementId("text-2"),
      frame: { x: 200, y: 140, width: 520, height: 160 },
    };
    expect(() => addElement(first, second, later)).toThrow(/readable text.*overlap/i);
  });

  it("translates and scales stroke points when its frame moves or resizes", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const stroke = {
      kind: "stroke" as const,
      id: createElementId("stroke-1"),
      label: "Line",
      frame: { x: 100, y: 100, width: 100, height: 100 },
      points: [{ x: 100, y: 100 }, { x: 150, y: 150 }],
      color: "#000",
      width: 4,
    };
    const page = addElement(document.pages[0]!, stroke, later);
    const moved = updateElementFrame(page, stroke.id, { x: 200, y: 300, width: 200, height: 50 }, later);
    const result = moved.elements[0];
    expect(result?.kind).toBe("stroke");
    if (result?.kind === "stroke") {
      expect(result.points).toEqual([{ x: 200, y: 300 }, { x: 300, y: 325 }]);
    }
  });

  it("formats emoji ranges by UTF-16 offsets while preserving surrounding marks", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const page = addElement(document.pages[0]!, {
      ...textElement("A😀B"),
      content: {
        format: "rich_text",
        blocks: [{
          id: createTextBlockId("emoji-block"),
          kind: "paragraph",
          runs: [{ text: "A😀B", marks: [] }],
        }],
      },
    }, later);
    const formatted = formatTextRange(page, createElementId("text-1"), createTextBlockId("emoji-block"), 1, 3, ["bold"], later);
    const element = formatted.elements[0];
    expect(element?.kind).toBe("text");
    if (element?.kind === "text") {
      expect(element.content.blocks[0]?.runs).toEqual([
        { text: "A", marks: [] },
        { text: "😀", marks: ["bold"] },
        { text: "B", marks: [] },
      ]);
    }
  });

  it("continues one block without dropping sibling blocks or run marks", () => {
    const document = createEmptyPageDocument(workbookId, at);
    const blocks: readonly RichTextBlock[] = [
      {
        id: createTextBlockId("split-block"),
        kind: "paragraph",
        runs: [
          { text: "First ", marks: [] },
          { text: "paragraph continues", marks: ["bold"] },
        ],
      },
      {
        id: createTextBlockId("sibling-block"),
        kind: "quote",
        runs: [{ text: "Keep this sibling", marks: ["italic"] }],
      },
    ];
    const page = addElement(document.pages[0]!, {
      ...textElement("placeholder"),
      content: { format: "rich_text", blocks },
    }, later);
    const insertedDocument = { ...document, pages: [page] };
    const result = continueText(insertedDocument, page.id, createElementId("text-1"), createTextBlockId("split-block"), 6, later);
    const source = result.sourcePage.elements[0];
    const destination = result.destinationPage.elements.find((item) => item.kind === "text");
    expect(source?.kind).toBe("text");
    expect(destination?.kind).toBe("text");
    if (source?.kind === "text" && destination?.kind === "text") {
      expect(source.content.blocks.map((block) => block.id)).toEqual([
        createTextBlockId("split-block"),
        createTextBlockId("sibling-block"),
      ]);
      expect(source.content.blocks[1]?.runs[0]?.marks).toEqual(["italic"]);
      expect(destination.content.blocks[0]?.runs[0]?.marks).toEqual(["bold"]);
    }
  });
});
