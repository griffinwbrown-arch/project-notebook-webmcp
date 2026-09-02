import { describe, expect, it } from "vitest";

import { createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import { createPageCommandRegistry, deactivatePageWebMcpTools, layoutPage, registerPageWebMcpTools, textRangeRects } from "../../../src/page";
import type { WebMcpTool } from "../../../src/types/webmcp";

let sequence = 0;

function storage(prefix: string): IndexedDbPageStorage {
  sequence += 1;
  return new IndexedDbPageStorage({
    databaseName: `phase3-command-${prefix}-${sequence}`,
    clock: { now: () => "2026-08-26T16:00:00.000Z" },
  });
}

describe("Phase 3 canonical page command registry", () => {
  it("routes manual and WebMCP writes through the same revision and receipt path", async () => {
    const store = storage("shared");
    const registry = await createPageCommandRegistry(store, createNotebookId("command-workbook"));

    const manual = await registry.executeManual("page_text_insert", {
      mutationId: "manual-1",
      expectedRevision: 1,
      text: "Project kickoff Friday",
      label: "Kickoff",
    });
    expect(manual).toMatchObject({ outcome: "success", output: { context: { pageRevision: 2 } } });

    const external = await registry.executeExternal("page_text_format", {
      mutationId: "assistant-1",
      actorId: "assistant:work-chat",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "Project kickoff" },
      marks: ["bold"],
    }, "webmcp");
    expect(external).toMatchObject({ outcome: "success", output: { context: { pageRevision: 3 } } });
    if (external.outcome === "success") {
      expect(external.output.receipt?.source).toBe("assistant");
      expect(external.output.receipt).not.toHaveProperty("beforeDocument");
      expect(external.output.context.elements[0]).toMatchObject({
        blockIds: ["phase3:block:manual-1"],
      });
      const undone = await registry.executeExternal("page_undo", {
        mutationId: "assistant-undo",
        actorId: "assistant:work-chat",
        receiptId: external.output.receipt?.id,
      }, "webmcp");
      expect(undone).toMatchObject({ outcome: "success", output: { context: { pageRevision: 4 } } });
    }
    await store.close();
  });

  it("inserts headings with a valid following paragraph block", async () => {
    const store = storage("heading");
    const registry = await createPageCommandRegistry(store, createNotebookId("heading-workbook"));
    const result = await registry.executeManual("page_text_insert", {
      mutationId: "heading-insert",
      expectedRevision: 1,
      text: "A useful heading",
      blockKind: "heading",
    });
    expect(result.outcome).toBe("success");
    const element = registry.getDocument().pages[0]?.elements[0];
    expect(element?.kind).toBe("text");
    if (element?.kind === "text") {
      expect(element.content.blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
    }
    await store.close();
  });

  it("persists paper style and page size in canonical context", async () => {
    const store = storage("presentation");
    const registry = await createPageCommandRegistry(store, createNotebookId("presentation-workbook"));
    expect(await registry.executeManual("page_presentation_set", {
      mutationId: "presentation-change",
      expectedRevision: 1,
      paper: "blank",
      sizePreset: "a4",
    })).toMatchObject({
      outcome: "success",
      output: { context: { paper: "blank", pageSize: { width: 794, height: 1123 }, pageRevision: 2 } },
    });
    const reopened = await createPageCommandRegistry(store, createNotebookId("presentation-workbook"));
    expect(reopened.getSnapshot()).toMatchObject({ paper: "blank", pageSize: { width: 794, height: 1123 } });
    await store.close();
  });

  it("reads visible spread pages in display order while preserving focus", async () => {
    const store = storage("visible-spread");
    const registry = await createPageCommandRegistry(store, createNotebookId("visible-spread-workbook"));
    const firstPageId = registry.getSnapshot().focusedPageId;
    const advanced = await registry.executeManual("page_advance", {
      mutationId: "visible-spread-page-2",
      expectedDocumentRevision: 1,
    });
    expect(advanced.outcome).toBe("success");
    const secondPageId = registry.getSnapshot().focusedPageId;
    registry.setViewContext({ presentation: "spread", visiblePageIds: [firstPageId, secondPageId] });

    const read = await registry.executeExternal("page_context_read", {}, "webmcp");
    expect(read).toMatchObject({
      outcome: "success",
      output: {
        context: {
          focusedPageId: secondPageId,
          presentation: "spread",
          visiblePageIds: [firstPageId, secondPageId],
          visiblePages: [
            { pageId: firstPageId, pageNumber: 1 },
            { pageId: secondPageId, pageNumber: 2 },
          ],
        },
      },
    });
    await store.close();
  });

  it("acknowledges an existing next page immediately", async () => {
    const store = storage("existing-next-page");
    const registry = await createPageCommandRegistry(store, createNotebookId("existing-next-page-workbook"));
    const firstPageId = registry.getSnapshot().focusedPageId;
    const created = await registry.executeManual("page_advance", {
      mutationId: "create-next-page",
      expectedDocumentRevision: 1,
    });
    expect(created).toMatchObject({ outcome: "success", output: { context: { focusedPageNumber: 2 } } });
    const secondPageId = registry.getSnapshot().focusedPageId;

    registry.focusPage(firstPageId);
    const advanced = await registry.executeExternal("page_advance", {
      mutationId: "open-existing-next-page",
      expectedDocumentRevision: 2,
    }, "webmcp");

    expect(advanced).toMatchObject({ outcome: "success", output: { context: { focusedPageId: secondPageId, focusedPageNumber: 2 } } });
    expect(registry.getSnapshot()).toMatchObject({ focusedPageId: secondPageId, visiblePageIds: [secondPageId] });
    await store.close();
  });

  it("resolves an exact visible phrase without stealing spread focus", async () => {
    const store = storage("target-resolution");
    const registry = await createPageCommandRegistry(store, createNotebookId("target-resolution-workbook"));
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "target-resolution-text",
      expectedRevision: 1,
      text: "Alpha iW target",
      label: "Resolution proof",
    });
    expect(inserted.outcome).toBe("success");
    const firstPageId = registry.getSnapshot().focusedPageId;
    const targetElement = registry.getDocument().pages[0]!.elements[0]!;
    if (targetElement.kind !== "text") throw new Error("Expected text target.");
    const blockId = targetElement.content.blocks[0]!.id;
    await registry.executeManual("page_advance", {
      mutationId: "target-resolution-page-2",
      expectedDocumentRevision: 1,
    });
    const secondPageId = registry.getSnapshot().focusedPageId;
    registry.setViewContext({ presentation: "spread", visiblePageIds: [firstPageId, secondPageId] });

    const resolved = await registry.executeExternal("page_target_resolve", {
      target: { kind: "phrase", value: "iW" },
    }, "webmcp");
    const expectedBoxes = textRangeRects(layoutPage(registry.getDocument().pages[0]!), {
      kind: "text-range",
      elementId: targetElement.id,
      blockId,
      start: 6,
      end: 8,
    });
    expect(resolved).toMatchObject({
      outcome: "success",
      output: {
        context: { focusedPageId: secondPageId },
        resolution: {
          kind: "text-range",
          pageId: firstPageId,
          pageNumber: 1,
          elementId: targetElement.id,
          blockId,
          start: 6,
          end: 8,
          label: "Resolution proof",
          preview: "iW",
          boxes: expectedBoxes,
        },
      },
    });

    const annotated = await registry.executeExternal("page_annotation_add", {
      mutationId: "target-resolution-circle",
      pageId: firstPageId,
      expectedRevision: 2,
      target: { kind: "text-range", elementId: targetElement.id, blockId, start: 6, end: 8 },
      annotation: "circle",
    }, "webmcp");
    expect(annotated).toMatchObject({ outcome: "success", output: { context: { focusedPageId: secondPageId, pageRevision: 1 } } });
    expect(registry.getDocument().pages[0]!.revision).toBe(3);
    expect(registry.getSnapshot().focusedPageId).toBe(secondPageId);
    await store.close();
  });

  it("anchors a circle to the shared variable-width text layout", async () => {
    const store = storage("annotation-frame");
    const registry = await createPageCommandRegistry(store, createNotebookId("annotation-frame-workbook"));
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "circle-target",
      expectedRevision: 1,
      text: "iW",
    });
    expect(inserted.outcome).toBe("success");
    const circled = await registry.executeExternal("page_annotation_add", {
      mutationId: "circle-proof",
      actorId: "assistant:work-chat",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "W" },
      annotation: "circle",
    }, "webmcp");
    expect(circled.outcome).toBe("success");
    if (circled.outcome === "success") {
      const circle = circled.output.context.elements.find((element) => element.kind === "annotation");
      const page = registry.getDocument().pages[0]!;
      const annotation = page.elements.find((element) => element.kind === "annotation")!;
      if (annotation.kind !== "annotation" || annotation.anchor.kind !== "text-range") throw new Error("Expected a text-range annotation.");
      const targetRect = textRangeRects(layoutPage(page), annotation.anchor)[0]!;
      if (circle?.frame === undefined) throw new Error("Expected a rendered annotation frame.");
      expect(circle.frame.x).toBeCloseTo(targetRect.x - 8, 8);
      expect(circle.frame.y).toBeCloseTo(targetRect.y - 8, 8);
      expect(circle.frame.width).toBeCloseTo(targetRect.width + 16, 8);
      expect(circle.frame.height).toBeCloseTo(targetRect.height + 16, 8);
    }
    await store.close();
  });

  it("connects a named page object to a diagram target with an arrow", async () => {
    const store = storage("connected-arrow");
    const registry = await createPageCommandRegistry(store, createNotebookId("connected-arrow-workbook"));
    const note = await registry.executeManual("page_text_insert", {
      mutationId: "connected-arrow-note",
      expectedRevision: 1,
      text: "Explain why this step needs evidence.",
      frame: { x: 96, y: 360, width: 280, height: 52 },
    });
    expect(note.outcome).toBe("success");
    const noteElement = registry.getDocument().pages[0]!.elements[0]!;

    const diagram = await registry.executeManual("page_shape_add", {
      mutationId: "connected-arrow-diagram",
      expectedRevision: 2,
      shape: "rectangle",
      label: "Evidence diagram",
      frame: { x: 440, y: 180, width: 180, height: 96 },
      fill: null,
      stroke: "#2d463b",
    });
    expect(diagram.outcome).toBe("success");
    const diagramElement = registry.getDocument().pages[0]!.elements[1]!;

    const arrow = await registry.executeExternal("page_annotation_add", {
      mutationId: "connected-arrow",
      actorId: "assistant:work-chat",
      expectedRevision: 3,
      target: { kind: "element", elementId: diagramElement.id },
      annotation: "arrow",
      sourceElementId: noteElement.id,
    }, "webmcp");

    expect(arrow.outcome).toBe("success");
    const annotation = registry.getDocument().pages[0]!.elements.at(-1);
    expect(annotation).toMatchObject({
      kind: "annotation",
      annotation: "arrow",
      sourceElementId: noteElement.id,
      anchor: { kind: "element", elementId: diagramElement.id },
    });
    await store.close();
  });

  it("creates one explicit review callout and undoes it as one revision", async () => {
    const store = storage("review-callout");
    const registry = await createPageCommandRegistry(store, createNotebookId("review-callout-workbook"));
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "review-target",
      expectedRevision: 1,
      text: "Replace the source wording after review.",
      label: "Source wording",
      frame: { x: 96, y: 96, width: 360, height: 96 },
    });
    expect(inserted.outcome).toBe("success");

    const reviewed = await registry.executeExternal("page_review_callout_add", {
      mutationId: "review-callout",
      actorId: "assistant:reviewer",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "source wording" },
      reviewKind: "replacement",
      text: "Use verified wording instead.",
    }, "webmcp");

    expect(reviewed).toMatchObject({
      outcome: "success",
      output: {
        context: {
          pageRevision: 3,
          elements: [
            expect.objectContaining({ kind: "text" }),
            expect.objectContaining({
              id: "phase3:mutation:review-callout",
              kind: "annotation",
              relationship: {
                kind: "review-callout",
                sourceElementId: "phase3:mutation:review-callout",
                target: expect.objectContaining({ kind: "text-range" }),
                reviewKind: "replacement",
              },
            }),
          ],
        },
        receipt: {
          kind: "page_review_callout_add",
          resultingPageRevisions: expect.objectContaining({
            "phase3:review-callout-workbook:page:1": 3,
          }),
        },
      },
    });
    if (reviewed.outcome !== "success") throw new Error("The review callout should succeed.");
    const page = registry.getDocument().pages[0]!;
    const target = page.elements[0]!;
    const callout = page.elements[1]!;
    expect(callout.kind).toBe("annotation");
    expect(callout.frame.x >= target.frame.x + target.frame.width ||
      callout.frame.y >= target.frame.y + target.frame.height ||
      callout.frame.x + callout.frame.width <= target.frame.x ||
      callout.frame.y + callout.frame.height <= target.frame.y).toBe(true);

    const undone = await registry.executeExternal("page_undo", {
      mutationId: "review-callout-undo",
      actorId: "assistant:reviewer",
      receiptId: reviewed.output.receipt?.id,
    }, "webmcp");
    expect(undone).toMatchObject({ outcome: "success", output: { context: { pageRevision: 4 } } });
    expect(registry.getDocument().pages[0]!.elements).toHaveLength(1);
    await store.close();
  });

  it("targets existing ink and shape objects with review callouts", async () => {
    const store = storage("review-object-targets");
    const registry = await createPageCommandRegistry(store, createNotebookId("review-object-workbook"));
    await registry.executeManual("page_stroke_add", {
      mutationId: "review-ink",
      expectedRevision: 1,
      points: [{ x: 120, y: 180 }, { x: 220, y: 210 }],
    });
    await registry.executeManual("page_shape_add", {
      mutationId: "review-shape",
      expectedRevision: 2,
      shape: "rectangle",
      frame: { x: 460, y: 180, width: 120, height: 80 },
    });

    const ink = await registry.executeExternal("page_review_callout_add", {
      mutationId: "review-ink-callout",
      expectedRevision: 3,
      target: { kind: "element", elementId: "phase3:mutation:review-ink" },
      reviewKind: "explanation",
      text: "This stroke needs a clearer direction.",
    }, "webmcp");
    expect(ink).toMatchObject({ outcome: "success", output: { context: { pageRevision: 4 } } });

    const shape = await registry.executeExternal("page_review_callout_add", {
      mutationId: "review-shape-callout",
      expectedRevision: 4,
      target: { kind: "element", elementId: "phase3:mutation:review-shape" },
      reviewKind: "replacement",
      text: "Replace this box with the approved step.",
    }, "webmcp");
    expect(shape).toMatchObject({ outcome: "success", output: { context: { pageRevision: 5 } } });
    await store.close();
  });

  it("fails closed for ambiguous targets and pages without a safe callout position", async () => {
    const ambiguousStore = storage("review-ambiguous");
    const ambiguousRegistry = await createPageCommandRegistry(ambiguousStore, createNotebookId("review-ambiguous-workbook"));
    await ambiguousRegistry.executeManual("page_text_insert", {
      mutationId: "review-ambiguous-a",
      expectedRevision: 1,
      text: "Repeated review phrase",
    });
    await ambiguousRegistry.executeManual("page_text_insert", {
      mutationId: "review-ambiguous-b",
      expectedRevision: 2,
      text: "Repeated review phrase",
    });
    const ambiguousBefore = JSON.stringify(ambiguousRegistry.getDocument());
    expect(await ambiguousRegistry.executeExternal("page_review_callout_add", {
      mutationId: "review-ambiguous-callout",
      expectedRevision: 3,
      target: { kind: "phrase", phrase: "Repeated review phrase" },
      reviewKind: "explanation",
      text: "Clarify this statement.",
    }, "webmcp")).toMatchObject({ outcome: "error", error: { code: "TARGET_AMBIGUOUS" } });
    expect(JSON.stringify(ambiguousRegistry.getDocument())).toBe(ambiguousBefore);
    await ambiguousStore.close();

    const fullStore = storage("review-full-page");
    const fullRegistry = await createPageCommandRegistry(fullStore, createNotebookId("review-full-page-workbook"));
    await fullRegistry.executeManual("page_text_insert", {
      mutationId: "review-full-target",
      expectedRevision: 1,
      text: "No safe margin remains.",
      frame: { x: 72, y: 64, width: 672, height: 928 },
    });
    const fullBefore = JSON.stringify(fullRegistry.getDocument());
    expect(await fullRegistry.executeExternal("page_review_callout_add", {
      mutationId: "review-full-callout",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "safe margin" },
      reviewKind: "explanation",
      text: "This cannot cover the document.",
    }, "webmcp")).toMatchObject({ outcome: "error", error: { code: "SAFE_PLACEMENT_UNAVAILABLE" } });
    expect(JSON.stringify(fullRegistry.getDocument())).toBe(fullBefore);
    await fullStore.close();
  });

  it("places labels outside readable text", async () => {
    const store = storage("label-frame");
    const registry = await createPageCommandRegistry(store, createNotebookId("label-frame-workbook"));
    await registry.executeManual("page_text_insert", {
      mutationId: "label-target",
      expectedRevision: 1,
      text: "Label this phrase without covering the sentence",
    });
    const labelled = await registry.executeExternal("page_annotation_add", {
      mutationId: "label-proof",
      expectedRevision: 2,
      target: { kind: "phrase", phrase: "Label this phrase" },
      annotation: "label",
      text: "Review this",
    }, "webmcp");
    expect(labelled.outcome).toBe("success");
    if (labelled.outcome === "success") {
      const text = labelled.output.context.elements.find((element) => element.kind === "text")!;
      const label = labelled.output.context.elements.find((element) => element.kind === "annotation")!;
      const overlaps = label.frame.x < text.frame.x + text.frame.width &&
        label.frame.x + label.frame.width > text.frame.x &&
        label.frame.y < text.frame.y + text.frame.height &&
        label.frame.y + label.frame.height > text.frame.y;
      expect(overlaps).toBe(false);
    }
    await store.close();
  });

  it("keeps anchored annotations attached when their target is resized", async () => {
    const store = storage("resize-anchor");
    const registry = await createPageCommandRegistry(store, createNotebookId("resize-anchor-workbook"));
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "resize-target",
      expectedRevision: 1,
      text: "Resize this target",
    });
    expect(inserted.outcome).toBe("success");
    const targetId = inserted.outcome === "success" ? inserted.output.context.elements[0]!.id : "";
    const annotated = await registry.executeManual("page_annotation_add", {
      mutationId: "resize-annotation",
      expectedRevision: 2,
      target: { kind: "element", elementId: targetId },
      annotation: "highlight",
    });
    expect(annotated.outcome).toBe("success");
    const before = annotated.outcome === "success"
      ? annotated.output.context.elements.find((element) => element.kind === "annotation")!.frame
      : null;
    const resized = await registry.executeManual("page_element_resize", {
      mutationId: "resize-target-frame",
      expectedRevision: 3,
      elementId: targetId,
      frame: { x: 96, y: 92, width: 400, height: 120 },
    });
    expect(resized.outcome).toBe("success");
    if (resized.outcome === "success") {
      const after = resized.output.context.elements.find((element) => element.kind === "annotation")!.frame;
      expect(after).not.toEqual(before);
      expect(after.width).toBeLessThan(before?.width ?? Number.POSITIVE_INFINITY);
    }
    await store.close();
  });

  it("rejects stale revisions and ambiguous phrase targeting without changing the page", async () => {
    const store = storage("closed");
    const registry = await createPageCommandRegistry(store, createNotebookId("ambiguous-workbook"));
    await registry.executeManual("page_text_insert", {
      mutationId: "insert-a",
      expectedRevision: 1,
      text: "Repeated phrase",
    });
    await registry.executeManual("page_text_insert", {
      mutationId: "insert-b",
      expectedRevision: 2,
      text: "Repeated phrase",
    });

    const ambiguous = await registry.executeExternal("page_annotation_add", {
      mutationId: "ambiguous-annotation",
      actorId: "assistant:two",
      expectedRevision: 3,
      target: { kind: "phrase", phrase: "Repeated phrase" },
      annotation: "highlight",
    }, "webmcp");
    expect(ambiguous).toMatchObject({
      outcome: "error",
      error: {
        code: "TARGET_AMBIGUOUS",
        candidates: [
          { kind: "text-range", label: "Repeated phrase", start: 0, end: 15 },
          { kind: "text-range", label: "Repeated phrase", start: 0, end: 15 },
        ],
      },
    });
    expect(registry.getSnapshot().pageRevision).toBe(3);

    const stale = await registry.executeManual("page_shape_add", {
      mutationId: "stale-shape",
      expectedRevision: 1,
      shape: "ellipse",
    });
    expect(stale).toMatchObject({ outcome: "error", error: { code: "REVISION_CONFLICT" } });
    expect(registry.getSnapshot().pageRevision).toBe(3);
    await store.close();
  });

  it("publishes only page-scoped WebMCP tools", async () => {
    const store = storage("descriptors");
    const registry = await createPageCommandRegistry(store, createNotebookId("descriptor-workbook"));
    const webmcp = registry.describe("webmcp").map((descriptor) => descriptor.name);
    expect(webmcp).toEqual(expect.arrayContaining([
      "page_context_read",
      "page_text_insert",
      "page_text_format",
      "page_annotation_add",
      "page_shape_add",
      "page_element_move",
      "page_advance",
      "page_undo",
    ]));
    await store.close();
  });

  it("executes a registered page-scoped WebMCP tool through the canonical registry", async () => {
    const store = storage("webmcp");
    const registry = await createPageCommandRegistry(store, createNotebookId("webmcp-workbook"));
    const tools = new Map<string, WebMcpTool>();
    const registration = await registerPageWebMcpTools(registry, {
      registerTool(tool) { tools.set(tool.name, tool); },
    });
    expect(registration.status).toBe("registered");

    const result = await tools.get("page_text_insert")?.execute({
      mutationId: "work-chat-write",
      actorId: "assistant:work-chat",
      expectedRevision: 1,
      text: "Written through the page-scoped tool",
    });
    expect(result).toMatchObject({ context: { plainText: "Written through the page-scoped tool", pageRevision: 2 } });
    expect(registry.getSnapshot().plainText).toBe("Written through the page-scoped tool");
    await store.close();
  });

  it("rebinds existing WebMCP tools when the focused workbook changes", async () => {
    const store = storage("webmcp-rebind");
    const first = await createPageCommandRegistry(store, createNotebookId("first-workbook"));
    const second = await createPageCommandRegistry(store, createNotebookId("second-workbook"));
    const tools = new Map<string, WebMcpTool>();
    const modelContext = { registerTool(tool: WebMcpTool) { tools.set(tool.name, tool); } };
    expect((await registerPageWebMcpTools(first, modelContext)).status).toBe("registered");
    expect((await registerPageWebMcpTools(second, modelContext)).status).toBe("already_registered");

    await tools.get("page_text_insert")?.execute({
      mutationId: "second-workbook-write",
      expectedRevision: 1,
      text: "Only the second workbook changes",
    });
    expect(first.getSnapshot().plainText).toBe("");
    expect(second.getSnapshot().plainText).toBe("Only the second workbook changes");
    await store.close();
  });

  it("fails closed when the visible notebook unmounts", async () => {
    const store = storage("webmcp-inactive");
    const registry = await createPageCommandRegistry(store, createNotebookId("inactive-workbook"));
    const tools = new Map<string, WebMcpTool>();
    const modelContext = { registerTool(tool: WebMcpTool) { tools.set(tool.name, tool); } };
    await registerPageWebMcpTools(registry, modelContext);

    deactivatePageWebMcpTools(registry, modelContext);
    const result = await tools.get("page_text_insert")?.execute({
      mutationId: "hidden-write",
      expectedRevision: 1,
      text: "This must not reach a hidden notebook",
    });

    expect(result).toMatchObject({ outcome: "error", error: { code: "PAGE_NOT_VISIBLE" } });
    expect(registry.getSnapshot().plainText).toBe("");
    await store.close();
  });

  it("recovers partial registration and avoids duplicate tools during a concurrent rebind", async () => {
    const store = storage("webmcp-registration-recovery");
    const first = await createPageCommandRegistry(store, createNotebookId("registration-first"));
    const second = await createPageCommandRegistry(store, createNotebookId("registration-second"));
    const tools = new Map<string, WebMcpTool>();
    const counts = new Map<string, number>();
    let failOnce = true;
    const modelContext = {
      async registerTool(tool: WebMcpTool): Promise<void> {
        await Promise.resolve();
        if (failOnce && tool.name === "page_text_insert") {
          failOnce = false;
          throw new Error("temporary registration failure");
        }
        counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
        tools.set(tool.name, tool);
      },
    };

    expect((await registerPageWebMcpTools(first, modelContext)).status).toBe("error");
    const [retried, rebound] = await Promise.all([
      registerPageWebMcpTools(first, modelContext),
      registerPageWebMcpTools(second, modelContext),
    ]);
    expect([retried.status, rebound.status]).toEqual(["already_registered", "already_registered"]);
    expect([...counts.values()].every((count) => count === 1)).toBe(true);

    await tools.get("page_text_insert")?.execute({
      mutationId: "registration-rebound-write",
      expectedRevision: 1,
      text: "The latest visible notebook receives the write",
    });
    expect(first.getSnapshot().plainText).toBe("");
    expect(second.getSnapshot().plainText).toBe("The latest visible notebook receives the write");
    await store.close();
  });

  it("holds a canonical writer claim across multiple commands while other pages stay writable", async () => {
    const store = storage("canonical-writer-claim");
    const owner = await createPageCommandRegistry(store, createNotebookId("claimed-workbook"));
    const advanced = await owner.executeExternal("page_advance", {
      mutationId: "claim-create-page-two",
      expectedDocumentRevision: 1,
      actorId: "assistant:owner",
    }, "webmcp");
    expect(advanced.outcome).toBe("success");
    const context = owner.getSnapshot();
    const firstPageId = context.previousPageId!;
    const secondPageId = context.focusedPageId;
    const challenger = await createPageCommandRegistry(store, createNotebookId("claimed-workbook"));
    owner.setViewContext({ presentation: "spread", visiblePageIds: [firstPageId, secondPageId] });
    challenger.setViewContext({ presentation: "spread", visiblePageIds: [firstPageId, secondPageId] });

    const claimed = await owner.executeExternal("page_writer_claim", {
      pageId: firstPageId,
      actorId: "assistant:owner",
      claimId: "owner-turn-1",
    }, "webmcp");
    expect(claimed.outcome).toBe("success");
    expect(await owner.executeExternal("page_text_insert", {
      mutationId: "claimed-owner-write",
      pageId: firstPageId,
      expectedRevision: 1,
      actorId: "assistant:owner",
      claimId: "owner-turn-1",
      text: "Owner holds this page",
    }, "webmcp")).toMatchObject({ outcome: "success" });

    expect(await challenger.executeExternal("page_text_insert", {
      mutationId: "claimed-blocked-write",
      pageId: firstPageId,
      expectedRevision: 2,
      actorId: "assistant:challenger",
      text: "Blocked while claimed",
    }, "webmcp")).toMatchObject({ outcome: "error", error: { code: "PAGE_BUSY" } });
    expect(await challenger.executeExternal("page_text_insert", {
      mutationId: "claimed-other-page-write",
      pageId: secondPageId,
      expectedRevision: 1,
      actorId: "assistant:challenger",
      text: "A separate page stays writable",
    }, "webmcp")).toMatchObject({ outcome: "success" });

    expect(await owner.executeExternal("page_writer_release", {
      pageId: firstPageId,
      actorId: "assistant:owner",
      claimId: "owner-turn-1",
    }, "webmcp")).toMatchObject({ outcome: "success" });
    expect(await challenger.executeExternal("page_text_insert", {
      mutationId: "claimed-after-release",
      pageId: firstPageId,
      expectedRevision: 2,
      actorId: "assistant:challenger",
      text: "Writable after release",
    }, "webmcp")).toMatchObject({ outcome: "success" });
    await store.close();
  });
});
