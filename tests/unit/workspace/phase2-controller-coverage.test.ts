import { describe, expect, it } from "vitest";

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
  WorkspaceOperation,
  WorkspaceOperationResult,
  WorkspacePlace,
} from "../../../src/workspace/model";
import type {
  WorkspaceBootstrap,
  WorkspaceMetadata,
  WorkspacePersistence,
} from "../../../src/workspace/persistence";

const inboxId = createNotebookId("inbox");
const workId = createNotebookId("work");
const instant = createIsoInstant("2026-08-26T12:00:00.000Z");

function notebook(id: NotebookId, title: string = id): Notebook {
  return createNotebook({ id, title, subject: "Coverage", createdAt: instant });
}

function metadata(currentTargetNotebookId: NotebookId): WorkspaceMetadata {
  return {
    id: "workspace",
    version: 1,
    inboxNotebookId: inboxId,
    currentTargetNotebookId,
    revision: createRevision(1),
    updatedAt: instant,
  };
}

class CoveragePersistence implements WorkspacePersistence {
  public readonly operations: WorkspaceOperation[] = [];
  private readonly notebooks = new Map<NotebookId, Notebook>();
  private currentMetadata: WorkspaceMetadata = metadata(inboxId);
  private failCurrentTarget = false;
  private failNotebookLookup = false;
  private nextOperationResult: WorkspaceOperationResult | null = null;

  public constructor(notebooks: readonly Notebook[] = []) {
    for (const value of notebooks) this.notebooks.set(value.id, value);
  }

  public failSetCurrentTarget(): void {
    this.failCurrentTarget = true;
  }

  public failLookups(): void {
    this.failNotebookLookup = true;
  }

  public returnOperation(result: WorkspaceOperationResult): void {
    this.nextOperationResult = result;
  }

  public bootstrap(): Promise<WorkspaceBootstrap> {
    return Promise.resolve({
      inbox: notebook(inboxId, "Inbox"),
      notebooks: [...this.notebooks.values()],
      metadata: this.currentMetadata,
      issues: [],
    });
  }

  public getNotebook(id: NotebookId): Promise<Notebook | null> {
    if (this.failNotebookLookup) return Promise.reject(new Error("Lookup failed."));
    return Promise.resolve(id === inboxId ? notebook(inboxId, "Inbox") : this.notebooks.get(id) ?? null);
  }

  public createNotebook(value: Notebook): Promise<Notebook> {
    this.notebooks.set(value.id, value);
    return Promise.resolve(value);
  }

  public updateNotebook(value: Notebook, expectedRevision: Revision): Promise<Notebook> {
    void expectedRevision;
    this.notebooks.set(value.id, value);
    return Promise.resolve(value);
  }

  public setCurrentTarget(id: NotebookId): Promise<WorkspaceMetadata> {
    if (this.failCurrentTarget) return Promise.reject(new Error("Current target failed."));
    this.currentMetadata = { ...this.currentMetadata, currentTargetNotebookId: id };
    return Promise.resolve(this.currentMetadata);
  }

  public execute(operation: WorkspaceOperation): Promise<WorkspaceOperationResult> {
    this.operations.push(operation);
    const result = this.nextOperationResult ?? {
      ok: true,
      receipt: { id: `receipt-${this.operations.length}`, kind: operation.kind },
    };
    this.nextOperationResult = null;
    return Promise.resolve(result);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

class CoverageHistory implements WorkspaceHistory {
  private current: WorkspaceHistoryRead = { kind: "canonical", place: { kind: "shelf" } };
  private readonly listeners = new Set<(read: WorkspaceHistoryRead) => void>();
  public readonly replacements: WorkspacePlace[] = [];

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
    return () => this.listeners.delete(listener);
  }
}

describe("Phase 2 controller branch coverage", () => {
  it("publishes a shelf failure when missing-target recovery cannot persist Inbox focus", async () => {
    const persistence = new CoveragePersistence();
    persistence.failSetCurrentTarget();
    const history = new CoverageHistory();
    history.replace({ kind: "notebook", notebookId: createNotebookId("missing") });
    const controller = createWorkspaceController(persistence, history);

    await controller.start();

    expect(controller.getSnapshot()).toMatchObject({
      status: "failed",
      message: "The Inbox could not be opened.",
      fallback: { kind: "shelf", inbox: { id: inboxId } },
    });
    expect(history.replacements).toContainEqual({ kind: "shelf" });
  });

  it("leaves the controller shell stable when a notebook lifecycle operation is rejected", async () => {
    const persistence = new CoveragePersistence([notebook(workId, "Work")]);
    const controller = createWorkspaceController(persistence, new CoverageHistory());
    await controller.start();
    persistence.returnOperation({ ok: false, code: "conflict" });

    await expect(
      controller.trashNotebook(workId, createRevision(1)),
    ).resolves.toEqual({ ok: false, code: "conflict" });
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", view: { kind: "shelf" } });
  });

  it("refreshes the shelf after a successful restore cannot reload the notebook", async () => {
    const persistence = new CoveragePersistence([notebook(workId, "Work")]);
    const controller = createWorkspaceController(persistence, new CoverageHistory());
    await controller.start();
    persistence.failLookups();

    await expect(
      controller.restoreNotebook(workId, createRevision(1)),
    ).resolves.toMatchObject({ ok: true });
    expect(controller.getSnapshot()).toMatchObject({ status: "ready", view: { kind: "shelf" } });
  });
});
