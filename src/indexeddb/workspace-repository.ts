import type {
  IDBPDatabase,
  IDBPTransaction,
  StoreNames,
} from "idb";
import { z } from "zod";

import {
  createIsoInstant,
  createNoteEntry,
  createNoteId,
  createNotebook,
  createNotebookId,
  createReceiptId,
  createRevision,
  moveNote,
  parseNote,
  parseReceipt,
  restoreNote,
  sortNoteEntries,
  trashNote,
  type IsoInstant,
  type NoteEntry,
  type NoteId,
  type Notebook,
  type NotebookId,
  type ReceiptId,
  type Revision,
} from "../domain";
import type {
  WorkspaceOperation,
  WorkspaceOperationResult,
} from "../workspace/model";

import {
  notebookToRow,
  openPhase2Database,
  parseNotebookRow,
  PHASE0_DATABASE_NAME,
  type NoteRow,
  type NotebookLifecycleRow,
  type Phase2Database,
  type ReceiptRow,
  type WorkspaceMetadataRow,
} from "./database";

export const INBOX_NOTEBOOK_ID = createNotebookId("inbox");
export const WORKSPACE_METADATA_ID = "workspace" as const;

export type WorkspaceIssue = Readonly<{
  kind: "malformed_notebook";
  id: string;
  message: string;
}>;

export type WorkspaceBootstrap = Readonly<{
  inbox: Notebook;
  notebooks: readonly Notebook[];
  metadata: WorkspaceMetadataRow;
  issues: readonly WorkspaceIssue[];
}>;

export type WorkspaceRepositoryOptions = Readonly<{
  databaseName?: string;
  clock?: Readonly<{ now: () => string }>;
  ids?: Readonly<{
    newNotebookId: () => string;
    newNoteId: () => string;
    newReceiptId: () => string;
  }>;
  failureHook?: ((point: string) => void) | undefined;
}>;

const MetadataSchema = z
  .object({
    id: z.literal(WORKSPACE_METADATA_ID),
    version: z.literal(1),
    inboxNotebookId: z.literal("inbox"),
    currentTargetNotebookId: z.string(),
    revision: z.number().int().safe().positive(),
    updatedAt: z.string(),
  })
  .strict();

const LifecycleSchema = z
  .object({
    notebookId: z.string(),
    lifecycle: z.enum(["active", "trashed"]),
    revision: z.number().int().safe().positive(),
    updatedAt: z.string(),
  })
  .strict();

function defaultId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

function defaultClock(): string {
  return new Date().toISOString();
}

function parseMetadata(value: unknown): WorkspaceMetadataRow {
  const row = MetadataSchema.parse(value);
  return {
    id: WORKSPACE_METADATA_ID,
    version: 1,
    inboxNotebookId: createNotebookId(row.inboxNotebookId),
    currentTargetNotebookId: createNotebookId(row.currentTargetNotebookId),
    revision: createRevision(row.revision),
    updatedAt: createIsoInstant(row.updatedAt),
  };
}

function parseLifecycle(value: unknown): NotebookLifecycleRow {
  const row = LifecycleSchema.parse(value);
  return {
    notebookId: createNotebookId(row.notebookId),
    lifecycle: row.lifecycle,
    revision: createRevision(row.revision),
    updatedAt: createIsoInstant(row.updatedAt),
  };
}

function noteToRow(note: NoteEntry): NoteRow {
  return {
    id: note.id,
    targetNotebookId: note.targetNotebookId,
    revision: note.revision,
    contentVersion: 1,
    content: note.content,
    lifecycle: note.lifecycle,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function lifecycleDefault(notebookId: NotebookId, at: IsoInstant): NotebookLifecycleRow {
  return {
    notebookId,
    lifecycle: "active",
    revision: createRevision(1),
    updatedAt: at,
  };
}

type AbortableTransaction = Readonly<{
  abort: () => void;
  done: Promise<unknown>;
}>;

async function abortAndRethrow(
  transaction: AbortableTransaction,
  error: unknown,
): Promise<never> {
  try {
    transaction.abort();
  } catch {
  }
  try {
    await transaction.done;
  } catch {
  }
  throw error;
}

export class IndexedDbWorkspaceRepository {
  private readonly databaseName: string;
  private readonly nowValue: () => string;
  private readonly newNoteValue: () => string;
  private readonly newReceiptValue: () => string;
  private readonly failureHook: ((point: string) => void) | undefined;
  private database: IDBPDatabase<Phase2Database> | null = null;

  public constructor(options: WorkspaceRepositoryOptions = {}) {
    this.databaseName = options.databaseName ?? PHASE0_DATABASE_NAME;
    this.nowValue = options.clock?.now ?? defaultClock;
    this.newNoteValue = options.ids?.newNoteId ?? defaultId;
    this.newReceiptValue = options.ids?.newReceiptId ?? defaultId;
    this.failureHook = options.failureHook;
  }

  private now(): IsoInstant {
    return createIsoInstant(this.nowValue());
  }

  private newNoteId(): NoteId {
    return createNoteId(this.newNoteValue());
  }

  private newReceiptId(): ReceiptId {
    return createReceiptId(this.newReceiptValue());
  }

  private async getDatabase(): Promise<IDBPDatabase<Phase2Database>> {
    this.database ??= await openPhase2Database(
      this.databaseName,
      this.failureHook,
    );
    return this.database;
  }

  public async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  public async bootstrap(): Promise<WorkspaceBootstrap> {
    const database = await this.getDatabase();
    const instant = this.now();
    const inbox = createNotebook({
      id: INBOX_NOTEBOOK_ID,
      title: "Inbox",
      subject: "Quick notes",
      createdAt: instant,
    });
    const initialMetadata: WorkspaceMetadataRow = {
      id: WORKSPACE_METADATA_ID,
      version: 1,
      inboxNotebookId: INBOX_NOTEBOOK_ID,
      currentTargetNotebookId: INBOX_NOTEBOOK_ID,
      revision: createRevision(1),
      updatedAt: instant,
    };
    const transaction = database.transaction(
      ["notebooks", "notebookLifecycle", "workspaceMetadata"],
      "readwrite",
    );
    try {
      const existingInbox = await transaction.objectStore("notebooks").get(
        INBOX_NOTEBOOK_ID,
      );
      if (existingInbox === undefined) {
        await transaction.objectStore("notebooks").add(notebookToRow(inbox));
      } else {
        parseNotebookRow(existingInbox);
      }
      const existingMetadata = await transaction
        .objectStore("workspaceMetadata")
        .get(WORKSPACE_METADATA_ID);
      let metadata: WorkspaceMetadataRow;
      if (existingMetadata === undefined) {
        await transaction
          .objectStore("workspaceMetadata")
          .add(initialMetadata);
        metadata = initialMetadata;
      } else {
        metadata = parseMetadata(existingMetadata);
      }
      let targetIsActive = false;
      try {
        const rawTarget = await transaction
          .objectStore("notebooks")
          .get(metadata.currentTargetNotebookId);
        const rawTargetLifecycle = await transaction
          .objectStore("notebookLifecycle")
          .get(metadata.currentTargetNotebookId);
        targetIsActive =
          rawTarget !== undefined &&
          parseNotebookRow(rawTarget).id === metadata.currentTargetNotebookId &&
          (rawTargetLifecycle === undefined ||
            parseLifecycle(rawTargetLifecycle).lifecycle === "active");
      } catch {
        targetIsActive = false;
      }
      if (!targetIsActive) {
        metadata = {
          ...metadata,
          currentTargetNotebookId: metadata.inboxNotebookId,
          revision: createRevision(metadata.revision + 1),
          updatedAt: instant,
        };
        await transaction.objectStore("workspaceMetadata").put(metadata);
      }
      await transaction.done;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }

    const [rawNotebooks, rawLifecycle, rawMetadata] = await Promise.all([
      database.getAll("notebooks"),
      database.getAll("notebookLifecycle"),
      database.get("workspaceMetadata", WORKSPACE_METADATA_ID),
    ]);
    if (rawMetadata === undefined) {
      throw new Error("Workspace metadata bootstrap did not commit.");
    }
    const metadata = parseMetadata(rawMetadata);
    const lifecycleByNotebook = new Map<string, NotebookLifecycleRow>();
    for (const raw of rawLifecycle) {
      const lifecycle = parseLifecycle(raw);
      lifecycleByNotebook.set(lifecycle.notebookId, lifecycle);
    }
    const notebooks: Notebook[] = [];
    const issues: WorkspaceIssue[] = [];
    let parsedInbox: Notebook | null = null;
    for (const raw of rawNotebooks) {
      try {
        const notebook = parseNotebookRow(raw);
        if (notebook.id === metadata.inboxNotebookId) {
          parsedInbox = notebook;
        } else if (
          lifecycleByNotebook.get(notebook.id)?.lifecycle !== "trashed"
        ) {
          notebooks.push(notebook);
        }
      } catch (error: unknown) {
        const id =
          typeof raw === "object" &&
          raw !== null &&
          "id" in raw &&
          typeof raw.id === "string"
            ? raw.id
            : "unknown";
        issues.push({
          kind: "malformed_notebook",
          id,
          message: error instanceof Error ? error.message : "Malformed notebook row.",
        });
      }
    }
    if (parsedInbox === null) {
      throw new Error("The stable Inbox row is unavailable.");
    }
    notebooks.sort((left, right) => {
      const createdOrder = left.createdAt.localeCompare(right.createdAt);
      return createdOrder === 0
        ? left.id.localeCompare(right.id)
        : createdOrder;
    });
    return { inbox: parsedInbox, notebooks, metadata, issues };
  }

  public async getNotebook(id: NotebookId): Promise<Notebook | null> {
    const database = await this.getDatabase();
    const raw = await database.get("notebooks", id);
    if (raw === undefined) {
      return null;
    }
    const lifecycle = await database.get("notebookLifecycle", id);
    if (lifecycle !== undefined && parseLifecycle(lifecycle).lifecycle === "trashed") {
      return null;
    }
    return parseNotebookRow(raw);
  }

  public async createNotebook(notebook: Notebook): Promise<Notebook> {
    const database = await this.getDatabase();
    const transaction = database.transaction("notebooks", "readwrite");
    try {
      await transaction.store.add(notebookToRow(notebook));
      await transaction.done;
      return notebook;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async updateNotebook(
    notebook: Notebook,
    expectedRevision: Revision,
  ): Promise<Notebook> {
    const database = await this.getDatabase();
    const transaction = database.transaction("notebooks", "readwrite");
    try {
      const raw = await transaction.store.get(notebook.id);
      if (raw === undefined) {
        throw new Error("Notebook not found.");
      }
      const current = parseNotebookRow(raw);
      if (
        current.revision !== expectedRevision ||
        notebook.revision !== createRevision(current.revision + 1)
      ) {
        throw new Error("Notebook revision conflict.");
      }
      await transaction.store.put(notebookToRow(notebook));
      await transaction.done;
      return notebook;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async setCurrentTarget(
    notebookId: NotebookId,
  ): Promise<WorkspaceMetadataRow> {
    const database = await this.getDatabase();
    const instant = this.now();
    const transaction = database.transaction(
      ["notebooks", "notebookLifecycle", "workspaceMetadata"],
      "readwrite",
    );
    try {
      await this.requireActiveNotebook(transaction, notebookId, instant);
      const rawMetadata = await transaction
        .objectStore("workspaceMetadata")
        .get(WORKSPACE_METADATA_ID);
      if (rawMetadata === undefined) {
        throw new Error("Workspace metadata is unavailable.");
      }
      const metadata = parseMetadata(rawMetadata);
      if (metadata.currentTargetNotebookId === notebookId) {
        await transaction.done;
        return metadata;
      }
      const updated: WorkspaceMetadataRow = {
        ...metadata,
        currentTargetNotebookId: notebookId,
        revision: createRevision(metadata.revision + 1),
        updatedAt: instant,
      };
      await transaction.objectStore("workspaceMetadata").put(updated);
      await transaction.done;
      return updated;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async listNotes(
    notebookId: NotebookId,
    lifecycle: "active" | "trashed" = "active",
  ): Promise<readonly NoteEntry[]> {
    const database = await this.getDatabase();
    const rows = await database.getAllFromIndex(
      "notes",
      "byNotebookLifecycleCreatedAtId",
      IDBKeyRange.bound(
        [notebookId, lifecycle, "", ""],
        [notebookId, lifecycle, "\uffff", "\uffff"],
      ),
    );
    return sortNoteEntries(rows.map(parseNote));
  }

  public async execute(
    operation: WorkspaceOperation,
  ): Promise<WorkspaceOperationResult> {
    switch (operation.kind) {
      case "capture_note":
        return this.capture(operation);
      case "move_note":
        return this.move(operation);
      case "trash_note":
      case "restore_note":
        return this.changeNoteLifecycle(operation);
      case "trash_notebook":
      case "restore_notebook":
        return this.changeNotebookLifecycle(operation);
      case "undo":
        return this.undo(operation);
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
  }

  private async requireActiveNotebook<
    Names extends ArrayLike<StoreNames<Phase2Database>> & StoreNames<Phase2Database>[],
  >(
    transaction: IDBPTransaction<Phase2Database, Names, "readwrite">,
    notebookId: NotebookId,
    instant: IsoInstant,
  ): Promise<Notebook> {
    const workspaceTransaction = transaction as unknown as IDBPTransaction<
      Phase2Database,
      ["notebooks", "notebookLifecycle"],
      "readwrite"
    >;
    const rawNotebook = await workspaceTransaction
      .objectStore("notebooks")
      .get(notebookId);
    if (rawNotebook === undefined) {
      throw new Error("Notebook not found.");
    }
    const notebook = parseNotebookRow(rawNotebook);
    const rawLifecycle = await workspaceTransaction
      .objectStore("notebookLifecycle")
      .get(notebookId);
    const lifecycle =
      rawLifecycle === undefined
        ? lifecycleDefault(notebookId, instant)
        : parseLifecycle(rawLifecycle);
    if (lifecycle.lifecycle !== "active") {
      throw new Error("The target notebook is in Trash.");
    }
    return notebook;
  }

  private async capture(
    operation: Extract<WorkspaceOperation, { kind: "capture_note" }>,
  ): Promise<WorkspaceOperationResult> {
    const instant = this.now();
    const note = createNoteEntry({
      id: this.newNoteId(),
      targetNotebookId: operation.target.notebookId,
      content: operation.content,
      createdAt: instant,
    });
    const receiptId = this.newReceiptId();
    const receipt: ReceiptRow = {
      id: receiptId,
      kind: "capture_note",
      source: operation.initiatedBy,
      completedAt: instant,
      noteId: note.id,
      targetNotebookId: note.targetNotebookId,
      resultingRevision: note.revision,
      undo: { kind: "available", effect: "withdraw_capture" },
    };
    const database = await this.getDatabase();
    const transaction = database.transaction(
      ["notebooks", "notebookLifecycle", "notes", "receipts"],
      "readwrite",
    );
    try {
      await this.requireActiveNotebook(
        transaction,
        note.targetNotebookId,
        instant,
      );
      await transaction.objectStore("notes").add(noteToRow(note));
      this.failureHook?.("capture.after-note");
      this.failureHook?.("capture.receipt-write");
      await transaction.objectStore("receipts").add(receipt);
      await transaction.done;
      return { ok: true, receipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  private async move(
    operation: Extract<WorkspaceOperation, { kind: "move_note" }>,
  ): Promise<WorkspaceOperationResult> {
    const instant = this.now();
    const receiptId = this.newReceiptId();
    const database = await this.getDatabase();
    const transaction = database.transaction(
      ["notebooks", "notebookLifecycle", "notes", "receipts"],
      "readwrite",
    );
    try {
      await this.requireActiveNotebook(transaction, operation.to.notebookId, instant);
      const rawNote = await transaction.objectStore("notes").get(operation.noteId);
      if (rawNote === undefined) {
        await transaction.done;
        return { ok: false, code: "not_found" };
      }
      const current = parseNote(rawNote);
      if (current.revision !== operation.expectedRevision) {
        await transaction.done;
        return { ok: false, code: "conflict" };
      }
      const moved = moveNote(current, operation.to.notebookId, instant);
      const receipt: ReceiptRow = {
        id: receiptId,
        kind: "move_note",
        source: operation.initiatedBy,
        completedAt: instant,
        noteId: moved.id,
        fromNotebookId: current.targetNotebookId,
        toNotebookId: moved.targetNotebookId,
        resultingRevision: moved.revision,
        undo: { kind: "available", effect: "move_back" },
      };
      await transaction.objectStore("notes").put(noteToRow(moved));
      this.failureHook?.("move.receipt-write");
      await transaction.objectStore("receipts").add(receipt);
      await transaction.done;
      return { ok: true, receipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  private async changeNoteLifecycle(
    operation: Extract<
      WorkspaceOperation,
      { kind: "trash_note" | "restore_note" }
    >,
  ): Promise<WorkspaceOperationResult> {
    const instant = this.now();
    const receiptId = this.newReceiptId();
    const database = await this.getDatabase();
    const transaction = database.transaction(["notes", "receipts"], "readwrite");
    try {
      const rawNote = await transaction.objectStore("notes").get(operation.noteId);
      if (rawNote === undefined) {
        await transaction.done;
        return { ok: false, code: "not_found" };
      }
      const current = parseNote(rawNote);
      if (current.revision !== operation.expectedRevision) {
        await transaction.done;
        return { ok: false, code: "conflict" };
      }
      const next =
        operation.kind === "trash_note"
          ? trashNote(current, instant)
          : restoreNote(current, instant);
      const receipt: ReceiptRow = {
        id: receiptId,
        kind: operation.kind,
        source: operation.initiatedBy,
        completedAt: instant,
        noteId: next.id,
        priorLifecycle: current.lifecycle,
        resultingLifecycle: next.lifecycle,
        resultingRevision: next.revision,
        undo: {
          kind: "available",
          effect:
            operation.kind === "trash_note" ? "restore_note" : "trash_note",
        },
      };
      await transaction.objectStore("notes").put(noteToRow(next));
      this.failureHook?.(`${operation.kind}.receipt-write`);
      await transaction.objectStore("receipts").add(receipt);
      await transaction.done;
      return { ok: true, receipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  private async changeNotebookLifecycle(
    operation: Extract<
      WorkspaceOperation,
      { kind: "trash_notebook" | "restore_notebook" }
    >,
  ): Promise<WorkspaceOperationResult> {
    if (
      operation.kind === "trash_notebook" &&
      operation.notebookId === INBOX_NOTEBOOK_ID
    ) {
      return { ok: false, code: "invalid_target" };
    }
    const instant = this.now();
    const receiptId = this.newReceiptId();
    const database = await this.getDatabase();
    const transaction = database.transaction(
      ["notebooks", "notebookLifecycle", "workspaceMetadata", "receipts"],
      "readwrite",
    );
    try {
      const rawNotebook = await transaction
        .objectStore("notebooks")
        .get(operation.notebookId);
      if (rawNotebook === undefined) {
        await transaction.done;
        return { ok: false, code: "not_found" };
      }
      parseNotebookRow(rawNotebook);
      const rawLifecycle = await transaction
        .objectStore("notebookLifecycle")
        .get(operation.notebookId);
      const current =
        rawLifecycle === undefined
          ? lifecycleDefault(operation.notebookId, instant)
          : parseLifecycle(rawLifecycle);
      if (current.revision !== operation.expectedRevision) {
        await transaction.done;
        return { ok: false, code: "conflict" };
      }
      const expectedState =
        operation.kind === "trash_notebook" ? "active" : "trashed";
      if (current.lifecycle !== expectedState) {
        await transaction.done;
        return { ok: false, code: "conflict" };
      }
      const next: NotebookLifecycleRow = {
        notebookId: current.notebookId,
        lifecycle:
          operation.kind === "trash_notebook" ? "trashed" : "active",
        revision: createRevision(current.revision + 1),
        updatedAt: instant,
      };
      const rawMetadata = await transaction
        .objectStore("workspaceMetadata")
        .get(WORKSPACE_METADATA_ID);
      if (rawMetadata === undefined) {
        throw new Error("Workspace metadata is unavailable.");
      }
      const metadata = parseMetadata(rawMetadata);
      const resetsCurrent =
        operation.kind === "trash_notebook" &&
        metadata.currentTargetNotebookId === operation.notebookId;
      const nextMetadata: WorkspaceMetadataRow | null = resetsCurrent
        ? {
            ...metadata,
            currentTargetNotebookId: metadata.inboxNotebookId,
            revision: createRevision(metadata.revision + 1),
            updatedAt: instant,
          }
        : null;
      const receipt: ReceiptRow = {
        id: receiptId,
        kind: operation.kind,
        source: operation.initiatedBy,
        completedAt: instant,
        notebookId: operation.notebookId,
        priorLifecycle: current.lifecycle,
        resultingLifecycle: next.lifecycle,
        resultingRevision: next.revision,
        ...(resetsCurrent
          ? {
              priorCurrentTargetNotebookId: operation.notebookId,
              resultingWorkspaceRevision: createRevision(metadata.revision + 1),
            }
          : {}),
        undo: {
          kind: "available",
          effect:
            operation.kind === "trash_notebook"
              ? "restore_notebook"
              : "trash_notebook",
        },
      };
      await transaction.objectStore("notebookLifecycle").put(next);
      if (nextMetadata !== null) {
        await transaction.objectStore("workspaceMetadata").put(nextMetadata);
      }
      this.failureHook?.(`${operation.kind}.receipt-write`);
      await transaction.objectStore("receipts").add(receipt);
      await transaction.done;
      return { ok: true, receipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  private async undo(
    operation: Extract<WorkspaceOperation, { kind: "undo" }>,
  ): Promise<WorkspaceOperationResult> {
    const instant = this.now();
    const undoReceiptId = this.newReceiptId();
    const database = await this.getDatabase();
    const transaction = database.transaction(
      ["notes", "receipts", "notebookLifecycle", "workspaceMetadata"],
      "readwrite",
    );
    try {
      const source = await transaction
        .objectStore("receipts")
        .get(operation.receiptId);
      if (source === undefined) {
        await transaction.done;
        return { ok: false, code: "not_found" };
      }
      let sourceReceipt;
      try {
        sourceReceipt = parseReceipt(source);
      } catch {
        await transaction.done;
        return { ok: false, code: "stale_undo" };
      }
      if (sourceReceipt.undo.kind === "consumed") {
        await transaction.done;
        return { ok: false, code: "already_undone" };
      }
      if (sourceReceipt.undo.kind !== "available") {
        await transaction.done;
        return { ok: false, code: "stale_undo" };
      }
      const existingUndo = await transaction
        .objectStore("receipts")
        .index("byUndoOf")
        .get(operation.receiptId);
      if (existingUndo !== undefined) {
        await transaction.done;
        return { ok: false, code: "already_undone" };
      }
      let affectedId = "";
      let resultingRevision: Revision;
      if (
        sourceReceipt.kind === "capture_note" ||
        sourceReceipt.kind === "move_note" ||
        sourceReceipt.kind === "trash_note" ||
        sourceReceipt.kind === "restore_note"
      ) {
        const noteId = sourceReceipt.noteId;
        const rawNote = await transaction.objectStore("notes").get(noteId);
        if (rawNote === undefined) {
          await transaction.done;
          return { ok: false, code: "stale_undo" };
        }
        const current = parseNote(rawNote);
        if (current.revision !== sourceReceipt.resultingRevision) {
          await transaction.done;
          return { ok: false, code: "stale_undo" };
        }
        let inverse: NoteEntry;
        if (sourceReceipt.kind === "capture_note") {
          if (
            current.lifecycle !== "active" ||
            current.targetNotebookId !== sourceReceipt.targetNotebookId
          ) {
            await transaction.done;
            return { ok: false, code: "stale_undo" };
          }
          inverse = trashNote(current, instant);
        } else if (sourceReceipt.kind === "move_note") {
          if (
            current.lifecycle !== "active" ||
            current.targetNotebookId !== sourceReceipt.toNotebookId
          ) {
            await transaction.done;
            return { ok: false, code: "stale_undo" };
          }
          inverse = moveNote(
            current,
            sourceReceipt.fromNotebookId,
            instant,
          );
        } else if (sourceReceipt.kind === "trash_note") {
          if (current.lifecycle !== "trashed") {
            await transaction.done;
            return { ok: false, code: "stale_undo" };
          }
          inverse = restoreNote(current, instant);
        } else {
          if (current.lifecycle !== "active") {
            await transaction.done;
            return { ok: false, code: "stale_undo" };
          }
          inverse = trashNote(current, instant);
        }
        await transaction.objectStore("notes").put(noteToRow(inverse));
        affectedId = inverse.id;
        resultingRevision = createRevision(inverse.revision);
      } else if (
        sourceReceipt.kind === "trash_notebook" ||
        sourceReceipt.kind === "restore_notebook"
      ) {
        const notebookId = sourceReceipt.notebookId;
        const rawLifecycle = await transaction
          .objectStore("notebookLifecycle")
          .get(notebookId);
        if (rawLifecycle === undefined) {
          await transaction.done;
          return { ok: false, code: "stale_undo" };
        }
        const current = parseLifecycle(rawLifecycle);
        if (
          current.revision !== sourceReceipt.resultingRevision ||
          current.lifecycle !== sourceReceipt.resultingLifecycle
        ) {
          await transaction.done;
          return { ok: false, code: "stale_undo" };
        }
        const inverse: NotebookLifecycleRow = {
          notebookId,
          lifecycle: current.lifecycle === "trashed" ? "active" : "trashed",
          revision: createRevision(current.revision + 1),
          updatedAt: instant,
        };
        const rawMetadata = await transaction
          .objectStore("workspaceMetadata")
          .get(WORKSPACE_METADATA_ID);
        if (rawMetadata === undefined) {
          throw new Error("Workspace metadata is unavailable.");
        }
        const metadata = parseMetadata(rawMetadata);
        let inverseMetadata: WorkspaceMetadataRow | null = null;
        if (sourceReceipt.kind === "trash_notebook") {
          const priorCurrentTarget = sourceReceipt.priorCurrentTargetNotebookId;
          if (priorCurrentTarget !== undefined) {
            const expectedWorkspaceRevision =
              sourceReceipt.resultingWorkspaceRevision;
            if (expectedWorkspaceRevision === undefined) {
              await transaction.done;
              return { ok: false, code: "stale_undo" };
            }
            if (
              metadata.currentTargetNotebookId !== metadata.inboxNotebookId ||
              metadata.revision !== expectedWorkspaceRevision
            ) {
              await transaction.done;
              return { ok: false, code: "stale_undo" };
            }
            inverseMetadata = {
              ...metadata,
              currentTargetNotebookId: priorCurrentTarget,
              revision: createRevision(metadata.revision + 1),
              updatedAt: instant,
            };
          }
        } else if (metadata.currentTargetNotebookId === notebookId) {
          inverseMetadata = {
            ...metadata,
            currentTargetNotebookId: metadata.inboxNotebookId,
            revision: createRevision(metadata.revision + 1),
            updatedAt: instant,
          };
        }
        await transaction.objectStore("notebookLifecycle").put(inverse);
        if (inverseMetadata !== null) {
          await transaction
            .objectStore("workspaceMetadata")
            .put(inverseMetadata);
        }
        affectedId = notebookId;
        resultingRevision = createRevision(inverse.revision);
      } else {
        await transaction.done;
        return { ok: false, code: "stale_undo" };
      }

      const consumed: ReceiptRow = {
        ...sourceReceipt,
        undo: { kind: "consumed", by: undoReceiptId },
      };
      const undoReceipt: ReceiptRow = {
        id: undoReceiptId,
        kind: "undo",
        source: operation.initiatedBy,
        completedAt: instant,
        undoOf: operation.receiptId,
        affectedId,
        resultingRevision,
        undo: { kind: "unavailable", reason: "undo_is_final" },
      };
      await transaction.objectStore("receipts").put(consumed);
      this.failureHook?.("undo.receipt-write");
      await transaction.objectStore("receipts").add(undoReceipt);
      await transaction.done;
      return { ok: true, receipt: undoReceipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }
}
