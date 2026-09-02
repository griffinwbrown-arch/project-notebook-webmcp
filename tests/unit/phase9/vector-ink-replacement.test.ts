import fixtureSource from "../../fixtures/phase9/neutral-vector-replacement.json";
import { describe, expect, it } from "vitest";

import { createIsoInstant, createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import {
  createPageCommandRegistry,
  createActorId,
  createMutationId,
  createPageRevision,
  type PageCommandRegistry,
  type PageElement,
  type PageRecord,
  type PageVectorInkElement,
  type VectorInkDocument,
  type VectorInkProvenance,
  validateVectorInkDocument,
  validateVectorInkProvenance,
  validatePage,
  validatePageDocument,
  validateVectorInkReplacementHistory,
} from "../../../src/page";

const at = "2026-08-29T04:00:00.000Z";
let sequence = 0;

const fixture = {
  label: fixtureSource.label,
  description: fixtureSource.description,
  frame: fixtureSource.frame,
  before: validateVectorInkDocument(fixtureSource.before),
  after: validateVectorInkDocument(fixtureSource.after),
  beforeProvenance: validateVectorInkProvenance(fixtureSource.beforeProvenance),
  afterProvenance: validateVectorInkProvenance(fixtureSource.afterProvenance),
} satisfies Readonly<{
  label: string;
  description: string;
  frame: Readonly<{ x: number; y: number; width: number; height: number }>;
  before: VectorInkDocument;
  after: VectorInkDocument;
  beforeProvenance: VectorInkProvenance;
  afterProvenance: VectorInkProvenance;
}>;

type TestRig = Readonly<{
  databaseName: string;
  storage: IndexedDbPageStorage;
  registry: PageCommandRegistry;
  target: PageVectorInkElement;
  unrelated: PageElement;
  relationship: PageElement;
}>;

function nextDatabaseName(prefix: string): string {
  sequence += 1;
  return `phase9-vector-replacement-${prefix}-${sequence}`;
}

function createStorage(databaseName: string): IndexedDbPageStorage {
  return new IndexedDbPageStorage({ databaseName, clock: { now: () => at } });
}

async function setupRig(prefix: string): Promise<TestRig> {
  const databaseName = nextDatabaseName(prefix);
  const storage = createStorage(databaseName);
  const registry = await createPageCommandRegistry(storage, createNotebookId(`phase9-${prefix}`));

  const added = await registry.executeExternal("page_vector_ink_add", {
    mutationId: `${prefix}-target`, expectedRevision: 1, frame: fixture.frame,
    document: fixture.before, label: fixture.label, description: fixture.description,
    provenance: fixture.beforeProvenance,
  }, "webmcp");
  if (added.outcome !== "success") throw new Error(`Could not add target: ${added.error.message}`);
  const target = registry.getDocument().pages[0]?.elements[0];
  if (target?.kind !== "vector-ink") throw new Error("Expected the neutral vector target.");

  const text = await registry.executeManual("page_text_insert", {
    mutationId: `${prefix}-unrelated`, expectedRevision: 2,
    text: "Unrelated page content must remain exact.", label: "Unrelated note",
    frame: { x: 440, y: 100, width: 240, height: 120 },
  });
  if (text.outcome !== "success") throw new Error(`Could not add unrelated content: ${text.error.message}`);
  const unrelated = registry.getDocument().pages[0]?.elements.find((element) => element.kind === "text");
  if (unrelated === undefined) throw new Error("Expected unrelated text.");

  const reviewed = await registry.executeExternal("page_review_callout_add", {
    mutationId: `${prefix}-relationship`, expectedRevision: 3,
    target: { kind: "element", elementId: target.id }, reviewKind: "replacement",
    text: "Review this exact figure.",
  }, "webmcp");
  if (reviewed.outcome !== "success") throw new Error(`Could not add relationship: ${reviewed.error.message}`);
  const relationship = registry.getDocument().pages[0]?.elements.find((element) =>
    element.kind === "annotation" && element.reviewKind === "replacement");
  if (relationship === undefined) throw new Error("Expected an exact replacement relationship.");
  return { databaseName, storage, registry, target, unrelated, relationship };
}

function proposeInput(target: PageVectorInkElement, overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    targetElementId: target.id, expectedRevision: 4,
    document: fixture.after,
    provenance: fixture.afterProvenance, ...overrides,
  };
}

function reviewingProposal(registry: PageCommandRegistry) {
  const review = registry.getVectorInkReplacementReviewSnapshot();
  if (review.kind !== "reviewing" && review.kind !== "apply-error") {
    throw new Error(`Expected an active replacement review, received ${review.kind}.`);
  }
  return review.proposal;
}

async function readStore(database: IDBDatabase, storeName: string): Promise<readonly unknown[]> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not read ${storeName}.`));
  });
}

async function rawDatabaseSnapshot(databaseName: string): Promise<string> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the page database."));
  });
  try {
    const stores = ["pageDocuments", "pages", "pageReceipts", "pageWriterClaims"] as const;
    const entries = await Promise.all(stores.map(async (storeName) => {
      const rows = await readStore(database, storeName);
      return [storeName, [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))] as const;
    }));
    return JSON.stringify(Object.fromEntries(entries));
  } finally {
    database.close();
  }
}

async function durableState(rig: TestRig): Promise<Readonly<{ document: string; context: string; rows: string }>> {
  return {
    document: JSON.stringify(rig.registry.getDocument()),
    context: JSON.stringify(rig.registry.getSnapshot()),
    rows: await rawDatabaseSnapshot(rig.databaseName),
  };
}

async function seedDuplicateTargetOnSecondPage(rig: TestRig): Promise<void> {
  const workbookId = rig.registry.getDocument().workbookId;
  const withSecondPage = await rig.storage.appendPage(workbookId, rig.registry.getDocument().documentRevision);
  const secondPage = withSecondPage.pages[1];
  if (secondPage === undefined) throw new Error("Expected a second page.");
  const nextSecondPage = validatePage({
    ...secondPage,
    revision: createPageRevision(secondPage.revision + 1),
    updatedAt: createIsoInstant(at),
    elements: [rig.target],
  });
  const nextDocument = validatePageDocument({
    ...withSecondPage,
    pages: withSecondPage.pages.map((page) => page.id === nextSecondPage.id ? nextSecondPage : page),
  });
  await rig.storage.commit({
    workbookId,
    nextDocument,
    pageIds: [nextSecondPage.id],
    expectedDocumentRevision: withSecondPage.documentRevision,
    expectedPageRevisions: { [nextSecondPage.id]: secondPage.revision },
    mutationId: createMutationId("phase9-seed-duplicate-target"),
    actorId: createActorId("phase9-test-fixture"),
    source: "person",
    kind: "phase9_test_fixture",
  });
  await rig.registry.refresh();
}

function semanticPage(value: PageRecord): Omit<PageRecord, "revision" | "updatedAt"> {
  const { revision: _revision, updatedAt: _updatedAt, ...semantic } = value;
  void _revision;
  void _updatedAt;
  return semantic;
}

describe("Phase 9 vector ink replacement", () => {
  it("rejects unsupported, excessive, and oversized replacement history", () => {
    const baseRecord = {
      kind: "typed-vector-document-replacement" as const,
      version: 1 as const,
      priorProvenance: fixture.beforeProvenance,
      newProvenance: fixture.afterProvenance,
    };
    expect(() => validateVectorInkReplacementHistory([{ ...baseRecord, version: 2 }])).toThrow(/history|version|invalid/i);
    expect(() => validateVectorInkReplacementHistory(Array.from({ length: 33 }, () => baseRecord))).toThrow(/history|32|array|entries/i);

    const longPortable = "é".repeat(160);
    const longProvenance = {
      kind: "é".repeat(80),
      sourceLabel: longPortable,
      sourceFormat: longPortable,
      tool: longPortable,
      toolVersion: longPortable,
    };
    const oversizedRecord = {
      ...baseRecord,
      priorProvenance: longProvenance,
      newProvenance: longProvenance,
    };
    expect(() => validateVectorInkReplacementHistory(Array.from({ length: 32 }, () => oversizedRecord)))
      .toThrow(/65536|bytes|history/i);
  });

  it("exposes a typed review proposal and keeps apply manual-only", async () => {
    const storage = createStorage(nextDatabaseName("descriptors"));
    try {
      const registry = await createPageCommandRegistry(storage, createNotebookId("phase9-descriptors"));
      const webMcp = registry.describe("webmcp");
      const manual = registry.describe("manual");
      expect(webMcp).toContainEqual(expect.objectContaining({
        name: "page_vector_ink_replace_propose", readOnly: false,
        exposure: expect.objectContaining({ manual: false, webmcp: true }),
      }));
      expect(webMcp.some((descriptor) => descriptor.name === "page_vector_ink_replace_apply")).toBe(false);
      expect(manual).toContainEqual(expect.objectContaining({
        name: "page_vector_ink_replace_apply", readOnly: false,
        exposure: expect.objectContaining({ manual: true, webmcp: false }),
      }));
    } finally {
      await storage.close();
    }
  });

  it("stages the exact typed documents without changing durable state", async () => {
    const rig = await setupRig("proposal");
    try {
      const before = await durableState(rig);
      const result = await rig.registry.executeExternal("page_vector_ink_replace_propose", proposeInput(rig.target), "webmcp");
      expect(result.outcome).toBe("success");
      expect(await durableState(rig)).toEqual(before);
      const proposal = reviewingProposal(rig.registry);
      expect(proposal).toMatchObject({
        kind: "vector-ink-replacement-proposal",
        version: 1,
        elementId: rig.target.id,
        pageRevision: 4,
        priorDocument: fixture.before,
        priorProvenance: fixture.beforeProvenance,
        newDocument: fixture.after,
        newProvenance: fixture.afterProvenance,
      });
    } finally {
      await rig.storage.close();
    }
  });

  it("keeps the reviewed proposal exact when another proposal arrives and discards it without a write", async () => {
    const rig = await setupRig("review-guard");
    try {
      await rig.registry.executeExternal("page_vector_ink_replace_propose", proposeInput(rig.target), "webmcp");
      const proposal = reviewingProposal(rig.registry);
      const reviewBefore = rig.registry.getVectorInkReplacementReviewSnapshot();
      const durableBefore = await durableState(rig);

      const invalid = await rig.registry.executeExternal("page_vector_ink_replace_propose", {
        ...proposeInput(rig.target),
        document: { ...fixture.after, version: 2 },
      }, "webmcp");
      expect(invalid.outcome).toBe("error");
      if (invalid.outcome !== "error") throw new Error("Expected the invalid competing proposal to fail.");
      expect(["INPUT_VALIDATION_ERROR", "REPLACEMENT_REVIEW_IN_PROGRESS"]).toContain(invalid.error.code);
      expect(rig.registry.getVectorInkReplacementReviewSnapshot()).toEqual(reviewBefore);
      expect(await durableState(rig)).toEqual(durableBefore);

      const second = await rig.registry.executeExternal(
        "page_vector_ink_replace_propose",
        proposeInput(rig.target),
        "webmcp",
      );
      expect(second).toMatchObject({ outcome: "error", error: { code: "REPLACEMENT_REVIEW_IN_PROGRESS" } });
      expect(rig.registry.getVectorInkReplacementReviewSnapshot()).toEqual(reviewBefore);
      expect(await durableState(rig)).toEqual(durableBefore);

      expect(rig.registry.discardVectorInkReplacementProposal(proposal.proposalId)).toBe(true);
      expect(rig.registry.getVectorInkReplacementReviewSnapshot()).toEqual({ kind: "closed" });
      expect(await durableState(rig)).toEqual(durableBefore);
    } finally {
      await rig.storage.close();
    }
  });

  it("applies one reviewed replacement while preserving identity, placement, relationships, and unrelated content", async () => {
    const rig = await setupRig("apply");
    try {
      const beforeDocument = rig.registry.getDocument();
      const beforePage = beforeDocument.pages[0];
      if (beforePage === undefined) throw new Error("Expected the target page.");
      const receiptsBefore = JSON.parse(await rawDatabaseSnapshot(rig.databaseName)) as Readonly<{ pageReceipts: readonly unknown[] }>;
      await rig.registry.executeExternal("page_vector_ink_replace_propose", proposeInput(rig.target), "webmcp");
      const proposal = reviewingProposal(rig.registry);
      const applied = await rig.registry.executeManual("page_vector_ink_replace_apply", {
        proposalId: proposal.proposalId, mutationId: "phase9-apply-reviewed",
      });
      expect(applied).toMatchObject({
        outcome: "success",
        output: { context: { documentRevision: beforeDocument.documentRevision, pageRevision: beforePage.revision + 1 }, receipt: { kind: "page_vector_ink_replace_apply" } },
      });
      if (applied.outcome !== "success" || applied.output.receipt === undefined) throw new Error("Expected a replacement receipt.");
      const afterPage = rig.registry.getDocument().pages[0];
      const afterTarget = afterPage?.elements.find((element) => element.id === rig.target.id);
      if (afterTarget?.kind !== "vector-ink") throw new Error("Expected the replaced vector.");
      const { document: _oldDocument, provenance: _oldProvenance, replacementHistory: _oldHistory, ...beforeIdentity } = rig.target;
      const { document: _newDocument, provenance: _newProvenance, replacementHistory: _newHistory, ...afterIdentity } = afterTarget;
      void _oldDocument;
      void _oldProvenance;
      void _oldHistory;
      void _newDocument;
      void _newProvenance;
      void _newHistory;
      expect(afterIdentity).toEqual(beforeIdentity);
      expect(afterTarget.document).toEqual(fixture.after);
      expect(afterTarget.provenance).toEqual(fixture.afterProvenance);
      expect(afterTarget.replacementHistory).toEqual([{
          version: 1,
          kind: "typed-vector-document-replacement",
          priorProvenance: fixture.beforeProvenance,
          newProvenance: fixture.afterProvenance,
      }]);
      expect(afterPage?.elements.find((element) => element.id === rig.unrelated.id)).toEqual(rig.unrelated);
      expect(afterPage?.elements.find((element) => element.id === rig.relationship.id)).toEqual(rig.relationship);
      expect(afterPage?.elements.map((element) => element.id)).toEqual(beforePage.elements.map((element) => element.id));
      const receiptsAfter = JSON.parse(await rawDatabaseSnapshot(rig.databaseName)) as Readonly<{ pageReceipts: readonly unknown[] }>;
      expect(receiptsAfter.pageReceipts).toHaveLength(receiptsBefore.pageReceipts.length + 1);

      const retry = await rig.registry.executeManual("page_vector_ink_replace_apply", {
        proposalId: proposal.proposalId, mutationId: "phase9-apply-reviewed",
      });
      expect(retry).toMatchObject({ outcome: "success", output: { receipt: { id: applied.output.receipt.id } } });
      expect(rig.registry.getSnapshot().pageRevision).toBe(beforePage.revision + 1);
      const receiptsAfterRetry = JSON.parse(await rawDatabaseSnapshot(rig.databaseName)) as Readonly<{ pageReceipts: readonly unknown[] }>;
      expect(receiptsAfterRetry.pageReceipts).toHaveLength(receiptsAfter.pageReceipts.length);
    } finally {
      await rig.storage.close();
    }
  });

  it("rejects every malformed, unsafe, stale, unsupported, or exact no-op proposal without changing state", async () => {
    const rig = await setupRig("reject");
    try {
      const tooManyCommands = [
        { kind: "move", x: 0, y: 0 },
        ...Array.from({ length: 20_000 }, (_, index) => ({ kind: "line", x: index % 100, y: Math.floor(index / 100) % 100 })),
      ];
      const firstPath = fixture.after.paths[0];
      if (firstPath === undefined) throw new Error("Expected fixture path.");
      const cases = [
        { name: "missing", input: proposeInput(rig.target, { targetElementId: "phase9:missing" }), code: "TARGET_NOT_FOUND" },
        { name: "non-vector", input: proposeInput(rig.target, { targetElementId: rig.unrelated.id }), code: "TARGET_NOT_VECTOR_INK" },
        { name: "selector-shaped", input: proposeInput(rig.target, { targetElementId: { kind: "phrase", phrase: fixture.label } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "stale-revision", input: proposeInput(rig.target, { expectedRevision: 3 }), code: "STALE_REPLACEMENT" },
        { name: "exact-no-op", input: proposeInput(rig.target, { document: fixture.before }), code: "VECTOR_INK_NO_OP" },
        { name: "malformed", input: proposeInput(rig.target, { document: { ...fixture.after, paths: [] } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "unsafe-paint", input: proposeInput(rig.target, { document: { ...fixture.after, paths: [{ ...firstPath, paint: { ...firstPath.paint, stroke: "url(remote)" } }] } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "unsafe-provenance", input: proposeInput(rig.target, { provenance: { ...fixture.afterProvenance, sourceLabel: "https://remote.invalid/vector" } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "too-many-commands", input: proposeInput(rig.target, { document: { ...fixture.after, paths: [{ commands: tooManyCommands, paint: firstPath.paint }] } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "oversized", input: proposeInput(rig.target, { document: { ...fixture.after, paths: [{ commands: tooManyCommands.slice(0, 18_000), paint: firstPath.paint }] } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "out-of-bounds", input: proposeInput(rig.target, { document: { ...fixture.after, paths: [{ ...firstPath, commands: [{ kind: "move", x: 0, y: 0 }, { kind: "line", x: 101, y: 50 }] }] } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "unsupported-document-version", input: proposeInput(rig.target, { document: { ...fixture.after, version: 2 } }), code: "INPUT_VALIDATION_ERROR" },
        { name: "unsupported-replacement-version", input: { ...proposeInput(rig.target), version: 2 }, code: "INPUT_VALIDATION_ERROR" },
      ] as const;

      for (const rejected of cases) {
        const before = await durableState(rig);
        const reviewBefore = rig.registry.getVectorInkReplacementReviewSnapshot();
        const result = await rig.registry.executeExternal("page_vector_ink_replace_propose", rejected.input, "webmcp");
        expect(result, rejected.name).toMatchObject({ outcome: "error", error: { code: rejected.code } });
        expect(await durableState(rig), rejected.name).toEqual(before);
        expect(rig.registry.getVectorInkReplacementReviewSnapshot(), rejected.name).toEqual(reviewBefore);
      }
    } finally {
      await rig.storage.close();
    }
  });

  it("rejects a stale Apply without publishing the fresh persisted page", async () => {
    const rig = await setupRig("stale-apply");
    try {
      await rig.registry.executeExternal("page_vector_ink_replace_propose", proposeInput(rig.target), "webmcp");
      const proposal = reviewingProposal(rig.registry);
      const secondStorage = createStorage(rig.databaseName);
      try {
        const second = await createPageCommandRegistry(secondStorage, rig.registry.getDocument().workbookId);
        const changed = await second.executeManual("page_text_insert", {
          mutationId: "phase9-intervening-edit", expectedRevision: 4,
          text: "An intervening edit makes the proposal stale.", frame: { x: 440, y: 600, width: 240, height: 100 },
        });
        expect(changed.outcome).toBe("success");
      } finally {
        await secondStorage.close();
      }
      const registryBefore = JSON.stringify(rig.registry.getDocument());
      const contextBefore = JSON.stringify(rig.registry.getSnapshot());
      const rowsBefore = await rawDatabaseSnapshot(rig.databaseName);
      const result = await rig.registry.executeManual("page_vector_ink_replace_apply", {
        proposalId: proposal.proposalId, mutationId: "phase9-stale-apply",
      });
      expect(result).toMatchObject({ outcome: "error", error: { code: "STALE_REPLACEMENT" } });
      expect(JSON.stringify(rig.registry.getDocument())).toBe(registryBefore);
      expect(JSON.stringify(rig.registry.getSnapshot())).toBe(contextBefore);
      expect(await rawDatabaseSnapshot(rig.databaseName)).toBe(rowsBefore);
      expect(rig.registry.getVectorInkReplacementReviewSnapshot()).toMatchObject({ kind: "apply-error" });
    } finally {
      await rig.storage.close();
    }
  });

  it("rejects an exact element ID that is ambiguous across pages without changing state", async () => {
    const rig = await setupRig("ambiguous");
    try {
      await seedDuplicateTargetOnSecondPage(rig);
      const before = await durableState(rig);
      const result = await rig.registry.executeExternal(
        "page_vector_ink_replace_propose",
        proposeInput(rig.target),
        "webmcp",
      );
      expect(result).toMatchObject({ outcome: "error", error: { code: "TARGET_AMBIGUOUS" } });
      expect(await durableState(rig)).toEqual(before);
      expect(rig.registry.getVectorInkReplacementReviewSnapshot()).toEqual({ kind: "closed" });
    } finally {
      await rig.storage.close();
    }
  });

  it("persists the replacement across reopen and exact Undo restores the prior vector and provenance", async () => {
    const rig = await setupRig("reopen-undo");
    const workbookId = rig.registry.getDocument().workbookId;
    const beforePage = rig.registry.getDocument().pages[0];
    if (beforePage === undefined) throw new Error("Expected the target page.");
    await rig.registry.executeExternal("page_vector_ink_replace_propose", proposeInput(rig.target), "webmcp");
    const proposal = reviewingProposal(rig.registry);
    const applied = await rig.registry.executeManual("page_vector_ink_replace_apply", {
      proposalId: proposal.proposalId, mutationId: "phase9-reopen-apply",
    });
    if (applied.outcome !== "success" || applied.output.receipt === undefined) throw new Error("Expected replacement receipt.");
    await rig.storage.close();

    const reopenedStorage = createStorage(rig.databaseName);
    try {
      const reopened = await createPageCommandRegistry(reopenedStorage, workbookId);
      const reopenedTarget = reopened.getDocument().pages[0]?.elements.find((element) => element.id === rig.target.id);
      expect(reopenedTarget).toMatchObject({ kind: "vector-ink", document: fixture.after, provenance: fixture.afterProvenance });
      const undone = await reopened.executeManual("page_undo", {
        mutationId: "phase9-reopen-undo", receiptId: applied.output.receipt.id,
      });
      expect(undone).toMatchObject({ outcome: "success", output: { receipt: { kind: "page_undo" } } });
      const restoredPage = reopened.getDocument().pages[0];
      if (restoredPage === undefined) throw new Error("Expected the restored page.");
      expect(semanticPage(restoredPage)).toEqual(semanticPage(beforePage));
      expect(restoredPage.elements.find((element) => element.id === rig.target.id)).toEqual(rig.target);
    } finally {
      await reopenedStorage.close();
    }
  });
});
