import { z } from "zod";

import type { PageDocumentRow, PageRow } from "../indexeddb/database";
import {
  createProjectActor,
  createProjectAnchor,
  createProjectId,
  createProjectItemId,
  createProjectItemReceiptId,
  createProjectItemRevision,
  createProjectMutationId,
  createProjectWorkbookId,
  parseProjectInstant,
  validateProjectText,
  type Project,
  type ProjectItem,
  type ProjectItemReceipt,
  type WorkbookIdentity,
} from "./domain";

const ActorSchema = z.object({ kind: z.enum(["user", "agent"]), id: z.string() }).strict();
const AnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("page"), pageId: z.string() }).strict(),
  z.object({ kind: z.literal("element"), pageId: z.string(), elementId: z.string() }).strict(),
]);
const ProjectItemSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  projectId: z.string(),
  workbookId: z.string(),
  kind: z.enum(["task", "milestone", "decision"]),
  title: z.string(),
  status: z.enum(["open", "in_progress", "blocked", "done", "superseded"]),
  anchor: AnchorSchema,
  revision: z.number(),
  authoredBy: ActorSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

export type ProjectRow = Readonly<{
  version: 1;
  id: string;
  name: string;
  revision: number;
  createdBy: Readonly<{ kind: "user" | "agent"; id: string }>;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkbookIdentityRow =
  | Readonly<{
      version: 1;
      kind: "user";
      workbookId: string;
      projectId: string | null;
      shelfKind: "user";
      createdAt: string;
    }>
  | Readonly<{
      version: 1;
      kind: "agent";
      workbookId: string;
      projectId: string;
      agentProjectId: string;
      shelfKind: "agent";
      createdAt: string;
    }>;

export type ProjectItemRow = Readonly<{
  version: 1;
  id: string;
  projectId: string;
  workbookId: string;
  kind: "task" | "milestone" | "decision";
  title: string;
  status: "open" | "in_progress" | "blocked" | "done" | "superseded";
  anchor:
    | Readonly<{ kind: "none" }>
    | Readonly<{ kind: "page"; pageId: string }>
    | Readonly<{ kind: "element"; pageId: string; elementId: string }>;
  revision: number;
  authoredBy: Readonly<{ kind: "user" | "agent"; id: string }>;
  createdAt: string;
  updatedAt: string;
}>;

export type ProjectItemReceiptRequestRow =
  | Readonly<{
      kind: "create";
      itemId: string;
      projectId: string;
      workbookId: string;
      itemKind: "task" | "milestone" | "decision";
      title: string;
      status: "open" | "in_progress" | "blocked" | "done" | "superseded";
      anchor: ProjectItemRow["anchor"];
      actor: Readonly<{ kind: "user" | "agent"; id: string }>;
      source: "manual" | "webmcp";
    }>
  | Readonly<{
      kind: "update";
      itemId: string;
      expectedRevision: number;
      title: string;
      status: "open" | "in_progress" | "blocked" | "done" | "superseded";
      anchor: ProjectItemRow["anchor"];
      actor: Readonly<{ kind: "user" | "agent"; id: string }>;
      source: "manual" | "webmcp";
    }>
  | Readonly<{
      kind: "undo";
      receiptId: string;
      actor: Readonly<{ kind: "user" | "agent"; id: string }>;
      source: "manual" | "webmcp";
    }>;

export type ProjectItemReceiptRow = Readonly<{
  version: 1;
  id: string;
  mutationId: string;
  projectId: string;
  workbookId: string;
  itemId: string;
  kind: "project_item_create" | "project_item_update" | "project_item_undo";
  actor: Readonly<{ kind: "user" | "agent"; id: string }>;
  source: "manual" | "webmcp";
  completedAt: string;
  beforeItem: ProjectItemRow | null;
  afterItem: ProjectItemRow | null;
  request: ProjectItemReceiptRequestRow;
  undo:
    | Readonly<{ kind: "available" }>
    | Readonly<{ kind: "consumed"; by: string }>
    | Readonly<{ kind: "unavailable" }>;
  undoOf?: string;
}>;

export type PageScrapAssetReferenceRow = Readonly<{
  kind: "page-element";
  pageId: string;
  elementId: string;
}>;

export type PageScrapRow = Readonly<{
  version: 1;
  id: string;
  workbookId: string;
  reason: string;
  capturedBy: Readonly<{ kind: "user" | "agent"; id: string }>;
  capturedAt: string;
  beforeDocument: PageDocumentRow;
  beforePages: readonly PageRow[];
  assetReferences: readonly PageScrapAssetReferenceRow[];
  resultingDocumentRevision: number;
  resultingPageOrder: readonly string[];
  resultingPageRevisions: Readonly<Record<string, number>>;
  reworkReceiptId: string;
}>;

const ProjectSchema = z.object({
  version: z.literal(1), id: z.string(), name: z.string(), revision: z.number(),
  createdBy: ActorSchema, createdAt: z.string(), updatedAt: z.string(),
}).strict();
const UserIdentitySchema = z.object({
  version: z.literal(1), kind: z.literal("user"), workbookId: z.string(),
  projectId: z.string().nullable(), shelfKind: z.literal("user"), createdAt: z.string(),
}).strict();
const AgentIdentitySchema = z.object({
  version: z.literal(1), kind: z.literal("agent"), workbookId: z.string(),
  projectId: z.string(), agentProjectId: z.string(), shelfKind: z.literal("agent"), createdAt: z.string(),
}).strict();
const RequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), itemId: z.string(), projectId: z.string(), workbookId: z.string(), itemKind: z.enum(["task", "milestone", "decision"]), title: z.string(), status: z.enum(["open", "in_progress", "blocked", "done", "superseded"]), anchor: AnchorSchema, actor: ActorSchema, source: z.enum(["manual", "webmcp"]) }).strict(),
  z.object({ kind: z.literal("update"), itemId: z.string(), expectedRevision: z.number(), title: z.string(), status: z.enum(["open", "in_progress", "blocked", "done", "superseded"]), anchor: AnchorSchema, actor: ActorSchema, source: z.enum(["manual", "webmcp"]) }).strict(),
  z.object({ kind: z.literal("undo"), receiptId: z.string(), actor: ActorSchema, source: z.enum(["manual", "webmcp"]) }).strict(),
]);
const UndoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available") }).strict(),
  z.object({ kind: z.literal("consumed"), by: z.string() }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
const ReceiptSchema = z.object({
  version: z.literal(1), id: z.string(), mutationId: z.string(), projectId: z.string(), workbookId: z.string(), itemId: z.string(),
  kind: z.enum(["project_item_create", "project_item_update", "project_item_undo"]), actor: ActorSchema,
  source: z.enum(["manual", "webmcp"]), completedAt: z.string(), beforeItem: ProjectItemSchema.nullable(), afterItem: ProjectItemSchema.nullable(),
  request: RequestSchema, undo: UndoSchema, undoOf: z.string().optional(),
}).strict();
const DocumentRowSchema = z.object({ workbookId: z.string(), version: z.literal(1), documentRevision: z.number().int().safe().positive(), pageOrder: z.array(z.string()), updatedAt: z.string() }).strict();
const PageRowSchema = z.object({ id: z.string(), workbookId: z.string(), version: z.literal(1), number: z.number().int().safe().positive(), revision: z.number().int().safe().positive(), size: z.object({ width: z.number().finite().positive(), height: z.number().finite().positive() }).strict(), paper: z.enum(["lined", "grid", "blank"]).optional(), elements: z.array(z.unknown()), createdAt: z.string(), updatedAt: z.string() }).strict();
const ScrapSchema = z.object({
  version: z.literal(1), id: z.string(), workbookId: z.string(), reason: z.string(), capturedBy: ActorSchema, capturedAt: z.string(),
  beforeDocument: DocumentRowSchema, beforePages: z.array(PageRowSchema),
  assetReferences: z.array(z.object({ kind: z.literal("page-element"), pageId: z.string(), elementId: z.string() }).strict()),
  resultingDocumentRevision: z.number().int().safe().positive(), resultingPageOrder: z.array(z.string()),
  resultingPageRevisions: z.record(z.string(), z.number().int().safe().positive()), reworkReceiptId: z.string(),
}).strict();

export function parseProjectRow(value: unknown): Project {
  const row = ProjectSchema.parse(value);
  return {
    version: 1, id: createProjectId(row.id), name: validateProjectText(row.name, "Project name", 120),
    revision: createProjectItemRevision(row.revision), createdBy: createProjectActor(row.createdBy),
    createdAt: parseProjectInstant(row.createdAt), updatedAt: parseProjectInstant(row.updatedAt),
  };
}

export function parseWorkbookIdentityRow(value: unknown): WorkbookIdentity {
  const user = UserIdentitySchema.safeParse(value);
  if (user.success) {
    return { version: 1, kind: "user", workbookId: createProjectWorkbookId(user.data.workbookId), projectId: user.data.projectId === null ? null : createProjectId(user.data.projectId), createdAt: parseProjectInstant(user.data.createdAt) };
  }
  const agent = AgentIdentitySchema.parse(value);
  if (agent.agentProjectId !== agent.projectId) throw new Error("Agent workbook identity project index is inconsistent.");
  return { version: 1, kind: "agent", workbookId: createProjectWorkbookId(agent.workbookId), projectId: createProjectId(agent.projectId), createdAt: parseProjectInstant(agent.createdAt) };
}

export function parseProjectItemRow(value: unknown): ProjectItem {
  const row = ProjectItemSchema.parse(value);
  return {
    version: 1, id: createProjectItemId(row.id), projectId: createProjectId(row.projectId), workbookId: createProjectWorkbookId(row.workbookId),
    kind: row.kind, title: validateProjectText(row.title, "Project item title"), status: row.status, anchor: createProjectAnchor(row.anchor),
    revision: createProjectItemRevision(row.revision), authoredBy: createProjectActor(row.authoredBy),
    createdAt: parseProjectInstant(row.createdAt), updatedAt: parseProjectInstant(row.updatedAt),
  };
}

export function parseProjectItemReceiptRow(value: unknown): ProjectItemReceipt {
  const row = ReceiptSchema.parse(value);
  const beforeItem = row.beforeItem === null ? null : parseProjectItemRow(row.beforeItem);
  const afterItem = row.afterItem === null ? null : parseProjectItemRow(row.afterItem);
  const undo = row.undo.kind === "consumed"
    ? { kind: "consumed" as const, by: createProjectItemReceiptId(row.undo.by) }
    : row.undo.kind === "available" ? { kind: "available" as const } : { kind: "unavailable" as const };
  return {
    version: 1, id: createProjectItemReceiptId(row.id), mutationId: createProjectMutationId(row.mutationId),
    projectId: createProjectId(row.projectId), workbookId: createProjectWorkbookId(row.workbookId), itemId: createProjectItemId(row.itemId),
    kind: row.kind, actor: createProjectActor(row.actor), source: row.source, completedAt: parseProjectInstant(row.completedAt), beforeItem, afterItem, undo,
    ...(row.undoOf === undefined ? {} : { undoOf: createProjectItemReceiptId(row.undoOf) }),
  };
}

export function parsePageScrapRow(value: unknown): PageScrapRow {
  const row = ScrapSchema.parse(value);
  validateProjectText(row.reason, "Scrap reason", 500);
  createProjectWorkbookId(row.workbookId);
  createProjectActor(row.capturedBy);
  parseProjectInstant(row.capturedAt);
  if (row.beforeDocument.workbookId !== row.workbookId || row.beforePages.some((page) => page.workbookId !== row.workbookId)) {
    throw new Error("Scrap rows must contain one workbook only.");
  }
  if (row.resultingPageOrder.length === 0 || new Set(row.resultingPageOrder).size !== row.resultingPageOrder.length) {
    throw new Error("Scrap resulting page order must be finite and unique.");
  }
  return {
    version: 1,
    id: row.id,
    workbookId: row.workbookId,
    reason: row.reason,
    capturedBy: { ...row.capturedBy },
    capturedAt: row.capturedAt,
    beforeDocument: {
      workbookId: row.beforeDocument.workbookId,
      version: 1,
      documentRevision: row.beforeDocument.documentRevision,
      pageOrder: [...row.beforeDocument.pageOrder],
      updatedAt: row.beforeDocument.updatedAt,
    },
    beforePages: row.beforePages.map((page) => ({
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
    })),
    assetReferences: row.assetReferences.map((reference) => ({ ...reference })),
    resultingDocumentRevision: row.resultingDocumentRevision,
    resultingPageOrder: [...row.resultingPageOrder],
    resultingPageRevisions: { ...row.resultingPageRevisions },
    reworkReceiptId: row.reworkReceiptId,
  };
}

export function projectToRow(project: Project): ProjectRow {
  return { ...project, createdBy: { ...project.createdBy } };
}

export function identityToRow(identity: WorkbookIdentity): WorkbookIdentityRow {
  return identity.kind === "agent"
    ? { ...identity, shelfKind: "agent", agentProjectId: identity.projectId }
    : { ...identity, shelfKind: "user" };
}

export function itemToRow(item: ProjectItem): ProjectItemRow {
  return { ...item, anchor: { ...item.anchor }, authoredBy: { ...item.authoredBy } };
}
