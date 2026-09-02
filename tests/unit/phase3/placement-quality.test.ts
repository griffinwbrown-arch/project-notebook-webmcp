import { describe, expect, it } from "vitest";

import { createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import { createPageCommandRegistry, layoutPage } from "../../../src/page";
import { PAGE_CONTENT_RECT, type PageRect } from "../../../src/page/domain";

let sequence = 0;

function storage(prefix: string): IndexedDbPageStorage {
  sequence += 1;
  return new IndexedDbPageStorage({
    databaseName: `phase3-placement-quality-${prefix}-${sequence}`,
    clock: { now: () => "2026-08-30T16:00:00.000Z" },
  });
}

function hasMinimumGutter(left: PageRect, right: PageRect, gutter: number): boolean {
  return left.x + left.width + gutter <= right.x
    || right.x + right.width + gutter <= left.x
    || left.y + left.height + gutter <= right.y
    || right.y + right.height + gutter <= left.y;
}

function isInsideWithInset(frame: PageRect, bounds: PageRect, inset: number): boolean {
  return frame.x >= bounds.x + inset
    && frame.y >= bounds.y + inset
    && frame.x + frame.width <= bounds.x + bounds.width - inset
    && frame.y + frame.height <= bounds.y + bounds.height - inset;
}

describe("default page element placement quality", () => {
  it("places repeated default shapes on an 8px grid without colliding with each other or text", async () => {
    const store = storage("repeated-shapes");
    const registry = await createPageCommandRegistry(store, createNotebookId("placement-quality-workbook"));

    expect(await registry.executeManual("page_text_insert", {
      mutationId: "placement-text",
      expectedRevision: 1,
      text: "Keep diagrams clear of this readable text.",
    })).toMatchObject({ outcome: "success" });
    expect(await registry.executeManual("page_shape_add", {
      mutationId: "placement-rectangle",
      expectedRevision: 2,
      shape: "rectangle",
    })).toMatchObject({ outcome: "success" });
    expect(await registry.executeManual("page_shape_add", {
      mutationId: "placement-ellipse",
      expectedRevision: 3,
      shape: "ellipse",
    })).toMatchObject({ outcome: "success" });
    const arrow = await registry.executeManual("page_shape_add", {
      mutationId: "placement-arrow",
      expectedRevision: 4,
      shape: "arrow",
    });
    expect(arrow).toMatchObject({ outcome: "success", output: { receipt: { kind: "page_shape_add" } } });

    const page = registry.getDocument().pages[0];
    if (page === undefined) throw new Error("Expected the first notebook page.");
    const text = page.elements.find((element) => element.kind === "text");
    const shapes = page.elements.filter((element) => element.kind === "shape");
    if (text === undefined || shapes.length !== 3) throw new Error("Expected one text element and three shapes.");
    expect(shapes.map((shape) => shape.frame)).toEqual([
      { x: 632, y: 80, width: 96, height: 96 },
      { x: 632, y: 192, width: 96, height: 96 },
      { x: 632, y: 304, width: 96, height: 96 },
    ]);

    for (let index = 0; index < shapes.length; index += 1) {
      const shape = shapes[index];
      if (shape === undefined) throw new Error("Expected a placed shape.");
      expect(shape.frame.x % 8).toBe(0);
      expect(shape.frame.y % 8).toBe(0);
      for (let nextIndex = index + 1; nextIndex < shapes.length; nextIndex += 1) {
        const nextShape = shapes[nextIndex];
        if (nextShape === undefined) throw new Error("Expected another placed shape.");
        expect(hasMinimumGutter(shape.frame, nextShape.frame, 16)).toBe(true);
      }
      expect(hasMinimumGutter(shape.frame, text.frame, 16)).toBe(true);
    }

    if (arrow.outcome !== "success" || arrow.output.receipt === undefined) {
      throw new Error("Expected a receipt for the placed arrow.");
    }
    expect(await registry.executeManual("page_undo", {
      mutationId: "placement-arrow-undo",
      receiptId: arrow.output.receipt.id,
    })).toMatchObject({ outcome: "success", output: { context: { pageRevision: 6 } } });
    expect(registry.getDocument().pages[0]?.elements.map((element) => element.id)).toEqual([
      "phase3:mutation:placement-text",
      "phase3:mutation:placement-rectangle",
      "phase3:mutation:placement-ellipse",
    ]);

    await store.close();
  });

  it("uses the same bounded grid placement on A4 pages", async () => {
    const store = storage("a4-shapes");
    const registry = await createPageCommandRegistry(store, createNotebookId("a4-placement-workbook"));

    expect(await registry.executeManual("page_presentation_set", {
      mutationId: "a4-presentation",
      expectedRevision: 1,
      sizePreset: "a4",
    })).toMatchObject({ outcome: "success" });
    expect(await registry.executeManual("page_shape_add", {
      mutationId: "a4-rectangle",
      expectedRevision: 2,
      shape: "rectangle",
    })).toMatchObject({ outcome: "success" });
    expect(await registry.executeManual("page_shape_add", {
      mutationId: "a4-ellipse",
      expectedRevision: 3,
      shape: "ellipse",
    })).toMatchObject({ outcome: "success" });

    const page = registry.getDocument().pages[0];
    if (page === undefined) throw new Error("Expected the A4 notebook page.");
    const shapes = page.elements.filter((element) => element.kind === "shape");
    if (shapes.length !== 2 || shapes[0] === undefined || shapes[1] === undefined) {
      throw new Error("Expected two shapes on the A4 page.");
    }
    expect(shapes.map((shape) => shape.frame)).toEqual([
      { x: 608, y: 80, width: 96, height: 96 },
      { x: 608, y: 192, width: 96, height: 96 },
    ]);
    const contentRect = layoutPage(page).metrics.contentRect;
    for (const shape of shapes) {
      expect(shape.frame.x % 8).toBe(0);
      expect(shape.frame.y % 8).toBe(0);
      expect(isInsideWithInset(shape.frame, contentRect, 16)).toBe(true);
    }
    expect(hasMinimumGutter(shapes[0].frame, shapes[1].frame, 16)).toBe(true);

    await store.close();
  });

  it("fails closed when the page has no safe default shape position", async () => {
    const store = storage("full-page");
    const registry = await createPageCommandRegistry(store, createNotebookId("full-placement-workbook"));

    expect(await registry.executeManual("page_text_insert", {
      mutationId: "full-page-text",
      expectedRevision: 1,
      text: "This page reserves the complete content area.",
      frame: PAGE_CONTENT_RECT,
    })).toMatchObject({ outcome: "success" });
    const before = JSON.stringify(registry.getDocument());

    expect(await registry.executeManual("page_shape_add", {
      mutationId: "full-page-shape",
      expectedRevision: 2,
      shape: "arrow",
    })).toMatchObject({
      outcome: "error",
      error: { code: "SAFE_PLACEMENT_UNAVAILABLE" },
    });
    expect(JSON.stringify(registry.getDocument())).toBe(before);

    await store.close();
  });

  it("preserves a caller-provided shape frame exactly", async () => {
    const store = storage("explicit-frame");
    const registry = await createPageCommandRegistry(store, createNotebookId("explicit-placement-workbook"));
    const frame = { x: 424, y: 280, width: 144, height: 80 };

    expect(await registry.executeManual("page_shape_add", {
      mutationId: "explicit-frame-shape",
      expectedRevision: 1,
      shape: "rectangle",
      frame,
    })).toMatchObject({
      outcome: "success",
      output: { context: { elements: [{ frame }] } },
    });

    await store.close();
  });
});
