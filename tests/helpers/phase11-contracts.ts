export type Phase11Tool = Readonly<{
  name: string;
  execute: (input: unknown) => unknown | Promise<unknown>;
}>;

export type Phase11CommandResult =
  | Readonly<{ ok: true; output: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; error: Readonly<{ code: string; message: string }> }>;

export const DATABASE_NAME = "project-notebook-phase0-v1";
export const EXPECTED_DATABASE_VERSION = 4;
export const ACCEPTANCE_PORT = 3251;

export const LEGACY_STORES: readonly string[] = [
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
];

export const PHASE11_STORES: readonly string[] = [
  "projects",
  "workbookIdentities",
  "projectItems",
  "projectItemReceipts",
  "pageScraps",
];

export const TOOL_NAMES = Object.freeze({
  resolveAgentWorkbook: "project_workbook_resolve",
  claimPage: "page_writer_claim",
  releasePage: "page_writer_release",
  setStructuredText: "page_structured_text_set",
  continueText: "page_text_continue",
  createProjectItem: "project_item_create",
  updateProjectItem: "project_item_update",
  undoProjectItem: "project_item_undo",
  applyRework: "page_rework_apply",
  restoreScrap: "page_scrap_restore",
  undoPage: "page_undo",
});

export const SELECTORS = Object.freeze({
  userShelf: '[data-phase11-shelf="user"]',
  agentShelf: '[data-phase11-shelf="agent"]',
  projectStamp: "[data-phase11-project-id]",
  editor: '[data-phase11-structured-editor="true"]',
  editorInput: '[data-phase11-editor-input="true"]',
  editorSave: '[data-phase11-editor-save="true"]',
  editorCancel: '[data-phase11-editor-cancel="true"]',
  tracking: '[data-phase11-tracking="true"]',
  trackingItem: "[data-phase11-project-item-id]",
  scrapPocket: '[data-phase11-scrap-pocket="true"]',
  scrapEntry: "[data-phase11-scrap-id]",
  pageSurface: ".page-surface",
  focusedPage: '.page-surface[data-page-focused="true"]',
  visiblePages: ".notebook-pages",
  recentPageReceipt: ".page-navigation",
});

export const FIXTURE = Object.freeze({
  projectId: "phase11:project:acceptance",
  userWorkbookId: "phase11:workbook:user-legacy",
  userPage1Id: "phase11:page:user-1",
  userPage2Id: "phase11:page:user-2",
  text1Id: "phase11:element:text-1",
  text2Id: "phase11:element:text-2",
  actorA: "phase11:agent:ada",
  actorB: "phase11:agent:grace",
  personActor: "phase11:person:acceptance",
});
