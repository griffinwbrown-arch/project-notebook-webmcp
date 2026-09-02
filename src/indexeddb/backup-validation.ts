import { z } from "zod";

import {
  createIsoInstant,
  createNotebookId,
  parseNote,
  parseReceipt,
  createRevision,
} from "../domain";
import {
  parseNotebookRow,
  type NoteRow,
  type NotebookRow,
  type PageDocumentRow,
  type PageReceiptRow,
  type PageRow,
  type WorkspaceMetadataRow,
} from "./database";
import {
  createDocumentRevision,
  createPageId,
  createPageRevision,
  parsePageElements,
  validatePage,
  validatePageDocument,
  type PageDocument,
  type PageRecord,
} from "../page";
import {
  parsePageScrapRow,
  parseProjectItemReceiptRow,
  parseProjectItemRow,
  parseProjectRow,
  parseWorkbookIdentityRow,
  type PageScrapRow,
  type ProjectItemReceiptRow,
  type ProjectItemRow,
  type ProjectRow,
  type WorkbookIdentityRow,
} from "../projects/rows";
import { createBackupSchema } from "./backup-validation-schemas";
import type {
  BackupStores,
  RawBackup,
  RawLegacyReceipt,
  RawPageRow,
  RawStores,
  WorkspaceBackupV1,
} from "./backup-validation-schemas";

export { BACKUP_DATABASE_VERSION, BACKUP_FORMAT, BACKUP_VERSION } from "./backup-validation-schemas";
export type { BackupStores, WorkspaceBackupV1 } from "./backup-validation-schemas";

export class WorkspaceBackupValidationError extends Error {
  public constructor(message: string) {
    super(message.slice(0, 512));
    this.name = "WorkspaceBackupValidationError";
  }
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof WorkspaceBackupValidationError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "schema validation failed";
  return error instanceof Error ? error.message : "validation failed";
}

function checked<T>(label: string, parse: () => T): T {
  try {
    return parse();
  } catch (error: unknown) {
    throw new WorkspaceBackupValidationError(`${label}: ${errorMessage(error)}`);
  }
}

function parseEnvelope(value: unknown): RawBackup {
  try {
    rejectUndefined(value);
  } catch (error: unknown) {
    if (error instanceof WorkspaceBackupValidationError) throw error;
    throw new WorkspaceBackupValidationError("Backup is malformed.");
  }
  let result: ReturnType<ReturnType<typeof createBackupSchema>["safeParse"]>;
  try {
    result = createBackupSchema().safeParse(value);
  } catch {
    throw new WorkspaceBackupValidationError("Backup is malformed.");
  }
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new WorkspaceBackupValidationError(`Backup${path}: ${issue?.message ?? "is malformed."}`);
  }
  return result.data;
}

function rejectUndefined(value: unknown, path = "Backup", seen = new Set<object>()): void {
  if (value === undefined) throw new WorkspaceBackupValidationError(`${path} contains an undefined value.`);
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) throw new WorkspaceBackupValidationError(`${path} contains a cyclic value.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUndefined(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) rejectUndefined(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function uniqueMap<Row>(rows: readonly Row[], key: (row: Row) => string, label: string): Map<string, Row> {
  const result = new Map<string, Row>();
  for (const row of rows) {
    const value = key(row);
    if (result.has(value)) throw new WorkspaceBackupValidationError(`${label} contains duplicate key ${value}.`);
    result.set(value, row);
  }
  return result;
}

function sortRows<Row>(rows: readonly Row[], key: (row: Row) => string): Row[] {
  return [...rows].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function assertReference(condition: boolean, message: string): void {
  if (!condition) throw new WorkspaceBackupValidationError(message);
}

export function canonicalizeBackupValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeBackupValue);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeBackupValue(value[key])]));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeBackupValue(left)) === JSON.stringify(canonicalizeBackupValue(right));
}

function pageFromRow(row: RawPageRow): PageRecord {
  return checked(`Page ${row.id}`, () => validatePage({
    version: 1,
    id: createPageId(row.id),
    workbookId: createNotebookId(row.workbookId),
    number: row.number,
    revision: createPageRevision(row.revision),
    size: { ...row.size },
    ...(row.paper === undefined ? {} : { paper: row.paper }),
    elements: parsePageElements(row.elements),
    createdAt: createIsoInstant(row.createdAt),
    updatedAt: createIsoInstant(row.updatedAt),
  }));
}

function normalizePageRow(row: RawPageRow): PageRow {
  return {
    id: row.id,
    workbookId: row.workbookId,
    version: 1,
    number: row.number,
    revision: row.revision,
    size: { ...row.size },
    ...(row.paper === undefined ? {} : { paper: row.paper }),
    elements: [...row.elements],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizePageDocumentRow(row: RawBackup["stores"]["pageDocuments"][number]): PageDocumentRow {
  return {
    workbookId: row.workbookId,
    version: 1,
    documentRevision: row.documentRevision,
    pageOrder: [...row.pageOrder],
    updatedAt: row.updatedAt,
  };
}

function normalizePageReceiptRow(row: RawBackup["stores"]["pageReceipts"][number]): PageReceiptRow {
  return {
    id: row.id,
    workbookId: row.workbookId,
    mutationId: row.mutationId,
    actorId: row.actorId,
    source: row.source,
    kind: row.kind,
    completedAt: row.completedAt,
    fingerprint: row.fingerprint,
    beforeDocument: normalizePageDocumentRow(row.beforeDocument),
    beforePages: row.beforePages.map(normalizePageRow),
    affectedPageIds: [...row.affectedPageIds],
    resultingDocumentRevision: row.resultingDocumentRevision,
    resultingPageRevisions: { ...row.resultingPageRevisions },
    undo: row.undo.kind === "consumed"
      ? { kind: "consumed", by: row.undo.by }
      : row.undo.kind === "available" ? { kind: "available" } : { kind: "unavailable" },
  };
}

function normalizeProjectItemReceiptRow(row: RawBackup["stores"]["projectItemReceipts"][number]): ProjectItemReceiptRow {
  return {
    version: 1,
    id: row.id,
    mutationId: row.mutationId,
    projectId: row.projectId,
    workbookId: row.workbookId,
    itemId: row.itemId,
    kind: row.kind,
    actor: { ...row.actor },
    source: row.source,
    completedAt: row.completedAt,
    beforeItem: row.beforeItem,
    afterItem: row.afterItem,
    request: row.request,
    undo: row.undo,
    ...(row.undoOf === undefined ? {} : { undoOf: row.undoOf }),
  };
}

function normalizePageScrapRow(row: RawBackup["stores"]["pageScraps"][number]): PageScrapRow {
  return {
    version: 1,
    id: row.id,
    workbookId: row.workbookId,
    reason: row.reason,
    capturedBy: { ...row.capturedBy },
    capturedAt: row.capturedAt,
    beforeDocument: normalizePageDocumentRow(row.beforeDocument),
    beforePages: row.beforePages.map(normalizePageRow),
    assetReferences: row.assetReferences.map((reference) => ({ ...reference })),
    resultingDocumentRevision: row.resultingDocumentRevision,
    resultingPageOrder: [...row.resultingPageOrder],
    resultingPageRevisions: { ...row.resultingPageRevisions },
    reworkReceiptId: row.reworkReceiptId,
  };
}

function documentFromRows(row: PageDocumentRow, pages: readonly PageRecord[]): PageDocument {
  return checked(`Document ${row.workbookId}`, () => {
    if (pages.length !== row.pageOrder.length || new Set(pages.map((page) => page.id)).size !== pages.length) {
      throw new WorkspaceBackupValidationError(`Document ${row.workbookId} does not contain exactly one row for each ordered page.`);
    }
    const byId = new Map(pages.map((page) => [page.id, page]));
    const pageOrder = row.pageOrder.map((id) => createPageId(id));
    const ordered = pageOrder.map((id) => {
      const page = byId.get(id);
      if (page === undefined) throw new WorkspaceBackupValidationError(`Page ${id} is missing.`);
      return page;
    });
    return validatePageDocument({
      version: 1,
      workbookId: createNotebookId(row.workbookId),
      documentRevision: createDocumentRevision(row.documentRevision),
      pageOrder,
      pages: ordered,
    });
  });
}

function validateLegacyReceiptRelationships(
  rows: readonly RawLegacyReceipt[],
  notebooks: ReadonlyMap<string, NotebookRow>,
  notes: ReadonlyMap<string, NoteRow>,
): void {
  const byId = uniqueMap(rows, (row) => row.id, "receipts");
  const undoOf = new Set<string>();
  for (const row of rows) {
    const receipt = checked(`Receipt ${row.id}`, () => parseReceipt(row));
    if (row.undo.kind === "consumed") {
      const undoReceipt = byId.get(row.undo.by);
      assertReference(undoReceipt !== undefined && undoReceipt.kind === "undo", `Receipt ${row.id} points to a missing undo receipt.`);
    }
    if (row.kind === "undo") {
      const source = byId.get(row.undoOf);
      assertReference(source !== undefined && source.kind !== "undo", `Undo receipt ${row.id} points to a missing source receipt.`);
      assertReference(source?.undo.kind === "consumed" && source.undo.by === row.id, `Undo receipt ${row.id} is not linked from its source receipt.`);
      assertReference(row.undo.kind === "unavailable", `Undo receipt ${row.id} must be final.`);
      assertReference(notes.has(row.affectedId) || notebooks.has(row.affectedId), `Undo receipt ${row.id} references a missing affected object.`);
      if (source !== undefined) {
        const sourceReceipt = checked(`Receipt ${source.id}`, () => parseReceipt(source));
        switch (sourceReceipt.kind) {
          case "capture_note":
          case "move_note":
          case "trash_note":
          case "restore_note":
            assertReference(row.affectedId === sourceReceipt.noteId && row.resultingRevision === sourceReceipt.resultingRevision + 1, `Undo receipt ${row.id} has an invalid note transition.`);
            break;
          case "trash_notebook":
          case "restore_notebook":
            assertReference(row.affectedId === sourceReceipt.notebookId && row.resultingRevision === sourceReceipt.resultingRevision + 1, `Undo receipt ${row.id} has an invalid notebook transition.`);
            break;
          case "undo":
            throw new WorkspaceBackupValidationError(`Undo receipt ${row.id} points to another undo receipt.`);
        }
      }
      undoOf.add(row.undoOf);
    }
    switch (receipt.kind) {
      case "capture_note":
        assertReference(notes.has(receipt.noteId), `Receipt ${row.id} references a missing note.`);
        assertReference(notebooks.has(receipt.targetNotebookId), `Receipt ${row.id} references a missing notebook.`);
        assertReference(row.undo.kind === "available" ? row.undo.effect === "withdraw_capture" : true, `Receipt ${row.id} has an invalid undo effect.`);
        break;
      case "move_note":
        assertReference(notes.has(receipt.noteId), `Receipt ${row.id} references a missing note.`);
        assertReference(notebooks.has(receipt.fromNotebookId) && notebooks.has(receipt.toNotebookId), `Receipt ${row.id} references a missing notebook.`);
        assertReference(row.undo.kind === "available" ? row.undo.effect === "move_back" : true, `Receipt ${row.id} has an invalid undo effect.`);
        break;
      case "trash_note":
      case "restore_note":
        assertReference(notes.has(receipt.noteId), `Receipt ${row.id} references a missing note.`);
        assertReference(receipt.kind === "trash_note" ? receipt.priorLifecycle === "active" && receipt.resultingLifecycle === "trashed" : receipt.priorLifecycle === "trashed" && receipt.resultingLifecycle === "active", `Receipt ${row.id} has an invalid lifecycle transition.`);
        assertReference(row.undo.kind === "available" ? row.undo.effect === (receipt.kind === "trash_note" ? "restore_note" : "trash_note") : true, `Receipt ${row.id} has an invalid undo effect.`);
        break;
      case "trash_notebook":
      case "restore_notebook":
        assertReference(notebooks.has(receipt.notebookId), `Receipt ${row.id} references a missing notebook.`);
        assertReference(receipt.kind === "trash_notebook" ? receipt.priorLifecycle === "active" && receipt.resultingLifecycle === "trashed" : receipt.priorLifecycle === "trashed" && receipt.resultingLifecycle === "active", `Receipt ${row.id} has an invalid lifecycle transition.`);
        assertReference(receipt.kind !== "trash_notebook" || receipt.notebookId !== "inbox", `Receipt ${row.id} cannot trash Inbox.`);
        assertReference(row.undo.kind === "available" ? row.undo.effect === (receipt.kind === "trash_notebook" ? "restore_notebook" : "trash_notebook") : true, `Receipt ${row.id} has an invalid undo effect.`);
        if (row.kind === "trash_notebook" || row.kind === "restore_notebook") {
          assertReference((row.priorCurrentTargetNotebookId === undefined) === (row.resultingWorkspaceRevision === undefined), `Receipt ${row.id} has incomplete workspace metadata undo state.`);
          if (row.priorCurrentTargetNotebookId !== undefined) assertReference(notebooks.has(row.priorCurrentTargetNotebookId), `Receipt ${row.id} references a missing prior target notebook.`);
        }
        break;
      case "undo":
        break;
      default: {
        const exhaustive: never = receipt;
        return exhaustive;
      }
    }
  }
  assertReference(undoOf.size <= byId.size, "Receipt undo relationships are inconsistent.");
}

function validateProjectRelationships(
  stores: RawStores,
  projects: ReadonlyMap<string, ProjectRow>,
  identities: ReadonlyMap<string, WorkbookIdentityRow>,
  items: ReadonlyMap<string, ProjectItemRow>,
  pages: ReadonlyMap<string, PageRecord>,
): void {
  const receiptRows = stores.projectItemReceipts;
  const receipts = uniqueMap(receiptRows, (row) => row.id, "projectItemReceipts");
  const mutationIds = new Set<string>();
  const undoOf = new Set<string>();
  const agentProjectIds = new Set<string>();
  const validateAnchor = (
    anchor: ProjectItemRow["anchor"],
    label: string,
    workbookId: string,
  ): void => {
    if (anchor.kind === "none") return;
    const page = pages.get(anchor.pageId);
    assertReference(page !== undefined && String(page.workbookId) === workbookId, `${label} references a page in another workbook.`);
    if (anchor.kind === "element") {
      assertReference(page !== undefined && page.elements.some((element) => element.id === anchor.elementId), `${label} references a missing page element.`);
    }
  };
  for (const row of stores.workbookIdentities) {
    const identity = checked(`Workbook identity ${row.workbookId}`, () => parseWorkbookIdentityRow(row));
    assertReference(!identity.projectId || projects.has(identity.projectId), `Workbook ${row.workbookId} references a missing project.`);
    assertReference(row.kind !== "agent" || row.agentProjectId === row.projectId, `Workbook ${row.workbookId} has an inconsistent agent project index.`);
    if (row.kind === "agent") {
      assertReference(!agentProjectIds.has(row.agentProjectId), `workbookIdentities contains duplicate agent project ${row.agentProjectId}.`);
      agentProjectIds.add(row.agentProjectId);
    }
  }
  for (const row of stores.projectItems) {
    const item = checked(`Project item ${row.id}`, () => parseProjectItemRow(row));
    assertReference(projects.has(item.projectId), `Project item ${row.id} references a missing project.`);
    const identity = identities.get(item.workbookId);
    assertReference(identity !== undefined && identity.projectId === item.projectId, `Project item ${row.id} has an invalid project/workbook relationship.`);
    validateAnchor(row.anchor, `Project item ${row.id}`, row.workbookId);
  }
  for (const row of receiptRows) {
    const receipt = checked(`Project item receipt ${row.id}`, () => parseProjectItemReceiptRow(row));
    assertReference(!mutationIds.has(row.mutationId), `projectItemReceipts contains duplicate mutation id ${row.mutationId}.`);
    mutationIds.add(row.mutationId);
    assertReference(projects.has(receipt.projectId), `Project item receipt ${row.id} references a missing project.`);
    const identity = identities.get(receipt.workbookId);
    assertReference(identity !== undefined && identity.projectId === receipt.projectId, `Project item receipt ${row.id} has an invalid project/workbook relationship.`);
    assertReference(receipt.itemId === row.itemId, `Project item receipt ${row.id} has an inconsistent item id.`);
    assertReference(sameValue(row.actor, row.request.actor) && row.source === row.request.source, `Project item receipt ${row.id} has an inconsistent request actor or source.`);
    const before = row.beforeItem;
    const after = row.afterItem;
    if (before !== null) assertReference(before.id === row.itemId && before.projectId === row.projectId && before.workbookId === row.workbookId, `Project item receipt ${row.id} has an inconsistent before item.`);
    if (after !== null) assertReference(after.id === row.itemId && after.projectId === row.projectId && after.workbookId === row.workbookId, `Project item receipt ${row.id} has an inconsistent after item.`);
    if (before !== null) validateAnchor(before.anchor, `Project item receipt ${row.id} before item`, row.workbookId);
    if (after !== null) validateAnchor(after.anchor, `Project item receipt ${row.id} after item`, row.workbookId);
    if (row.kind === "project_item_create") {
      assertReference(before === null && after !== null && after.revision === 1, `Project item create receipt ${row.id} has an invalid before/after state.`);
      assertReference(row.request.kind === "create" && row.request.itemId === row.itemId && row.request.projectId === row.projectId && row.request.workbookId === row.workbookId, `Project item create receipt ${row.id} has an invalid request.`);
      if (row.request.kind === "create" && after !== null) {
        validateAnchor(row.request.anchor, `Project item receipt ${row.id} request`, row.workbookId);
        assertReference(after.kind === row.request.itemKind && after.title === row.request.title && after.status === row.request.status && sameValue(after.anchor, row.request.anchor), `Project item create receipt ${row.id} does not match its request.`);
        assertReference(sameValue(after.authoredBy, row.request.actor) && after.createdAt === row.completedAt && after.updatedAt === row.completedAt, `Project item create receipt ${row.id} has an invalid authored state.`);
      }
    } else if (row.kind === "project_item_update") {
      assertReference(before !== null && after !== null && after.revision === before.revision + 1, `Project item update receipt ${row.id} has an invalid revision transition.`);
      assertReference(row.request.kind === "update" && row.request.itemId === row.itemId && row.request.expectedRevision === before?.revision, `Project item update receipt ${row.id} has an invalid request.`);
      if (row.request.kind === "update" && before !== null && after !== null) {
        validateAnchor(row.request.anchor, `Project item receipt ${row.id} request`, row.workbookId);
        assertReference(after.title === row.request.title && after.status === row.request.status && sameValue(after.anchor, row.request.anchor), `Project item update receipt ${row.id} does not match its request.`);
        assertReference(after.createdAt === before.createdAt && sameValue(after.authoredBy, before.authoredBy) && after.updatedAt === row.completedAt, `Project item update receipt ${row.id} has an invalid authored state.`);
      }
    } else {
      assertReference(row.undoOf !== undefined, `Project item undo receipt ${row.id} is missing undoOf.`);
      const source = row.undoOf === undefined ? undefined : receipts.get(row.undoOf);
      assertReference(source !== undefined && source.kind !== "project_item_undo", `Project item undo receipt ${row.id} points to a missing source receipt.`);
      assertReference(source?.undo.kind === "consumed" && source.undo.by === row.id, `Project item undo receipt ${row.id} is not linked from its source receipt.`);
      const sourceId = row.undoOf;
      if (sourceId === undefined) throw new WorkspaceBackupValidationError(`Project item undo receipt ${row.id} is missing undoOf.`);
      undoOf.add(sourceId);
      assertReference(row.request.kind === "undo" && row.request.receiptId === sourceId, `Project item undo receipt ${row.id} has an invalid request.`);
      if (source !== undefined) {
        assertReference(sameValue(before, source.afterItem), `Project item undo receipt ${row.id} has an invalid source snapshot.`);
        if (source.beforeItem === null) {
          assertReference(after === null, `Project item undo receipt ${row.id} should remove the created item.`);
        } else if (before !== null && after !== null) {
          assertReference(after.id === source.beforeItem.id && after.projectId === source.beforeItem.projectId && after.workbookId === source.beforeItem.workbookId &&
            after.kind === source.beforeItem.kind && after.title === source.beforeItem.title && after.status === source.beforeItem.status &&
            sameValue(after.anchor, source.beforeItem.anchor) && sameValue(after.authoredBy, source.beforeItem.authoredBy) &&
            after.revision === before.revision + 1 && after.createdAt === source.beforeItem.createdAt &&
            after.updatedAt === row.completedAt, `Project item undo receipt ${row.id} has an invalid restored snapshot.`);
        }
      }
    }
    if (row.kind !== "project_item_undo") assertReference(row.undoOf === undefined, `Project item receipt ${row.id} has an unexpected undoOf field.`);
    if (row.undo.kind === "consumed") {
      const inverse = receipts.get(row.undo.by);
      assertReference(inverse !== undefined && inverse.kind === "project_item_undo", `Project item receipt ${row.id} points to a missing undo receipt.`);
    }
    if (row.kind === "project_item_undo") assertReference(row.undo.kind === "unavailable", `Project item undo receipt ${row.id} must be final.`);
  }
  assertReference(undoOf.size <= receipts.size, "Project item undo relationships are inconsistent.");
  for (const item of items.values()) assertReference(item.id.length > 0, "Project item ids must not be empty.");
}

export function validateWorkspaceBackup(value: unknown): WorkspaceBackupV1 {
  const raw = parseEnvelope(value);
  const stores = raw.stores;
  const notebooks = uniqueMap(stores.notebooks, (row) => row.id, "notebooks");
  const canvasSnapshots = uniqueMap(stores.canvasSnapshots, (row) => row.notebookId, "canvasSnapshots");
  const notes = uniqueMap(stores.notes, (row) => row.id, "notes");
  const lifecycles = uniqueMap(stores.notebookLifecycle, (row) => row.notebookId, "notebookLifecycle");
  const pageDocuments = uniqueMap(stores.pageDocuments, (row) => row.workbookId, "pageDocuments");
  const pageRows = uniqueMap(stores.pages, (row) => row.id, "pages");
  const pageReceipts = uniqueMap(stores.pageReceipts, (row) => row.id, "pageReceipts");
  const pageMigrations = uniqueMap(stores.pageMigrations, (row) => row.id, "pageMigrations");
  const projects = uniqueMap(stores.projects, (row) => row.id, "projects");
  const identities = uniqueMap(stores.workbookIdentities, (row) => row.workbookId, "workbookIdentities");
  const items = uniqueMap(stores.projectItems, (row) => row.id, "projectItems");
  const scraps = uniqueMap(stores.pageScraps, (row) => row.id, "pageScraps");

  for (const row of stores.notebooks) checked(`Notebook ${row.id}`, () => parseNotebookRow(row));
  for (const row of canvasSnapshots.values()) assertReference(notebooks.has(row.notebookId), `Canvas snapshot ${row.notebookId} references a missing notebook.`);
  for (const row of stores.notes) checked(`Note ${row.id}`, () => parseNote(row));
  for (const row of stores.notes) assertReference(notebooks.has(row.targetNotebookId), `Note ${row.id} references a missing notebook.`);
  for (const row of stores.notebookLifecycle) {
    assertReference(notebooks.has(row.notebookId), `Notebook lifecycle ${row.notebookId} references a missing notebook.`);
    assertReference(row.notebookId !== "inbox" || row.lifecycle !== "trashed", "Inbox cannot be trashed.");
  }
  assertReference(stores.workspaceMetadata.length === 1, "workspaceMetadata must contain exactly one row.");
  const metadata = stores.workspaceMetadata[0];
  if (metadata !== undefined) {
    assertReference(notebooks.has(metadata.inboxNotebookId), "Workspace metadata references a missing Inbox notebook.");
    assertReference(notebooks.has(metadata.currentTargetNotebookId), "Workspace metadata references a missing current target notebook.");
    assertReference(lifecycles.get(metadata.currentTargetNotebookId)?.lifecycle !== "trashed", "Workspace metadata targets a trashed notebook.");
  }
  validateLegacyReceiptRelationships(stores.receipts, notebooks, notes);

  const parsedPages = new Map<string, PageRecord>();
  for (const row of stores.pages) {
    assertReference(notebooks.has(row.workbookId), `Page ${row.id} references a missing workbook notebook.`);
    parsedPages.set(row.id, pageFromRow(row));
  }
  const parsedDocuments = new Map<string, PageDocument>();
  for (const row of pageDocuments.values()) {
    assertReference(notebooks.has(row.workbookId), `Page document ${row.workbookId} references a missing workbook notebook.`);
    const workbookPages = [...pageRows.values()].filter((page) => page.workbookId === row.workbookId).map(pageFromRow);
    parsedDocuments.set(row.workbookId, documentFromRows(row, workbookPages));
  }
  for (const row of stores.pages) assertReference(parsedDocuments.has(row.workbookId), `Page ${row.id} is not owned by a page document.`);
  const pageMutationIds = new Set<string>();
  const reworkReceiptIds = new Set<string>();
  for (const row of stores.pageReceipts) {
    assertReference(notebooks.has(row.workbookId), `Page receipt ${row.id} references a missing workbook notebook.`);
    assertReference(!pageMutationIds.has(row.mutationId), `pageReceipts contains duplicate mutation id ${row.mutationId}.`);
    pageMutationIds.add(row.mutationId);
    const beforePages = row.beforePages.map(pageFromRow);
    const beforeDocument = documentFromRows(row.beforeDocument, beforePages);
    assertReference(beforeDocument.workbookId === row.workbookId, `Page receipt ${row.id} has an inconsistent workbook.`);
    for (const page of beforePages) assertReference(parsedPages.get(page.id)?.workbookId === page.workbookId, `Page receipt ${row.id} references a page outside the current page store.`);
    assertReference(new Set(row.affectedPageIds).size === row.affectedPageIds.length, `Page receipt ${row.id} contains duplicate affected page ids.`);
    const beforePageIds = new Set<string>(beforePages.map((page) => page.id));
    const resultingPageIds = new Set(Object.keys(row.resultingPageRevisions));
    assertReference(resultingPageIds.size > 0, `Page receipt ${row.id} has no resulting page revisions.`);
    for (const pageId of resultingPageIds) assertReference(parsedPages.get(pageId)?.workbookId === row.workbookId, `Page receipt ${row.id} has a resulting revision for an unknown page.`);
    for (const pageId of row.affectedPageIds) {
      assertReference(beforePageIds.has(pageId) || resultingPageIds.has(pageId), `Page receipt ${row.id} references an unknown affected page.`);
    }
    if (row.undo.kind === "consumed") {
      const inverse = pageReceipts.get(row.undo.by);
      assertReference(inverse !== undefined && inverse.kind === "page_undo", `Page receipt ${row.id} points to a missing page undo receipt.`);
    }
    if (row.kind === "page_undo" || row.kind === "page_rework_apply" || row.kind === "page_scrap_restore") assertReference(row.undo.kind === "unavailable", `Page receipt ${row.id} must be final.`);
    if (row.kind === "page_rework_apply") reworkReceiptIds.add(row.id);
  }
  const migrationWorkbooks = new Set<string>();
  for (const row of pageMigrations.values()) {
    assertReference(!migrationWorkbooks.has(row.workbookId), `pageMigrations contains duplicate workbook ${row.workbookId}.`);
    migrationWorkbooks.add(row.workbookId);
    assertReference(row.id === `phase3-v1:${row.workbookId}`, `Page migration ${row.id} has an invalid stable id.`);
    assertReference(notebooks.has(row.workbookId), `Page migration ${row.id} references a missing workbook notebook.`);
    assertReference(parsedDocuments.has(row.workbookId), `Page migration ${row.id} has no page document.`);
    assertReference(new Set(row.migratedNoteIds).size === row.migratedNoteIds.length, `Page migration ${row.id} contains duplicate note ids.`);
    for (const noteId of row.migratedNoteIds) assertReference(notes.get(noteId)?.targetNotebookId === row.workbookId, `Page migration ${row.id} references an unrelated note.`);
  }
  const scrapReceipts = new Set<string>();
  for (const row of scraps.values()) {
    checked(`Page scrap ${row.id}`, () => parsePageScrapRow(row));
    assertReference(notebooks.has(row.workbookId), `Page scrap ${row.id} references a missing workbook notebook.`);
    const beforePages = row.beforePages.map(pageFromRow);
    const beforeDocument = documentFromRows(row.beforeDocument, beforePages);
    assertReference(beforeDocument.workbookId === row.workbookId, `Page scrap ${row.id} has an inconsistent workbook.`);
    for (const page of beforePages) assertReference(parsedPages.get(page.id)?.workbookId === page.workbookId, `Page scrap ${row.id} references a page outside the current page store.`);
    assertReference(sameValue(row.resultingPageOrder, row.beforeDocument.pageOrder), `Page scrap ${row.id} changes page topology.`);
    const resultingPageIds = Object.keys(row.resultingPageRevisions);
    assertReference(resultingPageIds.length === row.resultingPageOrder.length && row.resultingPageOrder.every((pageId) => resultingPageIds.includes(pageId)), `Page scrap ${row.id} has incomplete resulting page revisions.`);
    const rework = pageReceipts.get(row.reworkReceiptId);
    assertReference(!scrapReceipts.has(row.reworkReceiptId), `Page scrap ${row.id} duplicates a rework receipt.`);
    scrapReceipts.add(row.reworkReceiptId);
    assertReference(rework !== undefined && rework.kind === "page_rework_apply" && rework.workbookId === row.workbookId, `Page scrap ${row.id} references an invalid rework receipt.`);
    assertReference(rework === undefined || (sameValue(rework.beforeDocument, row.beforeDocument) && sameValue(rework.beforePages, row.beforePages) &&
      rework.resultingDocumentRevision === row.resultingDocumentRevision && sameValue(rework.resultingPageRevisions, row.resultingPageRevisions)), `Page scrap ${row.id} does not match its rework receipt snapshot.`);
    const assetIds = new Set<string>();
    for (const reference of row.assetReferences) {
      const assetId = `${reference.pageId}\u0000${reference.elementId}`;
      assertReference(!assetIds.has(assetId), `Page scrap ${row.id} contains duplicate asset references.`);
      assetIds.add(assetId);
      const page = beforePages.find((candidate) => candidate.id === reference.pageId);
      assertReference(page !== undefined && page.elements.some((element) => element.id === reference.elementId), `Page scrap ${row.id} references a missing asset element.`);
    }
  }
  for (const receiptId of reworkReceiptIds) {
    assertReference([...scraps.values()].some((scrap) => scrap.reworkReceiptId === receiptId), `Page rework receipt ${receiptId} has no durable Scrap.`);
  }
  validateProjectRelationships(stores, projects, identities, items, parsedPages);
  for (const row of stores.projectItemReceipts) assertReference(row.kind === "project_item_undo" || row.undo.kind !== "unavailable", `Project item receipt ${row.id} has an invalid undo state.`);
  for (const row of stores.workbookIdentities) assertReference(notebooks.has(row.workbookId), `Workbook identity ${row.workbookId} references a missing notebook.`);
  for (const row of stores.pageDocuments) assertReference(row.pageOrder.length === new Set(row.pageOrder).size, `Page document ${row.workbookId} contains duplicate page ids.`);
  for (const row of stores.pageReceipts) assertReference(pageReceipts.has(row.id), `Page receipt ${row.id} is unavailable.`);
  for (const row of stores.projects) checked(`Project ${row.id}`, () => parseProjectRow(row));

  const normalizedMetadata: WorkspaceMetadataRow[] = stores.workspaceMetadata.map((row) => ({
    ...row,
    inboxNotebookId: createNotebookId(row.inboxNotebookId),
    currentTargetNotebookId: createNotebookId(row.currentTargetNotebookId),
    revision: createRevision(row.revision),
    updatedAt: createIsoInstant(row.updatedAt),
  }));
  const normalized: BackupStores = {
    notebooks: sortRows(stores.notebooks, (row) => row.id),
    canvasSnapshots: sortRows(stores.canvasSnapshots, (row) => row.notebookId),
    notes: sortRows(stores.notes, (row) => row.id),
    receipts: sortRows(stores.receipts, (row) => row.id),
    notebookLifecycle: sortRows(stores.notebookLifecycle, (row) => row.notebookId),
    workspaceMetadata: sortRows(normalizedMetadata, (row) => row.id),
    pageDocuments: sortRows(stores.pageDocuments.map(normalizePageDocumentRow), (row) => row.workbookId),
    pages: sortRows(stores.pages.map(normalizePageRow), (row) => row.id),
    pageReceipts: sortRows(stores.pageReceipts.map(normalizePageReceiptRow), (row) => row.id),
    pageMigrations: sortRows(stores.pageMigrations, (row) => row.id),
    projects: sortRows(stores.projects, (row) => row.id),
    workbookIdentities: sortRows(stores.workbookIdentities, (row) => row.workbookId),
    projectItems: sortRows(stores.projectItems, (row) => row.id),
    projectItemReceipts: sortRows(stores.projectItemReceipts.map(normalizeProjectItemReceiptRow), (row) => row.id),
    pageScraps: sortRows(stores.pageScraps.map(normalizePageScrapRow), (row) => row.id),
  };
  return {
    format: raw.format,
    version: raw.version,
    databaseVersion: raw.databaseVersion,
    exportedAt: raw.exportedAt,
    stores: normalized,
  };
}
