import { afterEach, describe, expect, it, vi } from "vitest";

import {
  IndexedDbProjectStorage,
} from "../../../src/indexeddb/project-storage";
import {
  createProjectActor,
  createProjectId,
  createProjectItemId,
  createProjectItemReceiptId,
} from "../../../src/projects";
import {
  createProjectWorkbookCommands,
  deactivateProjectWebMcpTools,
  registerProjectWebMcpTools,
  type ProjectWorkbookCommands,
} from "../../../src/entries/webmcp";
import type {
  WebMcpModelContext,
  WebMcpTool,
} from "../../../src/types/webmcp";

const FIXED_INSTANT = "2026-08-30T12:00:00.000Z";
const databaseNames = new Set<string>();
const openStorages = new Set<IndexedDbProjectStorage>();

function databaseName(): string {
  const name = `project-tools-${Math.random().toString(36).slice(2)}`;
  databaseNames.add(name);
  return name;
}

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("database deletion failed"));
    request.onblocked = () => reject(new Error("database deletion was blocked"));
  });
}

afterEach(async () => {
  await Promise.all([...openStorages].map((storage) => storage.close()));
  await Promise.all([...databaseNames].map(deleteDatabase));
  openStorages.clear();
  databaseNames.clear();
});

class CapturingModelContext implements WebMcpModelContext {
  public readonly tools: WebMcpTool[] = [];

  public constructor(
    private readonly failOn: string | undefined = undefined,
    private readonly rejectAsync = false,
  ) {}

  public registerTool(tool: WebMcpTool): void | Promise<void> {
    if (tool.name === this.failOn) {
      if (this.rejectAsync) return Promise.reject(new Error(`cannot register ${tool.name}`));
      throw new Error(`cannot register ${tool.name}`);
    }
    this.tools.push(tool);
  }
}

class FailOnceModelContext implements WebMcpModelContext {
  public readonly tools: WebMcpTool[] = [];
  private failed = false;

  public registerTool(tool: WebMcpTool): void | Promise<void> {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error("first registration failed"));
    }
    this.tools.push(tool);
  }
}

type Fixture = Readonly<{
  storage: IndexedDbProjectStorage;
  commands: ProjectWorkbookCommands;
  projectId: string;
  workbookId: string;
}>;

async function createFixture(): Promise<Fixture> {
  const storage = new IndexedDbProjectStorage({
    databaseName: databaseName(),
    clock: { now: () => FIXED_INSTANT },
    ids: {
      newReceiptId: (() => {
        let index = 0;
        return () => createProjectItemReceiptId(`receipt-${index++}`);
      })(),
    },
  });
  openStorages.add(storage);
  const projectId = "project-tools";
  const workbookId = "agent-workbook";
  await storage.createProject({
    projectId: createProjectId(projectId),
    name: "Project tools",
    createdBy: createProjectActor({ kind: "user", id: "person-1" }),
  });
  return {
    storage,
    commands: createProjectWorkbookCommands({ storage, projectId, workbookId }),
    projectId,
    workbookId,
  };
}

function toolFor(context: CapturingModelContext, name: string): WebMcpTool {
  const tool = context.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Missing registered tool ${name}.`);
  return tool;
}

describe("project workbook WebMCP tools", () => {
  it("describes four exact tools and reports unsupported or partial registration without pretending success", async () => {
    const { commands } = await createFixture();
    expect(commands.describe().map((descriptor) => descriptor.name)).toEqual([
      "project_workbook_resolve",
      "project_item_create",
      "project_item_update",
      "project_item_undo",
    ]);
    const createDescriptor = commands.describe().find((descriptor) => descriptor.name === "project_item_create");
    expect(createDescriptor?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["projectId", "workbookId", "actorId", "mutationId", "itemId", "kind", "title", "status", "anchor"],
    });
    expect(createDescriptor?.inputSchema).toHaveProperty("properties.anchor.type", "object");

    await expect(registerProjectWebMcpTools(commands, undefined)).resolves.toEqual({
      status: "unsupported",
      toolNames: [],
    });
    await expect(registerProjectWebMcpTools(commands, null)).resolves.toEqual({
      status: "unsupported",
      toolNames: [],
    });

    const synchronousFailure = new CapturingModelContext("project_item_create");
    await expect(registerProjectWebMcpTools(commands, synchronousFailure)).resolves.toEqual({
      status: "error",
      toolNames: ["project_workbook_resolve"],
      message: "cannot register project_item_create",
    });
    expect(synchronousFailure.tools.map((tool) => tool.name)).toEqual(["project_workbook_resolve"]);

    const asynchronousFailure = new CapturingModelContext("project_workbook_resolve", true);
    await expect(registerProjectWebMcpTools(commands, asynchronousFailure)).resolves.toEqual({
      status: "error",
      toolNames: [],
      message: "cannot register project_workbook_resolve",
    });

    const retrying = new FailOnceModelContext();
    await expect(registerProjectWebMcpTools(commands, retrying)).resolves.toEqual({
      status: "error",
      toolNames: [],
      message: "first registration failed",
    });
    await expect(registerProjectWebMcpTools(commands, retrying)).resolves.toMatchObject({
      status: "registered",
      toolNames: [
        "project_workbook_resolve",
        "project_item_create",
        "project_item_update",
        "project_item_undo",
      ],
    });
    expect(retrying.tools).toHaveLength(4);
  });

  it("resolves the exact project workbook, validates targets, and completes create, update, and Undo", async () => {
    const { commands, storage, projectId, workbookId } = await createFixture();
    const context = new CapturingModelContext();
    const itemsChanged = vi.fn();
    const workspaceChanged = vi.fn();
    document.addEventListener("project-notebook-items-changed", itemsChanged);
    document.addEventListener("project-notebook-workspace-changed", workspaceChanged);

    try {
      await expect(registerProjectWebMcpTools(commands, context)).resolves.toMatchObject({
        status: "registered",
        toolNames: [
          "project_workbook_resolve",
          "project_item_create",
          "project_item_update",
          "project_item_undo",
        ],
      });
      await registerProjectWebMcpTools(commands, context);
      expect(context.tools).toHaveLength(4);
      expect(context.tools.every((tool) => tool.annotations?.readOnlyHint === false)).toBe(true);
      expect(context.tools.every((tool) => tool.annotations?.untrustedContentHint === true)).toBe(true);

      const resolve = toolFor(context, "project_workbook_resolve");
      await expect(resolve.execute({
        projectId: "other-project",
        workbookId,
        actorId: "agent-1",
        title: "Wrong target",
        subject: "Must be rejected",
      })).resolves.toMatchObject({
        outcome: "error",
        command: "project_workbook_resolve",
        error: { code: "PROJECT_COMMAND_REJECTED" },
      });
      await expect(resolve.execute({
        projectId,
        workbookId,
        title: "Missing actor",
        subject: "Must be rejected",
      })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "PROJECT_COMMAND_REJECTED" },
      });

      await expect(resolve.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        title: "Agent Workbook",
        subject: "Bound project work",
      })).resolves.toMatchObject({
        outcome: "success",
        command: "project_workbook_resolve",
        output: { projectId, workbookId, shelfKind: "agent" },
      });
      expect(itemsChanged).toHaveBeenCalledOnce();
      expect(workspaceChanged).toHaveBeenCalledOnce();

      await expect(resolve.execute({
        projectId,
        workbookId: "a-different-proposed-workbook",
        actorId: "agent-2",
        title: "A changed title",
        subject: "The existing assignment wins",
      })).resolves.toMatchObject({
        outcome: "success",
        output: { projectId, workbookId, shelfKind: "agent" },
      });

      for (const [kind, status] of [
        ["task", "open"],
        ["milestone", "open"],
        ["decision", "open"],
        ["task", "in_progress"],
        ["task", "blocked"],
        ["task", "done"],
        ["task", "superseded"],
      ] as const) {
        await expect(commands.executeManual("project_item_create", {
          projectId,
          workbookId,
          mutationId: `manual-${kind}-${status}`,
          itemId: `manual-${kind}-${status}`,
          kind,
          title: `Manual ${kind} ${status}`,
          status,
          anchor: { kind: "none" },
        })).resolves.toMatchObject({
          outcome: "success",
          output: { itemRevision: 1, itemStatus: status, commitStatus: "committed" },
        });
      }

      const create = toolFor(context, "project_item_create");
      const createInput = {
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-create",
        itemId: "item-1",
        kind: "task" as const,
        title: "Review the page",
        status: "open" as const,
        anchor: { kind: "none" as const },
      };
      await expect(create.execute(createInput)).resolves.toMatchObject({
        outcome: "success",
        command: "project_item_create",
        output: {
          projectId,
          workbookId,
          itemId: "item-1",
          itemRevision: 1,
          itemStatus: "open",
          commitStatus: "committed",
        },
      });
      expect(itemsChanged).toHaveBeenCalledTimes(3);
      expect((await storage.getItem(createProjectItemId("item-1")))?.authoredBy).toMatchObject({
        kind: "agent",
        id: "agent-1",
      });

      await expect(create.execute(createInput)).resolves.toMatchObject({
        outcome: "success",
        output: { commitStatus: "duplicate", itemRevision: 1 },
      });
      await expect(create.execute({ ...createInput, mutationId: "mutation-page-anchor", itemId: "page-anchor", anchor: { kind: "page", pageId: "missing-page" } })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "invalid_target" },
      });
      await expect(create.execute({ ...createInput, mutationId: "mutation-element-anchor", itemId: "element-anchor", anchor: { kind: "element", pageId: "missing-page", elementId: "missing-element" } })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "invalid_target" },
      });

      const update = toolFor(context, "project_item_update");
      await expect(update.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-missing-item",
        itemId: "missing-item",
        expectedRevision: 1,
        title: "Missing item",
        status: "open",
        anchor: { kind: "none" },
      })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "PROJECT_COMMAND_REJECTED" },
      });
      await expect(update.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-update",
        itemId: "item-1",
        expectedRevision: 1,
        title: "Review the revised page",
        status: "done",
        anchor: { kind: "none" },
      })).resolves.toMatchObject({
        outcome: "success",
        command: "project_item_update",
        output: { itemRevision: 2, itemStatus: "done", commitStatus: "committed" },
      });
      const updateReceipt = (await storage.listReceipts(createProjectItemId("item-1"))).find(
        (receipt) => receipt.kind === "project_item_update",
      );
      if (updateReceipt === undefined) throw new Error("The update receipt was not written.");

      const undo = toolFor(context, "project_item_undo");
      await expect(undo.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-undo",
        receiptId: updateReceipt.id,
      })).resolves.toMatchObject({
        outcome: "success",
        command: "project_item_undo",
        output: { itemRevision: 3, itemStatus: "open", commitStatus: "committed" },
      });
      expect((await storage.getItem(createProjectItemId("item-1")))?.title).toBe("Review the page");

      await expect(update.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-stale",
        itemId: "item-1",
        expectedRevision: 1,
        title: "Stale edit",
        status: "blocked",
        anchor: { kind: "none" },
      })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "stale" },
      });

      await expect(update.execute({
        projectId,
        workbookId: "different-workbook",
        actorId: "agent-1",
        mutationId: "mutation-cross-workbook",
        itemId: "item-1",
        expectedRevision: 3,
        title: "Wrong workbook",
        status: "blocked",
        anchor: { kind: "none" },
      })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "PROJECT_COMMAND_REJECTED" },
      });
      await expect(create.execute({ ...createInput, mutationId: "mutation-extra", itemId: "item-extra", extra: true })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "INVALID_INPUT" },
      });
      await expect(create.execute({ ...createInput, mutationId: "mutation-unsafe", itemId: "item-unsafe", title: "<unsafe>" })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "unsafe" },
      });
      await expect(undo.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-missing-receipt",
        receiptId: "missing-receipt",
      })).resolves.toMatchObject({
        outcome: "error",
        error: { code: "PROJECT_COMMAND_REJECTED" },
      });

      const nullableCreate = await create.execute({ ...createInput, mutationId: "mutation-nullable", itemId: "nullable-item" });
      expect(nullableCreate).toMatchObject({ outcome: "success", output: { itemRevision: 1 } });
      const nullableReceipt = (await storage.listReceipts(createProjectItemId("nullable-item"))).find(
        (receipt) => receipt.kind === "project_item_create",
      );
      if (nullableReceipt === undefined) throw new Error("The nullable create receipt was not written.");
      await expect(undo.execute({
        projectId,
        workbookId,
        actorId: "agent-1",
        mutationId: "mutation-nullable-undo",
        receiptId: nullableReceipt.id,
      })).resolves.toMatchObject({
        outcome: "success",
        output: { itemRevision: null, itemStatus: null, commitStatus: "committed" },
      });
      expect(itemsChanged).toHaveBeenCalledTimes(8);
    } finally {
      document.removeEventListener("project-notebook-items-changed", itemsChanged);
      document.removeEventListener("project-notebook-workspace-changed", workspaceChanged);
    }
  });

  it("keeps registered tools inactive after deactivation and reactivates the same binding without duplicate registration", async () => {
    const { commands, projectId, workbookId } = await createFixture();
    const context = new CapturingModelContext();
    await registerProjectWebMcpTools(commands, context);
    deactivateProjectWebMcpTools(commands, context);

    await expect(toolFor(context, "project_item_create").execute({
      projectId,
      workbookId,
      actorId: "agent-1",
      mutationId: "inactive-mutation",
      itemId: "inactive-item",
      kind: "task",
      title: "Inactive workbook",
      status: "open",
      anchor: { kind: "none" },
    })).resolves.toMatchObject({
      outcome: "error",
      error: { code: "PROJECT_WORKBOOK_NOT_ACTIVE" },
    });
    await registerProjectWebMcpTools(commands, context);
    expect(context.tools).toHaveLength(4);
  });

  it("still completes a successful tool call when the host has no document global for notifications", async () => {
    const { commands, projectId, workbookId } = await createFixture();
    const context = new CapturingModelContext();
    await registerProjectWebMcpTools(commands, context);
    const resolve = toolFor(context, "project_workbook_resolve");
    vi.stubGlobal("document", undefined);
    try {
      await expect(resolve.execute({
        projectId,
        workbookId,
        actorId: "agent-no-document",
        title: "No document host",
        subject: "The operation still completes",
      })).resolves.toMatchObject({
        outcome: "success",
        output: { projectId, workbookId, shelfKind: "agent" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
