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
import type {
  BindUserWorkbookInput,
  CreateProjectAndBindUserWorkbookInput,
} from "../../../src/indexeddb/project-storage";
import {
  createProjectActor,
  createProjectId,
  createProjectItemRevision,
  createProjectWorkbookId,
  type Project,
  type ProjectId,
  type WorkbookIdentity,
} from "../../../src/projects";
import { createWorkspaceController, type WorkspaceControllerOptions } from "../../../src/workspace/controller";
import type { WorkspaceHistory, WorkspaceHistoryRead } from "../../../src/workspace/history";
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

const INBOX_ID = createNotebookId("inbox");
const AT = createIsoInstant("2026-08-30T12:00:00.000Z");
const INBOX = createNotebook({
  id: INBOX_ID,
  title: "Inbox",
  subject: "Quick notes",
  createdAt: AT,
});

function notebook(id: string, createdAt: string): Notebook {
  return createNotebook({
    id: createNotebookId(id),
    title: `Notebook ${id}`,
    subject: `Subject ${id}`,
    createdAt: createIsoInstant(createdAt),
  });
}

function project(id: string, name: string, createdAt: string): Project {
  const instant = createIsoInstant(createdAt);
  return {
    version: 1,
    id: createProjectId(id),
    name,
    revision: createProjectItemRevision(1),
    createdBy: createProjectActor({ kind: "user", id: `user:${id}` }),
    createdAt: instant,
    updatedAt: instant,
  };
}

function userIdentity(
  notebookId: NotebookId,
  projectId: ProjectId | null,
  createdAt: string,
): WorkbookIdentity {
  return {
    version: 1,
    kind: "user",
    workbookId: createProjectWorkbookId(notebookId),
    projectId,
    createdAt: createIsoInstant(createdAt),
  };
}

function agentIdentity(
  notebookId: NotebookId,
  projectId: ProjectId,
  createdAt: string,
): WorkbookIdentity {
  return {
    version: 1,
    kind: "agent",
    workbookId: createProjectWorkbookId(notebookId),
    projectId,
    createdAt: createIsoInstant(createdAt),
  };
}

function metadata(currentTargetNotebookId: NotebookId): WorkspaceMetadata {
  return {
    id: "workspace",
    version: 1,
    inboxNotebookId: INBOX_ID,
    currentTargetNotebookId,
    revision: createRevision(1),
    updatedAt: AT,
  };
}

class LifecyclePersistence implements WorkspacePersistence {
  private readonly notebooks = new Map<NotebookId, Notebook>();
  private readonly trashed = new Set<NotebookId>();
  private metadataValue: WorkspaceMetadata;
  private receiptNumber = 0;

  public readonly operations: WorkspaceOperation[] = [];

  public constructor(notebooks: readonly Notebook[]) {
    for (const value of notebooks) this.notebooks.set(value.id, value);
    this.metadataValue = metadata(INBOX_ID);
  }

  public async bootstrap(): Promise<WorkspaceBootstrap> {
    return {
      inbox: INBOX,
      notebooks: [...this.notebooks.values()].filter((value) => !this.trashed.has(value.id)),
      metadata: this.metadataValue,
      issues: [],
    };
  }

  public async getNotebook(id: NotebookId): Promise<Notebook | null> {
    if (id === INBOX_ID) return INBOX;
    return this.trashed.has(id) ? null : this.notebooks.get(id) ?? null;
  }

  public async createNotebook(value: Notebook): Promise<Notebook> {
    this.notebooks.set(value.id, value);
    return value;
  }

  public async updateNotebook(value: Notebook, _expectedRevision: Revision): Promise<Notebook> {
    void _expectedRevision;
    this.notebooks.set(value.id, value);
    return value;
  }

  public async setCurrentTarget(id: NotebookId): Promise<WorkspaceMetadata> {
    if (await this.getNotebook(id) === null) throw new Error("Notebook not found.");
    this.metadataValue = {
      ...this.metadataValue,
      currentTargetNotebookId: id,
      revision: createRevision(this.metadataValue.revision + 1),
      updatedAt: AT,
    };
    return this.metadataValue;
  }

  public async execute(operation: WorkspaceOperation): Promise<WorkspaceOperationResult> {
    this.operations.push(operation);
    if (operation.kind === "trash_notebook") this.trashed.add(operation.notebookId);
    if (operation.kind === "restore_notebook") this.trashed.delete(operation.notebookId);
    this.receiptNumber += 1;
    return {
      ok: true,
      receipt: { id: `receipt-${this.receiptNumber}`, kind: operation.kind },
    };
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}

class TestHistory implements WorkspaceHistory {
  private current: WorkspaceHistoryRead;
  private readonly listeners = new Set<(read: WorkspaceHistoryRead) => void>();
  public readonly pushes: WorkspacePlace[] = [];
  public readonly replacements: WorkspacePlace[] = [];

  public constructor(initial: WorkspaceHistoryRead = { kind: "canonical", place: { kind: "shelf" } }) {
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
    return () => this.listeners.delete(listener);
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

type ProjectState = {
  identities: WorkbookIdentity[];
  projects: Project[];
  failReads?: boolean;
};

function projectApi(state: ProjectState): NonNullable<WorkspaceControllerOptions["projectStorage"]> {
  return {
    bindUserWorkbook: vi.fn(async ({ workbookId, projectId }: BindUserWorkbookInput): Promise<WorkbookIdentity> => {
      if (state.failReads) throw new Error("Project storage unavailable.");
      const current = state.identities.find((identity) => identity.workbookId === workbookId);
      if (current?.kind !== "user") throw new Error("User workbook is missing.");
      const next = state.identities.map((identity) => identity.workbookId === workbookId
        ? { ...current, projectId }
        : identity);
      state.identities = next;
      return next.find((identity) => identity.workbookId === workbookId)!;
    }),
    listProjects: vi.fn(async () => {
      if (state.failReads) throw new Error("Project storage unavailable.");
      return state.projects;
    }),
    listWorkbookIdentities: vi.fn(async () => {
      if (state.failReads) throw new Error("Project storage unavailable.");
      return state.identities;
    }),
    createProjectAndBindUserWorkbook: vi.fn(async ({ workbookId, projectId, name, createdBy }: CreateProjectAndBindUserWorkbookInput): Promise<Readonly<{ project: Project; identity: WorkbookIdentity }>> => {
      if (state.failReads) throw new Error("Project storage unavailable.");
      const instant = AT;
      const createdProject: Project = {
        version: 1,
        id: projectId,
        name,
        revision: createProjectItemRevision(1),
        createdBy,
        createdAt: instant,
        updatedAt: instant,
      };
      const createdIdentity = userIdentity(createNotebookId(workbookId), projectId, instant);
      state.projects = [...state.projects, createdProject];
      state.identities = [...state.identities, createdIdentity];
      return { project: createdProject, identity: createdIdentity };
    }),
  };
}

function readyShelf(snapshot: WorkspaceSnapshot): ShelfViewModel {
  if (snapshot.status !== "ready" || snapshot.view.kind !== "shelf") throw new Error("Expected a ready shelf.");
  return snapshot.view;
}

function readyNotebook(snapshot: WorkspaceSnapshot): FocusedNotebookViewModel {
  if (snapshot.status !== "ready" || snapshot.view.kind !== "notebook") throw new Error("Expected a ready notebook.");
  return snapshot.view;
}

describe("workspace controller project identity and lifecycle boundaries", () => {
  it("keeps user and agent identities distinct and renders missing bindings fail-closed", async () => {
    const userUnbound = notebook("user-unbound", "2026-08-30T12:01:00.000Z");
    const userBound = notebook("user-bound", "2026-08-30T12:02:00.000Z");
    const agentBound = notebook("agent-bound", "2026-08-30T12:03:00.000Z");
    const agentMissing = notebook("agent-missing", "2026-08-30T12:04:00.000Z");
    const noIdentity = notebook("no-identity", "2026-08-30T12:05:00.000Z");
    const alpha = project("alpha", "Alpha project", "2026-08-30T12:00:01.000Z");
    const beta = project("beta", "Beta project", "2026-08-30T12:00:02.000Z");
    const missingProjectId = createProjectId("missing-project");
    const state: ProjectState = {
      projects: [beta, alpha],
      identities: [
        userIdentity(userUnbound.id, null, "2026-08-30T12:01:00.000Z"),
        userIdentity(userBound.id, alpha.id, "2026-08-30T12:02:00.000Z"),
        agentIdentity(agentBound.id, alpha.id, "2026-08-30T12:03:00.000Z"),
        agentIdentity(agentMissing.id, missingProjectId, "2026-08-30T12:04:00.000Z"),
      ],
    };
    const controller = createWorkspaceController(
      new LifecyclePersistence([userUnbound, userBound, agentBound, agentMissing, noIdentity]),
      new TestHistory(),
      { projectStorage: projectApi(state) },
    );

    await controller.start();

    const shelf = readyShelf(controller.getSnapshot());
    expect(shelf.inbox).toMatchObject({ shelfKind: "user", projectBinding: { kind: "unbound" } });
    expect(shelf.userNotebooks?.map((cover) => cover.id)).toEqual([userUnbound.id, userBound.id, noIdentity.id]);
    expect(shelf.agentNotebooks?.map((cover) => cover.id)).toEqual([agentBound.id, agentMissing.id]);
    expect(shelf.notebooks.map((cover) => cover.id)).toEqual([userUnbound.id, userBound.id, noIdentity.id]);
    expect(shelf.projects).toEqual([
      { id: alpha.id, name: alpha.name },
      { id: beta.id, name: beta.name },
    ]);
    expect(shelf.userNotebooks?.find((cover) => cover.id === userBound.id)).toMatchObject({
      shelfKind: "user",
      projectId: alpha.id,
      projectBinding: {
        kind: "user",
        workbookId: createProjectWorkbookId(userBound.id),
        projectId: alpha.id,
        projectName: alpha.name,
      },
      workbookIdentity: {
        kind: "user",
        workbookId: createProjectWorkbookId(userBound.id),
        projectId: alpha.id,
        projectName: alpha.name,
      },
    });
    expect(shelf.agentNotebooks?.find((cover) => cover.id === agentBound.id)).toMatchObject({
      shelfKind: "agent",
      projectBinding: { kind: "agent", projectId: alpha.id, projectName: alpha.name },
    });
    expect(shelf.agentNotebooks?.find((cover) => cover.id === agentMissing.id)).toMatchObject({
      shelfKind: "agent",
      projectBinding: { kind: "unbound" },
    });
    expect(shelf.userNotebooks?.find((cover) => cover.id === noIdentity.id)).toMatchObject({
      shelfKind: "user",
      projectBinding: { kind: "unbound" },
    });

    const opened = await controller.openNotebook(userBound.id);
    expect(opened).toMatchObject({
      ok: true,
      value: {
        notebook: { id: userBound.id, projectId: alpha.id, projectBinding: { projectName: alpha.name } },
        projects: [{ id: alpha.id, name: alpha.name }, { id: beta.id, name: beta.name }],
      },
    });

    state.projects = [{ ...alpha, name: "Alpha renamed" }, beta];
    await controller.refreshProjectAssignments();
    expect(readyNotebook(controller.getSnapshot()).notebook).toMatchObject({
      id: userBound.id,
      projectBinding: { projectName: "Alpha renamed" },
    });
  });

  it("binds and creates project identities through the controller, then preserves them across notebook lifecycle changes", async () => {
    const unbound = notebook("bind-me", "2026-08-30T12:10:00.000Z");
    const createProjectNotebook = notebook("create-project", "2026-08-30T12:11:00.000Z");
    const alpha = project("alpha-lifecycle", "Alpha lifecycle", "2026-08-30T12:00:01.000Z");
    const state: ProjectState = {
      projects: [alpha],
      identities: [userIdentity(unbound.id, null, "2026-08-30T12:10:00.000Z")],
    };
    const api = projectApi(state);
    const persistence = new LifecyclePersistence([unbound, createProjectNotebook]);
    const history = new TestHistory();
    const controller = createWorkspaceController(persistence, history, { projectStorage: api });
    await controller.start();

    const bound = await controller.bindNotebookToProject(unbound.id, alpha.id);
    expect(bound).toMatchObject({
      ok: true,
      value: { notebook: { id: unbound.id, projectBinding: { kind: "user", projectId: alpha.id, projectName: alpha.name } } },
    });
    expect(api.bindUserWorkbook).toHaveBeenCalledWith({
      workbookId: createProjectWorkbookId(unbound.id),
      projectId: alpha.id,
    });

    const created = await controller.createProjectAndBindNotebook(createProjectNotebook.id, {
      projectId: "created-project",
      name: "Created project",
    });
    expect(created).toMatchObject({
      ok: true,
      value: { notebook: { id: createProjectNotebook.id, projectBinding: { kind: "user", projectName: "Created project" } } },
    });
    expect(api.createProjectAndBindUserWorkbook).toHaveBeenCalledWith(expect.objectContaining({
      workbookId: createProjectWorkbookId(createProjectNotebook.id),
      projectId: createProjectId("created-project"),
      name: "Created project",
    }));

    await controller.openNotebook(unbound.id);
    await expect(controller.trashNotebook(unbound.id, createRevision(1))).resolves.toMatchObject({ ok: true });
    expect(readyNotebook(controller.getSnapshot()).notebook.id).toBe(INBOX_ID);
    expect(history.replacements).toContainEqual({ kind: "notebook", notebookId: INBOX_ID });

    controller.showShelf();
    await expect(controller.restoreNotebook(unbound.id, createRevision(1))).resolves.toMatchObject({ ok: true });
    expect(readyShelf(controller.getSnapshot()).userNotebooks?.find((cover) => cover.id === unbound.id)).toMatchObject({
      projectBinding: { kind: "user", projectId: alpha.id, projectName: alpha.name },
    });
    expect(persistence.operations.map((operation) => operation.kind)).toEqual(["trash_notebook", "restore_notebook"]);

    await controller.dispose();
    expect(history.listenerCount()).toBe(0);
    await expect(controller.captureNote({
      target: { kind: "current" },
      content: { format: "plain_text", text: "after dispose" },
    })).resolves.toEqual({ ok: false, code: "invalid_target" });
  });

  it("shows a bounded assignment notice when project rows cannot be read", async () => {
    const notebookValue = notebook("project-read-failure", "2026-08-30T12:20:00.000Z");
    const state: ProjectState = { identities: [], projects: [], failReads: true };
    const controller = createWorkspaceController(
      new LifecyclePersistence([notebookValue]),
      new TestHistory(),
      { projectStorage: projectApi(state) },
    );

    await controller.start();

    const shelf = readyShelf(controller.getSnapshot());
    expect(shelf.notice).toBe("Project assignments could not be opened. Stored rows were left unchanged.");
    expect(shelf.projects).toEqual([]);
    expect(shelf.userNotebooks).toHaveLength(1);
    expect(shelf.userNotebooks?.[0]).toMatchObject({ shelfKind: "user", projectBinding: { kind: "unbound" } });
  });
});
