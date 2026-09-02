import {
  createActorId,
  createDocumentRevision,
  createMutationId,
  createPageId,
  createPageReceiptId,
  createPageRevision,
  createPageScrapId,
  resolveDiagramTemplate,
  parsePageElements,
  validatePage,
  validatePageDocument,
  type PageDocument,
  type PageRecord,
} from "../page";
import { createIsoInstant, createNotebookId } from "../domain";
import { parsePageScrapRow } from "../projects/rows";
import { PageStorageError } from "./page-storage-errors";
import type {
  PageDocumentRow,
  PageMigrationRow,
  PageReceiptRow,
  PageRow,
} from "./database";
import type { PageMigrationReport, PageReceipt, PageScrap } from "./page-storage";

type UnknownRecord = Record<string, unknown>;
type CanvasRow = { notebookId: string; version: 1; savedAt: string; snapshot: unknown };
type DiagramTemplateName = "relationship-map" | "process-map" | "visual-study" | "signal-flow";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDiagramTemplateName(value: string): value is DiagramTemplateName {
  return value === "relationship-map" || value === "process-map" || value === "visual-study" || value === "signal-flow";
}

export function normalizeStoredElement(value: unknown): unknown {
  if (!isRecord(value) || value.kind !== "diagram") return value;
  const element = value;
  if (!isRecord(element.document)) return value;
  const document = element.document;
  if (document.kind === "snapshot" && document.version === undefined && document.snapshot !== undefined) {
    return { ...element, document: { kind: "snapshot", version: 1, snapshot: document.snapshot } };
  }
  if (document.kind === "template" && document.version === undefined) {
    const templateName = String(document.template);
    if (isDiagramTemplateName(templateName)) {
      const definition = resolveDiagramTemplate(templateName);
      return { ...element, document: { kind: "template", template: definition.template, version: definition.version } };
    }
  }
  return value;
}

export function decodePageRow(row: PageRow): PageRecord {
  try {
    const page: PageRecord = {
      version: 1,
      id: createPageId(row.id),
      workbookId: createNotebookId(row.workbookId),
      number: row.number,
      revision: createPageRevision(row.revision),
      size: { ...row.size },
      ...(row.paper === undefined ? {} : { paper: row.paper }),
      elements: parsePageElements(row.elements.map(normalizeStoredElement)),
      createdAt: createIsoInstant(row.createdAt),
      updatedAt: createIsoInstant(row.updatedAt),
    };
    return validatePage(page);
  } catch (error: unknown) {
    if (error instanceof PageStorageError) throw error;
    throw new PageStorageError("invalid_page", error instanceof Error ? error.message : "Malformed canonical page row.");
  }
}

export function decodePageDocument(row: PageDocumentRow, pages: readonly PageRecord[]): PageDocument {
  try {
    const byId = new Map(pages.map((page) => [page.id, page]));
    const ordered = row.pageOrder.map((id) => {
      const page = byId.get(createPageId(id));
      if (page === undefined) throw new PageStorageError("invalid_page", `Page ${id} is missing.`);
      return page;
    });
    return validatePageDocument({
      version: 1,
      workbookId: createNotebookId(row.workbookId),
      documentRevision: createDocumentRevision(row.documentRevision),
      pageOrder: row.pageOrder.map(createPageId),
      pages: ordered,
    });
  } catch (error: unknown) {
    if (error instanceof PageStorageError) throw error;
    throw new PageStorageError("invalid_page", error instanceof Error ? error.message : "Malformed canonical document row.");
  }
}

export function decodePageReceipt(row: PageReceiptRow): PageReceipt {
  const beforePages = row.beforePages.map(decodePageRow);
  return {
    id: createPageReceiptId(row.id),
    workbookId: createNotebookId(row.workbookId),
    mutationId: createMutationId(row.mutationId),
    actorId: createActorId(row.actorId),
    source: row.source,
    kind: row.kind,
    completedAt: createIsoInstant(row.completedAt),
    beforeDocument: decodePageDocument(row.beforeDocument, beforePages),
    beforePages,
    affectedPageIds: row.affectedPageIds.map(createPageId),
    resultingDocumentRevision: createDocumentRevision(row.resultingDocumentRevision),
    resultingPageRevisions: Object.fromEntries(
      Object.entries(row.resultingPageRevisions).map(([id, revision]) => [id, createPageRevision(revision)]),
    ),
    undo: row.undo.kind === "consumed"
      ? { kind: "consumed", by: createPageReceiptId(String(row.undo.by)) }
      : row.undo.kind === "unavailable"
        ? { kind: "unavailable" }
        : { kind: "available" },
  };
}

export function decodePageScrap(value: unknown): PageScrap {
  const row = parsePageScrapRow(value);
  const beforePages = row.beforePages.map(decodePageRow);
  return {
    version: 1,
    id: createPageScrapId(row.id),
    workbookId: createNotebookId(row.workbookId),
    reason: row.reason,
    capturedBy: { kind: row.capturedBy.kind, id: createActorId(row.capturedBy.id) },
    capturedAt: createIsoInstant(row.capturedAt),
    beforeDocument: decodePageDocument(row.beforeDocument, beforePages),
    beforePages,
    assetReferences: row.assetReferences.map((reference) => ({
      kind: "page-element",
      pageId: createPageId(reference.pageId),
      elementId: reference.elementId,
    })),
    resultingDocumentRevision: createDocumentRevision(row.resultingDocumentRevision),
    resultingPageOrder: row.resultingPageOrder.map(createPageId),
    resultingPageRevisions: Object.fromEntries(Object.entries(row.resultingPageRevisions).map(([id, revision]) => [id, createPageRevision(revision)])),
    reworkReceiptId: createPageReceiptId(row.reworkReceiptId),
  };
}

export function isCanvasRow(value: unknown): value is CanvasRow {
  return isRecord(value) &&
    "notebookId" in value && typeof value.notebookId === "string" &&
    "version" in value && value.version === 1 &&
    "savedAt" in value && typeof value.savedAt === "string" &&
    "snapshot" in value;
}

export function decodeMigrationReport(row: PageMigrationRow): PageMigrationReport {
  return {
    migrationId: row.id,
    workbookId: createNotebookId(row.workbookId),
    migratedNoteIds: [...row.migratedNoteIds],
    migratedCanvas: row.migratedCanvas,
    issues: [...row.issues],
  };
}
