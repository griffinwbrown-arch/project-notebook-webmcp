import { describe, expect, it, vi } from "vitest";

import {
  createIsoInstant,
  createNoteId,
  createNotebook,
  createNotebookId,
  createReceiptId,
  createRevision,
  type Notebook,
  type NotebookId,
  type Revision,
} from "../../../src/domain";
import { createWorkspaceController } from "../../../src/workspace/controller";
import type {
  WorkspaceHistory,
  WorkspaceHistoryRead,
} from "../../../src/workspace/history";
import type {
  FocusedNotebookViewModel,
  WorkspaceOperation,
  WorkspaceOperationResult,
  WorkspacePlace,
  WorkspaceSnapshot,
} from "../../../src/workspace/model";
import type {
  WorkspaceBootstrap,
  WorkspaceMetadata,
  WorkspacePersistence,
} from "../../../src/workspace/persistence";

type Deferred<Value> = {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
  readonly reject: (error: unknown) => void;
};

function deferred<Value>(): Deferred<Value> {
  let resolveValue: (value: Value) => void = (): void => undefined;
  let rejectValue: (error: unknown) => void = (): void => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function fixtureNotebook(id: string): Notebook {
  return createNotebook({
    id: createNotebookId(id),
    title: `Notebook ${id}`,
    subject: `Subject ${id}`,
    createdAt: createIsoInstant("2026-08-26T12:00:00.000Z"),
  });
}

const INBOX_NOTEBOOK_ID = createNotebookId("inbox");
const FIXED_INBOX = createNotebook({
  id: INBOX_NOTEBOOK_ID,
  title: "Inbox",
  subject: "Quick notes",
  createdAt: createIsoInstant("2026-08-26T00:00:00.000Z"),
});
const METADATA_INSTANT = createIsoInstant("2026-08-26T00:00:00.000Z");

function metadataFor(currentTargetNotebookId: NotebookId): WorkspaceMetadata {
  return {
    id: "workspace",
    version: 1,
    inboxNotebookId: INBOX_NOTEBOOK_ID,
    currentTargetNotebookId,
    revision: createRevision(1),
    updatedAt: METADATA_INSTANT,
  };
}

class MemoryPersistence implements WorkspacePersistence {
  private readonly records = new Map<NotebookId, Notebook>();
  private readonly trashed = new Set<NotebookId>();
  private readonly delayedBootstraps: Promise<WorkspaceBootstrap>[] = [];
  private metadataValue: WorkspaceMetadata = metadataFor(INBOX_NOTEBOOK_ID);
  private nextReceipt = 0;

  public readonly operations: WorkspaceOperation[] = [];

  public constructor(notebooks: readonly Notebook[] = []) {
    for (const notebook of notebooks) {
      this.records.set(notebook.id, notebook);
    }
  }

  public queueBootstrap(result: Promise<WorkspaceBootstrap>): void {
    this.delayedBootstraps.push(result);
  }

  public bootstrapValue(
    notebooks: readonly Notebook[] = [...this.records.values()],
  ): WorkspaceBootstrap {
    return {
      inbox: FIXED_INBOX,
      notebooks,
      metadata: this.metadataValue,
      issues: [],
    };
  }

  public markTrashed(id: NotebookId): void {
    this.trashed.add(id);
  }

  public async bootstrap(): Promise<WorkspaceBootstrap> {
    const queued = this.delayedBootstraps.shift();
    if (queued !== undefined) {
      return queued;
    }
    const notebooks = [...this.records.values()].filter(
      (notebook) => !this.trashed.has(notebook.id),
    );
    return this.bootstrapValue(notebooks);
  }

  public async getNotebook(id: NotebookId): Promise<Notebook | null> {
    if (id === INBOX_NOTEBOOK_ID) {
      return this.trashed.has(id) ? null : FIXED_INBOX;
    }
    return this.trashed.has(id) ? null : this.records.get(id) ?? null;
  }

  public async createNotebook(notebook: Notebook): Promise<Notebook> {
    this.records.set(notebook.id, notebook);
    return notebook;
  }

  public async updateNotebook(
    notebook: Notebook,
    expectedRevision: Revision,
  ): Promise<Notebook> {
    void expectedRevision;
    this.records.set(notebook.id, notebook);
    return notebook;
  }

  public async setCurrentTarget(id: NotebookId): Promise<WorkspaceMetadata> {
    if ((await this.getNotebook(id)) === null) {
      throw new Error("Notebook not found.");
    }
    if (this.metadataValue.currentTargetNotebookId !== id) {
      this.metadataValue = {
        ...this.metadataValue,
        currentTargetNotebookId: id,
        revision: createRevision(this.metadataValue.revision + 1),
        updatedAt: METADATA_INSTANT,
      };
    }
    return this.metadataValue;
  }

  public async execute(
    operation: WorkspaceOperation,
  ): Promise<WorkspaceOperationResult> {
    this.operations.push(operation);
    if (operation.kind === "trash_notebook") {
      this.trashed.add(operation.notebookId);
      if (this.metadataValue.currentTargetNotebookId === operation.notebookId) {
        this.metadataValue = {
          ...this.metadataValue,
          currentTargetNotebookId: INBOX_NOTEBOOK_ID,
          revision: createRevision(this.metadataValue.revision + 1),
        };
      }
    }
    if (operation.kind === "restore_notebook") {
      this.trashed.delete(operation.notebookId);
    }
    this.nextReceipt += 1;
    return {
      ok: true,
      receipt: { id: `receipt-${this.nextReceipt}`, kind: operation.kind },
    };
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

class RacingTargetPersistence extends MemoryPersistence {
  public readonly targetCalls: NotebookId[] = [];
  private readonly blockedTarget: NotebookId;
  private readonly blockedWrite = deferred<WorkspaceMetadata>();
  private hasBlocked = false;

  public constructor(notebooks: readonly Notebook[], blockedTarget: NotebookId) {
    super(notebooks);
    this.blockedTarget = blockedTarget;
  }

  public override async setCurrentTarget(id: NotebookId): Promise<WorkspaceMetadata> {
    this.targetCalls.push(id);
    if (id === this.blockedTarget && !this.hasBlocked) {
      this.hasBlocked = true;
      return this.blockedWrite.promise;
    }
    return super.setCurrentTarget(id);
  }

  public rejectBlockedWrite(): void {
    this.blockedWrite.reject(new Error("Superseded target write failed."));
  }
}

class MemoryHistory implements WorkspaceHistory {
  public readonly replacements: WorkspacePlace[] = [];
  private readonly listeners = new Set<(read: WorkspaceHistoryRead) => void>();
  private current: WorkspaceHistoryRead;

  public constructor(
    initial: WorkspaceHistoryRead = {
      kind: "canonical",
      place: { kind: "shelf" },
    },
  ) {
    this.current = initial;
  }

  public read(): WorkspaceHistoryRead {
    return this.current;
  }

  public push(place: WorkspacePlace): void {
    this.current = { kind: "canonical", place };
  }

  public replace(place: WorkspacePlace): void {
    this.replacements.push(place);
    this.current = { kind: "canonical", place };
  }

  public subscribe(listener: (read: WorkspaceHistoryRead) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public emit(read: WorkspaceHistoryRead): void {
    this.current = read;
    for (const listener of this.listeners) {
      listener(read);
    }
  }
}

function readyNotebook(snapshot: WorkspaceSnapshot): FocusedNotebookViewModel {
  if (snapshot.status !== "ready" || snapshot.view.kind !== "notebook") {
    throw new Error("Expected a ready notebook snapshot.");
  }
  return snapshot.view;
}

describe("phase 2 workspace controller", () => {
  it("does not persist Inbox recovery after a newer history target supersedes a failed focus", async () => {
    const first = fixtureNotebook("first");
    const second = fixtureNotebook("second");
    const persistence = new RacingTargetPersistence([first, second], first.id);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history);
    await controller.start();

    const firstOpen = controller.openNotebook(first.id);
    await vi.waitFor(() => expect(persistence.targetCalls).toEqual([first.id]));
    history.emit({ kind: "canonical", place: { kind: "notebook", notebookId: second.id } });
    persistence.rejectBlockedWrite();

    await firstOpen;
    await vi.waitFor(() => {
      expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(second.id);
    });
    expect(persistence.targetCalls).toEqual([first.id, second.id]);
  });

  it("resolves current, explicit notebook, and Inbox capture targets", async () => {
    const notebook = fixtureNotebook("work");
    const persistence = new MemoryPersistence([notebook]);
    const controller = createWorkspaceController(persistence, new MemoryHistory());
    await controller.start();
    await controller.openNotebook(notebook.id);

    await controller.captureNote({
      target: { kind: "current" },
      content: { format: "plain_text", text: "Current target" },
    });
    await controller.captureNote({
      target: { kind: "notebook", notebookId: notebook.id },
      content: { format: "plain_text", text: "Explicit target" },
    });
    await controller.captureNote({
      target: { kind: "inbox" },
      content: { format: "plain_text", text: "Inbox target" },
    });

    expect(persistence.operations).toEqual([
      {
        kind: "capture_note",
        target: { kind: "notebook", notebookId: notebook.id },
        content: { format: "plain_text", text: "Current target" },
        initiatedBy: "person",
      },
      {
        kind: "capture_note",
        target: { kind: "notebook", notebookId: notebook.id },
        content: { format: "plain_text", text: "Explicit target" },
        initiatedBy: "person",
      },
      {
        kind: "capture_note",
        target: { kind: "notebook", notebookId: INBOX_NOTEBOOK_ID },
        content: { format: "plain_text", text: "Inbox target" },
        initiatedBy: "person",
      },
    ]);
  });

  it("uses the durable current target after a shelf navigation and restart", async () => {
    const notebook = fixtureNotebook("durable-target");
    const persistence = new MemoryPersistence([notebook]);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history);
    await controller.start();

    await controller.openNotebook(notebook.id);
    controller.showShelf();
    await controller.dispose();
    await controller.start();
    await controller.captureNote({
      target: { kind: "current" },
      content: { format: "plain_text", text: "After restart" },
    });

    expect(persistence.operations.at(-1)).toMatchObject({
      kind: "capture_note",
      target: { kind: "notebook", notebookId: notebook.id },
    });
  });

  it("recovers a missing focused notebook to Inbox with history replacement", async () => {
    const history = new MemoryHistory({
      kind: "canonical",
      place: { kind: "notebook", notebookId: createNotebookId("missing") },
    });
    const controller = createWorkspaceController(new MemoryPersistence(), history);

    await controller.start();

    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
      INBOX_NOTEBOOK_ID,
    );
    expect(history.replacements).toEqual([
      { kind: "notebook", notebookId: INBOX_NOTEBOOK_ID },
    ]);
  });

  it("recovers a trashed focused notebook to Inbox with history replacement", async () => {
    const notebook = fixtureNotebook("trashed-focus");
    const persistence = new MemoryPersistence([notebook]);
    persistence.markTrashed(notebook.id);
    const history = new MemoryHistory({
      kind: "canonical",
      place: { kind: "notebook", notebookId: notebook.id },
    });
    const controller = createWorkspaceController(persistence, history);

    await controller.start();

    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
      INBOX_NOTEBOOK_ID,
    );
    expect(history.replacements).toEqual([
      { kind: "notebook", notebookId: INBOX_NOTEBOOK_ID },
    ]);
  });

  it("keeps the latest Back or Forward place during delayed bootstrap", async () => {
    const first = fixtureNotebook("first-place");
    const latest = fixtureNotebook("latest-place");
    const persistence = new MemoryPersistence([first, latest]);
    const bootstrap = deferred<WorkspaceBootstrap>();
    persistence.queueBootstrap(bootstrap.promise);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history);

    const start = controller.start();
    history.emit({
      kind: "canonical",
      place: { kind: "notebook", notebookId: first.id },
    });
    history.emit({
      kind: "canonical",
      place: { kind: "notebook", notebookId: latest.id },
    });

    await vi.waitFor(() => {
      expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(latest.id);
    });
    bootstrap.resolve(persistence.bootstrapValue([first, latest]));
    await start;

    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(latest.id);
  });

  it("delegates note Move, Undo, Trash, and Restore with their arguments", async () => {
    const notebook = fixtureNotebook("delegation");
    const persistence = new MemoryPersistence([notebook]);
    const controller = createWorkspaceController(persistence, new MemoryHistory());
    await controller.start();

    const noteId = createNoteId("note-delegation");
    const receiptId = createReceiptId("receipt-delegation");
    await controller.moveNote(noteId, {
      kind: "notebook",
      notebookId: notebook.id,
    }, createRevision(1));
    await controller.trashNote(noteId, createRevision(1));
    await controller.restoreNote(noteId, createRevision(2));
    await controller.undo(receiptId);

    expect(persistence.operations).toEqual([
      {
        kind: "move_note",
        noteId,
        to: { kind: "notebook", notebookId: notebook.id },
        expectedRevision: createRevision(1),
        initiatedBy: "person",
      },
      {
        kind: "trash_note",
        noteId,
        expectedRevision: createRevision(1),
        initiatedBy: "person",
      },
      {
        kind: "restore_note",
        noteId,
        expectedRevision: createRevision(2),
        initiatedBy: "person",
      },
      {
        kind: "undo",
        receiptId,
        initiatedBy: "person",
      },
    ]);
  });

  it("recovers focused Inbox after the controller delegates notebook Trash", async () => {
    const notebook = fixtureNotebook("trash-recovery");
    const persistence = new MemoryPersistence([notebook]);
    const history = new MemoryHistory({
      kind: "canonical",
      place: { kind: "notebook", notebookId: notebook.id },
    });
    const controller = createWorkspaceController(persistence, history);
    await controller.start();

    await expect(
      controller.trashNotebook(notebook.id, createRevision(1)),
    ).resolves.toMatchObject({ ok: true });

    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
      INBOX_NOTEBOOK_ID,
    );
    expect(history.replacements).toContainEqual({
      kind: "notebook",
      notebookId: INBOX_NOTEBOOK_ID,
    });
    expect(persistence.operations).toEqual([
      {
        kind: "trash_notebook",
        notebookId: notebook.id,
        expectedRevision: createRevision(1),
        initiatedBy: "person",
      },
    ]);
  });
});
