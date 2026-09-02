import { fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import { PageSurface } from "../../../src/entries/desk/PageSurface";
import {
  createPageCommandRegistry,
  createElementId,
  createEmptyPage,
  type PageVectorInkElement,
  type VectorInkCommand,
  type VectorInkDocument,
  validatePage,
} from "../../../src/page";
import {
  VECTOR_INK_LIMITS,
  validateVectorInkDocument,
  validateVectorInkProvenance,
  vectorInkPaint,
  vectorInkPathData,
} from "../../../src/page/vector-ink";
import { createDetailedVectorInkFixture } from "../../helpers/detailed-vector-ink-fixture";

const at = createIsoInstant("2026-08-27T12:00:00.000Z");
let sequence = 0;

function databaseName(prefix: string): string {
  sequence += 1;
  return `phase6-vector-ink-${prefix}-${sequence}`;
}

const commands = [
  { kind: "move", x: 8, y: 8 },
  { kind: "line", x: 92, y: 8 },
  { kind: "line", x: 92, y: 92 },
  { kind: "line", x: 8, y: 92 },
  { kind: "close" },
] satisfies readonly VectorInkCommand[];

const paint = vectorInkPaint({
  stroke: "ink",
  strokeWidth: 2,
  fill: null,
  linecap: "round",
  linejoin: "round",
});

function documentFixture(): VectorInkDocument {
  return {
    version: 1,
    viewBox: { width: 100, height: 100 },
    paths: [{ commands, paint }],
  };
}

function elementFixture(): PageVectorInkElement {
  return {
    kind: "vector-ink",
    version: 1,
    id: createElementId("vector-ink-fixture"),
    label: "Vector figure",
    description: "A bounded editable vector figure.",
    frame: { x: 96, y: 280, width: 240, height: 180 },
    document: documentFixture(),
    provenance: { kind: "traced-visible-ink", sourceLabel: "local audit fixture" },
  };
}

describe("Phase 6 generic vector ink", () => {
  it("accepts a detailed-art-sized document inside the shared 512 KiB envelope", () => {
    const fixture = createDetailedVectorInkFixture();
    const validated = validateVectorInkDocument(fixture);
    const commandCount = validated.paths.reduce((total, path) => total + path.commands.length, 0);
    const serializedBytes = new TextEncoder().encode(JSON.stringify(fixture)).byteLength;

    expect(VECTOR_INK_LIMITS.maxSerializedBytes).toBe(512 * 1024);
    expect(serializedBytes).toBeLessThanOrEqual(VECTOR_INK_LIMITS.maxSerializedBytes);
    expect(commandCount).toBe(4_905);
    expect(validated.viewBox).toEqual({ width: 670, height: 154 });
  });

  it("accepts a small typed document and serializes commands without raw SVG", () => {
    const document = documentFixture();

    expect(validateVectorInkDocument(document)).toEqual(document);
    const path = vectorInkPathData(commands);
    expect(path).toMatch(/M\s*8(?:\.0+)?\s+8(?:\.0+)?/);
    expect(path).toMatch(/L\s*92(?:\.0+)?\s+92(?:\.0+)?/);
    expect(path).toMatch(/Z/);
    expect(JSON.stringify(document)).not.toContain("<svg");
    expect(VECTOR_INK_LIMITS.maxCommands).toBeGreaterThanOrEqual(20_000);
  });

  it("rejects unsafe coordinates, paint, command complexity, and serialized size", () => {
    expect(() => validateVectorInkDocument({
      ...documentFixture(),
      paths: [{ ...documentFixture().paths[0]!, commands: [{ kind: "line", x: 101, y: 50 }] }],
    })).toThrow(/viewBox|coordinate/i);

    expect(() => validateVectorInkDocument({
      ...documentFixture(),
      paths: [{ ...documentFixture().paths[0]!, commands: [{ kind: "close" }] }],
    })).toThrow(/path|move|geometry/i);

    expect(() => validateVectorInkDocument({
      ...documentFixture(),
      paths: [{ ...documentFixture().paths[0]!, paint: { ...paint, stroke: "rebeccapurple" } }],
    })).toThrow(/color|stroke/i);

    const tooManyCommands = Array.from({ length: 20_001 }, (_, index) => ({
      kind: "line" as const,
      x: index % 100,
      y: Math.floor(index / 100) % 100,
    }));
    expect(() => validateVectorInkDocument({
      ...documentFixture(),
      paths: [{ ...documentFixture().paths[0]!, commands: tooManyCommands }],
    })).toThrow(/command/i);

    const tooLarge = [
      { kind: "move" as const, x: 0, y: 0 },
      ...Array.from({ length: 17_999 }, (_, index) => ({
        kind: "line" as const,
        x: index % 100,
        y: Math.floor(index / 100) % 100,
      })),
    ];
    expect(JSON.stringify({ ...documentFixture(), paths: [{ ...documentFixture().paths[0]!, commands: tooLarge }] }).length)
      .toBeGreaterThan(VECTOR_INK_LIMITS.maxSerializedBytes);
    expect(() => validateVectorInkDocument({
      ...documentFixture(),
      paths: [{ ...documentFixture().paths[0]!, commands: tooLarge }],
    })).toThrow(/size|bytes|large/i);
  });

  it("rejects executable, remote, and machine-specific provenance strings", () => {
    for (const sourceLabel of ["javascript:alert(1)", "data:image/svg+xml", "C:\\private\\source.svg", "https://example.test/source.svg"]) {
      expect(() => validateVectorInkProvenance({ kind: "traced-visible-ink", sourceLabel })).toThrow(/provenance|portable/i);
    }
    expect(() => validateVectorInkProvenance({
      kind: "traced-visible-ink",
      sourceLabel: "Local audit fixture",
      checksum: "legacy-value",
    })).toThrow(/portable metadata/i);
  });

  it("rejects a vector frame below the domain minimum", () => {
    const page = createEmptyPage(createNotebookId("vector-frame"), 1, at);
    expect(() => validatePage({
      ...page,
      elements: [{ ...elementFixture(), frame: { x: 96, y: 280, width: 0.5, height: 10 } }],
    })).toThrow(/vector|minimum|size|dimension/i);
  });

  it("adds one vector figure through the typed command with receipt, revision, and WebMCP exposure", async () => {
    const storage = new IndexedDbPageStorage({ databaseName: databaseName("command"), clock: { now: () => at } });
    const registry = await createPageCommandRegistry(storage, createNotebookId("vector-command"));

    const vectorDescriptor = registry.describe("webmcp").find(({ name }) => name === "page_vector_ink_add");
    expect(vectorDescriptor).toBeDefined();
    expect(JSON.stringify(vectorDescriptor?.inputSchema)).toContain('"viewBox"');
    expect(JSON.stringify(vectorDescriptor?.inputSchema)).toContain('"commands"');
    const result = await registry.executeExternal("page_vector_ink_add", {
      mutationId: "vector-add",
      expectedRevision: 1,
      frame: elementFixture().frame,
      document: documentFixture(),
      label: "Vector figure",
      description: "A bounded editable vector figure.",
      provenance: elementFixture().provenance,
    }, "webmcp");

    expect(result).toMatchObject({
      outcome: "success",
      output: { context: { pageRevision: 2 }, receipt: { kind: "page_vector_ink_add" } },
    });
    expect(registry.getDocument().pages[0]?.elements[0]).toMatchObject({ kind: "vector-ink", version: 1 });
    if (result.outcome !== "success" || result.output.receipt === undefined) throw new Error("Expected vector receipt.");
    expect(await registry.executeExternal("page_undo", {
      mutationId: "vector-add-undo",
      receiptId: result.output.receipt.id,
    }, "webmcp")).toMatchObject({ outcome: "success", output: { context: { pageRevision: 3 } } });
    expect(registry.getDocument().pages[0]?.elements).toHaveLength(0);
    await storage.close();
  });

  it("fails closed when the requested frame obscures text", async () => {
    const storage = new IndexedDbPageStorage({ databaseName: databaseName("placement"), clock: { now: () => at } });
    const registry = await createPageCommandRegistry(storage, createNotebookId("vector-placement"));
    const text = await registry.executeManual("page_text_insert", {
      mutationId: "placement-text",
      expectedRevision: 1,
      text: "Readable source text",
      label: "Source text",
    });
    expect(text.outcome).toBe("success");

    const result = await registry.executeExternal("page_vector_ink_add", {
      mutationId: "unsafe-vector",
      expectedRevision: 2,
      frame: { x: 96, y: 92, width: 240, height: 120 },
      document: documentFixture(),
      label: "Unsafe vector",
      description: "This must not cover readable text.",
    }, "webmcp");
    expect(result).toMatchObject({ outcome: "error", error: { code: "SAFE_PLACEMENT_UNAVAILABLE" } });
    expect(registry.getSnapshot().pageRevision).toBe(2);
    await storage.close();
  });

  it("keeps canonical vector data unchanged through move and resize, then exactly undoes the resize", async () => {
    const storage = new IndexedDbPageStorage({ databaseName: databaseName("move-undo"), clock: { now: () => at } });
    const registry = await createPageCommandRegistry(storage, createNotebookId("vector-move-undo"));
    const added = await registry.executeManual("page_vector_ink_add", {
      mutationId: "vector-add",
      expectedRevision: 1,
      frame: elementFixture().frame,
      document: documentFixture(),
      label: "Vector figure",
      description: "A bounded editable vector figure.",
    });
    if (added.outcome !== "success" || added.output.receipt === undefined) throw new Error("Expected vector receipt.");
    const id = registry.getDocument().pages[0]?.elements[0]?.id;
    if (id === undefined) throw new Error("Expected vector element.");
    const original = registry.getDocument().pages[0]?.elements[0];
    const moved = await registry.executeManual("page_element_move", {
      mutationId: "vector-move",
      expectedRevision: 2,
      elementId: id,
      frame: { x: 120, y: 300, width: 240, height: 180 },
    });
    expect(moved.outcome).toBe("success");
    const resized = await registry.executeManual("page_element_resize", {
      mutationId: "vector-resize",
      expectedRevision: 3,
      elementId: id,
      frame: { x: 120, y: 300, width: 300, height: 210 },
    });
    if (resized.outcome !== "success" || resized.output.receipt === undefined) throw new Error("Expected resize receipt.");
    const current = registry.getDocument().pages[0]?.elements[0];
    expect(current).toMatchObject({ document: original && "document" in original ? original.document : undefined });

    const undone = await registry.executeManual("page_undo", {
      mutationId: "vector-resize-undo",
      receiptId: resized.output.receipt.id,
    });
    expect(undone).toMatchObject({ outcome: "success", output: { context: { pageRevision: 5 } } });
    expect(registry.getDocument().pages[0]?.elements[0]).toMatchObject({
      kind: "vector-ink",
      frame: { x: 120, y: 300, width: 240, height: 180 },
      document: original && "document" in original ? original.document : undefined,
    });
    await storage.close();
  });

  it("keeps a review callout attached to the exact vector figure after the figure moves", async () => {
    const storage = new IndexedDbPageStorage({ databaseName: databaseName("review-target"), clock: { now: () => at } });
    const registry = await createPageCommandRegistry(storage, createNotebookId("vector-review-target"));
    await registry.executeManual("page_vector_ink_add", {
      mutationId: "reviewed-vector",
      expectedRevision: 1,
      frame: elementFixture().frame,
      document: documentFixture(),
      label: "Reviewed vector figure",
      description: "A vector figure with an exact review relationship.",
    });
    const vectorId = registry.getDocument().pages[0]?.elements[0]?.id;
    if (vectorId === undefined) throw new Error("Expected vector element.");

    const reviewed = await registry.executeExternal("page_review_callout_add", {
      mutationId: "vector-review-callout",
      expectedRevision: 2,
      target: { kind: "element", elementId: vectorId },
      reviewKind: "explanation",
      text: "These four views show the same bounded source figure.",
    }, "webmcp");
    expect(reviewed).toMatchObject({ outcome: "success", output: { context: { pageRevision: 3 } } });

    const moved = await registry.executeManual("page_element_move", {
      mutationId: "reviewed-vector-move",
      expectedRevision: 3,
      elementId: vectorId,
      frame: { x: 420, y: 500, width: 240, height: 180 },
    });
    expect(moved).toMatchObject({ outcome: "success", output: { context: { pageRevision: 4 } } });
    expect(registry.getDocument().pages[0]?.elements.find((element) => element.kind === "annotation")).toMatchObject({
      kind: "annotation",
      annotation: "label",
      anchor: { kind: "element", elementId: vectorId },
    });
    await storage.close();
  });

  it("reopens the persisted vector figure from IndexedDB", async () => {
    const name = databaseName("reopen");
    const workbookId = createNotebookId("vector-reopen");
    const firstStorage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => at } });
    const first = await createPageCommandRegistry(firstStorage, workbookId);
    await first.executeManual("page_vector_ink_add", {
      mutationId: "vector-persist",
      expectedRevision: 1,
      frame: elementFixture().frame,
      document: documentFixture(),
      label: "Vector figure",
      description: "A bounded editable vector figure.",
    });
    await firstStorage.close();

    const reopenedStorage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => at } });
    const reopened = await createPageCommandRegistry(reopenedStorage, workbookId);
    expect(reopened.getDocument().pages[0]?.elements[0]).toMatchObject({ kind: "vector-ink", document: documentFixture() });
    await reopenedStorage.close();
  });

  it("renders vector ink in the canonical scene and semantic copy", () => {
    const page = createEmptyPage(createNotebookId("vector-surface"), 1, at);
    const element = elementFixture();
    const { container } = render(createElement(PageSurface, {
      page: { ...page, elements: [element] },
      notebookTitle: "Vector surface",
      focused: true,
      writingStyle: "typed",
      onFocus: () => undefined,
      graphics: { kind: "svg" },
    }));

    expect(container.querySelector('.page-scene [data-element-kind="vector-ink"]')).toBeInTheDocument();
    expect(container.querySelector('.page-scene [data-element-kind="vector-ink"] path')).toHaveAttribute("d", expect.stringContaining("M"));
    expect(container.querySelector('figure[aria-label="Vector figure"]')).toHaveTextContent("A bounded editable vector figure.");
    expect(container.querySelector(".tl-container")).not.toBeInTheDocument();
    fireEvent.click(container.querySelector("article")!);
  });
});
