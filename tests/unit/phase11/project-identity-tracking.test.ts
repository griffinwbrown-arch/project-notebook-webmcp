import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProjectActor,
  createProjectId,
  createProjectItemId,
  createProjectItemReceiptId,
  createProjectMutationId,
  createProjectWorkbookId,
  createProjectItemRevision,
  parseProjectItemRow,
  parseWorkbookIdentityRow,
} from "../../../src/projects";
import {
  IndexedDbProjectStorage,
  ProjectStorageError,
} from "../../../src/indexeddb/project-storage";
import {
  openPhase2Database,
  PHASE0_DATABASE_VERSION,
} from "../../../src/indexeddb/database";

const databases = new Set<string>();
const at = "2026-08-29T12:00:00.000Z";
const later = "2026-08-29T12:01:00.000Z";

function databaseName(label: string): string {
  const name = `phase11-project-${label}-${Math.random().toString(36).slice(2)}`;
  databases.add(name);
  return name;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("delete failed"));
    request.onblocked = () => reject(new Error("delete blocked"));
  });
}

async function openCurrentDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("open current database failed"));
  });
}

afterEach(async () => {
  await Promise.all([...databases].map(deleteDatabase));
  databases.clear();
});

type SchemaSnapshot = Readonly<Record<string, Readonly<{
  keyPath: string | readonly string[] | null;
  indexes: readonly Readonly<{
    name: string;
    keyPath: string | readonly string[];
    unique: boolean;
  }>[];
  rows: readonly unknown[];
}>>>;

async function seedVersion3(name: string): Promise<SchemaSnapshot> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    request.onupgradeneeded = () => {
      const created = request.result;
      created.createObjectStore("notebooks", { keyPath: "id" });
      created.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
      const notes = created.createObjectStore("notes", { keyPath: "id" });
      notes.createIndex("byNotebookLifecycleCreatedAtId", ["targetNotebookId", "lifecycle", "createdAt", "id"]);
      const receipts = created.createObjectStore("receipts", { keyPath: "id" });
      receipts.createIndex("byCompletedAt", "completedAt");
      receipts.createIndex("byUndoOf", "undoOf", { unique: true });
      created.createObjectStore("notebookLifecycle", { keyPath: "notebookId" });
      created.createObjectStore("workspaceMetadata", { keyPath: "id" });
      const documents = created.createObjectStore("pageDocuments", { keyPath: "workbookId" });
      documents.createIndex("byUpdatedAt", "updatedAt");
      const pages = created.createObjectStore("pages", { keyPath: "id" });
      pages.createIndex("byWorkbookId", "workbookId");
      pages.createIndex("byWorkbookNumber", ["workbookId", "number"]);
      const pageReceipts = created.createObjectStore("pageReceipts", { keyPath: "id" });
      pageReceipts.createIndex("byWorkbookId", "workbookId");
      pageReceipts.createIndex("byMutationId", "mutationId", { unique: true });
      pageReceipts.createIndex("byCompletedAt", "completedAt");
      const claims = created.createObjectStore("pageWriterClaims", { keyPath: "pageId" });
      claims.createIndex("byWorkbookId", "workbookId");
      claims.createIndex("byExpiresAt", "expiresAt");
      const migrations = created.createObjectStore("pageMigrations", { keyPath: "id" });
      migrations.createIndex("byWorkbookId", "workbookId", { unique: true });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("open failed"));
  });
  const tx = database.transaction(
    ["notebooks", "canvasSnapshots", "notes", "receipts", "notebookLifecycle", "workspaceMetadata", "pageDocuments", "pages", "pageReceipts", "pageWriterClaims", "pageMigrations"],
    "readwrite",
  );
  tx.objectStore("notebooks").put({ id: "legacy-workbook", title: "Legacy", subject: "Preserve", revision: 7, createdAt: at, updatedAt: at });
  tx.objectStore("canvasSnapshots").put({ notebookId: "legacy-workbook", version: 1, savedAt: at, snapshot: { shapes: [] } });
  tx.objectStore("notes").put({ id: "legacy-note", targetNotebookId: "legacy-workbook", revision: 2, contentVersion: 1, content: { format: "plain_text", text: "Keep exactly" }, lifecycle: "active", createdAt: at, updatedAt: at });
  tx.objectStore("receipts").put({ id: "legacy-receipt", kind: "capture_note", source: "person", completedAt: at, undo: { kind: "available" } });
  tx.objectStore("notebookLifecycle").put({ notebookId: "legacy-workbook", lifecycle: "active", revision: 3, updatedAt: at });
  tx.objectStore("workspaceMetadata").put({ id: "workspace", version: 1, inboxNotebookId: "legacy-workbook", currentTargetNotebookId: "legacy-workbook", revision: 4, updatedAt: at });
  tx.objectStore("pageDocuments").put({ workbookId: "legacy-workbook", version: 1, documentRevision: 5, pageOrder: ["legacy-page"], updatedAt: at });
  tx.objectStore("pages").put({ id: "legacy-page", workbookId: "legacy-workbook", version: 1, number: 1, revision: 6, size: { width: 816, height: 1056 }, paper: "lined", elements: [], createdAt: at, updatedAt: at });
  tx.objectStore("pageReceipts").put({ id: "legacy-page-receipt", workbookId: "legacy-workbook", mutationId: "legacy-mutation", actorId: "legacy-actor", source: "person", kind: "page_edit", completedAt: at, fingerprint: "legacy-only", beforeDocument: { workbookId: "legacy-workbook", version: 1, documentRevision: 4, pageOrder: ["legacy-page"], updatedAt: at }, beforePages: [], affectedPageIds: ["legacy-page"], resultingDocumentRevision: 5, resultingPageRevisions: { "legacy-page": 6 }, undo: { kind: "available" } });
  tx.objectStore("pageWriterClaims").put({ pageId: "legacy-page", workbookId: "legacy-workbook", actorId: "legacy-actor", claimId: "legacy-claim", expiresAt: later, acquiredAt: at });
  tx.objectStore("pageMigrations").put({ id: "phase3-v1:legacy-workbook", workbookId: "legacy-workbook", version: 1, status: "complete", completedAt: at, migratedNoteIds: ["legacy-note"], migratedCanvas: true, issues: [] });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("seed failed"));
    tx.onabort = () => reject(tx.error ?? new Error("seed aborted"));
  });
  const snapshot = await snapshotSchema(database);
  database.close();
  return snapshot;
}

async function snapshotSchema(database: IDBDatabase): Promise<SchemaSnapshot> {
  const names = Array.from(database.objectStoreNames);
  const tx = database.transaction(names, "readonly");
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("schema snapshot failed"));
    tx.onabort = () => reject(tx.error ?? new Error("schema snapshot aborted"));
  });
  const entries = await Promise.all(names.map(async (name) => {
    const store = tx.objectStore(name);
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("snapshot failed"));
    });
    const indexes = Array.from(store.indexNames).map((indexName) => {
      const index = store.index(indexName);
      return { name: indexName, keyPath: index.keyPath, unique: index.unique };
    });
    return [name, { keyPath: store.keyPath, indexes, rows }] as const;
  }));
  await completed;
  return Object.fromEntries(entries);
}

const person = createProjectActor({ kind: "user", id: "person-1" });
const agent = createProjectActor({ kind: "agent", id: "agent-1" });

describe("Phase 11 project identity and tracking persistence", () => {
  it("adds only the five version-4 stores while preserving every version-3 store, row, key path, and index", async () => {
    const name = databaseName("migration");
    const before = await seedVersion3(name);
    const database = await openPhase2Database(name);
    expect(database.version).toBe(4);
    expect(PHASE0_DATABASE_VERSION).toBe(4);
    database.close();
    const rawDatabase = await openCurrentDatabase(name);
    const after = await snapshotSchema(rawDatabase);
    for (const [storeName, expected] of Object.entries(before)) {
      expect(after[storeName]).toEqual(expected);
    }
    expect(Object.keys(after).sort()).toEqual([
      ...Object.keys(before),
      "pageScraps",
      "projectItemReceipts",
      "projectItems",
      "projects",
      "workbookIdentities",
    ].sort());
    rawDatabase.close();
  });

  it("resolves one actor-independent Agent Workbook per project and binds user workbooks only explicitly", async () => {
    const name = databaseName("identity");
    await seedVersion3(name);
    const storage = new IndexedDbProjectStorage({ databaseName: name, clock: { now: () => at } });
    const projectId = createProjectId("project-alpha");
    await storage.createProject({ projectId, name: "Alpha", createdBy: person });

    const [first, second] = await Promise.all([storage.resolveAgentWorkbook({
      projectId,
      workbookId: createProjectWorkbookId("agent-alpha-a"),
      title: "Agent Alpha",
      subject: "Project work",
      requestedBy: agent,
    }), storage.resolveAgentWorkbook({
      projectId,
      workbookId: createProjectWorkbookId("agent-alpha-b"),
      title: "A mutable title that cannot affect lookup",
      subject: "Ignored for existing identity",
      requestedBy: createProjectActor({ kind: "agent", id: "agent-2" }),
    })]);
    expect(first).toEqual(second);
    expect(second).toMatchObject({ kind: "agent", workbookId: "agent-alpha-a", projectId: "project-alpha" });

    expect(await storage.getWorkbookIdentity(createProjectWorkbookId("legacy-workbook"))).toBeNull();
    const bound = await storage.bindUserWorkbook({ workbookId: createProjectWorkbookId("legacy-workbook"), projectId });
    expect(bound).toMatchObject({ kind: "user", workbookId: "legacy-workbook", projectId: "project-alpha" });
    expect((await storage.listWorkbookIdentities()).map((identity) => identity.kind).sort()).toEqual(["agent", "user"]);
    await storage.close();
  });

  it("rolls back Agent Workbook identity, notebook, and initial page as one unit", async () => {
    const name = databaseName("agent-rollback");
    await seedVersion3(name);
    const storage = new IndexedDbProjectStorage({
      databaseName: name,
      clock: { now: () => at },
      failureHook: (point) => {
        if (point === "agent-workbook.after-page") throw new Error("injected agent workbook failure");
      },
    });
    const projectId = createProjectId("project-rollback");
    await storage.createProject({ projectId, name: "Rollback", createdBy: person });
    await expect(storage.resolveAgentWorkbook({
      projectId,
      workbookId: createProjectWorkbookId("agent-rollback"),
      title: "Agent rollback",
      subject: "Must remain atomic",
      requestedBy: agent,
    })).rejects.toThrow("injected agent workbook failure");
    const database = await openPhase2Database(name);
    expect(await database.get("notebooks", "agent-rollback")).toBeUndefined();
    expect(await database.get("pageDocuments", "agent-rollback")).toBeUndefined();
    expect(await database.get("workbookIdentities", "agent-rollback")).toBeUndefined();
    expect(await database.getFromIndex("workbookIdentities", "byAgentProjectId", projectId)).toBeUndefined();
    database.close();
    await storage.close();
  });

  it("rolls back project creation and user binding as one unit", async () => {
    const name = databaseName("project-bind-rollback");
    await seedVersion3(name);
    const storage = new IndexedDbProjectStorage({
      databaseName: name,
      clock: { now: () => at },
      failureHook: (point) => {
        if (point === "project-bind.after-project") throw new Error("injected project bind failure");
      },
    });
    const projectId = createProjectId("project-bind-rollback");
    await expect(storage.createProjectAndBindUserWorkbook({
      workbookId: createProjectWorkbookId("legacy-workbook"),
      projectId,
      name: "Atomic binding",
      createdBy: person,
    })).rejects.toThrow("injected project bind failure");
    const database = await openPhase2Database(name);
    expect(await database.get("projects", projectId)).toBeUndefined();
    expect(await database.get("workbookIdentities", "legacy-workbook")).toBeUndefined();
    database.close();
    await storage.close();
  });

  it("records one item revision and receipt per meaningful edit, preserves authorship, and performs exact semantic Undo", async () => {
    const name = databaseName("tracking");
    await seedVersion3(name);
    const receipts = ["receipt-create", "receipt-update", "receipt-undo"].map(createProjectItemReceiptId);
    const storage = new IndexedDbProjectStorage({
      databaseName: name,
      clock: { now: () => later },
      ids: { newReceiptId: () => {
        const next = receipts.shift();
        if (next === undefined) throw new Error("unexpected receipt allocation");
        return next;
      } },
    });
    const projectId = createProjectId("project-tracking");
    const workbookId = createProjectWorkbookId("legacy-workbook");
    await storage.createProject({ projectId, name: "Tracking", createdBy: person });
    await storage.bindUserWorkbook({ workbookId, projectId });

    const created = await storage.createItem({
      id: createProjectItemId("item-1"),
      projectId,
      workbookId,
      kind: "task",
      title: "Write the field notes",
      status: "open",
      anchor: { kind: "element", pageId: "legacy-page", elementId: "missing" },
      mutationId: createProjectMutationId("item-create"),
      actor: person,
      source: "manual",
    }).catch((error: unknown) => error);
    expect(created).toBeInstanceOf(ProjectStorageError);
    expect(created).toMatchObject({ code: "invalid_target" });

    const committed = await storage.createItem({
      id: createProjectItemId("item-1"),
      projectId,
      workbookId,
      kind: "task",
      title: "Write the field notes",
      status: "open",
      anchor: { kind: "page", pageId: "legacy-page" },
      mutationId: createProjectMutationId("item-create"),
      actor: person,
      source: "manual",
    });
    expect(committed.status).toBe("committed");
    expect(committed.item).toMatchObject({ revision: 1, authoredBy: person });

    const updated = await storage.updateItem({
      id: committed.item.id,
      expectedRevision: createProjectItemRevision(1),
      title: committed.item.title,
      status: "in_progress",
      anchor: committed.item.anchor,
      mutationId: createProjectMutationId("item-update"),
      actor: agent,
      source: "webmcp",
    });
    expect(updated.item).toMatchObject({ revision: 2, status: "in_progress", authoredBy: person });
    expect(updated.receipt).toMatchObject({ actor: agent, source: "webmcp" });

    const undone = await storage.undoItem({
      receiptId: updated.receipt.id,
      mutationId: createProjectMutationId("item-undo"),
      actor: person,
      source: "manual",
    });
    expect(undone.item).toMatchObject({ revision: 3, status: "open", authoredBy: person });
    expect((await storage.getItem(committed.item.id))?.status).toBe("open");
    expect(await storage.listReceipts(committed.item.id)).toHaveLength(3);
    await storage.close();
  });

  it("rejects stale, no-op, unsafe, cross-workbook, and mutation-reuse requests without changing items or receipts", async () => {
    const name = databaseName("fail-closed");
    await seedVersion3(name);
    const storage = new IndexedDbProjectStorage({
      databaseName: name,
      clock: { now: () => later },
      ids: { newReceiptId: () => createProjectItemReceiptId(`receipt-${Math.random().toString(36).slice(2)}`) },
    });
    const projectId = createProjectId("project-safe");
    const workbookId = createProjectWorkbookId("legacy-workbook");
    await storage.createProject({ projectId, name: "Safe", createdBy: person });
    await storage.bindUserWorkbook({ workbookId, projectId });
    const created = await storage.createItem({
      id: createProjectItemId("safe-item"), projectId, workbookId, kind: "decision", title: "Use the ruled margin", status: "open",
      anchor: { kind: "none" }, mutationId: createProjectMutationId("safe-create"), actor: person, source: "manual",
    });
    const beforeItems = await storage.listItems({ projectId, workbookId });
    const beforeReceipts = await storage.listReceipts(created.item.id);

    await expect(storage.updateItem({ id: created.item.id, expectedRevision: createProjectItemRevision(2), title: created.item.title, status: "done", anchor: created.item.anchor, mutationId: createProjectMutationId("stale"), actor: person, source: "manual" })).rejects.toMatchObject({ code: "stale" });
    await expect(storage.updateItem({ id: created.item.id, expectedRevision: created.item.revision, title: created.item.title, status: created.item.status, anchor: created.item.anchor, mutationId: createProjectMutationId("noop"), actor: person, source: "manual" })).rejects.toMatchObject({ code: "no_op" });
    await expect(storage.updateItem({ id: created.item.id, expectedRevision: created.item.revision, title: "<script>alert(1)</script>", status: "done", anchor: created.item.anchor, mutationId: createProjectMutationId("unsafe"), actor: person, source: "manual" })).rejects.toMatchObject({ code: "unsafe" });
    await expect(storage.createItem({
      id: createProjectItemId("other-item"), projectId, workbookId: createProjectWorkbookId("unbound-workbook"), kind: "milestone", title: "Cross target", status: "open", anchor: { kind: "none" }, mutationId: createProjectMutationId("cross"), actor: agent, source: "webmcp",
    })).rejects.toMatchObject({ code: "invalid_target" });
    await expect(storage.createItem({
      id: createProjectItemId("reuse-item"), projectId, workbookId, kind: "task", title: "Different request", status: "open", anchor: { kind: "none" }, mutationId: createProjectMutationId("safe-create"), actor: person, source: "manual",
    })).rejects.toMatchObject({ code: "mutation_reuse" });
    expect(await storage.listItems({ projectId, workbookId })).toEqual(beforeItems);
    expect(await storage.listReceipts(created.item.id)).toEqual(beforeReceipts);
    await storage.close();
  });

  it("rejects malformed durable identity and tracking rows at the strict boundary", () => {
    expect(() => parseWorkbookIdentityRow({
      version: 1,
      kind: "agent",
      workbookId: "agent-1",
      projectId: "project-1",
      agentProjectId: "project-other",
      shelfKind: "agent",
      createdAt: at,
    })).toThrow("project index is inconsistent");
    expect(() => parseProjectItemRow({
      version: 1,
      id: "item-bad",
      projectId: "project-1",
      workbookId: "workbook-1",
      kind: "task",
      title: "Safe title",
      status: "open",
      anchor: { kind: "none" },
      revision: 1,
      authoredBy: { kind: "user", id: "person-1" },
      createdAt: at,
      updatedAt: at,
      rawHtml: "<p>forbidden</p>",
    })).toThrow();
  });
});
