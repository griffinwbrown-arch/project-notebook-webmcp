import { describe, expect, it, vi } from "vitest";

import {
  createNotebookId,
  createReceiptId,
  createRevision,
  type Notebook,
  type NotebookId,
  type NotebookRepository,
} from "../../../src/domain";
import {
  createCommandCatalog,
  createCommandRegistry,
  isCommandFailure,
  type CommandCatalog,
} from "../../../src/commands";
import {
  registerWebMcpTools,
  type WebMcpModelContext,
  type WebMcpTool,
} from "../../../src/entries/webmcp";

class MemoryRepository implements NotebookRepository {
  private readonly records = new Map<NotebookId, Notebook>();

  public async create(notebook: Notebook): Promise<Notebook> {
    this.records.set(notebook.id, notebook);
    return notebook;
  }

  public async get(id: NotebookId): Promise<Notebook | null> {
    return this.records.get(id) ?? null;
  }

  public async list(): Promise<Notebook[]> {
    return [...this.records.values()];
  }

  public async update(notebook: Notebook): Promise<Notebook> {
    this.records.set(notebook.id, notebook);
    return notebook;
  }
}

type CommandDescriptorContract = {
  readonly name: string;
  readonly readOnly: boolean;
  readonly outputSchema: unknown;
  readonly untrustedContent?: boolean;
};

type WebMcpToolContract = WebMcpTool & {
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly untrustedContentHint?: boolean;
  };
};

class FakeModelContext implements WebMcpModelContext {
  public readonly tools: WebMcpToolContract[] = [];

  public registerTool(tool: WebMcpTool): void {
    this.tools.push(tool as WebMcpToolContract);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function schemaContainsProperty(schema: unknown, property: "title" | "subject"): boolean {
  if (Array.isArray(schema)) {
    return schema.some((entry) => schemaContainsProperty(entry, property));
  }
  if (!isRecord(schema)) {
    return false;
  }

  const properties = schema.properties;
  if (isRecord(properties) && property in properties) {
    return true;
  }

  return Object.values(schema).some((entry) =>
    schemaContainsProperty(entry, property),
  );
}

function descriptorContract(
  descriptor: unknown,
): CommandDescriptorContract {
  if (!isRecord(descriptor) || typeof descriptor.name !== "string") {
    throw new Error("Expected a command descriptor.");
  }
  return descriptor as unknown as CommandDescriptorContract;
}

describe("Phase 2 command and WebMCP contracts", () => {
  it("executes lifecycle commands only when the shared lifecycle port is wired", async () => {
    const trashNotebook = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        id: createReceiptId("receipt-trash"),
        kind: "trash_notebook" as const,
        operation: "trash_notebook" as const,
        source: "manual" as const,
        notebookId: createNotebookId("lifecycle-notebook"),
        previousLifecycle: "active" as const,
        resultingLifecycle: "trashed" as const,
        previousRevision: createRevision(1),
        resultingRevision: createRevision(2),
        timestamp: "2026-08-26T00:00:00.000Z",
        undoEligible: true as const,
      },
    }));
    const restoreNotebook = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        id: createReceiptId("receipt-restore"),
        kind: "restore_notebook" as const,
        operation: "restore_notebook" as const,
        source: "manual" as const,
        notebookId: createNotebookId("lifecycle-notebook"),
        previousLifecycle: "trashed" as const,
        resultingLifecycle: "active" as const,
        previousRevision: createRevision(2),
        resultingRevision: createRevision(3),
        timestamp: "2026-08-26T00:01:00.000Z",
        undoEligible: true as const,
      },
    }));
    const registry = createCommandRegistry(
      createCommandCatalog({
        repository: new MemoryRepository(),
        lifecycle: { trashNotebook, restoreNotebook },
      }),
    );

    expect(registry.describe("manual").map((descriptor) => descriptor.name)).toEqual(
      expect.arrayContaining(["notebook_trash", "notebook_restore"]),
    );
    const trashed = await registry.executeManual("notebook_trash", {
      id: "lifecycle-notebook",
      expectedRevision: 1,
    });
    const restored = await registry.executeManual("notebook_restore", {
      id: "lifecycle-notebook",
      expectedRevision: 2,
    });

    expect(trashed).toMatchObject({
      outcome: "success",
      output: { id: "receipt-trash", kind: "trash_notebook", undoEligible: true },
    });
    expect(restored).toMatchObject({
      outcome: "success",
      output: { id: "receipt-restore", kind: "restore_notebook", undoEligible: true },
    });
    expect(trashNotebook).toHaveBeenCalledWith("lifecycle-notebook", 1);
    expect(restoreNotebook).toHaveBeenCalledWith("lifecycle-notebook", 2);
    expect(
      await registry.executeExternal(
        "notebook_trash",
        { id: "lifecycle-notebook", expectedRevision: 1 },
        "webmcp",
      ),
    ).toMatchObject({ outcome: "error", error: { code: "UNKNOWN_COMMAND" } });
  });

  it("removes hard delete and keeps semantic note/open/search tools out of every projection", () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });
    const allDescriptors = registry.describe().map(descriptorContract);
    const semanticTokens = new Set(["note", "notes", "open", "search"]);

    expect(allDescriptors.map((descriptor) => descriptor.name)).not.toContain(
      "notebook_delete",
    );
    for (const descriptor of allDescriptors) {
      const tokens = descriptor.name.split(/[_\-.]/);
      expect(tokens.some((token) => semanticTokens.has(token))).toBe(false);
    }

    for (const source of ["manual", "webmcp"] as const) {
      for (const descriptor of registry.describe(source).map(descriptorContract)) {
        expect(descriptor.name).not.toBe("notebook_delete");
        expect(
          descriptor.name.split(/[_\-.]/).some((token) => semanticTokens.has(token)),
        ).toBe(false);
      }
    }
  });

  it("marks notebook-authored output as untrusted while preserving read-only metadata", () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });
    const descriptors = registry.describe().map(descriptorContract);
    const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));

    expect(byName.get("notebook_create")?.readOnly).toBe(false);
    expect(byName.get("notebook_get")?.readOnly).toBe(true);
    expect(byName.get("notebook_list")?.readOnly).toBe(true);
    expect(byName.get("notebook_update")?.readOnly).toBe(false);
    for (const lifecycleCommand of ["notebook_trash", "notebook_restore"]) {
      const descriptor = byName.get(lifecycleCommand);
      if (descriptor !== undefined) {
        expect(descriptor.readOnly).toBe(false);
      }
    }

    const authoredTextDescriptors = descriptors.filter(
      (descriptor) =>
        schemaContainsProperty(descriptor.outputSchema, "title") ||
        schemaContainsProperty(descriptor.outputSchema, "subject"),
    );
    expect(authoredTextDescriptors.map((descriptor) => descriptor.name)).toEqual(
      expect.arrayContaining([
        "notebook_create",
        "notebook_get",
        "notebook_list",
        "notebook_update",
      ]),
    );
    for (const descriptor of authoredTextDescriptors) {
      expect(descriptor.untrustedContent).toBe(true);
    }
  });

  it("rejects a known command that is hidden from an external source before invoking it", async () => {
    const baseCatalog = createCommandCatalog({ repository: new MemoryRepository() });
    const hiddenHandler = vi.fn(async () => ({
      id: "hidden-id",
      title: "Should not run",
      subject: "Should not run",
      revision: 1,
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    }));
    const hiddenCatalog = {
      ...baseCatalog,
      notebook_update: {
        ...baseCatalog.notebook_update,
        exposure: { ...baseCatalog.notebook_update.exposure, webmcp: false },
        handler: hiddenHandler,
      },
    } as unknown as CommandCatalog;
    const registry = createCommandRegistry(hiddenCatalog);

    const result = await registry.executeExternal(
      "notebook_update",
      { id: "hidden-id", title: "blocked" },
      "webmcp",
    );

    expect(isCommandFailure(result)).toBe(true);
    expect(hiddenHandler).not.toHaveBeenCalled();
  });

  it("projects untrusted and read-only hints and returns the advertised tool output", async () => {
    const registry = createCommandRegistry({ repository: new MemoryRepository() });
    const modelContext = new FakeModelContext();

    const registration = await registerWebMcpTools(registry, { modelContext });
    expect(registration.status).toBe("registered");
    expect(modelContext.tools.map((tool) => tool.name)).not.toContain(
      "notebook_delete",
    );

    const byName = new Map(modelContext.tools.map((tool) => [tool.name, tool]));
    expect(byName.get("notebook_create")?.annotations).toMatchObject({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(byName.get("notebook_get")?.annotations).toMatchObject({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(byName.get("notebook_list")?.annotations).toMatchObject({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(byName.get("notebook_update")?.annotations).toMatchObject({
      readOnlyHint: false,
      untrustedContentHint: true,
    });

    const createTool = byName.get("notebook_create");
    if (createTool === undefined) {
      throw new Error("Expected the notebook_create WebMCP tool.");
    }
    const advertisedOutput = await createTool.execute({
      title: "WebMCP notebook",
      subject: "Raw command output",
    });
    expect(advertisedOutput).toMatchObject({
      title: "WebMCP notebook",
      subject: "Raw command output",
      revision: 1,
    });
    expect(advertisedOutput).not.toHaveProperty("outcome");
    expect(advertisedOutput).not.toHaveProperty("command");
    expect(advertisedOutput).not.toHaveProperty("source");
    if (isRecord(advertisedOutput) && typeof advertisedOutput.id === "string") {
      expect(createNotebookId(advertisedOutput.id)).toBe(advertisedOutput.id);
    }
  });
});
