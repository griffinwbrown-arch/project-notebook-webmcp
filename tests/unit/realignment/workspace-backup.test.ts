import { deleteDB } from "idb";
import { describe, expect, it, vi } from "vitest";

import {
  createWorkspaceBackup,
  parseWorkspaceBackup,
  parseWorkspaceBackupJson,
  restoreWorkspaceBackup,
  serializeWorkspaceBackup,
} from "../../../src/indexeddb/workspace-backup";
import { openPhase2Database } from "../../../src/indexeddb/database";

const exportedAt = "2026-08-30T02:45:00.000Z";
const pageDocument = {
  workbookId: "backup-notebook",
  version: 1,
  documentRevision: 1,
  pageOrder: ["page:backup"],
  updatedAt: exportedAt,
};
const page = {
  id: "page:backup",
  workbookId: "backup-notebook",
  version: 1,
  number: 1,
  revision: 1,
  size: { width: 816, height: 1056 },
  elements: [],
  createdAt: exportedAt,
  updatedAt: exportedAt,
};
const projectItem = {
  version: 1,
  id: "item:backup",
  projectId: "project:backup",
  workbookId: "backup-notebook",
  kind: "task" as const,
  title: "Verify backup",
  status: "open" as const,
  anchor: { kind: "none" as const },
  revision: 1,
  authoredBy: { kind: "user" as const, id: "user:backup" },
  createdAt: exportedAt,
  updatedAt: exportedAt,
};

function validBackupValue(): unknown {
  return {
    format: "project-notebook-workspace-backup",
    version: 1,
    databaseVersion: 4,
    exportedAt,
    stores: {
      notebooks: [
        { id: "backup-notebook", title: "Backup notebook", subject: "Recovery", revision: 1, createdAt: exportedAt, updatedAt: exportedAt },
        { id: "inbox", title: "Inbox", subject: "Inbox", revision: 1, createdAt: exportedAt, updatedAt: exportedAt },
      ],
      canvasSnapshots: [{ notebookId: "backup-notebook", version: 1, savedAt: exportedAt, snapshot: { shapes: [] } }],
      notes: [{ id: "note:backup", targetNotebookId: "backup-notebook", revision: 1, contentVersion: 1, content: { format: "plain_text", text: "Saved" }, lifecycle: "active", createdAt: exportedAt, updatedAt: exportedAt }],
      receipts: [{ id: "receipt:backup", kind: "capture_note", source: "person", completedAt: exportedAt, noteId: "note:backup", targetNotebookId: "backup-notebook", resultingRevision: 1, undo: { kind: "available", effect: "withdraw_capture" } }],
      notebookLifecycle: [{ notebookId: "backup-notebook", lifecycle: "active", revision: 1, updatedAt: exportedAt }],
      workspaceMetadata: [{ id: "workspace", version: 1, inboxNotebookId: "inbox", currentTargetNotebookId: "backup-notebook", revision: 1, updatedAt: exportedAt }],
      pageDocuments: [pageDocument],
      pages: [page],
      pageReceipts: [{ id: "page-receipt:backup", workbookId: "backup-notebook", mutationId: "mutation:backup", actorId: "user:backup", source: "person", kind: "page_rework_apply", completedAt: exportedAt, fingerprint: "fingerprint", beforeDocument: pageDocument, beforePages: [page], affectedPageIds: [page.id], resultingDocumentRevision: 1, resultingPageRevisions: { [page.id]: 1 }, undo: { kind: "unavailable" } }],
      pageMigrations: [{ id: "phase3-v1:backup-notebook", workbookId: "backup-notebook", version: 1, status: "complete", completedAt: exportedAt, migratedNoteIds: [], migratedCanvas: false, issues: [] }],
      projects: [{ version: 1, id: "project:backup", name: "Backup project", revision: 1, createdBy: { kind: "user", id: "user:backup" }, createdAt: exportedAt, updatedAt: exportedAt }],
      workbookIdentities: [{ version: 1, kind: "user", workbookId: "backup-notebook", projectId: "project:backup", shelfKind: "user", createdAt: exportedAt }],
      projectItems: [projectItem],
      projectItemReceipts: [{ version: 1, id: "item-receipt:backup", mutationId: "item-mutation:backup", projectId: "project:backup", workbookId: "backup-notebook", itemId: "item:backup", kind: "project_item_create", actor: { kind: "user", id: "user:backup" }, source: "manual", completedAt: exportedAt, beforeItem: null, afterItem: projectItem, request: { kind: "create", itemId: "item:backup", projectId: "project:backup", workbookId: "backup-notebook", itemKind: "task", title: "Verify backup", status: "open", anchor: { kind: "none" }, actor: { kind: "user", id: "user:backup" }, source: "manual" }, undo: { kind: "available" } }],
      pageScraps: [{ version: 1, id: "scrap:backup", workbookId: "backup-notebook", reason: "Before rework", capturedBy: { kind: "user", id: "user:backup" }, capturedAt: exportedAt, beforeDocument: pageDocument, beforePages: [page], assetReferences: [], resultingDocumentRevision: 1, resultingPageOrder: [page.id], resultingPageRevisions: { [page.id]: 1 }, reworkReceiptId: "page-receipt:backup" }],
    },
  };
}

const requiredFieldCases = [
  ["notebooks", "title"],
  ["canvasSnapshots", "savedAt"],
  ["notes", "contentVersion"],
  ["receipts", "kind"],
  ["notebookLifecycle", "revision"],
  ["workspaceMetadata", "currentTargetNotebookId"],
  ["pageDocuments", "documentRevision"],
  ["pages", "number"],
  ["pageReceipts", "fingerprint"],
  ["pageMigrations", "status"],
  ["projects", "name"],
  ["workbookIdentities", "shelfKind"],
  ["projectItems", "title"],
  ["projectItemReceipts", "mutationId"],
  ["pageScraps", "reworkReceiptId"],
] as const;

describe("workspace backup", () => {
  it("round-trips every durable store and clears transient writer claims", async () => {
    const databaseName = "workspace-backup-restored";
    try {
      const backup = parseWorkspaceBackup(validBackupValue());
      expect(parseWorkspaceBackupJson(serializeWorkspaceBackup(backup))).toEqual(backup);
      expect("pageWriterClaims" in backup.stores).toBe(false);

      const database = await openPhase2Database(databaseName);
      await database.put("notebooks", { id: "stale-notebook", title: "Stale", subject: "Replace me", revision: 1, createdAt: exportedAt, updatedAt: exportedAt });
      await database.put("pageWriterClaims", { pageId: "page:stale", workbookId: "stale-notebook", actorId: "agent:stale", claimId: "claim:stale", acquiredAt: exportedAt, expiresAt: "2026-08-30T02:46:00.000Z" });
      database.close();

      await restoreWorkspaceBackup(backup, databaseName);
      expect(await createWorkspaceBackup(databaseName, exportedAt)).toEqual(backup);

      const inspected = await openPhase2Database(databaseName);
      expect(await inspected.getAll("pageWriterClaims")).toEqual([]);
      inspected.close();
    } finally {
      await deleteDB(databaseName);
    }
  });

  it.each(requiredFieldCases)("rejects a %s row without %s", (storeName, fieldName) => {
    const candidate = structuredClone(validBackupValue()) as { stores: Record<string, Record<string, unknown>[]> };
    delete candidate.stores[storeName]?.[0]?.[fieldName];
    expect(() => parseWorkspaceBackup(candidate)).toThrow();
  });

  it("rejects non-object store rows", () => {
    const candidate = structuredClone(validBackupValue()) as { stores: { notebooks: unknown[] } };
    candidate.stores.notebooks = [null];
    expect(() => parseWorkspaceBackup(candidate)).toThrow();
  });

  it("rejects malformed nested row content", () => {
    const candidate = structuredClone(validBackupValue()) as {
      stores: {
        notes: Array<Record<string, unknown>>;
        pages: Array<Record<string, unknown>>;
      };
    };
    candidate.stores.notes[0]!.content = { format: "rich_text", blocks: [] };
    candidate.stores.pages[0]!.elements = "not-an-array";
    expect(() => parseWorkspaceBackup(candidate)).toThrow();
  });

  it("rejects malformed input before replacing the target database", async () => {
    const databaseName = "workspace-backup-invalid";
    try {
      const database = await openPhase2Database(databaseName);
      await database.put("notebooks", { id: "preserved-notebook", title: "Preserved", subject: "Unchanged", revision: 1, createdAt: exportedAt, updatedAt: exportedAt });
      const claim = { pageId: "page:stale", workbookId: "stale-notebook", actorId: "agent:stale", claimId: "claim:stale", acquiredAt: exportedAt, expiresAt: "2026-08-30T02:46:00.000Z" };
      await database.put("pageWriterClaims", claim);
      database.close();

      const malformed = structuredClone(validBackupValue()) as { stores: { pages: Array<Record<string, unknown>> } };
      malformed.stores.pages[0]!.workbookId = "missing-notebook";
      await expect(restoreWorkspaceBackup(malformed, databaseName)).rejects.toThrow();

      const inspected = await openPhase2Database(databaseName);
      expect((await inspected.getAll("notebooks")).map((row) => row.id)).toEqual(["preserved-notebook"]);
      expect(await inspected.getAll("pageWriterClaims")).toEqual([claim]);
      inspected.close();
    } finally {
      await deleteDB(databaseName);
    }
  });

  it("aborts an in-flight replacement and preserves every prior row and writer claim", async () => {
    const databaseName = "workspace-backup-write-failure";
    const claim = { pageId: "page:preserved", workbookId: "preserved-notebook", actorId: "agent:preserved", claimId: "claim:preserved", acquiredAt: exportedAt, expiresAt: "2026-08-30T02:46:00.000Z" };
    const preservedNotebook = { id: "preserved-notebook", title: "Preserved", subject: "Unchanged", revision: 1, createdAt: exportedAt, updatedAt: exportedAt };
    const nativePut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore["put"]>
    ): IDBRequest<IDBValidKey> {
      if (this.name === "pageDocuments") throw new DOMException("Forced restore write failure.", "AbortError");
      return nativePut.apply(this, args);
    });
    try {
      const database = await openPhase2Database(databaseName);
      await database.put("notebooks", preservedNotebook);
      await database.put("pageWriterClaims", claim);
      database.close();

      await expect(restoreWorkspaceBackup(validBackupValue(), databaseName)).rejects.toThrow("Forced restore write failure.");

      const inspected = await openPhase2Database(databaseName);
      expect(await inspected.getAll("notebooks")).toEqual([preservedNotebook]);
      expect(await inspected.getAll("pageWriterClaims")).toEqual([claim]);
      expect(await inspected.getAll("pages")).toEqual([]);
      inspected.close();
    } finally {
      put.mockRestore();
      await deleteDB(databaseName);
    }
  });

  it.each([
    "notebooks",
    "canvasSnapshots",
    "notes",
    "receipts",
    "notebookLifecycle",
    "workspaceMetadata",
    "pageDocuments",
    "pages",
    "pageReceipts",
    "pageMigrations",
    "projects",
    "workbookIdentities",
    "projectItems",
    "projectItemReceipts",
    "pageScraps",
  ] as const)("rejects duplicate rows in %s", (storeName) => {
    const candidate = structuredClone(validBackupValue()) as { stores: Record<string, unknown[]> };
    const rows = candidate.stores[storeName]!;
    rows.push(structuredClone(rows[0]));
    expect(() => parseWorkspaceBackup(candidate)).toThrow();
  });

  it("rejects a malformed timestamp, discriminant, or optional value", () => {
    const timestamp = structuredClone(validBackupValue()) as { exportedAt: string };
    timestamp.exportedAt = "2026-08-30T02:45:00Z";
    expect(() => parseWorkspaceBackup(timestamp)).toThrow();

    const discriminant = structuredClone(validBackupValue()) as { stores: { pages: Array<Record<string, unknown>>; pageReceipts: Array<Record<string, unknown>> } };
    discriminant.stores.pages[0]!.elements = [{ kind: "unknown", id: "element", label: "bad", frame: { x: 0, y: 0, width: 100, height: 100 } }];
    expect(() => parseWorkspaceBackup(discriminant)).toThrow();

    const receiptKind = structuredClone(validBackupValue()) as { stores: { pageReceipts: Array<Record<string, unknown>> } };
    receiptKind.stores.pageReceipts[0]!.kind = "unknown";
    expect(() => parseWorkspaceBackup(receiptKind)).toThrow();

    const optional = structuredClone(validBackupValue()) as { stores: { pages: Array<Record<string, unknown>> } };
    optional.stores.pages[0]!.paper = undefined;
    expect(() => parseWorkspaceBackup(optional)).toThrow();
  });

  it("orders durable rows and object keys deterministically", () => {
    const candidate = structuredClone(validBackupValue()) as { stores: { notebooks: unknown[] } };
    candidate.stores.notebooks.reverse();
    const backup = parseWorkspaceBackup(candidate);
    expect(backup.stores.notebooks.map((row) => row.id)).toEqual(["backup-notebook", "inbox"]);
    const serialized = serializeWorkspaceBackup(backup);
    expect(serialized.indexOf('"databaseVersion"')).toBeLessThan(serialized.indexOf('"exportedAt"'));
    expect(serialized).toBe(serializeWorkspaceBackup(parseWorkspaceBackupJson(serialized)));
  });
});
