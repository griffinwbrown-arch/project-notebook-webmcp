import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { z } from "zod";

import {
  createIsoInstant,
  createNotebookId,
  createRevision,
  validateNotebookSubject,
  validateNotebookTitle,
  type CanvasSnapshotEnvelope,
  type CanvasSnapshotStore,
  type JsonValue,
  type Notebook,
  type NotebookId,
  type NotebookRepository,
  type Revision,
  NotebookConflictError,
  NotebookNotFoundError,
} from "../domain";
import type {
  PageScrapRow,
  ProjectItemReceiptRow,
  ProjectItemRow,
  ProjectRow,
  WorkbookIdentityRow,
} from "../projects/rows";
export type {
  PageScrapAssetReferenceRow,
  PageScrapRow,
  ProjectItemReceiptRow,
  ProjectItemRow,
  ProjectRow,
  WorkbookIdentityRow,
} from "../projects/rows";

export const PHASE0_DATABASE_NAME = "project-notebook-phase0-v1";
export const PHASE0_DATABASE_VERSION = 4;

export type NotebookRow = {
  readonly id: string;
  readonly title: string;
  readonly subject: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CanvasSnapshotRow = {
  readonly notebookId: string;
  readonly version: 1;
  readonly savedAt: string;
  readonly snapshot: JsonValue;
};

export type NoteRow = {
  readonly id: string;
  readonly targetNotebookId: string;
  readonly revision: number;
  readonly contentVersion: 1;
  readonly content: Readonly<{ format: "plain_text"; text: string }>;
  readonly lifecycle: "active" | "trashed";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ReceiptRow = Readonly<{
  id: string;
  kind: string;
  source: "person" | "assistant";
  completedAt: string;
  undo: Readonly<Record<string, unknown>>;
  undoOf?: string;
  [key: string]: unknown;
}>;

export type NotebookLifecycleRow = {
  readonly notebookId: string;
  readonly lifecycle: "active" | "trashed";
  readonly revision: number;
  readonly updatedAt: string;
};

export type WorkspaceMetadataRow = {
  readonly id: "workspace";
  readonly version: 1;
  readonly inboxNotebookId: NotebookId;
  readonly currentTargetNotebookId: NotebookId;
  readonly revision: Revision;
  readonly updatedAt: import("../domain").IsoInstant;
};

export type PageDocumentRow = {
  readonly workbookId: string;
  readonly version: 1;
  readonly documentRevision: number;
  readonly pageOrder: readonly string[];
  readonly updatedAt: string;
};

export type PageRow = {
  readonly id: string;
  readonly workbookId: string;
  readonly version: 1;
  readonly number: number;
  readonly revision: number;
  readonly size: Readonly<{ width: number; height: number }>;
  readonly paper?: "lined" | "grid" | "blank";
  readonly elements: readonly unknown[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PageReceiptRow = {
  readonly id: string;
  readonly workbookId: string;
  readonly mutationId: string;
  readonly actorId: string;
  readonly source: "person" | "assistant";
  readonly kind: string;
  readonly completedAt: string;
  readonly fingerprint: string;
  readonly beforeDocument: PageDocumentRow;
  readonly beforePages: readonly PageRow[];
  readonly affectedPageIds: readonly string[];
  readonly resultingDocumentRevision: number;
  readonly resultingPageRevisions: Readonly<Record<string, number>>;
  readonly undo: Readonly<Record<string, unknown>>;
};

export type PageWriterClaimRow = {
  readonly pageId: string;
  readonly workbookId: string;
  readonly actorId: string;
  readonly claimId: string;
  readonly expiresAt: string;
  readonly acquiredAt: string;
};

export type PageMigrationRow = {
  readonly id: string;
  readonly workbookId: string;
  readonly version: 1;
  readonly status: "complete";
  readonly completedAt: string;
  readonly migratedNoteIds: readonly string[];
  readonly migratedCanvas: boolean;
  readonly issues: readonly Readonly<{
    kind: "malformed_note" | "malformed_canvas";
    id: string;
    message: string;
  }>[];
};

export interface Phase2Database extends DBSchema {
  notebooks: { key: string; value: NotebookRow };
  canvasSnapshots: { key: string; value: CanvasSnapshotRow };
  notes: {
    key: string;
    value: NoteRow;
    indexes: {
      byNotebookLifecycleCreatedAtId: [string, string, string, string];
    };
  };
  receipts: {
    key: string;
    value: ReceiptRow;
    indexes: { byCompletedAt: string; byUndoOf: string };
  };
  notebookLifecycle: { key: string; value: NotebookLifecycleRow };
  workspaceMetadata: { key: string; value: WorkspaceMetadataRow };
  pageDocuments: {
    key: string;
    value: PageDocumentRow;
    indexes: { byUpdatedAt: string };
  };
  pages: {
    key: string;
    value: PageRow;
    indexes: { byWorkbookId: string; byWorkbookNumber: [string, number] };
  };
  pageReceipts: {
    key: string;
    value: PageReceiptRow;
    indexes: { byWorkbookId: string; byMutationId: string; byCompletedAt: string };
  };
  pageWriterClaims: {
    key: string;
    value: PageWriterClaimRow;
    indexes: { byWorkbookId: string; byExpiresAt: string };
  };
  pageMigrations: {
    key: string;
    value: PageMigrationRow;
    indexes: { byWorkbookId: string };
  };
  projects: { key: string; value: ProjectRow };
  workbookIdentities: {
    key: string;
    value: WorkbookIdentityRow;
    indexes: {
      byShelfKind: "user" | "agent";
      byProjectId: string;
      byAgentProjectId: string;
    };
  };
  projectItems: {
    key: string;
    value: ProjectItemRow;
    indexes: {
      byProjectId: string;
      byWorkbookId: string;
      byKind: "task" | "milestone" | "decision";
      byStatus: "open" | "in_progress" | "blocked" | "done" | "superseded";
    };
  };
  projectItemReceipts: {
    key: string;
    value: ProjectItemReceiptRow;
    indexes: {
      byItemId: string;
      byMutationId: string;
      byCompletedAt: string;
      byUndoOf: string;
    };
  };
  pageScraps: {
    key: string;
    value: PageScrapRow;
    indexes: {
      byWorkbookId: string;
      byCapturedAt: string;
      byWorkbookCapturedAt: [string, string];
    };
  };
}

export type UpgradeFailureHook = (point: string) => void;

const NotebookRowSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    subject: z.string(),
    revision: z.number(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

const CanvasSnapshotRowSchema = z
  .object({
    notebookId: z.string(),
    version: z.literal(1),
    savedAt: z.string(),
    snapshot: z.json(),
  })
  .strict();

function requireLegacyStores(database: IDBPDatabase<Phase2Database>): void {
  if (
    !database.objectStoreNames.contains("notebooks") ||
    !database.objectStoreNames.contains("canvasSnapshots")
  ) {
    throw new Error("The Phase 1 database is missing a required legacy store.");
  }
}

function requirePhase3Stores(database: IDBPDatabase<Phase2Database>): void {
  const required = [
    "notebooks",
    "canvasSnapshots",
    "notes",
    "receipts",
    "notebookLifecycle",
    "workspaceMetadata",
    "pageDocuments",
    "pages",
    "pageReceipts",
    "pageWriterClaims",
    "pageMigrations",
  ] as const;
  const missing = required.filter((storeName) => !database.objectStoreNames.contains(storeName));
  if (missing.length > 0) {
    throw new Error(`The version 3 database is missing required stores: ${missing.join(", ")}.`);
  }
}

function createAdditiveStores(
  database: IDBPDatabase<Phase2Database>,
  failureHook?: UpgradeFailureHook,
): void {
  if (!database.objectStoreNames.contains("notes")) {
    const notes = database.createObjectStore("notes", { keyPath: "id" });
    failureHook?.("upgrade.notes-store");
    notes.createIndex(
      "byNotebookLifecycleCreatedAtId",
      ["targetNotebookId", "lifecycle", "createdAt", "id"],
    );
    failureHook?.("upgrade.notes-index");
  }
  if (!database.objectStoreNames.contains("receipts")) {
    const receipts = database.createObjectStore("receipts", { keyPath: "id" });
    failureHook?.("upgrade.receipts-store");
    receipts.createIndex("byCompletedAt", "completedAt");
    failureHook?.("upgrade.receipts-completed-index");
    receipts.createIndex("byUndoOf", "undoOf", { unique: true });
    failureHook?.("upgrade.receipts-undo-index");
  }
  if (!database.objectStoreNames.contains("notebookLifecycle")) {
    database.createObjectStore("notebookLifecycle", { keyPath: "notebookId" });
    failureHook?.("upgrade.lifecycle-store");
  }
  if (!database.objectStoreNames.contains("workspaceMetadata")) {
    database.createObjectStore("workspaceMetadata", { keyPath: "id" });
    failureHook?.("upgrade.metadata-store");
  }
}

function createPhase3Stores(
  database: IDBPDatabase<Phase2Database>,
  failureHook?: UpgradeFailureHook,
): void {
  if (!database.objectStoreNames.contains("pageDocuments")) {
    const documents = database.createObjectStore("pageDocuments", { keyPath: "workbookId" });
    failureHook?.("upgrade.pageDocuments-store");
    documents.createIndex("byUpdatedAt", "updatedAt");
    failureHook?.("upgrade.pageDocuments-index");
  }
  if (!database.objectStoreNames.contains("pages")) {
    const pages = database.createObjectStore("pages", { keyPath: "id" });
    failureHook?.("upgrade.pages-store");
    pages.createIndex("byWorkbookId", "workbookId");
    failureHook?.("upgrade.pages-workbook-index");
    pages.createIndex("byWorkbookNumber", ["workbookId", "number"]);
    failureHook?.("upgrade.pages-number-index");
  }
  if (!database.objectStoreNames.contains("pageReceipts")) {
    const receipts = database.createObjectStore("pageReceipts", { keyPath: "id" });
    failureHook?.("upgrade.pageReceipts-store");
    receipts.createIndex("byWorkbookId", "workbookId");
    failureHook?.("upgrade.pageReceipts-workbook-index");
    receipts.createIndex("byMutationId", "mutationId", { unique: true });
    failureHook?.("upgrade.pageReceipts-mutation-index");
    receipts.createIndex("byCompletedAt", "completedAt");
    failureHook?.("upgrade.pageReceipts-completed-index");
  }
  if (!database.objectStoreNames.contains("pageWriterClaims")) {
    const claims = database.createObjectStore("pageWriterClaims", { keyPath: "pageId" });
    failureHook?.("upgrade.pageWriterClaims-store");
    claims.createIndex("byWorkbookId", "workbookId");
    failureHook?.("upgrade.pageWriterClaims-workbook-index");
    claims.createIndex("byExpiresAt", "expiresAt");
    failureHook?.("upgrade.pageWriterClaims-expiry-index");
  }
  if (!database.objectStoreNames.contains("pageMigrations")) {
    const migrations = database.createObjectStore("pageMigrations", { keyPath: "id" });
    failureHook?.("upgrade.pageMigrations-store");
    migrations.createIndex("byWorkbookId", "workbookId", { unique: true });
    failureHook?.("upgrade.pageMigrations-workbook-index");
  }
}

function createPhase11Stores(
  database: IDBPDatabase<Phase2Database>,
  failureHook?: UpgradeFailureHook,
): void {
  if (!database.objectStoreNames.contains("projects")) {
    database.createObjectStore("projects", { keyPath: "id" });
    failureHook?.("upgrade.projects-store");
  }
  if (!database.objectStoreNames.contains("workbookIdentities")) {
    const identities = database.createObjectStore("workbookIdentities", { keyPath: "workbookId" });
    failureHook?.("upgrade.workbookIdentities-store");
    identities.createIndex("byShelfKind", "shelfKind");
    identities.createIndex("byProjectId", "projectId");
    identities.createIndex("byAgentProjectId", "agentProjectId", { unique: true });
    failureHook?.("upgrade.workbookIdentities-indexes");
  }
  if (!database.objectStoreNames.contains("projectItems")) {
    const items = database.createObjectStore("projectItems", { keyPath: "id" });
    failureHook?.("upgrade.projectItems-store");
    items.createIndex("byProjectId", "projectId");
    items.createIndex("byWorkbookId", "workbookId");
    items.createIndex("byKind", "kind");
    items.createIndex("byStatus", "status");
    failureHook?.("upgrade.projectItems-indexes");
  }
  if (!database.objectStoreNames.contains("projectItemReceipts")) {
    const receipts = database.createObjectStore("projectItemReceipts", { keyPath: "id" });
    failureHook?.("upgrade.projectItemReceipts-store");
    receipts.createIndex("byItemId", "itemId");
    receipts.createIndex("byMutationId", "mutationId", { unique: true });
    receipts.createIndex("byCompletedAt", "completedAt");
    receipts.createIndex("byUndoOf", "undoOf", { unique: true });
    failureHook?.("upgrade.projectItemReceipts-indexes");
  }
  if (!database.objectStoreNames.contains("pageScraps")) {
    const scraps = database.createObjectStore("pageScraps", { keyPath: "id" });
    failureHook?.("upgrade.pageScraps-store");
    scraps.createIndex("byWorkbookId", "workbookId");
    scraps.createIndex("byCapturedAt", "capturedAt");
    scraps.createIndex("byWorkbookCapturedAt", ["workbookId", "capturedAt"]);
    failureHook?.("upgrade.pageScraps-indexes");
  }
}

export async function openPhase2Database(
  databaseName = PHASE0_DATABASE_NAME,
  failureHook?: UpgradeFailureHook,
): Promise<IDBPDatabase<Phase2Database>> {
  let upgradeFailure: unknown;
  let openedDatabase: IDBPDatabase<Phase2Database> | null = null;
  let blocked = false;
  let rejectBlocked: (error: Error) => void = () => undefined;
  const blockedPromise = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject;
  });
  const opening = openDB<Phase2Database>(databaseName, PHASE0_DATABASE_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      try {
        if (oldVersion === 0) {
          database.createObjectStore("notebooks", { keyPath: "id" });
          database.createObjectStore("canvasSnapshots", { keyPath: "notebookId" });
        } else if (oldVersion === 1) {
          requireLegacyStores(database);
        } else if (oldVersion === 2) {
          requireLegacyStores(database);
        } else if (oldVersion === 3) {
          requirePhase3Stores(database);
        } else {
          throw new Error(`Unsupported database upgrade from version ${oldVersion}.`);
        }
        if (oldVersion < 3) {
          createAdditiveStores(database, failureHook);
          createPhase3Stores(database, failureHook);
        }
        createPhase11Stores(database, failureHook);
      } catch (error: unknown) {
        upgradeFailure = error;
        void transaction.done.catch(() => undefined);
        transaction.abort();
      }
    },
    blocked() {
      blocked = true;
      rejectBlocked(
        new Error(
          "The local database upgrade is blocked by another open Project Notebook tab.",
        ),
      );
    },
    blocking() {
      openedDatabase?.close();
    },
  });
  const trackedOpening = opening.then((database) => {
    if (blocked) {
      database.close();
      throw new Error("The blocked database open was superseded.");
    }
    openedDatabase = database;
    return database;
  });
  try {
    return await Promise.race([trackedOpening, blockedPromise]);
  } catch (error: unknown) {
    if (blocked) {
      void trackedOpening.catch(() => undefined);
    }
    throw upgradeFailure ?? error;
  }
}

export function parseNotebookRow(value: unknown): Notebook {
  const row = NotebookRowSchema.parse(value);
  return {
    id: createNotebookId(row.id),
    title: validateNotebookTitle(row.title),
    subject: validateNotebookSubject(row.subject),
    revision: createRevision(row.revision),
    createdAt: createIsoInstant(row.createdAt),
    updatedAt: createIsoInstant(row.updatedAt),
  };
}

export function notebookToRow(notebook: Notebook): NotebookRow {
  return {
    id: notebook.id,
    title: notebook.title,
    subject: notebook.subject,
    revision: notebook.revision,
    createdAt: notebook.createdAt,
    updatedAt: notebook.updatedAt,
  };
}

function parseCanvasSnapshotRow(value: unknown): CanvasSnapshotEnvelope {
  const row = CanvasSnapshotRowSchema.parse(value);
  return {
    version: 1,
    notebookId: createNotebookId(row.notebookId),
    savedAt: createIsoInstant(row.savedAt),
    snapshot: row.snapshot,
  };
}

function canvasSnapshotToRow(snapshot: CanvasSnapshotEnvelope): CanvasSnapshotRow {
  return {
    notebookId: snapshot.notebookId,
    version: 1,
    savedAt: snapshot.savedAt,
    snapshot: snapshot.snapshot,
  };
}

export class IndexedDbNotebookRepository implements NotebookRepository {
  private database: IDBPDatabase<Phase2Database> | null = null;

  private async getDatabase(): Promise<IDBPDatabase<Phase2Database>> {
    this.database ??= await openPhase2Database();
    return this.database;
  }

  public async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  public async create(notebook: Notebook): Promise<Notebook> {
    const database = await this.getDatabase();
    const transaction = database.transaction("notebooks", "readwrite");
    const existing = await transaction.store.get(notebook.id);
    if (existing !== undefined) {
      const current = parseNotebookRow(existing);
      throw new NotebookConflictError(notebook.id, notebook.revision, current.revision);
    }
    await transaction.store.add(notebookToRow(notebook));
    await transaction.done;
    return notebook;
  }

  public async get(id: NotebookId): Promise<Notebook | null> {
    const database = await this.getDatabase();
    const value = await database.get("notebooks", id);
    return value === undefined ? null : parseNotebookRow(value);
  }

  public async list(): Promise<Notebook[]> {
    const database = await this.getDatabase();
    const values = await database.getAll("notebooks");
    return values
      .map(parseNotebookRow)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public async update(notebook: Notebook, expectedRevision?: Revision): Promise<Notebook> {
    const database = await this.getDatabase();
    const transaction = database.transaction("notebooks", "readwrite");
    const stored = await transaction.store.get(notebook.id);
    if (stored === undefined) {
      throw new NotebookNotFoundError(notebook.id);
    }
    const current = parseNotebookRow(stored);
    const expected = expectedRevision ?? createRevision(notebook.revision - 1);
    if (
      current.revision !== expected ||
      notebook.revision !== createRevision(current.revision + 1)
    ) {
      throw new NotebookConflictError(notebook.id, expected, current.revision);
    }
    await transaction.store.put(notebookToRow(notebook));
    await transaction.done;
    return notebook;
  }
}

export class IndexedDbCanvasSnapshotStore implements CanvasSnapshotStore {
  private database: IDBPDatabase<Phase2Database> | null = null;

  private async getDatabase(): Promise<IDBPDatabase<Phase2Database>> {
    this.database ??= await openPhase2Database();
    return this.database;
  }

  public async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  public async save(snapshot: CanvasSnapshotEnvelope): Promise<CanvasSnapshotEnvelope> {
    const database = await this.getDatabase();
    const validated = parseCanvasSnapshotRow(canvasSnapshotToRow(snapshot));
    await database.put("canvasSnapshots", canvasSnapshotToRow(validated));
    return validated;
  }

  public async get(notebookId: NotebookId): Promise<CanvasSnapshotEnvelope | null> {
    const database = await this.getDatabase();
    const value = await database.get("canvasSnapshots", notebookId);
    return value === undefined ? null : parseCanvasSnapshotRow(value);
  }
}

export function createIndexedDbNotebookRepository(): IndexedDbNotebookRepository {
  return new IndexedDbNotebookRepository();
}

export function createIndexedDbCanvasSnapshotStore(): IndexedDbCanvasSnapshotStore {
  return new IndexedDbCanvasSnapshotStore();
}
