import { z } from "zod";

import { createIsoInstant, type IsoInstant } from "../domain";
import {
  createElementId,
  createPageId,
  type ElementId,
  type PageId,
} from "../page";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type ProjectId = Brand<string, "ProjectId">;
export type ProjectWorkbookId = Brand<string, "ProjectWorkbookId">;
export type ProjectItemId = Brand<string, "ProjectItemId">;
export type ProjectItemReceiptId = Brand<string, "ProjectItemReceiptId">;
export type ProjectMutationId = Brand<string, "ProjectMutationId">;
export type ProjectActorId = Brand<string, "ProjectActorId">;
export type ProjectItemRevision = Brand<number, "ProjectItemRevision">;

export type ProjectActor =
  | Readonly<{ kind: "user"; id: ProjectActorId }>
  | Readonly<{ kind: "agent"; id: ProjectActorId }>;

export type Project = Readonly<{
  version: 1;
  id: ProjectId;
  name: string;
  revision: ProjectItemRevision;
  createdBy: ProjectActor;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}>;

export type WorkbookIdentity =
  | Readonly<{
      version: 1;
      kind: "user";
      workbookId: ProjectWorkbookId;
      projectId: ProjectId | null;
      createdAt: IsoInstant;
    }>
  | Readonly<{
      version: 1;
      kind: "agent";
      workbookId: ProjectWorkbookId;
      projectId: ProjectId;
      createdAt: IsoInstant;
    }>;

export type ProjectItemKind = "task" | "milestone" | "decision";
export type ProjectItemStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "superseded";

export type ProjectItemAnchor =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "page"; pageId: PageId }>
  | Readonly<{ kind: "element"; pageId: PageId; elementId: ElementId }>;

export type ProjectItem = Readonly<{
  version: 1;
  id: ProjectItemId;
  projectId: ProjectId;
  workbookId: ProjectWorkbookId;
  kind: ProjectItemKind;
  title: string;
  status: ProjectItemStatus;
  anchor: ProjectItemAnchor;
  revision: ProjectItemRevision;
  authoredBy: ProjectActor;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}>;

export type ProjectCommandSource = "manual" | "webmcp";

export type ProjectItemReceipt = Readonly<{
  version: 1;
  id: ProjectItemReceiptId;
  mutationId: ProjectMutationId;
  projectId: ProjectId;
  workbookId: ProjectWorkbookId;
  itemId: ProjectItemId;
  kind: "project_item_create" | "project_item_update" | "project_item_undo";
  actor: ProjectActor;
  source: ProjectCommandSource;
  completedAt: IsoInstant;
  beforeItem: ProjectItem | null;
  afterItem: ProjectItem | null;
  undo:
    | Readonly<{ kind: "available" }>
    | Readonly<{ kind: "consumed"; by: ProjectItemReceiptId }>
    | Readonly<{ kind: "unavailable" }>;
  undoOf?: ProjectItemReceiptId;
}>;

export class ProjectDomainError extends Error {
  public constructor(
    public readonly code: "invalid_id" | "invalid_revision" | "unsafe_text",
    message: string,
  ) {
    super(message);
    this.name = "ProjectDomainError";
  }
}

const IdentifierSchema = z.string().trim().min(1).max(180);
const RevisionSchema = z.number().int().safe().positive();
const IsoInstantSchema = z.string().datetime({ offset: true });
const BANNED_TEXT = /[<>]|(?:https?|file):\/\/|(?:^|\s)[a-zA-Z]:[\\/]|[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u;

function identifier<Name extends string>(value: string, name: Name): Brand<string, Name> {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectDomainError("invalid_id", `${name} must be a bounded non-empty identifier.`);
  }
  return parsed.data as Brand<string, Name>;
}

export function createProjectId(value: string): ProjectId {
  return identifier(value, "ProjectId");
}

export function createProjectWorkbookId(value: string): ProjectWorkbookId {
  return identifier(value, "ProjectWorkbookId");
}

export function createProjectItemId(value: string): ProjectItemId {
  return identifier(value, "ProjectItemId");
}

export function createProjectItemReceiptId(value: string): ProjectItemReceiptId {
  return identifier(value, "ProjectItemReceiptId");
}

export function createProjectMutationId(value: string): ProjectMutationId {
  return identifier(value, "ProjectMutationId");
}

export function createProjectActorId(value: string): ProjectActorId {
  return identifier(value, "ProjectActorId");
}

export function createProjectItemRevision(value: number): ProjectItemRevision {
  const parsed = RevisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectDomainError("invalid_revision", "Project item revision must be a positive safe integer.");
  }
  return parsed.data as ProjectItemRevision;
}

export function createProjectActor(input: Readonly<{ kind: "user" | "agent"; id: string }>): ProjectActor {
  const id = createProjectActorId(input.id);
  return input.kind === "user" ? { kind: "user", id } : { kind: "agent", id };
}

export function createProjectAnchor(input: Readonly<
  | { kind: "none" }
  | { kind: "page"; pageId: string }
  | { kind: "element"; pageId: string; elementId: string }
>): ProjectItemAnchor {
  switch (input.kind) {
    case "none":
      return { kind: "none" };
    case "page":
      return { kind: "page", pageId: createPageId(input.pageId) };
    case "element":
      return {
        kind: "element",
        pageId: createPageId(input.pageId),
        elementId: createElementId(input.elementId),
      };
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

export function validateProjectText(value: string, label: string, maximum = 240): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum || BANNED_TEXT.test(trimmed)) {
    throw new ProjectDomainError(
      "unsafe_text",
      `${label} must be bounded plain text without markup, URLs, filesystem paths, or control characters.`,
    );
  }
  return trimmed;
}

export function parseProjectInstant(value: string): IsoInstant {
  const parsed = IsoInstantSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectDomainError("invalid_id", "Timestamp must be an ISO instant with an offset.");
  }
  return createIsoInstant(parsed.data);
}

export function sameProjectActor(left: ProjectActor, right: ProjectActor): boolean {
  return left.kind === right.kind && left.id === right.id;
}

export function sameProjectAnchor(left: ProjectItemAnchor, right: ProjectItemAnchor): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "none":
      return true;
    case "page":
      return right.kind === "page" && left.pageId === right.pageId;
    case "element":
      return right.kind === "element" && left.pageId === right.pageId && left.elementId === right.elementId;
    default: {
      const exhaustive: never = left;
      return exhaustive;
    }
  }
}
