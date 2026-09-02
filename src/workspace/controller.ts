import {
  createIsoInstant,
  createNotebook,
  createNotebookId,
  generateNotebookId,
  nowIsoInstant,
  type IsoInstant,
  type NoteId,
  type Notebook,
  type NotebookId,
  type ReceiptId,
  type Revision,
} from "../domain";
import type { IndexedDbProjectStorage } from "../indexeddb/project-storage";
import {
  createProjectId,
  createProjectActor,
  createProjectWorkbookId,
  type Project,
  type ProjectId,
  type WorkbookIdentity,
} from "../projects";

import type { WorkspaceHistory, WorkspaceHistoryRead } from "./history";
import {
  INITIAL_WORKSPACE_SNAPSHOT,
  SHELF_PLACE,
  type CreateNotebookInput,
  type CreateProjectBindingInput,
  type FocusedNotebookViewModel,
  type NotebookCoverViewModel,
  type PlainTextCaptureInput,
  type ProjectSummaryViewModel,
  type ShelfViewModel,
  type WorkspaceOperationResult,
  type WorkspacePlace,
  type WorkspaceResult,
  type WorkspaceSnapshot,
} from "./model";
import type {
  WorkspaceBootstrap,
  WorkspaceMetadata,
  WorkspacePersistence,
} from "./persistence";

type NotebookRecord = Readonly<{
  cover: NotebookCoverViewModel;
  createdAt: IsoInstant;
}>;

export type WorkspaceControllerOptions = Readonly<{
  now?: () => IsoInstant;
  createId?: () => NotebookId;
  projectStorage?: Pick<
    IndexedDbProjectStorage,
    "bindUserWorkbook" | "listProjects" | "listWorkbookIdentities"
    | "createProjectAndBindUserWorkbook"
  >;
}>;

export interface WorkspaceController {
  readonly getSnapshot: () => WorkspaceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly start: () => Promise<void>;
  readonly showShelf: () => void;
  readonly listNotebooks: () => Promise<
    WorkspaceResult<readonly NotebookCoverViewModel[]>
  >;
  readonly createNotebook: (
    input: CreateNotebookInput,
  ) => Promise<WorkspaceResult<NotebookCoverViewModel>>;
  readonly openNotebook: (
    notebookId: NotebookId,
  ) => Promise<WorkspaceResult<FocusedNotebookViewModel>>;
  readonly bindNotebookToProject: (
    notebookId: NotebookId,
    projectId: ProjectId,
  ) => Promise<WorkspaceResult<FocusedNotebookViewModel>>;
  readonly createProjectAndBindNotebook: (
    notebookId: NotebookId,
    input: CreateProjectBindingInput,
  ) => Promise<WorkspaceResult<FocusedNotebookViewModel>>;
  readonly refreshProjectAssignments: () => Promise<void>;
  readonly captureNote: (
    input: PlainTextCaptureInput,
  ) => Promise<WorkspaceOperationResult>;
  readonly moveNote: (
    noteId: NoteId,
    target: PlainTextCaptureInput["target"],
    expectedRevision: Revision,
  ) => Promise<WorkspaceOperationResult>;
  readonly trashNote: (
    noteId: NoteId,
    expectedRevision: Revision,
  ) => Promise<WorkspaceOperationResult>;
  readonly restoreNote: (
    noteId: NoteId,
    expectedRevision: Revision,
  ) => Promise<WorkspaceOperationResult>;
  readonly trashNotebook: (
    notebookId: NotebookId,
    expectedRevision: Revision,
  ) => Promise<WorkspaceOperationResult>;
  readonly restoreNotebook: (
    notebookId: NotebookId,
    expectedRevision: Revision,
  ) => Promise<WorkspaceOperationResult>;
  readonly undo: (receiptId: ReceiptId) => Promise<WorkspaceOperationResult>;
  readonly dispose: () => Promise<void>;
}

function unavailable(
  message: string,
): {
  readonly ok: false;
  readonly issue: {
    readonly kind: "unavailable";
    readonly message: string;
  };
} {
  return { ok: false, issue: { kind: "unavailable", message } };
}

function recordFromNotebook(notebook: Notebook): NotebookRecord {
  return {
    cover: {
      kind: "notebook",
      id: notebook.id,
      title: notebook.title,
      subject: notebook.subject,
    },
    createdAt: notebook.createdAt,
  };
}

function sortRecords(records: Iterable<NotebookRecord>): NotebookRecord[] {
  return [...records].sort((left, right) => {
    const createdOrder = left.createdAt.localeCompare(right.createdAt);
    return createdOrder === 0
      ? left.cover.id.localeCompare(right.cover.id)
      : createdOrder;
  });
}

function coverList(
  records: ReadonlyMap<NotebookId, NotebookRecord>,
): readonly NotebookCoverViewModel[] {
  return sortRecords(records.values()).map((record) => record.cover);
}

type ProjectShelfContext = Readonly<{
  identities: ReadonlyMap<string, WorkbookIdentity>;
  projects: ReadonlyMap<string, Project>;
}>;

function projectSummaries(context: ProjectShelfContext): readonly ProjectSummaryViewModel[] {
  return [...context.projects.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .map((project) => ({ id: project.id, name: project.name }));
}

function coverWithProject(
  record: NotebookRecord,
  context: ProjectShelfContext,
): NotebookCoverViewModel {
  const identity = context.identities.get(record.cover.id);
  if (identity === undefined) {
    return { ...record.cover, shelfKind: "user", projectBinding: { kind: "unbound" } };
  }
  if (identity.projectId === null) {
    return { ...record.cover, shelfKind: "user", projectBinding: { kind: "unbound" } };
  }
  const project = context.projects.get(identity.projectId);
  if (project === undefined) {
    return { ...record.cover, shelfKind: identity.kind, projectBinding: { kind: "unbound" } };
  }
  const workbookIdentity = {
    kind: identity.kind,
    workbookId: identity.workbookId,
    projectId: identity.projectId,
    projectName: project.name,
  } as const;
  return {
    ...record.cover,
    shelfKind: identity.kind,
    projectId: identity.projectId,
    projectBinding: workbookIdentity,
    workbookIdentity,
  };
}

function shelfView(
  inbox: NotebookRecord,
  records: ReadonlyMap<NotebookId, NotebookRecord>,
  notice: string | null,
  context?: ProjectShelfContext,
): ShelfViewModel {
  if (context !== undefined) {
    const covers = sortRecords(records.values()).map((record) => coverWithProject(record, context));
    const userNotebooks = covers.filter((cover) => cover.shelfKind !== "agent");
    const agentNotebooks = covers.filter((cover) => cover.shelfKind === "agent");
    return {
      kind: "shelf",
      inbox: { ...inbox.cover, shelfKind: "user", projectBinding: { kind: "unbound" } },
      notebooks: userNotebooks,
      userNotebooks,
      agentNotebooks,
      projects: projectSummaries(context),
      notice,
    };
  }
  return {
    kind: "shelf",
    inbox: inbox.cover,
    notebooks: coverList(records),
    notice,
  };
}

function focusedView(
  record: NotebookRecord,
  context?: ProjectShelfContext,
): FocusedNotebookViewModel {
  if (context === undefined) return { kind: "notebook", notebook: record.cover };
  return {
    kind: "notebook",
    notebook: coverWithProject(record, context),
    projects: projectSummaries(context),
  };
}

function canonicalPlace(
  read: WorkspaceHistoryRead,
  history: WorkspaceHistory,
): WorkspacePlace {
  if (read.kind === "canonical") {
    return read.place;
  }
  history.replace(read.place);
  return read.place;
}

const FALLBACK_INBOX_RECORD: NotebookRecord = {
  cover: {
    kind: "notebook",
    id: createNotebookId("inbox"),
    title: "Inbox",
    subject: "Quick notes",
  },
  createdAt: createIsoInstant("1970-01-01T00:00:00.000Z"),
};

export function createWorkspaceController(
  persistence: WorkspacePersistence,
  history: WorkspaceHistory,
  options: WorkspaceControllerOptions = {},
): WorkspaceController {
  const listeners = new Set<() => void>();
  const records = new Map<NotebookId, NotebookRecord>();
  const identities = new Map<string, WorkbookIdentity>();
  const projects = new Map<string, Project>();
  const projectStorage = options.projectStorage;
  const now = options.now ?? nowIsoInstant;
  const createId = options.createId ?? generateNotebookId;
  let inboxRecord = FALLBACK_INBOX_RECORD;
  let metadata: WorkspaceMetadata | null = null;
  let loadNotice: string | null = null;
  let snapshot = INITIAL_WORKSPACE_SNAPSHOT;
  let active = false;
  let activationEpoch = 0;
  let restoreGeneration = 0;
  let historyUnsubscribe: (() => void) | null = null;
  let startTask: Promise<void> | null = null;
  let targetWriteTail: Promise<void> = Promise.resolve();
  let createPending = false;
  let requestedPlace: WorkspacePlace = SHELF_PLACE;

  const projectContext = (): ProjectShelfContext | undefined =>
    projectStorage === undefined ? undefined : { identities, projects };

  const refreshProjectContext = async (): Promise<void> => {
    if (projectStorage === undefined) return;
    try {
      const [nextIdentities, nextProjects] = await Promise.all([
        projectStorage.listWorkbookIdentities(),
        projectStorage.listProjects(),
      ]);
      identities.clear();
      projects.clear();
      for (const identity of nextIdentities) identities.set(identity.workbookId, identity);
      for (const project of nextProjects) projects.set(project.id, project);
    } catch {
      identities.clear();
      projects.clear();
      loadNotice = "Project assignments could not be opened. Stored rows were left unchanged.";
    }
  };

  const publish = (next: WorkspaceSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const applyBootstrap = (loaded: WorkspaceBootstrap): void => {
    records.clear();
    inboxRecord = recordFromNotebook(loaded.inbox);
    metadata = loaded.metadata;
    for (const notebook of loaded.notebooks) {
      records.set(notebook.id, recordFromNotebook(notebook));
    }
    loadNotice =
      loaded.issues.length === 0
        ? null
        : "Some local notebooks could not be opened. Their stored rows were left unchanged.";
  };

  const loadWorkspace = async (): Promise<
    WorkspaceResult<WorkspaceBootstrap>
  > => {
    try {
      return { ok: true, value: await persistence.bootstrap() };
    } catch {
      return unavailable("Your notebooks could not be opened.");
    }
  };

  const loadRecord = async (
    notebookId: NotebookId,
  ): Promise<WorkspaceResult<NotebookRecord>> => {
    try {
      const notebook = await persistence.getNotebook(notebookId);
      return notebook === null
        ? unavailable("That notebook could not be opened.")
        : { ok: true, value: recordFromNotebook(notebook) };
    } catch {
      return unavailable("That notebook could not be opened.");
    }
  };

  const setCurrentTarget = (
    notebookId: NotebookId,
  ): Promise<WorkspaceMetadata> => {
    const write = targetWriteTail.then(() =>
      persistence.setCurrentTarget(notebookId),
    );
    targetWriteTail = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  };

  const recoverToInbox = async (
    epoch: number,
    generation: number,
  ): Promise<void> => {
    if (
      !active ||
      epoch !== activationEpoch ||
      generation !== restoreGeneration
    ) {
      return;
    }
    const place: WorkspacePlace = {
      kind: "notebook",
      notebookId: inboxRecord.cover.id,
    };
    try {
      metadata = await setCurrentTarget(inboxRecord.cover.id);
    } catch {
      if (
        active &&
        epoch === activationEpoch &&
        generation === restoreGeneration
      ) {
        requestedPlace = SHELF_PLACE;
        history.replace(SHELF_PLACE);
        publish({
          status: "failed",
          fallback: shelfView(inboxRecord, records, loadNotice, projectContext()),
          message: "The Inbox could not be opened.",
        });
      }
      return;
    }
    if (
      !active ||
      epoch !== activationEpoch ||
      generation !== restoreGeneration
    ) {
      return;
    }
    requestedPlace = place;
    history.replace(place);
    publish({ status: "ready", view: focusedView(inboxRecord, projectContext()) });
  };

  const restore = async (
    place: WorkspacePlace,
    epoch: number,
  ): Promise<WorkspaceResult<FocusedNotebookViewModel> | null> => {
    const generation = ++restoreGeneration;
    if (place.kind === "shelf") {
      if (active && epoch === activationEpoch) {
        publish({
          status: "ready",
          view: shelfView(inboxRecord, records, loadNotice, projectContext()),
        });
      }
      return null;
    }

    publish({ status: "loading", requestedPlace: place });
    const result = await loadRecord(place.notebookId);
    if (
      !active ||
      epoch !== activationEpoch ||
      generation !== restoreGeneration
    ) {
      return unavailable(
        "The visible notebook changed before it finished opening.",
      );
    }
    if (!result.ok) {
      await recoverToInbox(epoch, generation);
      return result;
    }
    try {
      metadata = await setCurrentTarget(result.value.cover.id);
    } catch {
      await recoverToInbox(epoch, generation);
      return unavailable("That notebook could not be opened.");
    }
    if (
      !active ||
      epoch !== activationEpoch ||
      generation !== restoreGeneration
    ) {
      return unavailable(
        "The visible notebook changed before it finished opening.",
      );
    }
    if (result.value.cover.id === inboxRecord.cover.id) {
      inboxRecord = result.value;
    } else {
      records.set(result.value.cover.id, result.value);
    }
    const view = focusedView(result.value, projectContext());
    publish({ status: "ready", view });
    return { ok: true, value: view };
  };

  const handleHistory = (read: WorkspaceHistoryRead): void => {
    if (!active) {
      return;
    }
    const place = canonicalPlace(read, history);
    requestedPlace = place;
    void restore(place, activationEpoch);
  };

  const start = async (): Promise<void> => {
    if (active) {
      await (startTask ?? Promise.resolve());
      return;
    }

    active = true;
    const epoch = ++activationEpoch;
    records.clear();
    metadata = null;
    loadNotice = null;
    requestedPlace = canonicalPlace(history.read(), history);
    historyUnsubscribe?.();
    historyUnsubscribe = history.subscribe(handleHistory);
    publish({ status: "loading", requestedPlace });

    const task = (async (): Promise<void> => {
      const result = await loadWorkspace();
      if (!active || epoch !== activationEpoch) {
        return;
      }
      if (!result.ok) {
        publish({
          status: "failed",
          fallback: shelfView(inboxRecord, records, null, projectContext()),
          message: result.issue.message,
        });
        return;
      }
      applyBootstrap(result.value);
      await refreshProjectContext();
      await restore(requestedPlace, epoch);
    })();

    startTask = task;
    try {
      await task;
    } finally {
      if (active && epoch === activationEpoch) {
        startTask = null;
      }
    }
  };

  const listNotebooks = async (): Promise<
    WorkspaceResult<readonly NotebookCoverViewModel[]>
  > => {
    if (!active) {
      return unavailable("The desk is not ready yet.");
    }
    const epoch = activationEpoch;
    const result = await loadWorkspace();
    if (!active || epoch !== activationEpoch) {
      return unavailable(
        "The desk changed before the notebooks finished loading.",
      );
    }
    if (!result.ok) {
      return result;
    }
    applyBootstrap(result.value);
    await refreshProjectContext();
    return { ok: true, value: coverList(records) };
  };

  const refreshProjectAssignments = async (): Promise<void> => {
    if (!active) return;
    const visible = snapshot;
    const result = await loadWorkspace();
    if (!active || !result.ok) return;
    applyBootstrap(result.value);
    await refreshProjectContext();
    if (visible.status !== "ready" || visible.view.kind === "shelf") {
      publish({ status: "ready", view: shelfView(inboxRecord, records, loadNotice, projectContext()) });
      return;
    }
    const notebookId = visible.view.notebook.id;
    const record = notebookId === inboxRecord.cover.id ? inboxRecord : records.get(notebookId);
    if (record !== undefined) publish({ status: "ready", view: focusedView(record, projectContext()) });
  };

  const createNotebookAtDesk = async (
    input: CreateNotebookInput,
  ): Promise<WorkspaceResult<NotebookCoverViewModel>> => {
    if (!active) {
      return unavailable("The desk is not ready yet.");
    }
    if (createPending) {
      return {
        ok: false,
        issue: {
          kind: "busy",
          message: "Finish creating the current notebook first.",
        },
      };
    }

    createPending = true;
    const epoch = activationEpoch;
    try {
      const created = createNotebook({
        id: createId(),
        title: input.title,
        subject: input.subject,
        createdAt: now(),
      });
      const stored = await persistence.createNotebook(created);
      if (!active || epoch !== activationEpoch) {
        return unavailable(
          "The desk changed before the notebook finished creating.",
        );
      }
      metadata = await setCurrentTarget(stored.id);
      if (!active || epoch !== activationEpoch) {
        return unavailable(
          "The desk changed before the notebook finished creating.",
        );
      }
      const record = recordFromNotebook(stored);
      records.set(record.cover.id, record);
      const place: WorkspacePlace = {
        kind: "notebook",
        notebookId: record.cover.id,
      };
      requestedPlace = place;
      history.push(place);
      ++restoreGeneration;
      publish({ status: "ready", view: focusedView(record, projectContext()) });
      return { ok: true, value: record.cover };
    } catch (error: unknown) {
      return unavailable(
        error instanceof Error ? error.message : "The notebook could not be created.",
      );
    } finally {
      createPending = false;
    }
  };

  const openNotebook = async (
    notebookId: NotebookId,
  ): Promise<WorkspaceResult<FocusedNotebookViewModel>> => {
    if (!active) {
      return unavailable("The desk is not ready yet.");
    }
    const place: WorkspacePlace = { kind: "notebook", notebookId };
    requestedPlace = place;
    history.push(place);
    const result = await restore(place, activationEpoch);
    return result ?? unavailable("That notebook could not be opened.");
  };

  const bindNotebookToProject = async (
    notebookId: NotebookId,
    projectId: ProjectId,
  ): Promise<WorkspaceResult<FocusedNotebookViewModel>> => {
    if (!active || projectStorage === undefined) {
      return unavailable("Project binding is not available.");
    }
    if (notebookId === inboxRecord.cover.id) {
      return unavailable("The Inbox cannot be bound to a project.");
    }
    const loaded = await loadRecord(notebookId);
    if (!loaded.ok) return loaded;
    try {
      await projectStorage.bindUserWorkbook({
        workbookId: createProjectWorkbookId(notebookId),
        projectId: createProjectId(projectId),
      });
      await refreshProjectContext();
      records.set(notebookId, loaded.value);
      const view = focusedView(loaded.value, projectContext());
      if (
        snapshot.status === "ready" &&
        snapshot.view.kind === "notebook" &&
        snapshot.view.notebook.id === notebookId
      ) {
        publish({ status: "ready", view });
      }
      return { ok: true, value: view };
    } catch (error: unknown) {
      return unavailable(
        error instanceof Error ? error.message : "The notebook could not be bound to that project.",
      );
    }
  };

  const createProjectAndBindNotebook = async (
    notebookId: NotebookId,
    input: CreateProjectBindingInput,
  ): Promise<WorkspaceResult<FocusedNotebookViewModel>> => {
    if (!active || projectStorage === undefined) {
      return unavailable("Project creation is not available.");
    }
    if (notebookId === inboxRecord.cover.id) return unavailable("The Inbox cannot be bound to a project.");
    const loaded = await loadRecord(notebookId);
    if (!loaded.ok) return loaded;
    try {
      await projectStorage.createProjectAndBindUserWorkbook({
        workbookId: createProjectWorkbookId(notebookId),
        projectId: createProjectId(input.projectId),
        name: input.name,
        createdBy: createProjectActor({ kind: "user", id: "manual:project-notebook-user" }),
      });
      await refreshProjectContext();
      records.set(notebookId, loaded.value);
      const view = focusedView(loaded.value, projectContext());
      if (snapshot.status === "ready" && snapshot.view.kind === "notebook" && snapshot.view.notebook.id === notebookId) publish({ status: "ready", view });
      return { ok: true, value: view };
    } catch (error: unknown) {
      return unavailable(error instanceof Error ? error.message : "The project could not be created.");
    }
  };

  const resolveTarget = (
    target: PlainTextCaptureInput["target"],
  ): NotebookId | null => {
    if (target.kind === "notebook") {
      return target.notebookId;
    }
    if (target.kind === "inbox") {
      return metadata?.inboxNotebookId ?? null;
    }
    if (
      snapshot.status === "ready" &&
      snapshot.view.kind === "notebook"
    ) {
      return snapshot.view.notebook.id;
    }
    return metadata?.currentTargetNotebookId ?? null;
  };

  const execute = async (
    operation: Parameters<WorkspacePersistence["execute"]>[0],
  ): Promise<WorkspaceOperationResult> => {
    if (!active) {
      return { ok: false, code: "invalid_target" };
    }
    try {
      return await persistence.execute(operation);
    } catch {
      return { ok: false, code: "invalid_target" };
    }
  };

  const captureNote = async (
    input: PlainTextCaptureInput,
  ): Promise<WorkspaceOperationResult> => {
    const notebookId = resolveTarget(input.target);
    if (notebookId === null) {
      return { ok: false, code: "invalid_target" };
    }
    return execute({
      kind: "capture_note",
      target: { kind: "notebook", notebookId },
      content: input.content,
      initiatedBy: input.initiatedBy ?? "person",
    });
  };

  const moveNote = async (
    noteId: NoteId,
    target: PlainTextCaptureInput["target"],
    expectedRevision: Revision,
  ): Promise<WorkspaceOperationResult> => {
    const notebookId = resolveTarget(target);
    if (notebookId === null) {
      return { ok: false, code: "invalid_target" };
    }
    return execute({
      kind: "move_note",
      noteId,
      to: { kind: "notebook", notebookId },
      expectedRevision,
      initiatedBy: "person",
    });
  };

  const changeNoteLifecycle = (
    kind: "trash_note" | "restore_note",
    noteId: NoteId,
    expectedRevision: Revision,
  ): Promise<WorkspaceOperationResult> =>
    execute({ kind, noteId, expectedRevision, initiatedBy: "person" });

  const changeNotebookLifecycle = async (
    kind: "trash_notebook" | "restore_notebook",
    notebookId: NotebookId,
    expectedRevision: Revision,
  ): Promise<WorkspaceOperationResult> => {
    const result = await execute({
      kind,
      notebookId,
      expectedRevision,
      initiatedBy: "person",
    });
    if (!result.ok) {
      return result;
    }
    if (kind === "trash_notebook") {
      records.delete(notebookId);
      if (
        snapshot.status === "ready" &&
        snapshot.view.kind === "notebook" &&
        snapshot.view.notebook.id === notebookId
      ) {
        const generation = ++restoreGeneration;
        await recoverToInbox(activationEpoch, generation);
      } else if (snapshot.status === "ready" && snapshot.view.kind === "shelf") {
        publish({
          status: "ready",
          view: shelfView(inboxRecord, records, loadNotice, projectContext()),
        });
      }
    } else {
      const restored = await loadRecord(notebookId);
      if (restored.ok) {
        records.set(notebookId, restored.value);
      }
      if (snapshot.status === "ready" && snapshot.view.kind === "shelf") {
        publish({
          status: "ready",
          view: shelfView(inboxRecord, records, loadNotice, projectContext()),
        });
      }
    }
    return result;
  };

  const showShelf = (): void => {
    if (!active) {
      return;
    }
    ++restoreGeneration;
    requestedPlace = SHELF_PLACE;
    history.push(SHELF_PLACE);
    publish({
      status: "ready",
      view: shelfView(inboxRecord, records, loadNotice, projectContext()),
    });
  };

  const undo = async (
    receiptId: ReceiptId,
  ): Promise<WorkspaceOperationResult> => {
    const epoch = activationEpoch;
    const generation = restoreGeneration;
    const result = await execute({
      kind: "undo",
      receiptId,
      initiatedBy: "person",
    });
    if (!result.ok) {
      return result;
    }
    if (
      !active ||
      epoch !== activationEpoch ||
      generation !== restoreGeneration
    ) {
      return result;
    }
    const reloaded = await loadWorkspace();
    if (
      !active ||
      epoch !== activationEpoch ||
      generation !== restoreGeneration
    ) {
      return result;
    }
    if (!reloaded.ok) {
      publish({
        status: "failed",
        fallback: shelfView(inboxRecord, records, loadNotice, projectContext()),
        message: reloaded.issue.message,
      });
      return result;
    }
    applyBootstrap(reloaded.value);
    await refreshProjectContext();
    if (snapshot.status === "ready" && snapshot.view.kind === "shelf") {
      publish({
        status: "ready",
        view: shelfView(inboxRecord, records, loadNotice, projectContext()),
      });
      return result;
    }
    const durableTarget: WorkspacePlace = {
      kind: "notebook",
      notebookId: reloaded.value.metadata.currentTargetNotebookId,
    };
    requestedPlace = durableTarget;
    history.replace(durableTarget);
    await restore(durableTarget, epoch);
    return result;
  };

  const dispose = async (): Promise<void> => {
    if (!active && historyUnsubscribe === null) {
      return;
    }
    active = false;
    ++activationEpoch;
    ++restoreGeneration;
    historyUnsubscribe?.();
    historyUnsubscribe = null;
    startTask = null;
    await targetWriteTail;
  };

  return {
    getSnapshot: (): WorkspaceSnapshot => snapshot,
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    start,
    showShelf,
    listNotebooks,
    createNotebook: createNotebookAtDesk,
    openNotebook,
    bindNotebookToProject,
    createProjectAndBindNotebook,
    refreshProjectAssignments,
    captureNote,
    moveNote,
    trashNote: (noteId, expectedRevision) =>
      changeNoteLifecycle("trash_note", noteId, expectedRevision),
    restoreNote: (noteId, expectedRevision) =>
      changeNoteLifecycle("restore_note", noteId, expectedRevision),
    trashNotebook: (notebookId, expectedRevision) =>
      changeNotebookLifecycle("trash_notebook", notebookId, expectedRevision),
    restoreNotebook: (notebookId, expectedRevision) =>
      changeNotebookLifecycle("restore_notebook", notebookId, expectedRevision),
    undo,
    dispose,
  };
}
