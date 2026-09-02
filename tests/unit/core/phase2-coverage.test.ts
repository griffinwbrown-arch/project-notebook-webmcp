import { describe, expect, it, vi } from "vitest";

import {
  createIsoInstant,
  createNoteEntry,
  createNoteId,
  createNotebookId,
  createReceiptId,
  createRevision,
  generateNoteId,
  generateReceiptId,
  moveNote,
  parseReceipt,
  restoreNote,
  sortNoteEntries,
  trashNote,
  type NotebookId,
} from "../../../src/domain";
import { openPhase2Database } from "../../../src/indexeddb/database";
import {
  INBOX_NOTEBOOK_ID,
  IndexedDbWorkspaceRepository,
} from "../../../src/indexeddb/workspace-repository";

const timestamp = "2026-08-26T12:00:00.000Z";
const laterTimestamp = "2026-08-26T12:01:00.000Z";
const inboxId = INBOX_NOTEBOOK_ID;
const destinationId = createNotebookId("destination");
const noteId = createNoteId("coverage-note");
const revisionOne = createRevision(1);

let databaseSequence = 0;

function databaseName(prefix: string): string {
  databaseSequence += 1;
  return `phase2-coverage-${prefix}-${databaseSequence}`;
}

function sequence(values: readonly string[], fallback: string): () => string {
  let index = 0;
  return () => values[index++] ?? `${fallback}-${index}`;
}

function createRepository(
  name: string,
  options: {
    readonly notes?: readonly string[];
    readonly receipts?: readonly string[];
    readonly failureHook?: (point: string) => void;
  } = {},
): IndexedDbWorkspaceRepository {
  return new IndexedDbWorkspaceRepository({
    databaseName: name,
    clock: { now: () => timestamp },
    ids: {
      newNotebookId: sequence(["generated-notebook"], "generated-notebook"),
      newNoteId: sequence(options.notes ?? ["coverage-note"], "coverage-note"),
      newReceiptId: sequence(options.receipts ?? ["coverage-receipt"], "coverage-receipt"),
    },
    failureHook: options.failureHook,
  });
}

type LegacyNotebookRow = {
  readonly id: string;
  readonly title: string;
  readonly subject: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

const legacyNotebook: LegacyNotebookRow = {
  id: "legacy-notebook",
  title: "Legacy notebook",
  subject: "Coverage fixture",
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Transaction aborted."));
  });
}

async function seedLegacy(
  name: string,
  options: {
    readonly notebooks?: readonly LegacyNotebookRow[];
    readonly includeCanvas?: boolean;
  } = {},
): Promise<void> {
  const request = indexedDB.open(name, 1);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onupgradeneeded = () => {
      const created = request.result;
      created.createObjectStore("notebooks", { keyPath: "id" });
      if (options.includeCanvas !== false) {
        created.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Seed open failed."));
  });
  const transaction = database.transaction("notebooks", "readwrite");
  for (const notebook of options.notebooks ?? [legacyNotebook]) {
    transaction.objectStore("notebooks").put(notebook);
  }
  await completeTransaction(transaction);
  database.close();
}

async function openRaw(name: string, version?: number): Promise<IDBDatabase> {
  const request = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Open failed."));
    request.onblocked = () => reject(new Error("Open blocked."));
  });
}

async function readStore(name: string, store: string): Promise<unknown[]> {
  const database = await openRaw(name);
  const transaction = database.transaction(store, "readonly");
  const request = transaction.objectStore(store).getAll();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Read failed."));
  });
  await completeTransaction(transaction);
  database.close();
  return rows;
}

async function deleteStoreRow(name: string, store: string, key: string): Promise<void> {
  const database = await openRaw(name);
  const transaction = database.transaction(store, "readwrite");
  transaction.objectStore(store).delete(key);
  await completeTransaction(transaction);
  database.close();
}

async function updateStoreRow(
  name: string,
  store: string,
  key: string,
  update: (row: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const database = await openRaw(name);
  const transaction = database.transaction(store, "readwrite");
  const objectStore = transaction.objectStore(store);
  const current = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const request = objectStore.get(key);
    request.onsuccess = () => {
      if (typeof request.result !== "object" || request.result === null) {
        reject(new Error("Fixture row is unavailable."));
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error("Fixture read failed."));
  });
  objectStore.put(update(current));
  await completeTransaction(transaction);
  database.close();
}

async function putStoreRow(
  name: string,
  store: string,
  row: Record<string, unknown>,
): Promise<void> {
  const database = await openRaw(name);
  const transaction = database.transaction(store, "readwrite");
  transaction.objectStore(store).put(row);
  await completeTransaction(transaction);
  database.close();
}

async function capture(
  repository: IndexedDbWorkspaceRepository,
  ids: { readonly note: string; readonly receipt: string },
  target: NotebookId = inboxId,
): Promise<void> {
  await expect(
    repository.execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: target },
      content: { format: "plain_text", text: `text-${ids.note}` },
      initiatedBy: "person",
    }),
  ).resolves.toMatchObject({ ok: true, receipt: { id: ids.receipt } });
}

describe("Phase 2 branch coverage", () => {
  it("covers domain lifecycle guards, fallback ids, unequal ordering, and consumed receipts", () => {
    const active = createNoteEntry({
      id: noteId,
      targetNotebookId: inboxId,
      content: { format: "plain_text", text: "coverage" },
      createdAt: createIsoInstant(timestamp),
    });
    const trashed = trashNote(active, createIsoInstant(laterTimestamp));

    expect(() => moveNote(trashed, destinationId, createIsoInstant(laterTimestamp))).toThrow(
      "cannot be moved",
    );
    expect(() => trashNote(trashed, createIsoInstant(laterTimestamp))).toThrow(
      "already in Trash",
    );
    expect(() => restoreNote(active, createIsoInstant(laterTimestamp))).toThrow(
      "not in Trash",
    );
    const laterNote = createNoteEntry({
      id: createNoteId("coverage-later"),
      targetNotebookId: inboxId,
      content: { format: "plain_text", text: "later" },
      createdAt: createIsoInstant(laterTimestamp),
    });
    expect(sortNoteEntries([laterNote, active])).toEqual([active, laterNote]);

    const consumed = parseReceipt({
      id: "consumed-receipt",
      kind: "capture_note",
      source: "person",
      completedAt: timestamp,
      noteId: noteId,
      targetNotebookId: inboxId,
      resultingRevision: 1,
      undo: { kind: "consumed", by: "undo-receipt" },
    });
    expect(consumed.undo).toEqual({ kind: "consumed", by: createReceiptId("undo-receipt") });

    vi.stubGlobal("crypto", {});
    try {
      expect(generateNoteId()).toMatch(/^note-/);
      expect(generateReceiptId()).toMatch(/^receipt-/);
      const fallbackNote = createNoteEntry({
        id: createNoteId("fallback-note"),
        targetNotebookId: inboxId,
        content: { format: "plain_text", text: "fallback" },
        createdAt: createIsoInstant(timestamp),
      });
      expect(fallbackNote.id).toBe("fallback-note");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a missing legacy store and a blocked upgrade without accepting v2", async () => {
    const missingStoreName = databaseName("missing-legacy-store");
    await seedLegacy(missingStoreName, { includeCanvas: false });
    await expect(openPhase2Database(missingStoreName)).rejects.toThrow(
      "missing a required legacy store",
    );
    const stillV1 = await openRaw(missingStoreName);
    expect(stillV1.version).toBe(1);
    expect(Array.from(stillV1.objectStoreNames)).toEqual(["notebooks"]);
    stillV1.close();

    const blockedName = databaseName("blocked");
    await seedLegacy(blockedName);
    const heldOpen = await openRaw(blockedName);
    const blockedOpen = openPhase2Database(blockedName);
    await expect(blockedOpen).rejects.toThrow("upgrade is blocked");
    heldOpen.close();
    await blockedOpen.catch(() => undefined);
  });

  it("covers raw notebook repositories through missing and conflict branches", async () => {
    const name = databaseName("legacy-repositories");
    await seedLegacy(name);
    const repository = createRepository(name);
    await repository.bootstrap();

    expect(await repository.getNotebook(createNotebookId("missing"))).toBeNull();
    await expect(
      repository.updateNotebook(
        {
          id: createNotebookId("missing"),
          title: "Missing",
          subject: "Missing",
          revision: createRevision(2),
          createdAt: createIsoInstant(timestamp),
          updatedAt: createIsoInstant(timestamp),
        },
        revisionOne,
      ),
    ).rejects.toThrow("Notebook not found");
    const legacy = await repository.getNotebook(createNotebookId(legacyNotebook.id));
    if (legacy === null) throw new Error("Expected legacy notebook.");
    await expect(
      repository.updateNotebook({ ...legacy, revision: createRevision(3) }, revisionOne),
    ).rejects.toThrow("revision conflict");
    await expect(repository.createNotebook(legacy)).rejects.toThrow();

    await repository.close();
  });

  it("repairs missing and trashed durable targets once, then bootstraps idempotently", async () => {
    const name = databaseName("durable-target-repair");
    await seedLegacy(name, {
      notebooks: [legacyNotebook, { ...legacyNotebook, id: destinationId }],
    });
    const repository = createRepository(name);
    await repository.bootstrap();

    await updateStoreRow(name, "workspaceMetadata", "workspace", (row) => ({
      ...row,
      currentTargetNotebookId: "missing-notebook",
      revision: 7,
    }));
    const missingRepair = await repository.bootstrap();
    expect(missingRepair.metadata).toMatchObject({
      currentTargetNotebookId: inboxId,
      revision: 8,
    });
    expect((await repository.bootstrap()).metadata).toMatchObject({
      currentTargetNotebookId: inboxId,
      revision: 8,
    });

    await putStoreRow(name, "notebookLifecycle", {
      notebookId: destinationId,
      lifecycle: "trashed",
      revision: 2,
      updatedAt: timestamp,
    });
    await updateStoreRow(name, "workspaceMetadata", "workspace", (row) => ({
      ...row,
      currentTargetNotebookId: destinationId,
      revision: 9,
    }));
    const trashedRepair = await repository.bootstrap();
    expect(trashedRepair.metadata).toMatchObject({
      currentTargetNotebookId: inboxId,
      revision: 10,
    });
    expect((await repository.bootstrap()).metadata).toMatchObject({
      currentTargetNotebookId: inboxId,
      revision: 10,
    });
    await repository.close();
  });

  it("covers target validation, same-target metadata, list defaults, and lifecycle conflict paths", async () => {
    const name = databaseName("target-lifecycle");
    await seedLegacy(name, {
      notebooks: [legacyNotebook, { ...legacyNotebook, id: destinationId }],
    });
    const repository = createRepository(name, {
      notes: ["target-note"],
      receipts: ["target-capture", "target-trash", "target-restore"],
    });
    await repository.bootstrap();
    await expect(repository.setCurrentTarget(inboxId)).resolves.toMatchObject({
      currentTargetNotebookId: inboxId,
    });
    expect(await repository.listNotes(inboxId)).toEqual([]);
    expect(await repository.listNotes(inboxId, "trashed")).toEqual([]);

    await expect(
      repository.execute({
        kind: "capture_note",
        target: { kind: "notebook", notebookId: createNotebookId("missing") },
        content: { format: "plain_text", text: "missing target" },
        initiatedBy: "person",
      }),
    ).rejects.toThrow("Notebook not found");
    await expect(
      repository.execute({
        kind: "trash_notebook",
        notebookId: inboxId,
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "invalid_target" });
    await expect(
      repository.execute({
        kind: "trash_notebook",
        notebookId: createNotebookId("missing"),
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "not_found" });

    await repository.execute({
      kind: "trash_notebook",
      notebookId: destinationId,
      expectedRevision: revisionOne,
      initiatedBy: "person",
    });
    await expect(
      repository.execute({
        kind: "trash_notebook",
        notebookId: destinationId,
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "conflict" });
    await expect(
      repository.execute({
        kind: "restore_notebook",
        notebookId: destinationId,
        expectedRevision: createRevision(2),
        initiatedBy: "person",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      repository.execute({
        kind: "restore_notebook",
        notebookId: destinationId,
        expectedRevision: createRevision(2),
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "conflict" });
    await repository.close();
  });

  it("covers Move not-found and stale revision results while preserving the note", async () => {
    const name = databaseName("move-conflicts");
    await seedLegacy(name, {
      notebooks: [legacyNotebook, { ...legacyNotebook, id: destinationId }],
    });
    const repository = createRepository(name, {
      notes: ["move-conflict-note"],
      receipts: ["move-capture", "move-unused"],
    });
    await repository.bootstrap();
    await capture(repository, { note: "move-conflict-note", receipt: "move-capture" });
    await expect(
      repository.execute({
        kind: "move_note",
        noteId: createNoteId("missing-note"),
        to: { kind: "notebook", notebookId: destinationId },
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "not_found" });
    await expect(
      repository.execute({
        kind: "move_note",
        noteId: createNoteId("move-conflict-note"),
        to: { kind: "notebook", notebookId: destinationId },
        expectedRevision: createRevision(2),
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "conflict" });
    expect(await repository.listNotes(inboxId)).toHaveLength(1);
    await repository.close();
  });

  it("covers note lifecycle not-found, conflict, invalid-state, and receipt rollback paths", async () => {
    const name = databaseName("note-conflicts");
    await seedLegacy(name);
    const repository = createRepository(name, {
      notes: ["lifecycle-note"],
      receipts: ["lifecycle-not-found", "lifecycle-capture", "lifecycle-trash", "lifecycle-restore"],
    });
    await repository.bootstrap();
    await expect(
      repository.execute({
        kind: "trash_note",
        noteId: createNoteId("missing-note"),
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "not_found" });
    await capture(repository, { note: "lifecycle-note", receipt: "lifecycle-capture" });
    await expect(
      repository.execute({
        kind: "trash_note",
        noteId: createNoteId("lifecycle-note"),
        expectedRevision: createRevision(2),
        initiatedBy: "person",
      }),
    ).resolves.toEqual({ ok: false, code: "conflict" });
    await repository.execute({
      kind: "trash_note",
      noteId: createNoteId("lifecycle-note"),
      expectedRevision: revisionOne,
      initiatedBy: "person",
    });
    await expect(
      repository.execute({
        kind: "trash_note",
        noteId: createNoteId("lifecycle-note"),
        expectedRevision: createRevision(2),
        initiatedBy: "person",
      }),
    ).rejects.toThrow("already in Trash");
    await repository.execute({
      kind: "restore_note",
      noteId: createNoteId("lifecycle-note"),
      expectedRevision: createRevision(2),
      initiatedBy: "person",
    });
    await expect(
      repository.execute({
        kind: "restore_note",
        noteId: createNoteId("lifecycle-note"),
        expectedRevision: createRevision(3),
        initiatedBy: "person",
      }),
    ).rejects.toThrow("not in Trash");

    const failureName = databaseName("note-receipt-failure");
    await seedLegacy(failureName);
    const failing = createRepository(failureName, {
      notes: ["failure-note"],
      receipts: ["failure-capture"],
      failureHook: (point) => {
        if (point === "trash_note.receipt-write") throw new Error("injected lifecycle failure");
      },
    });
    await failing.bootstrap();
    await capture(failing, { note: "failure-note", receipt: "failure-capture" });
    await expect(
      failing.execute({
        kind: "trash_note",
        noteId: createNoteId("failure-note"),
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).rejects.toThrow("injected lifecycle failure");
    expect(await readStore(failureName, "notes")).toEqual([
      expect.objectContaining({ id: "failure-note", lifecycle: "active", revision: 1 }),
    ]);
    await repository.close();
    await failing.close();
  });

  it("covers successful Undo for Move, note lifecycle, and notebook lifecycle operations", async () => {
    const name = databaseName("undo-kinds");
    await seedLegacy(name, {
      notebooks: [legacyNotebook, { ...legacyNotebook, id: destinationId }],
    });
    const repository = createRepository(name, {
      notes: ["move-undo-note", "trash-undo-note", "restore-undo-note"],
      receipts: [
        "move-capture",
        "move-receipt",
        "move-undo",
        "trash-capture",
        "trash-receipt",
        "trash-undo",
        "restore-capture",
        "restore-trash",
        "restore-receipt",
        "restore-undo",
        "notebook-trash",
        "notebook-undo",
        "notebook-restore",
        "notebook-restore-undo",
        "notebook-restore-undo-actual",
      ],
    });
    await repository.bootstrap();

    await capture(repository, { note: "move-undo-note", receipt: "move-capture" });
    await expect(
      repository.execute({
        kind: "move_note",
        noteId: createNoteId("move-undo-note"),
        to: { kind: "notebook", notebookId: destinationId },
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "move-receipt" } });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("move-receipt"), initiatedBy: "person" }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "move-undo" } });

    await capture(repository, { note: "trash-undo-note", receipt: "trash-capture" });
    await repository.execute({
      kind: "trash_note",
      noteId: createNoteId("trash-undo-note"),
      expectedRevision: revisionOne,
      initiatedBy: "person",
    });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("trash-receipt"), initiatedBy: "person" }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "trash-undo" } });

    await capture(repository, { note: "restore-undo-note", receipt: "restore-capture" });
    await repository.execute({
      kind: "trash_note",
      noteId: createNoteId("restore-undo-note"),
      expectedRevision: revisionOne,
      initiatedBy: "person",
    });
    await repository.execute({
      kind: "restore_note",
      noteId: createNoteId("restore-undo-note"),
      expectedRevision: createRevision(2),
      initiatedBy: "person",
    });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("restore-receipt"), initiatedBy: "person" }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "restore-undo" } });

    await expect(
      repository.execute({
        kind: "trash_notebook",
        notebookId: destinationId,
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "notebook-trash" } });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("notebook-trash"), initiatedBy: "person" }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "notebook-undo" } });

    await repository.execute({
      kind: "trash_notebook",
      notebookId: destinationId,
      expectedRevision: createRevision(3),
      initiatedBy: "person",
    });
    await repository.execute({
      kind: "restore_notebook",
      notebookId: destinationId,
      expectedRevision: createRevision(4),
      initiatedBy: "person",
    });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("notebook-restore-undo"), initiatedBy: "person" }),
    ).resolves.toMatchObject({ ok: true, receipt: { id: "notebook-restore-undo-actual" } });
    await repository.close();
  });

  it("rejects missing, consumed, unavailable, duplicate, and stale Undo paths", async () => {
    const name = databaseName("undo-invalid");
    await seedLegacy(name);
    const repository = createRepository(name, {
      notes: ["invalid-undo-note"],
      receipts: ["invalid-undo-missing", "invalid-capture", "invalid-undo"],
    });
    await repository.bootstrap();
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("missing-receipt"), initiatedBy: "person" }),
    ).resolves.toEqual({ ok: false, code: "not_found" });
    await capture(repository, { note: "invalid-undo-note", receipt: "invalid-capture" });
    await repository.execute({ kind: "undo", receiptId: createReceiptId("invalid-capture"), initiatedBy: "person" });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("invalid-capture"), initiatedBy: "person" }),
    ).resolves.toEqual({ ok: false, code: "already_undone" });

    await updateStoreRow(name, "receipts", "invalid-capture", (row) => ({
      ...row,
      undo: { kind: "unavailable", reason: "undo_is_final" },
    }));
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("invalid-capture"), initiatedBy: "person" }),
    ).resolves.toEqual({ ok: false, code: "stale_undo" });

    const staleName = databaseName("undo-stale-note");
    await seedLegacy(staleName);
    const stale = createRepository(staleName, {
      notes: ["stale-note"],
      receipts: ["stale-capture", "stale-trash", "stale-undo"],
    });
    await stale.bootstrap();
    await capture(stale, { note: "stale-note", receipt: "stale-capture" });
    await updateStoreRow(staleName, "receipts", "stale-capture", (row) => ({
      ...row,
      undo: { kind: "available", effect: "withdraw_capture" },
      resultingRevision: 99,
    }));
    await expect(
      stale.execute({ kind: "undo", receiptId: createReceiptId("stale-capture"), initiatedBy: "person" }),
    ).resolves.toEqual({ ok: false, code: "stale_undo" });
    await repository.close();
    await stale.close();
  });

  it("covers Undo receipt rollback and malformed receipt branches", async () => {
    const name = databaseName("undo-rollback");
    await seedLegacy(name);
    const repository = createRepository(name, {
      notes: ["rollback-note"],
      receipts: ["rollback-capture", "rollback-undo"],
      failureHook: (point) => {
        if (point === "undo.receipt-write") throw new Error("injected undo failure");
      },
    });
    await repository.bootstrap();
    await capture(repository, { note: "rollback-note", receipt: "rollback-capture" });
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("rollback-capture"), initiatedBy: "person" }),
    ).rejects.toThrow("injected undo failure");
    expect(await readStore(name, "notes")).toEqual([
      expect.objectContaining({ id: "rollback-note", lifecycle: "active", revision: 1 }),
    ]);
    expect(await readStore(name, "receipts")).toEqual([
      expect.objectContaining({ id: "rollback-capture", undo: { kind: "available", effect: "withdraw_capture" } }),
    ]);

    await updateStoreRow(name, "receipts", "rollback-capture", (row) => ({
      ...row,
      kind: "unknown-operation",
    }));
    await expect(
      repository.execute({ kind: "undo", receiptId: createReceiptId("rollback-capture"), initiatedBy: "person" }),
    ).resolves.toEqual({ ok: false, code: "stale_undo" });
    await repository.close();
  });

  it("recovers missing lifecycle metadata errors without rewriting legacy rows", async () => {
    const name = databaseName("missing-metadata");
    await seedLegacy(name);
    const repository = createRepository(name, {
      notes: ["metadata-note"],
      receipts: ["metadata-capture"],
    });
    await repository.bootstrap();
    await deleteStoreRow(name, "workspaceMetadata", "workspace");
    await expect(
      repository.execute({
        kind: "trash_notebook",
        notebookId: createNotebookId(legacyNotebook.id),
        expectedRevision: revisionOne,
        initiatedBy: "person",
      }),
    ).rejects.toThrow("metadata is unavailable");
    await repository.close();
  });
});
