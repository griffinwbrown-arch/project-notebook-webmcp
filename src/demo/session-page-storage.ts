import type { PageWriterClaimRow } from "../indexeddb/database";
import {
  PageStorageError,
  type PageCommitInput,
  type PageCommitResult,
  type PageMigrationReport,
  type PageReworkInput,
  type PageReworkResult,
  type PageScrap,
  type PageScrapRestoreInput,
  type PageStorage,
  type PageUndoInput,
  type PageWriterClaimInput,
} from "../indexeddb/page-storage";
import {
  appendPage,
  createActorId,
  createDocumentRevision,
  createEmptyPageDocument,
  createMutationId,
  createPageReceiptId,
  createPageRevision,
  validatePage,
  validatePageDocument,
  type DocumentRevision,
  type PageDocument,
  type PageId,
  type PageReceiptId,
  type PageRevision,
  type PageScrapId,
  type WorkbookId,
} from "../page";
import { createIsoInstant } from "../domain";

export const DEMO_STORAGE_LIMITS = {
  appliedChanges: 24,
  pagesPerNotebook: 8,
  documentBytes: 512_000,
  scrapsPerNotebook: 4,
} as const;

const DEFAULT_SESSION_KEY = "project-notebook-demo:page-documents:v4";

type SessionCache = Pick<Storage, "getItem" | "setItem">;

function browserSessionCache(): SessionCache | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

type StoredMutation = Readonly<{
  fingerprint: string;
  receipt: PageCommitResult["receipt"];
}>;

function clone<Value>(value: Value): Value {
  return structuredClone(value);
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

function pageFingerprint(document: PageDocument, pageId: PageId): string | null {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  return page === undefined ? null : fingerprint(page);
}

function now(): ReturnType<typeof createIsoInstant> {
  return createIsoInstant(new Date().toISOString());
}

function pageRevisions(document: PageDocument): Readonly<Record<string, PageRevision>> {
  return Object.fromEntries(document.pages.map((page) => [page.id, page.revision]));
}

function changedPageIds(before: PageDocument, after: PageDocument): readonly PageId[] {
  return [...new Set([...before.pageOrder, ...after.pageOrder])]
    .filter((pageId) => pageFingerprint(before, pageId) !== pageFingerprint(after, pageId));
}

function isPristineEmptyDocument(document: PageDocument): boolean {
  return document.documentRevision === 1 &&
    document.pages.length === 1 &&
    document.pages[0]?.revision === 1 &&
    document.pages[0].elements.length === 0;
}

export class SessionPageStorage implements PageStorage {
  private readonly documents = new Map<WorkbookId, PageDocument>();
  private readonly mutations = new Map<string, StoredMutation>();
  private readonly receipts = new Map<PageReceiptId, PageCommitResult["receipt"]>();
  private readonly claims = new Map<PageId, PageWriterClaimRow>();
  private readonly scraps = new Map<PageScrapId, PageScrap>();
  private readonly sessionCache: SessionCache | null;
  private readonly sessionKey: string;
  private appliedChanges = 0;

  public constructor(
    seedDocuments: readonly PageDocument[] = [],
    options: Readonly<{ sessionCache?: SessionCache | null; sessionKey?: string }> = {},
  ) {
    this.sessionCache = options.sessionCache === undefined ? browserSessionCache() : options.sessionCache;
    this.sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
    const restored = this.readSessionDocuments();
    for (const document of restored) {
      this.documents.set(document.workbookId, clone(validatePageDocument(document)));
    }
    for (const document of seedDocuments) {
      const existing = this.documents.get(document.workbookId);
      if (existing === undefined || isPristineEmptyDocument(existing)) {
        this.documents.set(document.workbookId, clone(validatePageDocument(document)));
      }
    }
    this.persistDocuments();
  }

  private readSessionDocuments(): readonly PageDocument[] {
    const serialized = this.sessionCache?.getItem(this.sessionKey);
    if (serialized === null || serialized === undefined) return [];
    try {
      const value: unknown = JSON.parse(serialized);
      if (!Array.isArray(value)) return [];
      return value.map((document) => validatePageDocument(document as PageDocument));
    } catch {
      return [];
    }
  }

  private persistDocuments(): void {
    if (this.sessionCache === null) return;
    this.sessionCache.setItem(this.sessionKey, JSON.stringify([...this.documents.values()]));
  }

  public getUsage(): Readonly<{
    appliedChanges: number;
    appliedChangesLimit: number;
    notebookCount: number;
  }> {
    return {
      appliedChanges: this.appliedChanges,
      appliedChangesLimit: DEMO_STORAGE_LIMITS.appliedChanges,
      notebookCount: this.documents.size,
    };
  }

  public async close(): Promise<void> {
    this.persistDocuments();
    return Promise.resolve();
  }

  public async read(workbookId: WorkbookId): Promise<PageDocument> {
    const document = this.documents.get(workbookId);
    if (document === undefined) throw new PageStorageError("not_found", `Workbook ${workbookId} was not found.`);
    return clone(document);
  }

  public async getDocument(workbookId: WorkbookId): Promise<PageDocument | null> {
    const document = this.documents.get(workbookId);
    return document === undefined ? null : clone(document);
  }

  public async ensureWorkbook(workbookId: WorkbookId): Promise<PageDocument> {
    const existing = await this.getDocument(workbookId);
    return existing ?? (await this.migrateWorkbook(workbookId)).document;
  }

  public async migrateWorkbook(workbookId: WorkbookId): Promise<Readonly<{ document: PageDocument; report: PageMigrationReport }>> {
    const existing = await this.getDocument(workbookId);
    const document = existing ?? createEmptyPageDocument(workbookId, now(), { paper: "blank" });
    this.documents.set(workbookId, clone(document));
    this.persistDocuments();
    return {
      document: clone(document),
      report: {
        migrationId: `session:${workbookId}`,
        workbookId,
        migratedNoteIds: [],
        migratedCanvas: false,
        issues: [],
      },
    };
  }

  public async appendPage(workbookId: WorkbookId, expectedDocumentRevision: DocumentRevision): Promise<PageDocument> {
    const current = await this.read(workbookId);
    const next = appendPage(current, now());
    return (await this.commit({
      workbookId,
      nextDocument: next,
      pageIds: [next.pages.at(-1)!.id],
      expectedDocumentRevision,
      expectedPageRevisions: {},
      mutationId: createMutationId(`session-append:${workbookId}:${next.documentRevision}`),
      actorId: createActorId("session-page-storage"),
      source: "person",
      kind: "page_advance",
    })).document;
  }

  public async claimPage(input: PageWriterClaimInput): Promise<PageWriterClaimRow> {
    const document = await this.read(input.workbookId);
    if (!document.pageOrder.includes(input.pageId)) {
      throw new PageStorageError("invalid_page", `Page ${input.pageId} does not belong to workbook ${input.workbookId}.`);
    }
    const instant = now();
    const existing = this.claims.get(input.pageId);
    if (existing !== undefined && existing.expiresAt > instant &&
      (existing.actorId !== input.actorId || existing.claimId !== input.claimId)) {
      throw new PageStorageError("page_busy", `Page ${input.pageId} is being edited by another assistant.`);
    }
    const row: PageWriterClaimRow = {
      pageId: input.pageId,
      workbookId: input.workbookId,
      actorId: input.actorId,
      claimId: input.claimId,
      acquiredAt: instant,
      expiresAt: new Date(Date.parse(instant) + Math.min(input.ttlMs ?? 30_000, 300_000)).toISOString(),
    };
    this.claims.set(input.pageId, row);
    return clone(row);
  }

  public async releasePageWriter(input: Pick<PageWriterClaimInput, "pageId" | "actorId" | "claimId">): Promise<void> {
    const existing = this.claims.get(input.pageId);
    if (existing?.actorId === input.actorId && existing.claimId === input.claimId) this.claims.delete(input.pageId);
  }

  public async listScraps(workbookId: WorkbookId): Promise<readonly PageScrap[]> {
    return [...this.scraps.values()]
      .filter((scrap) => scrap.workbookId === workbookId)
      .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))
      .map(clone);
  }

  public async getScrap(workbookId: WorkbookId, scrapId: PageScrapId): Promise<PageScrap | null> {
    const scrap = this.scraps.get(scrapId);
    if (scrap === undefined) return null;
    if (scrap.workbookId !== workbookId) throw new PageStorageError("invalid_page", "The Scrap belongs to another workbook.");
    return clone(scrap);
  }

  public async commit(input: PageCommitInput): Promise<PageCommitResult> {
    const next = validatePageDocument(clone(input.nextDocument));
    if (next.workbookId !== input.workbookId) throw new PageStorageError("invalid_page", "The document workbook does not match the commit target.");
    const mutationFingerprint = fingerprint(input);
    const duplicate = this.mutations.get(input.mutationId);
    if (duplicate !== undefined) {
      if (duplicate.fingerprint !== mutationFingerprint) throw new PageStorageError("mutation_reuse", "The mutation id was already used for different content.");
      return { status: "duplicate", document: await this.read(input.workbookId), receipt: clone(duplicate.receipt) };
    }
    if (this.appliedChanges >= DEMO_STORAGE_LIMITS.appliedChanges) {
      throw new PageStorageError("invalid_page", `This reload has reached its ${DEMO_STORAGE_LIMITS.appliedChanges}-change playground limit.`);
    }
    if (next.pages.length > DEMO_STORAGE_LIMITS.pagesPerNotebook) {
      throw new PageStorageError("invalid_page", `A demo notebook can contain at most ${DEMO_STORAGE_LIMITS.pagesPerNotebook} pages.`);
    }
    if (new TextEncoder().encode(JSON.stringify(next)).byteLength > DEMO_STORAGE_LIMITS.documentBytes) {
      throw new PageStorageError("invalid_page", "The demo notebook exceeds its 512 KB in-memory limit.");
    }
    const current = await this.read(input.workbookId);
    if (current.documentRevision !== input.expectedDocumentRevision) throw new PageStorageError("revision_conflict", "The workbook revision is stale.");
    const declared = [...new Set(input.pageIds)];
    if (declared.length === 0) throw new PageStorageError("no_op", "A page commit must declare one meaningful change.");
    const topologyChanged = fingerprint(current.pageOrder) !== fingerprint(next.pageOrder);
    const expectedDocumentRevision = topologyChanged
      ? createDocumentRevision(current.documentRevision + 1)
      : current.documentRevision;
    if (next.documentRevision !== expectedDocumentRevision) {
      throw new PageStorageError("revision_conflict", topologyChanged
        ? "A topology change must advance the document revision once."
        : "A page edit cannot change the document revision.");
    }
    const actualChanged = changedPageIds(current, next);
    if (actualChanged.length === 0) throw new PageStorageError("no_op", "The page command does not make a semantic change.");
    if (actualChanged.some((pageId) => !declared.includes(pageId))) {
      throw new PageStorageError("invalid_page", "The commit changes a page that was not declared.");
    }
    for (const pageId of declared) {
      const before = current.pages.find((page) => page.id === pageId);
      const after = next.pages.find((page) => page.id === pageId);
      if (before === undefined && after !== undefined) continue;
      if (before !== undefined && after === undefined && topologyChanged) {
        if (input.expectedPageRevisions[pageId] !== before.revision) throw new PageStorageError("revision_conflict", `Page ${pageId} changed before this action could be applied.`);
        continue;
      }
      if (before === undefined || after === undefined) throw new PageStorageError("invalid_page", `Page ${pageId} is missing.`);
      if (input.expectedPageRevisions[pageId] !== before.revision) throw new PageStorageError("revision_conflict", `Page ${pageId} is stale.`);
      if (after.revision !== createPageRevision(before.revision + 1)) throw new PageStorageError("revision_conflict", `Page ${pageId} must advance one revision.`);
      if (after.id !== before.id || after.workbookId !== before.workbookId || after.number !== before.number) {
        throw new PageStorageError("invalid_page", `Page ${pageId} cannot change identity.`);
      }
    }
    const instant = now();
    const receipt: PageCommitResult["receipt"] = {
      id: createPageReceiptId(`session:receipt:${input.mutationId}`),
      workbookId: input.workbookId,
      mutationId: input.mutationId,
      actorId: input.actorId,
      source: input.source,
      kind: input.kind,
      completedAt: instant,
      beforeDocument: clone(current),
      beforePages: clone(current.pages),
      affectedPageIds: actualChanged,
      resultingDocumentRevision: next.documentRevision,
      resultingPageRevisions: pageRevisions(next),
      undo: { kind: "available" },
    };
    this.documents.set(input.workbookId, clone(next));
    this.persistDocuments();
    this.receipts.set(receipt.id, receipt);
    this.mutations.set(input.mutationId, { fingerprint: mutationFingerprint, receipt });
    this.appliedChanges += 1;
    return { status: "committed", document: clone(next), receipt: clone(receipt) };
  }

  public async applyRework(input: PageReworkInput): Promise<PageReworkResult> {
    const current = await this.read(input.workbookId);
    const existingScraps = await this.listScraps(input.workbookId);
    if (existingScraps.length >= DEMO_STORAGE_LIMITS.scrapsPerNotebook) {
      throw new PageStorageError("invalid_page", "This demo notebook has reached its four-Scrap limit.");
    }
    const result = await this.commit({ ...input, kind: "page_rework_apply" });
    const scrap: PageScrap = {
      version: 1,
      id: input.scrapId,
      workbookId: input.workbookId,
      reason: input.reason.trim(),
      capturedBy: { kind: input.source === "person" ? "user" : "agent", id: input.actorId },
      capturedAt: result.receipt.completedAt,
      beforeDocument: current,
      beforePages: current.pages,
      assetReferences: current.pages.flatMap((page) => page.elements
        .filter((element) => element.kind === "embedded-frame" || element.kind === "diagram" || element.kind === "vector-ink")
        .map((element) => ({ kind: "page-element" as const, pageId: page.id, elementId: element.id }))),
      resultingDocumentRevision: result.document.documentRevision,
      resultingPageOrder: result.document.pageOrder,
      resultingPageRevisions: pageRevisions(result.document),
      reworkReceiptId: result.receipt.id,
    };
    this.scraps.set(scrap.id, clone(scrap));
    return { ...result, scrap: clone(scrap) };
  }

  public async restoreScrap(input: PageScrapRestoreInput): Promise<PageCommitResult> {
    const scrap = await this.getScrap(input.workbookId, input.scrapId);
    if (scrap === null) throw new PageStorageError("not_found", "The Scrap entry was not found.");
    const current = await this.read(input.workbookId);
    if (current.documentRevision !== scrap.resultingDocumentRevision ||
      current.pages.some((page) => scrap.resultingPageRevisions[page.id] !== page.revision)) {
      throw new PageStorageError("stale_undo", "The workbook changed after this Scrap was created.");
    }
    const affected = changedPageIds(scrap.beforeDocument, current);
    if (affected.some((pageId) => !input.visiblePageIds.includes(pageId))) {
      throw new PageStorageError("page_not_visible", "Open every affected page before restoring this Scrap.");
    }
    const instant = now();
    const beforeById = new Map(scrap.beforePages.map((page) => [page.id, page]));
    const restored = validatePageDocument({
      ...current,
      pages: current.pages.map((page) => {
        const before = beforeById.get(page.id);
        return before === undefined || !affected.includes(page.id)
          ? page
          : validatePage({ ...before, revision: createPageRevision(page.revision + 1), updatedAt: instant });
      }),
    });
    return this.commit({
      workbookId: input.workbookId,
      nextDocument: restored,
      pageIds: affected,
      expectedDocumentRevision: current.documentRevision,
      expectedPageRevisions: Object.fromEntries(current.pages.map((page) => [page.id, page.revision])),
      mutationId: input.mutationId,
      actorId: input.actorId,
      source: input.source,
      kind: "page_scrap_restore",
      ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
    });
  }

  public async undo(input: PageUndoInput): Promise<PageCommitResult> {
    const source = this.receipts.get(input.receiptId);
    if (source === undefined) throw new PageStorageError("not_found", "The page receipt was not found.");
    if (source.workbookId !== input.workbookId) throw new PageStorageError("invalid_page", "The receipt belongs to another workbook.");
    if (source.undo.kind !== "available") throw new PageStorageError("stale_undo", "The receipt cannot be undone.");
    const current = await this.read(input.workbookId);
    if (current.documentRevision !== source.resultingDocumentRevision ||
      source.affectedPageIds.some((pageId) => current.pages.find((page) => page.id === pageId)?.revision !== source.resultingPageRevisions[pageId])) {
      throw new PageStorageError("stale_undo", "The page changed after this receipt.");
    }
    const compositionUndoVisible = source.kind === "page_composition_apply" &&
      input.visiblePageIds.some((pageId) => source.affectedPageIds.includes(pageId));
    if (!compositionUndoVisible && source.affectedPageIds.some((pageId) => !input.visiblePageIds.includes(pageId))) {
      throw new PageStorageError("page_not_visible", "Open every affected page before using Undo.");
    }
    const topologyChanged = fingerprint(current.pageOrder) !== fingerprint(source.beforeDocument.pageOrder);
    const instant = now();
    const beforeById = new Map(source.beforePages.map((page) => [page.id, page]));
    const restoredPages = source.beforeDocument.pageOrder.map((pageId) => {
      const before = beforeById.get(pageId);
      const currentPage = current.pages.find((page) => page.id === pageId);
      if (before === undefined || currentPage === undefined) throw new PageStorageError("stale_undo", "The page state required for Undo is unavailable.");
      return source.affectedPageIds.includes(pageId)
        ? validatePage({ ...before, revision: createPageRevision(currentPage.revision + 1), updatedAt: instant })
        : currentPage;
    });
    const next = validatePageDocument({
      ...current,
      documentRevision: topologyChanged ? createDocumentRevision(current.documentRevision + 1) : current.documentRevision,
      pageOrder: topologyChanged ? source.beforeDocument.pageOrder : current.pageOrder,
      pages: topologyChanged ? restoredPages : current.pages.map((page) => {
        const restored = restoredPages.find((candidate) => candidate.id === page.id);
        return restored ?? page;
      }),
    });
    const result = await this.commit({
      workbookId: input.workbookId,
      nextDocument: next,
      pageIds: source.affectedPageIds,
      expectedDocumentRevision: current.documentRevision,
      expectedPageRevisions: Object.fromEntries(current.pages.map((page) => [page.id, page.revision])),
      mutationId: input.mutationId,
      actorId: input.actorId,
      source: input.source,
      kind: "page_undo",
      ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
    });
    const consumed = { ...source, undo: { kind: "consumed" as const, by: result.receipt.id } };
    this.receipts.set(source.id, consumed);
    return result;
  }
}
