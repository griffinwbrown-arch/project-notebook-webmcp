import { describe, expect, it } from "vitest";

import { SessionPageStorage } from "../../../src/demo/session-page-storage";
import { createIsoInstant, createNotebookId } from "../../../src/domain";
import { appendPage, createEmptyPageDocument, createPageCommandRegistry } from "../../../src/page";

describe("session-only page authority", () => {
  it("adds new seeded workbooks and upgrades only pristine placeholders", async () => {
    const values = new Map<string, string>();
    const sessionCache = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); },
    };
    const at = createIsoInstant("2026-09-02T12:00:00.000Z");
    const calculusId = createNotebookId("calculus-seed");
    const coloringId = createNotebookId("coloring-seed");
    const placeholder = createEmptyPageDocument(calculusId, at, { paper: "blank" });
    sessionCache.setItem("seed-merge", JSON.stringify([placeholder]));
    const calculusSeed = appendPage(placeholder, at);
    const coloringSeed = createEmptyPageDocument(coloringId, at, { paper: "blank" });

    const storage = new SessionPageStorage([calculusSeed, coloringSeed], { sessionCache, sessionKey: "seed-merge" });

    expect((await storage.read(calculusId)).pages).toHaveLength(2);
    expect((await storage.read(coloringId)).pages).toHaveLength(1);
  });

  it("commits a direct change and restores it from the same browser-tab cache", async () => {
    const values = new Map<string, string>();
    const sessionCache = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value); },
    };
    const workbookId = createNotebookId("visitor-notebook");
    const storage = new SessionPageStorage([], { sessionCache, sessionKey: "direct-change" });
    const registry = await createPageCommandRegistry(storage, workbookId);
    const before = registry.getSnapshot();

    const result = await registry.executeManual("page_text_insert", {
      mutationId: "direct_change_001",
      pageId: before.focusedPageId,
      expectedRevision: before.pageRevision,
      text: "Saved judge note",
      blockKind: "paragraph",
    });

    expect(result).toMatchObject({ outcome: "success", output: { receipt: { kind: "page_text_insert" } } });
    expect(registry.getSnapshot()).toMatchObject({ pageRevision: 2, plainText: "Saved judge note" });
    const freshStorage = new SessionPageStorage([], { sessionCache, sessionKey: "direct-change" });
    const freshRegistry = await createPageCommandRegistry(freshStorage, workbookId);
    expect(freshRegistry.getSnapshot()).toMatchObject({ pageRevision: 2, plainText: "Saved judge note" });
  });

  it("enforces the eight-page notebook limit", async () => {
    const storage = new SessionPageStorage([], { sessionCache: null });
    const registry = await createPageCommandRegistry(storage, createNotebookId("bounded-notebook"));
    for (let index = 1; index < 8; index += 1) {
      const result = await registry.executeManual("page_advance", {
        mutationId: `advance_page_${String(index).padStart(2, "0")}`,
        expectedDocumentRevision: registry.getSnapshot().documentRevision,
      });
      expect(result.outcome).toBe("success");
    }
    expect(registry.getSnapshot().pageCount).toBe(8);
    const rejected = await registry.executeManual("page_advance", {
      mutationId: "advance_page_08",
      expectedDocumentRevision: registry.getSnapshot().documentRevision,
    });
    expect(rejected).toMatchObject({ outcome: "error", error: { message: "A demo notebook can contain at most 8 pages." } });
  });

  it("undoes a topology change by its exact receipt", async () => {
    const storage = new SessionPageStorage([], { sessionCache: null });
    const registry = await createPageCommandRegistry(storage, createNotebookId("undo-notebook"));
    const advanced = await registry.executeManual("page_advance", {
      mutationId: "advance_for_undo",
      expectedDocumentRevision: registry.getSnapshot().documentRevision,
    });
    if (advanced.outcome !== "success") throw new Error("Expected the page advance to succeed.");
    if (advanced.output.receipt === undefined) throw new Error("Expected the page advance to return a receipt.");
    expect(registry.getSnapshot().pageCount).toBe(2);

    const undone = await registry.executeManual("page_undo", {
      mutationId: "undo_advance",
      receiptId: advanced.output.receipt.id,
    });
    expect(undone.outcome).toBe("success");
    expect(registry.getSnapshot()).toMatchObject({ pageCount: 1, focusedPageNumber: 1 });
  });
});
