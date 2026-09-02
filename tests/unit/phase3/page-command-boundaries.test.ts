import { describe, expect, it } from "vitest";

import { createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import {
  createPageScrapId,
  createPageCommandRegistry,
  type VectorInkDocument,
  type VectorInkProvenance,
} from "../../../src/page";

let sequence = 0;

function storage(prefix: string): IndexedDbPageStorage {
  sequence += 1;
  return new IndexedDbPageStorage({
    databaseName: `page-command-boundary-${prefix}-${sequence}`,
    clock: { now: () => "2026-08-30T12:00:00.000Z" },
  });
}

function blocks(prefix: string, body: string) {
  return [
    { id: `${prefix}:heading`, kind: "heading" as const, runs: [{ text: "Reworked heading", marks: ["bold" as const] }] },
    { id: `${prefix}:body`, kind: "paragraph" as const, runs: [{ text: body, marks: ["italic" as const] }] },
  ];
}

const beforeVector: VectorInkDocument = {
  version: 1,
  viewBox: { width: 100, height: 100 },
  paths: [{
    commands: [{ kind: "move", x: 10, y: 10 }, { kind: "line", x: 90, y: 90 }],
    paint: { stroke: "ink", strokeWidth: 1, fill: null, linecap: "round", linejoin: "round" },
  }],
};

const afterVector: VectorInkDocument = {
  version: 1,
  viewBox: { width: 100, height: 100 },
  paths: [{
    commands: [{ kind: "move", x: 10, y: 90 }, { kind: "line", x: 90, y: 10 }],
    paint: { stroke: "red", strokeWidth: 2, fill: null, linecap: "round", linejoin: "round" },
  }],
};

const beforeProvenance: VectorInkProvenance = {
  kind: "reference",
  sourceLabel: "Before",
  sourceFormat: "svg",
};

const afterProvenance: VectorInkProvenance = {
  kind: "replacement",
  sourceLabel: "After",
  sourceFormat: "svg",
};

describe("page command mutation boundaries", () => {
  it("rejects malformed command inputs and targets without changing the page", async () => {
    const store = storage("malformed");
    const registry = await createPageCommandRegistry(store, createNotebookId("malformed-targets"));
    const before = structuredClone(registry.getDocument());

    await expect(registry.executeExternal("not_a_page_command", {}, "webmcp")).resolves.toMatchObject({
      outcome: "error",
      error: { code: "UNKNOWN_COMMAND" },
    });
    await expect(registry.executeExternal("page_text_insert", {
      mutationId: "invalid-revision",
      expectedRevision: 0,
      text: "Should not write",
    }, "webmcp")).resolves.toMatchObject({
      outcome: "error",
      error: { code: "INPUT_VALIDATION_ERROR" },
    });
    await expect(registry.executeExternal("page_target_resolve", {
      target: { kind: "page", pageId: "" },
    }, "webmcp")).resolves.toMatchObject({
      outcome: "error",
      error: { code: "INPUT_VALIDATION_ERROR" },
    });
    await expect(registry.executeExternal("page_target_resolve", {
      target: { kind: "number", pageNumber: 99 },
    }, "webmcp")).resolves.toMatchObject({
      outcome: "error",
      error: { code: "TARGET_NOT_FOUND" },
    });
    await expect(registry.executeExternal("page_text_insert", {
      mutationId: "unknown-field",
      expectedRevision: 1,
      text: "Should not write",
      unsupported: true,
    }, "webmcp")).resolves.toMatchObject({
      outcome: "error",
      error: { code: "INPUT_VALIDATION_ERROR" },
    });

    expect(registry.getDocument()).toEqual(before);
    await store.close();
  });

  it("rejects stale page revisions before resolving or committing a later mutation", async () => {
    const store = storage("stale");
    const registry = await createPageCommandRegistry(store, createNotebookId("stale-target"));
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "stale-seed",
      expectedRevision: 1,
      text: "Stable target",
      label: "Stable target",
    });
    expect(inserted.outcome).toBe("success");
    const page = registry.getDocument().pages[0]!;
    const element = page.elements[0]!;
    const changed = await registry.executeManual("page_shape_add", {
      mutationId: "fresh-shape",
      expectedRevision: 2,
      shape: "ellipse",
    });
    expect(changed).toMatchObject({ outcome: "success", output: { context: { pageRevision: 3 } } });
    const afterChange = structuredClone(registry.getDocument());

    await expect(registry.executeExternal("page_text_format", {
      mutationId: "stale-format",
      actorId: "assistant:stale",
      pageId: page.id,
      expectedRevision: 2,
      target: { kind: "element", elementId: element.id },
      marks: ["bold"],
    }, "webmcp")).resolves.toMatchObject({
      outcome: "error",
      error: { code: "REVISION_CONFLICT" },
    });
    expect(registry.getDocument()).toEqual(afterChange);
    await store.close();
  });

  it("applies major rework through the command registry, records Scrap, and restores it exactly", async () => {
    const store = storage("rework");
    const workbookId = createNotebookId("command-rework");
    const registry = await createPageCommandRegistry(store, workbookId);
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "rework-seed",
      expectedRevision: 1,
      text: "Before rework",
      frame: { x: 96, y: 100, width: 520, height: 400 },
    });
    expect(inserted.outcome).toBe("success");
    const page = registry.getDocument().pages[0]!;
    const element = page.elements[0]!;
    if (element.kind !== "text") throw new Error("Expected text to rework.");

    const input = {
      mutationId: "command-rework",
      pageId: page.id,
      expectedRevision: page.revision,
      scrapId: "command-rework-scrap",
      reason: "Reorganize the working brief",
      elementId: element.id,
      blocks: blocks("rework", "After rework"),
    };
    const reworked = await registry.executeManual("page_rework_apply", input);
    expect(reworked).toMatchObject({
      outcome: "success",
      output: { context: { pageRevision: 3, plainText: "Reworked heading\nAfter rework" }, receipt: { kind: "page_rework_apply" } },
    });
    expect(await store.listScraps(workbookId)).toHaveLength(1);

    const restored = await registry.executeManual("page_scrap_restore", {
      mutationId: "command-rework-restore",
      scrapId: createPageScrapId(input.scrapId),
    });
    expect(restored).toMatchObject({
      outcome: "success",
      output: { context: { pageRevision: 4, plainText: "Before rework" }, receipt: { kind: "page_scrap_restore" } },
    });
    expect(registry.getDocument().pages[0]?.elements).toHaveLength(1);
    await store.close();
  });

  it("rejects Scrap restore after newer page work and preserves the newer document", async () => {
    const store = storage("stale-scrap");
    const registry = await createPageCommandRegistry(store, createNotebookId("stale-command-rework"));
    await registry.executeManual("page_text_insert", {
      mutationId: "stale-rework-seed",
      expectedRevision: 1,
      text: "Original",
      frame: { x: 96, y: 100, width: 520, height: 400 },
    });
    const page = registry.getDocument().pages[0]!;
    const element = page.elements[0]!;
    if (element.kind !== "text") throw new Error("Expected text to rework.");
    await registry.executeManual("page_rework_apply", {
      mutationId: "stale-command-rework",
      pageId: page.id,
      expectedRevision: page.revision,
      scrapId: "stale-command-scrap",
      reason: "Capture original before a change",
      elementId: element.id,
      blocks: blocks("stale", "Reworked"),
    });
    const reworkedPage = registry.getDocument().pages[0]!;
    const newer = await registry.executeManual("page_text_insert", {
      mutationId: "newer-command-work",
      expectedRevision: reworkedPage.revision,
      text: "Newer work",
      frame: { x: 96, y: 560, width: 520, height: 180 },
    });
    expect(newer.outcome).toBe("success");
    const beforeRestore = structuredClone(registry.getDocument());

    await expect(registry.executeManual("page_scrap_restore", {
      mutationId: "stale-command-restore",
      scrapId: "stale-command-scrap",
    })).resolves.toMatchObject({ outcome: "error", error: { code: "STALE_UNDO" } });
    expect(registry.getDocument()).toEqual(beforeRestore);
    await store.close();
  });

  it("keeps replacement review manual-only and makes an exact Apply retry idempotent", async () => {
    const store = storage("replacement");
    const registry = await createPageCommandRegistry(store, createNotebookId("command-replacement"));
    const added = await registry.executeExternal("page_vector_ink_add", {
      mutationId: "replacement-target",
      expectedRevision: 1,
      document: beforeVector,
      label: "Figure",
      description: "A replaceable figure",
      provenance: beforeProvenance,
    }, "webmcp");
    expect(added.outcome).toBe("success");
    const target = registry.getDocument().pages[0]?.elements[0];
    if (target?.kind !== "vector-ink") throw new Error("Expected vector ink target.");

    const proposalResult = await registry.executeExternal("page_vector_ink_replace_propose", {
      targetElementId: target.id,
      expectedRevision: 2,
      document: afterVector,
      provenance: afterProvenance,
    }, "webmcp");
    expect(proposalResult).toMatchObject({ outcome: "success", output: { replacementProposal: { elementId: target.id } } });
    if (proposalResult.outcome !== "success" || proposalResult.output.replacementProposal === undefined) {
      throw new Error("Expected a replacement proposal.");
    }
    const proposalId = proposalResult.output.replacementProposal.proposalId;
    expect(registry.getVectorInkReplacementReviewSnapshot().kind).toBe("reviewing");
    expect(await registry.executeExternal("page_vector_ink_replace_apply", {
      mutationId: "external-apply",
      proposalId,
    }, "webmcp")).toMatchObject({ outcome: "error", error: { code: "UNKNOWN_COMMAND" } });

    const applyInput = { mutationId: "manual-apply", proposalId };
    const applied = await registry.executeManual("page_vector_ink_replace_apply", applyInput);
    expect(applied).toMatchObject({ outcome: "success", output: { context: { pageRevision: 3 }, receipt: { kind: "page_vector_ink_replace_apply" } } });
    const retried = await registry.executeManual("page_vector_ink_replace_apply", applyInput);
    expect(retried).toEqual(applied);
    expect(registry.getDocument().pages[0]?.elements[0]).toMatchObject({ kind: "vector-ink", document: afterVector, provenance: afterProvenance });
    expect(await registry.executeManual("page_vector_ink_replace_apply", {
      mutationId: "different-apply",
      proposalId,
    })).toMatchObject({ outcome: "error", error: { code: "REPLACEMENT_REVIEW_NOT_FOUND" } });
    await store.close();
  });

  it("maps hidden and stale page Undo attempts to fail-closed command errors", async () => {
    const store = storage("undo");
    const registry = await createPageCommandRegistry(store, createNotebookId("command-undo"));
    const added = await registry.executeManual("page_text_insert", {
      mutationId: "undo-seed",
      expectedRevision: 1,
      text: "Undo me",
    });
    if (added.outcome !== "success" || added.output.receipt === undefined) throw new Error("Expected an undoable receipt.");
    const receiptId = added.output.receipt.id;
    const firstPageId = registry.getSnapshot().focusedPageId;
    expect(added.output.receipt.affectedPageIds).toEqual([firstPageId]);
    const advanced = await registry.executeManual("page_advance", { mutationId: "undo-advance", expectedDocumentRevision: 1 });
    expect(advanced).toMatchObject({ outcome: "success", output: { context: { focusedPageNumber: 2 } } });
    const secondPageId = registry.getSnapshot().focusedPageId;
    registry.focusPage(firstPageId);
    registry.setViewContext({ presentation: "single", visiblePageIds: [secondPageId] });
    expect(registry.getSnapshot().visiblePageIds).toEqual([secondPageId]);
    const hiddenBefore = structuredClone(registry.getDocument());
    await expect(registry.executeExternal("page_undo", {
      mutationId: "hidden-undo",
      receiptId,
    }, "webmcp")).resolves.toMatchObject({ outcome: "error", error: { code: "PAGE_NOT_VISIBLE" } });
    expect(registry.getDocument()).toEqual(hiddenBefore);

    await registry.focusPage(firstPageId);
    const changed = await registry.executeManual("page_text_insert", {
      mutationId: "newer-undo-work",
      pageId: firstPageId,
      expectedRevision: 2,
      text: "Newer text",
    });
    expect(changed.outcome).toBe("success");
    await expect(registry.executeManual("page_undo", {
      mutationId: "stale-undo",
      receiptId,
    })).resolves.toMatchObject({ outcome: "error", error: { code: "STALE_UNDO" } });
    await store.close();
  });
});
