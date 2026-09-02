import { z } from "zod";

import { createIsoInstant } from "../domain";
import type {
  CanvasSnapshotRow,
  NoteRow,
  NotebookLifecycleRow,
  NotebookRow,
  PageDocumentRow,
  PageMigrationRow,
  PageReceiptRow,
  PageRow,
  ReceiptRow,
  WorkspaceMetadataRow,
} from "./database";
import type {
  PageScrapRow,
  ProjectItemReceiptRow,
  ProjectItemRow,
  ProjectRow,
  WorkbookIdentityRow,
} from "../projects/rows";

export const BACKUP_FORMAT = "project-notebook-workspace-backup" as const;
export const BACKUP_VERSION = 1 as const;
export const BACKUP_DATABASE_VERSION = 4 as const;

export type BackupStores = Readonly<{
  notebooks: readonly NotebookRow[];
  canvasSnapshots: readonly CanvasSnapshotRow[];
  notes: readonly NoteRow[];
  receipts: readonly ReceiptRow[];
  notebookLifecycle: readonly NotebookLifecycleRow[];
  workspaceMetadata: readonly WorkspaceMetadataRow[];
  pageDocuments: readonly PageDocumentRow[];
  pages: readonly PageRow[];
  pageReceipts: readonly PageReceiptRow[];
  pageMigrations: readonly PageMigrationRow[];
  projects: readonly ProjectRow[];
  workbookIdentities: readonly WorkbookIdentityRow[];
  projectItems: readonly ProjectItemRow[];
  projectItemReceipts: readonly ProjectItemReceiptRow[];
  pageScraps: readonly PageScrapRow[];
}>;

export type WorkspaceBackupV1 = Readonly<{
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  databaseVersion: typeof BACKUP_DATABASE_VERSION;
  exportedAt: string;
  stores: BackupStores;
}>;

export function createBackupSchema() {
  const IdentifierSchema = z.string().min(1).max(500).refine((value) => value.trim() === value, "must be canonical");
  const ProjectIdentifierSchema = z.string().min(1).max(180).refine((value) => value.trim() === value, "must be canonical");
  const PositiveIntegerSchema = z.number().int().safe().positive();
  const FinitePositiveSchema = z.number().finite().positive();
  const InstantSchema = z.string().refine((value) => {
    try {
      createIsoInstant(value);
      return true;
    } catch {
      return false;
    }
  }, "must be a canonical UTC instant");
  const ActorSchema = z.object({ kind: z.enum(["user", "agent"]), id: IdentifierSchema }).strict();
  const NotebookTitleSchema = z.string().min(1).max(120).refine((value) => value.trim() === value, "must be canonical");
  const NotebookSubjectSchema = z.string().min(1).max(240).refine((value) => value.trim() === value, "must be canonical");
  const ProjectTextSchema = z.string().refine((value) => value.trim() === value, "must be canonical");
  const AnchorSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("page"), pageId: IdentifierSchema }).strict(),
    z.object({ kind: z.literal("element"), pageId: IdentifierSchema, elementId: IdentifierSchema }).strict(),
  ]);

  const NotebookRowSchema = z.object({
    id: IdentifierSchema,
    title: NotebookTitleSchema,
    subject: NotebookSubjectSchema,
    revision: PositiveIntegerSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  }).strict();

  const CanvasSnapshotRowSchema = z.object({
    notebookId: IdentifierSchema,
    version: z.literal(1),
    savedAt: InstantSchema,
    snapshot: z.json(),
  }).strict();

  const NoteRowSchema = z.object({
    id: IdentifierSchema,
    targetNotebookId: IdentifierSchema,
    revision: PositiveIntegerSchema,
    contentVersion: z.literal(1),
    content: z.object({ format: z.literal("plain_text"), text: z.string() }).strict(),
    lifecycle: z.enum(["active", "trashed"]),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  }).strict();

  const LegacyUndoSchema = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("available"),
      effect: z.enum(["withdraw_capture", "move_back", "restore_note", "trash_note", "restore_notebook", "trash_notebook"]),
    }).strict(),
    z.object({ kind: z.literal("consumed"), by: IdentifierSchema }).strict(),
    z.object({ kind: z.literal("unavailable"), reason: z.literal("undo_is_final") }).strict(),
  ]);
  const LegacyReceiptBase = {
    id: IdentifierSchema,
    source: z.enum(["person", "assistant"]),
    completedAt: InstantSchema,
    undo: LegacyUndoSchema,
  };
  const LegacyReceiptSchema = z.discriminatedUnion("kind", [
    z.object({ ...LegacyReceiptBase, kind: z.literal("capture_note"), noteId: IdentifierSchema, targetNotebookId: IdentifierSchema, resultingRevision: PositiveIntegerSchema }).strict(),
    z.object({ ...LegacyReceiptBase, kind: z.literal("move_note"), noteId: IdentifierSchema, fromNotebookId: IdentifierSchema, toNotebookId: IdentifierSchema, resultingRevision: PositiveIntegerSchema }).strict(),
    z.object({ ...LegacyReceiptBase, kind: z.literal("trash_note"), noteId: IdentifierSchema, priorLifecycle: z.enum(["active", "trashed"]), resultingLifecycle: z.enum(["active", "trashed"]), resultingRevision: PositiveIntegerSchema }).strict(),
    z.object({ ...LegacyReceiptBase, kind: z.literal("restore_note"), noteId: IdentifierSchema, priorLifecycle: z.enum(["active", "trashed"]), resultingLifecycle: z.enum(["active", "trashed"]), resultingRevision: PositiveIntegerSchema }).strict(),
    z.object({ ...LegacyReceiptBase, kind: z.literal("trash_notebook"), notebookId: IdentifierSchema, priorLifecycle: z.enum(["active", "trashed"]), resultingLifecycle: z.enum(["active", "trashed"]), resultingRevision: PositiveIntegerSchema, priorCurrentTargetNotebookId: IdentifierSchema.optional(), resultingWorkspaceRevision: PositiveIntegerSchema.optional() }).strict(),
    z.object({ ...LegacyReceiptBase, kind: z.literal("restore_notebook"), notebookId: IdentifierSchema, priorLifecycle: z.enum(["active", "trashed"]), resultingLifecycle: z.enum(["active", "trashed"]), resultingRevision: PositiveIntegerSchema, priorCurrentTargetNotebookId: IdentifierSchema.optional(), resultingWorkspaceRevision: PositiveIntegerSchema.optional() }).strict(),
    z.object({ ...LegacyReceiptBase, kind: z.literal("undo"), undoOf: IdentifierSchema, affectedId: IdentifierSchema, resultingRevision: PositiveIntegerSchema }).strict(),
  ]);

  const LifecycleSchema = z.object({
    notebookId: IdentifierSchema,
    lifecycle: z.enum(["active", "trashed"]),
    revision: PositiveIntegerSchema,
    updatedAt: InstantSchema,
  }).strict();

  const MetadataSchema = z.object({
    id: z.literal("workspace"),
    version: z.literal(1),
    inboxNotebookId: z.literal("inbox"),
    currentTargetNotebookId: IdentifierSchema,
    revision: PositiveIntegerSchema,
    updatedAt: InstantSchema,
  }).strict();

  const PageDocumentRowSchema = z.object({
    workbookId: IdentifierSchema,
    version: z.literal(1),
    documentRevision: PositiveIntegerSchema,
    pageOrder: z.array(IdentifierSchema).min(1).max(1_024),
    updatedAt: InstantSchema,
  }).strict();
  const PageRowSchema = z.object({
    id: IdentifierSchema,
    workbookId: IdentifierSchema,
    version: z.literal(1),
    number: PositiveIntegerSchema,
    revision: PositiveIntegerSchema,
    size: z.object({ width: FinitePositiveSchema, height: FinitePositiveSchema }).strict(),
    paper: z.enum(["lined", "grid", "blank"]).optional(),
    elements: z.array(z.unknown()).max(1_024),
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  }).strict();
  const PageReceiptUndoSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("available") }).strict(),
    z.object({ kind: z.literal("consumed"), by: IdentifierSchema }).strict(),
    z.object({ kind: z.literal("unavailable") }).strict(),
  ]);
  const PageReceiptKindSchema = z.enum([
    "page_composition_apply",
    "page_anatomy_paint_apply",
    "page_anatomy_quiz_submit",
    "page_text_insert",
    "page_structured_text_set",
    "page_text_format",
    "page_stroke_add",
    "page_shape_add",
    "page_vector_ink_add",
    "page_vector_ink_replace_apply",
    "page_diagram_add",
    "page_diagram_frame_set",
    "page_diagram_snapshot_set",
    "page_annotation_add",
    "page_review_callout_add",
    "page_element_frame_set",
    "page_element_move",
    "page_element_resize",
    "page_advance",
    "page_text_continue",
    "page_rework_apply",
    "page_scrap_restore",
    "page_undo",
  ]);
  const PageReceiptSchema = z.object({
    id: IdentifierSchema,
    workbookId: IdentifierSchema,
    mutationId: IdentifierSchema,
    actorId: IdentifierSchema,
    source: z.enum(["person", "assistant"]),
    kind: PageReceiptKindSchema,
    completedAt: InstantSchema,
    fingerprint: z.string().min(1).max(2_000_000),
    beforeDocument: PageDocumentRowSchema,
    beforePages: z.array(PageRowSchema).min(1).max(1_024),
    affectedPageIds: z.array(IdentifierSchema).min(1).max(1_024),
    resultingDocumentRevision: PositiveIntegerSchema,
    resultingPageRevisions: z.record(IdentifierSchema, PositiveIntegerSchema),
    undo: PageReceiptUndoSchema,
  }).strict();
  const MigrationIssueSchema = z.object({
    kind: z.enum(["malformed_note", "malformed_canvas"]),
    id: IdentifierSchema,
    message: z.string().min(1).max(2_000),
  }).strict();
  const PageMigrationSchema = z.object({
    id: IdentifierSchema,
    workbookId: IdentifierSchema,
    version: z.literal(1),
    status: z.literal("complete"),
    completedAt: InstantSchema,
    migratedNoteIds: z.array(IdentifierSchema).max(1_024),
    migratedCanvas: z.boolean(),
    issues: z.array(MigrationIssueSchema).max(1_024),
  }).strict();

  const ProjectRowSchema = z.object({
    version: z.literal(1),
    id: ProjectIdentifierSchema,
    name: ProjectTextSchema,
    revision: PositiveIntegerSchema,
    createdBy: ActorSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  }).strict();
  const WorkbookIdentitySchema = z.discriminatedUnion("kind", [
    z.object({ version: z.literal(1), kind: z.literal("user"), workbookId: IdentifierSchema, projectId: ProjectIdentifierSchema.nullable(), shelfKind: z.literal("user"), createdAt: InstantSchema }).strict(),
    z.object({ version: z.literal(1), kind: z.literal("agent"), workbookId: IdentifierSchema, projectId: ProjectIdentifierSchema, agentProjectId: ProjectIdentifierSchema, shelfKind: z.literal("agent"), createdAt: InstantSchema }).strict(),
  ]);
  const ProjectItemSchema = z.object({
    version: z.literal(1),
    id: ProjectIdentifierSchema,
    projectId: ProjectIdentifierSchema,
    workbookId: IdentifierSchema,
    kind: z.enum(["task", "milestone", "decision"]),
    title: ProjectTextSchema,
    status: z.enum(["open", "in_progress", "blocked", "done", "superseded"]),
    anchor: AnchorSchema,
    revision: PositiveIntegerSchema,
    authoredBy: ActorSchema,
    createdAt: InstantSchema,
    updatedAt: InstantSchema,
  }).strict();
  const ProjectItemRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("create"), itemId: ProjectIdentifierSchema, projectId: ProjectIdentifierSchema, workbookId: IdentifierSchema, itemKind: z.enum(["task", "milestone", "decision"]), title: ProjectTextSchema, status: z.enum(["open", "in_progress", "blocked", "done", "superseded"]), anchor: AnchorSchema, actor: ActorSchema, source: z.enum(["manual", "webmcp"]) }).strict(),
    z.object({ kind: z.literal("update"), itemId: ProjectIdentifierSchema, expectedRevision: PositiveIntegerSchema, title: ProjectTextSchema, status: z.enum(["open", "in_progress", "blocked", "done", "superseded"]), anchor: AnchorSchema, actor: ActorSchema, source: z.enum(["manual", "webmcp"]) }).strict(),
    z.object({ kind: z.literal("undo"), receiptId: ProjectIdentifierSchema, actor: ActorSchema, source: z.enum(["manual", "webmcp"]) }).strict(),
  ]);
  const ProjectUndoSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("available") }).strict(),
    z.object({ kind: z.literal("consumed"), by: ProjectIdentifierSchema }).strict(),
    z.object({ kind: z.literal("unavailable") }).strict(),
  ]);
  const ProjectItemReceiptSchema = z.object({
    version: z.literal(1),
    id: ProjectIdentifierSchema,
    mutationId: ProjectIdentifierSchema,
    projectId: ProjectIdentifierSchema,
    workbookId: IdentifierSchema,
    itemId: ProjectIdentifierSchema,
    kind: z.enum(["project_item_create", "project_item_update", "project_item_undo"]),
    actor: ActorSchema,
    source: z.enum(["manual", "webmcp"]),
    completedAt: InstantSchema,
    beforeItem: ProjectItemSchema.nullable(),
    afterItem: ProjectItemSchema.nullable(),
    request: ProjectItemRequestSchema,
    undo: ProjectUndoSchema,
    undoOf: ProjectIdentifierSchema.optional(),
  }).strict();

  const PageScrapReferenceSchema = z.object({ kind: z.literal("page-element"), pageId: IdentifierSchema, elementId: IdentifierSchema }).strict();
  const PageScrapSchema = z.object({
    version: z.literal(1),
    id: IdentifierSchema,
    workbookId: IdentifierSchema,
    reason: ProjectTextSchema,
    capturedBy: ActorSchema,
    capturedAt: InstantSchema,
    beforeDocument: PageDocumentRowSchema,
    beforePages: z.array(PageRowSchema).min(1).max(1_024),
    assetReferences: z.array(PageScrapReferenceSchema).max(2_048),
    resultingDocumentRevision: PositiveIntegerSchema,
    resultingPageOrder: z.array(IdentifierSchema).min(1).max(1_024),
    resultingPageRevisions: z.record(IdentifierSchema, PositiveIntegerSchema),
    reworkReceiptId: IdentifierSchema,
  }).strict();

  return z.object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    databaseVersion: z.literal(BACKUP_DATABASE_VERSION),
    exportedAt: InstantSchema,
    stores: z.object({
      notebooks: z.array(NotebookRowSchema).max(10_000),
      canvasSnapshots: z.array(CanvasSnapshotRowSchema).max(10_000),
      notes: z.array(NoteRowSchema).max(100_000),
      receipts: z.array(LegacyReceiptSchema).max(100_000),
      notebookLifecycle: z.array(LifecycleSchema).max(10_000),
      workspaceMetadata: z.array(MetadataSchema).max(1),
      pageDocuments: z.array(PageDocumentRowSchema).max(100_000),
      pages: z.array(PageRowSchema).max(100_000),
      pageReceipts: z.array(PageReceiptSchema).max(100_000),
      pageMigrations: z.array(PageMigrationSchema).max(100_000),
      projects: z.array(ProjectRowSchema).max(10_000),
      workbookIdentities: z.array(WorkbookIdentitySchema).max(100_000),
      projectItems: z.array(ProjectItemSchema).max(100_000),
      projectItemReceipts: z.array(ProjectItemReceiptSchema).max(100_000),
      pageScraps: z.array(PageScrapSchema).max(50_000),
    }).strict(),
  }).strict();
}

export type RawBackup = z.infer<ReturnType<typeof createBackupSchema>>;
export type RawStores = RawBackup["stores"];
export type RawLegacyReceipt = RawStores["receipts"][number];
export type RawPageRow = RawStores["pages"][number];
