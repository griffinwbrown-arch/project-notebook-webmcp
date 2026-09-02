import { describe, expect, it } from "vitest";

import {
  addElement,
  appendPage as appendDomainPage,
  createActorId,
  createElementId,
  createMutationId,
  createTextBlockId,
  derivePagePlainText,
  richTextFromPlainText,
  type PageDocument,
  type TextElement,
} from "../../../src/page";
import { createIsoInstant, createNotebookId } from "../../../src/domain";
import {
  IndexedDbPageStorage,
  PHASE0_DATABASE_VERSION,
  openPhase2Database,
  type PageWriterClaimInput,
} from "../../../src/indexeddb";
import { decodePageDocument } from "../../../src/indexeddb/page-storage-codecs";

let sequence = 0;
const at = createIsoInstant("2026-08-26T12:00:00.000Z");
const later = createIsoInstant("2026-08-26T12:01:00.000Z");

function databaseName(prefix: string): string {
  sequence += 1;
  return `phase3-page-storage-${prefix}-${sequence}`;
}

function legacyNote(id: string, lifecycle: "active" | "trashed" = "active") {
  return {
    id,
    targetNotebookId: "migration-workbook",
    revision: 1,
    contentVersion: 1,
    content: { format: "plain_text" as const, text: `Legacy ${id}` },
    lifecycle,
    createdAt: "2026-08-26T11:00:00.000Z",
    updatedAt: "2026-08-26T11:00:00.000Z",
  };
}

async function seedLegacy(name: string, malformed = false): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    request.onupgradeneeded = () => {
      const created = request.result;
      if (!created.objectStoreNames.contains("notebooks")) {
        created.createObjectStore("notebooks", { keyPath: "id" });
      }
      if (!created.objectStoreNames.contains("canvasSnapshots")) {
        created.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
      }
      if (!created.objectStoreNames.contains("notes")) {
        const notes = created.createObjectStore("notes", { keyPath: "id" });
        notes.createIndex("byNotebookLifecycleCreatedAtId", [
          "targetNotebookId",
          "lifecycle",
          "createdAt",
          "id",
        ]);
      }
      if (!created.objectStoreNames.contains("receipts")) {
        const receipts = created.createObjectStore("receipts", { keyPath: "id" });
        receipts.createIndex("byCompletedAt", "completedAt");
        receipts.createIndex("byUndoOf", "undoOf", { unique: true });
      }
      if (!created.objectStoreNames.contains("notebookLifecycle")) {
        created.createObjectStore("notebookLifecycle", { keyPath: "notebookId" });
      }
      if (!created.objectStoreNames.contains("workspaceMetadata")) {
        created.createObjectStore("workspaceMetadata", { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("legacy open failed"));
  });
  const transaction = database.transaction(
    ["notebooks", "canvasSnapshots", "notes"],
    "readwrite",
  );
  transaction.objectStore("notebooks").put({
    id: "migration-workbook",
    title: "Migration workbook",
    subject: "Legacy subject",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
  transaction.objectStore("notes").put(legacyNote("active-note"));
  transaction.objectStore("notes").put(legacyNote("trashed-note", "trashed"));
  if (malformed) {
    transaction.objectStore("notes").put({ id: "bad-note", targetNotebookId: "migration-workbook" });
  }
  transaction.objectStore("canvasSnapshots").put({
    notebookId: "migration-workbook",
    version: 1,
    savedAt: at,
    snapshot: { shapes: [{ id: "legacy-shape", type: "ellipse" }] },
  });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("legacy seed failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("legacy seed aborted"));
  });
  database.close();
}

function textElement(id: string, text: string): TextElement {
  return {
    kind: "text",
    id: createElementId(id),
    label: id,
    frame: { x: 96, y: 100, width: 520, height: 160 },
    content: richTextFromPlainText(text, createTextBlockId(`${id}-block`)),
  };
}

describe("IndexedDB Phase 3 page storage", () => {
  it("migrates active notes and canvas provenance while preserving legacy rows and trashed notes", async () => {
    const name = databaseName("migration");
    await seedLegacy(name);
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });

    const document = await storage.ensureWorkbook(createNotebookId("migration-workbook"));
    expect(document.pages).toHaveLength(1);
    expect(derivePagePlainText(document.pages[0]!)).toBe("Legacy active-note");
    expect(document.pages[0]!.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "embedded-frame", componentType: "legacy-canvas" }),
    ]));
    const database = await openPhase2Database(name);
    expect(database.version).toBe(PHASE0_DATABASE_VERSION);
    expect(await database.get("notes", "trashed-note")).toEqual(legacyNote("trashed-note", "trashed"));
    expect(await database.get("canvasSnapshots", "migration-workbook")).toMatchObject({
      snapshot: { shapes: [{ id: "legacy-shape" }] },
    });
    expect(await database.get("pageMigrations", "phase3-v1:migration-workbook")).toMatchObject({ status: "complete" });
    database.close();
    await storage.close();
  });

  it("records malformed legacy rows separately and retries idempotently", async () => {
    const name = databaseName("migration-retry");
    await seedLegacy(name, true);
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });

    const first = await storage.ensureWorkbook(createNotebookId("migration-workbook"));
    const second = await storage.ensureWorkbook(createNotebookId("migration-workbook"));
    expect(second).toEqual(first);
    expect(first.pages[0]!.elements.filter((element) => element.kind === "text")).toHaveLength(1);
    const database = await openPhase2Database(name);
    const migrations = await database.get("pageMigrations", "phase3-v1:migration-workbook");
    expect(migrations?.issues).toEqual([expect.objectContaining({ kind: "malformed_note", id: "bad-note" })]);
    expect(await database.get("pageReceipts", "phase3:v1:migration-workbook")).toBeUndefined();
    database.close();
    await storage.close();
  });

  it("commits one valid page revision, rejects stale revisions, and deduplicates mutation retries", async () => {
    const name = databaseName("commit");
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });
    const workbookId = createNotebookId("commit-workbook");
    const actorId = createActorId("assistant-a");
    const initial = await storage.ensureWorkbook(workbookId);
    const page = initial.pages[0]!;
    const nextPage = addElement(page, textElement("text-1", "A typed page"), later);
    const next: PageDocument = { ...initial, pages: [nextPage] };
    const input = {
      workbookId,
      nextDocument: next,
      pageIds: [page.id],
      expectedDocumentRevision: initial.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId("mutation-1"),
      actorId,
      source: "assistant" as const,
      kind: "page_text_insert",
    };
    const committed = await storage.commit(input);
    expect(committed.status).toBe("committed");
    expect(committed.receipt.beforePages[0]!.revision).toBe(1);
    const duplicate = await storage.commit(input);
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.receipt.id).toBe(committed.receipt.id);
    await expect(storage.commit({ ...input, mutationId: createMutationId("mutation-2") })).rejects.toMatchObject({ code: "revision_conflict" });
    await storage.close();
  });

  it("holds one assistant claim per page, allows independent pages, and performs exact semantic Undo", async () => {
    const name = databaseName("claims-undo");
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });
    const workbookId = createNotebookId("claims-workbook");
    let document = await storage.ensureWorkbook(workbookId);
    document = await storage.appendPage(workbookId, document.documentRevision);
    const first = document.pages[0]!;
    const second = document.pages[1]!;
    const claim: PageWriterClaimInput = {
      workbookId,
      pageId: first.id,
      actorId: createActorId("agent-one"),
      claimId: "claim-one",
      ttlMs: 60_000,
    };
    await storage.claimPage(claim);
    await expect(storage.claimPage({ ...claim, actorId: createActorId("agent-two"), claimId: "claim-two" })).rejects.toMatchObject({ code: "page_busy" });
    const pageTwo = addElement(second, textElement("second", "Independent"), later);
    const pageTwoCommit = await storage.commit({
      workbookId,
      nextDocument: { ...document, pages: [first, pageTwo] },
      pageIds: [second.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [second.id]: second.revision },
      mutationId: createMutationId("second-page"),
      actorId: createActorId("agent-two"),
      source: "assistant",
      kind: "page_text_insert",
    });
    expect(pageTwoCommit.status).toBe("committed");
    await storage.releasePageWriter(claim);

    const pageOne = addElement(first, textElement("first", "Undo me"), later);
    const commit = await storage.commit({
      workbookId,
      nextDocument: { ...document, pages: [pageOne, pageTwo] },
      pageIds: [first.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [first.id]: first.revision },
      mutationId: createMutationId("undoable"),
      actorId: claim.actorId,
      source: "assistant",
      kind: "page_text_insert",
    });
    const undone = await storage.undo({
      workbookId,
      receiptId: commit.receipt.id,
      mutationId: createMutationId("undo-undoable"),
      actorId: claim.actorId,
      source: "assistant",
      visiblePageIds: [first.id, pageTwo.id],
    });
    expect(undone.status).toBe("committed");
    const afterUndo = await storage.read(workbookId);
    expect(derivePagePlainText(afterUndo.pages[0]!)).toBe("");
    await storage.close();
  });

  it("rolls back page and receipt rows when the transaction fails after page write", async () => {
    const name = databaseName("rollback");
    let fail = true;
    const storage = new IndexedDbPageStorage({
      databaseName: name,
      clock: { now: () => later },
      failureHook: (point) => {
        if (fail && point === "page.commit.receipt-write") throw new Error("injected page receipt failure");
      },
    });
    const workbookId = createNotebookId("rollback-workbook");
    const initial = await storage.ensureWorkbook(workbookId);
    const page = initial.pages[0]!;
    const nextPage = addElement(page, textElement("rollback", "Should not persist"), later);
    await expect(storage.commit({
      workbookId,
      nextDocument: { ...initial, pages: [nextPage] },
      pageIds: [page.id],
      expectedDocumentRevision: initial.documentRevision,
      expectedPageRevisions: { [page.id]: page.revision },
      mutationId: createMutationId("rollback-mutation"),
      actorId: createActorId("assistant-rollback"),
      source: "assistant",
      kind: "page_text_insert",
    })).rejects.toThrow("injected page receipt failure");
    fail = false;
    expect(derivePagePlainText((await storage.read(workbookId)).pages[0]!)).toBe("");
    await storage.close();
  });

  it("fails closed when a commit mutates a page that is missing from pageIds", async () => {
    const name = databaseName("undeclared-page");
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });
    const workbookId = createNotebookId("undeclared-workbook");
    let initial = await storage.ensureWorkbook(workbookId);
    initial = await storage.appendPage(workbookId, initial.documentRevision);
    const first = initial.pages[0]!;
    const second = initial.pages[1]!;
    const mutated = addElement(first, textElement("undeclared", "Must not persist"), later);

    await expect(storage.commit({
      workbookId,
      nextDocument: { ...initial, pages: [mutated, second] },
      pageIds: [second.id],
      expectedDocumentRevision: initial.documentRevision,
      expectedPageRevisions: { [second.id]: second.revision },
      mutationId: createMutationId("undeclared-mutation"),
      actorId: createActorId("undeclared-actor"),
      source: "person",
      kind: "page_text_insert",
    })).rejects.toMatchObject({ code: "invalid_page" });
    expect(await storage.read(workbookId)).toEqual(initial);
    await storage.close();
  });

  it("blocks Undo when any affected page is claimed by another actor, while allowing the claimant to undo", async () => {
    const name = databaseName("undo-claim");
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });
    const workbookId = createNotebookId("undo-claim-workbook");
    const initial = await storage.ensureWorkbook(workbookId);
    const advanced = appendDomainPage(initial, later);
    const actor = createActorId("undo-actor");
    const committed = await storage.commit({
      workbookId,
      nextDocument: advanced,
      pageIds: [advanced.pages[1]!.id],
      expectedDocumentRevision: initial.documentRevision,
      expectedPageRevisions: {},
      mutationId: createMutationId("undo-claim-mutation"),
      actorId: actor,
      source: "assistant",
      kind: "page_advance",
    });
    const otherClaim = {
      workbookId,
      pageId: advanced.pages[1]!.id,
      actorId: createActorId("other-actor"),
      claimId: "other-claim",
      ttlMs: 60_000,
    } satisfies PageWriterClaimInput;
    await storage.claimPage(otherClaim);
    await expect(storage.undo({
      workbookId,
      receiptId: committed.receipt.id,
      mutationId: createMutationId("undo-claim-blocked"),
      actorId: actor,
      source: "assistant",
      visiblePageIds: advanced.pageOrder,
    })).rejects.toMatchObject({ code: "page_busy" });
    await storage.releasePageWriter(otherClaim);
    const sameActorClaim = {
      ...otherClaim,
      actorId: actor,
      claimId: "same-actor-claim",
    };
    await storage.claimPage(sameActorClaim);
    await expect(storage.undo({
      workbookId,
      receiptId: committed.receipt.id,
      mutationId: createMutationId("undo-claim-allowed"),
      actorId: actor,
      source: "assistant",
      claimId: sameActorClaim.claimId,
      visiblePageIds: advanced.pageOrder,
    })).resolves.toMatchObject({ status: "committed" });
    await storage.close();
  });

  it("turns malformed canonical page rows into invalid_page without removing the row", async () => {
    const name = databaseName("malformed-page-row");
    const storage = new IndexedDbPageStorage({ databaseName: name, clock: { now: () => later } });
    const workbookId = createNotebookId("malformed-page-workbook");
    const document = await storage.ensureWorkbook(workbookId);
    const database = await openPhase2Database(name);
    const malformed = await database.get("pages", document.pages[0]!.id);
    database.close();
    if (malformed === undefined) throw new Error("Seeded page row was unavailable.");
    const rawDatabase = await openPhase2Database(name);
    const transaction = rawDatabase.transaction("pages", "readwrite");
    transaction.objectStore("pages").put({ ...malformed, elements: "not-an-array" as unknown as readonly unknown[] });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("malformed row write failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("malformed row write aborted"));
    });
    rawDatabase.close();
    await expect(storage.read(workbookId)).rejects.toMatchObject({ code: "invalid_page" });
    const preserved = await openPhase2Database(name);
    expect((await preserved.get("pages", document.pages[0]!.id))?.elements).toBe("not-an-array");
    preserved.close();
    await storage.close();
  });

  it("rejects a canonical document row that references a missing page", () => {
    expect(() => decodePageDocument({
      workbookId: "missing-page-workbook",
      version: 1,
      documentRevision: 1,
      pageOrder: ["missing-page"],
      updatedAt: at,
    }, [])).toThrowError("Page missing-page is missing.");
  });
});
