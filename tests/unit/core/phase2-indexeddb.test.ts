import { describe, expect, it } from "vitest";

import {
  createNoteId,
  createNotebookId,
  createReceiptId,
  createRevision,
  type NoteId,
  type NotebookId,
  type ReceiptId,
} from "../../../src/domain";
import { IndexedDbWorkspaceRepository } from "../../../src/indexeddb/workspace-repository";

const INBOX_ID = "inbox";
const inboxNotebookId = createNotebookId(INBOX_ID);
const destinationNotebookId = createNotebookId("destination");
const workNotebookId = createNotebookId("work-notebook");
const noteMoveId = createNoteId("note-move");
const noteUndoId = createNoteId("note-undo");
const noteLifecycleId = createNoteId("note-lifecycle");
const captureReceiptId = createReceiptId("receipt-capture");
const DATABASE_VERSION_1 = 1;
const CURRENT_DATABASE_VERSION = 4;
const timestamp = "2026-08-25T12:00:00.000Z";

type LegacyNotebookRow = {
  readonly id: string;
  readonly title: string;
  readonly subject: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type LegacyCanvasRow = {
  readonly notebookId: string;
  readonly version: 1;
  readonly savedAt: string;
  readonly snapshot: unknown;
};

const preservedNotebook: LegacyNotebookRow = {
  id: "preserved-phase2",
  title: "Preserved field notes",
  subject: "Existing local notebook",
  revision: 1,
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z",
};

const preservedCanvas: LegacyCanvasRow = {
  notebookId: "preserved-phase2",
  version: 1,
  savedAt: "2026-08-25T12:30:00.000Z",
  snapshot: {
    shapes: [{ id: "existing-shape", type: "note" }],
  },
};

let databaseSequence = 0;

function databaseName(prefix: string): string {
  databaseSequence += 1;
  return `phase2-indexeddb-${prefix}-${databaseSequence}`;
}

function openDatabase(name: string, version?: number): Promise<IDBDatabase> {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed."));
    request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
  });
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

async function seedVersion1(
  name: string,
  options: {
    readonly notebooks?: readonly LegacyNotebookRow[];
    readonly canvasSnapshots?: readonly LegacyCanvasRow[];
  } = {},
): Promise<void> {
  const request = indexedDB.open(name, DATABASE_VERSION_1);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      const created = request.result;
      if (!created.objectStoreNames.contains("notebooks")) {
        created.createObjectStore("notebooks", { keyPath: "id" });
      }
      if (!created.objectStoreNames.contains("canvasSnapshots")) {
        created.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Version-1 seed failed."));
  });

  const transaction = database.transaction(["notebooks", "canvasSnapshots"], "readwrite");
  const notebooks = options.notebooks ?? [preservedNotebook];
  const canvasSnapshots = options.canvasSnapshots ?? [preservedCanvas];
  for (const notebook of notebooks) {
    transaction.objectStore("notebooks").put(notebook);
  }
  for (const canvasSnapshot of canvasSnapshots) {
    transaction.objectStore("canvasSnapshots").put(canvasSnapshot);
  }
  await completeTransaction(transaction);
  database.close();
}

async function readStore(name: string, storeName: string): Promise<unknown[]> {
  const database = await openDatabase(name);
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).getAll();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed."));
  });
  await completeTransaction(transaction);
  database.close();
  return rows;
}

async function readStoreFromIndex(
  name: string,
  storeName: string,
  indexName: string,
): Promise<unknown[]> {
  const database = await openDatabase(name);
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).index(indexName).getAll();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB index read failed."));
  });
  await completeTransaction(transaction);
  database.close();
  return rows;
}

function hasRowId(value: unknown, id: string): boolean {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return false;
  }
  return value.id === id;
}

function createIds(options: {
  readonly notebooks?: readonly string[];
  readonly notes?: readonly string[];
  readonly receipts?: readonly string[];
} = {}) {
  let notebookIndex = 0;
  let noteIndex = 0;
  let receiptIndex = 0;
  const notebooks = options.notebooks ?? ["generated-notebook"];
  const notes = options.notes ?? ["note-1", "note-2", "note-3"];
  const receipts = options.receipts ?? ["receipt-1", "receipt-2", "receipt-3", "receipt-4", "receipt-5"];
  return {
    newNotebookId: (): NotebookId => createNotebookId(notebooks[notebookIndex++] ?? `generated-notebook-${notebookIndex}`),
    newNoteId: (): NoteId => createNoteId(notes[noteIndex++] ?? `note-${noteIndex}`),
    newReceiptId: (): ReceiptId => createReceiptId(receipts[receiptIndex++] ?? `receipt-${receiptIndex}`),
  };
}

function createRepository(
  name: string,
  options: {
    readonly ids?: ReturnType<typeof createIds>;
    readonly failureHook?: (point: string) => void;
  } = {},
): IndexedDbWorkspaceRepository {
  return new IndexedDbWorkspaceRepository({
    databaseName: name,
    clock: { now: () => timestamp },
    ids: options.ids ?? createIds(),
    failureHook: options.failureHook,
  });
}

async function close(repository: IndexedDbWorkspaceRepository): Promise<void> {
  await repository.close();
}

describe("IndexedDB Phase 2 workspace persistence", () => {
  it("upgrades a populated v1 database while preserving every legacy notebook and canvas row exactly", async () => {
    const name = databaseName("migration-preserves");
    await seedVersion1(name);
    const repository = createRepository(name);

    await repository.bootstrap();

    const notebooks = await readStore(name, "notebooks");
    expect(notebooks).toHaveLength(2);
    expect(notebooks).toEqual(
      expect.arrayContaining([
        preservedNotebook,
        expect.objectContaining({ id: INBOX_ID }),
      ]),
    );
    expect(await readStore(name, "canvasSnapshots")).toEqual([preservedCanvas]);
    const database = await openDatabase(name);
    expect(database.version).toBe(CURRENT_DATABASE_VERSION);
    database.close();
    await close(repository);
  });

  it("creates every additive store while preserving the Phase 2 and Phase 3 contracts", async () => {
    const name = databaseName("schema-contract");
    await seedVersion1(name);
    const repository = createRepository(name);
    await repository.bootstrap();

    const database = await openDatabase(name);
    expect(Array.from(database.objectStoreNames)).toEqual([
      "canvasSnapshots",
      "notebookLifecycle",
      "notebooks",
      "notes",
      "pageDocuments",
      "pageMigrations",
      "pageReceipts",
      "pageScraps",
      "pageWriterClaims",
      "pages",
      "projectItemReceipts",
      "projectItems",
      "projects",
      "receipts",
      "workbookIdentities",
      "workspaceMetadata",
    ]);

    const notes = database.transaction("notes", "readonly").objectStore("notes");
    expect(notes.keyPath).toBe("id");
    expect(Array.from(notes.indexNames)).toEqual(["byNotebookLifecycleCreatedAtId"]);
    expect(notes.index("byNotebookLifecycleCreatedAtId").keyPath).toEqual([
      "targetNotebookId",
      "lifecycle",
      "createdAt",
      "id",
    ]);

    const receipts = database.transaction("receipts", "readonly").objectStore("receipts");
    expect(receipts.keyPath).toBe("id");
    expect(Array.from(receipts.indexNames)).toEqual(["byCompletedAt", "byUndoOf"]);
    expect(receipts.index("byCompletedAt").keyPath).toBe("completedAt");
    expect(receipts.index("byUndoOf").keyPath).toBe("undoOf");
    expect(receipts.index("byUndoOf").unique).toBe(true);
    expect(receipts.index("byUndoOf").multiEntry).toBe(false);

    const lifecycle = database.transaction("notebookLifecycle", "readonly").objectStore("notebookLifecycle");
    expect(lifecycle.keyPath).toBe("notebookId");
    expect(Array.from(lifecycle.indexNames)).toEqual([]);

    const metadata = database.transaction("workspaceMetadata", "readonly").objectStore("workspaceMetadata");
    expect(metadata.keyPath).toBe("id");
    expect(Array.from(metadata.indexNames)).toEqual([]);
    database.close();
    await close(repository);
  });

  it("bootstraps one fixed-ID Inbox and one workspace metadata row, then remains idempotent", async () => {
    const name = databaseName("bootstrap-idempotent");
    await seedVersion1(name);
    const first = createRepository(name, {
      ids: createIds({ notebooks: ["this-must-not-be-used-for-inbox"] }),
    });

    const initial = await first.bootstrap();
    expect(initial.metadata).toMatchObject({
      id: "workspace",
      inboxNotebookId: INBOX_ID,
      currentTargetNotebookId: INBOX_ID,
    });
    await close(first);

    const second = createRepository(name, {
      ids: {
        newNotebookId: (): NotebookId => {
          throw new Error("repeated bootstrap must not generate another Inbox");
        },
        newNoteId: () => createNoteId("unused-note"),
        newReceiptId: () => createReceiptId("unused-receipt"),
      },
    });
    const repeated = await second.bootstrap();
    expect(repeated.metadata).toEqual(initial.metadata);
    expect((await readStore(name, "notebooks")).filter((row) => hasRowId(row, INBOX_ID))).toHaveLength(1);
    expect(await readStore(name, "workspaceMetadata")).toEqual([initial.metadata]);
    await close(second);
  });

  it("isolates a malformed legacy notebook row without rewriting or hiding valid rows", async () => {
    const name = databaseName("malformed-legacy");
    const malformed = {
      id: "malformed-legacy",
      title: "Bad legacy row",
      subject: "Preserve me",
      revision: 0,
      createdAt: "not-an-instant",
      updatedAt: "not-an-instant",
    };
    await seedVersion1(name, { notebooks: [preservedNotebook, malformed] });
    const repository = createRepository(name);

    const loaded = await repository.bootstrap();

    expect(loaded.notebooks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: preservedNotebook.id })]),
    );
    expect(loaded.notebooks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: malformed.id })]),
    );
    expect(loaded.issues).toEqual([
      expect.objectContaining({ kind: "malformed_notebook", id: malformed.id }),
    ]);
    const notebooks = await readStore(name, "notebooks");
    expect(notebooks).toHaveLength(3);
    expect(notebooks).toEqual(
      expect.arrayContaining([
        preservedNotebook,
        malformed,
        expect.objectContaining({ id: INBOX_ID }),
      ]),
    );
    await close(repository);
  });

  it("rejects an injected upgrade failure without accepting a partial v2 schema or false success", async () => {
    const name = databaseName("upgrade-failure");
    await seedVersion1(name);
    const failing = createRepository(name, {
      failureHook: (point) => {
        if (point.startsWith("upgrade")) {
          throw new Error(`injected ${point}`);
        }
      },
    });

    await expect(failing.bootstrap()).rejects.toThrow(/injected upgrade/);
    await close(failing);
    const reopened = await openDatabase(name);
    expect(reopened.version).toBe(DATABASE_VERSION_1);
    expect(Array.from(reopened.objectStoreNames)).toEqual(["canvasSnapshots", "notebooks"]);
    reopened.close();
  });

  it("captures a note and a body-free receipt atomically", async () => {
    const name = databaseName("capture");
    await seedVersion1(name);
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-capture"], receipts: ["receipt-capture"] }),
    });
    await repository.bootstrap();

    await expect(
      repository.execute({
        kind: "capture_note",
        target: { kind: "notebook", notebookId: inboxNotebookId },
        content: { format: "plain_text", text: "Call Casey Friday" },
        initiatedBy: "person",
      }),
    ).resolves.toMatchObject({ ok: true });

    const notes = await readStore(name, "notes");
    const receipts = await readStore(name, "receipts");
    expect(notes).toEqual([
      expect.objectContaining({
        id: "note-capture",
        targetNotebookId: INBOX_ID,
        lifecycle: "active",
        contentVersion: 1,
        content: { format: "plain_text", text: "Call Casey Friday" },
      }),
    ]);
    expect(receipts).toEqual([expect.objectContaining({ id: "receipt-capture", noteId: "note-capture" })]);
    const receiptText = JSON.stringify(receipts[0]);
    expect(receiptText).not.toContain("Call Casey Friday");
    for (const forbiddenField of ["content", "text", "title", "subject", "prompt", "transcript", "canvas"]) {
      expect(receipts[0]).not.toHaveProperty(forbiddenField);
    }
    await close(repository);
  });

  it("rolls back note and receipt when failure is injected after the note write and before the receipt", async () => {
    const name = databaseName("capture-after-note-failure");
    await seedVersion1(name);
    let fail = true;
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-aborted"], receipts: ["receipt-aborted"] }),
      failureHook: (point) => {
        if (fail && point === "capture.after-note") {
          throw new Error("injected failure after note");
        }
      },
    });
    await repository.bootstrap();

    await expect(
      repository.execute({
        kind: "capture_note",
        target: { kind: "notebook", notebookId: inboxNotebookId },
        content: { format: "plain_text", text: "Should roll back" },
        initiatedBy: "person",
      }),
    ).rejects.toThrow("injected failure after note");
    expect(await readStore(name, "notes")).toEqual([]);
    expect(await readStore(name, "receipts")).toEqual([]);
    fail = false;
    await close(repository);
  });

  it("rolls back the note when the receipt-side write fails", async () => {
    const name = databaseName("capture-receipt-failure");
    await seedVersion1(name);
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-receipt-aborted"], receipts: ["receipt-receipt-aborted"] }),
      failureHook: (point) => {
        if (point === "capture.receipt-write") {
          throw new Error("injected receipt write failure");
        }
      },
    });
    await repository.bootstrap();

    await expect(
      repository.execute({
        kind: "capture_note",
        target: { kind: "notebook", notebookId: inboxNotebookId },
        content: { format: "plain_text", text: "Receipt must be atomic" },
        initiatedBy: "person",
      }),
    ).rejects.toThrow("injected receipt write failure");
    expect(await readStore(name, "notes")).toEqual([]);
    expect(await readStore(name, "receipts")).toEqual([]);
    await close(repository);
  });

  it("orders notes with the same timestamp by stable note ID", async () => {
    const name = databaseName("stable-order");
    await seedVersion1(name);
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-b", "note-a"], receipts: ["receipt-b", "receipt-a"] }),
    });
    await repository.bootstrap();
    for (const text of ["second", "first"]) {
      await repository.execute({
        kind: "capture_note",
        target: { kind: "notebook", notebookId: inboxNotebookId },
        content: { format: "plain_text", text },
        initiatedBy: "person",
      });
    }

    const ordered = await readStoreFromIndex(name, "notes", "byNotebookLifecycleCreatedAtId");
    expect(ordered).toEqual([
      expect.objectContaining({ id: "note-a" }),
      expect.objectContaining({ id: "note-b" }),
    ]);
    await close(repository);
  });

  it("keeps Move atomic when its receipt write fails", async () => {
    const name = databaseName("move-atomic");
    await seedVersion1(name, {
      notebooks: [
        preservedNotebook,
        {
          ...preservedNotebook,
          id: "destination",
          title: "Destination",
          subject: "Move target",
        },
      ],
    });
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-move"], receipts: ["receipt-capture", "receipt-move"] }),
    });
    await repository.bootstrap();
    await repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: inboxNotebookId },
      content: { format: "plain_text", text: "Move atomically" },
      initiatedBy: "person",
    });
    const before = await readStore(name, "notes");
    let fail = true;
    const failingRepository = createRepository(name, {
      ids: createIds({ receipts: ["unused-receipt"] }),
      failureHook: (point) => {
        if (fail && point === "move.receipt-write") {
          throw new Error("injected move receipt failure");
        }
      },
    });

    await expect(
      failingRepository.execute({
        kind: "move_note",
        noteId: noteMoveId,
        to: { kind: "notebook", notebookId: destinationNotebookId },
        expectedRevision: createRevision(1),
        initiatedBy: "person",
      }),
    ).rejects.toThrow("injected move receipt failure");
    expect(await readStore(name, "notes")).toEqual(before);
    expect(await readStore(name, "receipts")).toHaveLength(1);
    fail = false;
    await close(failingRepository);
    await close(repository);
  });

  it("rejects a stale Move revision without changing the note or adding a receipt", async () => {
    const name = databaseName("move-stale-revision");
    await seedVersion1(name, {
      notebooks: [
        preservedNotebook,
        {
          ...preservedNotebook,
          id: "destination",
          title: "Destination",
          subject: "Move target",
        },
      ],
    });
    const repository = createRepository(name, {
      ids: createIds({
        notes: ["note-move"],
        receipts: ["receipt-capture", "receipt-move"],
      }),
    });
    await repository.bootstrap();
    await repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: inboxNotebookId },
      content: { format: "plain_text", text: "Keep this put" },
      initiatedBy: "person",
    });
    const beforeNotes = await readStore(name, "notes");
    const beforeReceipts = await readStore(name, "receipts");

    const result = await repository.execute({
      kind: "move_note",
      noteId: noteMoveId,
      to: { kind: "notebook", notebookId: destinationNotebookId },
      expectedRevision: createRevision(2),
      initiatedBy: "person",
    });

    expect(result).toEqual({ ok: false, code: "conflict" });
    expect(await readStore(name, "notes")).toEqual(beforeNotes);
    expect(await readStore(name, "receipts")).toEqual(beforeReceipts);
    await close(repository);
  });

  it("rejects stale Undo and leaves state unchanged, then reports repeated Undo without another write", async () => {
    const name = databaseName("undo");
    await seedVersion1(name, {
      notebooks: [
        preservedNotebook,
        { ...preservedNotebook, id: "destination", title: "Destination", subject: "Move target" },
      ],
    });
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-undo"], receipts: ["receipt-capture", "receipt-move", "receipt-undo"] }),
    });
    await repository.bootstrap();
    await repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: inboxNotebookId },
      content: { format: "plain_text", text: "Undo me" },
      initiatedBy: "person",
    });
    await repository.execute({
      kind: "move_note",
      noteId: noteUndoId,
      to: { kind: "notebook", notebookId: destinationNotebookId },
      expectedRevision: createRevision(1),
      initiatedBy: "person",
    });
    const staleBefore = await readStore(name, "notes");
    const staleResult = await repository.execute({
      kind: "undo",
      receiptId: captureReceiptId,
      initiatedBy: "person",
    });
    expect(staleResult).toMatchObject({ ok: false, code: "stale_undo" });
    expect(await readStore(name, "notes")).toEqual(staleBefore);
    expect(await readStore(name, "receipts")).toHaveLength(2);

    const cleanName = databaseName("undo-repeat");
    await seedVersion1(cleanName);
    const clean = createRepository(cleanName, {
      ids: createIds({ notes: ["note-repeat"], receipts: ["receipt-capture", "receipt-undo"] }),
    });
    await clean.bootstrap();
    await clean.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: inboxNotebookId },
      content: { format: "plain_text", text: "Undo once" },
      initiatedBy: "person",
    });
    await expect(clean.execute({ kind: "undo", receiptId: captureReceiptId, initiatedBy: "person" })).resolves.toMatchObject({ ok: true });
    const afterFirstUndo = await readStore(cleanName, "receipts");
    const repeated = await clean.execute({ kind: "undo", receiptId: captureReceiptId, initiatedBy: "person" });
    expect(repeated).toMatchObject({ ok: false, code: "already_undone" });
    expect(await readStore(cleanName, "receipts")).toEqual(afterFirstUndo);
    await close(repository);
    await close(clean);
  });

  it("rejects a malformed durable receipt without applying an inverse or writing an undo receipt", async () => {
    const name = databaseName("undo-malformed-receipt");
    await seedVersion1(name);
    const repository = createRepository(name, {
      ids: createIds({
        notes: ["note-malformed-receipt"],
        receipts: ["receipt-capture", "receipt-undo"],
      }),
    });
    await repository.bootstrap();
    await repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: inboxNotebookId },
      content: { format: "plain_text", text: "Do not mutate me" },
      initiatedBy: "person",
    });
    const database = await openDatabase(name);
    const transaction = database.transaction("receipts", "readwrite");
    transaction.objectStore("receipts").put({
      id: "receipt-forged",
      kind: "capture_note",
      source: "person",
      completedAt: timestamp,
      noteId: "note-malformed-receipt",
      targetNotebookId: INBOX_ID,
      resultingRevision: 1,
      undo: { kind: "available" },
    });
    await completeTransaction(transaction);
    database.close();
    const notesBefore = await readStore(name, "notes");
    const receiptsBefore = await readStore(name, "receipts");

    const result = await repository.execute({
      kind: "undo",
      receiptId: createReceiptId("receipt-forged"),
      initiatedBy: "person",
    });

    expect(result).toEqual({ ok: false, code: "stale_undo" });
    expect(await readStore(name, "notes")).toEqual(notesBefore);
    expect(await readStore(name, "receipts")).toEqual(receiptsBefore);
    await close(repository);
  });

  it("trashes and restores a note without deleting its row", async () => {
    const name = databaseName("note-lifecycle");
    await seedVersion1(name);
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-lifecycle"], receipts: ["receipt-capture", "receipt-trash", "receipt-restore"] }),
    });
    await repository.bootstrap();
    await repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: inboxNotebookId },
      content: { format: "plain_text", text: "Lifecycle" },
      initiatedBy: "person",
    });
    await repository.execute({ kind: "trash_note", noteId: noteLifecycleId, expectedRevision: createRevision(1), initiatedBy: "person" });
    expect(await readStore(name, "notes")).toEqual([expect.objectContaining({ id: "note-lifecycle", lifecycle: "trashed" })]);
    await repository.execute({ kind: "restore_note", noteId: noteLifecycleId, expectedRevision: createRevision(2), initiatedBy: "person" });
    expect(await readStore(name, "notes")).toEqual([expect.objectContaining({ id: "note-lifecycle", lifecycle: "active" })]);
    await close(repository);
  });

  it("trashes and restores notebook lifecycle metadata without changing notebook, note, or canvas raw rows", async () => {
    const name = databaseName("notebook-lifecycle");
    const notebook: LegacyNotebookRow = {
      ...preservedNotebook,
      id: "work-notebook",
      title: "Work",
      subject: "Lifecycle target",
    };
    const canvas: LegacyCanvasRow = {
      ...preservedCanvas,
      notebookId: notebook.id,
      snapshot: { shapes: [{ id: "work-shape", type: "ellipse" }] },
    };
    await seedVersion1(name, { notebooks: [notebook], canvasSnapshots: [canvas] });
    const repository = createRepository(name, {
      ids: createIds({ notes: ["note-work"], receipts: ["receipt-capture", "receipt-trash", "receipt-restore"] }),
    });
    await repository.bootstrap();
    await repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: workNotebookId },
      content: { format: "plain_text", text: "Notebook lifecycle" },
      initiatedBy: "person",
    });
    const notebooksBefore = await readStore(name, "notebooks");
    const notesBefore = await readStore(name, "notes");
    const canvasBefore = await readStore(name, "canvasSnapshots");

    await repository.execute({ kind: "trash_notebook", notebookId: workNotebookId, expectedRevision: createRevision(1), initiatedBy: "person" });
    expect(await readStore(name, "notebookLifecycle")).toEqual([
      expect.objectContaining({ notebookId: notebook.id, lifecycle: "trashed" }),
    ]);
    expect(await readStore(name, "notebooks")).toEqual(notebooksBefore);
    expect(await readStore(name, "notes")).toEqual(notesBefore);
    expect(await readStore(name, "canvasSnapshots")).toEqual(canvasBefore);

    await repository.execute({ kind: "restore_notebook", notebookId: workNotebookId, expectedRevision: createRevision(2), initiatedBy: "person" });
    expect(await readStore(name, "notebookLifecycle")).toEqual([
      expect.objectContaining({ notebookId: notebook.id, lifecycle: "active" }),
    ]);
    expect(await readStore(name, "notebooks")).toEqual(notebooksBefore);
    expect(await readStore(name, "notes")).toEqual(notesBefore);
    expect(await readStore(name, "canvasSnapshots")).toEqual(canvasBefore);
    await close(repository);
  });

  it("restores the prior current target when notebook Trash is undone and rejects a stale metadata inverse", async () => {
    const name = databaseName("notebook-undo-metadata");
    await seedVersion1(name, {
      notebooks: [
        { ...preservedNotebook, id: "work-notebook", title: "Work" },
        preservedNotebook,
      ],
    });
    const repository = createRepository(name, {
      ids: createIds({
        receipts: [
          "receipt-trash",
          "receipt-undo",
          "receipt-trash-again",
          "receipt-stale-undo",
        ],
      }),
    });
    await repository.bootstrap();
    await repository.setCurrentTarget(workNotebookId);

    const trashed = await repository.execute({
      kind: "trash_notebook",
      notebookId: workNotebookId,
      expectedRevision: createRevision(1),
      initiatedBy: "person",
    });
    expect(trashed).toMatchObject({ ok: true });
    expect((await repository.bootstrap()).metadata.currentTargetNotebookId).toBe(
      inboxNotebookId,
    );

    const undone = await repository.execute({
      kind: "undo",
      receiptId: createReceiptId("receipt-trash"),
      initiatedBy: "person",
    });
    expect(undone).toMatchObject({ ok: true });
    expect((await repository.bootstrap()).metadata.currentTargetNotebookId).toBe(
      workNotebookId,
    );

    await repository.execute({
      kind: "trash_notebook",
      notebookId: workNotebookId,
      expectedRevision: createRevision(3),
      initiatedBy: "person",
    });
    await repository.setCurrentTarget(createNotebookId(preservedNotebook.id));
    const beforeLifecycle = await readStore(name, "notebookLifecycle");
    const stale = await repository.execute({
      kind: "undo",
      receiptId: createReceiptId("receipt-trash-again"),
      initiatedBy: "person",
    });
    expect(stale).toEqual({ ok: false, code: "stale_undo" });
    expect(await readStore(name, "notebookLifecycle")).toEqual(beforeLifecycle);
    await close(repository);
  });
});
