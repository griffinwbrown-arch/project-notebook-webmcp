import type { IDBPDatabase } from "idb";

import type { Phase2Database } from "./database";
import {
  openPhase2Database,
  PHASE0_DATABASE_NAME,
} from "./database";
import {
  BACKUP_DATABASE_VERSION,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  canonicalizeBackupValue,
  type BackupStores,
  type WorkspaceBackupV1,
  WorkspaceBackupValidationError,
  validateWorkspaceBackup,
} from "./backup-validation";

export type { WorkspaceBackupV1 } from "./backup-validation";

async function readStores(database: IDBPDatabase<Phase2Database>): Promise<BackupStores> {
  const [
    notebooks,
    canvasSnapshots,
    notes,
    receipts,
    notebookLifecycle,
    workspaceMetadata,
    pageDocuments,
    pages,
    pageReceipts,
    pageMigrations,
    projects,
    workbookIdentities,
    projectItems,
    projectItemReceipts,
    pageScraps,
  ] = await Promise.all([
    database.getAll("notebooks"),
    database.getAll("canvasSnapshots"),
    database.getAll("notes"),
    database.getAll("receipts"),
    database.getAll("notebookLifecycle"),
    database.getAll("workspaceMetadata"),
    database.getAll("pageDocuments"),
    database.getAll("pages"),
    database.getAll("pageReceipts"),
    database.getAll("pageMigrations"),
    database.getAll("projects"),
    database.getAll("workbookIdentities"),
    database.getAll("projectItems"),
    database.getAll("projectItemReceipts"),
    database.getAll("pageScraps"),
  ]);
  return {
    notebooks,
    canvasSnapshots,
    notes,
    receipts,
    notebookLifecycle,
    workspaceMetadata,
    pageDocuments,
    pages,
    pageReceipts,
    pageMigrations,
    projects,
    workbookIdentities,
    projectItems,
    projectItemReceipts,
    pageScraps,
  };
}

export async function createWorkspaceBackup(
  databaseName = PHASE0_DATABASE_NAME,
  exportedAt = new Date().toISOString(),
): Promise<WorkspaceBackupV1> {
  const database = await openPhase2Database(databaseName);
  try {
    return validateWorkspaceBackup({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      databaseVersion: BACKUP_DATABASE_VERSION,
      exportedAt,
      stores: await readStores(database),
    });
  } finally {
    database.close();
  }
}

export function parseWorkspaceBackup(value: unknown): WorkspaceBackupV1 {
  return validateWorkspaceBackup(value);
}

export function parseWorkspaceBackupJson(value: string): WorkspaceBackupV1 {
  try {
    return parseWorkspaceBackup(JSON.parse(value));
  } catch (error: unknown) {
    if (error instanceof WorkspaceBackupValidationError) throw error;
    throw new WorkspaceBackupValidationError("Backup JSON is malformed.");
  }
}

export function serializeWorkspaceBackup(backup: WorkspaceBackupV1): string {
  const validated = validateWorkspaceBackup(backup);
  try {
    return JSON.stringify(canonicalizeBackupValue(validated), null, 2);
  } catch {
    throw new WorkspaceBackupValidationError("Backup serialization failed.");
  }
}

export async function restoreWorkspaceBackup(
  value: unknown,
  databaseName = PHASE0_DATABASE_NAME,
): Promise<void> {
  const backup = parseWorkspaceBackup(value);
  const database = await openPhase2Database(databaseName);
  try {
    const transaction = database.transaction([
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
      "projects",
      "workbookIdentities",
      "projectItems",
      "projectItemReceipts",
      "pageScraps",
    ], "readwrite");
    try {
      for (const storeName of transaction.objectStoreNames) await transaction.objectStore(storeName).clear();
      for (const row of backup.stores.notebooks) await transaction.objectStore("notebooks").put(row);
      for (const row of backup.stores.canvasSnapshots) await transaction.objectStore("canvasSnapshots").put(row);
      for (const row of backup.stores.notes) await transaction.objectStore("notes").put(row);
      for (const row of backup.stores.receipts) await transaction.objectStore("receipts").put(row);
      for (const row of backup.stores.notebookLifecycle) await transaction.objectStore("notebookLifecycle").put(row);
      for (const row of backup.stores.workspaceMetadata) await transaction.objectStore("workspaceMetadata").put(row);
      for (const row of backup.stores.pageDocuments) await transaction.objectStore("pageDocuments").put(row);
      for (const row of backup.stores.pages) await transaction.objectStore("pages").put(row);
      for (const row of backup.stores.pageReceipts) await transaction.objectStore("pageReceipts").put(row);
      for (const row of backup.stores.pageMigrations) await transaction.objectStore("pageMigrations").put(row);
      for (const row of backup.stores.projects) await transaction.objectStore("projects").put(row);
      for (const row of backup.stores.workbookIdentities) await transaction.objectStore("workbookIdentities").put(row);
      for (const row of backup.stores.projectItems) await transaction.objectStore("projectItems").put(row);
      for (const row of backup.stores.projectItemReceipts) await transaction.objectStore("projectItemReceipts").put(row);
      for (const row of backup.stores.pageScraps) await transaction.objectStore("pageScraps").put(row);
      await transaction.done;
    } catch (error: unknown) {
      try { transaction.abort(); } catch { /* IndexedDB may already have aborted the transaction. */ }
      try { await transaction.done; } catch { /* Preserve the original restore failure. */ }
      throw error;
    }
  } finally {
    database.close();
  }
}
