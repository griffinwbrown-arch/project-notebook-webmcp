import { describe, expect, it, vi } from "vitest";

import {
  createIsoInstant,
  createNotebook,
  createNotebookId,
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
  ShelfViewModel,
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
};

function deferred<Value>(): Deferred<Value> {
  let resolveValue: (value: Value) => void = (): void => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function fixtureNotebook(
  id: string,
  createdAt: string,
  updatedAt: string = createdAt,
): Notebook {
  const created = createNotebook({
    id: createNotebookId(id),
    title: `Notebook ${id}`,
    subject: `Subject ${id}`,
    createdAt: createIsoInstant(createdAt),
  });
  return { ...created, updatedAt: createIsoInstant(updatedAt) };
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
  private readonly delayedGets = new Map<NotebookId, Promise<Notebook | null>>();
  private readonly delayedBootstraps: Promise<WorkspaceBootstrap>[] = [];
  private createBarrier: Promise<void> | null = null;
  private nextBootstrapError: Error | null = null;
  private metadataValue: WorkspaceMetadata = metadataFor(INBOX_NOTEBOOK_ID);
  private nextReceipt = 0;

  public readonly getCalls: NotebookId[] = [];
  public readonly setCurrentTargetCalls: NotebookId[] = [];
  public readonly operations: WorkspaceOperation[] = [];

  public constructor(notebooks: readonly Notebook[] = []) {
    for (const notebook of notebooks) {
      if (notebook.id !== INBOX_NOTEBOOK_ID) {
        this.records.set(notebook.id, notebook);
      }
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

  public failNextBootstrap(error: Error): void {
    this.nextBootstrapError = error;
  }

  public delayGet(id: NotebookId, result: Promise<Notebook | null>): void {
    this.delayedGets.set(id, result);
  }

  public waitBeforeCreate(barrier: Promise<void>): void {
    this.createBarrier = barrier;
  }

  public async bootstrap(): Promise<WorkspaceBootstrap> {
    const queued = this.delayedBootstraps.shift();
    if (queued !== undefined) {
      return queued;
    }
    if (this.nextBootstrapError !== null) {
      const error = this.nextBootstrapError;
      this.nextBootstrapError = null;
      throw error;
    }
    const notebooks = [...this.records.values()]
      .filter((notebook) => !this.trashed.has(notebook.id))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return this.bootstrapValue(notebooks);
  }

  public async getNotebook(id: NotebookId): Promise<Notebook | null> {
    this.getCalls.push(id);
    const delayed = this.delayedGets.get(id);
    if (delayed !== undefined) {
      return delayed;
    }
    if (id === INBOX_NOTEBOOK_ID) {
      return this.trashed.has(id) ? null : FIXED_INBOX;
    }
    return this.trashed.has(id) ? null : this.records.get(id) ?? null;
  }

  public async createNotebook(notebook: Notebook): Promise<Notebook> {
    await (this.createBarrier ?? Promise.resolve());
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
    this.setCurrentTargetCalls.push(id);
    if (this.metadataValue.currentTargetNotebookId === id) {
      return this.metadataValue;
    }
    this.metadataValue = {
      ...this.metadataValue,
      currentTargetNotebookId: id,
      revision: createRevision(this.metadataValue.revision + 1),
      updatedAt: METADATA_INSTANT,
    };
    return this.metadataValue;
  }

  public async execute(
    operation: WorkspaceOperation,
  ): Promise<WorkspaceOperationResult> {
    this.operations.push(operation);
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

class MemoryHistory implements WorkspaceHistory {
  public readonly pushes: WorkspacePlace[] = [];
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
    this.pushes.push(place);
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

  public listenerCount(): number {
    return this.listeners.size;
  }
}

function readyShelf(snapshot: WorkspaceSnapshot): ShelfViewModel {
  if (snapshot.status !== "ready" || snapshot.view.kind !== "shelf") {
    throw new Error("Expected a ready shelf snapshot.");
  }
  return snapshot.view;
}

function readyNotebook(snapshot: WorkspaceSnapshot): FocusedNotebookViewModel {
  if (snapshot.status !== "ready" || snapshot.view.kind !== "notebook") {
    throw new Error("Expected a ready notebook snapshot.");
  }
  return snapshot.view;
}

describe("workspace controller", () => {
  it("sorts covers by immutable creation time and id instead of persistence update order", async () => {
    const persistence = new MemoryPersistence([
      fixtureNotebook(
        "later-updated",
        "2026-08-26T12:00:00.000Z",
        "2026-08-26T18:00:00.000Z",
      ),
      fixtureNotebook("tie-b", "2026-08-26T13:00:00.000Z"),
      fixtureNotebook("tie-a", "2026-08-26T13:00:00.000Z"),
      fixtureNotebook("newest", "2026-08-26T14:00:00.000Z"),
    ]);
    const controller = createWorkspaceController(persistence, new MemoryHistory());

    await controller.start();

    expect(readyShelf(controller.getSnapshot()).notebooks.map((cover) => cover.id)).toEqual([
      "later-updated",
      "tie-a",
      "tie-b",
      "newest",
    ]);
  });

  it("restores focused URLs and follows shelf and notebook history events", async () => {
    const notebook = fixtureNotebook("restored", "2026-08-26T12:00:00.000Z");
    const history = new MemoryHistory({
      kind: "canonical",
      place: { kind: "notebook", notebookId: notebook.id },
    });
    const controller = createWorkspaceController(
      new MemoryPersistence([notebook]),
      history,
    );

    await controller.start();
    expect(readyNotebook(controller.getSnapshot())).toMatchObject({
      notebook: { id: notebook.id },
    });

    history.emit({ kind: "canonical", place: { kind: "shelf" } });
    expect(readyShelf(controller.getSnapshot()).kind).toBe("shelf");

    history.emit({
      kind: "canonical",
      place: { kind: "notebook", notebookId: notebook.id },
    });
    await vi.waitFor(() => {
      expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
        notebook.id,
      );
    });
  });

  it("canonicalizes a valid focused repair without losing its place", async () => {
    const notebook = fixtureNotebook("canonical", "2026-08-26T12:00:00.000Z");
    const place: WorkspacePlace = {
      kind: "notebook",
      notebookId: notebook.id,
    };
    const history = new MemoryHistory({ kind: "repair", place });
    const controller = createWorkspaceController(
      new MemoryPersistence([notebook]),
      history,
    );

    await controller.start();

    expect(history.replacements).toEqual([place]);
    expect(readyNotebook(controller.getSnapshot())).toMatchObject({
      notebook: { id: notebook.id },
    });
  });

  it("keeps a newer history place while the initial bootstrap is pending", async () => {
    const notebook = fixtureNotebook("newer-place", "2026-08-26T12:00:00.000Z");
    const persistence = new MemoryPersistence([notebook]);
    const initialBootstrap = deferred<WorkspaceBootstrap>();
    persistence.queueBootstrap(initialBootstrap.promise);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history);

    const start = controller.start();
    history.emit({
      kind: "canonical",
      place: { kind: "notebook", notebookId: notebook.id },
    });
    await vi.waitFor(() => {
      expect(readyNotebook(controller.getSnapshot())).toMatchObject({
        notebook: { id: notebook.id },
      });
    });

    initialBootstrap.resolve(persistence.bootstrapValue([notebook]));
    await start;

    expect(readyNotebook(controller.getSnapshot())).toMatchObject({
      notebook: { id: notebook.id },
    });
    controller.showShelf();
    expect(readyShelf(controller.getSnapshot()).notebooks.map((cover) => cover.id)).toEqual([
      notebook.id,
    ]);
  });

  it("creates, opens, and returns to the shelf through product operations", async () => {
    const existing = fixtureNotebook("existing", "2026-08-26T12:00:00.000Z");
    const persistence = new MemoryPersistence([existing]);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history, {
      createId: () => createNotebookId("created-notebook"),
      now: () => createIsoInstant("2026-08-26T15:00:00.000Z"),
    });
    await controller.start();

    const created = await controller.createNotebook({
      title: "Created",
      subject: "Created subject",
    });
    expect(created).toMatchObject({ ok: true, value: { id: "created-notebook" } });
    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
      "created-notebook",
    );

    controller.showShelf();
    expect(readyShelf(controller.getSnapshot()).notebooks.map((cover) => cover.id)).toEqual([
      existing.id,
      "created-notebook",
    ]);

    await controller.openNotebook(createNotebookId("created-notebook"));
    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
      "created-notebook",
    );

    controller.showShelf();
    await controller.openNotebook(existing.id);
    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(existing.id);
    expect(history.pushes.map((place) => place.kind)).toEqual([
      "notebook",
      "shelf",
      "notebook",
      "shelf",
      "notebook",
    ]);
  });

  it("repairs malformed places to the shelf and stale places to the Inbox", async () => {
    const history = new MemoryHistory({ kind: "repair", place: { kind: "shelf" } });
    const controller = createWorkspaceController(
      new MemoryPersistence(),
      history,
    );
    await controller.start();
    expect(history.replacements).toEqual([{ kind: "shelf" }]);

    history.emit({
      kind: "canonical",
      place: {
        kind: "notebook",
        notebookId: createNotebookId("missing"),
      },
    });
    await vi.waitFor(() => {
      expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(
        INBOX_NOTEBOOK_ID,
      );
      expect(history.replacements).toContainEqual({
        kind: "notebook",
        notebookId: INBOX_NOTEBOOK_ID,
      });
    });
  });

  it("suppresses stale notebook restores and rejects overlapping creates", async () => {
    const slow = fixtureNotebook("slow", "2026-08-26T12:00:00.000Z");
    const fast = fixtureNotebook("fast", "2026-08-26T13:00:00.000Z");
    const persistence = new MemoryPersistence([slow, fast]);
    const slowGet = deferred<Notebook | null>();
    persistence.delayGet(slow.id, slowGet.promise);
    const createGate = deferred<void>();
    persistence.waitBeforeCreate(createGate.promise);
    const controller = createWorkspaceController(persistence, new MemoryHistory());
    await controller.start();

    const slowOpen = controller.openNotebook(slow.id);
    const fastOpen = controller.openNotebook(fast.id);
    await expect(fastOpen).resolves.toMatchObject({ ok: true });
    slowGet.resolve(slow);
    await expect(slowOpen).resolves.toMatchObject({ ok: false });
    expect(readyNotebook(controller.getSnapshot())).toMatchObject({
      notebook: { id: fast.id },
    });

    controller.showShelf();
    const firstCreate = controller.createNotebook({ title: "First", subject: "Subject" });
    await expect(
      controller.createNotebook({ title: "Second", subject: "Subject" }),
    ).resolves.toMatchObject({ ok: false, issue: { kind: "busy" } });
    createGate.resolve(undefined);
    await expect(firstCreate).resolves.toMatchObject({ ok: true });
  });

  it("rejects operations outside its active lifetime and publishes bounded load failures", async () => {
    const notebook = fixtureNotebook("lifetime", "2026-08-26T12:00:00.000Z");
    const persistence = new MemoryPersistence([notebook]);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history);

    await expect(controller.listNotebooks()).resolves.toMatchObject({ ok: false });
    await expect(
      controller.createNotebook({ title: "Before", subject: "Start" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(controller.openNotebook(notebook.id)).resolves.toMatchObject({
      ok: false,
    });
    controller.showShelf();
    expect(history.pushes).toEqual([]);

    persistence.failNextBootstrap(new Error("storage unavailable"));
    await controller.start();
    expect(controller.getSnapshot()).toEqual({
      status: "failed",
      fallback: {
        kind: "shelf",
        inbox: {
          kind: "notebook",
          id: "inbox",
          title: "Inbox",
          subject: "Quick notes",
        },
        notebooks: [],
        notice: null,
      },
      message: "Your notebooks could not be opened.",
    });

    persistence.failNextBootstrap(new Error("storage unavailable"));
    await expect(controller.listNotebooks()).resolves.toEqual({
      ok: false,
      issue: {
        kind: "unavailable",
        message: "Your notebooks could not be opened.",
      },
    });
    await expect(
      controller.createNotebook({ title: "", subject: "" }),
    ).resolves.toMatchObject({ ok: false, issue: { kind: "unavailable" } });

    await controller.dispose();
    await expect(controller.listNotebooks()).resolves.toMatchObject({ ok: false });
    await expect(controller.openNotebook(notebook.id)).resolves.toMatchObject({
      ok: false,
    });
  });

  it("does not expose covers from a prior activation when restart loading fails", async () => {
    const notebook = fixtureNotebook("prior-cover", "2026-08-26T12:00:00.000Z");
    const persistence = new MemoryPersistence([notebook]);
    const controller = createWorkspaceController(persistence, new MemoryHistory());

    await controller.start();
    expect(readyShelf(controller.getSnapshot()).notebooks).toHaveLength(1);
    await controller.dispose();

    persistence.failNextBootstrap(new Error("storage unavailable"));
    await controller.start();

    expect(controller.getSnapshot()).toEqual({
      status: "failed",
      fallback: {
        kind: "shelf",
        inbox: {
          kind: "notebook",
          id: "inbox",
          title: "Inbox",
          subject: "Quick notes",
        },
        notebooks: [],
        notice: null,
      },
      message: "Your notebooks could not be opened.",
    });
  });

  it("notifies current subscribers only and allows creation again after completion", async () => {
    const persistence = new MemoryPersistence();
    let nextId = 0;
    const controller = createWorkspaceController(
      persistence,
      new MemoryHistory(),
      {
        createId: () => {
          nextId += 1;
          return createNotebookId(`created-${nextId}`);
        },
      },
    );
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    await controller.start();
    expect(listener).toHaveBeenCalled();

    await expect(
      controller.createNotebook({ title: "First", subject: "Subject" }),
    ).resolves.toMatchObject({ ok: true, value: { id: "created-1" } });
    controller.showShelf();
    await expect(
      controller.createNotebook({ title: "Second", subject: "Subject" }),
    ).resolves.toMatchObject({ ok: true, value: { id: "created-2" } });

    unsubscribe();
    const notifications = listener.mock.calls.length;
    controller.showShelf();
    expect(listener).toHaveBeenCalledTimes(notifications);
  });

  it("does not let an older start publish after dispose and restart", async () => {
    const current = fixtureNotebook("current", "2026-08-26T13:00:00.000Z");
    const stale = fixtureNotebook("stale", "2026-08-26T11:00:00.000Z");
    const persistence = new MemoryPersistence([current]);
    const oldBootstrap = deferred<WorkspaceBootstrap>();
    persistence.queueBootstrap(oldBootstrap.promise);
    const history = new MemoryHistory();
    const controller = createWorkspaceController(persistence, history);

    const oldStart = controller.start();
    await controller.dispose();
    await controller.start();
    expect(readyShelf(controller.getSnapshot()).notebooks.map((cover) => cover.id)).toEqual([
      current.id,
    ]);

    oldBootstrap.resolve(persistence.bootstrapValue([stale]));
    await oldStart;
    expect(readyShelf(controller.getSnapshot()).notebooks.map((cover) => cover.id)).toEqual([
      current.id,
    ]);
    expect(history.listenerCount()).toBe(1);
  });

  it("starts and disposes repeatedly with one history subscription", async () => {
    const history = new MemoryHistory();
    const controller = createWorkspaceController(new MemoryPersistence(), history);

    await Promise.all([controller.start(), controller.start()]);
    expect(history.listenerCount()).toBe(1);
    await controller.dispose();
    expect(history.listenerCount()).toBe(0);
    await controller.dispose();
    expect(history.listenerCount()).toBe(0);

    await controller.start();
    expect(history.listenerCount()).toBe(1);
    expect(readyShelf(controller.getSnapshot()).kind).toBe("shelf");
    await controller.dispose();
  });
});
