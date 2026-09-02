import type { IDBPDatabase } from "idb";

import {
  createIsoInstant,
  createNotebook,
  createNotebookId,
  type IsoInstant,
} from "../domain";
import { createEmptyPageDocument } from "../page";
import {
  createProjectActor,
  createProjectAnchor,
  createProjectId,
  createProjectItemId,
  createProjectItemReceiptId,
  createProjectItemRevision,
  createProjectMutationId,
  createProjectWorkbookId,
  sameProjectAnchor,
  validateProjectText,
  type Project,
  type ProjectActor,
  type ProjectCommandSource,
  type ProjectId,
  type ProjectItem,
  type ProjectItemAnchor,
  type ProjectItemId,
  type ProjectItemKind,
  type ProjectItemReceipt,
  type ProjectItemReceiptId,
  type ProjectItemRevision,
  type ProjectItemStatus,
  type ProjectMutationId,
  type ProjectWorkbookId,
  type WorkbookIdentity,
} from "../projects/domain";
import {
  identityToRow,
  itemToRow,
  parseProjectItemReceiptRow,
  parseProjectItemRow,
  parseProjectRow,
  parseWorkbookIdentityRow,
  projectToRow,
  type ProjectItemReceiptRequestRow,
  type ProjectItemReceiptRow,
  type ProjectItemRow,
} from "../projects/rows";
import {
  notebookToRow,
  openPhase2Database,
  PHASE0_DATABASE_NAME,
  type PageDocumentRow,
  type PageRow,
  type Phase2Database,
} from "./database";

export type ProjectItemAnchorInput =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "page"; pageId: string }>
  | Readonly<{ kind: "element"; pageId: string; elementId: string }>;

export type ProjectStorageOptions = Readonly<{
  databaseName?: string;
  clock?: Readonly<{ now: () => string }>;
  ids?: Readonly<{ newReceiptId: () => ProjectItemReceiptId }>;
  failureHook?: (point: string) => void;
}>;

export type CreateProjectInput = Readonly<{
  projectId: ProjectId;
  name: string;
  createdBy: ProjectActor;
}>;

export type ResolveAgentWorkbookInput = Readonly<{
  projectId: ProjectId;
  workbookId: ProjectWorkbookId;
  title: string;
  subject: string;
  requestedBy: ProjectActor;
}>;

export type BindUserWorkbookInput = Readonly<{
  workbookId: ProjectWorkbookId;
  projectId: ProjectId;
}>;

export type CreateProjectAndBindUserWorkbookInput = Readonly<{
  workbookId: ProjectWorkbookId;
  projectId: ProjectId;
  name: string;
  createdBy: ProjectActor;
}>;

export type CreateProjectItemInput = Readonly<{
  id: ProjectItemId;
  projectId: ProjectId;
  workbookId: ProjectWorkbookId;
  kind: ProjectItemKind;
  title: string;
  status: ProjectItemStatus;
  anchor: ProjectItemAnchorInput;
  mutationId: ProjectMutationId;
  actor: ProjectActor;
  source: ProjectCommandSource;
}>;

export type UpdateProjectItemInput = Readonly<{
  id: ProjectItemId;
  expectedRevision: ProjectItemRevision;
  title: string;
  status: ProjectItemStatus;
  anchor: ProjectItemAnchorInput;
  mutationId: ProjectMutationId;
  actor: ProjectActor;
  source: ProjectCommandSource;
}>;

export type UndoProjectItemInput = Readonly<{
  receiptId: ProjectItemReceiptId;
  mutationId: ProjectMutationId;
  actor: ProjectActor;
  source: ProjectCommandSource;
}>;

export type ProjectItemCommandResult = Readonly<{
  status: "committed" | "duplicate";
  item: ProjectItem | null;
  receipt: ProjectItemReceipt;
}>;

export type ProjectItemWriteResult = Readonly<{
  status: "committed" | "duplicate";
  item: ProjectItem;
  receipt: ProjectItemReceipt;
}>;

export class ProjectStorageError extends Error {
  public constructor(
    public readonly code:
      | "not_found"
      | "conflict"
      | "stale"
      | "no_op"
      | "unsafe"
      | "invalid_target"
      | "mutation_reuse"
      | "already_undone"
      | "stale_undo",
    message: string,
  ) {
    super(message);
    this.name = "ProjectStorageError";
  }
}

function defaultId(): ProjectItemReceiptId {
  return createProjectItemReceiptId(
    `project-receipt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
}

function actorRow(actor: ProjectActor): Readonly<{ kind: "user" | "agent"; id: string }> {
  return { ...actor };
}

function anchorRow(anchor: ProjectItemAnchor): ProjectItemRow["anchor"] {
  return { ...anchor };
}

function documentRow(workbookId: ProjectWorkbookId, at: IsoInstant): Readonly<{
  document: PageDocumentRow;
  page: PageRow;
}> {
  const document = createEmptyPageDocument(createNotebookId(workbookId), at);
  const page = document.pages[0];
  if (page === undefined) throw new ProjectStorageError("unsafe", "An Agent Workbook must start with one page.");
  return {
    document: {
      workbookId,
      version: 1,
      documentRevision: document.documentRevision,
      pageOrder: [...document.pageOrder],
      updatedAt: at,
    },
    page: {
      id: page.id,
      workbookId,
      version: 1,
      number: page.number,
      revision: page.revision,
      size: { ...page.size },
      ...(page.paper === undefined ? {} : { paper: page.paper }),
      elements: [...page.elements],
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    },
  };
}

function sameRequest(left: ProjectItemReceiptRequestRow, right: ProjectItemReceiptRequestRow): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStoredItem(left: ProjectItem, right: ProjectItem): boolean {
  return JSON.stringify(itemToRow(left)) === JSON.stringify(itemToRow(right));
}

function normalizeText(value: string, label: string, maximum?: number): string {
  try {
    return validateProjectText(value, label, maximum);
  } catch (error: unknown) {
    throw new ProjectStorageError("unsafe", error instanceof Error ? error.message : `${label} is unsafe.`);
  }
}

function normalizeActor(actor: ProjectActor): ProjectActor {
  try {
    return createProjectActor(actor);
  } catch (error: unknown) {
    throw new ProjectStorageError("unsafe", error instanceof Error ? error.message : "Actor identity is unsafe.");
  }
}

function normalizeAnchor(anchor: ProjectItemAnchorInput): ProjectItemAnchor {
  try {
    return createProjectAnchor(anchor);
  } catch (error: unknown) {
    throw new ProjectStorageError("unsafe", error instanceof Error ? error.message : "Project item anchor is unsafe.");
  }
}

async function abortTransaction(transaction: Readonly<{ abort: () => void; done: Promise<unknown> }>): Promise<void> {
  try {
    transaction.abort();
  } catch {
  }
  try {
    await transaction.done;
  } catch {
  }
}

export class IndexedDbProjectStorage {
  private readonly databaseName: string;
  private readonly options: ProjectStorageOptions;
  private database: IDBPDatabase<Phase2Database> | null = null;

  public constructor(options: ProjectStorageOptions = {}) {
    this.options = options;
    this.databaseName = options.databaseName ?? PHASE0_DATABASE_NAME;
  }

  private async getDatabase(): Promise<IDBPDatabase<Phase2Database>> {
    this.database ??= await openPhase2Database(this.databaseName, this.options.failureHook);
    return this.database;
  }

  private now(): IsoInstant {
    try {
      return createIsoInstant(this.options.clock?.now() ?? new Date().toISOString());
    } catch (error: unknown) {
      throw new ProjectStorageError("unsafe", error instanceof Error ? error.message : "Clock returned an invalid instant.");
    }
  }

  private newReceiptId(): ProjectItemReceiptId {
    return this.options.ids?.newReceiptId() ?? defaultId();
  }

  public async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  public async createProject(input: CreateProjectInput): Promise<Project> {
    const instant = this.now();
    const project: Project = {
      version: 1,
      id: createProjectId(input.projectId),
      name: normalizeText(input.name, "Project name", 120),
      revision: createProjectItemRevision(1),
      createdBy: normalizeActor(input.createdBy),
      createdAt: instant,
      updatedAt: instant,
    };
    const database = await this.getDatabase();
    const transaction = database.transaction("projects", "readwrite");
    try {
      const existing = await transaction.store.get(project.id);
      if (existing !== undefined) {
        const parsed = parseProjectRow(existing);
        if (parsed.name === project.name) {
          await transaction.done;
          return parsed;
        }
        throw new ProjectStorageError("conflict", `Project ${project.id} already exists.`);
      }
      await transaction.store.add(projectToRow(project));
      await transaction.done;
      return project;
    } catch (error: unknown) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  public async getProject(projectId: ProjectId): Promise<Project | null> {
    const row = await (await this.getDatabase()).get("projects", projectId);
    return row === undefined ? null : parseProjectRow(row);
  }

  public async listProjects(): Promise<readonly Project[]> {
    const rows = await (await this.getDatabase()).getAll("projects");
    return rows.map(parseProjectRow).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  public async resolveAgentWorkbook(input: ResolveAgentWorkbookInput): Promise<WorkbookIdentity> {
    const actor = normalizeActor(input.requestedBy);
    if (actor.kind !== "agent") throw new ProjectStorageError("invalid_target", "Only an assigned agent can resolve an Agent Workbook.");
    const workbookId = createProjectWorkbookId(input.workbookId);
    const title = normalizeText(input.title, "Agent Workbook title", 120);
    const subject = normalizeText(input.subject, "Agent Workbook subject", 240);
    const instant = this.now();
    const database = await this.getDatabase();
    const existing = await database.getFromIndex("workbookIdentities", "byAgentProjectId", input.projectId);
    if (existing !== undefined) return parseWorkbookIdentityRow(existing);
    const notebook = createNotebook({ id: createNotebookId(workbookId), title, subject, createdAt: instant });
    const initialPage = documentRow(workbookId, instant);
    const identity: WorkbookIdentity = { version: 1, kind: "agent", workbookId, projectId: createProjectId(input.projectId), createdAt: instant };
    const transaction = database.transaction(["projects", "notebooks", "pageDocuments", "pages", "workbookIdentities"], "readwrite");
    try {
      const project = await transaction.objectStore("projects").get(input.projectId);
      if (project === undefined) throw new ProjectStorageError("not_found", `Project ${input.projectId} was not found.`);
      parseProjectRow(project);
      const concurrent = await transaction.objectStore("workbookIdentities").index("byAgentProjectId").get(input.projectId);
      if (concurrent !== undefined) {
        const resolved = parseWorkbookIdentityRow(concurrent);
        await transaction.done;
        return resolved;
      }
      if (await transaction.objectStore("notebooks").get(workbookId) !== undefined || await transaction.objectStore("workbookIdentities").get(workbookId) !== undefined) {
        throw new ProjectStorageError("conflict", `Workbook ${workbookId} is already in use.`);
      }
      await transaction.objectStore("notebooks").add(notebookToRow(notebook));
      this.options.failureHook?.("agent-workbook.after-notebook");
      await transaction.objectStore("pageDocuments").add(initialPage.document);
      await transaction.objectStore("pages").add(initialPage.page);
      this.options.failureHook?.("agent-workbook.after-page");
      await transaction.objectStore("workbookIdentities").add(identityToRow(identity));
      await transaction.done;
      return identity;
    } catch (error: unknown) {
      await abortTransaction(transaction);
      const converged = await database.getFromIndex("workbookIdentities", "byAgentProjectId", input.projectId);
      if (converged !== undefined) return parseWorkbookIdentityRow(converged);
      throw error;
    }
  }

  public async bindUserWorkbook(input: BindUserWorkbookInput): Promise<WorkbookIdentity> {
    const instant = this.now();
    const projectId = createProjectId(input.projectId);
    const identity: Extract<WorkbookIdentity, { kind: "user" }> = {
      version: 1,
      kind: "user",
      workbookId: createProjectWorkbookId(input.workbookId),
      projectId,
      createdAt: instant,
    };
    const database = await this.getDatabase();
    const transaction = database.transaction(["projects", "notebooks", "workbookIdentities"], "readwrite");
    try {
      if (await transaction.objectStore("projects").get(projectId) === undefined) {
        throw new ProjectStorageError("not_found", `Project ${projectId} was not found.`);
      }
      if (await transaction.objectStore("notebooks").get(identity.workbookId) === undefined) {
        throw new ProjectStorageError("not_found", `User workbook ${identity.workbookId} was not found.`);
      }
      const existing = await transaction.objectStore("workbookIdentities").get(identity.workbookId);
      if (existing !== undefined) {
        const parsed = parseWorkbookIdentityRow(existing);
        if (parsed.kind === "user" && parsed.projectId === identity.projectId) {
          await transaction.done;
          return parsed;
        }
        throw new ProjectStorageError("conflict", `Workbook ${identity.workbookId} already has a different identity.`);
      }
      await transaction.objectStore("workbookIdentities").add(identityToRow(identity));
      await transaction.done;
      return identity;
    } catch (error: unknown) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  public async createProjectAndBindUserWorkbook(input: CreateProjectAndBindUserWorkbookInput): Promise<Readonly<{ project: Project; identity: WorkbookIdentity }>> {
    const instant = this.now();
    const project: Project = {
      version: 1,
      id: createProjectId(input.projectId),
      name: normalizeText(input.name, "Project name", 120),
      revision: createProjectItemRevision(1),
      createdBy: normalizeActor(input.createdBy),
      createdAt: instant,
      updatedAt: instant,
    };
    const identity: Extract<WorkbookIdentity, { kind: "user" }> = {
      version: 1,
      kind: "user",
      workbookId: createProjectWorkbookId(input.workbookId),
      projectId: project.id,
      createdAt: instant,
    };
    const database = await this.getDatabase();
    const transaction = database.transaction(["projects", "notebooks", "workbookIdentities"], "readwrite");
    try {
      if (await transaction.objectStore("projects").get(project.id) !== undefined) {
        throw new ProjectStorageError("conflict", `Project ${project.id} already exists.`);
      }
      if (await transaction.objectStore("notebooks").get(identity.workbookId) === undefined) {
        throw new ProjectStorageError("not_found", `User workbook ${identity.workbookId} was not found.`);
      }
      if (await transaction.objectStore("workbookIdentities").get(identity.workbookId) !== undefined) {
        throw new ProjectStorageError("conflict", `Workbook ${identity.workbookId} already has an identity.`);
      }
      await transaction.objectStore("projects").add(projectToRow(project));
      this.options.failureHook?.("project-bind.after-project");
      await transaction.objectStore("workbookIdentities").add(identityToRow(identity));
      await transaction.done;
      return { project, identity };
    } catch (error: unknown) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  public async getWorkbookIdentity(workbookId: ProjectWorkbookId): Promise<WorkbookIdentity | null> {
    const row = await (await this.getDatabase()).get("workbookIdentities", workbookId);
    return row === undefined ? null : parseWorkbookIdentityRow(row);
  }

  public async listWorkbookIdentities(kind?: "user" | "agent"): Promise<readonly WorkbookIdentity[]> {
    const database = await this.getDatabase();
    const rows = kind === undefined
      ? await database.getAll("workbookIdentities")
      : await database.getAllFromIndex("workbookIdentities", "byShelfKind", kind);
    return rows.map(parseWorkbookIdentityRow).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.workbookId.localeCompare(right.workbookId));
  }

  public async createItem(input: CreateProjectItemInput): Promise<ProjectItemWriteResult> {
    const title = normalizeText(input.title, "Project item title");
    const actor = normalizeActor(input.actor);
    const anchor = normalizeAnchor(input.anchor);
    const request: ProjectItemReceiptRequestRow = {
      kind: "create", itemId: input.id, projectId: input.projectId, workbookId: input.workbookId,
      itemKind: input.kind, title, status: input.status, anchor: anchorRow(anchor), actor: actorRow(actor), source: input.source,
    };
    const database = await this.getDatabase();
    const transaction = database.transaction(["projects", "workbookIdentities", "pages", "projectItems", "projectItemReceipts"], "readwrite");
    try {
      const duplicate = await this.checkDuplicate(transaction.objectStore("projectItemReceipts"), input.mutationId, request);
      if (duplicate !== null) {
        const item = duplicate.afterItem;
        if (item === null) throw new ProjectStorageError("mutation_reuse", "The mutation id belongs to a non-create receipt.");
        await transaction.done;
        return { status: "duplicate", item, receipt: duplicate };
      }
      await this.requireRelationship(transaction, input.projectId, input.workbookId);
      await this.requireAnchor(transaction, input.workbookId, anchor);
      if (await transaction.objectStore("projectItems").get(input.id) !== undefined) {
        throw new ProjectStorageError("conflict", `Project item ${input.id} already exists.`);
      }
      const instant = this.now();
      const item: ProjectItem = {
        version: 1, id: createProjectItemId(input.id), projectId: createProjectId(input.projectId), workbookId: createProjectWorkbookId(input.workbookId),
        kind: input.kind, title, status: input.status, anchor, revision: createProjectItemRevision(1), authoredBy: actor,
        createdAt: instant, updatedAt: instant,
      };
      const receipt = this.createReceipt({ mutationId: input.mutationId, item, kind: "project_item_create", actor, source: input.source, beforeItem: null, afterItem: item, request, instant });
      await transaction.objectStore("projectItems").add(itemToRow(item));
      this.options.failureHook?.("project-item.after-item");
      await transaction.objectStore("projectItemReceipts").add(receipt.row);
      await transaction.done;
      return { status: "committed", item, receipt: receipt.domain };
    } catch (error: unknown) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  public async updateItem(input: UpdateProjectItemInput): Promise<ProjectItemWriteResult> {
    const title = normalizeText(input.title, "Project item title");
    const actor = normalizeActor(input.actor);
    const anchor = normalizeAnchor(input.anchor);
    const request: ProjectItemReceiptRequestRow = {
      kind: "update", itemId: input.id, expectedRevision: input.expectedRevision, title, status: input.status,
      anchor: anchorRow(anchor), actor: actorRow(actor), source: input.source,
    };
    const database = await this.getDatabase();
    const transaction = database.transaction(["projects", "workbookIdentities", "pages", "projectItems", "projectItemReceipts"], "readwrite");
    try {
      const duplicate = await this.checkDuplicate(transaction.objectStore("projectItemReceipts"), input.mutationId, request);
      if (duplicate !== null) {
        if (duplicate.afterItem === null) throw new ProjectStorageError("mutation_reuse", "The mutation id belongs to a non-update receipt.");
        await transaction.done;
        return { status: "duplicate", item: duplicate.afterItem, receipt: duplicate };
      }
      const stored = await transaction.objectStore("projectItems").get(input.id);
      if (stored === undefined) throw new ProjectStorageError("not_found", `Project item ${input.id} was not found.`);
      const current = parseProjectItemRow(stored);
      if (current.revision !== input.expectedRevision) throw new ProjectStorageError("stale", "Project item revision is stale.");
      await this.requireRelationship(transaction, current.projectId, current.workbookId);
      await this.requireAnchor(transaction, current.workbookId, anchor);
      if (current.title === title && current.status === input.status && sameProjectAnchor(current.anchor, anchor)) {
        throw new ProjectStorageError("no_op", "The project item update has no semantic change.");
      }
      const instant = this.now();
      const next: ProjectItem = {
        ...current, title, status: input.status, anchor,
        revision: createProjectItemRevision(current.revision + 1), updatedAt: instant,
      };
      const receipt = this.createReceipt({ mutationId: input.mutationId, item: next, kind: "project_item_update", actor, source: input.source, beforeItem: current, afterItem: next, request, instant });
      await transaction.objectStore("projectItems").put(itemToRow(next));
      this.options.failureHook?.("project-item.after-item");
      await transaction.objectStore("projectItemReceipts").add(receipt.row);
      await transaction.done;
      return { status: "committed", item: next, receipt: receipt.domain };
    } catch (error: unknown) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  public async undoItem(input: UndoProjectItemInput): Promise<ProjectItemCommandResult> {
    const actor = normalizeActor(input.actor);
    const request: ProjectItemReceiptRequestRow = { kind: "undo", receiptId: input.receiptId, actor: actorRow(actor), source: input.source };
    const database = await this.getDatabase();
    const transaction = database.transaction(["projectItems", "projectItemReceipts"], "readwrite");
    try {
      const duplicate = await this.checkDuplicate(transaction.objectStore("projectItemReceipts"), input.mutationId, request);
      if (duplicate !== null) {
        await transaction.done;
        return { status: "duplicate", item: duplicate.afterItem, receipt: duplicate };
      }
      const rawSource = await transaction.objectStore("projectItemReceipts").get(input.receiptId);
      if (rawSource === undefined) throw new ProjectStorageError("not_found", `Project item receipt ${input.receiptId} was not found.`);
      const source = parseProjectItemReceiptRow(rawSource);
      if (source.undo.kind === "consumed") throw new ProjectStorageError("already_undone", "The project item receipt was already undone.");
      if (source.undo.kind !== "available" || source.afterItem === null) throw new ProjectStorageError("stale_undo", "The project item receipt cannot be undone.");
      const existingUndo = await transaction.objectStore("projectItemReceipts").index("byUndoOf").get(input.receiptId);
      if (existingUndo !== undefined) throw new ProjectStorageError("already_undone", "The project item receipt was already undone.");
      const rawCurrent = await transaction.objectStore("projectItems").get(source.itemId);
      if (rawCurrent === undefined) throw new ProjectStorageError("stale_undo", "The project item no longer matches the receipt.");
      const current = parseProjectItemRow(rawCurrent);
      if (!sameStoredItem(current, source.afterItem)) throw new ProjectStorageError("stale_undo", "Newer project item work prevents this Undo.");
      const instant = this.now();
      const restored: ProjectItem | null = source.beforeItem === null
        ? null
        : {
            ...source.beforeItem,
            revision: createProjectItemRevision(current.revision + 1),
            updatedAt: instant,
          };
      const undoReceiptId = this.newReceiptId();
      const undoReceipt: ProjectItemReceipt = {
        version: 1, id: undoReceiptId, mutationId: createProjectMutationId(input.mutationId), projectId: source.projectId,
        workbookId: source.workbookId, itemId: source.itemId, kind: "project_item_undo", actor, source: input.source,
        completedAt: instant, beforeItem: current, afterItem: restored, undo: { kind: "unavailable" }, undoOf: source.id,
      };
      const undoRow: ProjectItemReceiptRow = {
        ...undoReceipt, actor: actorRow(actor), beforeItem: itemToRow(current), afterItem: restored === null ? null : itemToRow(restored),
        request, undo: { kind: "unavailable" }, undoOf: source.id,
      };
      const consumed: ProjectItemReceiptRow = { ...rawSource, undo: { kind: "consumed", by: undoReceiptId } };
      if (restored === null) await transaction.objectStore("projectItems").delete(current.id);
      else await transaction.objectStore("projectItems").put(itemToRow(restored));
      await transaction.objectStore("projectItemReceipts").put(consumed);
      this.options.failureHook?.("project-item.undo-receipt");
      await transaction.objectStore("projectItemReceipts").add(undoRow);
      await transaction.done;
      return { status: "committed", item: restored, receipt: undoReceipt };
    } catch (error: unknown) {
      await abortTransaction(transaction);
      throw error;
    }
  }

  public async getItem(id: ProjectItemId): Promise<ProjectItem | null> {
    const row = await (await this.getDatabase()).get("projectItems", id);
    return row === undefined ? null : parseProjectItemRow(row);
  }

  public async listItems(input: Readonly<{ projectId: ProjectId; workbookId: ProjectWorkbookId }>): Promise<readonly ProjectItem[]> {
    const rows = await (await this.getDatabase()).getAllFromIndex("projectItems", "byWorkbookId", input.workbookId);
    return rows.map(parseProjectItemRow).filter((item) => item.projectId === input.projectId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  public async listReceipts(itemId: ProjectItemId): Promise<readonly ProjectItemReceipt[]> {
    const rows = await (await this.getDatabase()).getAllFromIndex("projectItemReceipts", "byItemId", itemId);
    return rows.map(parseProjectItemReceiptRow).sort((left, right) => left.completedAt.localeCompare(right.completedAt) || left.id.localeCompare(right.id));
  }

  private async checkDuplicate(
    store: Readonly<{
      index: (name: "byMutationId") => Readonly<{
        get: (key: string | IDBKeyRange) => Promise<ProjectItemReceiptRow | undefined>;
      }>;
    }>,
    mutationId: ProjectMutationId,
    request: ProjectItemReceiptRequestRow,
  ): Promise<ProjectItemReceipt | null> {
    const existing = await store.index("byMutationId").get(mutationId);
    if (existing === undefined) return null;
    if (!sameRequest(existing.request, request)) throw new ProjectStorageError("mutation_reuse", "The mutation id was already used for a different project item request.");
    return parseProjectItemReceiptRow(existing);
  }

  private async requireRelationship(
    transaction: ReturnType<IDBPDatabase<Phase2Database>["transaction"]>,
    projectId: ProjectId,
    workbookId: ProjectWorkbookId,
  ): Promise<void> {
    const project = await transaction.objectStore("projects").get(projectId);
    if (project === undefined) throw new ProjectStorageError("invalid_target", `Project ${projectId} was not found.`);
    parseProjectRow(project);
    const row = await transaction.objectStore("workbookIdentities").get(workbookId);
    if (row === undefined) throw new ProjectStorageError("invalid_target", `Workbook ${workbookId} is not explicitly bound.`);
    const identity = parseWorkbookIdentityRow(row);
    if (identity.projectId !== projectId) throw new ProjectStorageError("invalid_target", "The workbook does not belong to the requested project.");
  }

  private async requireAnchor(
    transaction: ReturnType<IDBPDatabase<Phase2Database>["transaction"]>,
    workbookId: ProjectWorkbookId,
    anchor: ProjectItemAnchor,
  ): Promise<void> {
    if (anchor.kind === "none") return;
    const page = await transaction.objectStore("pages").get(anchor.pageId);
    if (page === undefined || page.workbookId !== workbookId) throw new ProjectStorageError("invalid_target", "The project item page anchor is missing or belongs to another workbook.");
    if (anchor.kind === "element") {
      const exists = Array.isArray(page.elements) && page.elements.some((element) => {
        return typeof element === "object" && element !== null && !Array.isArray(element) && "id" in element && element.id === anchor.elementId;
      });
      if (!exists) throw new ProjectStorageError("invalid_target", "The project item element anchor is missing from the exact page.");
    }
  }

  private createReceipt(input: Readonly<{
    mutationId: ProjectMutationId;
    item: ProjectItem;
    kind: "project_item_create" | "project_item_update";
    actor: ProjectActor;
    source: ProjectCommandSource;
    beforeItem: ProjectItem | null;
    afterItem: ProjectItem;
    request: ProjectItemReceiptRequestRow;
    instant: IsoInstant;
  }>): Readonly<{ domain: ProjectItemReceipt; row: ProjectItemReceiptRow }> {
    const domain: ProjectItemReceipt = {
      version: 1, id: this.newReceiptId(), mutationId: createProjectMutationId(input.mutationId), projectId: input.item.projectId,
      workbookId: input.item.workbookId, itemId: input.item.id, kind: input.kind, actor: input.actor, source: input.source,
      completedAt: input.instant, beforeItem: input.beforeItem, afterItem: input.afterItem, undo: { kind: "available" },
    };
    return {
      domain,
      row: {
        ...domain, actor: actorRow(input.actor), beforeItem: input.beforeItem === null ? null : itemToRow(input.beforeItem),
        afterItem: itemToRow(input.afterItem), request: input.request, undo: { kind: "available" },
      },
    };
  }
}

export function createIndexedDbProjectStorage(options: ProjectStorageOptions = {}): IndexedDbProjectStorage {
  return new IndexedDbProjectStorage(options);
}
