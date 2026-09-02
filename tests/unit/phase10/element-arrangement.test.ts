import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import {
  createActorId,
  createDocumentRevision,
  createElementId,
  createMutationId,
  createPageCommandRegistry,
  createPageRevision,
  validatePage,
  validatePageDocument,
  type PageCommandRegistry,
  type PageRect,
  type VectorInkCommand,
  type VectorInkDocument,
} from "../../../src/page";

const at = createIsoInstant("2026-08-29T14:00:00.000Z");
let sequence = 0;

function storage(prefix: string): Readonly<{ databaseName: string; storage: IndexedDbPageStorage }> {
  sequence += 1;
  const databaseName = `phase10-element-arrangement-${prefix}-${sequence}`;
  return {
    databaseName,
    storage: new IndexedDbPageStorage({ databaseName, clock: { now: () => at } }),
  };
}

async function receiptCount(databaseName: string): Promise<number> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the page database."));
  });
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = database.transaction("pageReceipts", "readonly").objectStore("pageReceipts").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not count page receipts."));
    });
  } finally {
    database.close();
  }
}

async function durableState(registry: PageCommandRegistry, databaseName: string): Promise<string> {
  return JSON.stringify({
    document: registry.getDocument(),
    context: registry.getSnapshot(),
    receipts: await receiptCount(databaseName),
  });
}

const vectorCommands = [
  { kind: "move", x: 8, y: 8 },
  { kind: "line", x: 92, y: 8 },
  { kind: "line", x: 92, y: 92 },
  { kind: "line", x: 8, y: 92 },
  { kind: "close" },
] satisfies readonly VectorInkCommand[];

const vectorDocument: VectorInkDocument = {
  version: 1,
  viewBox: { width: 100, height: 100 },
  paths: [{
    commands: vectorCommands,
    paint: {
      stroke: "ink",
      strokeWidth: 2,
      fill: null,
      linecap: "round",
      linejoin: "round",
    },
  }],
};

describe("Phase 10 exact element arrangement", () => {
  it("is manual-only, commits once, deduplicates Apply, and exactly undoes rich text placement", async () => {
    const fixture = storage("text-history");
    try {
      const registry = await createPageCommandRegistry(fixture.storage, createNotebookId("phase10-text-history"));
      expect(registry.describe("webmcp").map(({ name }) => name)).not.toContain("page_element_frame_set");
      expect(registry.describe("manual")).toContainEqual(expect.objectContaining({
        name: "page_element_frame_set",
        exposure: expect.objectContaining({ manual: true, webmcp: false }),
      }));

      const inserted = await registry.executeManual("page_text_insert", {
        mutationId: "phase10-text-add",
        expectedRevision: 1,
        text: "Arrange one exact element.",
        label: "Arrangement note",
        frame: { x: 96, y: 92, width: 260, height: 120 },
      });
      expect(inserted.outcome).toBe("success");
      const beforePage = registry.getDocument().pages[0]!;
      const beforeElement = beforePage.elements[0];
      if (beforeElement?.kind !== "text") throw new Error("Expected text.");
      const input = {
        mutationId: "phase10-text-arrange",
        pageId: beforePage.id,
        expectedRevision: beforePage.revision,
        elementId: beforeElement.id,
        frame: { x: 120, y: 260, width: 300, height: 140 },
      } as const;

      const applied = await registry.executeManual("page_element_frame_set", input);
      expect(applied).toMatchObject({
        outcome: "success",
        output: { context: { pageRevision: 3 }, receipt: { kind: "page_element_frame_set" } },
      });
      if (applied.outcome !== "success" || applied.output.receipt === undefined) throw new Error("Expected arrangement receipt.");
      const afterElement = registry.getDocument().pages[0]?.elements[0];
      if (afterElement?.kind !== "text") throw new Error("Expected arranged text.");
      expect(afterElement.id).toBe(beforeElement.id);
      expect(afterElement.content).toEqual(beforeElement.content);
      expect(afterElement.frame).toEqual(input.frame);

      const duplicate = await registry.executeManual("page_element_frame_set", input);
      expect(duplicate).toEqual(applied);
      expect(registry.getSnapshot().pageRevision).toBe(3);
      expect(await receiptCount(fixture.databaseName)).toBe(2);

      const undone = await registry.executeManual("page_undo", {
        mutationId: "phase10-text-arrange-undo",
        receiptId: applied.output.receipt.id,
      });
      expect(undone).toMatchObject({ outcome: "success", output: { context: { pageRevision: 4 } } });
      expect(registry.getDocument().pages[0]?.elements[0]).toEqual(beforeElement);
    } finally {
      await fixture.storage.close();
    }
  });

  it("preserves stroke semantics, shape paint, vector authority, and diagram documents", async () => {
    const fixture = storage("typed-preservation");
    try {
      const registry = await createPageCommandRegistry(fixture.storage, createNotebookId("phase10-typed-preservation"));
      await registry.executeManual("page_stroke_add", {
        mutationId: "phase10-stroke-add",
        expectedRevision: 1,
        elementId: "phase10-stroke",
        points: [{ x: 100, y: 180, pressure: 0.25 }, { x: 160, y: 220, pressure: 0.75 }],
        color: "navy",
        width: 3,
      });
      await registry.executeManual("page_shape_add", {
        mutationId: "phase10-shape-add",
        expectedRevision: 2,
        elementId: "phase10-shape",
        shape: "ellipse",
        label: "Neutral marker",
        frame: { x: 560, y: 160, width: 96, height: 96 },
        fill: "yellow",
        stroke: "green",
      });
      await registry.executeManual("page_vector_ink_add", {
        mutationId: "phase10-vector-add",
        expectedRevision: 3,
        frame: { x: 96, y: 420, width: 240, height: 180 },
        document: vectorDocument,
        label: "Neutral vector figure",
        description: "A generic typed vector arrangement fixture.",
        provenance: { kind: "typed-vector", sourceLabel: "neutral acceptance fixture" },
      });
      await registry.executeManual("page_diagram_add", {
        mutationId: "phase10-diagram-add",
        expectedRevision: 4,
        template: "relationship-map",
        frame: { x: 400, y: 620, width: 320, height: 240 },
      });
      const page = registry.getDocument().pages[0]!;
      const beforeById = new Map(page.elements.map((element) => [element.id, element]));
      const frames = new Map<string, PageRect>([
        ["phase10-stroke", { x: 120, y: 260, width: 90, height: 60 }],
        ["phase10-shape", { x: 560, y: 300, width: 120, height: 108 }],
      ]);
      let expectedRevision: number = page.revision;
      for (const [elementId, frame] of frames) {
        const result = await registry.executeManual("page_element_frame_set", {
          mutationId: `phase10-arrange-${elementId}`,
          expectedRevision,
          elementId,
          frame,
        });
        expect(result.outcome).toBe("success");
        expectedRevision += 1;
      }
      const vector = page.elements.find((element) => element.kind === "vector-ink")!;
      const vectorResult = await registry.executeManual("page_element_frame_set", {
        mutationId: "phase10-arrange-vector",
        expectedRevision,
        elementId: vector.id,
        frame: { x: 400, y: 420, width: 240, height: 180 },
      });
      expect(vectorResult.outcome).toBe("success");
      expectedRevision += 1;
      const diagram = page.elements.find((element) => element.kind === "diagram")!;
      const diagramResult = await registry.executeManual("page_element_frame_set", {
        mutationId: "phase10-arrange-diagram",
        expectedRevision,
        elementId: diagram.id,
        frame: { x: 96, y: 700, width: 320, height: 240 },
      });
      expect(diagramResult.outcome).toBe("success");

      const afterById = new Map(registry.getDocument().pages[0]!.elements.map((element) => [element.id, element]));
      const beforeStroke = beforeById.get(createElementId("phase10-stroke"));
      const afterStroke = afterById.get(createElementId("phase10-stroke"));
      if (beforeStroke?.kind !== "stroke" || afterStroke?.kind !== "stroke") throw new Error("Expected stroke.");
      expect(afterStroke.points.map((point) => point.pressure)).toEqual(beforeStroke.points.map((point) => point.pressure));
      expect({ color: afterStroke.color, width: afterStroke.width }).toEqual({ color: beforeStroke.color, width: beforeStroke.width });
      const beforeShape = beforeById.get(createElementId("phase10-shape"));
      const afterShape = afterById.get(createElementId("phase10-shape"));
      if (beforeShape?.kind !== "shape" || afterShape?.kind !== "shape") throw new Error("Expected shape.");
      expect({ shape: afterShape.shape, fill: afterShape.fill, stroke: afterShape.stroke }).toEqual({
        shape: beforeShape.shape,
        fill: beforeShape.fill,
        stroke: beforeShape.stroke,
      });
      const afterVector = afterById.get(vector.id);
      if (afterVector?.kind !== "vector-ink" || vector.kind !== "vector-ink") throw new Error("Expected vector ink.");
      expect({ document: afterVector.document, provenance: afterVector.provenance, replacementHistory: afterVector.replacementHistory })
        .toEqual({ document: vector.document, provenance: vector.provenance, replacementHistory: vector.replacementHistory });
      const afterDiagram = afterById.get(diagram.id);
      if (afterDiagram?.kind !== "diagram" || diagram.kind !== "diagram") throw new Error("Expected diagram.");
      expect(afterDiagram.document).toEqual(diagram.document);
    } finally {
      await fixture.storage.close();
    }
  });

  it("rejects no-op, malformed, unsafe, missing, selector-like, and stale requests without a durable change", async () => {
    const fixture = storage("fail-closed");
    try {
      const registry = await createPageCommandRegistry(fixture.storage, createNotebookId("phase10-fail-closed"));
      await registry.executeManual("page_text_insert", {
        mutationId: "phase10-fail-text",
        expectedRevision: 1,
        text: "Keep this exact page unchanged.",
        label: "Guarded note",
        frame: { x: 96, y: 92, width: 260, height: 120 },
      });
      await registry.executeManual("page_shape_add", {
        mutationId: "phase10-fail-collision-target",
        expectedRevision: 2,
        elementId: "phase10-collision-target",
        shape: "rectangle",
        frame: { x: 460, y: 92, width: 160, height: 120 },
      });
      const page = registry.getDocument().pages[0]!;
      const target = page.elements[0]!;
      const before = await durableState(registry, fixture.databaseName);
      const cases = [
        { name: "no-op", expectedRevision: 3, elementId: target.id, frame: target.frame, code: "SAFE_PLACEMENT_UNAVAILABLE" },
        { name: "negative", expectedRevision: 3, elementId: target.id, frame: { ...target.frame, width: -1 }, code: "INPUT_VALIDATION_ERROR" },
        { name: "non-finite", expectedRevision: 3, elementId: target.id, frame: { ...target.frame, width: Number.NaN }, code: "INPUT_VALIDATION_ERROR" },
        { name: "too-small", expectedRevision: 3, elementId: target.id, frame: { ...target.frame, width: 40, height: 10 }, code: "SAFE_PLACEMENT_UNAVAILABLE" },
        { name: "oversized", expectedRevision: 3, elementId: target.id, frame: { x: 0, y: 0, width: 8_000, height: 8_000 }, code: "SAFE_PLACEMENT_UNAVAILABLE" },
        { name: "collision", expectedRevision: 3, elementId: target.id, frame: { x: 440, y: 92, width: 260, height: 120 }, code: "SAFE_PLACEMENT_UNAVAILABLE" },
        { name: "missing", expectedRevision: 3, elementId: "phase10-missing", frame: { ...target.frame, y: 300 }, code: "TARGET_NOT_FOUND" },
        { name: "selector", expectedRevision: 3, elementId: { kind: "phrase", phrase: "Guarded" }, frame: { ...target.frame, y: 300 }, code: "INPUT_VALIDATION_ERROR" },
        { name: "stale", expectedRevision: 2, elementId: target.id, frame: { ...target.frame, y: 300 }, code: "REVISION_CONFLICT" },
      ] as const;
      for (const rejected of cases) {
        const result = await registry.executeManual("page_element_frame_set", {
          mutationId: `phase10-reject-${rejected.name}`,
          expectedRevision: rejected.expectedRevision,
          elementId: rejected.elementId,
          frame: rejected.frame,
        });
        expect(result, rejected.name).toMatchObject({ outcome: "error", error: { code: rejected.code } });
        expect(await durableState(registry, fixture.databaseName), rejected.name).toBe(before);
      }
    } finally {
      await fixture.storage.close();
    }
  });

  it("rejects embedded frames and anchor-derived marks without another receipt", async () => {
    const fixture = storage("unsupported-targets");
    try {
      const registry = await createPageCommandRegistry(fixture.storage, createNotebookId("phase10-unsupported-targets"));
      await registry.executeManual("page_text_insert", {
        mutationId: "phase10-anchor-source",
        expectedRevision: 1,
        text: "Anchored source",
        frame: { x: 96, y: 92, width: 240, height: 120 },
      });
      const source = registry.getDocument().pages[0]!.elements[0]!;
      await registry.executeManual("page_annotation_add", {
        mutationId: "phase10-anchor-mark",
        expectedRevision: 2,
        target: { kind: "element", elementId: source.id },
        annotation: "highlight",
      });
      const mark = registry.getDocument().pages[0]!.elements.find((element) => element.kind === "annotation")!;
      const current = registry.getDocument();
      const page = current.pages[0]!;
      const embedded = {
        kind: "embedded-frame" as const,
        id: createElementId("phase10-embedded"),
        label: "Unsupported embedded frame",
        frame: { x: 460, y: 420, width: 220, height: 160 },
        componentType: "local-fixture",
        componentVersion: 1,
        props: {},
      };
      const nextPage = validatePage({
        ...page,
        revision: createPageRevision(page.revision + 1),
        updatedAt: at,
        elements: [...page.elements, embedded],
      });
      const nextDocument = validatePageDocument({ ...current, pages: [nextPage], documentRevision: createDocumentRevision(current.documentRevision) });
      await fixture.storage.commit({
        workbookId: current.workbookId,
        nextDocument,
        pageIds: [page.id],
        expectedDocumentRevision: current.documentRevision,
        expectedPageRevisions: { [page.id]: page.revision },
        mutationId: createMutationId("phase10-unsupported-fixture"),
        actorId: createActorId("phase10-test-fixture"),
        source: "person",
        kind: "phase10_test_fixture",
      });
      await registry.refresh();
      const before = await durableState(registry, fixture.databaseName);
      for (const target of [mark, embedded]) {
        const result = await registry.executeManual("page_element_frame_set", {
          mutationId: `phase10-reject-${target.kind}`,
          expectedRevision: 4,
          elementId: target.id,
          frame: { ...target.frame, y: target.frame.y + 24 },
        });
        expect(result).toMatchObject({ outcome: "error", error: { code: "SAFE_PLACEMENT_UNAVAILABLE" } });
        expect(await durableState(registry, fixture.databaseName)).toBe(before);
      }
    } finally {
      await fixture.storage.close();
    }
  });
});
