import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADULT_SKELETON_BONES,
  ANATOMY_CATALOG_VERSION,
  ANATOMY_COLORING_COMPONENT,
  ANATOMY_EXAM_PREP_TEMPLATE,
  ANATOMY_SECTIONS,
  COLORING_LABS,
  VERIFIED_ATLAS_ASSET_ID,
  VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  VERIFIED_ATLAS_VERSION,
  applyAnatomyComposition,
  bonesForSection,
  createAnatomyCompositionProposal,
  isCorrectBoneAnswer,
  parseAnatomyComponent,
  scoreBoneAnswers,
  verifyAnatomyComposition,
} from "../../../src/anatomy";
import { createIsoInstant, createNotebookId } from "../../../src/domain";
import { IndexedDbPageStorage } from "../../../src/indexeddb";
import {
  createActorId,
  createDocumentRevision,
  createElementId,
  createEmptyPage,
  createEmptyPageDocument,
  createMutationId,
  createPageCommandRegistry,
  createPageRevision,
  validatePage,
  validatePageDocument,
} from "../../../src/page";

const at = createIsoInstant("2026-08-30T22:00:00.000Z");
const EXPECTED_ATLAS_BYTES = 7_206_984;
const EXPECTED_ATLAS_SHA256 = "a8a2dc6c2d8938541c814c23f1a04a6677d1af3fe68d38332239a2f301950a98";
let sequence = 0;

function pinnedAssetRoot(): string {
  return resolve(process.cwd(), "public", "assets", "anatomy");
}

function storage(prefix: string): IndexedDbPageStorage {
  sequence += 1;
  return new IndexedDbPageStorage({
    databaseName: `anatomy-composition-${prefix}-${sequence}`,
    clock: { now: () => at },
  });
}

describe("adult skeleton catalogue", () => {
  it("contains exactly 206 unique, sectioned adult bones", () => {
    expect(ADULT_SKELETON_BONES).toHaveLength(VERIFIED_ATLAS_LOGICAL_BONE_COUNT);
    expect(new Set(ADULT_SKELETON_BONES.map((bone) => bone.id)).size).toBe(VERIFIED_ATLAS_LOGICAL_BONE_COUNT);
    expect(new Set(ADULT_SKELETON_BONES.flatMap((bone) => [...bone.sourceObjects])).size).toBe(VERIFIED_ATLAS_SEMANTIC_MESH_COUNT);
    expect(ADULT_SKELETON_BONES.reduce((count, bone) => count + bone.sourceMeshCount, 0)).toBe(VERIFIED_ATLAS_SEMANTIC_MESH_COUNT);
    expect(ADULT_SKELETON_BONES.filter((bone) => bone.sourceMeshCount === 3)).toEqual([
      expect.objectContaining({ id: "sternum", sourceObjects: ["Body of sternum", "Manubrium of sternum", "Xiphoid process"] }),
    ]);
    expect(ANATOMY_SECTIONS.map((section) => [section.id, bonesForSection(section.id).length])).toEqual([
      ["skull", 29],
      ["vertebral-column", 26],
      ["thorax", 25],
      ["upper-limb", 64],
      ["pelvis", 2],
      ["lower-limb", 60],
    ]);
  });

  it("scores accepted anatomical names without accepting near-misses", () => {
    const pelvis = bonesForSection("pelvis");
    const left = pelvis.find((bone) => bone.side === "left");
    if (left === undefined) throw new Error("Expected the left hip bone.");
    expect(isCorrectBoneAnswer(left, "os coxae")).toBe(true);
    expect(isCorrectBoneAnswer(left, "femur")).toBe(false);
    expect(scoreBoneAnswers({ [left.id]: "left hip bone" }, pelvis)).toEqual({ correct: 1, total: 2, unanswered: 1 });
  });

  it("migrates a valid v1 coloring component to v2 without losing whole-bone colors", () => {
    const parsed = parseAnatomyComponent({
      kind: "embedded-frame",
      id: createElementId("legacy-coloring-component"),
      label: "Legacy pelvis coloring lab",
      frame: { x: 0, y: 0, width: 640, height: 480 },
      componentType: ANATOMY_COLORING_COMPONENT,
      componentVersion: 1,
      props: {
        kind: "anatomy-coloring-lab",
        assetId: VERIFIED_ATLAS_ASSET_ID,
        catalogVersion: ANATOMY_CATALOG_VERSION,
        atlasVersion: VERIFIED_ATLAS_VERSION,
        logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
        semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
        section: "pelvis",
        paletteVersion: "anatomy-study-palette-v1",
        assignments: [["left-hip-bone", "carmine"], ["right-hip-bone", "cobalt"]],
      },
    });
    expect(parsed).toEqual({
      kind: "coloring",
      props: {
        kind: "anatomy-coloring-lab",
        assetId: VERIFIED_ATLAS_ASSET_ID,
        catalogVersion: ANATOMY_CATALOG_VERSION,
        atlasVersion: VERIFIED_ATLAS_VERSION,
        logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
        semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
        section: "pelvis",
        paletteVersion: "anatomy-study-palette-v1",
        baseFills: [["left-hip-bone", "carmine"], ["right-hip-bone", "cobalt"]],
        surfaceStrokes: [],
      },
    });
  });
});

describe("bundled verified atlas asset", () => {
  it("ships the exact public anatomy atlas used by the renderer", async () => {
    const atlasPath = join(pinnedAssetRoot(), "authority-atlas-206.glb");
    expect((await stat(atlasPath)).size).toBe(EXPECTED_ATLAS_BYTES);
    const digest = createHash("sha256").update(await readFile(atlasPath)).digest("hex");
    expect(digest).toBe(EXPECTED_ATLAS_SHA256);
  });
});

describe("anatomy exam-prep composition commands", () => {
  it("proposes, atomically applies, verifies, and exactly undoes the seven-page anatomy workbook", async () => {
    const registry = await createPageCommandRegistry(storage("apply"), createNotebookId("anatomy-apply"));
    const proposalResult = await registry.executeExternal("page_composition_propose", { template: ANATOMY_EXAM_PREP_TEMPLATE }, "webmcp");
    expect(proposalResult.outcome).toBe("success");
    if (proposalResult.outcome !== "success") throw new Error("Expected a composition proposal.");
    const proposal = proposalResult.output.proposal;
    if (typeof proposal !== "object" || proposal === null || !("proposalId" in proposal) || typeof proposal.proposalId !== "string") {
      throw new Error("Expected a bounded proposal id.");
    }
    expect(proposal).toMatchObject({
      operation: "create",
      pageCount: 7,
      logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
      semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
    });
    const applied = await registry.executeExternal("page_composition_apply", {
      template: ANATOMY_EXAM_PREP_TEMPLATE,
      proposalId: proposal.proposalId,
      expectedDocumentRevision: 1,
      mutationId: "anatomy-apply-once",
    }, "webmcp");
    if (applied.outcome === "error") throw new Error(applied.error.message);
    expect(applied.outcome).toBe("success");
    expect(registry.getDocument().pages).toHaveLength(7);
    expect(registry.getDocument().documentRevision).toBe(2);
    expect(registry.getDocument().pages.every((page) => page.paper === "blank")).toBe(true);
    expect(registry.getDocument().pages[0]?.paper).toBe("blank");
    const skeletonElement = registry.getDocument().pages[0]?.elements[0];
    if (skeletonElement?.kind !== "embedded-frame") throw new Error("Expected the verified atlas on page 1.");
    expect(parseAnatomyComponent(skeletonElement)).toEqual({
      kind: "skeleton",
      props: {
        kind: "anatomy-skeleton",
        assetId: VERIFIED_ATLAS_ASSET_ID,
        catalogVersion: ANATOMY_CATALOG_VERSION,
        atlasVersion: VERIFIED_ATLAS_VERSION,
        logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
        semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
      },
    });
    expect(registry.getDocument().pages.slice(1).map((page) => {
      const element = page.elements[0];
      if (element?.kind !== "embedded-frame") throw new Error("Expected a coloring lab component.");
      const component = parseAnatomyComponent(element);
      if (component?.kind !== "coloring") throw new Error("Expected a parsed coloring lab.");
      return [component.props.section, component.props.baseFills.length, component.props.surfaceStrokes.length];
    })).toEqual(COLORING_LABS.map((lab) => [lab.section, 0, 0]));

    const verified = await registry.executeExternal("page_composition_verify", { template: ANATOMY_EXAM_PREP_TEMPLATE }, "webmcp");
    expect(verified).toMatchObject({
      outcome: "success",
      output: {
        verification: {
          status: "complete",
          pageCount: 7,
          skeletonComponentCount: 1,
          coloringComponentCount: 6,
          coloringSections: COLORING_LABS.map((lab) => lab.section),
          coloredBoneCount: 0,
          invalidComponents: 0,
          assetId: VERIFIED_ATLAS_ASSET_ID,
          catalogVersion: ANATOMY_CATALOG_VERSION,
          atlasVersion: VERIFIED_ATLAS_VERSION,
          logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
          semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
        },
      },
    });
    const completeDocument = registry.getDocument();
    const firstPage = completeDocument.pages[0];
    const firstColoringPage = completeDocument.pages[1];
    if (firstPage === undefined || firstColoringPage === undefined) throw new Error("Expected the completed anatomy pages.");
    const firstColoringElement = firstColoringPage.elements[0];
    if (firstColoringElement?.kind !== "embedded-frame") throw new Error("Expected the first coloring component.");
    const incompleteDocument = {
      ...completeDocument,
      pageOrder: completeDocument.pageOrder.slice(0, 6),
      pages: completeDocument.pages.slice(0, 6),
    };
    expect(verifyAnatomyComposition(incompleteDocument)).toMatchObject({ status: "incomplete", pageCount: 6 });

    const invalidElement = {
      ...firstColoringElement,
      props: {
        kind: "anatomy-coloring-lab",
        assetId: VERIFIED_ATLAS_ASSET_ID,
        catalogVersion: ANATOMY_CATALOG_VERSION,
        atlasVersion: VERIFIED_ATLAS_VERSION,
        logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
        semanticMeshCount: 207,
        section: "skull",
        paletteVersion: "anatomy-study-palette-v1",
        baseFills: [],
        surfaceStrokes: [],
      },
    };
    const invalidPage = validatePage({
      ...firstColoringPage,
      revision: createPageRevision(firstColoringPage.revision + 1),
      elements: [invalidElement],
    });
    const invalidDocument = validatePageDocument({
      ...completeDocument,
      pages: completeDocument.pages.map((page) => page.id === invalidPage.id ? invalidPage : page),
    });
    expect(verifyAnatomyComposition(invalidDocument)).toMatchObject({ status: "incomplete", invalidComponents: 1 });
    const receiptId = registry.getSnapshot().recentReceiptId;
    if (receiptId === null) throw new Error("Expected a composition receipt.");
    const undone = await registry.executeManual("page_undo", { mutationId: "anatomy-undo", receiptId });
    if (undone.outcome === "error") throw new Error(undone.error.message);
    expect(undone.outcome).toBe("success");
    expect(registry.getDocument().pages).toHaveLength(1);
    expect(registry.getDocument().pages[0]?.elements).toHaveLength(0);
  });

  it("reuses blank trailing pages while preserving the exact atlas and rejecting content or stale proposals", () => {
    const workbookId = createNotebookId("anatomy-upgrade");
    const empty = createEmptyPageDocument(workbookId, at);
    const freshProposal = createAnatomyCompositionProposal(empty);
    const fresh = applyAnatomyComposition({
      document: empty,
      proposalId: freshProposal.proposalId,
      expectedDocumentRevision: empty.documentRevision,
      at,
    });
    const atlasPage = fresh.document.pages[0];
    const atlasElement = atlasPage?.elements[0];
    if (atlasPage === undefined || atlasElement?.kind !== "embedded-frame") throw new Error("Expected an atlas page.");
    const atlasComponent = parseAnatomyComponent(atlasElement);
    if (atlasComponent?.kind !== "skeleton") throw new Error("Expected a parsed skeleton component.");
    const scoredPage = validatePage({
      ...atlasPage,
      revision: createPageRevision(atlasPage.revision + 1),
      elements: [{
        ...atlasElement,
        props: {
          ...atlasComponent.props,
          latestSubmission: {
            attemptId: "preserved-score",
            section: "pelvis",
            correct: 2,
            total: 2,
            unanswered: 0,
            submittedAt: at,
          },
        },
      }],
    });
    const onePage = validatePageDocument({
      ...fresh.document,
      documentRevision: createDocumentRevision(fresh.document.documentRevision + 1),
      pageOrder: [scoredPage.id],
      pages: [scoredPage],
    });
    const blankPage2 = createEmptyPage(workbookId, 2, at, { paper: "blank", size: scoredPage.size });
    const blankPage3 = createEmptyPage(workbookId, 3, at, { paper: "blank", size: scoredPage.size });
    const threePage = validatePageDocument({
      ...onePage,
      documentRevision: createDocumentRevision(onePage.documentRevision + 1),
      pageOrder: [scoredPage.id, blankPage2.id, blankPage3.id],
      pages: [scoredPage, blankPage2, blankPage3],
    });
    const upgradeProposal = createAnatomyCompositionProposal(threePage);
    expect(upgradeProposal.operation).toBe("upgrade");
    const upgraded = applyAnatomyComposition({
      document: threePage,
      proposalId: upgradeProposal.proposalId,
      expectedDocumentRevision: threePage.documentRevision,
      at,
    });
    expect(upgraded.document.pages).toHaveLength(7);
    expect(upgraded.document.pages[0]).toEqual(scoredPage);
    expect(upgraded.changedPageIds).not.toContain(scoredPage.id);
    expect(upgraded.document.pages[1]?.id).toBe(blankPage2.id);
    expect(upgraded.document.pages[1]?.revision).toBe(blankPage2.revision + 1);
    expect(upgraded.document.pages[2]?.id).toBe(blankPage3.id);
    expect(upgraded.document.pages[2]?.revision).toBe(blankPage3.revision + 1);
    expect(upgraded.changedPageIds).toEqual(upgraded.document.pages.slice(1).map((page) => page.id));
    expect(upgraded.focusPageId).toBe(scoredPage.id);
    expect(verifyAnatomyComposition(upgraded.document).status).toBe("complete");

    const nonEmptyBlankPage = validatePage({ ...blankPage2, elements: [atlasElement] });
    const notebookWithContent = validatePageDocument({
      ...threePage,
      pages: [scoredPage, nonEmptyBlankPage, blankPage3],
    });
    expect(() => createAnatomyCompositionProposal(notebookWithContent)).toThrow(/reusable blank pages/i);

    const stale = validatePageDocument({
      ...threePage,
      documentRevision: createDocumentRevision(threePage.documentRevision + 1),
    });
    expect(() => applyAnatomyComposition({
      document: stale,
      proposalId: upgradeProposal.proposalId,
      expectedDocumentRevision: threePage.documentRevision,
      at,
    })).toThrow(/stale/i);
  });

  it("computes and exactly undoes a test-mode score through typed commands", async () => {
    const registry = await createPageCommandRegistry(storage("interactions"), createNotebookId("anatomy-interactions"));
    const proposed = await registry.executeExternal("page_composition_propose", { template: ANATOMY_EXAM_PREP_TEMPLATE }, "webmcp");
    if (proposed.outcome !== "success") throw new Error("Expected a proposal.");
    const proposal = proposed.output.proposal;
    if (typeof proposal !== "object" || proposal === null || !("proposalId" in proposal) || typeof proposal.proposalId !== "string") {
      throw new Error("Expected a proposal id.");
    }
    const applied = await registry.executeExternal("page_composition_apply", {
      template: ANATOMY_EXAM_PREP_TEMPLATE,
      proposalId: proposal.proposalId,
      expectedDocumentRevision: 1,
      mutationId: "anatomy-interactions-apply",
    }, "webmcp");
    if (applied.outcome === "error") throw new Error(applied.error.message);
    const studyPage = registry.getDocument().pages[0];
    const studyElement = studyPage?.elements[0];
    if (studyPage === undefined || studyElement?.kind !== "embedded-frame") throw new Error("Expected the skeleton study page.");
    const pelvis = bonesForSection("pelvis");
    const answers = Object.fromEntries(pelvis.map((bone) => [bone.id, bone.name]));
    const quiz = await registry.executeManual("page_anatomy_quiz_submit", {
      mutationId: "pelvis-quiz",
      pageId: studyPage.id,
      expectedRevision: studyPage.revision,
      elementId: studyElement.id,
      section: "pelvis",
      answers,
    });
    expect(quiz.outcome).toBe("success");
    const updatedStudy = registry.getDocument().pages[0]?.elements[0];
    if (updatedStudy?.kind !== "embedded-frame") throw new Error("Expected an updated study component.");
    expect(parseAnatomyComponent(updatedStudy)).toMatchObject({ kind: "skeleton", props: { latestSubmission: { correct: 2, total: 2, unanswered: 0 } } });
    const receiptId = registry.getSnapshot().recentReceiptId;
    if (receiptId === null) throw new Error("Expected a quiz submission receipt.");
    const undone = await registry.executeManual("page_undo", { mutationId: "pelvis-quiz-undo", receiptId });
    expect(undone.outcome).toBe("success");
    const restoredStudy = registry.getDocument().pages[0]?.elements[0];
    if (restoredStudy?.kind !== "embedded-frame") throw new Error("Expected the restored study component.");
    expect(parseAnatomyComponent(restoredStudy)).toMatchObject({
      kind: "skeleton",
      props: {
        assetId: VERIFIED_ATLAS_ASSET_ID,
        logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
        semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
      },
    });
    expect(parseAnatomyComponent(restoredStudy)?.props.latestSubmission).toBeUndefined();
  });

  it("writes migrated v1 whole-bone colors as v2 while appending the first local surface stroke", async () => {
    const pageStorage = storage("v1-paint-migration");
    const registry = await createPageCommandRegistry(pageStorage, createNotebookId("anatomy-v1-paint"));
    const proposed = await registry.executeExternal("page_composition_propose", { template: ANATOMY_EXAM_PREP_TEMPLATE }, "webmcp");
    if (proposed.outcome !== "success" || typeof proposed.output.proposal !== "object" || proposed.output.proposal === null ||
      !("proposalId" in proposed.output.proposal) || typeof proposed.output.proposal.proposalId !== "string") {
      throw new Error("Expected a coloring composition proposal.");
    }
    const applied = await registry.executeExternal("page_composition_apply", {
      template: ANATOMY_EXAM_PREP_TEMPLATE,
      proposalId: proposed.output.proposal.proposalId,
      expectedDocumentRevision: 1,
      mutationId: "v1-paint-composition",
    }, "webmcp");
    if (applied.outcome === "error") throw new Error(applied.error.message);

    const document = registry.getDocument();
    const pelvisPage = document.pages[5];
    const pelvisElement = pelvisPage?.elements[0];
    if (pelvisPage === undefined || pelvisElement?.kind !== "embedded-frame") throw new Error("Expected the pelvis coloring page.");
    const component = parseAnatomyComponent(pelvisElement);
    if (component?.kind !== "coloring") throw new Error("Expected the v2 pelvis coloring component.");
    const legacyPage = validatePage({
      ...pelvisPage,
      revision: createPageRevision(pelvisPage.revision + 1),
      elements: [{
        ...pelvisElement,
        componentVersion: 1,
        props: {
          kind: component.props.kind,
          assetId: component.props.assetId,
          catalogVersion: component.props.catalogVersion,
          atlasVersion: component.props.atlasVersion,
          logicalBoneCount: component.props.logicalBoneCount,
          semanticMeshCount: component.props.semanticMeshCount,
          section: component.props.section,
          paletteVersion: component.props.paletteVersion,
          assignments: [["right-hip-bone", "amber"]],
        },
      }],
    });
    const legacyDocument = validatePageDocument({
      ...document,
      pages: document.pages.map((page) => page.id === pelvisPage.id ? legacyPage : page),
    });
    await pageStorage.commit({
      workbookId: document.workbookId,
      nextDocument: legacyDocument,
      pageIds: [pelvisPage.id],
      expectedDocumentRevision: document.documentRevision,
      expectedPageRevisions: { [pelvisPage.id]: pelvisPage.revision },
      mutationId: createMutationId("install-v1-coloring-fixture"),
      actorId: createActorId("person:test"),
      source: "person",
      kind: "page_anatomy_fixture",
    });
    await registry.refresh();
    registry.focusPage(pelvisPage.id);

    const painted = await registry.executeManual("page_anatomy_paint_apply", {
      mutationId: "first-v2-surface-stroke",
      pageId: pelvisPage.id,
      expectedRevision: legacyPage.revision,
      elementId: pelvisElement.id,
      edit: {
        kind: "surface-stroke",
        boneId: "left-hip-bone",
        brush: { kind: "paint", colorId: "cobalt", radiusBps: 900, hardnessBps: 8_000 },
        anchors: [{ sourceObject: "Hip bone.l", faceIndex: 8, barycentric: [18_000, 24_000], pressure: 40_000 }],
      },
    });
    if (painted.outcome === "error") throw new Error(painted.error.message);
    const written = registry.getDocument().pages[5]?.elements[0];
    if (written?.kind !== "embedded-frame") throw new Error("Expected the migrated coloring component.");
    expect(written.componentVersion).toBe(2);
    expect(parseAnatomyComponent(written)).toMatchObject({
      kind: "coloring",
      props: {
        baseFills: [["right-hip-bone", "amber"]],
        surfaceStrokes: [{ id: "first-v2-surface-stroke", boneId: "left-hip-bone" }],
      },
    });
  });

  it("persists exact local surface paint through the shared command path and fails closed on hidden pages", async () => {
    const registry = await createPageCommandRegistry(storage("paint"), createNotebookId("anatomy-paint"));
    const proposed = await registry.executeExternal("page_composition_propose", { template: ANATOMY_EXAM_PREP_TEMPLATE }, "webmcp");
    if (proposed.outcome !== "success" || typeof proposed.output.proposal !== "object" || proposed.output.proposal === null ||
      !("proposalId" in proposed.output.proposal) || typeof proposed.output.proposal.proposalId !== "string") {
      throw new Error("Expected a coloring composition proposal.");
    }
    const applied = await registry.executeExternal("page_composition_apply", {
      template: ANATOMY_EXAM_PREP_TEMPLATE,
      proposalId: proposed.output.proposal.proposalId,
      expectedDocumentRevision: 1,
      mutationId: "anatomy-paint-apply",
    }, "webmcp");
    if (applied.outcome === "error") throw new Error(applied.error.message);
    const coloringPage = registry.getDocument().pages[1];
    const coloringElement = coloringPage?.elements[0];
    if (coloringPage === undefined || coloringElement?.kind !== "embedded-frame") throw new Error("Expected the head coloring page.");
    const hiddenRead = await registry.executeManual("page_anatomy_coloring_read", { pageId: coloringPage.id });
    expect(hiddenRead).toMatchObject({ outcome: "error", error: { code: "PAGE_NOT_VISIBLE" } });
    const hiddenPaint = await registry.executeManual("page_anatomy_paint_apply", {
      mutationId: "hidden-anatomy-paint-stroke",
      pageId: coloringPage.id,
      expectedRevision: coloringPage.revision,
      elementId: coloringElement.id,
      edit: {
        kind: "surface-stroke",
        boneId: "frontal-bone",
        brush: { kind: "paint", colorId: "cobalt", radiusBps: 800, hardnessBps: 7_500 },
        anchors: [{ sourceObject: "Frontal bone", faceIndex: 12, barycentric: [20_000, 22_000], pressure: 32_768 }],
      },
    });
    expect(hiddenPaint).toMatchObject({ outcome: "error", error: { code: "PAGE_NOT_VISIBLE" } });

    registry.focusPage(coloringPage.id);
    const painted = await registry.executeManual("page_anatomy_paint_apply", {
      mutationId: "anatomy-paint-stroke",
      pageId: coloringPage.id,
      expectedRevision: coloringPage.revision,
      elementId: coloringElement.id,
      edit: {
        kind: "surface-stroke",
        boneId: "frontal-bone",
        brush: { kind: "paint", colorId: "cobalt", radiusBps: 800, hardnessBps: 7_500 },
        anchors: [{ sourceObject: "Frontal bone", faceIndex: 12, barycentric: [20_000, 22_000], pressure: 32_768 }],
      },
    });
    if (painted.outcome === "error") throw new Error(painted.error.message);
    const updatedElement = registry.getDocument().pages[1]?.elements[0];
    if (updatedElement?.kind !== "embedded-frame") throw new Error("Expected the updated coloring component.");
    expect(parseAnatomyComponent(updatedElement)).toMatchObject({
      kind: "coloring",
      props: {
        section: "skull",
        baseFills: [],
        surfaceStrokes: [{
          id: "anatomy-paint-stroke",
          boneId: "frontal-bone",
          brush: { kind: "paint", colorId: "cobalt", radiusBps: 800, hardnessBps: 7_500 },
          anchors: [{ sourceObject: "Frontal bone", faceIndex: 12, barycentric: [20_000, 22_000], pressure: 32_768 }],
        }],
      },
    });
    expect(updatedElement.componentVersion).toBe(2);
    expect(registry.describe("webmcp").map((command) => command.name)).toEqual(expect.arrayContaining([
      "page_anatomy_coloring_read",
      "page_anatomy_paint_apply",
    ]));
    const context = await registry.executeManual("page_anatomy_coloring_read", { pageId: coloringPage.id });
    expect(context).toMatchObject({
      outcome: "success",
      output: {
        section: "skull",
        colored: 1,
        total: 29,
        answersReleased: false,
        baseFilledBoneCount: 0,
        surfacePaintedBoneCount: 1,
        surfaceStrokeCount: 1,
        surfaceAnchorCount: 1,
      },
    });
    expect(JSON.stringify(context)).not.toContain("Frontal bone");
    expect(JSON.stringify(context)).not.toContain("frontal-bone");

    const invalid = await registry.executeManual("page_anatomy_paint_apply", {
      mutationId: "anatomy-paint-cross-section",
      pageId: coloringPage.id,
      expectedRevision: registry.getDocument().pages[1]?.revision,
      elementId: coloringElement.id,
      edit: {
        kind: "surface-stroke",
        boneId: "left-femur",
        brush: { kind: "paint", colorId: "carmine", radiusBps: 800, hardnessBps: 7_500 },
        anchors: [{ sourceObject: "Femur.l", faceIndex: 12, barycentric: [20_000, 22_000], pressure: 32_768 }],
      },
    });
    expect(invalid).toMatchObject({ outcome: "error", error: { code: "COMMAND_ERROR" } });

    const receiptId = registry.getSnapshot().recentReceiptId;
    if (receiptId === null) throw new Error("Expected a paint receipt.");
    const undone = await registry.executeManual("page_undo", { mutationId: "anatomy-paint-undo", receiptId });
    expect(undone.outcome).toBe("success");
    const restoredElement = registry.getDocument().pages[1]?.elements[0];
    if (restoredElement?.kind !== "embedded-frame") throw new Error("Expected the restored coloring component.");
    expect(parseAnatomyComponent(restoredElement)).toMatchObject({
      kind: "coloring",
      props: { baseFills: [], surfaceStrokes: [] },
    });
  });
});
