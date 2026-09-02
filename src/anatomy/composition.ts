import type { IsoInstant } from "../domain";
import {
  createDocumentRevision,
  createElementId,
  createEmptyPage,
  createPageRevision,
  validatePage,
  validatePageDocument,
  type EmbeddedFrameElement,
  type PageDocument,
  type PageId,
  type PageRecord,
} from "../page/domain";
import {
  ADULT_SKELETON_BONES,
  ANATOMY_CATALOG_VERSION,
  VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
  VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
  VERIFIED_ATLAS_VERSION,
  type AnatomySection,
} from "./catalog";
import {
  ANATOMY_COLORING_COMPONENT,
  ANATOMY_COLORING_COMPONENT_VERSION,
  ANATOMY_COMPONENT_VERSION,
  ANATOMY_SKELETON_COMPONENT,
  VERIFIED_ATLAS_ASSET_ID,
  parseAnatomyComponent,
} from "./components";
import { COLORING_LABS, COLORING_PALETTE_VERSION, coloringCompletion } from "./coloring-domain";

export const ANATOMY_EXAM_PREP_TEMPLATE = "anatomy-exam-prep";
export const ANATOMY_EXAM_PREP_TEMPLATE_VERSION = 3;
export const VERIFIED_ATLAS_ATTRIBUTION =
  "Z-Anatomy source-owned semantic atlas, licensed CC BY-SA 4.0. Source: https://github.com/Z-Anatomy/Models-of-human-anatomy";

const COMPOSITION_PAGE_LABELS = [
  "Interactive 3D skeleton study and test",
  "Head and face 3D coloring lab",
  "Spine 3D coloring lab",
  "Thorax 3D coloring lab",
  "Upper limbs 3D coloring lab",
  "Pelvis 3D coloring lab",
  "Lower limbs 3D coloring lab",
] as const;

export type AnatomyCompositionProposal = Readonly<{
  proposalId: string;
  template: typeof ANATOMY_EXAM_PREP_TEMPLATE;
  templateVersion: typeof ANATOMY_EXAM_PREP_TEMPLATE_VERSION;
  operation: "create" | "upgrade";
  expectedDocumentRevision: number;
  pageCount: 7;
  logicalBoneCount: typeof VERIFIED_ATLAS_LOGICAL_BONE_COUNT;
  semanticMeshCount: typeof VERIFIED_ATLAS_SEMANTIC_MESH_COUNT;
  pages: typeof COMPOSITION_PAGE_LABELS;
  attribution: typeof VERIFIED_ATLAS_ATTRIBUTION;
}>;

export type AnatomyCompositionVerification = Readonly<{
  status: "complete" | "incomplete";
  pageCount: number;
  skeletonComponentCount: number;
  coloringComponentCount: number;
  invalidComponents: number;
  coloringSections: readonly AnatomySection[];
  coloredBoneCount: number;
  assetId: typeof VERIFIED_ATLAS_ASSET_ID;
  catalogVersion: typeof ANATOMY_CATALOG_VERSION;
  atlasVersion: typeof VERIFIED_ATLAS_VERSION;
  logicalBoneCount: number;
  semanticMeshCount: number;
  attribution: typeof VERIFIED_ATLAS_ATTRIBUTION;
}>;

function anatomyProposalId(document: PageDocument): string {
  return `composition:${ANATOMY_EXAM_PREP_TEMPLATE}:v${ANATOMY_EXAM_PREP_TEMPLATE_VERSION}:${document.workbookId}:${document.documentRevision}`;
}

function isEmptyCompositionSource(document: PageDocument): boolean {
  return document.pages.length === 1 && document.pages[0]?.elements.length === 0;
}

function isExactAtlasPage(firstPage: PageRecord | undefined): firstPage is PageRecord {
  if (firstPage?.elements.length !== 1) return false;
  const element = firstPage.elements[0];
  const expectedFrame = anatomyFrame(firstPage);
  return firstPage.paper === "blank" &&
    element?.kind === "embedded-frame" &&
    element.id === createElementId(`anatomy:skeleton:${firstPage.id}`) &&
    element.label === "Interactive adult skeleton study" &&
    element.frame.x === expectedFrame.x &&
    element.frame.y === expectedFrame.y &&
    element.frame.width === expectedFrame.width &&
    element.frame.height === expectedFrame.height &&
    parseAnatomyComponent(element)?.kind === "skeleton";
}

function isReusableBlankPage(page: PageRecord, firstPage: PageRecord, index: number): boolean {
  return page.number === index + 1 &&
    page.paper === "blank" &&
    page.elements.length === 0 &&
    page.size.width === firstPage.size.width &&
    page.size.height === firstPage.size.height;
}

function isAtlasWithReusableBlankPagesSource(document: PageDocument): boolean {
  const firstPage = document.pages[0];
  return document.pages.length < 7 &&
    isExactAtlasPage(firstPage) &&
    document.pages.slice(1).every((page, index) => isReusableBlankPage(page, firstPage, index + 1));
}

function compositionOperation(document: PageDocument): "create" | "upgrade" {
  if (isEmptyCompositionSource(document)) return "create";
  if (isAtlasWithReusableBlankPagesSource(document)) return "upgrade";
  throw new Error(
    "The anatomy exam-prep composition requires a new notebook or the exact verified atlas followed only by reusable blank pages.",
  );
}

export function createAnatomyCompositionProposal(document: PageDocument): AnatomyCompositionProposal {
  return {
    proposalId: anatomyProposalId(document),
    template: ANATOMY_EXAM_PREP_TEMPLATE,
    templateVersion: ANATOMY_EXAM_PREP_TEMPLATE_VERSION,
    operation: compositionOperation(document),
    expectedDocumentRevision: document.documentRevision,
    pageCount: 7,
    logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
    semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
    pages: COMPOSITION_PAGE_LABELS,
    attribution: VERIFIED_ATLAS_ATTRIBUTION,
  };
}

function anatomyFrame(page: PageRecord): Readonly<{ x: number; y: number; width: number; height: number }> {
  return { x: 36, y: 56, width: page.size.width - 72, height: page.size.height - 104 };
}

function skeletonElement(page: PageRecord): EmbeddedFrameElement {
  return {
    kind: "embedded-frame",
    id: createElementId(`anatomy:skeleton:${page.id}`),
    label: "Interactive adult skeleton study",
    frame: anatomyFrame(page),
    componentType: ANATOMY_SKELETON_COMPONENT,
    componentVersion: ANATOMY_COMPONENT_VERSION,
    props: {
      kind: "anatomy-skeleton",
      assetId: VERIFIED_ATLAS_ASSET_ID,
      catalogVersion: ANATOMY_CATALOG_VERSION,
      atlasVersion: VERIFIED_ATLAS_VERSION,
      logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
      semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
    },
  };
}

function coloringElement(page: PageRecord, section: AnatomySection): EmbeddedFrameElement {
  const lab = COLORING_LABS.find((candidate) => candidate.section === section);
  if (lab === undefined) throw new Error(`No coloring lab is registered for ${section}.`);
  return {
    kind: "embedded-frame",
    id: createElementId(`anatomy:coloring:${section}:${page.id}`),
    label: `${lab.label} 3D coloring lab`,
    frame: anatomyFrame(page),
    componentType: ANATOMY_COLORING_COMPONENT,
    componentVersion: ANATOMY_COLORING_COMPONENT_VERSION,
    props: {
      kind: "anatomy-coloring-lab",
      assetId: VERIFIED_ATLAS_ASSET_ID,
      catalogVersion: ANATOMY_CATALOG_VERSION,
      atlasVersion: VERIFIED_ATLAS_VERSION,
      logicalBoneCount: VERIFIED_ATLAS_LOGICAL_BONE_COUNT,
      semanticMeshCount: VERIFIED_ATLAS_SEMANTIC_MESH_COUNT,
      section,
      paletteVersion: COLORING_PALETTE_VERSION,
      baseFills: [],
      surfaceStrokes: [],
    },
  };
}

function pageWithSkeleton(page: PageRecord, at: IsoInstant): PageRecord {
  return validatePage({
    ...page,
    paper: "blank",
    revision: createPageRevision(page.revision + 1),
    elements: [skeletonElement(page)],
    updatedAt: at,
  });
}

function createColoringPage(
  document: PageDocument,
  firstPage: PageRecord,
  number: number,
  section: AnatomySection,
  at: IsoInstant,
): PageRecord {
  const empty = createEmptyPage(document.workbookId, number, at, { paper: "blank", size: firstPage.size });
  return validatePage({ ...empty, elements: [coloringElement(empty, section)] });
}

function pageWithColoring(page: PageRecord, section: AnatomySection, at: IsoInstant): PageRecord {
  return validatePage({
    ...page,
    paper: "blank",
    revision: createPageRevision(page.revision + 1),
    elements: [coloringElement(page, section)],
    updatedAt: at,
  });
}

export function applyAnatomyComposition(input: Readonly<{
  document: PageDocument;
  proposalId: string;
  expectedDocumentRevision: number;
  at: IsoInstant;
}>): Readonly<{
  document: PageDocument;
  changedPageIds: readonly PageId[];
  focusPageId: PageId;
}> {
  const proposal = createAnatomyCompositionProposal(input.document);
  if (input.expectedDocumentRevision !== input.document.documentRevision || proposal.proposalId !== input.proposalId) {
    throw new Error("The anatomy composition proposal is stale. Read a fresh proposal before applying it.");
  }
  const sourcePage = input.document.pages[0];
  if (sourcePage === undefined) throw new Error("The notebook has no first page.");
  const firstPage = proposal.operation === "create" ? pageWithSkeleton(sourcePage, input.at) : sourcePage;
  const coloringPages = COLORING_LABS.map((lab, index) => {
    const pageNumber = index + 2;
    const existingPage = input.document.pages[index + 1];
    return existingPage === undefined
      ? createColoringPage(input.document, firstPage, pageNumber, lab.section, input.at)
      : pageWithColoring(existingPage, lab.section, input.at);
  });
  const pages = [firstPage, ...coloringPages];
  const document = validatePageDocument({
    ...input.document,
    documentRevision: createDocumentRevision(input.document.documentRevision + 1),
    pageOrder: pages.map((page) => page.id),
    pages,
  });
  return {
    document,
    changedPageIds: proposal.operation === "create" ? pages.map((page) => page.id) : coloringPages.map((page) => page.id),
    focusPageId: firstPage.id,
  };
}

export function verifyAnatomyComposition(document: PageDocument): AnatomyCompositionVerification {
  const embeddedElements = document.pages.flatMap((page) => page.elements
    .filter((element): element is EmbeddedFrameElement => element.kind === "embedded-frame"));
  const parsedComponents = embeddedElements.map((element) => parseAnatomyComponent(element));
  const skeletonComponentCount = parsedComponents.filter((component) => component?.kind === "skeleton").length;
  const coloringComponents = parsedComponents.flatMap((component) => component?.kind === "coloring" ? [component] : []);
  const invalidComponents = parsedComponents.filter((component) => component === null).length;
  const coloringSections = coloringComponents.map((component) => component.props.section);
  const expectedSections = COLORING_LABS.map((lab) => lab.section);
  const logicalBoneIds = new Set(ADULT_SKELETON_BONES.map((bone) => bone.id));
  const semanticMeshCount = ADULT_SKELETON_BONES.reduce((count, bone) => count + bone.sourceMeshCount, 0);
  const exactPageKinds = document.pages.every((page, index) => {
    if (page.elements.length !== 1) return false;
    const element = page.elements[0];
    if (element?.kind !== "embedded-frame") return false;
    const component = parseAnatomyComponent(element);
    return index === 0
      ? component?.kind === "skeleton"
      : component?.kind === "coloring" && component.props.section === expectedSections[index - 1];
  });
  const complete = document.pages.length === 7 &&
    embeddedElements.length === 7 &&
    skeletonComponentCount === 1 &&
    coloringComponents.length === 6 &&
    invalidComponents === 0 &&
    exactPageKinds &&
    logicalBoneIds.size === VERIFIED_ATLAS_LOGICAL_BONE_COUNT &&
    semanticMeshCount === VERIFIED_ATLAS_SEMANTIC_MESH_COUNT;
  return {
    status: complete ? "complete" : "incomplete",
    pageCount: document.pages.length,
    skeletonComponentCount,
    coloringComponentCount: coloringComponents.length,
    invalidComponents,
    coloringSections,
    coloredBoneCount: coloringComponents.reduce((count, component) => count + coloringCompletion({
      section: component.props.section,
      baseFills: component.props.baseFills,
      surfaceStrokes: component.props.surfaceStrokes,
    }).completedBoneCount, 0),
    assetId: VERIFIED_ATLAS_ASSET_ID,
    catalogVersion: ANATOMY_CATALOG_VERSION,
    atlasVersion: VERIFIED_ATLAS_VERSION,
    logicalBoneCount: logicalBoneIds.size,
    semanticMeshCount,
    attribution: VERIFIED_ATLAS_ATTRIBUTION,
  };
}
