import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import {
  addElement,
  createActorId,
  createElementId,
  createMutationId,
  createPageScrapId,
  createTextBlockId,
  derivePagePlainText,
  richTextFromPlainText,
  setStructuredText,
  type StructuredTextBlock,
  type TextElement,
} from "../../../src/page";
import {
  IndexedDbPageStorage,
  openPhase2Database,
  type PageWriterClaimInput,
} from "../../../src/indexeddb";
import { createPageCommandRegistry } from "../../../src/page/commands";

let sequence = 0;
const at = createIsoInstant("2026-08-29T14:00:00.000Z");

function databaseName(prefix: string): string {
  sequence += 1;
  return `phase11-page-core-${prefix}-${sequence}`;
}

function storage(prefix: string): IndexedDbPageStorage {
  return new IndexedDbPageStorage({
    databaseName: databaseName(prefix),
    clock: { now: () => at },
  });
}

function textElement(id: string, text: string): TextElement {
  return {
    kind: "text",
    id: createElementId(id),
    label: id,
    frame: { x: 96, y: 100, width: 520, height: 400 },
    content: richTextFromPlainText(text, createTextBlockId(`${id}:block`)),
  };
}

function structuredBlocks(prefix: string, body: string): readonly StructuredTextBlock[] {
  return [
    { id: createTextBlockId(`${prefix}:heading`), kind: "heading", runs: [{ text: "Working brief", marks: ["bold"] }] },
    { id: createTextBlockId(`${prefix}:body`), kind: "paragraph", runs: [{ text: body, marks: ["italic"] }] },
    { id: createTextBlockId(`${prefix}:quote`), kind: "quote", runs: [{ text: "Evidence first", marks: [] }] },
    { id: createTextBlockId(`${prefix}:bullet`), kind: "bullet-list-item", runs: [{ text: "Preserve the page", marks: [] }] },
    { id: createTextBlockId(`${prefix}:ordered`), kind: "ordered-list-item", runs: [{ text: "Verify the result", marks: ["underline"] }] },
  ];
}

describe("Phase 11 page core", () => {
  it("uses one structured-text command for manual and WebMCP edits with exact Undo", async () => {
    const store = storage("structured-command");
    const registry = await createPageCommandRegistry(store, createNotebookId("structured-workbook"));
    const inserted = await registry.executeManual("page_text_insert", {
      mutationId: "seed-text",
      expectedRevision: 1,
      text: "Before",
      frame: { x: 96, y: 100, width: 520, height: 400 },
    });
    expect(inserted.outcome).toBe("success");
    const page = registry.getDocument().pages[0]!;
    const element = page.elements[0]!;
    if (element.kind !== "text") throw new Error("Expected seeded text.");

    const manual = await registry.executeManual("page_structured_text_set", {
      mutationId: "manual-structured",
      pageId: page.id,
      elementId: element.id,
      expectedRevision: page.revision,
      blocks: structuredBlocks("manual", "Manual draft"),
    });
    expect(manual).toMatchObject({
      outcome: "success",
      output: { context: { pageRevision: 3 }, receipt: { kind: "page_structured_text_set", source: "person" } },
    });

    if (manual.outcome !== "success" || manual.output.receipt === undefined) throw new Error("Manual edit did not produce a receipt.");
    const undone = await registry.executeManual("page_undo", {
      mutationId: "undo-manual-structured",
      receiptId: manual.output.receipt.id,
    });
    expect(undone).toMatchObject({ outcome: "success", output: { context: { pageRevision: 4, plainText: "Before" } } });
    expect(await registry.executeManual("page_undo", {
      mutationId: "undo-manual-structured",
      receiptId: manual.output.receipt.id,
    })).toMatchObject({ outcome: "success", output: { receipt: { id: undone.outcome === "success" ? undone.output.receipt?.id : undefined } } });

    const external = await registry.executeExternal("page_structured_text_set", {
      mutationId: "webmcp-structured",
      actorId: "assistant:project",
      pageId: page.id,
      elementId: element.id,
      expectedRevision: 4,
      blocks: structuredBlocks("external", "WebMCP draft"),
    }, "webmcp");
    expect(external).toMatchObject({
      outcome: "success",
      output: { context: { pageRevision: 5 }, receipt: { kind: "page_structured_text_set", source: "assistant" } },
    });
    expect(registry.describe("webmcp").map(({ name }) => name)).toContain("page_structured_text_set");
    await store.close();
  });

  it("rejects no-op, stale, hidden, malformed, oversized, and unsafe structured edits without state changes", async () => {
    const store = storage("structured-rejections");
    const registry = await createPageCommandRegistry(store, createNotebookId("structured-rejections-workbook"));
    await registry.executeManual("page_text_insert", {
      mutationId: "seed-rejections",
      expectedRevision: 1,
      text: "Keep me",
      frame: { x: 96, y: 100, width: 520, height: 400 },
    });
    const first = registry.getDocument().pages[0]!;
    const element = first.elements[0]!;
    if (element.kind !== "text") throw new Error("Expected seeded text.");
    const unchangedBlocks = element.content.blocks;

    const noOpBefore = structuredClone(registry.getDocument());
    expect(await registry.executeManual("page_structured_text_set", {
      mutationId: "noop-structured",
      pageId: first.id,
      elementId: element.id,
      expectedRevision: first.revision,
      blocks: unchangedBlocks,
    })).toMatchObject({ outcome: "error", error: { code: "NO_OP" } });
    expect(registry.getDocument()).toEqual(noOpBefore);

    expect(await registry.executeManual("page_structured_text_set", {
      mutationId: "stale-structured",
      pageId: first.id,
      elementId: element.id,
      expectedRevision: 1,
      blocks: structuredBlocks("stale", "Stale"),
    })).toMatchObject({ outcome: "error", error: { code: "REVISION_CONFLICT" } });

    const unsafeWindowsPath = ["Read C:", "Users", "example", "private.txt"].join("/");
    for (const [mutationId, blocks] of [
      ["malformed-structured", [{ id: "bad", kind: "table", runs: [{ text: "Bad", marks: [] }] }]],
      ["oversized-structured", [{ id: "large", kind: "paragraph", runs: [{ text: "x".repeat(20_001), marks: [] }] }]],
      ["unsafe-structured", [{ id: "unsafe", kind: "paragraph", runs: [{ text: "<script>alert(1)</script>", marks: [] }] }]],
      ["unsafe-windows-path", [{ id: "unsafe-path", kind: "paragraph", runs: [{ text: unsafeWindowsPath, marks: [] }] }]],
      ["unsafe-control", [{ id: "unsafe-control", kind: "paragraph", runs: [{ text: "hidden\u0001control", marks: [] }] }]],
    ] as const) {
      expect(await registry.executeManual("page_structured_text_set", {
        mutationId,
        pageId: first.id,
        elementId: element.id,
        expectedRevision: first.revision,
        blocks,
      })).toMatchObject({ outcome: "error", error: { code: "INPUT_VALIDATION_ERROR" } });
      expect(registry.getDocument()).toEqual(noOpBefore);
    }

    const advanced = await registry.executeManual("page_advance", {
      mutationId: "hidden-page-advance",
      expectedDocumentRevision: 1,
    });
    expect(advanced.outcome).toBe("success");
    const hiddenBefore = structuredClone(registry.getDocument());
    expect(await registry.executeManual("page_structured_text_set", {
      mutationId: "hidden-structured",
      pageId: first.id,
      elementId: element.id,
      expectedRevision: first.revision,
      blocks: structuredBlocks("hidden", "Hidden"),
    })).toMatchObject({ outcome: "error", error: { code: "PAGE_NOT_VISIBLE" } });
    expect(await registry.executeExternal("page_text_insert", {
      mutationId: "hidden-legacy-text",
      actorId: "assistant:hidden",
      pageId: first.id,
      expectedRevision: first.revision,
      text: "Must stay hidden",
    }, "webmcp")).toMatchObject({ outcome: "error", error: { code: "PAGE_NOT_VISIBLE" } });
    expect(registry.getDocument()).toEqual(hiddenBefore);
    expect(await store.read(hiddenBefore.workbookId)).toEqual(hiddenBefore);
    await store.close();
  });

  it("merges stale sibling snapshots for independent page-local commits", async () => {
    const store = storage("page-local");
    const workbookId = createNotebookId("page-local-workbook");
    let original = await store.ensureWorkbook(workbookId);
    original = await store.appendPage(workbookId, original.documentRevision);
    const first = original.pages[0]!;
    const second = original.pages[1]!;

    const firstNext = addElement(first, textElement("first-local", "First actor"), at);
    await store.commit({
      workbookId,
      nextDocument: { ...original, pages: [firstNext, second] },
      pageIds: [first.id],
      expectedDocumentRevision: original.documentRevision,
      expectedPageRevisions: { [first.id]: first.revision },
      mutationId: createMutationId("first-local-commit"),
      actorId: createActorId("person:first"),
      source: "person",
      kind: "page_text_insert",
    });

    const secondNext = addElement(second, textElement("second-local", "Second actor"), at);
    await expect(store.commit({
      workbookId,
      nextDocument: { ...original, pages: [first, secondNext] },
      pageIds: [second.id],
      expectedDocumentRevision: original.documentRevision,
      expectedPageRevisions: { [second.id]: second.revision },
      mutationId: createMutationId("second-local-commit"),
      actorId: createActorId("person:second"),
      source: "person",
      kind: "page_text_insert",
    })).resolves.toMatchObject({ status: "committed" });

    const merged = await store.read(workbookId);
    expect(derivePagePlainText(merged.pages[0]!)).toBe("First actor");
    expect(derivePagePlainText(merged.pages[1]!)).toBe("Second actor");
    expect(merged.pages.map(({ revision }) => revision)).toEqual([2, 2]);
    await store.close();
  });

  it("requires exact actor and claim id and verifies page membership", async () => {
    const store = storage("claims");
    const workbookId = createNotebookId("claim-workbook");
    const otherWorkbookId = createNotebookId("other-claim-workbook");
    const document = await store.ensureWorkbook(workbookId);
    await store.ensureWorkbook(otherWorkbookId);
    const page = document.pages[0]!;
    const claim = {
      workbookId,
      pageId: page.id,
      actorId: createActorId("assistant:writer"),
      claimId: "claim:exact",
      ttlMs: 60_000,
    } satisfies PageWriterClaimInput;
    await store.claimPage(claim);
    await expect(store.claimPage({ ...claim, claimId: "claim:replacement" })).rejects.toMatchObject({ code: "page_busy" });
    await expect(store.claimPage({ ...claim, workbookId: otherWorkbookId })).rejects.toMatchObject({ code: "invalid_page" });

    const nextPage = addElement(page, textElement("claimed-text", "Claimed"), at);
    const before = await store.read(workbookId);
    await expect(store.commit({
      workbookId,
      nextDocument: { ...document, pages: [nextPage] },
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId("missing-claim-write"),
      actorId: claim.actorId,
      source: "assistant",
      kind: "page_structured_text_set",
    })).rejects.toMatchObject({ code: "page_busy" });
    await expect(store.commit({
      workbookId,
      nextDocument: { ...document, pages: [nextPage] },
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId("wrong-claim-write"),
      actorId: claim.actorId,
      source: "assistant",
      kind: "page_structured_text_set",
      claimId: "claim:wrong",
    })).rejects.toMatchObject({ code: "page_busy" });
    await expect(store.applyRework({
      workbookId,
      nextDocument: { ...document, pages: [nextPage] },
      pageIds: [page.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId("missing-claim-rework"),
      actorId: claim.actorId,
      source: "assistant",
      scrapId: createPageScrapId("scrap:missing-claim-rework"),
      reason: "Prove exact rework writer ownership",
    })).rejects.toMatchObject({ code: "page_busy" });
    expect(await store.read(workbookId)).toEqual(before);
    await store.close();
  });

  it("rejects malformed persisted PageElement variants without repairing or deleting them", async () => {
    const name = databaseName("strict-elements");
    const store = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => at } });
    const workbookId = createNotebookId("strict-elements-workbook");
    const document = await store.ensureWorkbook(workbookId);
    const database = await openPhase2Database(name);
    const row = await database.get("pages", document.pages[0]!.id);
    if (row === undefined) throw new Error("Expected a page row.");
    const malformed = {
      kind: "text",
      id: "malformed-text",
      label: "Malformed",
      frame: { x: 96, y: 100, width: 520, height: 160 },
      content: {
        format: "rich_text",
        blocks: [{ id: "malformed-block", kind: "paragraph", runs: [{ text: "Unsafe", marks: ["blink"] }] }],
      },
      executable: "alert(1)",
    };
    await database.put("pages", { ...row, elements: [malformed] });
    database.close();

    await expect(store.read(workbookId)).rejects.toMatchObject({ code: "invalid_page" });
    const preserved = await openPhase2Database(name);
    expect((await preserved.get("pages", document.pages[0]!.id))?.elements).toEqual([malformed]);
    preserved.close();
    await store.close();
  });

  it("creates Scrap atomically before rework, restores exact content, and rejects stale restore", async () => {
    const store = storage("scrap");
    const workbookId = createNotebookId("scrap-workbook");
    const initial = await store.ensureWorkbook(workbookId);
    const page = initial.pages[0]!;
    const beforePage = addElement(page, textElement("scrap-text", "Before rework"), at);
    const seeded = await store.commit({
      workbookId,
      nextDocument: { ...initial, pages: [beforePage] },
      pageIds: [page.id],
      expectedDocumentRevision: initial.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId("scrap-seed"),
      actorId: createActorId("person:scrap"),
      source: "person",
      kind: "page_text_insert",
    });
    const seededPage = seeded.document.pages[0]!;
    const reworkedPage = setStructuredText(
      seededPage,
      createElementId("scrap-text"),
      structuredBlocks("rework", "After rework"),
      at,
    );
    const reworked = await store.applyRework({
      workbookId,
      nextDocument: { ...seeded.document, pages: [reworkedPage] },
      pageIds: [seededPage.id],
      expectedDocumentRevision: seeded.document.documentRevision,
      expectedPageRevisions: { [seededPage.id]: seededPage.revision },
      mutationId: createMutationId("major-rework"),
      actorId: createActorId("person:scrap"),
      source: "person",
      scrapId: createPageScrapId("scrap:before-major-rework"),
      reason: "Replace the working brief structure",
    });
    expect(derivePagePlainText(reworked.document.pages[0]!)).toContain("After rework");
    expect(reworked.scrap.beforeDocument).toEqual(seeded.document);
    expect(reworked.scrap.beforePages).toEqual(seeded.document.pages);
    expect(reworked.scrap.resultingPageRevisions).toEqual({ [seededPage.id]: reworked.document.pages[0]!.revision });
    expect(reworked.receipt.kind).toBe("page_rework_apply");
    expect(await store.getScrap(workbookId, reworked.scrap.id)).toEqual(reworked.scrap);
    expect(await store.listScraps(workbookId)).toEqual([reworked.scrap]);

    const restoreClaim = {
      workbookId,
      pageId: reworked.document.pages[0]!.id,
      actorId: createActorId("person:scrap"),
      claimId: "claim:restore-scrap",
      ttlMs: 60_000,
    } satisfies PageWriterClaimInput;
    await store.claimPage(restoreClaim);
    await expect(store.restoreScrap({
      workbookId,
      scrapId: reworked.scrap.id,
      mutationId: createMutationId("restore-major-rework-without-claim"),
      actorId: restoreClaim.actorId,
      source: "person",
      visiblePageIds: [reworked.document.pages[0]!.id],
    })).rejects.toMatchObject({ code: "page_busy" });
    const restored = await store.restoreScrap({
      workbookId,
      scrapId: reworked.scrap.id,
      mutationId: createMutationId("restore-major-rework"),
      actorId: restoreClaim.actorId,
      source: "person",
      claimId: restoreClaim.claimId,
      visiblePageIds: [reworked.document.pages[0]!.id],
    });
    expect(await store.restoreScrap({
      workbookId,
      scrapId: reworked.scrap.id,
      mutationId: createMutationId("restore-major-rework"),
      actorId: restoreClaim.actorId,
      source: "person",
      claimId: restoreClaim.claimId,
      visiblePageIds: [reworked.document.pages[0]!.id],
    })).toMatchObject({ status: "duplicate", receipt: { id: restored.receipt.id } });
    expect(derivePagePlainText(restored.document.pages[0]!)).toBe("Before rework");
    expect(restored.receipt.kind).toBe("page_scrap_restore");
    expect(await store.getScrap(workbookId, reworked.scrap.id)).toEqual(reworked.scrap);
    await store.releasePageWriter(restoreClaim);

    const reworkedAgainPage = setStructuredText(
      restored.document.pages[0]!,
      createElementId("scrap-text"),
      structuredBlocks("rework-again", "Second rework"),
      at,
    );
    const reworkedAgain = await store.applyRework({
      workbookId,
      nextDocument: { ...restored.document, pages: [reworkedAgainPage] },
      pageIds: [reworkedAgainPage.id],
      expectedDocumentRevision: restored.document.documentRevision,
      expectedPageRevisions: { [reworkedAgainPage.id]: restored.document.pages[0]!.revision },
      mutationId: createMutationId("major-rework-again"),
      actorId: createActorId("person:scrap"),
      source: "person",
      scrapId: createPageScrapId("scrap:before-major-rework-again"),
      reason: "Test the stale restore guard",
    });
    const laterPage = setStructuredText(
      reworkedAgain.document.pages[0]!,
      createElementId("scrap-text"),
      structuredBlocks("later", "Newer work"),
      at,
    );
    await store.commit({
      workbookId,
      nextDocument: { ...reworkedAgain.document, pages: [laterPage] },
      pageIds: [laterPage.id],
      expectedDocumentRevision: reworkedAgain.document.documentRevision,
      expectedPageRevisions: { [laterPage.id]: reworkedAgain.document.pages[0]!.revision },
      mutationId: createMutationId("newer-after-rework"),
      actorId: createActorId("person:scrap"),
      source: "person",
      kind: "page_structured_text_set",
    });
    const beforeStaleRestore = await store.read(workbookId);
    await expect(store.restoreScrap({
      workbookId,
      scrapId: reworkedAgain.scrap.id,
      mutationId: createMutationId("stale-scrap-restore"),
      actorId: createActorId("person:scrap"),
      source: "person",
      visiblePageIds: [reworkedAgain.document.pages[0]!.id],
    })).rejects.toMatchObject({ code: "stale_undo" });
    expect(await store.read(workbookId)).toEqual(beforeStaleRestore);
    await store.close();
  });

  it("rejects multi-page rework at the storage boundary", async () => {
    const store = storage("multi-page-rework");
    const workbookId = createNotebookId("multi-page-rework-workbook");
    let document = await store.ensureWorkbook(workbookId);
    document = await store.appendPage(workbookId, document.documentRevision);
    const [first, second] = document.pages;
    if (first === undefined || second === undefined) throw new Error("Expected two pages.");
    const changedFirst = addElement(first, textElement("multi-first", "First"), at);
    const changedSecond = addElement(second, textElement("multi-second", "Second"), at);
    await expect(store.applyRework({
      workbookId,
      nextDocument: { ...document, pages: [changedFirst, changedSecond] },
      pageIds: [first.id, second.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [first.id]: first.revision, [second.id]: second.revision },
      mutationId: createMutationId("multi-page-rework"),
      actorId: createActorId("person:multi-page"),
      source: "person",
      scrapId: createPageScrapId("scrap:multi-page"),
      reason: "Must remain page local",
    })).rejects.toMatchObject({ code: "invalid_page" });
    expect(await store.read(workbookId)).toEqual(document);
    await store.close();
  });
});
