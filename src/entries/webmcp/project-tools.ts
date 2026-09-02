import { z } from "zod";

import type { IndexedDbProjectStorage } from "../../indexeddb";
import {
  createProjectActor,
  createProjectId,
  createProjectItemId,
  createProjectItemReceiptId,
  createProjectItemRevision,
  createProjectMutationId,
  createProjectWorkbookId,
  type ProjectActor,
  type ProjectId,
  type ProjectWorkbookId,
} from "../../projects";
import type { WebMcpModelContext } from "../../types/webmcp";

export type ProjectCommandName =
  | "project_workbook_resolve"
  | "project_item_create"
  | "project_item_update"
  | "project_item_undo";

export type ProjectCommandResult =
  | Readonly<{ outcome: "success"; command: ProjectCommandName; output: Readonly<Record<string, unknown>> }>
  | Readonly<{ outcome: "error"; command: ProjectCommandName; error: Readonly<{ code: string; message: string }> }>;

export type ProjectWorkbookCommandsOptions = Readonly<{
  storage: IndexedDbProjectStorage;
  projectId: ProjectId;
  workbookId: ProjectWorkbookId;
  manualActor: ProjectActor;
}>;

const IdentifierSchema = z.string().trim().min(1).max(180);
const StatusSchema = z.enum(["open", "in_progress", "blocked", "done", "superseded"]);
const AnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("page"), pageId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("element"), pageId: IdentifierSchema, elementId: IdentifierSchema }).strict(),
]);
const ResolveSchema = z.object({
  projectId: IdentifierSchema,
  workbookId: IdentifierSchema,
  actorId: IdentifierSchema.optional(),
  title: z.string().trim().min(1).max(120),
  subject: z.string().trim().min(1).max(240),
}).strict();
const CreateSchema = z.object({
  projectId: IdentifierSchema,
  workbookId: IdentifierSchema,
  actorId: IdentifierSchema.optional(),
  mutationId: IdentifierSchema,
  itemId: IdentifierSchema,
  kind: z.enum(["task", "milestone", "decision"]),
  title: z.string().trim().min(1).max(240),
  status: StatusSchema,
  anchor: AnchorSchema,
}).strict();
const UpdateSchema = z.object({
  projectId: IdentifierSchema,
  workbookId: IdentifierSchema,
  actorId: IdentifierSchema.optional(),
  mutationId: IdentifierSchema,
  itemId: IdentifierSchema,
  expectedRevision: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  status: StatusSchema,
  anchor: AnchorSchema,
}).strict();
const UndoSchema = z.object({
  projectId: IdentifierSchema,
  workbookId: IdentifierSchema,
  actorId: IdentifierSchema.optional(),
  mutationId: IdentifierSchema,
  receiptId: IdentifierSchema,
}).strict();

function inputSchema(properties: Readonly<Record<string, unknown>>, required: readonly string[]): Readonly<Record<string, unknown>> {
  return { type: "object", properties, required, additionalProperties: false };
}

const DESCRIPTORS = [
  {
    name: "project_workbook_resolve",
    description: "Resolve the one stable Agent Workbook assigned to this exact project without title matching.",
    inputSchema: inputSchema({
      workbookId: { type: "string", minLength: 1, maxLength: 180 },
      projectId: { type: "string", minLength: 1, maxLength: 180 },
      actorId: { type: "string", minLength: 1, maxLength: 180 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      subject: { type: "string", minLength: 1, maxLength: 240 },
    }, ["projectId", "workbookId", "actorId", "title", "subject"]),
  },
  {
    name: "project_item_create",
    description: "Create one bounded task, milestone, or decision in the open project workbook.",
    inputSchema: inputSchema({
      mutationId: { type: "string", minLength: 1, maxLength: 180 },
      projectId: { type: "string", minLength: 1, maxLength: 180 },
      workbookId: { type: "string", minLength: 1, maxLength: 180 },
      actorId: { type: "string", minLength: 1, maxLength: 180 },
      itemId: { type: "string", minLength: 1, maxLength: 180 },
      kind: { type: "string", enum: ["task", "milestone", "decision"] },
      title: { type: "string", minLength: 1, maxLength: 240 },
      status: { type: "string", enum: ["open", "in_progress", "blocked", "done", "superseded"] },
      anchor: { type: "object" },
    }, ["projectId", "workbookId", "actorId", "mutationId", "itemId", "kind", "title", "status", "anchor"]),
  },
  {
    name: "project_item_update",
    description: "Update one exact project item revision in the open project workbook.",
    inputSchema: inputSchema({
      mutationId: { type: "string", minLength: 1, maxLength: 180 },
      projectId: { type: "string", minLength: 1, maxLength: 180 },
      workbookId: { type: "string", minLength: 1, maxLength: 180 },
      actorId: { type: "string", minLength: 1, maxLength: 180 },
      itemId: { type: "string", minLength: 1, maxLength: 180 },
      expectedRevision: { type: "integer", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 240 },
      status: { type: "string", enum: ["open", "in_progress", "blocked", "done", "superseded"] },
      anchor: { type: "object" },
    }, ["projectId", "workbookId", "actorId", "mutationId", "itemId", "expectedRevision", "title", "status", "anchor"]),
  },
  {
    name: "project_item_undo",
    description: "Undo one exact project-item receipt only while no newer item work exists.",
    inputSchema: inputSchema({
      mutationId: { type: "string", minLength: 1, maxLength: 180 },
      projectId: { type: "string", minLength: 1, maxLength: 180 },
      workbookId: { type: "string", minLength: 1, maxLength: 180 },
      actorId: { type: "string", minLength: 1, maxLength: 180 },
      receiptId: { type: "string", minLength: 1, maxLength: 180 },
    }, ["projectId", "workbookId", "actorId", "mutationId", "receiptId"]),
  },
] as const satisfies readonly Readonly<{
  name: ProjectCommandName;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}>[];

export class ProjectWorkbookCommands {
  public constructor(private readonly options: ProjectWorkbookCommandsOptions) {}

  public describe(): typeof DESCRIPTORS {
    return DESCRIPTORS;
  }

  public executeManual(name: ProjectCommandName, input: unknown): Promise<ProjectCommandResult> {
    return this.execute(name, input, "manual");
  }

  public executeExternal(name: ProjectCommandName, input: unknown): Promise<ProjectCommandResult> {
    return this.execute(name, input, "webmcp");
  }

  private async execute(
    name: ProjectCommandName,
    input: unknown,
    source: "manual" | "webmcp",
  ): Promise<ProjectCommandResult> {
    try {
      switch (name) {
        case "project_workbook_resolve": {
          const parsed = ResolveSchema.parse(input);
          this.assertProject(parsed.projectId);
          const actor = this.actorFor(source, parsed.actorId);
          const identity = await this.options.storage.resolveAgentWorkbook({
            projectId: createProjectId(this.options.projectId),
            workbookId: createProjectWorkbookId(parsed.workbookId),
            title: parsed.title,
            subject: parsed.subject,
            requestedBy: actor,
          });
          return { outcome: "success", command: name, output: { projectId: identity.projectId, workbookId: identity.workbookId, shelfKind: identity.kind } };
        }
        case "project_item_create": {
          const parsed = CreateSchema.parse(input);
          this.assertBound(parsed.projectId, parsed.workbookId);
          const actor = this.actorFor(source, parsed.actorId);
          const result = await this.options.storage.createItem({
            id: createProjectItemId(parsed.itemId),
            projectId: this.options.projectId,
            workbookId: this.options.workbookId,
            kind: parsed.kind,
            title: parsed.title,
            status: parsed.status,
            anchor: parsed.anchor,
            mutationId: createProjectMutationId(parsed.mutationId),
            actor,
            source,
          });
          return { outcome: "success", command: name, output: { projectId: result.item.projectId, workbookId: result.item.workbookId, itemId: result.item.id, itemRevision: result.item.revision, receiptId: result.receipt.id, itemStatus: result.item.status, commitStatus: result.status } };
        }
        case "project_item_update": {
          const parsed = UpdateSchema.parse(input);
          this.assertBound(parsed.projectId, parsed.workbookId);
          const actor = this.actorFor(source, parsed.actorId);
          const itemId = createProjectItemId(parsed.itemId);
          const current = await this.options.storage.getItem(itemId);
          if (current === null || current.projectId !== this.options.projectId || current.workbookId !== this.options.workbookId) {
            throw new Error("The project item is not part of the open workbook.");
          }
          const result = await this.options.storage.updateItem({
            id: itemId,
            expectedRevision: createProjectItemRevision(parsed.expectedRevision),
            title: parsed.title,
            status: parsed.status,
            anchor: parsed.anchor,
            mutationId: createProjectMutationId(parsed.mutationId),
            actor,
            source,
          });
          return { outcome: "success", command: name, output: { projectId: result.item.projectId, workbookId: result.item.workbookId, itemId: result.item.id, itemRevision: result.item.revision, receiptId: result.receipt.id, itemStatus: result.item.status, commitStatus: result.status } };
        }
        case "project_item_undo": {
          const parsed = UndoSchema.parse(input);
          this.assertBound(parsed.projectId, parsed.workbookId);
          const actor = this.actorFor(source, parsed.actorId);
          const receiptId = createProjectItemReceiptId(parsed.receiptId);
          const items = await this.options.storage.listItems({ projectId: this.options.projectId, workbookId: this.options.workbookId });
          const receiptLists = await Promise.all(items.map((item) => this.options.storage.listReceipts(item.id)));
          if (!receiptLists.some((receipts) => receipts.some((receipt) => receipt.id === receiptId))) {
            throw new Error("The project item receipt is not part of the open workbook.");
          }
          const result = await this.options.storage.undoItem({
            receiptId,
            mutationId: createProjectMutationId(parsed.mutationId),
            actor,
            source,
          });
          return { outcome: "success", command: name, output: { projectId: result.receipt.projectId, workbookId: result.receipt.workbookId, itemId: result.receipt.itemId, itemRevision: result.item?.revision ?? null, receiptId: result.receipt.id, itemStatus: result.item?.status ?? null, commitStatus: result.status } };
        }
        default: {
          const exhaustive: never = name;
          return exhaustive;
        }
      }
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : error instanceof z.ZodError
          ? "INVALID_INPUT"
          : "PROJECT_COMMAND_REJECTED";
      return {
        outcome: "error",
        command: name,
        error: { code, message: error instanceof Error ? error.message : "The project command was rejected." },
      };
    }
  }

  private actorFor(source: "manual" | "webmcp", actorId: string | undefined): ProjectActor {
    if (source === "manual") return this.options.manualActor;
    if (actorId === undefined) throw new Error("An assigned agent actorId is required.");
    return createProjectActor({ kind: "agent", id: actorId });
  }

  private assertProject(projectId: string): void {
    if (createProjectId(projectId) !== this.options.projectId) {
      throw new Error("The project command does not target the open project.");
    }
  }

  private assertBound(projectId: string, workbookId: string): void {
    this.assertProject(projectId);
    if (createProjectWorkbookId(workbookId) !== this.options.workbookId) {
      throw new Error("The project command does not target the open workbook.");
    }
  }
}

type ProjectToolBinding = {
  commands: ProjectWorkbookCommands;
  active: boolean;
  registered: Set<ProjectCommandName>;
  installing: Promise<void> | null;
};

const PROJECT_BINDINGS = new WeakMap<WebMcpModelContext, ProjectToolBinding>();

export function deactivateProjectWebMcpTools(
  commands: ProjectWorkbookCommands,
  modelContext: WebMcpModelContext | null | undefined,
): void {
  if (modelContext === null || modelContext === undefined) return;
  const binding = PROJECT_BINDINGS.get(modelContext);
  if (binding?.commands === commands) binding.active = false;
}

export async function registerProjectWebMcpTools(
  commands: ProjectWorkbookCommands,
  modelContext: WebMcpModelContext | null | undefined,
): Promise<Readonly<{ status: "registered" | "unsupported" | "error"; toolNames: readonly ProjectCommandName[]; message?: string }>> {
  if (modelContext === null || modelContext === undefined) return { status: "unsupported", toolNames: [] };
  const binding = PROJECT_BINDINGS.get(modelContext) ?? {
    commands,
    active: false,
    registered: new Set<ProjectCommandName>(),
    installing: null,
  };
  binding.commands = commands;
  PROJECT_BINDINGS.set(modelContext, binding);
  try {
    if (binding.installing !== null) await binding.installing;
    const missing = commands.describe().filter((descriptor) => !binding.registered.has(descriptor.name));
    if (missing.length > 0) binding.installing = (async () => {
      for (const descriptor of missing) {
        await modelContext.registerTool({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input: unknown): Promise<ProjectCommandResult> => {
          if (!binding.active) {
            return {
              outcome: "error",
              command: descriptor.name,
              error: { code: "PROJECT_WORKBOOK_NOT_ACTIVE", message: "Open the bound project workbook before using this project tool." },
            };
          }
          const result = await binding.commands.executeExternal(descriptor.name, input);
          if (result.outcome === "success" && typeof document !== "undefined") {
            document.dispatchEvent(new Event("project-notebook-items-changed"));
            if (descriptor.name === "project_workbook_resolve") document.dispatchEvent(new Event("project-notebook-workspace-changed"));
          }
          return result;
        },
        });
        binding.registered.add(descriptor.name);
      }
    })();
    if (binding.installing !== null) {
      try { await binding.installing; } finally { binding.installing = null; }
    }
    binding.active = true;
    return { status: "registered", toolNames: commands.describe().map(({ name }) => name) };
  } catch (error: unknown) {
    binding.active = false;
    return {
      status: "error",
      toolNames: [...binding.registered],
      message: error instanceof Error ? error.message : "Project tool registration failed.",
    };
  }
}

export function createProjectWorkbookCommands(input: Readonly<{
  storage: IndexedDbProjectStorage;
  projectId: string;
  workbookId: string;
}>): ProjectWorkbookCommands {
  return new ProjectWorkbookCommands({
    storage: input.storage,
    projectId: createProjectId(input.projectId),
    workbookId: createProjectWorkbookId(input.workbookId),
    manualActor: createProjectActor({ kind: "user", id: "manual:project-notebook-user" }),
  });
}
