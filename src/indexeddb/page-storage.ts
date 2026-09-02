import type { IDBPDatabase, IDBPTransaction } from "idb";

import {
  createActorId,
  createDocumentRevision,
  createMutationId,
  createPageReceiptId,
  createPageRevision,
  createTextBlockId,
  createEmptyPageDocument,
  appendPage as appendDomainPage,
  richTextFromPlainText,
  stableElementId,
  validatePage,
  validatePageDocument,
  type ActorId,
  type DocumentRevision,
  type MutationId,
  type PageDocument,
  type PageElement,
  type PageId,
  type PageRecord,
  type PageReceiptId,
  type PageRevision,
  type PageScrapId,
  type TextElement,
  type WorkbookId,
} from "../page";
import {
  createIsoInstant,
  type IsoInstant,
  parseNote,
  sortNoteEntries,
  type NoteEntry,
} from "../domain";
import {
  openPhase2Database,
  PHASE0_DATABASE_NAME,
  type PageDocumentRow,
  type PageMigrationRow,
  type PageReceiptRow,
  type PageRow,
  type PageWriterClaimRow,
  type Phase2Database,
} from "./database";
import {
  type PageScrapAssetReferenceRow,
  type PageScrapRow,
} from "../projects/rows";
import { PageStorageError } from "./page-storage-errors";
import {
  decodeMigrationReport,
  decodePageDocument,
  decodePageReceipt,
  decodePageRow,
  decodePageScrap,
  isCanvasRow,
} from "./page-storage-codecs";

export { PageStorageError } from "./page-storage-errors";

export type PageStorageSource = "person" | "assistant";

export type PageWriterClaimInput = Readonly<{
  workbookId: WorkbookId;
  pageId: PageId;
  actorId: ActorId;
  claimId: string;
  ttlMs?: number;
}>;

export type PageCommitInput = Readonly<{
  workbookId: WorkbookId;
  nextDocument: PageDocument;
  pageIds: readonly PageId[];
  expectedDocumentRevision: DocumentRevision;
  expectedPageRevisions: Readonly<Record<string, PageRevision>>;
  mutationId: MutationId;
  actorId: ActorId;
  source: PageStorageSource;
  kind: string;
  claimId?: string;
}>;

export type PageUndoInput = Readonly<{
  workbookId: WorkbookId;
  receiptId: PageReceiptId;
  mutationId: MutationId;
  actorId: ActorId;
  source: PageStorageSource;
  claimId?: string;
  visiblePageIds: readonly PageId[];
}>;

export type PageScrapAssetReference = Readonly<{
  kind: "page-element";
  pageId: PageId;
  elementId: string;
}>;

export type PageScrap = Readonly<{
  version: 1;
  id: PageScrapId;
  workbookId: WorkbookId;
  reason: string;
  capturedBy: Readonly<{ kind: "user" | "agent"; id: ActorId }>;
  capturedAt: IsoInstant;
  beforeDocument: PageDocument;
  beforePages: readonly PageRecord[];
  assetReferences: readonly PageScrapAssetReference[];
  resultingDocumentRevision: DocumentRevision;
  resultingPageOrder: readonly PageId[];
  resultingPageRevisions: Readonly<Record<string, PageRevision>>;
  reworkReceiptId: PageReceiptId;
}>;

export type PageReworkInput = Omit<PageCommitInput, "kind"> & Readonly<{
  kind?: "page_rework_apply";
  scrapId: PageScrapId;
  reason: string;
}>;

export type PageScrapRestoreInput = Readonly<{
  workbookId: WorkbookId;
  scrapId: PageScrapId;
  mutationId: MutationId;
  actorId: ActorId;
  source: PageStorageSource;
  claimId?: string;
  visiblePageIds: readonly PageId[];
}>;

export type PageReworkResult = PageCommitResult & Readonly<{ scrap: PageScrap }>;

export type PageReceipt = Readonly<{
  id: PageReceiptId;
  workbookId: WorkbookId;
  mutationId: MutationId;
  actorId: ActorId;
  source: PageStorageSource;
  kind: string;
  completedAt: IsoInstant;
  beforeDocument: PageDocument;
  beforePages: readonly PageRecord[];
  affectedPageIds: readonly PageId[];
  resultingDocumentRevision: DocumentRevision;
  resultingPageRevisions: Readonly<Record<string, PageRevision>>;
  undo: Readonly<{ kind: "available" | "consumed" | "unavailable"; by?: PageReceiptId }>;
}>;

export type PageCommitResult = Readonly<{
  status: "committed" | "duplicate";
  document: PageDocument;
  receipt: PageReceipt;
}>;

export type PageMigrationIssue = Readonly<{
  kind: "malformed_note" | "malformed_canvas";
  id: string;
  message: string;
}>;

export type PageMigrationReport = Readonly<{
  migrationId: string;
  workbookId: WorkbookId;
  migratedNoteIds: readonly string[];
  migratedCanvas: boolean;
  issues: readonly PageMigrationIssue[];
}>;

export type PageStorageOptions = Readonly<{
  databaseName?: string;
  clock?: Readonly<{ now: () => string }>;
  failureHook?: (point: string) => void;
  ids?: Readonly<{ newReceiptId?: () => string }>;
}>;

export interface PageStorage {
  close(): Promise<void>;
  read(workbookId: WorkbookId): Promise<PageDocument>;
  getDocument(workbookId: WorkbookId): Promise<PageDocument | null>;
  ensureWorkbook(workbookId: WorkbookId): Promise<PageDocument>;
  migrateWorkbook(workbookId: WorkbookId): Promise<Readonly<{ document: PageDocument; report: PageMigrationReport }>>;
  appendPage(workbookId: WorkbookId, expectedDocumentRevision: DocumentRevision): Promise<PageDocument>;
  claimPage(input: PageWriterClaimInput): Promise<PageWriterClaimRow>;
  releasePageWriter(input: Pick<PageWriterClaimInput, "pageId" | "actorId" | "claimId">): Promise<void>;
  listScraps(workbookId: WorkbookId): Promise<readonly PageScrap[]>;
  getScrap(workbookId: WorkbookId, scrapId: PageScrapId): Promise<PageScrap | null>;
  commit(input: PageCommitInput): Promise<PageCommitResult>;
  applyRework(input: PageReworkInput): Promise<PageReworkResult>;
  restoreScrap(input: PageScrapRestoreInput): Promise<PageCommitResult>;
  undo(input: PageUndoInput): Promise<PageCommitResult>;
}

function nowIso(options: PageStorageOptions): IsoInstant {
  return createIsoInstant(options.clock?.now?.() ?? new Date().toISOString());
}

function migrationId(workbookId: WorkbookId): string {
  return `phase3-v1:${workbookId}`;
}

function rowFromDocument(document: PageDocument): PageDocumentRow {
  return {
    workbookId: document.workbookId,
    version: 1,
    documentRevision: document.documentRevision,
    pageOrder: [...document.pageOrder],
    updatedAt: document.pages.at(-1)?.updatedAt ?? new Date(0).toISOString(),
  };
}

function rowFromPage(page: PageRecord): PageRow {
  return {
    id: page.id,
    workbookId: page.workbookId,
    version: 1,
    number: page.number,
    revision: page.revision,
    size: { ...page.size },
    ...(page.paper === undefined ? {} : { paper: page.paper }),
    elements: [...page.elements],
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
  };
}

function rowFromReceipt(receipt: PageReceipt, fingerprint: string): PageReceiptRow {
  return {
    id: receipt.id,
    workbookId: receipt.workbookId,
    mutationId: receipt.mutationId,
    actorId: receipt.actorId,
    source: receipt.source,
    kind: receipt.kind,
    completedAt: receipt.completedAt,
    fingerprint,
    beforeDocument: rowFromDocument(receipt.beforeDocument),
    beforePages: receipt.beforePages.map(rowFromPage),
    affectedPageIds: [...receipt.affectedPageIds],
    resultingDocumentRevision: receipt.resultingDocumentRevision,
    resultingPageRevisions: { ...receipt.resultingPageRevisions },
    undo: { ...receipt.undo },
  };
}

function assetReferencesFor(document: PageDocument): readonly PageScrapAssetReference[] {
  return document.pages.flatMap((page) => page.elements
    .filter((element) => element.kind === "embedded-frame" || element.kind === "diagram" || element.kind === "vector-ink")
    .map((element) => ({ kind: "page-element" as const, pageId: page.id, elementId: element.id })));
}

function rowFromScrap(scrap: PageScrap): PageScrapRow {
  return {
    version: 1,
    id: scrap.id,
    workbookId: scrap.workbookId,
    reason: scrap.reason,
    capturedBy: { kind: scrap.capturedBy.kind, id: scrap.capturedBy.id },
    capturedAt: scrap.capturedAt,
    beforeDocument: rowFromDocument(scrap.beforeDocument),
    beforePages: scrap.beforePages.map(rowFromPage),
    assetReferences: scrap.assetReferences.map((reference): PageScrapAssetReferenceRow => ({
      kind: "page-element",
      pageId: reference.pageId,
      elementId: reference.elementId,
    })),
    resultingDocumentRevision: scrap.resultingDocumentRevision,
    resultingPageOrder: [...scrap.resultingPageOrder],
    resultingPageRevisions: { ...scrap.resultingPageRevisions },
    reworkReceiptId: scrap.reworkReceiptId,
  };
}

function stableFingerprint(input: PageCommitInput): string {
  return JSON.stringify({
    workbookId: input.workbookId,
    nextDocument: input.nextDocument,
    pageIds: input.pageIds,
    expectedDocumentRevision: input.expectedDocumentRevision,
    expectedPageRevisions: input.expectedPageRevisions,
    kind: input.kind,
    source: input.source,
    actorId: input.actorId,
    ...("scrapId" in input && typeof input.scrapId === "string" ? { scrapId: input.scrapId } : {}),
    ...("reason" in input && typeof input.reason === "string" ? { reason: input.reason } : {}),
  });
}

function undoFingerprint(input: PageUndoInput): string {
  return JSON.stringify({
    kind: "page_undo",
    workbookId: input.workbookId,
    receiptId: input.receiptId,
    actorId: input.actorId,
    source: input.source,
    claimId: input.claimId ?? null,
  });
}

function scrapRestoreFingerprint(input: PageScrapRestoreInput): string {
  return JSON.stringify({
    kind: "page_scrap_restore",
    workbookId: input.workbookId,
    scrapId: input.scrapId,
    actorId: input.actorId,
    source: input.source,
    claimId: input.claimId ?? null,
  });
}

type Transaction = IDBPTransaction<Phase2Database, ["pageDocuments", "pages", "pageReceipts", "pageWriterClaims"], "readwrite">;
type ScrapTransaction = IDBPTransaction<Phase2Database, ["pageDocuments", "pages", "pageReceipts", "pageWriterClaims", "pageScraps"], "readwrite">;

async function abortAndRethrow(transaction: { abort: () => void; done: Promise<unknown> }, error: unknown): Promise<never> {
  try { transaction.abort(); } catch { /* IndexedDB can already be aborted. */ }
  try { await transaction.done; } catch {}
  throw error;
}

function pageContentFingerprint(page: PageRecord): string {
  const elements = page.elements.map((element) => element.kind === "text" ? {
    ...element,
    content: {
      ...element.content,
      blocks: element.content.blocks.map((block) => ({
        ...block,
        runs: block.runs.map((run) => ({ ...run, marks: [...run.marks].sort() })),
      })),
    },
  } : element);
  return JSON.stringify({
    version: page.version,
    id: page.id,
    workbookId: page.workbookId,
    number: page.number,
    size: page.size,
    paper: page.paper,
    elements,
    createdAt: page.createdAt,
  });
}

function validateScrapReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|<\/?[a-z][^>]*>|\b(?:javascript|data|file):|https?:\/\/|(?:^|\s)(?:[a-z]:[\\/]|\\\\|\/(?:[\w.-]+\/)+)/iu.test(trimmed)) {
    throw new PageStorageError("invalid_page", "A Scrap reason must be bounded plain text without executable or external content.");
  }
  return trimmed;
}

export class IndexedDbPageStorage implements PageStorage {
  private readonly databaseName: string;
  private readonly options: PageStorageOptions;
  private database: IDBPDatabase<Phase2Database> | null = null;

  public constructor(options: PageStorageOptions = {}) {
    this.options = options;
    this.databaseName = options.databaseName ?? PHASE0_DATABASE_NAME;
  }

  private async getDatabase(): Promise<IDBPDatabase<Phase2Database>> {
    this.database ??= await openPhase2Database(this.databaseName, this.options.failureHook);
    return this.database;
  }

  public async close(): Promise<void> {
    this.database?.close();
    this.database = null;
  }

  public async read(workbookId: WorkbookId): Promise<PageDocument> {
    const database = await this.getDatabase();
    const row = await database.get("pageDocuments", workbookId);
    if (row === undefined) throw new PageStorageError("not_found", `Workbook ${workbookId} was not found.`);
    const pages = await database.getAllFromIndex("pages", "byWorkbookId", workbookId);
    return decodePageDocument(row, pages.map(decodePageRow));
  }

  public async getDocument(workbookId: WorkbookId): Promise<PageDocument | null> {
    try { return await this.read(workbookId); } catch (error) {
      if (error instanceof PageStorageError && error.code === "not_found") return null;
      throw error;
    }
  }

  public async ensureWorkbook(workbookId: WorkbookId): Promise<PageDocument> {
    const existing = await this.getDocument(workbookId);
    return existing ?? (await this.migrateWorkbook(workbookId)).document;
  }

  public async migrateWorkbook(workbookId: WorkbookId): Promise<Readonly<{ document: PageDocument; report: PageMigrationReport }>> {
    const database = await this.getDatabase();
    const markerKey = migrationId(workbookId);
    const existingMarker = await database.get("pageMigrations", markerKey);
    if (existingMarker !== undefined) {
      return {
        document: await this.read(workbookId),
        report: decodeMigrationReport(existingMarker),
      };
    }

    const [rawNotes, rawCanvases] = await Promise.all([
      database.getAll("notes"),
      database.getAll("canvasSnapshots"),
    ]);
    const notes: NoteEntry[] = [];
    const issues: PageMigrationIssue[] = [];
    for (const raw of rawNotes) {
      try {
        const note = parseNote(raw);
        if (note.targetNotebookId === workbookId && note.lifecycle === "active") notes.push(note);
      } catch (error: unknown) {
        const id = typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? raw.id : "unknown";
        issues.push({ kind: "malformed_note", id, message: error instanceof Error ? error.message : "Malformed note row." });
      }
    }
    const canvas: unknown = rawCanvases.find((raw) => {
      return typeof raw === "object" && raw !== null && "notebookId" in raw && raw.notebookId === workbookId;
    });
    if (canvas !== undefined && !isCanvasRow(canvas)) {
      const id = typeof canvas === "object" && canvas !== null && "notebookId" in canvas && typeof canvas.notebookId === "string" ? canvas.notebookId : "unknown";
      issues.push({ kind: "malformed_canvas", id, message: "Malformed canvas snapshot row." });
    }
    notes.splice(0, notes.length, ...sortNoteEntries(notes));
    const instant = nowIso(this.options);
    const empty = createEmptyPageDocument(workbookId, instant);
    const hasCanvas = canvas !== undefined && isCanvasRow(canvas);
    const pageCount = Math.max(1, Math.ceil(notes.length / 4) + (hasCanvas && notes.length % 4 === 0 ? 1 : 0));
    let migratedDocument = empty;
    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      migratedDocument = appendDomainPage(migratedDocument, instant);
    }
    const migratedPages = migratedDocument.pages.map((basePage, pageIndex) => {
      const pageNotes = notes.slice(pageIndex * 4, pageIndex * 4 + 4);
      const elements: PageElement[] = pageNotes.map((note, noteIndex) => {
        const element: TextElement = {
          kind: "text",
          id: stableElementId("note", note.id),
          label: `Note ${pageIndex * 4 + noteIndex + 1}`,
          frame: { x: 96, y: 96 + noteIndex * 200, width: 624, height: 170 },
          content: richTextFromPlainText(note.content.text, createTextBlockId(note.id)),
          provenance: { source: "phase2-note", sourceId: note.id },
        };
        return element;
      });
      return { ...basePage, elements };
    });
    if (hasCanvas) {
      const lastPage = migratedPages.at(-1)!;
      migratedPages[migratedPages.length - 1] = {
        ...lastPage,
        elements: [...lastPage.elements, {
          kind: "embedded-frame",
          id: stableElementId("canvas", workbookId),
          label: "Legacy canvas recovery",
          frame: { x: 96, y: lastPage.elements.length === 0 ? 96 : 720, width: 624, height: 320 },
          componentType: "legacy-canvas",
          componentVersion: 1,
          props: {
            status: "recovery-only",
            sourceNotebookId: workbookId,
            sourceSnapshotVersion: 1,
          },
          provenance: { source: "phase2-canvas", sourceId: workbookId },
        }],
      };
    }
    const migrated = validatePageDocument({ ...migratedDocument, pages: migratedPages });
    const report: PageMigrationReport = {
      migrationId: markerKey,
      workbookId,
      migratedNoteIds: notes.map((note) => note.id),
      migratedCanvas: hasCanvas,
      issues,
    };
    const transaction = database.transaction(["pageDocuments", "pages", "pageMigrations"], "readwrite");
    try {
      const already = await transaction.objectStore("pageMigrations").get(markerKey);
      if (already !== undefined) {
        await transaction.done;
        return { document: await this.read(workbookId), report: decodeMigrationReport(already) };
      }
      await transaction.objectStore("pageDocuments").add(rowFromDocument(migrated));
      this.options.failureHook?.("migration.after-document");
      for (const page of migrated.pages) await transaction.objectStore("pages").add(rowFromPage(page));
      this.options.failureHook?.("migration.after-page");
      await transaction.objectStore("pageMigrations").add(rowFromMigration(report, instant));
      await transaction.done;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
    return { document: migrated, report };
  }

  public async appendPage(workbookId: WorkbookId, expectedDocumentRevision: DocumentRevision): Promise<PageDocument> {
    const current = await this.read(workbookId);
    const next = appendDomainPage(current, nowIso(this.options));
    const result = await this.commit({
      workbookId,
      nextDocument: next,
      pageIds: [next.pages.at(-1)!.id],
      expectedDocumentRevision,
      expectedPageRevisions: {},
      mutationId: createMutationId(`append:${workbookId}:${next.documentRevision}`),
      actorId: createActorId("page-storage"),
      source: "person",
      kind: "page_advance",
    });
    return result.document;
  }

  public async claimPage(input: PageWriterClaimInput): Promise<PageWriterClaimRow> {
    const database = await this.getDatabase();
    const instant = nowIso(this.options);
    const expiresAt = new Date(Date.parse(instant) + Math.max(1, input.ttlMs ?? 30_000)).toISOString();
    const transaction = database.transaction(["pages", "pageWriterClaims"], "readwrite");
    try {
      const page = await transaction.objectStore("pages").get(input.pageId);
      if (page === undefined || page.workbookId !== input.workbookId) {
        throw new PageStorageError("invalid_page", `Page ${input.pageId} does not belong to workbook ${input.workbookId}.`);
      }
      const claims = transaction.objectStore("pageWriterClaims");
      const existing = await claims.get(input.pageId);
      if (existing !== undefined && existing.expiresAt > instant &&
        (existing.actorId !== input.actorId || existing.claimId !== input.claimId || existing.workbookId !== input.workbookId)) {
        throw new PageStorageError("page_busy", `Page ${input.pageId} is being edited by another assistant.`);
      }
      const row: PageWriterClaimRow = {
        pageId: input.pageId,
        workbookId: input.workbookId,
        actorId: input.actorId,
        claimId: input.claimId,
        expiresAt,
        acquiredAt: instant,
      };
      await claims.put(row);
      await transaction.done;
      return row;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async releasePageWriter(input: Pick<PageWriterClaimInput, "pageId" | "actorId" | "claimId">): Promise<void> {
    const database = await this.getDatabase();
    const transaction = database.transaction("pageWriterClaims", "readwrite");
    try {
      const existing = await transaction.store.get(input.pageId);
      if (existing?.actorId === input.actorId && existing.claimId === input.claimId) await transaction.store.delete(input.pageId);
      await transaction.done;
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async listScraps(workbookId: WorkbookId): Promise<readonly PageScrap[]> {
    const database = await this.getDatabase();
    const rows = await database.getAllFromIndex("pageScraps", "byWorkbookId", workbookId);
    return rows.map(decodePageScrap).sort((left, right) =>
      right.capturedAt.localeCompare(left.capturedAt) || right.id.localeCompare(left.id));
  }

  public async getScrap(workbookId: WorkbookId, scrapId: PageScrapId): Promise<PageScrap | null> {
    const database = await this.getDatabase();
    const row = await database.get("pageScraps", scrapId);
    if (row === undefined) return null;
    const scrap = decodePageScrap(row);
    if (scrap.workbookId !== workbookId) throw new PageStorageError("invalid_page", "The Scrap belongs to another workbook.");
    return scrap;
  }

  public async commit(input: PageCommitInput): Promise<PageCommitResult> {
    validatePageDocument(input.nextDocument);
    if (input.nextDocument.workbookId !== input.workbookId) throw new PageStorageError("invalid_page", "The document workbook does not match the commit target.");
    const database = await this.getDatabase();
    const transaction = database.transaction(["pageDocuments", "pages", "pageReceipts", "pageWriterClaims"], "readwrite") as Transaction;
    try {
      const existingReceipt = await transaction.objectStore("pageReceipts").index("byMutationId").get(input.mutationId);
      const fingerprint = stableFingerprint(input);
      if (existingReceipt !== undefined) {
        if (existingReceipt.fingerprint !== fingerprint) throw new PageStorageError("mutation_reuse", "The mutation id was already used for different content.");
        const current = await this.readInTransaction(transaction, input.workbookId);
        await transaction.done;
        return { status: "duplicate", document: current, receipt: decodePageReceipt(existingReceipt) };
      }
      const current = await this.readInTransaction(transaction, input.workbookId);
      if (current.documentRevision !== input.expectedDocumentRevision) throw new PageStorageError("revision_conflict", "The workbook revision is stale.");
      const changedIds = [...new Set(input.pageIds)];
      if (changedIds.length === 0) throw new PageStorageError("no_op", "A page commit must declare at least one meaningful change.");
      const topologyChanged = current.pageOrder.length !== input.nextDocument.pageOrder.length ||
        current.pageOrder.some((pageId, index) => pageId !== input.nextDocument.pageOrder[index]);
      if (!topologyChanged && input.nextDocument.documentRevision !== current.documentRevision) {
        throw new PageStorageError("invalid_page", "A page-only commit cannot change document revision.");
      }
      if (topologyChanged && input.nextDocument.documentRevision !== createDocumentRevision(current.documentRevision + 1)) {
        throw new PageStorageError("revision_conflict", "A topology commit must advance document revision exactly once.");
      }
      if (!topologyChanged) {
        const declared = new Set(changedIds);
        for (const candidate of input.nextDocument.pages) {
          if (declared.has(candidate.id)) continue;
          const fresh = current.pages.find((page) => page.id === candidate.id);
          if (fresh !== undefined && candidate.revision >= fresh.revision && pageContentFingerprint(candidate) !== pageContentFingerprint(fresh)) {
            throw new PageStorageError("invalid_page", "The commit changes a page that is not declared in pageIds.");
          }
        }
      }
      if (topologyChanged) {
        const declaredIds = new Set(changedIds);
        const actuallyChangedIds = [...new Set([...current.pageOrder, ...input.nextDocument.pageOrder])].filter((pageId) => {
          const currentPage = current.pages.find((page) => page.id === pageId);
          const nextPage = input.nextDocument.pages.find((page) => page.id === pageId);
          return currentPage === undefined || nextPage === undefined || pageContentFingerprint(currentPage) !== pageContentFingerprint(nextPage);
        });
        if (actuallyChangedIds.some((pageId) => !declaredIds.has(pageId))) {
          throw new PageStorageError("invalid_page", "A topology commit changes a page that is not declared in pageIds.");
        }
      }
      for (const pageId of changedIds) {
        const currentPage = current.pages.find((page) => page.id === pageId);
        const nextPage = input.nextDocument.pages.find((page) => page.id === pageId);
        if (currentPage === undefined && nextPage !== undefined) continue;
        if (currentPage === undefined || nextPage === undefined) throw new PageStorageError("invalid_page", `Page ${pageId} is missing.`);
        const expected = input.expectedPageRevisions[pageId];
        if (expected === undefined || currentPage.revision !== expected) throw new PageStorageError("revision_conflict", `Page ${pageId} is stale.`);
        if (nextPage.workbookId !== input.workbookId || nextPage.number !== currentPage.number || nextPage.id !== currentPage.id) {
          throw new PageStorageError("invalid_page", `Page ${pageId} cannot change identity in a page-local commit.`);
        }
        if (nextPage.revision !== createPageRevision(currentPage.revision + 1)) throw new PageStorageError("revision_conflict", `Page ${pageId} must advance exactly one revision.`);
      }
      const nextDocument = topologyChanged
        ? input.nextDocument
        : validatePageDocument({
            ...current,
            pages: current.pages.map((page) => input.pageIds.includes(page.id)
              ? input.nextDocument.pages.find((candidate) => candidate.id === page.id) ?? page
              : page),
          });
      const actuallyChangedIds = changedIds.filter((pageId) => {
        const currentPage = current.pages.find((page) => page.id === pageId);
        const nextPage = nextDocument.pages.find((page) => page.id === pageId);
        return currentPage === undefined || nextPage === undefined || pageContentFingerprint(currentPage) !== pageContentFingerprint(nextPage);
      });
      if (actuallyChangedIds.length === 0) throw new PageStorageError("no_op", "The page command does not make a semantic change.");
      const affectedIds = topologyChanged
        ? [...new Set([...current.pageOrder, ...nextDocument.pageOrder])]
        : actuallyChangedIds;
      const now = nowIso(this.options);
      const autoClaimedPageIds: PageId[] = [];
      if (input.source === "assistant") {
        for (const pageId of actuallyChangedIds) {
          const existingClaim = await transaction.objectStore("pageWriterClaims").get(pageId);
          if (existingClaim !== undefined && existingClaim.expiresAt > now) {
            const exactProvidedClaim = input.claimId !== undefined && existingClaim.actorId === input.actorId &&
              existingClaim.claimId === input.claimId && existingClaim.workbookId === input.workbookId;
            if (!exactProvidedClaim) {
              throw new PageStorageError("page_busy", `Page ${pageId} is being edited under a different writer claim.`);
            }
          }
          if (existingClaim === undefined || existingClaim.expiresAt <= now) {
            const claimId = input.claimId ?? `auto:${input.actorId}:${input.mutationId}`;
            const claim: PageWriterClaimRow = {
              pageId,
              workbookId: input.workbookId,
              actorId: input.actorId,
              claimId,
              expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
              acquiredAt: now,
            };
            await transaction.objectStore("pageWriterClaims").put(claim);
            if (input.claimId === undefined) autoClaimedPageIds.push(pageId);
          }
        }
      }
      const beforeDocument = current;
      const beforePages = current.pages;
      const resultPageRevisions = Object.fromEntries(nextDocument.pages.map((page) => [page.id, page.revision]));
      const receipt: PageReceipt = {
        id: createPageReceiptId(this.options.ids?.newReceiptId?.() ?? `phase3:receipt:${input.mutationId}`),
        workbookId: input.workbookId,
        mutationId: input.mutationId,
        actorId: input.actorId,
        source: input.source,
        kind: input.kind,
        completedAt: now,
        beforeDocument,
        beforePages,
        affectedPageIds: affectedIds,
        resultingDocumentRevision: nextDocument.documentRevision,
        resultingPageRevisions: resultPageRevisions,
        undo: { kind: "available" },
      };
      await transaction.objectStore("pageDocuments").put(rowFromDocument(nextDocument));
      for (const page of nextDocument.pages) {
        const previous = current.pages.find((candidate) => candidate.id === page.id);
        if (previous === undefined || actuallyChangedIds.includes(page.id)) await transaction.objectStore("pages").put(rowFromPage(page));
      }
      this.options.failureHook?.("page.commit.after-page");
      await transaction.objectStore("pageReceipts").add(rowFromReceipt(receipt, fingerprint));
      this.options.failureHook?.("page.commit.receipt-write");
      for (const pageId of autoClaimedPageIds) {
        await transaction.objectStore("pageWriterClaims").delete(pageId);
      }
      await transaction.done;
      return { status: "committed", document: nextDocument, receipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async applyRework(input: PageReworkInput): Promise<PageReworkResult> {
    validatePageDocument(input.nextDocument);
    const reason = validateScrapReason(input.reason);
    if (input.nextDocument.workbookId !== input.workbookId) throw new PageStorageError("invalid_page", "The rework workbook does not match its target.");
    const database = await this.getDatabase();
    const transaction = database.transaction(["pageDocuments", "pages", "pageReceipts", "pageWriterClaims", "pageScraps"], "readwrite") as ScrapTransaction;
    try {
      const existingReceipt = await transaction.objectStore("pageReceipts").index("byMutationId").get(input.mutationId);
      const fingerprint = stableFingerprint({ ...input, kind: "page_rework_apply" });
      if (existingReceipt !== undefined) {
        if (existingReceipt.fingerprint !== fingerprint) throw new PageStorageError("mutation_reuse", "The mutation id was already used for different content.");
        const scraps = await transaction.objectStore("pageScraps").index("byWorkbookId").getAll(input.workbookId);
        const scrapRow = scraps.find((candidate) => candidate.reworkReceiptId === existingReceipt.id);
        if (scrapRow === undefined) throw new PageStorageError("invalid_page", "The duplicate rework receipt is missing its durable Scrap.");
        const current = await this.readInScrapTransaction(transaction, input.workbookId);
        await transaction.done;
        return { status: "duplicate", document: current, receipt: decodePageReceipt(existingReceipt), scrap: decodePageScrap(scrapRow) };
      }
      const current = await this.readInScrapTransaction(transaction, input.workbookId);
      if (current.documentRevision !== input.expectedDocumentRevision || input.nextDocument.documentRevision !== current.documentRevision) {
        throw new PageStorageError("revision_conflict", "The workbook topology changed before the rework.");
      }
      if (current.pageOrder.length !== input.nextDocument.pageOrder.length || current.pageOrder.some((pageId, index) => pageId !== input.nextDocument.pageOrder[index])) {
        throw new PageStorageError("invalid_page", "Phase 11 rework cannot add, remove, or reorder pages.");
      }
      const declaredIds = [...new Set(input.pageIds)];
      if (declaredIds.length !== 1) throw new PageStorageError("invalid_page", "Phase 11 rework changes exactly one page.");
      for (const pageId of declaredIds) {
        const before = current.pages.find((page) => page.id === pageId);
        const candidate = input.nextDocument.pages.find((page) => page.id === pageId);
        const expected = input.expectedPageRevisions[pageId];
        if (before === undefined || candidate === undefined || expected === undefined || before.revision !== expected) {
          throw new PageStorageError("revision_conflict", `Page ${pageId} is stale or missing.`);
        }
        if (candidate.id !== before.id || candidate.workbookId !== before.workbookId || candidate.number !== before.number ||
          candidate.revision !== createPageRevision(before.revision + 1)) {
          throw new PageStorageError("invalid_page", `Page ${pageId} has an invalid rework identity or revision.`);
        }
      }
      const nextDocument = validatePageDocument({
        ...current,
        pages: current.pages.map((page) => declaredIds.includes(page.id)
          ? input.nextDocument.pages.find((candidate) => candidate.id === page.id) ?? page
          : page),
      });
      const changedIds = declaredIds.filter((pageId) => {
        const before = current.pages.find((page) => page.id === pageId);
        const after = nextDocument.pages.find((page) => page.id === pageId);
        return before !== undefined && after !== undefined && pageContentFingerprint(before) !== pageContentFingerprint(after);
      });
      if (changedIds.length === 0) throw new PageStorageError("no_op", "The rework does not make a semantic change.");
      const now = nowIso(this.options);
      const autoClaimed: PageId[] = [];
      if (input.source === "assistant") {
        for (const pageId of changedIds) {
          const claim = await transaction.objectStore("pageWriterClaims").get(pageId);
          if (claim !== undefined && claim.expiresAt > now) {
            const exact = input.claimId !== undefined && claim.workbookId === input.workbookId && claim.actorId === input.actorId && claim.claimId === input.claimId;
            if (!exact) throw new PageStorageError("page_busy", `Page ${pageId} is being edited under a different writer claim.`);
          } else {
            const claimId = input.claimId ?? `auto:${input.actorId}:${input.mutationId}`;
            await transaction.objectStore("pageWriterClaims").put({
              pageId,
              workbookId: input.workbookId,
              actorId: input.actorId,
              claimId,
              expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
              acquiredAt: now,
            });
            if (input.claimId === undefined) autoClaimed.push(pageId);
          }
        }
      }
      const receipt: PageReceipt = {
        id: createPageReceiptId(this.options.ids?.newReceiptId?.() ?? `phase11:receipt:${input.mutationId}`),
        workbookId: input.workbookId,
        mutationId: input.mutationId,
        actorId: input.actorId,
        source: input.source,
        kind: "page_rework_apply",
        completedAt: now,
        beforeDocument: current,
        beforePages: current.pages,
        affectedPageIds: changedIds,
        resultingDocumentRevision: nextDocument.documentRevision,
        resultingPageRevisions: Object.fromEntries(nextDocument.pages.map((page) => [page.id, page.revision])),
        undo: { kind: "unavailable" },
      };
      const scrap: PageScrap = {
        version: 1,
        id: input.scrapId,
        workbookId: input.workbookId,
        reason,
        capturedBy: { kind: input.source === "person" ? "user" : "agent", id: input.actorId },
        capturedAt: now,
        beforeDocument: current,
        beforePages: current.pages,
        assetReferences: assetReferencesFor(current),
        resultingDocumentRevision: nextDocument.documentRevision,
        resultingPageOrder: nextDocument.pageOrder,
        resultingPageRevisions: receipt.resultingPageRevisions,
        reworkReceiptId: receipt.id,
      };
      const scrapRows = await transaction.objectStore("pageScraps").index("byWorkbookId").count(input.workbookId);
      if (scrapRows >= 50 || JSON.stringify(rowFromScrap(scrap)).length > 2_000_000) {
        throw new PageStorageError("invalid_page", "The workbook Scrap limit has been reached.");
      }
      await transaction.objectStore("pageScraps").add(rowFromScrap(scrap));
      this.options.failureHook?.("page.rework.after-scrap");
      await transaction.objectStore("pageDocuments").put(rowFromDocument(nextDocument));
      for (const page of nextDocument.pages) if (changedIds.includes(page.id)) await transaction.objectStore("pages").put(rowFromPage(page));
      await transaction.objectStore("pageReceipts").add(rowFromReceipt(receipt, fingerprint));
      this.options.failureHook?.("page.rework.receipt-write");
      for (const pageId of autoClaimed) await transaction.objectStore("pageWriterClaims").delete(pageId);
      await transaction.done;
      return { status: "committed", document: nextDocument, receipt, scrap };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async restoreScrap(input: PageScrapRestoreInput): Promise<PageCommitResult> {
    const database = await this.getDatabase();
    const transaction = database.transaction(["pageDocuments", "pages", "pageReceipts", "pageWriterClaims", "pageScraps"], "readwrite") as ScrapTransaction;
    try {
      const fingerprint = scrapRestoreFingerprint(input);
      const duplicate = await transaction.objectStore("pageReceipts").index("byMutationId").get(input.mutationId);
      if (duplicate !== undefined) {
        if (duplicate.fingerprint !== fingerprint) throw new PageStorageError("mutation_reuse", "The mutation id was already used for a different Scrap restore.");
        const current = await this.readInScrapTransaction(transaction, input.workbookId);
        await transaction.done;
        return { status: "duplicate", document: current, receipt: decodePageReceipt(duplicate) };
      }
      const rawScrap = await transaction.objectStore("pageScraps").get(input.scrapId);
      if (rawScrap === undefined) throw new PageStorageError("not_found", "The Scrap entry was not found.");
      const scrap = decodePageScrap(rawScrap);
      if (scrap.workbookId !== input.workbookId) throw new PageStorageError("invalid_page", "The Scrap belongs to another workbook.");
      const current = await this.readInScrapTransaction(transaction, input.workbookId);
      const exactOrder = current.pageOrder.length === scrap.resultingPageOrder.length &&
        current.pageOrder.every((pageId, index) => pageId === scrap.resultingPageOrder[index]);
      const exactRevisions = current.pages.every((page) => scrap.resultingPageRevisions[page.id] === page.revision);
      if (current.documentRevision !== scrap.resultingDocumentRevision || !exactOrder || !exactRevisions) {
        throw new PageStorageError("stale_undo", "The workbook changed after this Scrap was created.");
      }
      const beforeById = new Map(scrap.beforePages.map((page) => [page.id, page]));
      const changedIds = current.pages.filter((page) => {
        const before = beforeById.get(page.id);
        return before === undefined || pageContentFingerprint(page) !== pageContentFingerprint(before);
      }).map((page) => page.id);
      if (changedIds.length === 0) throw new PageStorageError("no_op", "The Scrap content is already restored.");
      if (changedIds.some((pageId) => !input.visiblePageIds.includes(pageId))) {
        throw new PageStorageError("page_not_visible", "Open every affected page before restoring this Scrap.");
      }
      const now = nowIso(this.options);
      for (const pageId of changedIds) {
        const claim = await transaction.objectStore("pageWriterClaims").get(pageId);
        if (claim !== undefined && claim.expiresAt > now) {
          const exact = input.claimId !== undefined && claim.workbookId === input.workbookId && claim.actorId === input.actorId && claim.claimId === input.claimId;
          if (!exact) throw new PageStorageError("page_busy", `Page ${pageId} is being edited under a different writer claim.`);
        }
      }
      const restoredPages = current.pages.map((page) => {
        if (!changedIds.includes(page.id)) return page;
        const before = beforeById.get(page.id);
        if (before === undefined) throw new PageStorageError("stale_undo", "The Scrap does not contain the page required for restore.");
        return validatePage({ ...before, revision: createPageRevision(page.revision + 1), updatedAt: now });
      });
      const restored = validatePageDocument({ ...current, pages: restoredPages });
      const receipt: PageReceipt = {
        id: createPageReceiptId(this.options.ids?.newReceiptId?.() ?? `phase11:receipt:${input.mutationId}`),
        workbookId: input.workbookId,
        mutationId: input.mutationId,
        actorId: input.actorId,
        source: input.source,
        kind: "page_scrap_restore",
        completedAt: now,
        beforeDocument: current,
        beforePages: current.pages,
        affectedPageIds: changedIds,
        resultingDocumentRevision: restored.documentRevision,
        resultingPageRevisions: Object.fromEntries(restored.pages.map((page) => [page.id, page.revision])),
        undo: { kind: "unavailable" },
      };
      await transaction.objectStore("pageDocuments").put(rowFromDocument(restored));
      for (const page of restored.pages) if (changedIds.includes(page.id)) await transaction.objectStore("pages").put(rowFromPage(page));
      await transaction.objectStore("pageReceipts").add(rowFromReceipt(receipt, fingerprint));
      this.options.failureHook?.("page.scrap.restore.receipt-write");
      await transaction.done;
      return { status: "committed", document: restored, receipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  public async undo(input: PageUndoInput): Promise<PageCommitResult> {
    const database = await this.getDatabase();
    const transaction = database.transaction(["pageDocuments", "pages", "pageReceipts", "pageWriterClaims"], "readwrite") as Transaction;
    try {
      const fingerprint = undoFingerprint(input);
      const duplicate = await transaction.objectStore("pageReceipts").index("byMutationId").get(input.mutationId);
      if (duplicate !== undefined) {
        if (duplicate.fingerprint !== fingerprint) throw new PageStorageError("mutation_reuse", "The mutation id was already used for a different Undo.");
        return { status: "duplicate", document: await this.readInTransaction(transaction, input.workbookId), receipt: decodePageReceipt(duplicate) };
      }
      const raw = await transaction.objectStore("pageReceipts").get(input.receiptId);
      if (raw === undefined) throw new PageStorageError("not_found", "The page receipt was not found.");
      const source = decodePageReceipt(raw);
      if (source.workbookId !== input.workbookId) throw new PageStorageError("invalid_page", "The page receipt belongs to another workbook.");
      if (source.undo.kind === "consumed") throw new PageStorageError("already_undone", "The page receipt has already been undone.");
      if (source.undo.kind !== "available") throw new PageStorageError("stale_undo", "The page receipt cannot be undone.");
      const current = await this.readInTransaction(transaction, input.workbookId);
      const affected = new Set(source.affectedPageIds);
      const compositionUndoVisible = source.kind === "page_composition_apply" && input.visiblePageIds.some((pageId) => affected.has(pageId));
      if (!compositionUndoVisible && [...affected].some((pageId) => !input.visiblePageIds.includes(pageId))) {
        throw new PageStorageError("page_not_visible", "Open every affected page before using Undo.");
      }
      const topologyChanged = current.pageOrder.length !== source.beforeDocument.pageOrder.length ||
        current.pageOrder.some((pageId, index) => pageId !== source.beforeDocument.pageOrder[index]);
      for (const pageId of affected) {
        const currentPage = current.pages.find((page) => page.id === pageId);
        const expected = source.resultingPageRevisions[pageId];
        if (currentPage === undefined || expected === undefined || currentPage.revision !== expected) throw new PageStorageError("stale_undo", "The page changed after this receipt.");
      }
      if (current.documentRevision !== source.resultingDocumentRevision) throw new PageStorageError("stale_undo", "The workbook changed after this receipt.");
      const now = nowIso(this.options);
      for (const pageId of affected) {
        const claim = await transaction.objectStore("pageWriterClaims").get(pageId);
        if (claim !== undefined && claim.expiresAt > now) {
          const exact = input.claimId !== undefined && claim.workbookId === input.workbookId && claim.actorId === input.actorId && claim.claimId === input.claimId;
          if (!exact) throw new PageStorageError("page_busy", `Page ${pageId} is held by a different writer claim.`);
        }
      }
      const beforeById = new Map(source.beforePages.map((page) => [page.id, page]));
      const restoredPages = source.beforeDocument.pageOrder.map((pageId) => {
        const before = beforeById.get(pageId);
        const currentPage = current.pages.find((page) => page.id === pageId);
        if (before === undefined || currentPage === undefined) throw new PageStorageError("stale_undo", "The page state required for Undo is unavailable.");
        return affected.has(pageId)
          ? { ...before, revision: createPageRevision(currentPage.revision + 1), updatedAt: now }
          : currentPage;
      });
      const next: PageDocument = validatePageDocument({
        ...current,
        documentRevision: topologyChanged ? createDocumentRevision(current.documentRevision + 1) : current.documentRevision,
        pageOrder: topologyChanged ? source.beforeDocument.pageOrder : current.pageOrder,
        pages: topologyChanged ? restoredPages : current.pages.map((page) => {
          const before = beforeById.get(page.id);
          return before !== undefined && affected.has(page.id)
            ? { ...before, revision: createPageRevision(page.revision + 1), updatedAt: now }
            : page;
        }),
      });
      const undoReceipt: PageReceipt = {
        id: createPageReceiptId(this.options.ids?.newReceiptId?.() ?? `phase3:receipt:${input.mutationId}`),
        workbookId: input.workbookId,
        mutationId: input.mutationId,
        actorId: input.actorId,
        source: input.source,
        kind: "page_undo",
        completedAt: now,
        beforeDocument: current,
        beforePages: current.pages,
        affectedPageIds: [...affected],
        resultingDocumentRevision: next.documentRevision,
        resultingPageRevisions: Object.fromEntries(next.pages.map((page) => [page.id, page.revision])),
        undo: { kind: "unavailable" },
      };
      const consumed: PageReceiptRow = { ...raw, undo: { kind: "consumed", by: undoReceipt.id } };
      await transaction.objectStore("pageDocuments").put(rowFromDocument(next));
      for (const page of next.pages) if (affected.has(page.id)) await transaction.objectStore("pages").put(rowFromPage(page));
      if (topologyChanged) {
        const restoredIds = new Set(next.pageOrder);
        for (const page of current.pages) {
          if (!restoredIds.has(page.id)) await transaction.objectStore("pages").delete(page.id);
        }
      }
      this.options.failureHook?.("page.undo.after-page");
      await transaction.objectStore("pageReceipts").put(consumed);
      await transaction.objectStore("pageReceipts").add(rowFromReceipt(undoReceipt, fingerprint));
      this.options.failureHook?.("page.undo.receipt-write");
      await transaction.done;
      return { status: "committed", document: next, receipt: undoReceipt };
    } catch (error: unknown) {
      return abortAndRethrow(transaction, error);
    }
  }

  private async readInTransaction(transaction: Transaction, workbookId: WorkbookId): Promise<PageDocument> {
    const row = await transaction.objectStore("pageDocuments").get(workbookId);
    if (row === undefined) throw new PageStorageError("not_found", `Workbook ${workbookId} was not found.`);
    const pages = await transaction.objectStore("pages").index("byWorkbookId").getAll(workbookId);
    return decodePageDocument(row, pages.map(decodePageRow));
  }

  private async readInScrapTransaction(transaction: ScrapTransaction, workbookId: WorkbookId): Promise<PageDocument> {
    const row = await transaction.objectStore("pageDocuments").get(workbookId);
    if (row === undefined) throw new PageStorageError("not_found", `Workbook ${workbookId} was not found.`);
    const pages = await transaction.objectStore("pages").index("byWorkbookId").getAll(workbookId);
    return decodePageDocument(row, pages.map(decodePageRow));
  }
}

function rowFromMigration(report: PageMigrationReport, completedAt: IsoInstant): PageMigrationRow {
  return {
    id: report.migrationId,
    workbookId: report.workbookId,
    version: 1,
    status: "complete",
    completedAt,
    migratedNoteIds: [...report.migratedNoteIds],
    migratedCanvas: report.migratedCanvas,
    issues: [...report.issues],
  };
}
